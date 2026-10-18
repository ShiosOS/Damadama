import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

type ScanResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type RuleResult = ScanResults["violations"][number];
type ScanReport = {
  state: string;
  sourceRevision: string;
  tags: string[];
  violations: {
    id: RuleResult["id"];
    impact: RuleResult["impact"];
    help: RuleResult["help"];
    nodes: {
      target: RuleResult["nodes"][number]["target"];
      failureSummary: RuleResult["nodes"][number]["failureSummary"];
    }[];
  }[];
  incomplete: { id: RuleResult["id"]; nodes: number }[];
  passedRules: number;
};

test.use({ viewport: { width: 1280, height: 800 }, video: "on" });

async function scan(
  page: Page,
  testInfo: TestInfo,
  state: string,
): Promise<ScanReport> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      if (animation.effect?.getTiming().iterations === Infinity) return true;
      return animation.playState !== "running";
    }),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
  const results = await new AxeBuilder({ page }).withTags(tags).analyze();
  const report: ScanReport = {
    state,
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    tags,
    violations: results.violations.map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      nodes: nodes.map(({ target, failureSummary }) => ({
        target,
        failureSummary,
      })),
    })),
    incomplete: results.incomplete.map(({ id, nodes }) => ({
      id,
      nodes: nodes.length,
    })),
    passedRules: results.passes.length,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(`.audit/accessibility-${state}.json`, json);
  await testInfo.attach(`accessibility-${state}`, {
    body: json,
    contentType: "application/json",
  });
  const screenshot = await page.screenshot({
    path: `.audit/accessibility-${state}.png`,
    fullPage: true,
  });
  await testInfo.attach(`accessibility-${state}-screen`, {
    body: screenshot,
    contentType: "image/png",
  });
  expect(report.passedRules).toBeGreaterThan(0);
  return report;
}

function assertAccessible(report: ScanReport): void {
  expect(report.violations, `WCAG violations in ${report.state}`).toEqual([]);
}

test("the audit rejects an unnamed button and accepts the repaired page", async ({
  page,
}, testInfo) => {
  await page.goto("/?account=accessibilityControl");
  await expect(
    page.getByRole("region", { name: "Saved habits" }),
  ).toContainText("No habits saved yet.");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "accessibility-missing-name";
    button.style.cssText = "width:40px;height:40px";
    document.querySelector("main")?.append(button);
  });
  const broken = await scan(page, testInfo, "control-missing-name");
  expect(broken.violations.map((rule) => rule.id)).toEqual(["button-name"]);
  expect(
    broken.violations.flatMap((rule) => rule.nodes.map((node) => node.target)),
  ).toEqual([["#accessibility-missing-name"]]);
  expect(() => assertAccessible(broken)).toThrow(/button-name/);
  await page
    .locator("#accessibility-missing-name")
    .evaluate((button) => button.remove());
  assertAccessible(await scan(page, testInfo, "control-repaired"));
});

test("the production entry explains missing sign-in configuration accessibly", async ({
  page,
}, testInfo) => {
  let realConfigStatus = 0;
  let habitRequests = 0;
  const scripts = new Set<string>();
  const errors: string[] = [];
  const apiOrigin = `http://localhost:${process.env["DAMADAMA_API_PORT"] ?? "5055"}`;
  page.on("pageerror", (error) => errors.push(error.name));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/habits") habitRequests++;
    if (path.startsWith("/assets/") && path.endsWith(".js")) scripts.add(path);
  });
  await page.route(`${apiOrigin}/api/config`, async (route) => {
    const response = await route.fetch();
    realConfigStatus = response.status();
    await route.fulfill({ response, json: { clerkPublishableKey: null } });
  });
  await page.goto(`${apiOrigin}/`);
  await expect(
    page.getByRole("heading", { name: "Damadama", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Sign-in needs development configuration."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Set the Clerk publishable key and issuer using the README startup instructions.",
    ),
  ).toBeVisible();
  expect(realConfigStatus).toBe(200);
  expect(scripts.size).toBeGreaterThan(0);
  expect(habitRequests).toBe(0);
  expect(errors).toEqual([]);
  assertAccessible(await scan(page, testInfo, "application-configuration"));
});

test("signed-out and expired-session messages pass WCAG scans", async ({
  page,
}, testInfo) => {
  let habitRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/habits") habitRequests++;
  });
  await page.goto("/?account=");
  await expect(
    page.getByText("Sign in to create and view your habits."),
  ).toBeVisible();
  expect(habitRequests).toBe(0);
  assertAccessible(await scan(page, testInfo, "signed-out"));
  const expired = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/habits" &&
      response.request().method() === "GET",
  );
  await page.goto("/?account=accessibilityExpired");
  expect((await expired).status()).toBe(401);
  await expect(
    page.getByRole("alert").filter({ hasText: "Sign in to continue." }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("region", { name: "Saved habits" }).locator("article"),
  ).toHaveCount(0);
  assertAccessible(await scan(page, testInfo, "expired-session"));
});

