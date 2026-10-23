import { access } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";
import {
  beginFontEvidence,
  finishFontEvidence,
  recordSaveMarker,
} from "./font-evidence";
import { habitSchema, type Habit } from "../../web/src/habits.schema";
import {
  baselineDir,
  captureOrCompare,
  checkpointFor,
  clockInstant,
  nonemptyDiffs,
  screenshotOptions,
} from "./visual-support";

const accounts = {
  "firefox-smoke": "reload",
  "webkit-smoke": "list",
  "chromium-desktop": "owner",
  "chromium-mobile": "cleanup",
} as const;
const habitName = "Walking";

const formDiagnostic = z.object({
  event: z.enum(["focusin", "input", "keydown", "invalid", "submit"]),
  saveFocused: z.boolean(),
  saveEnabled: z.boolean(),
  fields: z
    .array(
      z.object({
        label: z.enum([
          "Name",
          "Good",
          "Better",
          "Best",
          "Repeat every (weeks)",
        ]),
        present: z.boolean(),
        focused: z.boolean(),
        populated: z.boolean(),
        valid: z.boolean(),
      }),
    )
    .max(5),
});

function recordDiagnostic(event: string, details: object = {}): void {
  console.info("compatibility-diagnostic", {
    monotonicMs: Math.round(performance.now()),
    event,
    ...details,
  });
}

test.beforeEach(async ({ page }, testInfo) => {
  await beginFontEvidence(page, testInfo);
  recordDiagnostic("test-start");
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/habits"))
      recordDiagnostic("create-request");
  });
  page.on("response", (response) => {
    if (
      response.request().method() === "POST" &&
      response.url().endsWith("/api/habits")
    )
      recordDiagnostic("create-response", { status: response.status() });
  });
  page.on("requestfailed", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/habits"))
      recordDiagnostic("create-request-failed");
  });
  page.on("console", (message) => {
    const prefix = "compatibility-form ";
    if (!message.text().startsWith(prefix)) return;
    const payload: unknown = JSON.parse(message.text().slice(prefix.length));
    recordDiagnostic("form-event", formDiagnostic.parse(payload));
  });
  await page.addInitScript(() => {
    const labels = ["Name", "Good", "Better", "Best", "Repeat every (weeks)"];
    for (const event of ["focusin", "input", "keydown", "invalid", "submit"])
      document.addEventListener(
        event,
        (observed) => {
          if (observed instanceof KeyboardEvent && observed.key !== "Enter")
            return;
          const form = document.querySelector("form.habit-form");
          if (!form) return;
          const save = form.querySelector("button[type=submit]");
          const fields = labels.map((label) => {
            const input = form.querySelector(`input[aria-label="${label}"]`);
            return {
              label,
              present: input instanceof HTMLInputElement,
              focused: input === document.activeElement,
              populated:
                input instanceof HTMLInputElement && input.value.length > 0,
              valid: input instanceof HTMLInputElement && input.validity.valid,
            };
          });
          console.info(
            "compatibility-form",
            JSON.stringify({
              event,
              saveFocused: save === document.activeElement,
              saveEnabled: save instanceof HTMLButtonElement && !save.disabled,
              fields,
            }),
          );
        },
        true,
      );
  });
});

test.afterEach(({ page }, testInfo) => {
  finishFontEvidence(page, testInfo);
});

async function start(page: Page, account: string): Promise<void> {
  await page.clock.setFixedTime(new Date(clockInstant));
  const initialList = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().endsWith("/api/habits"),
  );
  await page.goto(`/compatibility.html?account=${account}`);
  const response = await initialList;
  expect(response.status()).toBe(200);
  expect(z.array(habitSchema).parse(await response.json())).toEqual([]);
  await expect(
    page.getByRole("region", { name: "Saved habits" }),
  ).toContainText("No habits saved yet.");
  recordDiagnostic("initial-list-ready");
}

