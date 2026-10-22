import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generate, prepare, replaceOnce } from "./quiet-save-generate.mjs";
import { digest, loadPassiveSources } from "./quiet-save-source.mjs";
import {
  concludeInvocation,
  invocationPassed,
  parseReceipt,
  phases,
  validateReceiptPrefix,
} from "./quiet-save-receipt.mjs";
import { caseNames, ownerSchema } from "./quiet-save-media.mjs";
import { runOwned } from "./quiet-save-run.mjs";
import QuietSaveReporter from "./quiet-save-reporter.mjs";
import { runNativeBoundary } from "./fixtures/passive-native-boundary.mjs";
import {
  passiveCalibrationCases,
  validatePassiveCalibrationCapture,
} from "./quiet-save-validate.mjs";

const root = resolve(".audit/quiet-save-integration-tests");
const started = {
  kind: "started",
  exitCode: 0,
  termination: "none",
  teardown: "owner-returned-resource-absence-unverified",
  receipt: "bounded-prefix",
};
const serialize = (rows) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

test(
  "unchanged canonical mutation and missing bodies cross actual local native boundaries",
  { timeout: 240000 },
  async () => {
    const proof = await runNativeBoundary();
    for (const mode of [
      "normal",
      "mutation",
      "missing",
      "restoration-failure",
    ]) {
      const runs = proof.results.filter((result) => result.mode === mode);
      const sequences = [];
      for (const run of runs) {
        assert.equal(run.runtime.status, "failed");
        assert.equal(
          run.runtime.body.bodyCompleted,
          mode !== "restoration-failure",
        );
        const rows = parseReceipt(run.receipt, "presave-assertion", 0);
        const result = rows.find((row) => row.kind === "test-result");
        assert.equal(
          result.passive.operations.kind,
          "complete",
          `${mode} ${run.passive}`,
        );
        assert.equal(
          result.media.refusal,
          "none",
          `${mode} media ${run.passive}`,
        );
        assert.equal(
          result.passive.network.kind,
          run.passive ? "complete" : "unverified",
        );
        assert(result.media.entries.every((entry) => entry.state === "absent"));
        const operations = result.passive.operations.value;
        const failures = operations.filter((row) => row.end.kind === "error");
        const expected = {
          normal: 0,
          mutation: 1,
          missing: 1,
          "restoration-failure": 2,
        };
        assert.equal(
          failures.length,
          expected[mode],
          `${mode} includes caught native failures`,
        );
        assert(!run.receipt.includes("Native screenshot"));
        assert(!run.receipt.includes("titlePolicy"));
        sequences.push(
          operations.map((row) => ({ site: row.site, end: row.end.kind })),
        );
      }
      assert.deepEqual(
        sequences[0],
        sequences[1],
        `${mode} direct/passive transport sequence`,
      );
      let expectedFiles = [];
      if (["mutation", "restoration-failure"].includes(mode))
        expectedFiles = ["actual", "diff", "expected"].map(
          (kind) => `desktop-saved-2-${kind}.png`,
        );
      if (mode === "restoration-failure")
        expectedFiles.push(
          ...["actual", "diff", "expected"].map(
            (kind) => `desktop-saved-3-${kind}.png`,
          ),
        );
      for (const run of runs)
        assert.deepEqual(
          run.nativeFiles,
          expectedFiles.sort(),
          `${mode} native file origins`,
        );
    }
  },
);

function successfulSession(iteration = 1) {
  return phases.flatMap((phase, index) => {
    let projects = ["chromium-desktop"];
    if (index === 0) projects = ["firefox-smoke", "webkit-smoke"];
    else if (index <= 3) projects = ["chromium-desktop", "chromium-mobile"];
    const owner = { control: "normal", iteration, phase };
    return [
      {
        ...owner,
        kind: "phase-start",
        cases: projects.length * caseNames.length,
      },
      ...projects.flatMap((project) =>
        caseNames.map((_title, id) => {
          let active = 0;
          if (project === "chromium-desktop") active = 1;
          if (project === "chromium-mobile") active = 2;
          return {
            ...owner,
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
            passive: null,
            media: null,
            mediaRejected: false,
            classification: "unknown",
          };
        }),
      ),
      { ...owner, kind: "phase-end", status: "passed" },
    ];
  });
}

