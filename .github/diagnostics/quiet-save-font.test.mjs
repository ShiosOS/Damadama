import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  copyFile,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  classify,
  fontEvidence,
  fontKinds,
  fontSnapshot,
} from "./quiet-save-schema.mjs";
import {
  digest,
  fontBuildProof,
  readFontAssets,
} from "./quiet-save-source.mjs";
import { readInstalledNunitoFile, readOwnedFile } from "./quiet-save-files.mjs";
import { parseReceipt } from "./quiet-save-receipt.mjs";

const root = resolve(".audit/quiet-save-font-tests");
const assets = resolve(root, "assets");
const name = (kind) => `nunito-${kind}-wght-normal-00000000.woff2`;
const fontPath = (kind) => `/assets/${name(kind)}`;

async function prepareAssets() {
  await mkdir(assets, { recursive: true });
  for (const kind of fontKinds)
    await writeFile(
      resolve(assets, name(kind)),
      await readInstalledNunitoFile(kind),
    );
}

test("font evidence refuses inconsistent sequence, counts, bounds and arbitrary fields", () => {
  const snapshot = {
    origin: "browser-performance",
    ms: 1,
    sampledAt: "failure-drain",
    setStatus: "loaded",
    family: {
      state: "present",
      counts: { unloaded: 4, loading: 0, loaded: 1, error: 0 },
    },
  };
  const event = {
    origin: "node-performance",
    ms: 1,
    request: 1,
    document: 1,
    kind: "latin",
    event: "font-request",
  };
  const good = {
    scope: "verified-bundled-nunito-main-frame",
    transport: {
      events: [
        event,
        { ...event, ms: 2, event: "font-response", status: 200 },
        { ...event, ms: 3, event: "font-request-finished" },
      ],
      stop: { origin: "node-performance", ms: 4, reason: "case-finished" },
      refusal: "none",
    },
    sample: { state: "available", document: 1, snapshot },
  };
  assert.equal(fontEvidence.safeParse(good).success, true);
  const change = (mutate) => {
    const copy = structuredClone(good);
    mutate(copy);
    return copy;
  };
  for (const bad of [
    change((v) => {
      v.token = "privacy-canary";
    }),
    change((v) => {
      v.transport.events[0].url = "privacy-canary";
    }),
    change((v) => {
      v.transport.events[1].status = 600;
    }),
    change((v) => {
      v.transport.events[1].request = 2;
    }),
    change((v) => {
      v.transport.events[1].kind = "latin-ext";
    }),
    change((v) => {
      v.transport.events[1].document = 2;
    }),
    change((v) => {
      v.transport.events[1].ms = 0;
    }),
    change((v) => {
      v.transport.stop.ms = 2;
    }),
    change((v) => {
      v.transport.events[0].request = 9;
    }),
    change((v) => {
      v.transport.events[0].document = 5;
    }),
    change((v) => {
      v.transport.events.splice(1, 1);
    }),
    change((v) => {
      v.transport.events.push(v.transport.events[2]);
    }),
    change((v) => {
      v.transport.events.splice(2, 0, v.transport.events[1]);
    }),
    change((v) => {
      v.transport.events = Array(33).fill(event);
    }),
    change((v) => {
      v.sample.document = 0;
    }),
    change((v) => {
      v.sample.snapshot.family.counts.loaded = 33;
    }),
    change((v) => {
      v.sample.snapshot.family.counts.unloaded = 0;
      v.sample.snapshot.family.counts.loaded = 0;
    }),
    change((v) => {
      v.sample.snapshot.family.counts.error = 29;
    }),
    change((v) => {
      v.sample.snapshot.family.counts.other = 1;
    }),
  ])
    assert.equal(fontEvidence.safeParse(bad).success, false);
  assert.equal(
    fontSnapshot.safeParse({ ...snapshot, family: { state: "missing" } })
      .success,
    true,
  );
  const partial = change((v) => {
    v.transport.events.pop();
  });
  assert.equal(fontEvidence.safeParse(partial).success, true);
  const failed = change((v) => {
    v.transport.events = [
      event,
      { ...event, ms: 2, event: "font-request-failed", category: "aborted" },
    ];
  });
  assert.equal(fontEvidence.safeParse(failed).success, true);
  const oversized = change((value) => {
    value.transport.stop.ms = Number.MAX_VALUE;
    value.sample.snapshot.ms = Number.MAX_VALUE;
    value.transport.events = Array.from({ length: 8 }, (_, index) => [
      {
        ...event,
        request: index + 1,
        ms: 1.1234567890123456e100 + index,
        event: "font-request",
      },
      {
        ...event,
        request: index + 1,
        ms: 1.1234567890123456e100 + index,
        event: "font-response",
        status: 200,
      },
      {
        ...event,
        request: index + 1,
        ms: 1.1234567890123456e100 + index,
        event: "font-request-failed",
        category: "connection-refused",
      },
    ]).flat();
    for (const event of value.transport.events) event.kind = "cyrillic-ext";
    value.transport.events.push(...value.transport.events.slice(0, 8));
  });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 4096);
  const oversizedResult = fontEvidence.safeParse(oversized);
  assert.equal(oversizedResult.success, false);
  assert.ok(
    oversizedResult.error.issues.some(
      (issue) => issue.message === "Font evidence byte bound exceeded.",
    ),
  );
  const refusal = change((v) => {
    v.transport.refusal = "overflow";
    v.sample = { state: "face-bound-exceeded" };
  });
  assert.equal(
    classify({
      schema: 2,
      font: refusal,
      refusal: "none",
      browser: [],
      node: [
        "test-start",
        "waiter-armed",
        "enter-sent",
        "enter-returned",
        "response",
      ].map((event) => ({
        origin: "node-performance",
        ms: 1,
        event,
        ...(event === "response" ? { status: 201 } : {}),
      })),
    }),
    "response-observed",
  );
});

