import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { test } from "node:test";
import { generate } from "./quiet-save-generate.mjs";
import {
  digest,
  loadSources,
  normalizeSite,
  sourceSite,
  unavailableSite,
} from "./quiet-save-source.mjs";
import {
  mediaDirectory,
  mediaManifest,
  readOwnedFile,
  retainFailureMedia,
  validateRetainedMedia,
} from "./quiet-save-media.mjs";
import { parseReceipt } from "./quiet-save-receipt.mjs";
import { validateEvidence } from "./quiet-save-validate.mjs";

const owner = {
  control: "pixel-mismatch",
  iteration: 0,
  phase: "calibration",
  project: "chromium-desktop",
  case: 1,
};
const root = resolve(".audit/quiet-save-evidence-tests");
const evidence = resolve(".audit/quiet-save-self-test-evidence");
const head = "a".repeat(40);

async function clearOwned(path) {
  const roots = [root, evidence];
  assert(
    roots.some(
      (base) =>
        path === base ||
        path.startsWith(base + "/") ||
        path.startsWith(base + "\\"),
    ),
  );
  await rm(path, { recursive: true, force: true });
}

test("source proof binds exact known files, bounds and canonical mapping", async () => {
  await generate();
  const sources = loadSources();
  assert.equal(sources.length, 2);
  const known = { file: sources[0].path, line: 2, column: 1 };
  assert.equal(normalizeSite(known, sources).source, "generated-test");
  for (const location of [
    { ...known, file: resolve("spoof/observed.pw.ts") },
    { ...known, line: 10001 },
    { ...known, line: 1, column: 1000 },
    { ...known, column: 0 },
  ])
    assert.deepEqual(normalizeSite(location, sources), unavailableSite);
  assert.equal(
    sourceSite.safeParse({ source: "unavailable", line: 1, column: 1 }).success,
    false,
  );
  const path = resolve(".audit/quiet-save/source-map.json");
  const original = await readFile(path);
  try {
    const proof = JSON.parse(original);
    proof.mapping[0] = 7;
    proof.mappingSha256 = digest(JSON.stringify(proof.mapping));
    await writeFile(path, JSON.stringify(proof));
    assert.throws(() => loadSources());
  } finally {
    await writeFile(path, original);
  }
});

