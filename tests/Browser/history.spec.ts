import { expect, test, type Page, type Locator } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { z } from "zod";
import { entrySchema } from "../../web/src/entries.schema";
import {
  habitSchema,
  editHabitSchema,
  type Habit,
} from "../../web/src/habits.schema";

test.use({ viewport: { width: 1280, height: 800 }, video: "on" });

async function open(
  page: Page,
  account: string,
  name: string,
): Promise<{ habit: Habit; token: string }> {
  await page.clock.setFixedTime(new Date("2026-01-05T00:30:00Z"));
  const tokens = z
    .record(z.string(), z.string())
    .parse(await (await page.request.get("/fixture.json")).json());
  const token = tokens[account];
  if (!token) throw new Error("The history fixture account is missing.");
  const response = await page.request.post("/api/habits", {
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
  expect(response.status()).toBe(201);
  const habit = habitSchema.parse(await response.json());
  await page.goto(`/?account=${account}`);
  await expect(savedRow(page, name)).toBeVisible();
  return { habit, token };
}

function savedRow(page: Page, name: string): Locator {
  return page
    .getByRole("region", { name: "Saved habits" })
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
}

function controls(page: Page, name: string): Locator {
  return page.getByRole("group", { name: `Result for ${name}`, exact: true });
}

async function capture(page: Page, path: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.effect?.getTiming().iterations === Infinity ||
          animation.playState !== "running",
      ),
  );
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(path, { path, contentType: "image/png" });
}