test("normal wrapper and original Bun runner retain exact executable selections", async () => {
  const { files, proof } = await prepare();
  assert.equal(
    files["passive.pw.ts"],
    'import "../../tests/Browser/compatibility.pw";\nimport { installPassiveSaveHooks } from "../../.github/diagnostics/quiet-save-passive.mjs";\ninstallPassiveSaveHooks();\n',
  );
  const original = await readFile("tests/Browser/compatibility-run.ts", "utf8");
  let expected = replaceOnce(
    original,
    '"./visual-support"',
    '"../../tests/Browser/visual-support"',
  );
  expected = replaceOnce(
    expected,
    '"tests/Browser/compatibility.config.ts"',
    '".audit/quiet-save/passive.config.ts"',
  );
  expected = replaceOnce(
    expected,
    "      COMPAT_MODE: mode,",
    "      QUIET_PHASE: phase,\n      COMPAT_MODE: mode,",
  );
  assert.equal(files["observed-run.ts"], expected);
  assert(
    files["passive.config.ts"].includes(
      JSON.stringify(
        resolve("tests/Browser/baselines/{arg}{ext}").replaceAll("\\", "/"),
      ),
    ),
  );
  assert(files["passive.config.ts"].includes('testMatch: "passive.pw.ts"'));
  assert(files["observed.config.ts"].includes('testMatch: "observed.pw.ts"'));
  assert(files["calibration.pw.ts"].includes('if (info.status === "passed")'));
  assert.equal(proof.mode, "canonical-import");
  for (const [name, hash] of Object.entries(proof.passive.files))
    assert.equal(hash, digest(files[name]));
  for (const [name, hash] of Object.entries(proof.passive.diagnostics))
    assert.equal(hash, digest(await readFile(`.github/diagnostics/${name}`)));
});