test(
  "real runner retains immediate assertion and native pixel mismatch with strict private evidence",
  { timeout: 60000 },
  async () => {
    await mkdir(root, { recursive: true });
    await mkdir(evidence, { recursive: true });
    const helper = resolve(
      ".github/diagnostics/quiet-save-observer.mjs",
    ).replaceAll("\\", "/");
    const reporter = resolve(
      ".github/diagnostics/quiet-save-reporter.mjs",
    ).replaceAll("\\", "/");
    const baseline = JSON.parse(
      await readFile("tests/Browser/baselines/manifest.json", "utf8"),
    );
    const image = baseline.images.find(
      (entry) => entry.id === "desktop-creation",
    );
    const png = await readFile("tests/Browser/baselines/desktop-creation.png");
    const comparison = {
      schemaVersion: 1,
      checkpoint: "desktop-creation",
      comparisonSHA: head,
      baselineGenerationSHA: baseline.generationSHA,
      expectedImageSHA256: image.sha256,
      comparisonImageSHA256: image.sha256,
      expectedPNG: "tests/Browser/baselines/desktop-creation.png",
      comparisonPNG: "desktop-creation-comparison.png",
      environment: image.environment,
    };
    const fixture = `import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import * as quiet from ${JSON.stringify(helper)};
test.beforeEach(async ({ page }) => { await quiet.begin(page, process.env.QUIET_CONTROL); });
test.afterEach(async ({ page }, info) => { await quiet.finish(page, info); });
test("desktop creation and saved details remain stable", async ({ page }, info) => {
  await page.goto("about:blank");
  quiet.mark(page, "phase-boundary", { stage: "dialog-open", edge: "start" });
  await page.setContent('<style>html,body { margin:0; background:rgb(255,0,0) }</style>');
  quiet.mark(page, "phase-boundary", { stage: "dialog-open", edge: "complete" });
  quiet.mark(page, "phase-boundary", { stage: "creation-comparison", edge: "start" });
  if (process.env.QUIET_FIXTURE_CASE === "plain") throw new Error("privacy-canary-plain");
  if (process.env.QUIET_FIXTURE_CASE === "caught") {
    let sameMessage;
    try { expect(false).toBe("privacy-canary-shared"); } catch (error) { sameMessage = error.message; }
    throw new Error(sameMessage);
  }
  if (process.env.QUIET_CONTROL === "presave-assertion") expect(false).toBe("privacy-canary-error");
  await writeFile(info.outputPath("desktop-creation-comparison.png"), await readFile("tests/Browser/baselines/desktop-creation.png"));
  await writeFile(info.outputPath("desktop-creation-comparison.json"), JSON.stringify(${JSON.stringify(comparison)}));
  await expect(page).toHaveScreenshot("desktop-creation.png");
});
`;
    await writeFile(resolve(root, "probe.spec.mjs"), fixture);
    await writeFile(
      resolve(root, "config.mjs"),
      `export default { testDir: ".", testMatch: "probe.spec.mjs", timeout: 30000, retries: 0, workers: 1, updateSnapshots: "none", outputDir: ${JSON.stringify(resolve(root, "output"))}, snapshotPathTemplate: ${JSON.stringify(resolve("tests/Browser/baselines/{arg}{ext}").replaceAll("\\", "/"))}, reporter: [[${JSON.stringify(reporter)}]], projects: [{ name: "chromium-desktop", use: { browserName: "chromium", viewport: { width: ${png.readUInt32BE(16)}, height: ${png.readUInt32BE(20)} }, trace: "off", screenshot: "off", video: "off" } }] };`,
    );
    await writeFile(
      resolve(root, "source.json"),
      JSON.stringify({
        schema: 1,
        mode: "calibration",
        source: "calibration-test",
        sha256: digest(fixture),
      }),
    );
    for (const [control, fixtureCase] of [
      ["presave-assertion", "assertion"],
      ["pixel-mismatch", "pixel"],
      ["presave-assertion", "plain"],
      ["presave-assertion", "caught"],
    ]) {
      const active = { ...owner, control };
      const destination = mediaDirectory(active, true);
      await clearOwned(destination);
      const receipt = resolve(evidence, `${control}-0.jsonl`);
      await writeFile(receipt, "");
      const exitCode = await new Promise((resolveExit, reject) => {
        const child = spawn(
          process.execPath,
          [
            "node_modules/@playwright/test/cli.js",
            "test",
            "--config",
            resolve(root, "config.mjs"),
          ],
          {
            stdio: "ignore",
            env: {
              ...process.env,
              QUIET_CONTROL: control,
              QUIET_FIXTURE_CASE: fixtureCase,
              QUIET_SELF_TEST: "1",
              QUIET_ITERATION: "0",
              QUIET_PHASE: "calibration",
              COMPAT_CURRENT_SHA: head,
            },
          },
        );
        child.once("error", reject);
        child.once("close", resolveExit);
      });
      assert.equal(exitCode, 1);
      const text = await readFile(receipt, "utf8");
      assert.equal(text.includes("privacy-canary"), false);
      assert.equal(text.includes(root), false);
      const rows = parseReceipt(text, control, 0);
      const result = rows.find((row) => row.kind === "test-result");
      assert.equal(result.status, "failed");
      assert.equal(result.failure.stage, "creation-comparison");
      assert.equal(result.failure.site.source, "calibration-test");
      assert.equal(result.failure.candidateOverflow, false);
      assert.equal(result.mediaRejected, false);
      assert.equal(result.media.refusal, "none");
      const manifest = await validateRetainedMedia(result.media, destination);
      if (["plain", "caught"].includes(fixtureCase)) {
        const marker =
          fixtureCase === "plain"
            ? 'throw new Error("privacy-canary-plain")'
            : "throw new Error(sameMessage)";
        assert.equal(
          result.failure.site.line,
          fixture.split("\n").findIndex((line) => line.includes(marker)) + 1,
        );
        assert.equal(result.failure.category, "unknown");
        assert.equal(result.failure.operation, "unknown");
        assert.equal(result.failure.locationOrigin, "result-error");
        assert.equal(
          manifest.entries.every((entry) => entry.state === "absent"),
          true,
        );
        continue;
      }
      assert.equal(result.failure.category, "expect");
      assert.equal(result.failure.locationOrigin, "step");
      if (control === "presave-assertion") {
        assert.equal(result.failure.operation, "toBe");
        assert.equal(
          manifest.entries.every((entry) => entry.state === "absent"),
          true,
        );
      } else {
        assert.equal(result.failure.operation, "toHaveScreenshot");
        assert.deepEqual(
          manifest.entries
            .filter((entry) => entry.state === "present")
            .map((entry) => entry.kind),
          ["comparison-json", "comparison-png", "actual", "expected", "diff"],
        );
        for (const file of await readdir(destination))
          assert.equal(
            (await readFile(resolve(destination, file))).includes(
              Buffer.from("privacy-canary"),
            ),
            false,
          );
        await writeFile(
          resolve(destination, "unintended.json"),
          '{"token":"privacy-canary"}',
        );
        await assert.rejects(validateRetainedMedia(manifest, destination));
        await rm(resolve(destination, "unintended.json"));
        await writeFile(
          resolve(destination, "manifest.json"),
          JSON.stringify({ ...manifest, token: "privacy-canary" }),
        );
        await assert.rejects(validateRetainedMedia(manifest, destination));
        await writeFile(
          resolve(destination, "manifest.json"),
          JSON.stringify(manifest),
        );
        const actual = resolve(destination, "desktop-creation-actual.png");
        const bytes = await readFile(actual);
        await writeFile(
          actual,
          Buffer.concat([bytes, Buffer.from("privacy-canary")]),
        );
        await assert.rejects(validateRetainedMedia(manifest, destination));
        await writeFile(actual, bytes);
      }
    }
  },
);

