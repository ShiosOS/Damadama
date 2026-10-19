import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ video: "on" });

test("Add habit opens a labelled creation panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Create a habit" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Name", { exact: true })).toBeFocused();
  await expect(
    panel.getByRole("button", { name: "Save habit", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await panel.boundingBox())?.width).toBe(420);
  await expect(
    panel.getByRole("button", { name: "Close", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: ".audit/habits-desktop-panel.png",
    fullPage: true,
  });
});

test("cancelling creation returns focus without saving", async ({ page }) => {
  await page.goto("/");
  let creates = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/habits"))
      creates++;
  });
  const add = page.getByRole("button", { name: "Add habit", exact: true });
  await add.click();
  await page.getByLabel("Name", { exact: true }).fill("Unsubmitted habit");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(creates).toBe(0);
});

test("account changes and sign out close and clear an unsaved panel", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Previous account draft");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("fixture:other-account")),
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("fixture:sign-out")),
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("Sign in to create and view your habits."),
  ).toBeVisible();
});

test("the creation panel remains usable on mobile and at double zoom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Damadama", exact: true }),
  ).toBeAttached();
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Create a habit" });
  await expect(panel).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await panel.getByLabel("Name", { exact: true }).click({ timeout: 5_000 });
  await page.getByLabel("Name", { exact: true }).fill("Mobile draft");
  await page.getByLabel("Good", { exact: true }).fill("5 minutes");
  await page.getByLabel("Better", { exact: true }).fill("15 minutes");
  await page.getByLabel("Best", { exact: true }).fill("30 minutes");
  await page.getByLabel("Sunday", { exact: true }).check();
  await page.getByLabel("Repeat every", { exact: false }).fill("3");
  const save = panel.getByRole("button", { name: "Save habit", exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: ".audit/habits-mobile-panel.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  const add = page.getByRole("button", { name: "Add habit", exact: true });
  await expect(add).toBeInViewport({ ratio: 1 });
  await add.click();
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

async function createWalking(page: Page, name = "Walking"): Promise<void> {
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Good", { exact: true }).fill("5 minutes");
  await page.getByLabel("Better", { exact: true }).fill("15 minutes");
  await page.getByLabel("Best", { exact: true }).fill("30 minutes");
  await page.getByLabel("Monday", { exact: true }).check();
  await page.getByLabel("Wednesday", { exact: true }).check();
  await page.getByLabel("Repeat every", { exact: false }).fill("2");
  await page.getByRole("button", { name: "Save habit", exact: true }).click();
}

async function expectWalking(page: Page, name = "Walking"): Promise<void> {
  const list = page.getByRole("region", { name: "Saved habits" });
  await expect(list.getByRole("heading", { name, exact: true })).toBeVisible();
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
}

test("saved values appear in the list before any reload", async ({ page }) => {
  await page.goto("/");
  await createWalking(page);
  await expect(
    page.getByRole("dialog", { name: "Create a habit" }),
  ).toHaveCount(0);
  await expectWalking(page);
  await expect(
    page
      .getByRole("region", { name: "Saved habits" })
      .getByRole("heading", { name: "Walking", exact: true }),
  ).toBeInViewport();
  await expect(
    page
      .getByRole("region", { name: "Saved habits" })
      .getByText("Every 2 weeks"),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: ".audit/habits-immediate.png",
    fullPage: true,
  });
});

test.describe("saved habit reveal", () => {
  const scheduledPath = "**/api/habits?scheduledOn=*";
  const today = (page: Page): Locator =>
    page.getByRole("region", { name: "Today", exact: true });

  async function openAccount(
    page: Page,
    account: string,
    date: string,
  ): Promise<void> {
    await page.clock.setFixedTime(new Date(`${date}T16:00:00Z`));
    await page.goto(`/?account=${account}`);
    expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
    await expect(today(page)).toContainText("Nothing scheduled for today.");
    await expect(
      page.getByRole("button", { name: "Add habit", exact: true }),
    ).toBeEnabled();
  }

  async function expectRevealed(page: Page, name = "Walking"): Promise<void> {
    await expectWalking(page, name);
    const saved = page.getByRole("region", { name: "Saved habits" });
    await expect(
      saved.getByRole("heading", { name, exact: true }),
    ).toBeInViewport();
    await expect(saved.getByText("Every 2 weeks").last()).toBeInViewport({
      ratio: 1,
    });
  }

  async function holdRefresh(page: Page): Promise<{
    received: Promise<void>;
    release: () => void;
    finished: Promise<void>;
  }> {
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let held = false;
    await page.route(scheduledPath, async (route) => {
      if (held) return route.continue();
      held = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      received.resolve();
      await release.promise;
      await route.fulfill({ response });
      finished.resolve();
    });
    return {
      received: received.promise,
      release: release.resolve,
      finished: finished.promise,
    };
  }

  async function expectClosed(page: Page): Promise<void> {
    await expect(
      page.getByRole("dialog", { name: "Create a habit" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Add habit", exact: true }),
    ).toBeFocused();
  }

  for (const scenario of [
    {
      account: "saveVisibilityIneligible",
      date: "2026-10-18",
      rows: 0,
      motion: "no-preference",
    },
    {
      account: "saveVisibilityEligible",
      date: "2026-10-19",
      rows: 1,
      motion: "no-preference",
    },
    {
      account: "saveVisibilityReduced",
      date: "2026-10-19",
      rows: 1,
      motion: "reduce",
    },
  ] satisfies {
    account: string;
    date: string;
    rows: number;
    motion: "no-preference" | "reduce";
  }[]) {
    test(`complete saved values are revealed on ${scenario.date} with ${scenario.motion} motion`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: scenario.motion });
      await openAccount(page, scenario.account, scenario.date);
      await createWalking(page);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(today(page).locator("article")).toHaveCount(scenario.rows);
      await expectRevealed(page);
      await page.screenshot({ path: `.audit/${scenario.account}.png` });
    });
  }

  test("a real Today response arriving after close autofocus reveals the saved schedule", async ({
    page,
  }) => {
    await openAccount(page, "saveVisibilityHeld", "2026-10-19");
    const refresh = await holdRefresh(page);
    try {
      await createWalking(page);
      await refresh.received;
      await expectClosed(page);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      refresh.release();
      await refresh.finished;
      await expect(
        today(page).getByRole("heading", { name: "Walking", exact: true }),
      ).toBeVisible();
      await expectRevealed(page);
      await page.screenshot({ path: ".audit/habits-reveal-held.png" });
    } finally {
      refresh.release();
    }
  });

  test("a new saved row is revealed below an already populated Today", async ({
    page,
  }) => {
    await openAccount(page, "saveVisibilityPopulated", "2026-10-19");
    await createWalking(page, "Morning walking");
    await expectRevealed(page, "Morning walking");
    await createWalking(page, "Evening walking");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(today(page).locator("article")).toHaveCount(2);
    const saved = page
      .getByRole("region", { name: "Saved habits" })
      .locator("article")
      .last();
    await expect(
      saved.getByRole("heading", { name: "Evening walking", exact: true }),
    ).toBeInViewport();
    for (const value of [
      "Good: 5 minutes",
      "Better: 15 minutes",
      "Best: 30 minutes",
      "Every 2 weeks",
      "Monday",
      "Wednesday",
    ])
      await expect(saved).toContainText(value);
    await expect(saved.getByText("Every 2 weeks")).toBeInViewport({ ratio: 1 });
  });

  test("a failed Today refresh still reveals the successfully committed habit", async ({
    page,
  }) => {
    await openAccount(page, "saveVisibilityError", "2026-10-19");
    await page.route(scheduledPath, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        body: JSON.stringify({ title: "Today is temporarily unavailable." }),
      });
    });
    await createWalking(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(today(page).getByRole("alert")).toContainText(
      "Today is temporarily unavailable.",
    );
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expectRevealed(page);
    await page.unroute(scheduledPath);
    await today(page)
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await expect(
      today(page).getByRole("heading", { name: "Walking", exact: true }),
    ).toBeVisible();
    await expectWalking(page);
  });

  for (const scenario of [
    { cancellation: "reopen", account: "saveVisibilityReopen" },
    { cancellation: "account", account: "saveVisibilityAccount" },
    { cancellation: "sign-out", account: "saveVisibilitySignOut" },
  ]) {
    test(`${scenario.cancellation} cancels a saved reveal while its real refresh is pending`, async ({
      page,
    }) => {
      const cancellation = scenario.cancellation;
      await openAccount(page, scenario.account, "2026-10-19");
      const refresh = await holdRefresh(page);
      try {
        await createWalking(page);
        await refresh.received;
        await expectClosed(page);
        if (cancellation === "reopen") {
          await page
            .getByRole("button", { name: "Add habit", exact: true })
            .click();
          await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
            "",
          );
          await page.getByLabel("Name", { exact: true }).fill("A new draft");
          await page.keyboard.press("Escape");
          await expectClosed(page);
        } else {
          await page.evaluate(
            (event) => window.dispatchEvent(new Event(event)),
            `fixture:${cancellation === "account" ? "other-account" : "sign-out"}`,
          );
          if (cancellation === "account")
            await expect(
              page.getByRole("region", { name: "Saved habits" }),
            ).toContainText("No habits saved yet.");
          else
            await expect(
              page.getByText("Sign in to create and view your habits."),
            ).toBeVisible();
        }
        refresh.release();
        await refresh.finished;
        if (cancellation === "reopen") {
          await expect(
            today(page).getByRole("heading", { name: "Walking", exact: true }),
          ).toBeVisible();
          await expectWalking(page);
        } else {
          await expect(
            page
              .getByRole("region", { name: "Saved habits" })
              .getByRole("heading", { name: "Walking", exact: true }),
          ).toHaveCount(0);
        }
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
        expect(await page.evaluate(() => scrollY)).toBe(0);
        if (cancellation === "reopen")
          await expect(
            page.getByRole("button", { name: "Add habit", exact: true }),
          ).toBeFocused();
      } finally {
        refresh.release();
      }
    });
  }

  test("a date change after refresh settles invalidates the reveal before close finishes", async ({
    page,
  }) => {
    await openAccount(page, "saveVisibilityDate", "2026-10-19");
    const underlyingToday = page.getByRole("region", {
      name: "Today",
      exact: true,
      includeHidden: true,
    });
    await page.evaluate(() => {
      document.addEventListener("animationstart", (event) => {
        const target = event.target;
        if (
          !(target instanceof HTMLElement) ||
          !target.matches('[role="dialog"][data-state="closed"]')
        )
          return;
        for (const animation of target.getAnimations()) animation.pause();
      });
    });
    await createWalking(page);
    await page.waitForFunction(() =>
      document
        .querySelector('[role="dialog"][data-state="closed"]')
        ?.getAnimations()
        .some((animation) => animation.playState === "paused"),
    );
    try {
      await expect(underlyingToday.locator("article h3")).toHaveText("Walking");
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      await page.clock.setFixedTime(new Date("2026-10-21T16:00:00Z"));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(underlyingToday.locator("time")).toHaveAttribute(
        "datetime",
        "2026-10-21",
      );
      await expect(underlyingToday.locator("article h3")).toHaveText("Walking");
    } finally {
      await page.evaluate(() => {
        for (const animation of document
          .querySelector('[role="dialog"]')
          ?.getAnimations() ?? [])
          animation.finish();
      });
    }
    await expectClosed(page);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await expectWalking(page);
    await expect(
      page
        .getByRole("region", { name: "Saved habits" })
        .getByText("Every 2 weeks"),
    ).not.toBeInViewport();
  });
});

