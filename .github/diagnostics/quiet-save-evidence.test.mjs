import { readOwnedFile } from "./quiet-save-files.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
  link,
  utimes,
  rename,
} from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { test, mock } from "node:test";
import { generate } from "./quiet-save-generate.mjs";
import {
  digest,
  loadSources,
  normalizeSite,
  sourceSite,
  unavailableSite,
  readFontAssets,
} from "./quiet-save-source.mjs";
import {
  mediaDirectory,
  mediaManifest,
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

test("auxiliary native PNGs are validated and discarded under their exact owner", async () => {
  const outputRoot = resolve(root, "auxiliary-output");
  const outputDir = resolve(outputRoot, "owned");
  const active = {
    ...owner,
    control: "normal",
    iteration: 19,
    phase: "changed-row pixel rejection and same-page restoration",
  };
  await mkdir(outputDir, { recursive: true });
  await clearOwned(mediaDirectory(active, true));
  for (const occurrence of [1, 2, 3])
    for (const kind of ["actual", "expected", "diff"])
      await writeFile(
        resolve(outputDir, `desktop-saved-${occurrence}-${kind}.png`),
        await readFile("tests/Browser/baselines/desktop-saved.png"),
      );
  const result = await retainFailureMedia({
    outputDir,
    outputRoot,
    owner: active,
    head,
    selfTest: true,
    started: 0,
  });
  assert.equal(result.refusal, "none");
  assert(result.entries.every((entry) => entry.state === "absent"));
  assert.deepEqual(await readdir(mediaDirectory(active, true)), [
    "manifest.json",
  ]);
  await clearOwned(mediaDirectory(active, true));
  await clearOwned(outputRoot);
});

test("auxiliary PNG inventory refuses foreign ownership, unsafe bytes and replaced files", async () => {
  const outputRoot = resolve(root, "auxiliary-policy");
  const outputDir = resolve(outputRoot, "owned");
  const mutation = {
    ...owner,
    control: "normal",
    iteration: 19,
    phase: "changed-row pixel rejection and same-page restoration",
  };
  const calibration = { ...owner, control: "presave-assertion", iteration: 0 };
  const baseline = await readFile("tests/Browser/baselines/desktop-saved.png");
  const creation = await readFile(
    "tests/Browser/baselines/desktop-creation.png",
  );
  const mobile = await readFile("tests/Browser/baselines/mobile-layout.png");
  async function capture(
    files,
    active = mutation,
    { started = 0, selfTest = true, prepare = async () => {} } = {},
  ) {
    await clearOwned(outputRoot);
    await mkdir(outputDir, { recursive: true });
    const destination = mediaDirectory(active, selfTest);
    if (selfTest) await clearOwned(destination);
    else {
      assert(
        destination.startsWith(resolve(".audit/quiet-save/evidence") + "/") ||
          destination.startsWith(resolve(".audit/quiet-save/evidence") + "\\"),
      );
      await rm(destination, { recursive: true, force: true });
    }
    for (const [name, bytes] of files)
      await writeFile(resolve(outputDir, name), bytes);
    await prepare();
    try {
      const manifest = await retainFailureMedia({
        outputDir,
        outputRoot,
        owner: active,
        head,
        selfTest,
        started,
      });
      assert.equal(JSON.stringify(manifest).includes("previous"), false);
      return manifest;
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      await rm(destination, { recursive: true, force: true });
    }
  }
  const candidate = (name, bytes = baseline) => [[name, bytes]];
  for (const [active, checkpoint, bytes] of [
    [mutation, "desktop-creation", creation],
    [mutation, "desktop-saved", baseline],
    [
      {
        ...mutation,
        phase: "fresh visual comparison 1",
        project: "chromium-mobile",
        case: 2,
      },
      "mobile-layout",
      mobile,
    ],
    [calibration, "desktop-saved", baseline],
  ]) {
    for (const suffix of ["1-actual", "1-expected", "1-diff", "previous"])
      assert.equal(
        (await capture(candidate(`${checkpoint}-${suffix}.png`, bytes), active))
          .refusal,
        "none",
      );
  }
  for (const suffix of ["2-previous", "3-previous", "2-expected", "3-expected"])
    assert.equal(
      (await capture(candidate(`desktop-saved-${suffix}.png`))).refusal,
      "none",
    );
  for (const name of [
    "desktop-saved-0-actual.png",
    "desktop-saved-4-diff.png",
    "desktop-saved-99-actual.png",
    "desktop-creation-2-actual.png",
    "mobile-layout-1-actual.png",
    "foreign-previous.png",
    "desktop-saved-1-previous.png",
    "desktop-saved-4-previous.png",
    "intentionally-absent-compatibility-control-actual.png",
  ])
    assert.equal((await capture(candidate(name))).refusal, "file-policy", name);
  for (const active of [
    { ...mutation, case: 0 },
    { ...mutation, project: "chromium-mobile" },
    { ...mutation, control: "pixel-mismatch" },
    { ...mutation, iteration: 0 },
    { ...mutation, phase: "Firefox and WebKit smoke" },
    { ...mutation, phase: "fresh visual comparison 1" },
    { ...mutation, phase: "missing-baseline rejection" },
    { ...calibration, iteration: 1 },
    { ...calibration, control: "pixel-mismatch" },
    { ...calibration, project: "firefox-smoke" },
    { ...calibration, case: 2 },
  ])
    assert.equal(
      (await capture(candidate("desktop-saved-2-actual.png"), active)).refusal,
      "file-policy",
    );
  assert.equal(
    (
      await capture(candidate("desktop-saved-2-actual.png"), calibration, {
        selfTest: false,
      })
    ).refusal,
    "file-policy",
  );
  assert.equal(
    (await capture(candidate("desktop-saved-1-expected.png", creation)))
      .refusal,
    "metadata",
  );
  assert.equal(
    (await capture(candidate("desktop-saved-2-expected.png", creation)))
      .refusal,
    "metadata",
  );
  for (const bytes of [
    Buffer.from("invalid PNG"),
    Buffer.alloc(4 * 1024 * 1024 + 1),
  ])
    assert.equal(
      (await capture(candidate("desktop-saved-2-actual.png", bytes))).refusal,
      "file-policy",
    );
  assert.equal(
    (
      await capture(
        candidate("desktop-saved-previous.png", Buffer.from("invalid PNG")),
      )
    ).refusal,
    "file-policy",
  );
  const file = resolve(outputDir, "desktop-saved-2-actual.png");
  assert.equal(
    (
      await capture(candidate("desktop-saved-2-actual.png"), mutation, {
        started: Date.now() - 1000,
        prepare: () => utimes(file, new Date(0), new Date(0)),
      })
    ).refusal,
    "file-policy",
  );
  assert.equal(
    (
      await capture(candidate("desktop-saved-2-actual.png"), mutation, {
        prepare: () => link(file, resolve(outputDir, "hard-link.bin")),
      })
    ).refusal,
    "file-policy",
  );
  const external = resolve(root, "auxiliary-linked");
  await mkdir(external, { recursive: true });
  await writeFile(resolve(external, "desktop-saved-2-actual.png"), baseline);
  assert.equal(
    (
      await capture([], mutation, {
        prepare: async () => {
          await rm(outputDir, { recursive: true });
          await symlink(external, outputDir, "junction");
        },
      })
    ).refusal,
    "file-policy",
  );
  await rm(outputDir);
  await clearOwned(external);
  let replaced = false;
  const originalOpen = fsPromises.open;
  assert.equal(
    (
      await capture(candidate("desktop-saved-2-actual.png"), mutation, {
        prepare: async () => {
          mock.method(fsPromises, "open", async (path, ...args) => {
            if (path === file && !replaced) {
              replaced = true;
              await rename(file, resolve(outputDir, "replaced.bin"));
              await writeFile(file, baseline);
            }
            return originalOpen(path, ...args);
          });
          syncBuiltinESMExports();
        },
      })
    ).refusal,
    "file-policy",
  );
  assert(replaced, "The replacement control must reach the owned-file open.");
  const padding = Buffer.alloc(3 * 1024 * 1024);
  padding.writeUInt32BE(padding.length - 12, 0);
  padding.write("IDAT", 4, "ascii");
  const large = Buffer.concat([
    baseline.subarray(0, -12),
    padding,
    baseline.subarray(-12),
  ]);
  const inputs = [
    "desktop-saved-actual.png",
    "desktop-saved-diff.png",
    "desktop-saved-1-actual.png",
    "desktop-saved-1-diff.png",
    "desktop-saved-2-actual.png",
    "desktop-saved-2-diff.png",
    "desktop-saved-3-actual.png",
  ];
  assert.equal(
    (await capture(inputs.map((name) => [name, large]))).refusal,
    "byte-bound",
  );
  await clearOwned(outputRoot);
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
    schema: 2,
    fontBuild: (await readFontAssets()).proof,
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
  const wrongFont = structuredClone(source);
  wrongFont.fontBuild.assets[0].sha256 = "f".repeat(64);
  await writeFile(resolve(directory, "source.json"), JSON.stringify(wrongFont));
  await assert.rejects(
    validateEvidence(directory),
    /Retained font inventory differs/,
  );
  await writeFile(resolve(directory, "source.json"), JSON.stringify(source));
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
    JSON.stringify({ ...source, tree: "f".repeat(40) }),
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
  const entry = {
    kind: "calibration",
    control: "invalid",
    matched: false,
    outcome: {
      kind: "not-started",
      reason: "budget-refused",
      receipt: "absent",
      teardown: "not-started",
    },
  };
  const outcomes = resolve(directory, "outcomes.json");
  const receipt = resolve(directory, "invalid-0.jsonl");
  const retain = async () => writeFile(outcomes, JSON.stringify([entry]));
  await retain();
  assert.equal((await validateEvidence(directory)).files, 3);
  await writeFile(receipt, "");
  await assert.rejects(validateEvidence(directory), /Not-started/);
  await rm(receipt);
  entry.outcome = {
    kind: "started",
    exitCode: null,
    termination: "owned-group-interrupt",
    teardown: "unverified-stop-no-retry",
    receipt: "missing",
    conclusion: "incomplete",
  };
  await retain();
  assert.equal((await validateEvidence(directory)).files, 3);
  entry.outcome.conclusion = "complete-pass";
  await retain();
  await assert.rejects(validateEvidence(directory));
  entry.outcome.conclusion = "incomplete";
  entry.outcome.receipt = "empty";
  await retain();
  await writeFile(receipt, "");
  assert.equal((await validateEvidence(directory)).files, 4);
  await writeFile(receipt, '{"truncated":');
  await assert.rejects(validateEvidence(directory));
  entry.outcome.receipt = "malformed";
  await retain();
  await assert.rejects(validateEvidence(directory), /Malformed receipt/);
  entry.outcome.receipt = "bounded-prefix";
  await retain();
  const prefix = {
    kind: "phase-start",
    control: "invalid",
    iteration: 0,
    phase: "calibration",
    cases: 1,
  };
  await writeFile(receipt, JSON.stringify(prefix) + "\n");
  assert.equal((await validateEvidence(directory)).files, 4);
  entry.outcome.conclusion = "complete-pass";
  await retain();
  await assert.rejects(validateEvidence(directory), /conclusion/);
  entry.outcome.conclusion = "incomplete";
  await retain();
  for (const mutation of [
    { ...prefix, cases: 2 },
    { ...prefix, phase: "fresh visual comparison 1" },
    { ...prefix, iteration: 1 },
  ]) {
    await writeFile(receipt, JSON.stringify(mutation) + "\n");
    await assert.rejects(validateEvidence(directory));
  }
  await writeFile(receipt, JSON.stringify(prefix) + "\n");
  await writeFile(outcomes, JSON.stringify([entry, entry]));
  await assert.rejects(validateEvidence(directory), /terminal stop/);
  await retain();
  await mkdir(resolve(directory, "media-invalid-0-0-chromium-desktop-1"));
  await assert.rejects(validateEvidence(directory), /Unexpected evidence/);
});
