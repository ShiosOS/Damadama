import { expect, test, type Page } from "@playwright/test";

type Target = "add-habit" | "saved-habit" | "dialog" | "form-input" | "other";
type DiagnosticEvent =
  | { kind: "layout" }
  | { kind: "dom" }
  | { kind: "scroll" }
  | { kind: "focusin"; target: Target }
  | {
      kind: "focus-call";
      target: Target;
      preventScroll: boolean;
      after: boolean;
    }
  | { kind: "reveal-call"; target: Target; after: boolean }
  | { kind: "dialog-event"; name: string }
  | { kind: "marker"; name: string }
  | {
      kind: "scheduled-resource";
      path: string;
      status: number;
      start: number;
      end: number;
    };
type DiagnosticRecord = {
  at: number;
  event: DiagnosticEvent;
  scrollY: number;
  article: { top: number; bottom: number } | null;
  todayRows: number;
  dialog: string | null;
  focus: Target;
};

declare global {
  interface Window {
    saveVisibilityDiagnostic: {
      record: (event: DiagnosticEvent) => void;
      finish: () => DiagnosticRecord[];
    };
  }
}

async function observe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const records: DiagnosticRecord[] = [];
    let observing = true;
    let lastLayout = "";
    const targetName = (target: EventTarget | null): Target => {
      if (!(target instanceof Element)) return "other";
      if (target.matches(".add-habit-button")) return "add-habit";
      if (target.matches('[aria-label="Saved habits"] article'))
        return "saved-habit";
      if (target.matches('[role="dialog"]')) return "dialog";
      if (target.matches("input")) return "form-input";
      return "other";
    };
    const snapshot = (): Omit<DiagnosticRecord, "event" | "at"> => {
      const article = document.querySelector(
        '[aria-label="Saved habits"] article',
      );
      const rect = article?.getBoundingClientRect();
      return {
        scrollY,
        article: rect ? { top: rect.top, bottom: rect.bottom } : null,
        todayRows: document.querySelectorAll(".today-view article").length,
        dialog:
          document
            .querySelector('[role="dialog"]')
            ?.getAttribute("data-state") ?? null,
        focus: targetName(document.activeElement),
      };
    };
    const record = (event: DiagnosticEvent): void => {
      records.push({ at: performance.now(), event, ...snapshot() });
    };
    const nativeFocus: unknown = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "focus",
    )?.value;
    if (typeof nativeFocus !== "function")
      throw new Error("Native focus is unavailable for observation.");
    HTMLElement.prototype.focus = function (
      ...args: Parameters<HTMLElement["focus"]>
    ): void {
      const event = {
        kind: "focus-call",
        target: targetName(this),
        preventScroll: args[0]?.preventScroll ?? false,
      } satisfies Omit<
        Extract<DiagnosticEvent, { kind: "focus-call" }>,
        "after"
      >;
      record({ ...event, after: false });
      Reflect.apply(nativeFocus, this, args);
      record({ ...event, after: true });
    };
    const nativeReveal: unknown = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    )?.value;
    if (typeof nativeReveal !== "function")
      throw new Error("Native scrollIntoView is unavailable for observation.");
    Element.prototype.scrollIntoView = function (
      ...args: Parameters<Element["scrollIntoView"]>
    ): void {
      const event = {
        kind: "reveal-call",
        target: targetName(this),
      } satisfies Omit<
        Extract<DiagnosticEvent, { kind: "reveal-call" }>,
        "after"
      >;
      record({ ...event, after: false });
      Reflect.apply(nativeReveal, this, args);
      record({ ...event, after: true });
    };
    document.addEventListener("focusin", (event) => {
      record({ kind: "focusin", target: targetName(event.target) });
    });
    document.addEventListener("scroll", () => record({ kind: "scroll" }), true);
    for (const name of [
      "focusScope.autoFocusOnUnmount",
      "animationstart",
      "animationend",
      "transitionrun",
      "transitionend",
    ]) {
      document.addEventListener(
        name,
        (event) => {
          if (!(event.target instanceof Element)) return;
          if (!event.target.matches('[role="dialog"]')) return;
          record({ kind: "dialog-event", name });
        },
        true,
      );
    }
    const resources = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        if (!(entry instanceof PerformanceResourceTiming)) continue;
        const url = new URL(entry.name);
        if (
          url.pathname !== "/api/habits" ||
          !url.searchParams.has("scheduledOn")
        )
          continue;
        record({
          kind: "scheduled-resource",
          path: `${url.pathname}?scheduledOn=${url.searchParams.get("scheduledOn") ?? ""}`,
          status: entry.responseStatus,
          start: entry.startTime,
          end: entry.responseEnd,
        });
      }
    });
    resources.observe({ type: "resource", buffered: true });
    const mutations = new MutationObserver(() => {
      const layout = JSON.stringify(snapshot());
      if (layout !== lastLayout) {
        lastLayout = layout;
        record({ kind: "dom" });
      }
    });
    mutations.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    const frame = (): void => {
      if (!observing) return;
      const layout = JSON.stringify(snapshot());
      if (layout !== lastLayout) {
        lastLayout = layout;
        record({ kind: "layout" });
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    window.saveVisibilityDiagnostic = {
      record,
      finish: (): DiagnosticRecord[] => {
        observing = false;
        resources.disconnect();
        mutations.disconnect();
        record({ kind: "marker", name: "observation-finished" });
        return records;
      },
    };
  });
}