test("reloading preserves every saved value", async ({ page }) => {
  await page.goto("/?account=reload");
  await createWalking(page);
  await expectWalking(page);
  await page.reload();
  await expectWalking(page);
});

test("saved values appear once with a non-interactive habit name", async ({
  page,
}) => {
  await page.goto("/?account=list");
  await createWalking(page);
  await expectWalking(page);
  const list = page.getByRole("region", { name: "Saved habits" });
  await expect(list.locator("article")).toHaveCount(1);
  await expect(list.getByRole("heading", { name: "Walking" })).toHaveCount(1);
  await expect(list.getByRole("button", { name: "Walking" })).toHaveCount(0);
  await expect(list.getByText("Good: 5 minutes")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Opened habit" })).toHaveCount(
    0,
  );
});

test("expired authentication explains how to continue", async ({ page }) => {
  await page.goto("/?account=expired");
  await expect(
    page.getByRole("alert").filter({ hasText: "Sign in to continue." }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("region", { name: "Saved habits" }).locator("article"),
  ).toHaveCount(0);
});

test("a rejected schedule keeps the form and offers a successful retry", async ({
  page,
}) => {
  await page.goto("/?account=errors");
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Walking");
  await page.getByLabel("Good", { exact: true }).fill("5 minutes");
  await page.getByLabel("Better", { exact: true }).fill("15 minutes");
  await page.getByLabel("Best", { exact: true }).fill("30 minutes");
  await page.getByRole("button", { name: "Save habit", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Select at least one weekday",
  );
  await expect(
    page.getByRole("region", { name: "Saved habits" }).locator("article"),
  ).toHaveCount(0);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Walking");
  await expect(
    page.getByRole("dialog", { name: "Create a habit" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Walking");
  await page.getByLabel("Monday", { exact: true }).check();
  await page.getByLabel("Wednesday", { exact: true }).check();
  await page.getByLabel("Repeat every", { exact: false }).fill("2");
  await page.getByRole("button", { name: "Save habit", exact: true }).click();
  await expectWalking(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("account change and sign out clear visible account data", async ({
  page,
}) => {
  await page.goto("/?account=cleanup");
  await createWalking(page);
  await expectWalking(page);
  await page
    .getByRole("button", { name: "Fixture other account", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Saved habits" }),
  ).toContainText("No habits saved yet.");
  await expect(
    page.getByRole("region", { name: "Saved habits" }).locator("article"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Fixture sign out", exact: true })
    .click();
  await expect(
    page.getByText("Sign in to create and view your habits."),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Saved habits" })).toHaveCount(
    0,
  );
});

test("save acknowledgement cannot reveal the previous accounts habit", async ({
  page,
}) => {
  await page.goto("/?account=stale");
  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/habits", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await createWalking(page);
  await committed.promise;
  await expect(
    page.getByRole("region", { name: "Saved habits" }).locator("article"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save habit", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Close", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Create a habit" }),
  ).toBeVisible();
  const acknowledgement = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/habits"),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("fixture:other-account")),
  );
  try {
    await expect(
      page.getByRole("dialog", { name: "Create a habit" }),
    ).toHaveCount(0);
  } finally {
    release.resolve();
  }
  await (await acknowledgement).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(
    page.getByRole("region", { name: "Saved habits" }),
  ).toContainText("No habits saved yet.");
  await expect(
    page.getByRole("region", { name: "Saved habits" }).locator("article"),
  ).toHaveCount(0);
});