test("media refuses stale files, links, unknown candidates and metadata fields", async () => {
  await mkdir(root, { recursive: true });
  const outputRoot = resolve(root, "policy-output");
  const outputDir = resolve(outputRoot, "owned");
  await mkdir(outputDir, { recursive: true });
  const active = { ...owner, iteration: 1 };
  const destination = mediaDirectory(active, true);
  const retain = () =>
    retainFailureMedia({
      outputDir,
      outputRoot,
      started: 0,
      owner: active,
      head,
      selfTest: true,
    });
  await clearOwned(destination);
  await writeFile(
    resolve(outputDir, "privacy-canary-actual.png"),
    "privacy-canary",
  );
  let result = await retain();
  assert.equal(result.refusal, "file-policy");
  assert.equal(
    result.entries.every((entry) => entry.state === "refused"),
    true,
  );
  assert.equal(JSON.stringify(result).includes("privacy-canary"), false);
  await rm(resolve(outputDir, "privacy-canary-actual.png"));
  await clearOwned(destination);
  await writeFile(
    resolve(outputDir, "desktop-creation-comparison.json"),
    '{"token":"privacy-canary"}',
  );
  result = await retain();
  assert.equal(result.refusal, "metadata");
  await rm(resolve(outputDir, "desktop-creation-comparison.json"));
  const file = resolve(outputDir, "desktop-creation-actual.png");
  await writeFile(
    file,
    await readFile("tests/Browser/baselines/desktop-creation.png"),
  );
  await assert.rejects(readOwnedFile(file, Date.now() + 60000));
  const link = resolve(root, "linked-output");
  await clearOwned(link);
  await symlink(outputDir, link, "junction");
  await assert.rejects(
    readOwnedFile(resolve(link, "desktop-creation-actual.png")),
  );
  await rm(link);
  assert.equal(
    mediaManifest.safeParse({
      ...result,
      entries: [...result.entries, result.entries[0]],
    }).success,
    false,
  );
  assert.equal(
    mediaManifest.safeParse({
      ...result,
      owner: { ...active, project: "chromium-mobile" },
    }).success,
    false,
  );
});

