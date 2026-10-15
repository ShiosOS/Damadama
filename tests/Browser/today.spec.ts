import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { habitSchema } from "../../web/src/habits";

const instant = new Date("2026-01-05T00:30:00Z");
const travelInstant = new Date("2026-01-12T00:30:00Z");
const scheduledPath = "**/api/habits/scheduled?date=*";
const today = (page: Page) =>
  page.getByRole("region", { name: "Today", exact: true });
const walking = (page: Page) =>
  today(page).getByRole("heading", { name: "Walking", exact: true });
const browserErrors = new Map<Page, string[]>();

function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      message.text().startsWith("Failed to load resource:") &&
      message.text().includes("503")
    )
      return;
    errors.push(message.text());
  });
  return errors;
}

test.beforeEach(({ page }) => {
  browserErrors.set(page, observeErrors(page));
});
test.afterEach(({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
  browserErrors.delete(page);
});

async function tokenFor(page: Page, account: string) {
  const tokens = z
    .record(z.string(), z.string())
    .parse(await (await page.request.get("/fixture.json")).json());
  const token = tokens[account];
  if (!token) throw new Error("Missing browser fixture account.");
  return token;
}

async function seed(
  page: Page,
  account: string,
  weekdays = [7],
  repeatEveryWeeks = 1,
) {
  const response = await page.request.post("/api/habits", {
    headers: { Authorization: `Bearer ${await tokenFor(page, account)}` },
    data: {
      name: "Walking",
      good: "5 minutes",
      better: "15 minutes",
      best: "30 minutes",
      weekdays,
      repeatEveryWeeks,
      timeZone: "America/New_York",
    },
  });
  expect(response.status()).toBe(201);
  return habitSchema.parse(await response.json());
}

async function create(page: Page, name: string, weekday: string) {
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Create a habit" });
  await panel.getByLabel("Name", { exact: true }).fill(name);
  await panel.getByLabel("Good", { exact: true }).fill("5 minutes");
  await panel.getByLabel("Better", { exact: true }).fill("15 minutes");
  await panel.getByLabel("Best", { exact: true }).fill("30 minutes");
  await panel.getByLabel(weekday, { exact: true }).check();
  await panel.getByRole("button", { name: "Save habit", exact: true }).click();
  await expect(panel).toHaveCount(0);
}

async function focus(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

async function rendered(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

test("Today shows a scheduled habit and its stored definitions", async ({
  page,
}) => {
  await seed(page, "todayScheduled");
  await page.clock.install({ time: instant });
  await page.goto("/?account=todayScheduled");
  await expect(
    today(page).getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  await expect(today(page).locator("time")).toHaveAttribute(
    "datetime",
    "2026-01-04",
  );
  await expect(today(page).locator("time")).toContainText(
    "Sunday, January 4, 2026",
  );
  await expect(walking(page)).toBeVisible();
  for (const definition of [
    "Good: 5 minutes",
    "Better: 15 minutes",
    "Best: 30 minutes",
  ])
    await expect(today(page)).toContainText(definition);
  await expect(
    page
      .getByRole("region", { name: "Saved habits" })
      .getByRole("heading", { name: "Walking" }),
  ).toBeVisible();
  await page.screenshot({ path: ".audit/today-populated.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(walking(page)).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".audit/today-mobile.png", fullPage: true });
});

test("Today loading waits for a real scheduled read without showing an empty result", async ({
  page,
}) => {
  await seed(page, "todayLoading");
  await page.clock.install({ time: instant });
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  await page.route(scheduledPath, async (route) => {
    reads++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.goto("/?account=todayLoading");
  await received.promise;
  try {
    await expect(today(page).getByRole("status")).toHaveText(
      "Loading today's habits…",
    );
    await expect(today(page)).not.toContainText("Nothing scheduled for today.");
    await expect(today(page).locator("article")).toHaveCount(0);
  } finally {
    release.resolve();
  }
  await expect(walking(page)).toBeVisible();
  await focus(page);
  await focus(page);
  await rendered(page);
  expect(reads).toBe(1);
});

test("a Today service error stays distinct from empty and Retry reads the server", async ({
  page,
}) => {
  await seed(page, "todayError");
  await page.clock.install({ time: instant });
  let reads = 0;
  await page.route(scheduledPath, async (route) => {
    reads++;
    if (reads > 1) return route.continue();
    await route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({ title: "Today is temporarily unavailable." }),
    });
  });
  await page.goto("/?account=todayError");
  await expect(today(page).getByRole("alert")).toContainText(
    "Today is temporarily unavailable.",
  );
  await expect(today(page)).not.toContainText("Nothing scheduled for today.");
  await today(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(walking(page)).toBeVisible();
  await expect(today(page).getByRole("alert")).toHaveCount(0);
  expect(reads).toBe(2);
});

test("eligible and ineligible creations refresh Today before reload", async ({
  page,
}) => {
  await page.clock.install({ time: instant });
  await page.goto("/?account=todayCreate");
  await expect(today(page)).toContainText("Nothing scheduled for today.");
  let reads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/habits/scheduled?date=")) reads++;
  });
  await create(page, "Sunday walk", "Sunday");
  await expect(
    today(page).getByRole("heading", { name: "Sunday walk" }),
  ).toBeVisible();
  await create(page, "Monday walk", "Monday");
  await expect(
    page
      .getByRole("region", { name: "Saved habits" })
      .getByRole("heading", { name: "Monday walk" }),
  ).toBeVisible();
  await expect(
    today(page).getByRole("heading", { name: "Sunday walk" }),
  ).toBeVisible();
  await expect(
    today(page).getByRole("heading", { name: "Monday walk" }),
  ).toHaveCount(0);
  expect(reads).toBe(2);
});

test("reload preserves a saved scheduled habit in Today", async ({ page }) => {
  await page.clock.install({ time: instant });
  await page.goto("/?account=todayReload");
  await create(page, "Persistent walk", "Sunday");
  await expect(
    today(page).getByRole("heading", { name: "Persistent walk" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    today(page).getByRole("heading", { name: "Persistent walk" }),
  ).toBeVisible();
  await expect(today(page)).toContainText("Best: 30 minutes");
});

test("owner Today success precedes foreign empty and sign-out clears the view with direct API refusal", async ({
  page,
}) => {
  await seed(page, "todayOwner");
  await page.clock.install({ time: instant });
  await page.goto("/?account=todayOwner");
  await expect(walking(page)).toBeVisible();
  await page
    .getByRole("button", { name: "Fixture other account", exact: true })
    .click();
  await expect(today(page)).toContainText("Nothing scheduled for today.");
  await expect(walking(page)).toHaveCount(0);
  await page.screenshot({ path: ".audit/today-empty.png", fullPage: true });
  await page
    .getByRole("button", { name: "Fixture sign out", exact: true })
    .click();
  await expect(today(page)).toHaveCount(0);
  await expect(
    page.getByText("Sign in to create and view your habits."),
  ).toBeVisible();
  expect(
    (await page.request.get("/api/habits/scheduled?date=2026-01-04")).status(),
  ).toBe(401);
});

for (const outcome of ["Success", "Error"]) {
  test(`delayed old-account ${outcome.toLowerCase()} cannot replace the new account's Today`, async ({
    page,
  }) => {
    const account = `todayStale${outcome}`;
    await seed(page, account);
    await page.clock.install({ time: instant });
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    await page.route(scheduledPath, async (route) => {
      if (++reads > 1) return route.continue();
      const response = await route.fetch();
      received.resolve();
      await release.promise;
      if (outcome === "Error")
        return route.fulfill({
          status: 503,
          contentType: "application/problem+json",
          body: JSON.stringify({ title: "Previous account failure." }),
        });
      await route.fulfill({ response });
    });
    await page.goto(`/?account=${account}`);
    await received.promise;
    try {
      await page
        .getByRole("button", { name: "Fixture other account", exact: true })
        .click();
      await expect(today(page)).toContainText("Nothing scheduled for today.");
      const acknowledgement = page.waitForResponse((response) =>
        response.url().includes("/api/habits/scheduled?date=2026-01-04"),
      );
      release.resolve();
      await (await acknowledgement).finished();
    } finally {
      release.resolve();
    }
    await expect.poll(() => reads).toBe(2);
    await rendered(page);
    await expect(walking(page)).toHaveCount(0);
    await expect(today(page).getByRole("alert")).toHaveCount(0);
    await expect(today(page)).toContainText("Nothing scheduled for today.");
  });

  test(`delayed old-date ${outcome.toLowerCase()} detects a date change before accepting the response`, async ({
    page,
  }) => {
    const account = `todayDate${outcome}`;
    await seed(page, account);
    await page.clock.install({ time: instant });
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    await page.route(scheduledPath, async (route) => {
      if (++reads > 1) return route.continue();
      const response = await route.fetch();
      received.resolve();
      await release.promise;
      if (outcome === "Error")
        return route.fulfill({
          status: 503,
          contentType: "application/problem+json",
          body: JSON.stringify({ title: "Yesterday failed." }),
        });
      await route.fulfill({ response });
    });
    await page.goto(`/?account=${account}`);
    await received.promise;
    await page.clock.setSystemTime(new Date("2026-01-05T12:00:00Z"));
    const acknowledgement = page.waitForResponse((response) =>
      response.url().includes("/api/habits/scheduled?date=2026-01-04"),
    );
    release.resolve();
    await (await acknowledgement).finished();
    await expect(today(page).locator("time")).toHaveAttribute(
      "datetime",
      "2026-01-05",
    );
    await expect(today(page)).toContainText("Nothing scheduled for today.");
    await expect(walking(page)).toHaveCount(0);
    await expect(today(page).getByRole("alert")).toHaveCount(0);
    expect(reads).toBe(2);
  });
}

test("travel updates Today both directions in the same page while stored schedule dates stay fixed", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5174",
    timezoneId: "",
    viewport: { width: 1100, height: 900 },
    recordVideo: {
      dir: ".audit/today-video",
      size: { width: 1100, height: 900 },
    },
  });
  const page = await context.newPage();
  const errors = observeErrors(page);
  const video = page.video();
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setTimezoneOverride", {
      timezoneId: "America/Los_Angeles",
    });
    expect(
      await page.evaluate(
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    ).toBe("America/Los_Angeles");
    const habit = await seed(page, "todayTravel", [1], 2);
    expect(habit.schedule.creationDate).toBe("2026-01-04");
    expect(habit.schedule.firstWeekMonday).toBe("2025-12-29");
    await page.clock.install({ time: travelInstant });
    await page.goto("/?account=todayTravel");
    await expect(today(page).locator("time")).toHaveAttribute(
      "datetime",
      "2026-01-11",
    );
    await expect(today(page)).toContainText("Nothing scheduled for today.");
    await cdp.send("Emulation.setTimezoneOverride", {
      timezoneId: "Asia/Tokyo",
    });
    expect(
      await page.evaluate(
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    ).toBe("Asia/Tokyo");
    await focus(page);
    await expect(today(page).locator("time")).toHaveAttribute(
      "datetime",
      "2026-01-12",
    );
    await expect(walking(page)).toBeVisible();
    await page.waitForTimeout(800);
    await cdp.send("Emulation.setTimezoneOverride", {
      timezoneId: "America/Los_Angeles",
    });
    expect(
      await page.evaluate(
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    ).toBe("America/Los_Angeles");
    await focus(page);
    await expect(today(page).locator("time")).toHaveAttribute(
      "datetime",
      "2026-01-11",
    );
    await expect(today(page)).toContainText("Nothing scheduled for today.");
    await expect(walking(page)).toHaveCount(0);
    await page.waitForTimeout(800);
    const response = await page.request.get("/api/habits", {
      headers: {
        Authorization: `Bearer ${await tokenFor(page, "todayTravel")}`,
      },
    });
    expect(response.status()).toBe(200);
    const saved = z.array(habitSchema).parse(await response.json());
    expect(saved).toEqual([habit]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    if (video) await video.saveAs(".audit/today-flow.webm");
  }
});

test("local midnight refreshes Today automatically without focus or reload", async ({
  page,
}) => {
  await seed(page, "todayMidnight", [1]);
  await page.clock.install({ time: new Date("2026-01-05T04:59:59Z") });
  await page.goto("/?account=todayMidnight");
  await expect(today(page).locator("time")).toHaveAttribute(
    "datetime",
    "2026-01-04",
  );
  await expect(today(page)).toContainText("Nothing scheduled for today.");
  await page.clock.fastForward("00:02");
  await expect(today(page).locator("time")).toHaveAttribute(
    "datetime",
    "2026-01-05",
  );
  await expect(walking(page)).toBeVisible();
});

test("a device local date can remain in the prior year without showing a pre-creation habit", async ({
  page,
}) => {
  await seed(page, "todayYear", [3, 4]);
  await page.clock.install({ time: new Date("2026-01-01T00:30:00Z") });
  await page.goto("/?account=todayYear");
  await expect(today(page).locator("time")).toHaveAttribute(
    "datetime",
    "2025-12-31",
  );
  await expect(today(page)).toContainText("Nothing scheduled for today.");
  await expect(
    page
      .getByRole("region", { name: "Saved habits" })
      .getByRole("heading", { name: "Walking" }),
  ).toBeVisible();
});

test("a visible-return event checks the current device date", async ({
  page,
}) => {
  await seed(page, "todayVisible", [1]);
  await page.clock.install({ time: instant });
  await page.goto("/?account=todayVisible");
  await expect(today(page)).toContainText("Nothing scheduled for today.");
  await page.clock.setSystemTime(new Date("2026-01-05T12:00:00Z"));
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(today(page).locator("time")).toHaveAttribute(
    "datetime",
    "2026-01-05",
  );
  await expect(walking(page)).toBeVisible();
});

test("a read finishing after sign-out cannot restore Today or start midnight reads", async ({
  page,
}) => {
  await seed(page, "todayUnmount");
  await page.clock.install({ time: instant });
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  await page.route(scheduledPath, async (route) => {
    reads++;
    const response = await route.fetch();
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.goto("/?account=todayUnmount");
  await received.promise;
  await page
    .getByRole("button", { name: "Fixture sign out", exact: true })
    .click();
  const acknowledgement = page.waitForResponse((response) =>
    response.url().includes("/api/habits/scheduled?date="),
  );
  release.resolve();
  await (await acknowledgement).finished();
  await page.clock.fastForward("25:00:00");
  await focus(page);
  await expect(today(page)).toHaveCount(0);
  await expect(
    page.getByText("Sign in to create and view your habits."),
  ).toBeVisible();
  expect(reads).toBe(1);
});
