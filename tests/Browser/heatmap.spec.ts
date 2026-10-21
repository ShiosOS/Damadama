import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { z } from "zod";
import { habitSchema, type Habit } from "../../web/src/habits.schema";
import { heatmapSchema, type Heatmap } from "../../web/src/heatmap.schema";

const instant = new Date("2026-01-05T00:30:00Z");
const heatmapPath = "**/api/heatmap?**";
const heatmap = (page: Page): Locator =>
  page.getByRole("region", { name: "Yearly activity", exact: true });
const day = (page: Page, date = "2026-01-04"): Locator =>
  heatmap(page).locator(`[data-heatmap-date="${date}"]`);
test.use({
  viewport: { width: 1280, height: 800 },
  video: "on",
  hasTouch: true,
});

async function tokenFor(page: Page, account: string): Promise<string> {
  const tokens = z
    .record(z.string(), z.string())
    .parse(await (await page.request.get("/fixture.json")).json());
  const token = tokens[account];
  if (!token) throw new Error("Missing heatmap fixture account.");
  return token;
}

async function seed(
  page: Page,
  account: string,
  name: string,
  weekdays = [7],
): Promise<Habit> {
  const response = await page.request.post("/api/habits", {
    headers: { Authorization: `Bearer ${await tokenFor(page, account)}` },
    data: {
      name,
      good: "5 minutes",
      better: "15 minutes",
      best: "30 minutes",
      weekdays,
      repeatEveryWeeks: 1,
      timeZone: "America/New_York",
    },
  });
  expect(response.status()).toBe(201);
  return habitSchema.parse(await response.json());
}

async function save(
  page: Page,
  account: string,
  habit: Habit,
  result: string,
  seconds = 0,
): Promise<void> {
  const response = await page.request.put(
    `/api/habits/${habit.id}/entries/2026-01-04`,
    {
      headers: { Authorization: `Bearer ${await tokenFor(page, account)}` },
      data: {
        result,
        editedAt: new Date(instant.getTime() + seconds * 1000).toISOString(),
        deviceToday: "2026-01-04",
        timeZone: "America/New_York",
      },
    },
  );
  expect([200, 201]).toContain(response.status());
}

async function open(page: Page, account: string): Promise<void> {
  await page.clock.setFixedTime(instant);
  await page.goto(`/?account=${account}`);
  await expect(heatmap(page).locator("[data-heatmap-date]")).toHaveCount(365);
}

async function focus(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

async function screenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const image = await page.screenshot({
    path: testInfo.outputPath(name + ".png"),
    fullPage: true,
  });
  await testInfo.attach(name, { body: image, contentType: "image/png" });
}

test("committed Good Better Best and Rest appear as six of twelve points before and after reload", async ({
  page,
  context,
}, testInfo) => {
  const video = page.video();
  if (!video)
    throw new Error("The heatmap acceptance journey requires a recording.");
  try {
    for (const result of ["Good", "Better", "Best", "Rest"])
      await seed(page, "heatmap", "Heatmap " + result);
    await open(page, "heatmap");
    await expect(day(page)).toHaveAttribute("data-completion", "0");
    for (const result of ["Good", "Better", "Best", "Rest"]) {
      const controls = page.getByRole("group", {
        name: "Result for Heatmap " + result,
        exact: true,
      });
      const acknowledged = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().includes("/entries/2026-01-04"),
      );
      await controls.getByRole("button", { name: result, exact: true }).click();
      expect((await acknowledged).status()).toBe(201);
      await expect(controls.getByRole("status")).toHaveText(
        result + " is saved.",
      );
    }
    await expect(day(page)).toHaveAttribute("data-completion", "0.5");
    await day(page).hover();
    await expect(heatmap(page).getByRole("status")).toContainText(
      "6 of 12 points. 50% complete. 4 habits scheduled.",
    );
    expect(
      await day(page).evaluate(
        (cell) => getComputedStyle(cell, "::before").opacity,
      ),
    ).toBe("0.5");
    await screenshot(page, testInfo, "heatmap-immediate");
    await page.reload();
    await expect(day(page)).toHaveAttribute("data-completion", "0.5");
    await screenshot(page, testInfo, "heatmap-reloaded");
  } finally {
    await context.close();
    const recording = testInfo.outputPath("heatmap-flow.webm");
    await video.saveAs(recording);
    await testInfo.attach("heatmap-flow", {
      path: recording,
      contentType: "video/webm",
    });
  }
});