test("controlled fixture admission accepts actual owned absence metadata and refuses media bytes", async () => {
  await mkdir(root, { recursive: true });
  const capture = await mkdtemp(resolve(root, "media-admission-"));
  const owner = {
    control: "presave-assertion",
    iteration: 0,
    phase: "calibration",
    project: "chromium-desktop",
    case: 1,
  };
  const mediaModule = pathToFileURL(
    resolve(".github/diagnostics/quiet-save-media.mjs"),
  ).href;
  const baseline = resolve("tests/Browser/baselines/desktop-creation.png");
  async function produce(image) {
    const directory = await mkdtemp(resolve(root, "media-producer-"));
    const program = `import {mkdir,readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {retainFailureMedia} from ${JSON.stringify(mediaModule)};
const outputRoot=resolve("output");
const outputDir=resolve(outputRoot,"case");
await mkdir(outputDir,{recursive:true});
const started=Date.now();
if (${image}) await writeFile(resolve(outputDir,"desktop-creation-actual.png"),await readFile(${JSON.stringify(baseline)}));
console.log(JSON.stringify(await retainFailureMedia({owner:${JSON.stringify(owner)},outputRoot,outputDir,started,head:"",selfTest:true})));`;
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", program],
      { cwd: directory, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  }
  const absent = await produce(false);
  assert.equal(absent.refusal, "none");
  assert(absent.entries.length > 0);
  assert(absent.entries.every((entry) => entry.state === "absent"));
  const base = {
    control: owner.control,
    iteration: owner.iteration,
    phase: owner.phase,
  };
  const result = {
    ...base,
    kind: "test-result",
    project: owner.project,
    case: owner.case,
    status: "failed",
    durationMs: 0,
    retry: 0,
    errorCategories: [],
    errorOverflow: false,
    observation: null,
    observationRejected: false,
    failure: null,
    passive: null,
    media: absent,
    mediaRejected: false,
    classification: "unknown",
  };
  const receipt = resolve(capture, `${passiveCalibrationCases[0]}.jsonl`);
  const retain = async (media) =>
    writeFile(
      receipt,
      serialize([
        { ...base, kind: "phase-start", cases: 1 },
        { ...result, media },
      ]),
    );
  const admit = () =>
    validatePassiveCalibrationCapture(capture, "chromium", "");
  await retain(absent);
  assert.deepEqual(await admit(), {
    matched: false,
    mediaFiles: 0,
    mediaBytes: 0,
  });
  const present = await produce(true);
  assert.equal(present.refusal, "none");
  assert(present.entries.some((entry) => entry.state === "present"));
  await retain(present);
  await assert.rejects(admit(), /Controlled fixture emitted media/);
  for (const mutate of [
    (value) => {
      value.entries[0].state = "refused";
    },
    (value) => {
      value.refusal = "ownership";
    },
    (value) => {
      value.owner.case = 0;
    },
    (value) => {
      value.token = "privacy-canary";
    },
  ]) {
    const rejected = structuredClone(absent);
    mutate(rejected);
    await retain(rejected);
    await assert.rejects(admit());
  }
  await writeFile(
    receipt,
    serialize([
      { ...base, kind: "phase-start", cases: 1 },
      { ...result, status: "skipped" },
    ]),
  );
  await assert.rejects(admit(), /Skipped calibration media differs/);
  await writeFile(
    receipt,
    serialize([
      { ...base, kind: "phase-start", cases: 1 },
      { ...result, status: "skipped", media: null },
    ]),
  );
  assert.deepEqual(await admit(), {
    matched: false,
    mediaFiles: 0,
    mediaBytes: 0,
  });
  await retain(absent);
  await writeFile(
    resolve(capture, "desktop-creation-actual.png"),
    await readFile(baseline),
  );
  await assert.rejects(admit(), /Unexpected calibration evidence file/);
});

test("actual generated wrapper discovers each canonical case once with inherited projects", async () => {
  await generate();
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      ".audit/quiet-save/passive.config.ts",
      "--list",
      "--reporter=json",
    ],
    { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  const listing = JSON.parse(result.stdout);
  const specs = [];
  const visit = (suite) => {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of listing.suites) visit(suite);
  const projects = listing.config.projects.map((project) => project.name);
  assert.deepEqual(
    [...projects].sort(),
    [...ownerSchema.shape.project.options].sort(),
  );
  assert.deepEqual(
    specs.flatMap((spec) =>
      spec.tests.map((item) => [item.projectName, spec.title]),
    ),
    projects.flatMap((project) => caseNames.map((title) => [project, title])),
  );
  assert(
    specs.every(
      (spec) =>
        spec.file.endsWith("tests/Browser/compatibility.pw.ts") ||
        spec.file === "compatibility.pw.ts",
    ),
  );
  assert.equal(listing.config.workers, 1);
  assert(listing.config.projects.every((project) => project.retries === 0));
});

test("source admission refuses executable and profile mutations before returning canonical sites", async () => {
  await generate();
  const mapPath = resolve(".audit/quiet-save/source-map.json");
  const originalMap = await readFile(mapPath);
  const path = resolve(".audit/quiet-save/passive.pw.ts");
  const original = await readFile(path);
  try {
    assert(loadPassiveSources().length === 2);
    for (const replacement of [
      original
        .toString()
        .replace('compatibility.pw"', 'compatibility.pw-copy"'),
      original.toString() + "void 0;\n",
    ]) {
      await writeFile(path, replacement);
      assert.throws(() => loadPassiveSources(), /preparation/);
    }
    await writeFile(path, original);
    for (const name of [
      "passive.config.ts",
      "observed-run.ts",
      "calibration.pw.ts",
    ]) {
      const selected = resolve(".audit/quiet-save", name);
      const bytes = await readFile(selected);
      try {
        await writeFile(selected, bytes.toString() + "void 0;\n");
        assert.throws(() => loadPassiveSources(), /preparation/);
      } finally {
        await writeFile(selected, bytes);
      }
    }
    for (const mutate of [
      (value) => {
        value.mode = "canonical";
      },
      (value) => {
        value.passive.siteManifestSha256 = "f".repeat(64);
      },
      (value) => {
        value.passive.diagnostics["quiet-save-run.mjs"] = "f".repeat(64);
      },
      (value) => {
        value.passive.runtime.sourceHashes[0] = "f".repeat(64);
      },
    ]) {
      const value = JSON.parse(originalMap.toString());
      mutate(value);
      await writeFile(mapPath, JSON.stringify(value));
      assert.throws(() => loadPassiveSources());
    }
  } finally {
    await writeFile(path, original);
    await writeFile(mapPath, originalMap);
  }
});

test("normal failed receipt binds its original operations, error inventory and clock decision", async () => {
  const keys = {
    QUIET_PROFILE: "passive",
    QUIET_SELF_TEST: "1",
    QUIET_CONTROL: "normal",
    QUIET_ITERATION: "1",
    QUIET_PHASE: phases[1],
  };
  const previous = Object.fromEntries(
    Object.keys(keys).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, keys);
  try {
    const reporter = new QuietSaveReporter();
    const source = reporter.sources.find(
      (item) => item.source === "canonical-test",
    );
    const site = source.sites.find((item) => item.role === "save-enter");
    const error = {
      message: "private-error-canary",
      stack: "private-stack-canary",
    };
    const testCase = {
      id: "failed",
      title: caseNames[1],
      timeout: 30000,
      parent: { project: () => ({ name: "chromium-desktop" }) },
    };
    const result = {
      startTime: new Date(1000),
      duration: 4,
      workerIndex: 0,
      retry: 0,
      status: "failed",
      errors: [error],
      attachments: [],
    };
    const step = {
      category: "pw:api",
      title: 'Press "Enter"',
      location: { file: source.path, line: site.line, column: site.column },
      startTime: new Date(1001),
      duration: 1,
      error,
    };
    let row;
    reporter.record = (data) => {
      row = { control: "normal", iteration: 1, phase: phases[1], ...data };
    };
    reporter.onTestBegin(testCase);
    reporter.onStepBegin(testCase, result, step);
    reporter.onStepEnd(testCase, result, step);
    reporter.onTestEnd(testCase, result);
    assert.equal(
      parseReceipt(serialize([row]), "normal", 1)[0].passive.errors.value[0]
        .correlation.kind,
      "unique-step",
    );
    assert(!JSON.stringify(row).includes("private-"));
    for (const mutate of [
      (value) => {
        value.passive = null;
      },
      (value) => {
        value.passive.owner.case = 0;
      },
      (value) => {
        value.passive.budget.configuredWholeTestMs = 2500;
      },
      (value) => {
        value.passive.errors.value[0].errorIndex = 1;
      },
      (value) => {
        value.passive.errors.value = [];
      },
      (value) => {
        value.passive.operations.value[0].end.kind = "success";
      },
      (value) => {
        value.passive.budget.wallOffsets = "unavailable";
      },
      (value) => {
        value.passive.operations.value[0].end.at.value = 0;
      },
      (value) => {
        value.errorOverflow = true;
      },
      (value) => {
        value.observationRejected = true;
      },
    ]) {
      const changed = structuredClone(row);
      mutate(changed);
      assert.throws(() => parseReceipt(serialize([changed]), "normal", 1));
    }
    const owner = row.passive.owner;
    for (const [name, walls, usable] of [
      ["equal wall samples", [1010, 1010, 1010], true],
      ["increasing wall samples", [1010, 1011, 1012], true],
      ["request before installation", [1009, 1011, 1012], false],
      ["response before request", [1011, 1010, 1012], false],
      ["end before response", [1011, 1012, 1011], false],
    ]) {
      const journal = {
        installationWall: 1010,
        end: { at: 2, wall: walls[2] },
        events: [
          {
            sequence: 1,
            requestOrdinal: 1,
            at: 0,
            wall: walls[0],
            event: { kind: "request" },
          },
          {
            sequence: 2,
            requestOrdinal: 1,
            at: 1,
            wall: walls[1],
            event: { kind: "response", status: 201 },
          },
        ],
      };
      const attachment = {
        schema: 1,
        owner,
        workerIndex: 0,
        journal: { kind: "complete", value: journal },
      };
      const observed = {
        ...result,
        duration: 12,
        attachments: [
          {
            name: "quiet-save-passive",
            body: Buffer.from(JSON.stringify(attachment)),
          },
        ],
      };
      reporter.onTestBegin(testCase);
      reporter.onStepBegin(testCase, observed, step);
      reporter.onStepEnd(testCase, observed, step);
      reporter.onTestEnd(testCase, observed);
      const network = row.passive.network.value;
      assert.deepEqual(
        network.events.map((event) => event.event.kind),
        ["request", "response"],
        name,
      );
      if (usable) {
        assert.equal(
          row.passive.budget.wallOffsets,
          "estimates-from-transported-worker-wall-time",
          name,
        );
        assert(
          [
            network.installationWall,
            ...network.events.map((event) => event.wall),
            network.end.wall,
          ].every((wall) => wall.kind === "complete"),
          name,
        );
        assert.equal(
          parseReceipt(serialize([row]), "normal", 1).length,
          1,
          name,
        );
        continue;
      }
      assert.equal(row.passive.budget.wallOffsets, "unavailable", name);
      assert.equal(
        row.passive.operations.value[0].start.kind,
        "unverified",
        name,
      );
      assert.equal(
        row.passive.operations.value[0].end.at.kind,
        "unverified",
        name,
      );
      assert(
        [
          network.installationWall,
          ...network.events.map((event) => event.wall),
          network.end.wall,
        ].every((wall) => wall.kind === "unverified"),
        name,
      );
      assert.equal(parseReceipt(serialize([row]), "normal", 1).length, 1, name);
      const forged = structuredClone(row);
      forged.passive.budget.wallOffsets =
        "estimates-from-transported-worker-wall-time";
      forged.passive.operations.value[0].start = { kind: "complete", value: 1 };
      forged.passive.operations.value[0].end.at = {
        kind: "complete",
        value: 2,
      };
      const trusted = forged.passive.network.value;
      trusted.installationWall = { kind: "complete", value: 10 };
      trusted.events.forEach((event, index) => {
        event.wall = { kind: "complete", value: walls[index] - 1000 };
      });
      trusted.end.wall = { kind: "complete", value: walls[2] - 1000 };
      assert.throws(
        () => parseReceipt(serialize([forged]), "normal", 1),
        /Passive network wall order differs/,
        name,
      );
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("terminal outcomes distinguish actual spawn from budget and spawn refusal", async () => {
  await mkdir(root, { recursive: true });
  const marker = resolve(root, "child-started.json");
  await rm(marker, { force: true });
  const args = [
    "--input-type=module",
    "-e",
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');`,
  ];
  const budget = await runOwned(
    process.execPath,
    args,
    process.env,
    1000,
    Date.now(),
  );
  assert.deepEqual(budget, {
    kind: "not-started",
    reason: "budget-refused",
    receipt: "absent",
    teardown: "not-started",
  });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const refused = await runOwned(
    resolve(root, "missing-runtime"),
    [],
    process.env,
    1000,
    Date.now() + 60000,
  );
  assert.equal(refused.kind, "not-started");
  assert.equal(refused.reason, "spawn-refused");
  const run = await runOwned(
    process.execPath,
    args,
    process.env,
    1000,
    Date.now() + 60000,
  );
  assert.equal(run.kind, "started");
  assert.equal(run.exitCode, 0);
  assert.equal(await readFile(marker, "utf8"), "started");
  for (const receipt of ["missing", "empty", "malformed"])
    assert.equal(
      concludeInvocation({ ...run, receipt }, null, "normal").conclusion,
      "incomplete",
    );
  const rows = validateReceiptPrefix(
    parseReceipt(serialize(successfulSession()), "normal", 1),
    "normal",
  );
  assert.equal(
    concludeInvocation({ ...run, receipt: "bounded-prefix" }, rows, "normal")
      .conclusion,
    "complete-pass",
  );
  assert.deepEqual(
    await runOwned(process.execPath, args, process.env, 1000, Date.now()),
    budget,
  );
  assert.equal(
    concludeInvocation(started, rows.slice(0, -1), "normal").conclusion,
    "incomplete",
  );
});

test("normal receipt completion refuses reordered phases, cases, profiles and fabricated pass", () => {
  const rows = successfulSession();
  assert.equal(invocationPassed(rows, 0), true);
  for (const mutate of [
    (value) => {
      value[0].phase = phases[1];
    },
    (value) => {
      [value[1], value[2]] = [value[2], value[1]];
    },
    (value) => {
      value[1].project = "chromium-mobile";
    },
    (value) => {
      delete value[1].passive;
    },
    (value) => {
      value[1].status = "failed";
    },
    (value) => {
      value[1].observationRejected = true;
    },
    (value) => {
      value.push(value[0]);
    },
  ]) {
    const value = structuredClone(rows);
    mutate(value);
    assert.throws(() => {
      const parsed = validateReceiptPrefix(
        parseReceipt(serialize(value), "normal", 1),
        "normal",
      );
      assert.equal(
        concludeInvocation(started, parsed, "normal").conclusion,
        "complete-pass",
      );
    });
  }
});

test(
  "Windows diagnostic entry refuses the unsupported host before any browser or Docker launch",
  { skip: process.platform !== "win32" },
  () => {
    const result = spawnSync(
      process.execPath,
      [".github/diagnostics/quiet-save-run.mjs"],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Quiet experiment requires Ubuntu 24\.04/);
  },
);