test("caught failed steps cannot claim a later uncaught error", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    QUIET_SELF_TEST: "1",
    QUIET_ITERATION: "0",
    QUIET_CONTROL: "presave-assertion",
    QUIET_PHASE: "calibration",
  });
  try {
    const { default: Reporter } = await import("./quiet-save-reporter.mjs");
    const reporter = new Reporter();
    const recorded = [];
    reporter.record = (row) => recorded.push(row);
    const testCase = {
      id: "fixed",
      title: "desktop creation and saved details remain stable",
      parent: { project: () => ({ name: "chromium-desktop" }) },
    };
    reporter.onStepEnd(
      testCase,
      {},
      {
        category: "expect",
        title: 'Expect "toHaveScreenshot(desktop-creation.png)"',
        location: {
          file: resolve(root, "probe.spec.mjs"),
          line: 15,
          column: 3,
        },
        error: { message: "caught-privacy-canary" },
        steps: [],
      },
    );
    reporter.onTestEnd(testCase, {
      status: "failed",
      duration: 1,
      retry: 0,
      errors: [{ message: "uncaught-privacy-canary" }],
      attachments: [],
    });
    assert.equal(recorded[0].failure.operation, "unknown");
    assert.deepEqual(recorded[0].failure.site, unavailableSite);
    for (const stack of ["different-private-stack", "same-private-stack"]) {
      const file = resolve(root, "probe.spec.mjs");
      reporter.onStepEnd(
        testCase,
        {},
        {
          category: "expect",
          title: 'Expect "toHaveScreenshot"',
          location: { file, line: 15, column: 3 },
          error: {
            message: "same-privacy-canary",
            stack: "same-private-stack",
          },
          steps: [],
        },
      );
      reporter.onTestEnd(testCase, {
        status: "failed",
        duration: 1,
        retry: 0,
        errors: [
          {
            message: "same-privacy-canary",
            stack,
            location: { file, line: 11, column: 3 },
          },
        ],
        attachments: [],
      });
      assert.equal(recorded.at(-1).failure.operation, "unknown");
      assert.equal(recorded.at(-1).failure.locationOrigin, "result-error");
      assert.deepEqual(recorded.at(-1).failure.site, {
        source: "calibration-test",
        line: 11,
        column: 3,
      });
    }
    assert.equal(JSON.stringify(recorded).includes("privacy-canary"), false);
    assert.equal(JSON.stringify(recorded).includes("private-stack"), false);
  } finally {
    for (const key of [
      "QUIET_SELF_TEST",
      "QUIET_ITERATION",
      "QUIET_CONTROL",
      "QUIET_PHASE",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("upload boundary validates complete owned proof and refuses unknown files and source identities", async () => {
  const directory = resolve(root, "upload");
  await clearOwned(directory);
  await mkdir(directory, { recursive: true });
  const proof = await generate();
  const git = (reference) =>
    spawnSync("git", ["rev-parse", reference], {
      encoding: "utf8",
    }).stdout.trim();
  const source = {
    schema: 1,
    head: git("HEAD"),
    tree: git("HEAD^{tree}"),
    node: "v24.21.0",
    kernel: "6.17.0",
    arch: "x64",
    cpus: 4,
    memoryBytes: 16000000000,
    imageOS: "ubuntu24",
    imageVersion: "20261012.334.1",
    ...proof,
    kind: "diagnostic-not-acceptance",
    invocations: 20,
    phases: 6,
    deadlineMinutesAfterJobStart: 39,
  };
  await writeFile(resolve(directory, "source.json"), JSON.stringify(source));
  await writeFile(
    resolve(directory, "source-map.json"),
    await readFile(".audit/quiet-save/source-map.json"),
  );
  await writeFile(resolve(directory, "outcomes.json"), "[]");
  assert.deepEqual(await validateEvidence(directory), {
    files: 3,
    mediaFiles: 0,
    mediaBytes: 0,
  });
  await writeFile(resolve(directory, "privacy-canary.txt"), "privacy-canary");
  await assert.rejects(validateEvidence(directory));
  await rm(resolve(directory, "privacy-canary.txt"));
  await writeFile(
    resolve(directory, "source.json"),
    JSON.stringify({ ...source, head: "f".repeat(40) }),
  );
  await assert.rejects(validateEvidence(directory));
  await writeFile(
    resolve(directory, "source.json"),
    JSON.stringify({ ...source, token: "privacy-canary" }),
  );
  await assert.rejects(validateEvidence(directory));
  await writeFile(resolve(directory, "source.json"), JSON.stringify(source));
  await writeFile(
    resolve(directory, "outcomes.json"),
    '[{"token":"privacy-canary"}]',
  );
  await assert.rejects(validateEvidence(directory));
  await writeFile(resolve(directory, "outcomes.json"), "[]");
  assert.deepEqual(await validateEvidence(directory), {
    files: 3,
    mediaFiles: 0,
    mediaBytes: 0,
  });
  const observed = parseReceipt(
    await readFile(resolve(evidence, "presave-assertion-0.jsonl"), "utf8"),
    "presave-assertion",
    0,
  );
  const rows = observed.map((row) => ({
    ...row,
    control: "normal",
    iteration: 1,
    phase: "fresh visual comparison 1",
  }));
  const result = rows.find((row) => row.kind === "test-result");
  result.failure = {
    ...result.failure,
    site: unavailableSite,
    category: "unknown",
    operation: "unknown",
    locationOrigin: "unavailable",
  };
  result.media.owner = {
    ...result.media.owner,
    control: "normal",
    iteration: 1,
    phase: "fresh visual comparison 1",
  };
  const mediaPath = resolve(
    directory,
    basename(mediaDirectory(result.media.owner)),
  );
  await mkdir(mediaPath);
  await writeFile(
    resolve(mediaPath, "manifest.json"),
    JSON.stringify(result.media),
  );
  const receipt = resolve(directory, "normal-1.jsonl");
  const serialize = () => rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(receipt, serialize());
  assert.deepEqual(await validateEvidence(directory), {
    files: 5,
    mediaFiles: 0,
    mediaBytes: 0,
  });
  result.media.owner.case = 0;
  await writeFile(receipt, serialize());
  await assert.rejects(validateEvidence(directory));
  result.media.owner.case = 1;
  await writeFile(receipt, serialize());
  await writeFile(resolve(mediaPath, "unexpected.png"), "privacy-canary");
  await assert.rejects(validateEvidence(directory));
  await rm(resolve(mediaPath, "unexpected.png"));
  assert.deepEqual(await validateEvidence(directory), {
    files: 5,
    mediaFiles: 0,
    mediaBytes: 0,
  });
});