async function createWalking(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Create a habit" });
  await panel.getByLabel("Name", { exact: true }).fill("Walking");
  await panel.getByLabel("Good", { exact: true }).fill("5 minutes");
  await panel.getByLabel("Better", { exact: true }).fill("15 minutes");
  await panel.getByLabel("Best", { exact: true }).fill("30 minutes");
  await panel.getByLabel("Monday", { exact: true }).check();
  await panel.getByLabel("Wednesday", { exact: true }).check();
  await panel.getByLabel("Repeat every", { exact: false }).fill("2");
  await panel.getByRole("button", { name: "Save habit", exact: true }).click();
}

const cases = [
  {
    account: "saveVisibilityIneligible",
    date: "2026-10-18",
    rows: 0,
    held: false,
  },
  {
    account: "saveVisibilityEligible",
    date: "2026-10-19",
    rows: 1,
    held: false,
  },
  {
    account: "saveVisibilityHeld",
    date: "2026-10-19",
    rows: 1,
    held: true,
  },
];

test.use({ video: "on" });

for (const scenario of cases) {
  test(`diagnostic saved visibility on ${scenario.date}, held refresh ${scenario.held}`, async ({
    page,
  }, testInfo) => {
    const errors = { runtime: 0, console: 0, requests: 0, responses: 0 };
    let navigations = 0;
    page.on("pageerror", () => errors.runtime++);
    page.on("console", (message) => {
      if (message.type() === "error") errors.console++;
    });
    page.on("requestfailed", () => errors.requests++);
    page.on("response", (response) => {
      if (response.status() >= 400) errors.responses++;
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
    await page.clock.setFixedTime(new Date(`${scenario.date}T16:00:00Z`));
    await observe(page);
    const release = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    try {
      await page.goto(`/?account=${scenario.account}`);
      const today = page.getByRole("region", { name: "Today", exact: true });
      await expect(today.locator("time")).toHaveAttribute(
        "datetime",
        scenario.date,
      );
      await expect(today).toContainText("Nothing scheduled for today.");
      await expect(
        page.getByRole("region", { name: "Saved habits" }).locator("article"),
      ).toHaveCount(0);
      if (scenario.held) {
        await page.route("**/api/habits?scheduledOn=*", async (route) => {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          await page.evaluate(() =>
            window.saveVisibilityDiagnostic.record({
              kind: "marker",
              name: "real-scheduled-response-held",
            }),
          );
          received.resolve();
          await release.promise;
          await route.fulfill({ response });
        });
      }
      const refreshed = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/habits" &&
          url.searchParams.get("scheduledOn") === scenario.date
        );
      });
      await createWalking(page);
      const panel = page.getByRole("dialog", { name: "Create a habit" });
      if (scenario.held) {
        await received.promise;
        await expect(panel).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Add habit", exact: true }),
        ).toBeFocused();
        await page.evaluate(() =>
          window.saveVisibilityDiagnostic.record({
            kind: "marker",
            name: "dialog-gone-before-scheduled-release",
          }),
        );
        release.resolve();
      }
      const scheduledResponse = await refreshed;
      expect(scheduledResponse.status()).toBe(200);
      await scheduledResponse.finished();
      await expect(panel).toHaveCount(0);
      await expect(today.locator("article")).toHaveCount(scenario.rows);
      const list = page.getByRole("region", { name: "Saved habits" });
      const heading = list.getByRole("heading", {
        name: "Walking",
        exact: true,
      });
      await expect(heading).toBeVisible();
      for (const value of [
        "Good: 5 minutes",
        "Better: 15 minutes",
        "Best: 30 minutes",
        "Every 2 weeks",
      ])
        await expect(list).toContainText(value);
      await expect(list.getByText("Monday", { exact: true })).toBeVisible();
      await expect(list.getByText("Wednesday", { exact: true })).toBeVisible();
      await expect(list).not.toContainText("Created on");
      await expect(list).not.toContainText("First repeat week starts Monday");
      expect(navigations).toBe(1);
      await expect(heading).toBeInViewport();
      await expect(list.getByText("Every 2 weeks")).toBeInViewport({
        ratio: 1,
      });
      expect(errors).toEqual({
        runtime: 0,
        console: 0,
        requests: 0,
        responses: 0,
      });
    } finally {
      release.resolve();
      await page.unrouteAll({ behavior: "wait" });
      const chronology = await page.evaluate(() =>
        window.saveVisibilityDiagnostic.finish(),
      );
      await testInfo.attach("save-visibility-chronology", {
        body: JSON.stringify(
          { scenario, errors, navigations, chronology },
          null,
          2,
        ),
        contentType: "application/json",
      });
      await testInfo.attach("save-visibility-viewport", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
  });
}
