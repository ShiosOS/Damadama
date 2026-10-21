import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { classify, observation, errorCategory } from "./quiet-save-schema.mjs";
import { instrument, replaceOnce } from "./quiet-save-generate.mjs";
import { mediaDirectory } from "./quiet-save-media.mjs";
import {
  begin,
  finish,
  mark,
  installBrowserObserver,
} from "./quiet-save-observer.mjs";
import {
  parseReceipt,
  calibrationMatched,
  invocationPassed,
  phases,
} from "./quiet-save-receipt.mjs";

const nodeEvent = (event) => ({ origin: "node-performance", ms: 1, event });

test("receipt validates every row and the complete six-phase routed case set", () => {
  const rows = [];
  for (const [index, phase] of phases.entries()) {
    const base = { iteration: 1, control: "normal", phase };
    let projects = ["chromium-desktop"];
    if (index === 0) projects = ["firefox-smoke", "webkit-smoke"];
    else if (index <= 3) projects = ["chromium-desktop", "chromium-mobile"];
    rows.push({ ...base, kind: "phase-start", cases: projects.length * 3 });
    for (const project of projects)
      for (let id = 0; id < 3; id++) {
        let active = 0;
        if (project === "chromium-desktop") active = 1;
        if (project === "chromium-mobile") active = 2;
        rows.push({
          ...base,
          kind: "test-result",
          project,
          case: id,
          status: id === active ? "passed" : "skipped",
          durationMs: 0,
          retry: 0,
          errorCategories: [],
          errorOverflow: false,
          observation: null,
          observationRejected: false,
          failure: null,
          media: null,
          mediaRejected: false,
          classification: "unknown",
        });
      }
    rows.push({ ...base, kind: "phase-end", status: "passed" });
  }
  const serialize = (values) =>
    values.map((row) => JSON.stringify(row)).join("\n");
  assert.equal(
    invocationPassed(parseReceipt(serialize(rows), "normal", 1), 0),
    true,
  );
  assert.equal(invocationPassed(rows.slice(1), 0), false);
  assert.equal(
    invocationPassed([...rows, { ...rows[1], phase: "calibration" }], 0),
    false,
  );
  const duplicate = structuredClone(rows);
  duplicate[1] = duplicate[2];
  assert.equal(invocationPassed(duplicate, 0), false);
  const unknown = structuredClone(rows);
  unknown[1].token = "privacy-canary";
  assert.throws(() => parseReceipt(serialize(unknown), "normal", 1));
  assert.throws(() => parseReceipt(serialize(rows), "normal", 2));
  assert.throws(() =>
    parseReceipt(serialize(Array(129).fill(rows[0])), "normal", 1),
  );
});

test("strict observation boundary refuses secrets, unknown values and overflow", () => {
  const good = {
    schema: 2,
    font: null,
    node: [nodeEvent("test-start")],
    browser: [],
    refusal: "none",
  };
  assert.equal(observation.safeParse(good).success, true);
  for (const bad of [
    { ...good, token: "privacy-canary" },
    { ...good, node: [{ ...nodeEvent("test-start"), url: "privacy-canary" }] },
    { ...good, node: Array(65).fill(nodeEvent("test-start")) },
    { ...good, browser: Array(257).fill({}) },
    { ...good, refusal: "privacy-canary" },
  ]) {
    assert.equal(observation.safeParse(bad).success, false);
    assert.equal(classify(bad), "unknown");
  }
  assert.equal(classify({ ...good, refusal: "overflow" }), "unknown");
  assert.equal(
    errorCategory({ message: "privacy-canary" }),
    "unknown-runner-error",
  );
  assert.equal(
    errorCategory({
      message: "page.waitForResponse: Test timeout of 30000ms exceeded.",
    }),
    "pending-waiter-global-timeout",
  );
});

