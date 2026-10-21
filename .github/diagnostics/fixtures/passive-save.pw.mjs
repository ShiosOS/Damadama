import { test, expect } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";

async function fillAndSave(page) {
  await page.keyboard.press("Enter");
}

async function saveAndReload(page) {
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/habits"),
  );
  created.catch(() => {});
  if (process.env.QUIET_PASSIVE_CASE === "pre-enter")
    await expect(page.locator("#missing")).toBeVisible({ timeout: 0 });
  await fillAndSave(page);
  if (process.env.QUIET_PASSIVE_CASE === "worker-exit") process.exit(47);
  await created;
}

test("desktop creation and saved details remain stable", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button")).toBeFocused();
  if (process.env.QUIET_PASSIVE_CASE === "consumed") await delay(1500);
  if (process.env.QUIET_PASSIVE_CASE === "foreign") {
    const foreign = await context.newPage();
    await foreign.goto("/");
    await foreign.evaluate(async () => {
      await fetch("/api/habits", { method: "POST" });
    });
    await foreign.close();
  }
  if (process.env.QUIET_PASSIVE_CASE === "two-posts") {
    await page.evaluate(async () => {
      await fetch("/api/habits", { method: "POST" });
    });
  }
  if (process.env.QUIET_PASSIVE_CASE === "subframe") {
    await page.evaluate(
      () =>
        new Promise((resolveDone) => {
          window.addEventListener("message", () => resolveDone(), {
            once: true,
          });
          const frame = document.createElement("iframe");
          frame.src = "/frame";
          document.body.append(frame);
        }),
    );
  }
  if (process.env.QUIET_PASSIVE_CASE === "overflow") {
    for (let index = 0; index < 5; index++)
      await page.evaluate(async () => {
        await fetch("/api/habits", { method: "POST" });
      });
  }
  await saveAndReload(page);
  expect(false).toBe(true);
});
