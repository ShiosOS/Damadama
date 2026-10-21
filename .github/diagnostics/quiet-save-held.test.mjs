import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { calibrationMatched, parseReceipt } from "./quiet-save-receipt.mjs";

test(
  "real 201 response stays held while the original 30-second waiter expires",
  { timeout: 65000 },
  async () => {
    let posts = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        posts++;
        response.writeHead(201, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<form class="habit-form">${["Name", "Good", "Better", "Best", "Repeat every (weeks)"].map((label) => `<input aria-label="${label}" required value="privacy-canary">`).join("")}<button type="submit">Save</button></form><script>document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); fetch('/api/habits', {method:'POST'}); });</script>`,
      );
    });
    await new Promise((resolveReady) =>
      server.listen(0, "127.0.0.1", resolveReady),
    );
    try {
      const directory = resolve(".audit/quiet-save-held-tests");
      await mkdir(directory, { recursive: true });
      const helper = resolve(
        ".github/diagnostics/quiet-save-observer.mjs",
      ).replaceAll("\\", "/");
      const reporter = resolve(
        ".github/diagnostics/quiet-save-reporter.mjs",
      ).replaceAll("\\", "/");
      await writeFile(
        resolve(directory, "held.spec.mjs"),
        `import { test } from "@playwright/test";
import * as quiet from ${JSON.stringify(helper)};
test.beforeEach(async ({ page }) => { await quiet.begin(page, "held-response"); });
test.afterEach(async ({ page }, info) => { await quiet.finish(page, info); });
test("desktop creation and saved details remain stable", async ({ page }) => {
  await page.goto("http://127.0.0.1:${server.address().port}");
  const created = page.waitForResponse(response => response.url().endsWith("/api/habits"));
  quiet.mark(page, "waiter-armed");
  await page.locator("button").focus();
  quiet.mark(page, "enter-sent");
  await page.keyboard.press("Enter");
  quiet.mark(page, "enter-returned");
  await created;
});
`,
      );
      await writeFile(
        resolve(directory, "config.mjs"),
        `export default { testDir: ".", testMatch: "held.spec.mjs", timeout: 30000, retries: 0, workers: 1, reporter: [[${JSON.stringify(reporter)}]], projects: [{ name: "chromium-desktop", use: { browserName: "chromium", trace: "off", screenshot: "off", video: "off" } }] };`,
      );
      const evidence = resolve(
        ".audit/quiet-save-self-test-evidence/held-response-0.jsonl",
      );
      await mkdir(resolve(".audit/quiet-save-self-test-evidence"), {
        recursive: true,
      });
      await writeFile(evidence, "");
      const result = await new Promise((resolveExit, reject) => {
        const child = spawn(
          process.execPath,
          [
            "node_modules/@playwright/test/cli.js",
            "test",
            "--config",
            resolve(directory, "config.mjs"),
          ],
          {
            stdio: "pipe",
            env: {
              ...process.env,
              QUIET_CONTROL: "held-response",
              QUIET_SELF_TEST: "1",
              QUIET_ITERATION: "0",
              QUIET_PHASE: "calibration",
            },
          },
        );
        child.stdout.resume();
        child.stderr.resume();
        child.on("error", reject);
        child.on("exit", resolveExit);
      });
      const text = await readFile(evidence, "utf8");
      assert.equal(
        calibrationMatched(
          parseReceipt(text, "held-response", 0),
          "held-response",
          result,
        ),
        true,
      );
      assert.equal(posts, 1);
      assert.equal(text.includes("privacy-canary"), false);
    } finally {
      server.closeAllConnections();
      await new Promise((resolveClosed) => server.close(resolveClosed));
    }
  },
);