async function openByKeyboard(page: Page): Promise<void> {
  const add = page.getByRole("button", { name: "Add habit", exact: true });
  for (let index = 0; index < 8; index++) {
    if (await add.evaluate((element) => element === document.activeElement))
      break;
    await page.keyboard.press("Tab");
  }
  await expect(add).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create a habit" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
}

async function fillAndSave(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Create a habit" });
  await page.keyboard.type(habitName);
  for (const { label, value } of [
    { label: "Good", value: "5 minutes" },
    { label: "Better", value: "15 minutes" },
    { label: "Best", value: "30 minutes" },
  ]) {
    await page.keyboard.press("Tab");
    await expect(dialog.getByLabel(label, { exact: true })).toBeFocused();
    await page.keyboard.type(value);
  }
  for (const day of [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]) {
    await page.keyboard.press("Tab");
    const checkbox = dialog.getByLabel(day, { exact: true });
    await expect(checkbox).toBeFocused();
    if (day === "Monday" || day === "Wednesday") {
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
    }
  }
  const repeat = dialog.getByLabel("Repeat every (weeks)", { exact: true });
  await page.keyboard.press("Tab");
  await expect(repeat).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("2");
  await expect(repeat).toHaveValue("2");
  const save = dialog.getByRole("button", { name: "Save habit", exact: true });
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  recordDiagnostic("before-save-enter");
  await page.keyboard.press("Enter");
  recordDiagnostic("after-save-enter");
}

async function expectSaved(page: Page): Promise<void> {
  const saved = page.getByRole("region", { name: "Saved habits" });
  await expect(
    saved.getByRole("heading", { name: habitName, exact: true }),
  ).toBeVisible();
  await expect(saved.locator("article")).toHaveCount(1);
  for (const text of [
    "Good: 5 minutes",
    "Better: 15 minutes",
    "Best: 30 minutes",
    "Monday",
    "Wednesday",
    "Every 2 weeks",
  ])
    await expect(saved).toContainText(text);
  await expect(saved).not.toContainText("Sunday");
}

function expectHabit(habit: Habit): void {
  expect(habit).toMatchObject({
    name: habitName,
    good: "5 minutes",
    better: "15 minutes",
    best: "30 minutes",
    schedule: {
      weekdays: [1, 3],
      repeatEveryWeeks: 2,
      timeZone: "America/New_York",
    },
  });
}

async function saveAndReload(
  page: Page,
  beforeSave?: () => Promise<void>,
  afterSave?: () => Promise<void>,
): Promise<void> {
  await openByKeyboard(page);
  recordDiagnostic("dialog-open");
  if (beforeSave) await beforeSave();
  recordDiagnostic("creation-checkpoint-complete");
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/habits"),
  );
  recordDiagnostic("create-waiter-armed");
  recordSaveMarker(page, "create-waiter-armed");
  await fillAndSave(page);
  recordDiagnostic("create-response-await-start");
  recordSaveMarker(page, "create-response-await-start");
  const createdResponse = await created;
  recordDiagnostic("create-response-await-complete");
  recordSaveMarker(page, "create-response-await-complete");
  expect(createdResponse.status()).toBe(201);
  const createdHabit = habitSchema.parse(await createdResponse.json());
  recordDiagnostic("create-json-complete");
  recordSaveMarker(page, "create-json-complete");
  expectHabit(createdHabit);
  await expect(
    page.getByRole("dialog", { name: "Create a habit" }),
  ).toHaveCount(0);
  await expectSaved(page);
  recordDiagnostic("saved-assertions-complete");
  recordSaveMarker(page, "saved-assertions-complete");
  if (afterSave) await afterSave();
  const reloaded = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().endsWith("/api/habits"),
  );
  await page.reload();
  const reloadedResponse = await reloaded;
  expect(reloadedResponse.status()).toBe(200);
  const habits = z.array(habitSchema).parse(await reloadedResponse.json());
  expect(habits).toHaveLength(1);
  const stored = habits[0];
  if (!stored) throw new Error("Reloaded habit is missing.");
  expect(stored.id).toBe(createdHabit.id);
  expectHabit(stored);
  await expectSaved(page);
}

