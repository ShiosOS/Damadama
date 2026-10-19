import { expect, test } from "@playwright/test";

test("a dismissed draft retains its values and the acknowledged habit survives reload", async ({
  page,
}) => {
  await page.goto("/?account=performance");
  const add = page.getByRole("button", { name: "Add habit", exact: true });
  await add.click();
  const panel = page.getByRole("dialog", { name: "Create a habit" });
  const fields = [
    ["Name", "Verification walking"],
    ["Good", "5 minutes"],
    ["Better", "15 minutes"],
    ["Best", "30 minutes"],
  ];
  for (const [label, value] of fields)
    await panel.getByLabel(label, { exact: true }).fill(value);
  await panel.getByLabel("Sunday", { exact: true }).check();
  await panel.getByLabel("Repeat every", { exact: false }).fill("2");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  for (const [label, value] of fields)
    await expect(panel.getByLabel(label, { exact: true })).toHaveValue(value);
  await expect(panel.getByLabel("Sunday", { exact: true })).toBeChecked();
  await expect(panel.getByLabel("Repeat every", { exact: false })).toHaveValue(
    "2",
  );
  const acknowledged = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" && url.pathname === "/api/habits"
    );
  });
  await panel.getByRole("button", { name: "Save habit", exact: true }).click();
  expect((await acknowledged).status()).toBe(201);
  await expect(panel).toHaveCount(0);
  const saved = page.getByRole("region", { name: "Saved habits", exact: true });
  for (const phase of ["immediate", "reloaded"]) {
    if (phase === "reloaded") await page.reload();
    await expect(
      saved.getByRole("heading", { name: "Verification walking", exact: true }),
    ).toBeVisible();
    for (const text of [
      "5 minutes",
      "15 minutes",
      "30 minutes",
      "Sunday",
      "Every 2 weeks",
    ])
      await expect(saved).toContainText(text);
    await page.screenshot({
      path: `.audit/verification-skill/habit-${phase}.png`,
      fullPage: true,
    });
  }
});

test("saved-list loading and authentication refusal retain their observable states", async ({
  page,
}, testInfo) => {
  const received = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route("**/api/habits", async (route) => {
    const response = await route.fetch();
    received.resolve(response);
    await release.promise;
    await route.fulfill({ response });
  });
  await page.goto("/?account=other");
  const initial = await received.promise;
  const saved = page.getByRole("region", { name: "Saved habits", exact: true });
  let emptyWhileLoading;
  try {
    expect(initial.status()).toBe(200);
    await expect(saved.getByRole("status")).toContainText("Loading habits");
    await expect(saved.locator("article")).toHaveCount(0);
    await expect(saved.getByText("No habits saved yet.")).toHaveCount(0);
    emptyWhileLoading = await saved
      .getByText("No habits saved yet.")
      .isVisible();
    await page.screenshot({
      path: ".audit/verification-skill/saved-list-loading.png",
      fullPage: true,
    });
  } finally {
    release.resolve();
  }
  await expect(saved.getByRole("status")).toHaveCount(0);
  await expect(saved.getByText("No habits saved yet.")).toBeVisible();
  await page.unroute("**/api/habits");
  const refused = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/habits" && url.search === "";
  });
  await page.goto("/?account=expired");
  expect((await refused).status()).toBe(401);
  await expect(page.getByRole("alert")).toHaveCount(2);
  await expect(saved.locator("article")).toHaveCount(0);
  await expect(saved.getByRole("status")).toHaveCount(0);
  await expect(saved.getByText("No habits saved yet.")).toHaveCount(0);
  const emptyAfterRefusal = await saved
    .getByText("No habits saved yet.")
    .isVisible();
  await page.screenshot({
    path: ".audit/verification-skill/saved-list-refused.png",
    fullPage: true,
  });
  await testInfo.attach("saved-list-state-observations", {
    body: JSON.stringify({ emptyWhileLoading, emptyAfterRefusal }),
    contentType: "application/json",
  });
});

test("the Today button returns from Entries to the device date through real reads", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-01-05T00:30:00Z") });
  await page.goto("/?account=other");
  const date = page.getByLabel("Calendar date", { exact: true });
  const today = page.getByRole("region", { name: "Today", exact: true });
  await expect(today.getByText("Nothing scheduled for today.")).toBeVisible();
  await expect(date).toHaveValue("2026-01-04");
  await date.fill("2026-01-03");
  const entries = page.getByRole("region", { name: "Entries", exact: true });
  await expect(
    entries.getByText("Nothing scheduled for this date."),
  ).toBeVisible();
  await expect(date).toHaveValue("2026-01-03");
  await page.screenshot({
    path: ".audit/verification-skill/calendar-past.png",
    fullPage: true,
  });
  const scheduled = page.waitForResponse(
    "**/api/habits?scheduledOn=2026-01-04",
  );
  const recorded = page.waitForResponse("**/api/entries?date=2026-01-04");
  await entries.getByRole("button", { name: "Today", exact: true }).click();
  expect((await scheduled).status()).toBe(200);
  expect((await recorded).status()).toBe(200);
  await expect(today.getByText("Nothing scheduled for today.")).toBeVisible();
  await expect(date).toHaveValue("2026-01-04");
  await expect(entries).toHaveCount(0);
  await page.screenshot({
    path: ".audit/verification-skill/calendar-today.png",
    fullPage: true,
  });
});
