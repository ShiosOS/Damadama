import {
  observation,
  browserSnapshot,
  nodeRecord,
  fontRead,
  fontEvidence,
  fontFailureCategory,
} from "./quiet-save-schema.mjs";
import { caseNames, retainFailureMedia } from "./quiet-save-media.mjs";
import { readFontAssets, fontBuildProof } from "./quiet-save-source.mjs";
import { readOwnedFile } from "./quiet-save-files.mjs";
import { resolve } from "node:path";

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
        if (eventTarget === "other" && type !== "focusin") return;
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
  function readFontSnapshot() {
    const counts = { unloaded: 0, loading: 0, loaded: 0, error: 0 };
    let total = 0;
    for (const face of document.fonts) {
      if (++total > 32) return { refusal: "face-bound-exceeded" };
      if (face.family.replaceAll('"', "") !== "Nunito Variable") continue;
      if (!Object.hasOwn(counts, face.status)) return null;
      counts[face.status]++;
    }
    let family = { state: "missing" };
    if (Object.values(counts).some((count) => count > 0))
      family = { state: "present", counts };
    return {
      origin: "browser-performance",
      ms: performance.now(),
      sampledAt: "failure-drain",
      setStatus: document.fonts.status,
      family,
    };
  }
  Object.defineProperty(window, "__quietSaveSnapshot", {
    value: (includeFont = false) => {
      let font = null;
      if (includeFont) {
        try {
          font = readFontSnapshot();
        } catch {
          font = { refusal: "read-failed" };
        }
      }
      return { records: records.map((record) => record()), overflow, font };
    },
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
    started: Date.now(),
    font: await observeFonts(page),
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

async function observeFonts(page) {
  const collector = {
    requests: new WeakMap(),
    events: [],
    nextRequest: 1,
    document: 0,
    documentOverflow: false,
    documentChangedAfterStop: false,
    refusal: "none",
    stoppedAt: null,
    sample: { state: "read-failed" },
    detach: () => {},
  };
  let inventory;
  try {
    const selfTest = process.env.QUIET_SELF_TEST === "1";
    inventory = await readFontAssets(selfTest);
    if (!selfTest) {
      const source = JSON.parse(
        (
          await readOwnedFile(
            resolve(".audit/quiet-save/evidence/source.json"),
            0,
            16384,
          )
        ).toString("utf8"),
      );
      const proof = fontBuildProof.parse(source.fontBuild);
      if (JSON.stringify(proof) !== JSON.stringify(inventory.proof))
        throw new Error("Font source proof differs.");
    }
  } catch {
    collector.refusal = "selection-unavailable";
  }
  const active = () =>
    collector.stoppedAt === null && collector.refusal === "none";
  const append = (event, identity, details = {}) => {
    if (!active()) return;
    const record = {
      origin: "node-performance",
      ms: performance.now(),
      ...identity,
      event,
      ...details,
    };
    if (
      collector.events.length >= 32 ||
      Buffer.byteLength(JSON.stringify([...collector.events, record])) > 3200
    ) {
      collector.refusal = "overflow";
      return;
    }
    collector.events.push(record);
  };
  const request = (item) => {
    if (!active() || !inventory) return;
    try {
      if (
        item.method() !== "GET" ||
        item.resourceType() !== "font" ||
        item.frame() !== page.mainFrame()
      )
        return;
      const kind = inventory.kindForUrl(item.url());
      if (!kind) return;
      if (collector.nextRequest > 8) {
        collector.refusal = "overflow";
        return;
      }
      const identity = {
        request: collector.nextRequest++,
        document: collector.document,
        kind,
      };
      collector.requests.set(item, identity);
      append("font-request", identity);
    } catch {
      collector.refusal = "selection-unavailable";
    }
  };
  const response = (item) => {
    const identity = collector.requests.get(item.request());
    if (identity) append("font-response", identity, { status: item.status() });
  };
  const finished = (item) => {
    const identity = collector.requests.get(item);
    if (identity) append("font-request-finished", identity);
  };
  const failed = (item) => {
    const identity = collector.requests.get(item);
    if (!identity || !active()) return;
    let category = "unknown";
    try {
      category = fontFailureCategory(item.failure()?.errorText);
    } catch {}
    append("font-request-failed", identity, { category });
  };
  const navigated = (frame) => {
    if (frame !== page.mainFrame()) return;
    if (collector.stoppedAt !== null) {
      collector.documentChangedAfterStop = true;
      return;
    }
    if (collector.document >= 4) {
      collector.documentOverflow = true;
      collector.refusal = "overflow";
      return;
    }
    collector.document++;
  };
  const listeners = [
    ["request", request],
    ["response", response],
    ["requestfinished", finished],
    ["requestfailed", failed],
    ["framenavigated", navigated],
  ];
  for (const [event, listener] of listeners) page.on(event, listener);
  collector.detach = () => {
    for (const [event, listener] of listeners) page.off(event, listener);
  };
  return collector;
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

async function read(page, state, includeFont = false) {
  if (page.isClosed()) {
    state.refusal = "missing-page";
    if (includeFont) state.font.sample = { state: "missing-page" };
    return;
  }
  let timer;
  try {
    const raw = await Promise.race([
      page.evaluate((font) => window.__quietSaveSnapshot?.(font), includeFont),
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
      if (includeFont) state.font.sample = { state: "schema-rejected" };
      return;
    }
    if (includeFont) {
      const font = fontRead.safeParse(parsed.data.font);
      if (state.font.documentChangedAfterStop)
        state.font.sample = { state: "document-changed" };
      else if (state.font.documentOverflow)
        state.font.sample = { state: "document-bound-exceeded" };
      else if (!font.success) state.font.sample = { state: "schema-rejected" };
      else if ("refusal" in font.data)
        state.font.sample = { state: font.data.refusal };
      else
        state.font.sample = {
          state: "available",
          document: state.font.document,
          snapshot: font.data,
        };
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
    if (includeFont) state.font.sample = { state: "read-failed" };
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
  state.font.stoppedAt = performance.now();
  try {
    state.cancelled = true;
    if (state.cancel && state.control === "deadline") {
      mark(page, "gate-cancelled");
      state.cancel();
    }
    if (
      (testInfo.status !== "passed" && testInfo.status !== "skipped") ||
      state.refusal !== "none"
    ) {
      const failed =
        testInfo.status !== "passed" && testInfo.status !== "skipped";
      await read(page, state, failed);
      let font = null;
      if (failed) {
        const transport = {
          events: state.font.events,
          refusal: state.font.refusal,
          stop: {
            origin: "node-performance",
            ms: state.font.stoppedAt,
            reason: "case-finished",
          },
        };
        const parsed = fontEvidence.safeParse({
          scope: "verified-bundled-nunito-main-frame",
          transport,
          sample: state.font.sample,
        });
        if (parsed.success) font = parsed.data;
        else
          font = {
            scope: "verified-bundled-nunito-main-frame",
            transport: {
              ...transport,
              events: [],
              refusal: "selection-unavailable",
            },
            sample: { state: "schema-rejected" },
          };
      }
      const safe = observation.parse({
        schema: 2,
        node: state.node,
        browser: state.browser,
        refusal: state.refusal,
        font,
      });
      await testInfo.attach("quiet-save-observation", {
        body: Buffer.from(JSON.stringify(safe)),
        contentType: "application/json",
      });
      if (
        testInfo.outputDir &&
        testInfo.project?.outputDir &&
        process.env.QUIET_CONTROL
      ) {
        const manifest = await retainFailureMedia({
          outputDir: testInfo.outputDir,
          outputRoot: testInfo.project.outputDir,
          started: state.started,
          owner: {
            control: process.env.QUIET_CONTROL,
            iteration: Number(process.env.QUIET_ITERATION),
            phase: process.env.QUIET_PHASE,
            project: testInfo.project.name,
            case: caseNames.indexOf(testInfo.title),
          },
          head: process.env.COMPAT_CURRENT_SHA,
          selfTest: process.env.QUIET_SELF_TEST === "1",
        });
        await testInfo.attach("quiet-save-media", {
          body: Buffer.from(JSON.stringify(manifest)),
          contentType: "application/json",
        });
      }
    }
    if (state.cancel && state.control === "held-response") state.cancel();
  } finally {
    state.font.detach();
  }
}
