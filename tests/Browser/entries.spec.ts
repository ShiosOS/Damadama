import { expect, test, type Locator, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { z } from "zod";
import { habitSchema, type Habit } from "../../web/src/habits.schema";
import {
  entrySchema,
  entryResultSchema,
  type Entry,
} from "../../web/src/entries.schema";

test.use({ viewport: { width: 1280, height: 800 }, video: "on" });

async function capture(page: Page, path: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      if (animation.effect?.getTiming().iterations === Infinity) return true;
      return animation.playState !== "running";
    }),
  );
  await page.screenshot({ path, fullPage: true });
}

async function openDailyHabit(
  page: Page,
  account: string,
  name: string,
): Promise<{ habit: Habit; token: string }> {
  await page.clock.setFixedTime(new Date("2026-01-05T00:30:00Z"));
  const tokens = z
    .record(z.string(), z.string())
    .parse(await (await page.request.get("/fixture.json")).json());
  const token = tokens[account];
  if (!token) throw new Error("The entry fixture account is missing.");
  const created = await page.request.post("/api/habits", {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name,
      good: "5 minutes",
      better: "15 minutes",
      best: "30 minutes",
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      repeatEveryWeeks: 1,
      timeZone: "America/New_York",
    },
  });
  expect(created.status()).toBe(201);
  const habit = habitSchema.parse(await created.json());
  await page.goto(`/?account=${account}`);
  await expect(
    page
      .getByRole("region", { name: "Saved habits" })
      .getByRole("heading", { name, exact: true }),
  ).toBeVisible();
  return { habit, token };
}