test("an unacknowledged entry leaves heatmap totals unchanged until the committed response returns", async ({
  page,
}) => {
  await seed(page, "heatmapReload", "Held heatmap");
  await open(page, "heatmapReload");
  const controls = page.getByRole("group", {
    name: "Result for Held heatmap",
    exact: true,
  });
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/habits/*/entries/*", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await controls.getByRole("button", { name: "Good", exact: true }).click();
  await received.promise;
  try {
    await expect(day(page)).toHaveAttribute("data-completion", "0");
    await expect(controls.getByRole("status")).not.toHaveText("Good is saved.");
  } finally {
    release.resolve();
  }
  await expect(day(page)).toHaveAttribute("data-completion", String(1 / 3));
  await page.reload();
  await expect(day(page)).toHaveAttribute("data-completion", String(1 / 3));
});

test("loading waits for a real read and displays no invented empty cells", async ({
  page,
}) => {
  await page.clock.setFixedTime(instant);
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(heatmapPath, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.goto("/?account=heatmapLoading");
  await received.promise;
  try {
    await expect(heatmap(page).getByRole("status")).toHaveText(
      "Loading yearly activity…",
    );
    await expect(heatmap(page).locator("[data-heatmap-date]")).toHaveCount(0);
    await expect(heatmap(page)).not.toContainText("Nothing scheduled");
  } finally {
    release.resolve();
  }
  await expect(heatmap(page).locator("[data-heatmap-date]")).toHaveCount(365);
});

test("service errors remain distinct from an empty year and Retry performs a fresh read", async ({
  page,
}) => {
  let reads = 0;
  await page.route(heatmapPath, async (route) => {
    reads++;
    if (reads > 1) return route.continue();
    await route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        title: "Yearly activity is temporarily unavailable.",
      }),
    });
  });
  await page.clock.setFixedTime(instant);
  await page.goto("/?account=heatmapError");
  await expect(heatmap(page).getByRole("alert")).toContainText(
    "Yearly activity is temporarily unavailable.",
  );
  await expect(heatmap(page).locator("[data-heatmap-date]")).toHaveCount(0);
  await heatmap(page)
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(day(page)).toHaveAttribute("aria-label", /Nothing scheduled/);
  expect(reads).toBe(2);
});

test("an old account response cannot restore its private totals after the account changes or signs out", async ({
  page,
}) => {
  const habit = await seed(page, "heatmapAccount", "Private heatmap");
  await save(page, "heatmapAccount", habit, "Best");
  await page.clock.setFixedTime(instant);
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  await page.route(heatmapPath, async (route) => {
    reads++;
    if (reads !== 1) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.goto("/?account=heatmapAccount");
  await received.promise;
  await page
    .getByRole("button", { name: "Fixture other account", exact: true })
    .click();
  try {
    await expect(day(page)).toHaveAttribute("aria-label", /Nothing scheduled/);
  } finally {
    release.resolve();
  }
  await expect(day(page)).toHaveAttribute("aria-label", /Nothing scheduled/);
  await page
    .getByRole("button", { name: "Fixture sign out", exact: true })
    .click();
  await expect(page.locator("[data-heatmap-date]")).toHaveCount(0);
});

test("travel refreshes the anchor and rejects a read that finishes for the old device date", async ({
  page,
  context,
}) => {
  await seed(page, "heatmapTravel", "Sunday history");
  await page.clock.setFixedTime(instant);
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  await page.route(heatmapPath, async (route) => {
    reads++;
    if (reads !== 1) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.goto("/?account=heatmapTravel");
  await received.promise;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Tokyo" });
  await focus(page);
  try {
    await expect(day(page, "2026-01-05")).toHaveAttribute(
      "aria-label",
      /Nothing scheduled/,
    );
    await expect(day(page, "2026-01-04")).toHaveAttribute(
      "data-completion",
      "0",
    );
  } finally {
    release.resolve();
  }
  await expect(day(page, "2026-01-05")).toHaveAttribute(
    "aria-label",
    /Nothing scheduled/,
  );
  await expect(heatmap(page).locator("time").last()).toHaveAttribute(
    "datetime",
    "2026-01-05",
  );
  expect(reads).toBe(2);
});

test("local midnight refreshes the anchor using controlled next-day totals", async ({
  page,
}) => {
  await seed(page, "heatmapDate", "Midnight Sunday");
  await page.clock.install({ time: new Date("2026-01-05T04:59:59Z") });
  await page.route(heatmapPath, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("deviceToday") !== "2026-01-05")
      return route.continue();
    url.searchParams.set("deviceToday", "2026-01-04");
    const response = await route.fetch({ url: url.toString() });
    expect(response.status()).toBe(200);
    const previous = heatmapSchema.parse(await response.json());
    const next: Heatmap = {
      start: "2025-01-06",
      end: "2026-01-05",
      days: [
        ...previous.days.slice(1),
        {
          date: "2026-01-05",
          scheduledCount: 0,
          earnedPoints: 0,
          maximumPoints: 0,
          completion: null,
        },
      ],
    };
    await route.fulfill({ response, json: next });
  });
  await page.goto("/?account=heatmapDate");
  await expect(heatmap(page).locator("time").last()).toHaveAttribute(
    "datetime",
    "2026-01-04",
  );
  await page.clock.fastForward("00:02");
  await expect(heatmap(page).locator("time").last()).toHaveAttribute(
    "datetime",
    "2026-01-05",
  );
  await expect(day(page, "2026-01-04")).toHaveAttribute("data-completion", "0");
  await expect(day(page, "2026-01-05")).toHaveAttribute(
    "aria-label",
    /Nothing scheduled/,
  );
});

test("focus and visible return refresh committed server totals at the same device date", async ({
  page,
}) => {
  const habit = await seed(page, "heatmapHistory", "Other-device entry");
  await open(page, "heatmapHistory");
  await expect(day(page)).toHaveAttribute("data-completion", "0");
  await save(page, "heatmapHistory", habit, "Best");
  await focus(page);
  await expect(day(page)).toHaveAttribute("data-completion", "1");
  await save(page, "heatmapHistory", habit, "Good", 1);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(day(page)).toHaveAttribute("data-completion", String(1 / 3));
});

test("neutral dates expose the same detail by hover keyboard and touch without page overflow", async ({
  page,
}, testInfo) => {
  await open(page, "heatmapMobile");
  const today = day(page);
  await expect(heatmap(page).locator("[data-heatmap-date]")).toHaveCount(365);
  await expect(today).not.toHaveAttribute("data-completion");
  await today.hover();
  await expect(heatmap(page).getByRole("status")).toContainText(
    "Nothing scheduled.",
  );
  await expect(heatmap(page).getByRole("status")).not.toContainText("%");
  await today.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(day(page, "2025-12-28")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(day(page, "2025-01-05")).toBeFocused();
  await expect(heatmap(page).getByRole("status")).toContainText(
    "Sunday, January 5, 2025. Nothing scheduled.",
  );
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
  await screenshot(page, testInfo, "heatmap-keyboard");
  await page.setViewportSize({ width: 390, height: 780 });
  await today.scrollIntoViewIfNeeded();
  await today.tap({ force: true });
  await expect(heatmap(page).getByRole("status")).toContainText(
    "Sunday, January 4, 2026. Nothing scheduled.",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await screenshot(page, testInfo, "heatmap-mobile");
});