test("keyboard creation contains focus, explains API refusal, and persists a save", async ({
  page,
}, testInfo) => {
  const loaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/habits" &&
      response.request().method() === "GET",
  );
  await page.goto("/?account=accessibility");
  expect((await loaded).status()).toBe(200);
  const list = page.getByRole("region", { name: "Saved habits" });
  await expect(list).toContainText("No habits saved yet.");
  assertAccessible(await scan(page, testInfo, "empty-list"));
  for (const name of [
    "Fixture sign out",
    "Fixture other account",
    "Fixture owning account",
    "Add habit",
  ]) {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
  }
  const add = page.getByRole("button", { name: "Add habit", exact: true });
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Create a habit" });
  const name = panel.getByLabel("Name", { exact: true });
  const close = panel.getByRole("button", { name: "Close", exact: true });
  const save = panel.getByRole("button", { name: "Save habit", exact: true });
  const days = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const repeat = panel.getByLabel("Repeat every", { exact: false });
  await expect(name).toBeFocused();
  for (const control of [
    close,
    save,
    repeat,
    ...[...days]
      .reverse()
      .map((day) => panel.getByRole("checkbox", { name: day, exact: true })),
    panel.getByLabel("Best", { exact: true }),
    panel.getByLabel("Better", { exact: true }),
    panel.getByLabel("Good", { exact: true }),
    name,
  ]) {
    await page.keyboard.press("Shift+Tab");
    await expect(control).toBeFocused();
  }
  assertAccessible(await scan(page, testInfo, "creation-panel"));
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(add).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(name).toBeFocused();
  for (const [label, value] of [
    ["Name", "Keyboard walking"],
    ["Good", "5 minutes"],
    ["Better", "15 minutes"],
    ["Best", "30 minutes"],
  ] satisfies [string, string][]) {
    await expect(panel.getByLabel(label, { exact: true })).toBeFocused();
    await page.keyboard.insertText(value);
    await page.keyboard.press("Tab");
  }
  for (const day of days) {
    await expect(
      panel.getByRole("checkbox", { name: day, exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
  }
  await expect(repeat).toBeFocused();
  await expect(repeat).toHaveValue("1");
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  const rejected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/habits" &&
      response.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  expect((await rejected).status()).toBe(400);
  await expect(panel.getByRole("alert")).toContainText(
    "Select at least one weekday",
  );
  await expect(list.locator("article")).toHaveCount(0);
  await expect(name).toHaveValue("Keyboard walking");
  await expect(panel.getByRole("alert")).toBeFocused();
  assertAccessible(await scan(page, testInfo, "validation-refusal"));
  for (const control of [
    name,
    panel.getByLabel("Good", { exact: true }),
    panel.getByLabel("Better", { exact: true }),
    panel.getByLabel("Best", { exact: true }),
    ...days.map((day) =>
      panel.getByRole("checkbox", { name: day, exact: true }),
    ),
    repeat,
    save,
  ]) {
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
  }
  await expect(save).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(repeat).toBeFocused();
  for (const day of [...days].reverse()) {
    await page.keyboard.press("Shift+Tab");
    await expect(
      panel.getByRole("checkbox", { name: day, exact: true }),
    ).toBeFocused();
  }
  await page.keyboard.press("Space");
  await expect(
    panel.getByRole("checkbox", { name: "Monday", exact: true }),
  ).toBeChecked();
  for (const day of days.slice(1)) {
    await page.keyboard.press("Tab");
    await expect(
      panel.getByRole("checkbox", { name: day, exact: true }),
    ).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(repeat).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/habits" &&
      response.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  expect((await created).status()).toBe(201);
  await expect(panel).toHaveCount(0);
  await expect(add).toBeFocused();
  const saved = list.getByRole("heading", {
    name: "Keyboard walking",
    exact: true,
  });
  await expect(saved).toBeVisible();
  assertAccessible(await scan(page, testInfo, "saved-list"));
  const reloaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/habits" &&
      response.request().method() === "GET",
  );
  await page.reload();
  expect((await reloaded).status()).toBe(200);
  await expect(saved).toBeVisible();
  for (const value of [
    "Good: 5 minutes",
    "Better: 15 minutes",
    "Best: 30 minutes",
    "Monday",
    "Every 1 week",
  ]) {
    await expect(list).toContainText(value);
  }
  await expect(list.locator("article")).toHaveCount(1);
  assertAccessible(await scan(page, testInfo, "reloaded-list"));
});

for (const layout of [
  {
    state: "mobile",
    account: "accessibilityMobile",
    viewport: { width: 390, height: 640 },
    zoom: "1",
  },
  {
    state: "zoom",
    account: "accessibilityZoom",
    viewport: { width: 1280, height: 800 },
    zoom: "2",
  },
]) {
  test(`${layout.state} creation and saved content stay usable`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(layout.viewport);
    await page.goto(`/?account=${layout.account}`);
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = zoom;
    }, layout.zoom);
    await page.getByRole("button", { name: "Add habit", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Create a habit" });
    await expect(panel.getByLabel("Name", { exact: true })).toBeFocused();
    for (const [label, value] of [
      ["Name", `${layout.state} walking`],
      ["Good", "5 minutes"],
      ["Better", "15 minutes"],
      ["Best", "30 minutes"],
    ] satisfies [string, string][]) {
      await panel.getByLabel(label, { exact: true }).fill(value);
    }
    await panel.getByRole("checkbox", { name: "Monday", exact: true }).check();
    const save = panel.getByRole("button", { name: "Save habit", exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    assertAccessible(await scan(page, testInfo, `${layout.state}-panel`));
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/habits" &&
        response.request().method() === "POST",
    );
    await save.click();
    expect((await created).status()).toBe(201);
    const list = page.getByRole("region", { name: "Saved habits" });
    await expect(
      list.getByRole("heading", {
        name: `${layout.state} walking`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(list).toContainText("Best: 30 minutes");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    assertAccessible(await scan(page, testInfo, `${layout.state}-saved`));
  });
}
