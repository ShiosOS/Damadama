import { expect, test, type Page } from "@playwright/test";

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

async function createWalking(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Walking");
  await page.getByLabel("Good", { exact: true }).fill("5 minutes");
  await page.getByLabel("Better", { exact: true }).fill("15 minutes");
  await page.getByLabel("Best", { exact: true }).fill("30 minutes");
  await page.getByLabel("Monday", { exact: true }).check();
  await page.getByLabel("Wednesday", { exact: true }).check();
  await page.getByLabel("Repeat every", { exact: false }).fill("2");
  await page.getByRole("button", { name: "Save habit", exact: true }).click();
}

async function expectWalking(page: Page): Promise<void> {
  const list = page.getByRole("region", { name: "Saved habits" });
  await expect(
    list.getByRole("heading", { name: "Walking", exact: true }),
  ).toBeVisible();
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