async function mutationControl(page: Page, testInfo: TestInfo): Promise<void> {
  const saved = page.getByRole("region", { name: "Saved habits" });
  const row = saved.locator(".habit-row");
  const before = await row.evaluate(
    (element) => getComputedStyle(element).paddingTop,
  );
  const style = await page.addStyleTag({
    content: ".habit-row { padding-top: 64px !important; }",
  });
  const after = await row.evaluate(
    (element) => getComputedStyle(element).paddingTop,
  );
  expect(after).not.toBe(before);
  expect(after).toBe("64px");
  let pixelMismatch = false;
  try {
    await expect(saved).toHaveScreenshot(
      "desktop-saved.png",
      screenshotOptions,
    );
  } catch (error) {
    pixelMismatch =
      error instanceof Error &&
      /Screenshot comparison failed|pixel.*differ|pixels.*different/i.test(
        error.message,
      );
  }
  expect(
    pixelMismatch,
    "Native screenshot assertion must reject changed saved-row geometry with a pixel mismatch.",
  ).toBe(true);
  const diffs = await nonemptyDiffs(testInfo.outputDir);
  expect(
    diffs.length,
    "Native screenshot assertion must emit a nonempty diff PNG.",
  ).toBeGreaterThan(0);
  await style.evaluate((element) => element.parentNode?.removeChild(element));
  expect(
    await row.evaluate((element) => getComputedStyle(element).paddingTop),
  ).toBe(before);
  await expect(saved).toHaveScreenshot("desktop-saved.png", screenshotOptions);
}

async function missingControl(page: Page): Promise<void> {
  const name = "intentionally-absent-compatibility-control.png";
  const expectedPath = join(baselineDir, name);
  await expect(access(expectedPath)).rejects.toThrow();
  let missingDiagnostic = false;
  try {
    await expect(
      page.getByRole("region", { name: "Saved habits" }),
    ).toHaveScreenshot(name);
  } catch (error) {
    missingDiagnostic =
      error instanceof Error &&
      /snapshot.*doesn.t exist|no snapshots|missing snapshot/i.test(
        error.message,
      );
  }
  expect(
    missingDiagnostic,
    "Native screenshot assertion must report the missing reviewed baseline.",
  ).toBe(true);
  await expect(access(expectedPath)).rejects.toThrow();
}

test("Firefox and WebKit create, save, and reload through the real API", async ({
  page,
}, testInfo) => {
  test.skip(!["firefox-smoke", "webkit-smoke"].includes(testInfo.project.name));
  const account =
    testInfo.project.name === "firefox-smoke"
      ? accounts["firefox-smoke"]
      : accounts["webkit-smoke"];
  await start(page, account);
  await saveAndReload(page);
});

test("desktop creation and saved details remain stable", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  await start(page, accounts["chromium-desktop"]);
  const creation = checkpointFor(testInfo.project.name, "desktop-creation");
  const saved = checkpointFor(testInfo.project.name, "desktop-saved");
  await saveAndReload(
    page,
    async () =>
      captureOrCompare(
        page,
        browser,
        testInfo,
        creation,
        page.getByRole("dialog", { name: "Create a habit" }),
      ),
    async () => {
      await captureOrCompare(
        page,
        browser,
        testInfo,
        saved,
        page.getByRole("region", { name: "Saved habits" }),
      );
      if (process.env["COMPAT_CONTROL"] === "mutation")
        await mutationControl(page, testInfo);
      if (process.env["COMPAT_CONTROL"] === "missing")
        await missingControl(page);
    },
  );
});

test("mobile saved layout remains stable", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-mobile");
  await start(page, accounts["chromium-mobile"]);
  const checkpoint = checkpointFor(testInfo.project.name, "mobile-layout");
  await saveAndReload(page, undefined, async () => {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByRole("region", { name: "Today" })).toContainText(
      "Nothing scheduled for today.",
    );
    await captureOrCompare(page, browser, testInfo, checkpoint, page);
  });
});