test("the committed result appears before any reload", async ({ page }) => {
  await openDailyHabit(page, "entriesImmediate", "Entry immediate");
  const controls = page.getByRole("group", {
    name: "Result for Entry immediate",
    exact: true,
  });
  await expect(controls).toBeVisible({ timeout: 2000 });
  await expect(controls.getByRole("status")).toHaveText("No entry recorded.");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/entries/2026-01-04"),
  );
  await controls.getByRole("button", { name: "Good", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(
    controls.getByRole("button", { name: "Good", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(controls.getByRole("status")).toHaveText("Good is saved.");
  await capture(page, ".audit/entries-immediate.png");
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
});

const controlsFor = (page: Page, name: string): Locator =>
  page.getByRole("group", { name: `Result for ${name}`, exact: true });

async function choose(
  page: Page,
  controls: Locator,
  result: string,
  seconds: number,
): Promise<Entry> {
  await page.clock.setFixedTime(
    new Date(Date.parse("2026-01-05T00:30:00Z") + seconds * 1000),
  );
  const acknowledged = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/entries/"),
  );
  await controls.getByRole("button", { name: result, exact: true }).click();
  const response = await acknowledged;
  expect(response.status()).toBe(200);
  const saved = entrySchema.parse(await response.json());
  await expect(
    controls.getByRole("button", { name: saved.result, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  return saved;
}

test("reload persistence is separate from immediate acknowledgment", async ({
  page,
}) => {
  await openDailyHabit(page, "entriesReload", "Entry reload");
  const controls = controlsFor(page, "Entry reload");
  await expect(controls).toBeVisible();
  await choose(page, controls, "Better", 1);
  await page.reload();
  await expect(controls.getByRole("status")).toHaveText("Better is saved.");
  await expect(
    controls.getByRole("button", { name: "Better", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await capture(page, ".audit/entries-reloaded.png");
});

test("rejected date input cannot leave controls targeting another date", async ({
  page,
}) => {
  await openDailyHabit(page, "entriesDate", "Entry date validation");
  const controls = controlsFor(page, "Entry date validation");
  await expect(controls).toBeVisible();
  const date = page.getByLabel("Calendar date", { exact: true });
  await date.fill("2026-01-06");
  await expect(date).toHaveValue("2026-01-04");
  await date.fill("");
  await expect(date).toHaveValue("2026-01-04");
  const saved = await choose(page, controls, "Good", 1);
  expect(saved.calendarDate).toBe("2026-01-04");
});

test("all five outcomes stay distinct after reload", async ({ page }) => {
  await openDailyHabit(page, "entriesOutcomes", "Entry outcomes");
  const controls = controlsFor(page, "Entry outcomes");
  await expect(controls).toBeVisible();
  let seconds = 1;
  for (const result of ["Good", "Better", "Best", "Rest", "Clear"]) {
    const saved = await choose(page, controls, result, seconds++);
    expect(saved.result).toBe(result);
    expect(saved.calendarDate).toBe("2026-01-04");
  }
  await expect(controls.getByRole("status")).toHaveText("Entry cleared.");
  await expect(
    controls.getByRole("button", { name: "Rest", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(controls.getByRole("status")).toHaveText("Entry cleared.");
  await expect(
    controls.getByRole("button", { name: "Clear", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("a committed write stays unconfirmed while its acknowledgment is held", async ({
  page,
}) => {
  const { token } = await openDailyHabit(page, "entriesHeld", "Entry held");
  const controls = controlsFor(page, "Entry held");
  await expect(controls).toBeVisible();
  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/habits/*/entries/*", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await controls.getByRole("button", { name: "Good", exact: true }).click();
  await committed.promise;
  try {
    const independent = await page.request.get("/api/entries?date=2026-01-04", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(
      z
        .array(entrySchema)
        .parse(await independent.json())
        .map((row) => row.result),
    ).toEqual(["Good"]);
    await expect(
      controls.getByRole("button", { name: "Good", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(controls.getByRole("status")).toHaveText("No entry recorded.");
    await expect(
      controls.getByRole("button", { name: "Clear", exact: true }),
    ).toBeDisabled();
    await capture(page, ".audit/entries-awaiting-ack.png");
  } finally {
    release.resolve();
  }
  await expect(controls.getByRole("status")).toHaveText("Good is saved.");
});

test("retry after a lost acknowledgment preserves the exact edit", async ({
  page,
}) => {
  await openDailyHabit(page, "entriesRetry", "Entry retry");
  const controls = controlsFor(page, "Entry retry");
  await expect(controls).toBeVisible();
  const requestSchema = z.object({
    result: entryResultSchema,
    editedAt: z.string(),
    deviceToday: z.iso.date(),
    timeZone: z.string(),
  });
  const writes: z.infer<typeof requestSchema>[] = [];
  await page.route("**/api/habits/*/entries/*", async (route) => {
    writes.push(requestSchema.parse(route.request().postDataJSON()));
    if (writes.length > 1) return route.continue();
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({ title: "The acknowledgment was lost." }),
    });
  });
  await controls.getByRole("button", { name: "Good", exact: true }).click();
  await expect(controls.getByRole("alert")).toContainText(
    "Could not confirm the save",
  );
  await expect(controls.getByRole("status")).toHaveText("No entry recorded.");
  await page.clock.setFixedTime(new Date("2026-01-05T00:40:00Z"));
  await controls
    .getByRole("button", { name: "Retry save", exact: true })
    .click();
  await expect(controls.getByRole("status")).toHaveText("Good is saved.");
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

test("creating another habit preserves an entry awaiting acknowledgment", async ({
  page,
}) => {
  await openDailyHabit(page, "entriesCreation", "Entry during creation");
  const controls = controlsFor(page, "Entry during creation");
  await expect(controls).toBeVisible();
  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/habits/*/entries/*", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await controls.getByRole("button", { name: "Good", exact: true }).click();
  await committed.promise;
  try {
    await page.getByRole("button", { name: "Add habit", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Create a habit" });
    await panel
      .getByLabel("Name", { exact: true })
      .fill("New habit during entry save");
    await panel.getByLabel("Good", { exact: true }).fill("Read one page");
    await panel.getByLabel("Better", { exact: true }).fill("Read five pages");
    await panel.getByLabel("Best", { exact: true }).fill("Read ten pages");
    await panel.getByLabel("Sunday", { exact: true }).check();
    await panel
      .getByRole("button", { name: "Save habit", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Today", exact: true })
        .getByRole("heading", {
          name: "New habit during entry save",
          exact: true,
        }),
    ).toBeVisible();
    await expect(controls.getByRole("status")).toHaveText("No entry recorded.");
  } finally {
    release.resolve();
  }
  await expect(controls.getByRole("status")).toHaveText("Good is saved.");
  await page.reload();
  await expect(controls.getByRole("status")).toHaveText("Good is saved.");
});

test("the browser displays the server winner when its own edit loses", async ({
  page,
}) => {
  const { habit, token } = await openDailyHabit(
    page,
    "entriesWinner",
    "Entry winner",
  );
  const controls = controlsFor(page, "Entry winner");
  await expect(controls.getByRole("status")).toHaveText("No entry recorded.");
  const otherDevice = await page.request.put(
    `/api/habits/${habit.id}/entries/2026-01-04`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        result: "Best",
        editedAt: "2026-01-05T00:40:00Z",
        deviceToday: "2026-01-04",
        timeZone: "America/New_York",
      },
    },
  );
  expect(otherDevice.status()).toBe(200);
  const winner = await choose(page, controls, "Good", 1);
  expect(winner.result).toBe("Best");
  await expect(controls.getByRole("status")).toHaveText("Best is saved.");
  await expect(
    controls.getByRole("button", { name: "Good", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});

for (const destination of ["other account", "sign out"]) {
  test(`a delayed entry acknowledgment stays private after ${destination}`, async ({
    page,
  }) => {
    await openDailyHabit(
      page,
      destination === "sign out" ? "entriesSignOut" : "entriesAccount",
      "Entry private",
    );
    const controls = controlsFor(page, "Entry private");
    await expect(controls).toBeVisible();
    const committed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/api/habits/*/entries/*", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    await controls.getByRole("button", { name: "Good", exact: true }).click();
    await committed.promise;
    const acknowledgment = page.waitForResponse(
      (response) => response.request().method() === "PUT",
    );
    try {
      await page
        .getByRole("button", { name: `Fixture ${destination}`, exact: true })
        .click();
      await expect(controls).toHaveCount(0);
    } finally {
      release.resolve();
    }
    await (await acknowledgment).finished();
    await expect(
      page.getByRole("heading", { name: "Entry private", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("Good is saved.", { exact: true })).toHaveCount(
      0,
    );
  });
}

test("date changes discard a delayed acknowledgment and refetch its original date", async ({
  page,
}) => {
  await openDailyHabit(page, "entriesDate", "Entry date");
  const controls = controlsFor(page, "Entry date");
  await expect(controls).toBeVisible();
  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/habits/*/entries/*", async (route) => {
    const response = await route.fetch();
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await controls.getByRole("button", { name: "Good", exact: true }).click();
  await committed.promise;
  const acknowledgment = page.waitForResponse(
    (response) => response.request().method() === "PUT",
  );
  try {
    await page.getByLabel("Calendar date", { exact: true }).fill("2026-01-03");
    await expect(controls).toHaveCount(0);
  } finally {
    release.resolve();
  }
  await (await acknowledgment).finished();
  await expect(page.getByText("Good is saved.", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Calendar date", { exact: true }).fill("2026-01-04");
  await expect(controls.getByRole("status")).toHaveText("Good is saved.");
});

test("a delayed save error stays hidden after sign-out", async ({ page }) => {
  await openDailyHabit(page, "entriesSignOut", "Entry delayed error");
  const controls = controlsFor(page, "Entry delayed error");
  await expect(controls).toBeVisible();
  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/habits/*/entries/*", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed.resolve();
    await release.promise;
    await route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({ title: "The acknowledgment was lost." }),
    });
  });
  await controls.getByRole("button", { name: "Good", exact: true }).click();
  await committed.promise;
  const failed = page.waitForResponse(
    (response) => response.request().method() === "PUT",
  );
  try {
    await page
      .getByRole("button", { name: "Fixture sign out", exact: true })
      .click();
    await expect(controls).toHaveCount(0);
  } finally {
    release.resolve();
  }
  expect((await failed).status()).toBe(503);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText("Could not confirm the save", { exact: true }),
  ).toHaveCount(0);
});

test("result controls remain usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await openDailyHabit(page, "entriesMobile", "Entry mobile");
  const controls = controlsFor(page, "Entry mobile");
  await expect(controls).toBeVisible();
  await choose(page, controls, "Rest", 1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, ".audit/entries-mobile.png");
});

test("retained unscheduled history stays visible and keeps original definitions", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-01-05T00:30:00Z"));
  await page.goto("/?account=entriesRetained");
  const today = page.getByRole("region", { name: "Today", exact: true });
  await expect(
    today.getByText("Retained entry", { exact: true }),
  ).toBeVisible();
  await expect(today).toContainText("Good: 5 minutes");
  await expect(today).toContainText("Better: 15 minutes");
  await expect(today).toContainText("Best: 30 minutes");
  await expect(today).not.toContainText("new good");
  const controls = controlsFor(page, "Retained walking");
  await expect(controls.getByRole("status")).toHaveText("Good is saved.");
  await choose(page, controls, "Better", 1);
  await page.reload();
  await expect(controls.getByRole("status")).toHaveText("Better is saved.");
  await expect(today).toContainText("Good: 5 minutes");
});

test.describe("entry calendar dates during travel", () => {
  test.use({ timezoneId: "" });
  test("Today follows the device while the recorded date remains fixed", async ({
    page,
    context,
  }) => {
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setTimezoneOverride", {
      timezoneId: "America/New_York",
    });
    await openDailyHabit(page, "entriesTravel", "Entry travel");
    const controls = controlsFor(page, "Entry travel");
    await expect(controls).toBeVisible();
    await choose(page, controls, "Better", 1);
    await session.send("Emulation.setTimezoneOverride", {
      timezoneId: "Asia/Tokyo",
    });
    expect(
      await page.evaluate(
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    ).toBe("Asia/Tokyo");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByLabel("Calendar date", { exact: true })).toHaveValue(
      "2026-01-05",
    );
    await expect(controls.getByRole("status")).toHaveText("No entry recorded.");
    await page.getByLabel("Calendar date", { exact: true }).fill("2026-01-04");
    await expect(controls.getByRole("status")).toHaveText("Better is saved.");
    const saved = await choose(page, controls, "Rest", 2);
    expect(saved.calendarDate).toBe("2026-01-04");
    await capture(page, ".audit/entries-past.png");
    await page.reload();
    await expect(page.getByLabel("Calendar date", { exact: true })).toHaveValue(
      "2026-01-05",
    );
    await page.getByLabel("Calendar date", { exact: true }).fill("2026-01-04");
    await expect(controls.getByRole("status")).toHaveText("Rest is saved.");
    await session.detach();
  });
});
