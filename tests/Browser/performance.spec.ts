import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

declare global {
  interface Window {
    qualityLayout: {
      supported: boolean;
      cls: number;
      score: number;
      start: number;
      last: number;
    };
  }
}

test.use({ viewport: { width: 1280, height: 800 } });

test("optimized habit page stays within layout and request budgets", async ({
  page,
}, testInfo) => {
  let requests = 0;
  let runtimeErrors = 0;
  let failedRequests = 0;
  let nonSuccessResponses = 0;
  const scripts = new Set<string>();
  page.on("pageerror", () => runtimeErrors++);
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors++;
  });
  page.on("request", () => requests++);
  page.on("requestfailed", () => failedRequests++);
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400) nonSuccessResponses++;
    if (path.startsWith("/assets/") && path.endsWith(".js")) scripts.add(path);
  });
  await page.addInitScript(() => {
    window.qualityLayout = {
      supported:
        PerformanceObserver.supportedEntryTypes.includes("layout-shift"),
      cls: 0,
      score: 0,
      start: 0,
      last: 0,
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (
          !("value" in entry) ||
          typeof entry.value !== "number" ||
          !("hadRecentInput" in entry) ||
          entry.hadRecentInput
        )
          continue;
        const metric = window.qualityLayout;
        if (
          entry.startTime - metric.last > 1000 ||
          entry.startTime - metric.start > 5000
        ) {
          metric.start = entry.startTime;
          metric.score = 0;
        }
        metric.last = entry.startTime;
        metric.score += entry.value;
        metric.cls = Math.max(metric.cls, metric.score);
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const firstGet = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/habits") &&
      response.request().method() === "GET",
  );
  const start = performance.now();
  await page.goto("/?account=performance");
  expect((await firstGet).status()).toBe(200);
  const list = page.getByRole("region", { name: "Saved habits" });
  await expect(list).toContainText("No habits saved yet.");
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const readyMs = performance.now() - start;
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Performance check");
  await page.getByLabel("Good", { exact: true }).fill("5 minutes");
  await page.getByLabel("Better", { exact: true }).fill("15 minutes");
  await page.getByLabel("Best", { exact: true }).fill("30 minutes");
  await page.getByLabel("Monday", { exact: true }).check();
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/habits") &&
      response.request().method() === "POST",
  );
  const saveStart = performance.now();
  await page.getByRole("button", { name: "Save habit", exact: true }).click();
  expect((await created).status()).toBe(201);
  const saved = list.getByRole("heading", {
    name: "Performance check",
    exact: true,
  });
  await expect(saved).toBeVisible();
  const saveMs = performance.now() - saveStart;
  const reloaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/habits") &&
      response.request().method() === "GET",
  );
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const firstDocumentLayout = await page.evaluate(() => window.qualityLayout);
  const reloadStart = performance.now();
  await page.reload();
  expect((await reloaded).status()).toBe(200);
  await expect(saved).toBeVisible();
  await expect(list).toContainText("Good: 5 minutes");
  await expect(list).toContainText("Better: 15 minutes");
  await expect(list).toContainText("Best: 30 minutes");
  await expect(list.getByText("Monday", { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const reloadMs = performance.now() - reloadStart;
  const reloadLayout = await page.evaluate(() => window.qualityLayout);
  const measurement = {
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    browser: testInfo.project.use.browserName ?? "chromium",
    viewport: { width: 1280, height: 800 },
    environment:
      "optimized local fixture, actual API and ephemeral PostgreSQL, test RSA JWT",
    budgets: { cls: 0.1, requests: 20 },
    cls: Math.max(firstDocumentLayout.cls, reloadLayout.cls),
    requests,
    runtimeErrors,
    failedRequests,
    nonSuccessResponses,
    optimizedScripts: scripts.size,
    diagnosticTimesMs: { ready: readyMs, save: saveMs, reload: reloadMs },
  };
  const json = `${JSON.stringify(measurement, null, 2)}\n`;
  await writeFile(".audit/performance-browser.json", json);
  await testInfo.attach("performance-measurement", {
    body: json,
    contentType: "application/json",
  });
  await page.screenshot({
    path: ".audit/performance-saved.png",
    fullPage: true,
  });
  expect(firstDocumentLayout.supported && reloadLayout.supported).toBe(true);
  expect(scripts.size).toBeGreaterThan(0);
  expect(runtimeErrors).toBe(0);
  expect(failedRequests).toBe(0);
  expect(nonSuccessResponses).toBe(0);
  expect(requests).toBeLessThanOrEqual(measurement.budgets.requests);
  expect(measurement.cls).toBeLessThanOrEqual(measurement.budgets.cls);
});