test("generated hooks leave canonical actions, assertions, screenshots and reload intact", async () => {
  const source = await readFile("tests/Browser/compatibility.pw.ts", "utf8");
  let generated = instrument(source);
  generated = generated.slice(
    generated.indexOf("\n") + 1,
    generated.lastIndexOf("\ntest.beforeEach"),
  );
  generated = generated
    .replace('"../../tests/Browser/visual-support"', '"./visual-support"')
    .replace(/^  quiet\.mark\(page, "fill-boundary",.*\n/gm, "")
    .replace(/^  quiet\.mark\(page, "phase-boundary",.*\n/gm, "")
    .replace(
      /  if \(beforeSave\) \{\n[\s\S]*?\n  \}\n  const created =/,
      "  if (beforeSave) await beforeSave();\n  const created =",
    )
    .replace(
      "  if (quiet.isDeadline(page) && !(await quiet.deadlineGate(page))) return;\n",
      "",
    )
    .replace('  quiet.mark(page, "enter-sent");\n', "")
    .replace('  quiet.mark(page, "enter-returned");\n', "")
    .replace('  quiet.mark(page, "waiter-armed");\n', "")
    .replace("  await quiet.preserveBeforeReload(page);\n", "");
  assert.equal(generated, source);
  assert.throws(() => replaceOnce("twice twice", "twice", "replacement"));
});

test("real browser exports only allowlisted booleans after dispatch and refuses overflow", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(installBrowserObserver);
    await page.goto(
      "data:text/html," +
        encodeURIComponent(
          `<form class="habit-form"><input aria-label="Name" required value="privacy-canary"><input aria-label="Good" value="privacy-canary"><input aria-label="Better" value="privacy-canary"><input aria-label="Best" value="privacy-canary"><input aria-label="Repeat every (weeks)" value="2"><button type="submit">Save</button></form><button id="outside">Outside privacy-canary</button>`,
        ),
    );
    await page.evaluate(() => {
      document
        .querySelector("form")
        .addEventListener("submit", (event) => event.preventDefault());
      document
        .querySelector("button")
        .addEventListener("keydown", (event) => event.preventDefault(), {
          once: true,
        });
    });
    await page.locator('input[aria-label="Name"]').focus();
    await page.keyboard.type("canary-input");
    await page.locator('button[type="submit"]').focus();
    await page.keyboard.press("Enter");
    let snapshot = await page.evaluate(() => window.__quietSaveSnapshot());
    assert.equal(
      snapshot.records.find((entry) => entry.event === "enter")
        .defaultPrevented,
      true,
    );
    assert.ok(
      snapshot.records.some(
        (entry) => entry.event === "input" && entry.fields.length === 1,
      ),
    );
    assert.equal(JSON.stringify(snapshot).includes("privacy-canary"), false);
    await page.evaluate(() =>
      window.addEventListener("keydown", (event) => event.preventDefault(), {
        once: true,
      }),
    );
    await page.keyboard.press("Enter");
    snapshot = await page.evaluate(() => window.__quietSaveSnapshot());
    assert.equal(
      snapshot.records.filter((entry) => entry.event === "enter").at(-1)
        .defaultPrevented,
      true,
    );
    await page.keyboard.press("Enter");
    snapshot = await page.evaluate(() => window.__quietSaveSnapshot());
    assert.equal(
      snapshot.records.find((entry) => entry.event === "submit")
        .defaultPrevented,
      true,
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .locator("#outside")
        .evaluate((element) => element === document.activeElement),
      true,
    );
    snapshot = await page.evaluate(() => window.__quietSaveSnapshot());
    const leftForm = snapshot.records
      .filter((entry) => entry.event === "focus")
      .at(-1);
    assert.equal(leftForm.target, "other");
    assert.equal(leftForm.focus, "other");
    assert.equal(leftForm.saveFocused, false);
    assert.equal(
      leftForm.fields.some((field) => field.focused),
      false,
    );
    const enterCount = snapshot.records.filter(
      (entry) => entry.event === "enter",
    ).length;
    await page.keyboard.press("Enter");
    snapshot = await page.evaluate(() => window.__quietSaveSnapshot());
    assert.equal(
      snapshot.records.filter((entry) => entry.event === "enter").length,
      enterCount,
    );
    assert.equal(JSON.stringify(snapshot).includes("privacy-canary"), false);
    await page.evaluate(() => {
      for (let index = 0; index < 300; index++)
        document
          .querySelector("button")
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          );
    });
    snapshot = await page.evaluate(() => window.__quietSaveSnapshot());
    assert.equal(snapshot.overflow, true);
    assert.ok(snapshot.records.length <= 256);
    assert.ok(JSON.stringify(snapshot).length < 50000);
  } finally {
    await browser.close();
  }
});

