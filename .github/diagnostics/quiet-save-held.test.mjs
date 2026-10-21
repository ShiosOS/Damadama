import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { passiveFailure } from "./quiet-save-schema.mjs";
import { calibrationMatched, parseReceipt } from "./quiet-save-receipt.mjs";
import { mediaDirectory } from "./quiet-save-media.mjs";

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
      const retained = mediaDirectory(
        {
          control: "held-response",
          iteration: 0,
          phase: "calibration",
          project: "chromium-desktop",
          case: 1,
        },
        true,
      );
      assert.equal(
        retained,
        resolve(
          ".audit/quiet-save-self-test-evidence/media-held-response-0-0-chromium-desktop-1",
        ),
      );
      await rm(retained, { recursive: true, force: true });
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

test(
  "owned calibration preparation preserves case deadlines, options and passive hook binding",
  { timeout: 90000 },
  async () => {
    const directory = resolve(".audit/quiet-save-held-tests/preparation");
    const engine = "chromium";
    const moduleUrl = (path) => pathToFileURL(resolve(path)).href;
    const receiptPath = resolve(
      ".audit/quiet-save-self-test-evidence/presave-assertion-0.jsonl",
    );
    async function resetCapture() {
      const path = mediaDirectory(
        {
          control: "presave-assertion",
          iteration: 0,
          phase: "calibration",
          project: "chromium-desktop",
          case: 1,
        },
        true,
      );
      assert.equal(
        path,
        resolve(
          ".audit/quiet-save-self-test-evidence/media-presave-assertion-0-0-chromium-desktop-1",
        ),
      );
      await rm(path, { recursive: true, force: true });
      await rm(receiptPath, { force: true });
    }
    await mkdir(directory, { recursive: true });
    let mode;
    let requests = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        requests++;
        if (mode === "held") return;
        setTimeout(() => {
          response.writeHead(201, { "content-type": "application/json" });
          response.end("{}");
        }, 1000);
        return;
      }
      assert.equal(request.headers["x-calibration-option"], "preserved");
      response.setHeader("content-type", "text/html");
      response.end(
        '<button autofocus>Save</button><script>document.querySelector("button").onclick=()=>fetch("/api/habits",{method:"POST"});</script>',
      );
    });
    await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
    try {
      await writeFile(
        resolve(directory, "preparation-reporter.mjs"),
        `import {writeFileSync} from "node:fs";
export default class {
  onTestEnd(test, result) {
    writeFileSync(process.env.PREPARATION_RESULT, JSON.stringify({
      timeout: test.timeout, retry: result.retry,
      errors: result.errors.map(error => error.message),
      steps: result.steps.map(step => ({title: step.title, category: step.category, duration: step.duration})),
    }));
  }
}
`,
      );
      await writeFile(
        resolve(directory, "preparation.pw.mjs"),
        `import ${JSON.stringify(moduleUrl(".github/diagnostics/fixtures/passive-save.pw.mjs"))};
import {test} from "@playwright/test";
import assert from "node:assert/strict";
import {appendFileSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";
import {installPassiveSaveHooks} from ${JSON.stringify(moduleUrl(".github/diagnostics/quiet-save-passive.mjs"))};
const mode = process.env.PREPARATION_CASE;
const record = (name, value = {}) => appendFileSync(process.env.PREPARATION_EVENTS, JSON.stringify({name, ...value}) + "\\n");
let ownedPage;
let restore;
test.beforeAll(async ({browser}) => {
  const original = browser.newContext.bind(browser);
  restore = () => {browser.newContext = original;};
  browser.newContext = async (...args) => {
    record("context-start");
    await delay(mode === "context-bound" ? 6000 : 2800);
    const context = await original(...args);
    record("context-ready");
    context.on("close", () => record("context-closed"));
    const newPage = context.newPage.bind(context);
    context.newPage = async (...pageArgs) => {
      record("page-start");
      await delay(mode === "page-bound" ? 6000 : 2800);
      ownedPage = await newPage(...pageArgs);
      record("page-ready");
      return ownedPage;
    };
    return context;
  };
});
test.beforeEach(async ({page, context}, info) => {
  assert.equal(page, ownedPage);
  assert.equal(page.context(), context);
  assert.equal(context.browser().contexts().length, 1);
  assert.equal(page.url(), "about:blank");
  assert.deepEqual(page.viewportSize(), {width: 777, height: 555});
  assert.equal(await page.evaluate(() => navigator.language), "fr-FR");
  record("base-hook", {timeout: info.timeout});
  if (mode === "beforeEach-bound") await delay(2800);
});
installPassiveSaveHooks();
test.afterAll(() => restore());
`,
      );
      await writeFile(
        resolve(directory, "preparation.config.mjs"),
        `export default ${JSON.stringify({
          testDir: directory,
          testMatch: "preparation.pw.mjs",
          timeout: 2500,
          workers: 1,
          retries: 0,
          outputDir: resolve(directory, "results"),
          reporter: [
            [resolve(".github/diagnostics/quiet-save-reporter.mjs")],
            [resolve(directory, "preparation-reporter.mjs")],
          ],
          projects: [
            {
              name: "chromium-desktop",
              use: {
                browserName: engine,
                baseURL: `http://127.0.0.1:${server.address().port}`,
                viewport: { width: 777, height: 555 },
                locale: "fr-FR",
                contextOptions: {
                  extraHTTPHeaders: { "x-calibration-option": "preserved" },
                },
              },
            },
          ],
        })};\n`,
      );
      for (mode of [
        "fresh",
        "consumed",
        "held",
        "context-bound",
        "page-bound",
        "beforeEach-bound",
      ]) {
        requests = 0;
        await resetCapture();
        const eventPath = resolve(directory, `${mode}.events.jsonl`);
        await writeFile(eventPath, "");
        const exit = await new Promise((done, reject) => {
          const child = spawn(
            process.execPath,
            [
              "node_modules/@playwright/test/cli.js",
              "test",
              "--config",
              resolve(directory, "preparation.config.mjs"),
            ],
            {
              env: {
                ...process.env,
                QUIET_SELF_TEST: "1",
                QUIET_PROFILE: "passive",
                QUIET_CONTROL: "presave-assertion",
                QUIET_ITERATION: "0",
                QUIET_PHASE: "calibration",
                QUIET_PASSIVE_CASE: mode,
                PREPARATION_CASE: mode,
                PREPARATION_EVENTS: eventPath,
                PREPARATION_RESULT: resolve(directory, `${mode}.result.json`),
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (data) => (output += data));
          child.stderr.on("data", (data) => (output += data));
          child.once("error", reject);
          child.once("exit", (code) => done({ code, output }));
        });
        await writeFile(resolve(directory, `${mode}.log`), exit.output);
        assert.equal(exit.code, 1);
        const receipt = await readFile(receiptPath, "utf8");
        await writeFile(resolve(directory, `${mode}.jsonl`), receipt);
        const result = parseReceipt(receipt, "presave-assertion", 0).find(
          (row) => row.kind === "test-result",
        );
        const events = (await readFile(eventPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
        assert.equal(
          result.status,
          mode === "fresh" ? "failed" : "timedOut",
          mode,
        );
        const detail = passiveFailure.parse(result.passive);
        const raw = JSON.parse(
          await readFile(resolve(directory, `${mode}.result.json`), "utf8"),
        );
        assert.equal(raw.timeout, 2500, mode);
        assert.equal(raw.retry, 0, mode);
        assert.equal(detail.budget.configuredWholeTestMs, 2500, mode);
        assert.equal(detail.operations.kind, "complete", mode);
        const bodyRan = ["fresh", "consumed", "held"].includes(mode);
        assert.equal(requests, bodyRan ? 1 : 0, mode);
        if (bodyRan) {
          assert.deepEqual(
            events.map((event) => event.name),
            [
              "context-start",
              "context-ready",
              "page-start",
              "page-ready",
              "base-hook",
              "context-closed",
            ],
          );
          assert.equal(
            events.find((event) => event.name === "base-hook").timeout,
            2500,
          );
          assert.equal(detail.network.kind, "complete", mode);
          assert.deepEqual(
            detail.network.value.events.map((event) => event.event),
            mode === "fresh"
              ? [{ kind: "request" }, { kind: "response", status: 201 }]
              : [{ kind: "request" }],
          );
          const operations = detail.operations.value;
          assert(
            operations.some(
              (row) =>
                row.site.role === "save-enter" && row.end.kind === "success",
            ),
          );
          if (mode === "fresh") {
            assert(
              raw.errors.some(
                (error) =>
                  /Expected:.*true/s.test(error) &&
                  /Received:.*false/s.test(error),
              ),
            );
            assert.equal(operations.at(-1).site.operation, "assertion");
            assert.equal(operations.at(-1).end.kind, "error");
          } else {
            assert(
              raw.errors.some((error) =>
                error.includes("Test timeout of 2500ms exceeded"),
              ),
            );
            assert(
              detail.errors.value.some(
                (row) =>
                  row.errorIndex > 0 && row.correlation.kind === "unique-step",
              ),
            );
          }
        } else {
          assert.equal(detail.operations.value.length, 0, mode);
          if (mode === "beforeEach-bound") {
            assert(events.some((event) => event.name === "base-hook"));
            assert(
              raw.errors.some((error) =>
                error.includes("Test timeout of 2500ms exceeded while running"),
              ),
            );
          } else {
            assert(!events.some((event) => event.name === "base-hook"));
            const fixture = mode === "context-bound" ? "context" : "page";
            assert(
              raw.errors.some((error) =>
                error.includes(
                  `Fixture "${fixture}" timeout of 5000ms exceeded during setup`,
                ),
              ),
            );
          }
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    }
  },
);