test("font inventory binds exact emitted bytes and keeps installed hardlinks separate", async () => {
  await prepareAssets();
  const inventory = await readFontAssets(true);
  assert.equal(fontBuildProof.safeParse(inventory.proof).success, true);
  assert.equal(inventory.proof.assets.length, 5);
  const port = process.env.DAMADAMA_BROWSER_PORT ?? "5174";
  const url = `http://127.0.0.1:${port}${fontPath("latin")}`;
  assert.equal(inventory.kindForUrl(url), "latin");
  for (const other of [
    url + "?privacy-canary",
    url + "#privacy-canary",
    url.replace("127.0.0.1", "localhost"),
    url.replace("00000000", "11111111"),
    url.replace("/assets/", "/other/"),
  ])
    assert.equal(inventory.kindForUrl(other), null);
  assert.equal(
    fontBuildProof.safeParse({
      ...inventory.proof,
      assets: [...inventory.proof.assets].reverse(),
    }).success,
    false,
  );
  assert.equal(
    fontBuildProof.safeParse({ ...inventory.proof, url }).success,
    false,
  );
  await assert.rejects(readInstalledNunitoFile("privacy-canary"));
  const file = resolve(assets, name("latin"));
  const bytes = await readFile(file);
  const other = resolve(assets, "nunito-latin-wght-normal-11111111.woff2");
  const parked = resolve(root, "parked.woff2");
  try {
    await writeFile(file, Buffer.from("changed bytes"));
    await assert.rejects(readFontAssets(true));
    await writeFile(file, bytes);
    await copyFile(file, other);
    await assert.rejects(readFontAssets(true));
    await rm(other);
    await rename(file, parked);
    await assert.rejects(readFontAssets(true));
    await rename(parked, file);
    const linked = resolve(root, "linked-assets");
    await rm(linked, { recursive: true, force: true });
    await symlink(assets, linked, "junction");
    await assert.rejects(readOwnedFile(resolve(linked, name("latin"))));
    await rm(linked);
  } finally {
    await rm(other, { force: true });
    await rm(parked, { force: true });
    await writeFile(file, bytes);
  }
  const config = await readFile("tests/Browser/playwright.config.ts", "utf8");
  assert.ok(
    config.includes(
      '`http://127.0.0.1:${process.env["DAMADAMA_BROWSER_PORT"] ?? "5174"}`',
    ),
  );
  const working = process.cwd();
  const isolated = resolve(root, "isolated-inventory");
  const packageRoot = resolve(
    isolated,
    "node_modules/@fontsource-variable/nunito/files",
  );
  const buildRoot = resolve(isolated, ".audit/browser-build/assets");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(buildRoot, { recursive: true });
  for (const kind of fontKinds) {
    const bytes = await readInstalledNunitoFile(kind);
    await writeFile(
      resolve(packageRoot, `nunito-${kind}-wght-normal.woff2`),
      bytes,
    );
    await writeFile(resolve(buildRoot, name(kind)), bytes);
  }
  const installed = resolve(packageRoot, "nunito-latin-wght-normal.woff2");
  const linked = resolve(isolated, "package-hardlink.woff2");
  await rm(linked, { force: true });
  await link(installed, linked);
  try {
    process.chdir(isolated);
    assert.deepEqual((await readFontAssets()).proof, inventory.proof);
    await assert.rejects(readOwnedFile(installed));
    assert.equal((await readInstalledNunitoFile("latin")).length, bytes.length);
    await writeFile(installed, "changed-installed-bytes");
    await assert.rejects(readFontAssets());
  } finally {
    process.chdir(working);
    await writeFile(installed, bytes);
    await rm(linked);
  }
});