test("native invalid calibration observes no submission or POST", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await begin(page, "invalid");
    await page.goto(
      "data:text/html," +
        encodeURIComponent(
          `<form class="habit-form"><input aria-label="Name" required value="privacy-canary"><input aria-label="Good"><input aria-label="Better"><input aria-label="Best"><input aria-label="Repeat every (weeks)"><button type="submit">Save</button></form>`,
        ),
    );
    mark(page, "waiter-armed");
    await page.locator("button").focus();
    mark(page, "enter-sent");
    await page.keyboard.press("Enter");
    mark(page, "enter-returned");
    let captured;
    await finish(page, {
      status: "failed",
      attach: async (_name, data) => {
        captured = JSON.parse(data.body.toString());
      },
    });
    assert.equal(classify(captured), "native-invalid");
    assert.equal(JSON.stringify(captured).includes("privacy-canary"), false);
  } finally {
    await browser.close();
  }
});

test(
  "real runner retains whole-test pre-Enter expiry and cancels without a late Enter",
  { timeout: 65000 },
  async () => {
    const directory = resolve(".audit/quiet-save-hook-tests");
    await mkdir(directory, { recursive: true });
    const helper = resolve(
      ".github/diagnostics/quiet-save-observer.mjs",
    ).replaceAll("\\", "/");
    const reporter = resolve(
      ".github/diagnostics/quiet-save-reporter.mjs",
    ).replaceAll("\\", "/");
    await writeFile(
      resolve(directory, "gate.spec.mjs"),
      `import { test } from "@playwright/test";
import * as quiet from ${JSON.stringify(helper)};
test.beforeEach(async ({ page }) => { await quiet.begin(page, "deadline"); });
test.afterEach(async ({ page }, info) => { await quiet.finish(page, info); });
test("desktop creation and saved details remain stable", async ({ page }) => {
  await page.goto("about:blank");
  const response = page.waitForResponse(response => response.url().endsWith("/api/habits"));
  quiet.mark(page, "waiter-armed");
  if (!(await quiet.deadlineGate(page))) return;
  quiet.mark(page, "enter-sent");
  await page.keyboard.press("Enter");
  await response;
});
`,
    );
    await writeFile(
      resolve(directory, "config.mjs"),
      `export default { testDir: ".", testMatch: "gate.spec.mjs", timeout: 30000, retries: 0, workers: 1, reporter: [[${JSON.stringify(reporter)}]], projects: [{ name: "chromium-desktop", use: { browserName: "chromium", trace: "off", screenshot: "off", video: "off" } }] };`,
    );
    const evidence = resolve(
      ".audit/quiet-save-self-test-evidence/deadline-0.jsonl",
    );
    await mkdir(resolve(".audit/quiet-save-self-test-evidence"), {
      recursive: true,
    });
    await writeFile(evidence, "");
    const retained = mediaDirectory(
      {
        control: "deadline",
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
        ".audit/quiet-save-self-test-evidence/media-deadline-0-0-chromium-desktop-1",
      ),
    );
    await rm(retained, { recursive: true, force: true });
    const result = await new Promise((resolveResult, reject) => {
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
            QUIET_CONTROL: "deadline",
            QUIET_SELF_TEST: "1",
            QUIET_ITERATION: "0",
            QUIET_PHASE: "calibration",
          },
        },
      );
      child.stdout.resume();
      child.stderr.resume();
      child.on("error", reject);
      child.on("exit", resolveResult);
    });
    assert.equal(result, 1);
    const lines = (await readFile(evidence, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const actual = lines.find((line) => line.kind === "test-result");
    assert.equal(actual.status, "timedOut");
    assert.equal(actual.classification, "deadline-before-enter");
    assert.ok(
      actual.observation.node.some((event) => event.event === "gate-cancelled"),
    );
    assert.equal(
      actual.observation.node.some((event) => event.event === "enter-sent"),
      false,
    );
    assert.equal(
      lines.some(
        (line) =>
          line.kind === "runner-error" &&
          line.category !== "pending-waiter-global-timeout",
      ),
      false,
    );
    assert.equal(
      calibrationMatched(
        parseReceipt(await readFile(evidence, "utf8"), "deadline", 0),
        "deadline",
        result,
      ),
      true,
    );
  },
);
