import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadPassiveSources,
  admitPassiveOperation,
  passiveRuntimeProof,
} from "./quiet-save-source.mjs";
import { parseReceipt } from "./quiet-save-receipt.mjs";
import { passiveFailure } from "./quiet-save-schema.mjs";
import { mediaDirectory } from "./quiet-save-media.mjs";
import QuietSaveReporter from "./quiet-save-reporter.mjs";
import { chromium, firefox, webkit } from "@playwright/test";

const engine = process.env.QUIET_PASSIVE_ENGINE ?? "chromium";
assert(["chromium", "firefox", "webkit"].includes(engine));
const root = resolve(
  process.env.QUIET_PASSIVE_PREFLIGHT === "1"
    ? `.audit/quiet-save/passive-calibration/${engine}`
    : ".audit/passive-save",
);
const receiptPath = resolve(
  ".audit/quiet-save-self-test-evidence/presave-assertion-0.jsonl",
);
const moduleUrl = (path) => pathToFileURL(resolve(path)).href;
async function resetCapture(project, caseId) {
  const path = mediaDirectory(
    {
      control: "presave-assertion",
      iteration: 0,
      phase: "calibration",
      project,
      case: caseId,
    },
    true,
  );
  assert(
    path.startsWith(resolve(".audit/quiet-save-self-test-evidence") + "/") ||
      path.startsWith(resolve(".audit/quiet-save-self-test-evidence") + "\\"),
  );
  await rm(path, { recursive: true, force: true });
  await rm(receiptPath, { force: true });
}

test("passive source admission requires an exact static site and its operation", () => {
  const sources = loadPassiveSources(true);
  const canonical = sources.find(
    (source) => source.source === "canonical-test",
  );
  const waiter = canonical.sites.find(
    (site) => site.role === "save-response-waiter",
  );
  assert.deepEqual([waiter.line, waiter.column], [133, 24]);
  const enter = canonical.sites.find((site) => site.role === "save-enter");
  const step = {
    category: "pw:api",
    title: 'Press "Enter"',
    location: { file: canonical.path, line: enter.line, column: enter.column },
  };
  assert.equal(admitPassiveOperation(step, sources).kind, "complete");
  assert.deepEqual(
    admitPassiveOperation({ ...step, title: "Evaluate" }, sources),
    { kind: "unverified", reason: "operation-mismatch" },
  );
  assert.deepEqual(
    admitPassiveOperation(
      { ...step, location: { ...step.location, column: enter.column + 1 } },
      sources,
    ),
    { kind: "unverified", reason: "site-unadmitted" },
  );
  assert.equal(
    admitPassiveOperation(
      {
        ...step,
        location: {
          ...step.location,
          file: resolve("unowned/compatibility.pw.ts"),
        },
      },
      sources,
    ).kind,
    "unverified",
  );
  assert.equal(
    admitPassiveOperation({ ...step, location: undefined }, sources).kind,
    "unverified",
  );
  assert.equal(
    admitPassiveOperation(
      { ...step, location: undefined, parent: { category: "fixture" } },
      sources,
    ).kind,
    "excluded",
  );
  assert.equal(
    admitPassiveOperation({ ...step, parent: { category: "hook" } }, sources)
      .kind,
    "excluded",
  );
  assert.equal(passiveRuntimeProof().version, "1.64.1");
  for (const role of ["save-enter", "dialog-enter", "save-response-waiter"])
    assert.equal(
      canonical.sites.filter((site) => site.role === role).length,
      1,
    );
  for (const [api, title] of [
    ["target.screenshot", "Screenshot"],
    ["style.evaluate", "Evaluate"],
  ]) {
    const entries = sources.flatMap((source) =>
      source.sites
        .filter((site) => site.api === api)
        .map((site) => ({ source, site })),
    );
    assert(entries.length > 0);
    for (const { source, site } of entries) {
      assert.equal(site.operation, "other-admitted-source-call");
      const admitted = admitPassiveOperation(
        {
          category: "pw:api",
          title,
          location: { file: source.path, line: site.line, column: site.column },
        },
        sources,
      );
      assert.equal(admitted.kind, "complete");
      assert.equal(
        admitPassiveOperation(
          {
            category: "pw:api",
            title: "Navigate",
            location: {
              file: source.path,
              line: site.line,
              column: site.column,
            },
          },
          sources,
        ).kind,
        "unverified",
      );
    }
  }
});