test(
  "real browser font states and transport remain distinct through the actual reporter",
  { timeout: 120000 },
  async () => {
    await prepareAssets();
    let mode = "healthy";
    let partialSent = false;
    const held = new Set();
    const bytes = new Map(
      await Promise.all(
        fontKinds.map(async (kind) => [
          fontPath(kind),
          await readFile(resolve(assets, name(kind))),
        ]),
      ),
    );
    const css = (
      await readFile(
        "node_modules/@fontsource-variable/nunito/index.css",
        "utf8",
      )
    ).replace(/\.\/files\/nunito-([a-z-]+)-wght-normal\.woff2/g, (_all, kind) =>
      fontPath(kind),
    );
    const remote = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "font/woff2",
        "access-control-allow-origin": "*",
      });
      response.end(bytes.get(fontPath("latin")));
    });
    await new Promise((ready) => remote.listen(0, "127.0.0.1", ready));
    const server = createServer((request, response) => {
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      if (path === "/held-ready") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(partialSent));
        return;
      }
      if (bytes.has(path)) {
        if (mode === "redirect") {
          response.writeHead(302, {
            location: `http://127.0.0.1:${remote.address().port}${path}?privacy-canary-destination`,
          });
          response.end();
          return;
        }
        const body = bytes.get(path);
        response.writeHead(200, {
          "content-type": "font/woff2",
          "x-content-type-options": "nosniff",
          "x-canary": "privacy-canary-header",
          "content-length": mode === "corrupt" ? 24 : body.length,
        });
        if (mode === "hold") {
          response.flushHeaders();
          response.write(body.subarray(0, 20000), () => {
            partialSent = true;
          });
          held.add(response);
          response.once("close", () => held.delete(response));
          return;
        }
        response.end(mode === "corrupt" ? Buffer.alloc(24, 7) : body);
        return;
      }
      let content = `<style>${css}body{font-family:'Nunito Variable'}</style><p>Fixed Latin text</p><input aria-label="Name" value="privacy-canary-input">`;
      if (mode === "missing") content = "<p>Fixed plain text</p>";
      if (mode === "unused") content = `<style>${css}</style>`;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(content);
    });
    await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const fixtureRoot = resolve(".audit/quiet-save-evidence-tests");
    const fixturePath = resolve(fixtureRoot, "probe.spec.mjs");
    const proofPath = resolve(fixtureRoot, "source.json");
    await mkdir(fixtureRoot, { recursive: true });
    const oldFixture = await readFile(fixturePath).catch(() => null);
    const oldProof = await readFile(proofPath).catch(() => null);
    const helper = resolve(
      ".github/diagnostics/quiet-save-observer.mjs",
    ).replaceAll("\\", "/");
    const support = resolve("tests/Browser/visual-support.ts").replaceAll(
      "\\",
      "/",
    );
    const reporter = resolve(
      ".github/diagnostics/quiet-save-reporter.mjs",
    ).replaceAll("\\", "/");
    const fixture = `import assert from 'node:assert/strict';
import { test, expect } from '@playwright/test';
import * as quiet from ${JSON.stringify(helper)};
import { captureOrCompare, checkpoints, clockInstant } from ${JSON.stringify(support)};
test.beforeEach(async ({page}) => { await quiet.begin(page); });
test.afterEach(async ({page}, info) => { await quiet.finish(page, { status: info.status, attach: (name, data) => info.attach(name, data) }); });
test('desktop creation and saved details remain stable', async ({page, browser}, info) => {
  const mode = process.env.QUIET_FONT_CASE;
  if (mode === 'skip') test.skip();
  await page.clock.setFixedTime(new Date(clockInstant));
  if (mode === 'abort') await page.route('**/assets/*.woff2', route => route.abort('aborted'));
  await page.goto(${JSON.stringify(origin)}, {waitUntil:'domcontentloaded'});
  if (mode === 'hold') { await expect.poll(async () => (await page.request.get(${JSON.stringify(origin + "/held-ready")})).json()).toBe(true); await page.waitForFunction(() => document.fonts.status === 'loading'); }
  else await page.evaluate(() => document.fonts.ready);
  if (['abort','corrupt'].includes(mode)) await assert.rejects(captureOrCompare(page, browser, info, checkpoints[0], page), {message:'Bundled Nunito Variable FontFace did not load.'});
  if (mode === 'healthy' || mode === 'mixed') await assert.rejects(captureOrCompare(page, browser, info, checkpoints[0], {screenshot: async () => { throw new Error('after-original-font-guard'); }}), {message:'after-original-font-guard'});
  if (mode === 'reload') { await quiet.preserveBeforeReload(page); await page.reload(); await page.evaluate(() => document.fonts.ready); }
  if (mode === 'pass') return;
  quiet.mark(page, 'phase-boundary', {stage:'creation-comparison',edge:'complete'});
  throw new Error('privacy-canary-failure');
});
`;
    const config = resolve(root, "config.mjs");
    const receipt = resolve(
      ".audit/quiet-save-self-test-evidence/presave-assertion-0.jsonl",
    );
    const oldReceipt = await readFile(receipt).catch(() => null);
    try {
      await writeFile(fixturePath, fixture);
      await writeFile(
        proofPath,
        JSON.stringify({
          schema: 1,
          mode: "calibration",
          source: "calibration-test",
          sha256: digest(fixture),
        }),
      );
      await writeFile(
        config,
        `export default { testDir:${JSON.stringify(fixtureRoot)}, testMatch:'probe.spec.mjs',timeout:30000,retries:0,workers:1,updateSnapshots:'none',reporter:[[${JSON.stringify(reporter)}]],projects:[{name:'chromium-desktop',use:{browserName:'chromium',viewport:{width:1280,height:900},screen:{width:1280,height:900},deviceScaleFactor:1,locale:'en-US',timezoneId:'America/New_York',trace:'off',screenshot:'off',video:'off'}}] };`,
      );
      await mkdir(resolve(".audit/quiet-save-self-test-evidence"), {
        recursive: true,
      });
      for (const current of [
        "healthy",
        "abort",
        "corrupt",
        "hold",
        "missing",
        "unused",
        "mixed",
        "reload",
        "redirect",
        "pass",
        "skip",
      ]) {
        mode = current;
        await writeFile(receipt, "");
        const exitCode = await new Promise((done, reject) => {
          const child = spawn(
            process.execPath,
            [
              "node_modules/@playwright/test/cli.js",
              "test",
              "--config",
              config,
            ],
            {
              stdio: "ignore",
              env: {
                ...process.env,
                QUIET_SELF_TEST: "1",
                QUIET_CONTROL: "presave-assertion",
                QUIET_ITERATION: "0",
                QUIET_PHASE: "calibration",
                QUIET_FONT_CASE: current,
                DAMADAMA_BROWSER_PORT: String(server.address().port),
                COMPAT_MODE: "capture",
                COMPAT_OS_DISTRIBUTION: "ubuntu",
                COMPAT_OS_VERSION: "24.04",
              },
            },
          );
          child.once("error", reject);
          child.once("close", done);
        });
        assert.equal(
          exitCode,
          ["pass", "skip"].includes(current) ? 0 : 1,
          current,
        );
        const text = await readFile(receipt, "utf8");
        assert.equal(text.includes("privacy-canary"), false, current);
        assert.equal(text.includes(origin), false, current);
        const row = parseReceipt(text, "presave-assertion", 0).find(
          (item) => item.kind === "test-result",
        );
        assert.equal(row.observationRejected, false, current);
        if (["pass", "skip"].includes(current)) {
          assert.equal(row.observation, null, current);
          continue;
        }
        const font = row.observation.font;
        assert.ok(
          row.observation.node.some(
            (event) =>
              event.event === "phase-boundary" && event.edge === "complete",
          ),
          current,
        );
        assert.equal(font.transport.refusal, "none", current);
        assert.equal(font.sample.state, "available", current);
        const events = font.transport.events;
        const family = font.sample.snapshot.family;
        if (current === "missing") {
          assert.equal(family.state, "missing");
          assert.equal(events.length, 0);
          continue;
        }
        assert.equal(family.state, "present", current);
        if (current === "unused") {
          assert.equal(family.counts.unloaded, 5);
          assert.equal(events.length, 0);
          continue;
        }
        if (current === "hold") {
          assert.equal(partialSent, true);
          assert.ok(family.counts.loading > 0);
          assert.equal(events[0].event, "font-request");
          assert.ok(
            events.every((event) =>
              ["font-request", "font-response"].includes(event.event),
            ),
          );
          assert.ok(
            events
              .filter((event) => event.event === "font-response")
              .every((event) => event.status === 200),
          );
          for (const response of held) response.destroy();
          continue;
        }
        if (current === "abort") {
          assert.ok(family.counts.error > 0);
          assert.deepEqual(
            events.map((event) => event.event),
            ["font-request", "font-request-failed"],
          );
          assert.equal(events[1].category, "aborted");
          continue;
        }
        assert.ok(
          events.some(
            (event) =>
              event.event === "font-response" &&
              event.status === (current === "redirect" ? 302 : 200),
          ),
          current,
        );
        assert.ok(
          events.some((event) => event.event === "font-request-finished"),
          current,
        );
        if (current === "corrupt") assert.ok(family.counts.error > 0);
        else assert.ok(family.counts.loaded > 0, current);
        if (current === "mixed") assert.ok(family.counts.unloaded > 0);
        if (current === "reload") {
          assert.equal(font.sample.document, 2);
          assert.ok(events.some((event) => event.document === 1));
        }
        assert.ok(
          events.every((event) => event.kind === "latin"),
          current,
        );
      }
    } finally {
      for (const response of held) response.destroy();
      for (const serverToClose of [server, remote]) {
        serverToClose.closeAllConnections();
        await new Promise((done) => serverToClose.close(done));
      }
      for (const [path, bytes] of [
        [fixturePath, oldFixture],
        [proofPath, oldProof],
        [receipt, oldReceipt],
      ]) {
        if (bytes) await writeFile(path, bytes);
        else await rm(path, { force: true });
      }
    }
  },
);