test("editing definitions updates the committed habit and keeps recorded entry text after reload", async ({
  page,
  context,
}) => {
  const video = page.video();
  if (!video) throw new Error("The history fixture requires video.");
  try {
    const { habit, token } = await open(
      page,
      "historyEdit",
      "Definition history",
    );
    await controls(page, habit.name)
      .getByRole("button", { name: "Good", exact: true })
      .click();
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "Good is saved.",
    );
    await savedRow(page, habit.name)
      .getByRole("button", { name: `Edit ${habit.name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Edit habit",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("New definition history");
    await dialog
      .getByRole("textbox", { name: "Good", exact: true })
      .fill("10 minutes");
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(savedRow(page, "New definition history")).toContainText(
      "10 minutes",
    );
    const today = page.getByRole("region", { name: "Today", exact: true });
    await expect(today).toContainText("5 minutes");
    const actual = habitSchema.parse(
      await (
        await page.request.get(`/api/habits/${habit.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json(),
    );
    expect(actual.schedule).toEqual(habit.schedule);
    await capture(page, ".audit/history-edit-immediate.png");
    await page.reload();
    await expect(savedRow(page, "New definition history")).toContainText(
      "10 minutes",
    );
    await expect(
      page.getByRole("region", { name: "Today", exact: true }),
    ).toContainText("5 minutes");
    await capture(page, ".audit/history-edit-reloaded.png");
  } finally {
    await context.close();
    await video.saveAs(".audit/history-edit.webm");
    await test.info().attach("History edit recording", {
      path: ".audit/history-edit.webm",
      contentType: "video/webm",
    });
  }
});

test.describe("dated schedule and archive history", () => {
  test.use({ timezoneId: "Asia/Tokyo" });

  test("removing today after a schedule edit retains the entry and the previous scheduled date", async ({
    page,
  }) => {
    const { habit, token } = await open(
      page,
      "historySchedule",
      "Schedule history",
    );
    await controls(page, habit.name)
      .getByRole("button", { name: "Good", exact: true })
      .click();
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "Good is saved.",
    );
    await savedRow(page, habit.name)
      .getByRole("button", { name: `Edit ${habit.name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Edit habit",
      exact: true,
    });
    await dialog
      .getByRole("checkbox", { name: "Monday", exact: true })
      .uncheck();
    await dialog
      .getByRole("spinbutton", { name: "Repeat every (weeks)", exact: true })
      .fill("2");
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      dialog.getByRole("group", { name: "Today's saved entry" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("textbox", { name: "Name", exact: true }),
    ).toBeDisabled();
    const beforeChoice = habitSchema.parse(
      await (
        await page.request.get(`/api/habits/${habit.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json(),
    );
    expect(beforeChoice.revision).toBe(0);
    await dialog
      .getByRole("button", { name: "Remove today", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("region", { name: "Today", exact: true }),
    ).toContainText("Retained entry");
    await controls(page, habit.name)
      .getByRole("button", { name: "Better", exact: true })
      .click();
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "Better is saved.",
    );
    const today = await page.request.get("/api/habits?scheduledOn=2026-01-05", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(z.array(habitSchema).parse(await today.json())).toEqual([]);
    await page.getByLabel("Calendar date", { exact: true }).fill("2026-01-04");
    await page.getByLabel("Calendar date", { exact: true }).press("Tab");
    await expect(
      page
        .getByRole("region", { name: "Entries", exact: true })
        .getByRole("heading", { name: habit.name, exact: true }),
    ).toBeVisible();
    const previous = await page.request.get(
      "/api/habits?scheduledOn=2026-01-04",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(
      z
        .array(habitSchema)
        .parse(await previous.json())
        .map((saved) => saved.id),
    ).toContain(habit.id);
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Today", exact: true }),
    ).toContainText("Retained entry");
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "Better is saved.",
    );
    await capture(page, ".audit/history-schedule-retained.png");
  });

  for (const choice of ["Keep", "Remove"]) {
    test(`archiving with ${choice} preserves saved history and excludes future recurrence`, async ({
      page,
      context,
    }) => {
      const account =
        choice === "Keep" ? "historyArchive" : "historyArchiveRemove";
      const { habit, token } = await open(page, account, `Archive ${choice}`);
      await controls(page, habit.name)
        .getByRole("button", { name: "Best", exact: true })
        .click();
      await expect(controls(page, habit.name).getByRole("status")).toHaveText(
        "Best is saved.",
      );
      await savedRow(page, habit.name)
        .getByRole("button", { name: `Archive ${habit.name}`, exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Archive habit",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "Archive habit", exact: true })
        .click();
      await expect(
        dialog.getByRole("group", { name: "Today's saved entry" }),
      ).toBeVisible();
      await dialog
        .getByRole("button", { name: `${choice} today`, exact: true })
        .click();
      await expect(dialog).toBeHidden();
      await expect(
        savedRow(page, habit.name).getByRole("button", {
          name: `Edit ${habit.name}`,
          exact: true,
        }),
      ).toBeFocused();
      await expect(savedRow(page, habit.name)).toContainText("Archived");
      const today = page.getByRole("region", { name: "Today", exact: true });
      if (choice === "Remove")
        await expect(today).toContainText("Retained entry");
      else await expect(today).not.toContainText("Retained entry");
      const future = await page.request.get(
        "/api/habits?scheduledOn=2026-01-06",
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(z.array(habitSchema).parse(await future.json())).toEqual([]);
      await page.reload();
      await expect(savedRow(page, habit.name)).toContainText("Archived");
      await expect(controls(page, habit.name).getByRole("status")).toHaveText(
        "Best is saved.",
      );
      await capture(page, `.audit/history-archive-${choice.toLowerCase()}.png`);
      if (choice === "Remove") {
        const video = page.video();
        if (!video) throw new Error("The archive fixture requires video.");
        await context.close();
        await video.saveAs(".audit/history-archive.webm");
        await test.info().attach("History archive recording", {
          path: ".audit/history-archive.webm",
          contentType: "video/webm",
        });
      }
    });
  }
});

test("retrying a lost acknowledgement reuses the committed mutation identity", async ({
  page,
}) => {
  const { habit, token } = await open(page, "historyRetry", "Retry history");
  const requests: string[] = [];
  await page.route(`**/api/habits/${habit.id}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const input = editHabitSchema.parse(route.request().postDataJSON());
    requests.push(input.mutationId);
    if (requests.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await savedRow(page, habit.name)
    .getByRole("button", { name: `Edit ${habit.name}`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit habit", exact: true });
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Retry committed");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(page.locator(`#habit-${habit.id}`)).toContainText(habit.name);
  await expect(page.locator(`#habit-${habit.id}`)).not.toContainText(
    "Retry committed",
  );
  await dialog
    .getByRole("button", { name: "Retry change", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(savedRow(page, "Retry committed")).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  const actual = habitSchema.parse(
    await (
      await page.request.get(`/api/habits/${habit.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json(),
  );
  expect(actual.revision).toBe(1);
});

test("a held old-account mutation response cannot restore private habits", async ({
  page,
}) => {
  const { habit } = await open(page, "historyAccount", "Private editor");
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observe = (): void => {};
  const started = new Promise<void>((resolve) => {
    observe = resolve;
  });
  await page.route(`**/api/habits/${habit.id}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    observe();
    await held;
    await route.fulfill({ response });
  });
  await savedRow(page, habit.name)
    .getByRole("button", { name: `Edit ${habit.name}`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit habit", exact: true });
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Private renamed");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await started;
  await page.evaluate(() =>
    window.dispatchEvent(new Event("fixture:other-account")),
  );
  await expect(dialog).toBeHidden();
  release();
  await expect(
    page.getByRole("region", { name: "Saved habits" }),
  ).not.toContainText("Private");
});

test("the editor keeps invalid drafts and supports mobile keyboard controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { habit } = await open(page, "historyMobile", "Mobile editing");
  const trigger = savedRow(page, habit.name).getByRole("button", {
    name: `Edit ${habit.name}`,
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Edit habit", exact: true });
  await dialog.getByRole("textbox", { name: "Good", exact: true }).fill(" ");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Good", exact: true }),
  ).toHaveValue(" ");
  await dialog
    .getByRole("textbox", { name: "Good", exact: true })
    .fill("10 minutes");
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, ".audit/history-editor-mobile.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("changing a failed draft starts a new command instead of replaying its older values", async ({
  page,
}) => {
  const { habit, token } = await open(
    page,
    "historyRetryDraft",
    "Corrected retry draft",
  );
  const commands: string[] = [];
  await page.route(`**/api/habits/${habit.id}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const input = editHabitSchema.parse(route.request().postDataJSON());
    commands.push(input.mutationId);
    if (commands.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await savedRow(page, habit.name)
    .getByRole("button", { name: `Edit ${habit.name}`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit habit", exact: true });
  await dialog
    .getByRole("textbox", { name: "Good", exact: true })
    .fill("8 minutes");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  const first = habitSchema.parse(
    await (
      await page.request.get(`/api/habits/${habit.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json(),
  );
  expect(first.good).toBe("8 minutes");
  expect(first.revision).toBe(1);
  await dialog
    .getByRole("textbox", { name: "Good", exact: true })
    .fill("10 minutes");
  await expect(
    dialog.getByRole("button", { name: "Retry change", exact: true }),
  ).toBeHidden();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(commands).toHaveLength(2);
  expect(commands[1]).not.toBe(commands[0]);
  const corrected = habitSchema.parse(
    await (
      await page.request.get(`/api/habits/${habit.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json(),
  );
  expect(corrected.good).toBe("10 minutes");
  expect(corrected.revision).toBe(2);
  await page.reload();
  await expect(savedRow(page, habit.name)).toContainText("10 minutes");
});

test("an entry acknowledgement survives a completed habit-change refresh", async ({
  page,
}) => {
  const { habit, token } = await open(
    page,
    "historyPending",
    "Pending entry across edit",
  );
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observe = (): void => {};
  const started = new Promise<void>((resolve) => {
    observe = resolve;
  });
  let acknowledge = (): void => {};
  const committed = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  await page.route(
    `**/api/habits/${habit.id}/entries/2026-01-04`,
    async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      observe();
      await held;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.fulfill({ response });
      acknowledge();
    },
  );
  try {
    await controls(page, habit.name)
      .getByRole("button", { name: "Good", exact: true })
      .click();
    await started;
    await savedRow(page, habit.name)
      .getByRole("button", { name: `Edit ${habit.name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Edit habit",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Good", exact: true })
      .fill("10 minutes");
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "No entry recorded.",
    );
    release();
    await committed;
    const stored = z.array(entrySchema).parse(
      await (
        await page.request.get("/api/entries?date=2026-01-04", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json(),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.result).toBe("Good");
    expect(stored[0]?.good).toBe("10 minutes");
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "Good is saved.",
    );
    await capture(page, ".audit/history-pending-entry.png");
    await page.reload();
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "Good is saved.",
    );
  } finally {
    release();
  }
});

test("a pending entry removed by archive retains its failed command and unchanged retry", async ({
  page,
}) => {
  const { habit, token } = await open(
    page,
    "historyPendingFailure",
    "Pending archive retry",
  );
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observe = (): void => {};
  const started = new Promise<void>((resolve) => {
    observe = resolve;
  });
  const writes: string[] = [];
  await page.route(
    `**/api/habits/${habit.id}/entries/2026-01-04`,
    async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      writes.push(route.request().postData() ?? "");
      if (writes.length === 1) {
        observe();
        await held;
        await route.abort("failed");
        return;
      }
      await route.continue();
    },
  );
  try {
    await controls(page, habit.name)
      .getByRole("button", { name: "Good", exact: true })
      .click();
    await started;
    await savedRow(page, habit.name)
      .getByRole("button", { name: `Archive ${habit.name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Archive habit",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Archive habit", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(savedRow(page, habit.name)).toContainText("Archived");
    const today = page.getByRole("region", { name: "Today", exact: true });
    await expect(today).toContainText("Pending entry");
    release();
    await expect(controls(page, habit.name).getByRole("alert")).toBeVisible();
    const empty = z.array(entrySchema).parse(
      await (
        await page.request.get("/api/entries?date=2026-01-04", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json(),
    );
    expect(empty).toEqual([]);
    await controls(page, habit.name)
      .getByRole("button", { name: "Retry save", exact: true })
      .click();
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "Good is saved.",
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(writes[0]);
    await expect(today).toContainText("Retained entry");
    await capture(page, ".audit/history-pending-retry.png");
    await page.reload();
    await expect(today).toContainText("Retained entry");
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "Good is saved.",
    );
  } finally {
    release();
  }
});

test("a delayed entry acknowledgement cannot replace a newer stored winner after refresh", async ({
  page,
}) => {
  const { habit, token } = await open(
    page,
    "historyPendingWinner",
    "Pending entry winner",
  );
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observe = (): void => {};
  const committed = new Promise<void>((resolve) => {
    observe = resolve;
  });
  let deliver = (): void => {};
  const delivered = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  await page.route(
    `**/api/habits/${habit.id}/entries/2026-01-04`,
    async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      expect(entrySchema.parse(await response.json()).result).toBe("Good");
      observe();
      await held;
      await route.fulfill({ response });
      deliver();
    },
  );
  try {
    await controls(page, habit.name)
      .getByRole("button", { name: "Good", exact: true })
      .click();
    await committed;
    const winner = await page.request.put(
      `/api/habits/${habit.id}/entries/2026-01-04`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          result: "Best",
          editedAt: "2026-01-05T00:30:00Z",
          deviceToday: "2026-01-04",
          timeZone: "America/New_York",
        },
      },
    );
    expect(winner.status()).toBe(200);
    expect(entrySchema.parse(await winner.json()).result).toBe("Best");
    await savedRow(page, habit.name)
      .getByRole("button", { name: `Edit ${habit.name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Edit habit",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Good", exact: true })
      .fill("10 minutes");
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "Best is saved.",
    );
    release();
    await delivered;
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "Best is saved.",
    );
    await page.reload();
    await expect(controls(page, habit.name).getByRole("status")).toHaveText(
      "Best is saved.",
    );
  } finally {
    release();
  }
});