test("reporter refuses lost step identity, malformed transport and serialized ledger overflow", () => {
  const keys = {
    QUIET_SELF_TEST: "1",
    QUIET_PROFILE: "passive",
    QUIET_CONTROL: "presave-assertion",
    QUIET_ITERATION: "0",
    QUIET_PHASE: "calibration",
  };
  const previous = Object.fromEntries(
    Object.keys(keys).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, keys);
  try {
    const testCase = {
      id: "bounded",
      title: "desktop creation and saved details remain stable",
      timeout: 30000,
      parent: { project: () => ({ name: "chromium-desktop" }) },
    };
    const result = {
      startTime: new Date(1000),
      duration: 1000,
      workerIndex: 0,
      errors: [],
      attachments: [],
    };
    const reporter = new QuietSaveReporter();
    const canonical = reporter.sources.find(
      (source) => source.source === "canonical-test",
    );
    const enter = canonical.sites.find((site) => site.role === "save-enter");
    const step = () => ({
      category: "pw:api",
      title: 'Press "Enter"',
      startTime: new Date(1001),
      duration: 1,
      location: {
        file: canonical.path,
        line: enter.line,
        column: enter.column,
      },
    });
    reporter.onTestBegin(testCase);
    const first = step();
    reporter.onStepBegin(testCase, result, first);
    reporter.onStepEnd(testCase, result, first);
    const missing = reporter.passiveDetail(testCase, result);
    assert.equal(missing.operations.kind, "complete");
    assert.deepEqual(missing.network, {
      kind: "unverified",
      reason: "missing",
    });
    const malformed = reporter.passiveDetail(testCase, {
      ...result,
      attachments: [
        {
          name: "quiet-save-passive",
          body: Buffer.from('{"unexpected":true}'),
        },
      ],
    });
    assert.equal(malformed.operations.kind, "complete");
    assert.deepEqual(malformed.network, {
      kind: "unverified",
      reason: "malformed",
    });
    for (const installationWall of [990, 301001]) {
      const outside = reporter.passiveDetail(testCase, {
        ...result,
        attachments: [
          {
            name: "quiet-save-passive",
            body: Buffer.from(
              JSON.stringify({
                schema: 1,
                owner: missing.owner,
                workerIndex: 0,
                journal: {
                  kind: "complete",
                  value: {
                    installationWall,
                    end: { at: 60, wall: installationWall + 60 },
                    events: [
                      {
                        sequence: 1,
                        requestOrdinal: 1,
                        at: 30,
                        wall: installationWall + 30,
                        event: { kind: "request" },
                      },
                    ],
                  },
                },
              }),
            ),
          },
        ],
      });
      assert.equal(outside.budget.wallOffsets, "unavailable");
      assert.equal(outside.operations.value[0].start.kind, "unverified");
      assert.equal(outside.operations.value[0].end.at.kind, "unverified");
      assert.equal(outside.network.value.events.length, 1);
      assert.equal(outside.network.value.events[0].wall.kind, "unverified");
    }
    reporter.onStepBegin(testCase, result, first);
    assert.deepEqual(reporter.passiveDetail(testCase, result).operations, {
      kind: "unverified",
      reason: "duplicate",
    });
    reporter.onTestBegin(testCase);
    reporter.onStepEnd(testCase, result, step());
    assert.deepEqual(reporter.passiveDetail(testCase, result).operations, {
      kind: "unverified",
      reason: "lifecycle-incomplete",
    });
    reporter.onTestBegin(testCase);
    reporter.onStepBegin(testCase, result, { ...step(), location: undefined });
    assert.deepEqual(reporter.passiveDetail(testCase, result).operations, {
      kind: "unverified",
      reason: "site-unadmitted",
    });
    reporter.onTestBegin(testCase);
    const reversed = { ...step(), duration: -1 };
    reporter.onStepBegin(testCase, result, reversed);
    reporter.onStepEnd(testCase, result, reversed);
    const clock = reporter.passiveDetail(testCase, result);
    assert.equal(clock.budget.wallOffsets, "unavailable");
    assert.equal(clock.operations.value[0].start.kind, "unverified");
    reporter.onTestBegin(testCase);
    reporter.onStepBegin(testCase, result, {
      ...step(),
      startTime: new Date(1002),
    });
    reporter.onStepBegin(testCase, result, step());
    const backward = reporter.passiveDetail(testCase, result);
    assert.equal(backward.budget.wallOffsets, "unavailable");
    assert(
      backward.operations.value.every((row) => row.start.kind === "unverified"),
    );
    reporter.onTestBegin(testCase);
    for (let index = 0; index < 512; index++) {
      const current = step();
      reporter.onStepBegin(testCase, result, current);
      reporter.onStepEnd(testCase, result, current);
    }
    const bounded = reporter.passiveDetail(testCase, result);
    assert.deepEqual(bounded.operations, {
      kind: "unverified",
      reason: "overflow",
    });
    assert(Buffer.byteLength(JSON.stringify(bounded)) < 66560);
    reporter.onStepBegin(testCase, result, step());
    assert.deepEqual(reporter.passiveDetail(testCase, result).operations, {
      kind: "unverified",
      reason: "overflow",
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test(
  "real imported Chromium controls distinguish passive operation and network boundaries",
  { timeout: 120000 },
  async () => {
    await mkdir(root, { recursive: true });
    await mkdir(resolve(receiptPath, ".."), { recursive: true });
    const wrapper = `import ${JSON.stringify(moduleUrl(".github/diagnostics/fixtures/passive-save.pw.mjs"))};
import {test} from "@playwright/test";
import assert from "node:assert/strict";
import {installPassiveSaveHooks} from ${JSON.stringify(moduleUrl(".github/diagnostics/quiet-save-passive.mjs"))};
const methods = new WeakMap();
const early = new WeakMap();
test.beforeEach(async ({page}) => {
  if (process.env.QUIET_PASSIVE_CASE !== "unmatched") return;
  await page.goto("/");
  const response = page.waitForResponse(item => item.request().method() === "POST");
  await page.evaluate(async () => {await fetch("/api/habits",{method:"POST"});});
  early.set(page,await response);
});
function block(page) {
  const entries = [[page,"evaluate"],[page,"addInitScript"],[page,"route"],[page,"locator"],[page.keyboard,"press"],[page.keyboard,"type"]];
  methods.set(page, entries.map(([object,key]) => [object,key,object[key]]));
  for (const [object,key] of entries) object[key] = () => {throw new Error("Passive hook called a forbidden browser API.");};
}
function restore(page) {for (const [object,key,value] of methods.get(page)) object[key] = value;}
test.beforeEach(({page}) => block(page));
test.afterEach(({page},info) => {
  block(page);
  const attach = info.attach.bind(info);
  info.attach = async (name,options) => {
    if (name !== "quiet-save-passive") return attach(name,options);
    const mode = process.env.QUIET_PASSIVE_CASE;
    if (mode === "missing") return;
    if (mode === "clock" || mode === "owner") {
      const value = JSON.parse(options.body.toString());
      if (mode === "clock") value.journal.value.events[0].wall += 100;
      else value.owner.case = 2;
      options = {...options,body:Buffer.from(JSON.stringify(value))};
    }
    await attach(name,options);
    if (mode === "duplicate") await attach(name,options);
  };
});
installPassiveSaveHooks();
if (process.env.QUIET_PASSIVE_CASE === "duplicate-install")
  assert.throws(() => installPassiveSaveHooks(), {message:"Passive save hooks already installed."});
test.beforeEach(({page}) => {
  restore(page);
  if (early.has(page)) page.emit("response",early.get(page));
});
test.afterEach(async ({page},info) => {
  restore(page);
  const mode = process.env.QUIET_PASSIVE_CASE;
  if (mode === "late") await page.evaluate(async () => { await fetch("/api/habits",{method:"POST"}); });
});
`;
    await writeFile(resolve(root, "control.pw.mjs"), wrapper);
    let mode = "fresh";
    let requests = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        requests++;
        if (["held", "worker-exit"].includes(mode)) return;
        const finish = () => {
          response.writeHead(201, { "content-type": "application/json" });
          response.end("{}");
        };
        if (["fresh", "consumed"].includes(mode)) setTimeout(finish, 1000);
        else finish();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      if (request.url === "/frame") {
        response.end(
          '<script>fetch("/api/habits",{method:"POST"}).then(()=>parent.postMessage("done","*"));</script>',
        );
        return;
      }
      response.end(
        '<button autofocus>Save</button><script>document.querySelector("button").onclick=()=>fetch("/api/habits",{method:"POST"});</script>',
      );
    });
    await new Promise((resolveReady) =>
      server.listen(0, "127.0.0.1", resolveReady),
    );
    const port = server.address().port;
    await writeFile(
      resolve(root, "control.config.mjs"),
      `export default ${JSON.stringify({
        testDir: root,
        testMatch: "control.pw.mjs",
        timeout: 2500,
        workers: 1,
        retries: 0,
        outputDir: resolve(root, "results"),
        reporter: [[resolve(".github/diagnostics/quiet-save-reporter.mjs")]],
        projects: [
          {
            name: "chromium-desktop",
            use: {
              browserName: engine,
              baseURL: `http://127.0.0.1:${port}`,
            },
          },
        ],
      })};\n`,
    );
    const results = {};
    try {
      for (mode of [
        "fresh",
        "pre-enter",
        "held",
        "consumed",
        "foreign",
        "two-posts",
        "subframe",
        "missing",
        "duplicate",
        "clock",
        "owner",
        "late",
        "worker-exit",
        "unmatched",
        "overflow",
        "duplicate-install",
      ]) {
        requests = 0;
        await resetCapture("chromium-desktop", 1);
        const exit = await new Promise((resolveExit, reject) => {
          const child = spawn(
            process.execPath,
            [
              "node_modules/@playwright/test/cli.js",
              "test",
              "--config",
              resolve(root, "control.config.mjs"),
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
                COMPAT_CURRENT_SHA: "",
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let diagnostic = "";
          child.stdout.on("data", (chunk) => {
            diagnostic += chunk;
          });
          child.stderr.on("data", (chunk) => {
            diagnostic += chunk;
          });
          child.once("error", reject);
          child.once("exit", (code) => resolveExit({ code, diagnostic }));
        });
        assert.equal(
          exit.code,
          1,
          "Each control must reach its intended test failure.",
        );
        const text = await readFile(receiptPath, "utf8").catch(() => {
          assert.fail(
            `Reporter produced no receipt; stderr bytes ${Buffer.byteLength(exit.diagnostic)}.`,
          );
        });
        await writeFile(resolve(root, `${mode}.jsonl`), text);
        const rows = parseReceipt(text, "presave-assertion", 0);
        const result = rows.find((row) => row.kind === "test-result");
        assert(result, "The real reporter must record the executed test.");
        const detail = passiveFailure.parse(result.passive);
        assert.equal(
          detail.operations.kind,
          "complete",
          `${mode}: original operation admission`,
        );
        const refused = [
          "missing",
          "duplicate",
          "owner",
          "worker-exit",
          "unmatched",
          "overflow",
        ].includes(mode);
        assert.equal(
          detail.network.kind,
          refused ? "unverified" : "complete",
          `${mode}: owned network attachment`,
        );
        assert.equal(detail.errors.kind, "complete");
        assert.equal(detail.budget.exactRemainingMs, "not-observed");
        results[mode] = { result, detail, requests };
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolveClosed) => server.close(resolveClosed));
    }
    const events = (mode) =>
      results[mode].detail.network.value.events.map(
        (event) => event.event.kind,
      );
    assert.deepEqual(events("fresh"), ["request", "response"]);
    assert.deepEqual(events("pre-enter"), []);
    assert.deepEqual(events("held"), ["request"]);
    assert.deepEqual(events("consumed"), ["request"]);
    assert.equal(results.fresh.result.status, "failed");
    for (const mode of ["pre-enter", "held", "consumed"])
      assert.equal(results[mode].result.status, "timedOut");
    const operations = (mode) => results[mode].detail.operations.value;
    assert(
      operations("pre-enter").some(
        (row) => row.site.role === "save-response-waiter",
      ),
    );
    assert(
      !operations("pre-enter").some((row) => row.site.role === "save-enter"),
    );
    for (const mode of ["held", "consumed"]) {
      assert(
        operations(mode).some(
          (row) => row.site.role === "save-enter" && row.end.kind === "success",
        ),
      );
      const lastInput = operations(mode)
        .filter((row) => row.site.operation.startsWith("keyboard."))
        .at(-1);
      assert.equal(lastInput.site.role, "save-enter");
      assert(
        results[mode].detail.errors.value.some(
          (error) =>
            error.errorIndex > 0 && error.correlation.kind === "unique-step",
        ),
      );
    }
    assert.equal(results.foreign.requests, 2);
    assert.deepEqual(events("foreign"), ["request", "response"]);
    assert.equal(results["duplicate-install"].requests, 1);
    assert.deepEqual(events("duplicate-install"), ["request", "response"]);
    assert.deepEqual(events("two-posts"), [
      "request",
      "response",
      "request",
      "response",
    ]);
    assert.deepEqual(
      results["two-posts"].detail.network.value.events.map(
        (event) => event.requestOrdinal,
      ),
      [1, 1, 2, 2],
    );
    assert.equal(results.subframe.requests, 2);
    assert.deepEqual(events("subframe"), ["request", "response"]);
    for (const [mode, reason] of [
      ["missing", "missing"],
      ["duplicate", "duplicate"],
      ["owner", "owner-mismatch"],
      ["worker-exit", "missing"],
      ["unmatched", "lifecycle-incomplete"],
      ["overflow", "overflow"],
    ])
      assert.equal(results[mode].detail.network.reason, reason);
    assert(
      results["worker-exit"].detail.operations.value.some(
        (row) => row.end.kind === "not-observed",
      ),
    );
    assert.equal(results.late.requests, 2);
    assert.deepEqual(events("late"), ["request", "response"]);
    assert(
      results.clock.detail.network.value.events.every(
        (event) => event.wall.kind === "unverified",
      ),
    );
    assert.equal(results.clock.detail.budget.wallOffsets, "unavailable");
    assert(
      results.clock.detail.operations.value.every(
        (row) =>
          row.start.kind === "unverified" &&
          (row.end.kind === "not-observed" || row.end.at.kind === "unverified"),
      ),
    );
  },
);

test(
  "actual canonical import preserves original operation sequence on the controlled Chromium page",
  { timeout: 90000 },
  async () => {
    await mkdir(root, { recursive: true });
    const pageHtml = await readFile(
      ".github/diagnostics/fixtures/passive-save-page.html",
    );
    let habits = [];
    const server = createServer(async (request, response) => {
      if (request.url === "/api/habits") {
        response.setHeader("content-type", "application/json");
        if (request.method === "POST") {
          let body = "";
          for await (const chunk of request) body += chunk;
          const input = JSON.parse(body);
          const habit = {
            id: "63acac30-1c1e-4a6b-9eae-f2a5595c2515",
            name: input.name,
            good: input.good,
            better: input.better,
            best: input.best,
            createdAt: "2026-01-05T00:30:00.000Z",
            schedule: {
              weekdays: input.weekdays,
              repeatEveryWeeks: input.repeatEveryWeeks,
              timeZone: input.timeZone,
              creationDate: "2026-01-04",
              firstWeekMonday: "2025-12-29",
            },
          };
          habits = [habit];
          response.statusCode = 201;
          response.end(JSON.stringify(habit));
        } else response.end(JSON.stringify(habits));
      } else {
        response.setHeader("content-type", "text/html");
        response.end(pageHtml);
      }
    });
    await new Promise((resolveReady) =>
      server.listen(0, "127.0.0.1", resolveReady),
    );
    const port = server.address().port;
    const captures = [];
    try {
      for (const passive of [false, true]) {
        habits = [];
        const wrapper =
          `import ${JSON.stringify(moduleUrl("tests/Browser/compatibility.pw.ts"))};\nimport {test,expect} from "@playwright/test";\ntest.afterEach(({}, info) => {if (info.status !== "skipped") for(let index=0;index<8;index++) expect.soft(index).toBe(-1);});\n` +
          (passive
            ? `import {installPassiveSaveHooks} from ${JSON.stringify(moduleUrl(".github/diagnostics/quiet-save-passive.mjs"))};\ninstallPassiveSaveHooks();\n`
            : "");
        await writeFile(resolve(root, "canonical.pw.mjs"), wrapper);
        await writeFile(
          resolve(root, "canonical.config.mjs"),
          `export default ${JSON.stringify({
            testDir: root,
            testMatch: "canonical.pw.mjs",
            timeout: 30000,
            workers: 1,
            retries: 0,
            outputDir: resolve(root, "canonical-results"),
            reporter: [
              [resolve(".github/diagnostics/quiet-save-reporter.mjs")],
            ],
            projects: [
              {
                name: "firefox-smoke",
                use: {
                  browserName: engine,
                  baseURL: `http://127.0.0.1:${port}`,
                },
              },
            ],
          })};\n`,
        );
        await resetCapture("firefox-smoke", 0);
        const exitCode = await new Promise((resolveExit, reject) => {
          const child = spawn(
            process.execPath,
            [
              "node_modules/@playwright/test/cli.js",
              "test",
              "--config",
              resolve(root, "canonical.config.mjs"),
            ],
            {
              env: {
                ...process.env,
                QUIET_SELF_TEST: "1",
                QUIET_PROFILE: "passive",
                QUIET_CONTROL: "presave-assertion",
                QUIET_ITERATION: "0",
                QUIET_PHASE: "calibration",
                COMPAT_CURRENT_SHA: "",
              },
              stdio: "ignore",
            },
          );
          child.once("error", reject);
          child.once("exit", resolveExit);
        });
        assert.equal(exitCode, 1);
        const text = await readFile(receiptPath, "utf8");
        await writeFile(
          resolve(root, `canonical-${passive ? "passive" : "direct"}.jsonl`),
          text,
        );
        const rows = parseReceipt(text, "presave-assertion", 0);
        const results = rows.filter((row) => row.kind === "test-result");
        assert.equal(
          results.length,
          3,
          "The import selects each canonical case exactly once.",
        );
        assert.deepEqual(
          results.map((row) => row.status),
          ["failed", "skipped", "skipped"],
        );
        const detail = results[0].passive;
        assert.equal(detail.operations.kind, "complete");
        const operations = detail.operations.value;
        assert(
          operations.length > 70,
          "The canonical keyboard, response-body and reload sequence must execute.",
        );
        assert(
          operations.every((row) => row.end.kind === "success"),
          "Only the external afterEach assertion may fail.",
        );
        assert(operations.some((row) => row.site.role === "save-enter"));
        assert(operations.some((row) => row.site.operation === "page.reload"));
        assert.deepEqual(
          detail.errors.value.map((error) => error.errorIndex),
          [0, 1, 2, 3, 4, 5, 6, 7],
        );
        assert(
          Buffer.byteLength(JSON.stringify(results[0])) < 66560,
          "The actual canonical smoke ledger plus all eight errors must fit the row cap.",
        );
        assert.equal(detail.network.kind, passive ? "complete" : "unverified");
        captures.push(operations.map((row) => row.site));
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolveClosed) => server.close(resolveClosed));
    }
    assert.deepEqual(captures[1], captures[0]);
  },
);

test("record actual calibration engine identity", async () => {
  const browser = await { chromium, firefox, webkit }[engine].launch();
  try {
    await writeFile(
      resolve(root, "engine.json"),
      JSON.stringify({
        schema: 1,
        engine,
        browserVersion: browser.version(),
        playwright: passiveRuntimeProof().version,
        node: process.version,
        platform: process.platform,
      }) + "\n",
    );
  } finally {
    await browser.close();
  }
});
