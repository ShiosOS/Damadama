import {
  observation,
  browserSnapshot,
  nodeRecord,
} from "./quiet-save-schema.mjs";

const states = new WeakMap();

export function installBrowserObserver() {
  const records = [];
  let bytes = 0;
  let pending = 0;
  let overflow = false;
  const labels = ["Name", "Good", "Better", "Best", "Repeat every (weeks)"];
  function target(element) {
    if (!(element instanceof Element)) return "other";
    const label = element.getAttribute("aria-label");
    if (labels.includes(label)) return label;
    if (element.matches("form.habit-form button[type=submit]")) return "save";
    if (element.matches("form.habit-form")) return "form";
    if (element.matches("form.habit-form input[type=checkbox]"))
      return "weekday";
    return "other";
  }
  for (const type of ["keydown", "invalid", "submit", "focusin", "input"]) {
    document.addEventListener(
      type,
      (event) => {
        if (
          type === "keydown" &&
          (!(event instanceof KeyboardEvent) || event.key !== "Enter")
        )
          return;
        const eventTarget = target(event.target);
        if (eventTarget === "other") return;
        if (records.length + pending >= 256 || overflow) {
          overflow = true;
          return;
        }
        pending++;
        const ms = performance.now();
        queueMicrotask(() => {
          pending--;
          if (records.length >= 256) {
            overflow = true;
            return;
          }
          const save = document.querySelector(
            "form.habit-form button[type=submit]",
          );
          let name = type;
          if (type === "keydown") name = "enter";
          if (type === "focusin") name = "focus";
          const keyboard = event instanceof KeyboardEvent;
          const record = {
            origin: "browser-performance",
            ms,
            event: name,
            target: eventTarget,
            focus: target(document.activeElement),
            defaultPrevented: event.defaultPrevented,
            alt: keyboard && event.altKey,
            ctrl: keyboard && event.ctrlKey,
            meta: keyboard && event.metaKey,
            shift: keyboard && event.shiftKey,
            composing: keyboard && event.isComposing,
            repeat: keyboard && event.repeat,
            saveFocused: save !== null && save === document.activeElement,
            saveDisabled: save instanceof HTMLButtonElement && save.disabled,
            fields: labels
              .filter((label) => type !== "input" || label === eventTarget)
              .map((label) => {
                const input = document.querySelector(
                  `form.habit-form input[aria-label="${label}"]`,
                );
                const present = input instanceof HTMLInputElement;
                return {
                  label,
                  present,
                  focused: present && input === document.activeElement,
                  populated: present && input.value.length > 0,
                  valid: present && input.validity.valid,
                };
              }),
          };
          const size = JSON.stringify(record).length + 1;
          if (bytes + size > 49152) {
            overflow = true;
            return;
          }
          bytes += size;
          records.push(() => ({
            ...record,
            defaultPrevented: event.defaultPrevented,
          }));
        });
      },
      true,
    );
  }
  Object.defineProperty(window, "__quietSaveSnapshot", {
    value: () => ({ records: records.map((record) => record()), overflow }),
    configurable: false,
    writable: false,
  });
}

export function mark(page, event, details = {}) {
  const state = states.get(page);
  if (!state) throw new Error("Observer has no page owner.");
  if (state.node.length >= 64) {
    state.refusal = "overflow";
    return;
  }
  state.node.push(
    nodeRecord.parse({
      origin: "node-performance",
      ms: performance.now(),
      event,
      ...details,
    }),
  );
}

export async function begin(page, control = "normal") {
  const state = {
    node: [],
    browser: [],
    refusal: "none",
    control,
    cancel: null,
    cancelled: false,
  };
  states.set(page, state);
  mark(page, "test-start");
  await page.addInitScript(installBrowserObserver);
  const relevant = (request) =>
    request.method() === "POST" &&
    new URL(request.url()).pathname === "/api/habits";
  page.on("request", (request) => {
    if (relevant(request)) mark(page, "request");
  });
  page.on("requestfailed", (request) => {
    if (relevant(request)) mark(page, "request-failed");
  });
  page.on("response", (response) => {
    if (relevant(response.request()))
      mark(page, "response", { status: response.status() });
  });
  if (control === "invalid") {
    await page.addInitScript(() => {
      document.addEventListener(
        "keydown",
        (event) => {
          if (!(event instanceof KeyboardEvent) || event.key !== "Enter")
            return;
          if (
            event.target !==
            document.querySelector("form.habit-form button[type=submit]")
          )
            return;
          const input = document.querySelector(
            'form.habit-form input[aria-label="Name"]',
          );
          if (input instanceof HTMLInputElement) input.value = "";
        },
        true,
      );
    });
  }
  if (control === "held-response") {
    await page.route("**/api/habits", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      mark(page, "held-response", { status: response.status() });
      await response.dispose();
      if (!state.cancelled)
        await new Promise((resolve) => {
          state.cancel = resolve;
        });
      await route.abort().catch(() => {});
    });
  }
}

export function isDeadline(page) {
  return states.get(page)?.control === "deadline";
}
export async function deadlineGate(page) {
  const state = states.get(page);
  mark(page, "deadline-gate");
  if (!state.cancelled)
    await new Promise((resolve) => {
      state.cancel = resolve;
    });
  return false;
}

async function read(page, state) {
  if (page.isClosed()) {
    state.refusal = "missing-page";
    return;
  }
  let timer;
  try {
    const raw = await Promise.race([
      page.evaluate(() => window.__quietSaveSnapshot?.()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Observation deadline.")),
          5000,
        );
      }),
    ]);
    const parsed = browserSnapshot.safeParse(raw);
    if (!parsed.success) {
      state.refusal = "schema-rejected";
      return;
    }
    if (
      parsed.data.overflow ||
      state.browser.length + parsed.data.records.length > 256
    ) {
      state.refusal = "overflow";
      return;
    }
    state.browser.push(...parsed.data.records);
  } catch {
    state.refusal = "read-failed";
  } finally {
    clearTimeout(timer);
  }
}

export async function preserveBeforeReload(page) {
  await read(page, states.get(page));
}

export async function finish(page, testInfo) {
  const state = states.get(page);
  if (!state) return;
  state.cancelled = true;
  if (state.cancel && state.control === "deadline") {
    mark(page, "gate-cancelled");
    state.cancel();
  }
  if (
    (testInfo.status !== "passed" && testInfo.status !== "skipped") ||
    state.refusal !== "none"
  ) {
    await read(page, state);
    const safe = observation.parse({
      schema: 1,
      node: state.node,
      browser: state.browser,
      refusal: state.refusal,
    });
    await testInfo.attach("quiet-save-observation", {
      body: Buffer.from(JSON.stringify(safe)),
      contentType: "application/json",
    });
  }
  if (state.cancel && state.control === "held-response") state.cancel();
}
