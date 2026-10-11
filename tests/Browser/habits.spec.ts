import { expect, test, type Page } from "@playwright/test";

async function createWalking(page: Page) {
  await page.getByLabel("Name", { exact: true }).fill("Walking");
  await page.getByLabel("Good", { exact: true }).fill("5 minutes");
  await page.getByLabel("Better", { exact: true }).fill("15 minutes");
  await page.getByLabel("Best", { exact: true }).fill("30 minutes");
  await page.getByLabel("Monday", { exact: true }).check();
  await page.getByLabel("Wednesday", { exact: true }).check();
  await page.getByLabel("Repeat every", { exact: false }).fill("2");
  await page.getByRole("button", { name: "Save habit", exact: true }).click();
}

async function expectWalking(page: Page) {
  const list = page.getByRole("region", { name: "Saved habits" });
  await expect(
    list.getByRole("button", { name: "Walking", exact: true }),
  ).toBeVisible();
  for (const value of [
    "Good: 5 minutes",
    "Better: 15 minutes",
    "Best: 30 minutes",
    "Monday, Wednesday every 2 weeks",
    "Created on 2026-01-04",
    "First repeat week starts Monday 2025-12-29",
    "America/New_York",
  ])
    await expect(list).toContainText(value);
}

test("saved values appear in the list before any reload", async ({ page }) => {
  await page.goto("/");
  await createWalking(page);
  await expectWalking(page);
  await expect(
    page
      .getByRole("region", { name: "Saved habits" })
      .getByRole("button", { name: "Walking", exact: true }),
  ).toBeInViewport();
  await expect(
    page
      .getByRole("region", { name: "Saved habits" })
      .getByText("First repeat week starts Monday 2025-12-29"),
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

test("opening a saved habit reads it from the server", async ({ page }) => {
  await page.goto("/?account=open");
  await createWalking(page);
  await expectWalking(page);
  let status: number | undefined;
  page.on("response", (response) => {
    if (
      /\/api\/habits\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "GET"
    )
      status = response.status();
  });
  await page
    .getByRole("region", { name: "Saved habits" })
    .getByRole("button", { name: "Walking", exact: true })
    .click();
  await expect.poll(() => status).toBe(200);
  await expect(
    page.getByRole("region", { name: "Opened habit" }),
  ).toContainText("Walking");
});

test("expired authentication explains how to continue", async ({ page }) => {
  await page.goto("/?account=expired");
  await expect(page.getByRole("alert")).toContainText("Sign in to continue.");
  await expect(
    page.getByRole("region", { name: "Saved habits" }).getByRole("button"),
  ).toHaveCount(0);
});

test("a rejected schedule keeps the form and offers a successful retry", async ({
  page,
}) => {
  await page.goto("/?account=errors");
  await page.getByLabel("Name", { exact: true }).fill("Walking");
  await page.getByLabel("Good", { exact: true }).fill("5 minutes");
  await page.getByLabel("Better", { exact: true }).fill("15 minutes");
  await page.getByLabel("Best", { exact: true }).fill("30 minutes");
  await page.getByRole("button", { name: "Save habit", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Select at least one weekday",
  );
  await expect(
    page.getByRole("region", { name: "Saved habits" }).getByRole("button"),
  ).toHaveCount(0);
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
    .getByRole("region", { name: "Saved habits" })
    .getByRole("button", { name: "Walking", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Opened habit" }),
  ).toContainText("Walking");
  await page
    .getByRole("button", { name: "Fixture other account", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Saved habits" }),
  ).toContainText("No habits saved yet.");
  await expect(
    page.getByRole("region", { name: "Saved habits" }).getByRole("button"),
  ).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Opened habit" })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
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
    page.getByRole("region", { name: "Saved habits" }).getByRole("button"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save habit", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Fixture other account", exact: true })
    .click();
  const acknowledgement = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/habits"),
  );
  release.resolve();
  await (await acknowledgement).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(
    page.getByRole("region", { name: "Saved habits" }),
  ).toContainText("No habits saved yet.");
  await expect(
    page.getByRole("region", { name: "Saved habits" }).getByRole("button"),
  ).toHaveCount(0);
});
