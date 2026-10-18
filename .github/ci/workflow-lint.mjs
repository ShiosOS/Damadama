import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import { arch, platform } from "node:process";
import { join, resolve } from "node:path";
import { gateGraphErrors, queueErrors } from "./workflow-policy.mjs";
import { releaseCallables } from "./required-jobs.mjs";
import { verifyReceiverWorkflow } from "./receiver-conformance.mjs";
import { verifyMonitorWorkflow } from "./monitor-conformance.mjs";

const root = resolve(import.meta.dir, "../..");
const toolsDirectory = join(root, ".audit", "workflow-tools");
const fixturesDirectory = join(import.meta.dir, "fixtures");
const platformKey = `${platform}-${arch}`;
const callableFilenames = Object.values(releaseCallables)
  .map(({ workflow }) => workflow.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const actionlintSelfRepositoryCompatibility = `reusable workflow call "\\$/\\.github/workflows/(${callableFilenames})" at "uses" is not following the format`;
const releases = {
  actionlint: {
    version: "1.7.12",
    owner: "rhysd/actionlint",
    assets: {
      "win32-x64": {
        file: "actionlint_1.7.12_windows_amd64.zip",
        sha256:
          "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9",
      },
      "linux-x64": {
        file: "actionlint_1.7.12_linux_amd64.tar.gz",
        sha256:
          "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
      },
    },
  },
  zizmor: {
    version: "1.31.1",
    owner: "zizmorcore/zizmor",
    assets: {
      "win32-x64": {
        file: "zizmor-x86_64-pc-windows-msvc.zip",
        sha256:
          "4de30371c8a3b483aecbcf0dec1fd6a2b6aae65051ca226b4f6527baac6a8c7a",
      },
      "linux-x64": {
        file: "zizmor-x86_64-unknown-linux-gnu.tar.gz",
        sha256:
          "d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99",
      },
    },
  },
};

function run(command, args) {
  const result = Bun.spawnSync([command, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

async function install(name) {
  const release = releases[name];
  const asset = release.assets[platformKey];
  if (!asset) {
    throw new Error(`Unsupported workflow lint platform: ${platformKey}`);
  }

  const archive = join(toolsDirectory, asset.file);
  await mkdir(toolsDirectory, { recursive: true });
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const url = `https://github.com/${release.owner}/releases/download/v${release.version}/${asset.file}`;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Cannot download ${name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    const downloaded = `${archive}.download`;
    await Bun.write(downloaded, bytes);
    await rename(downloaded, archive);
  }

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== asset.sha256) {
    throw new Error(
      `${name} archive SHA-256 mismatch: expected ${asset.sha256}, got ${actual}`,
    );
  }

  const directory = join(toolsDirectory, name);
  await mkdir(directory, { recursive: true });
  const extraction = run("tar", ["-xf", archive, "-C", directory]);
  if (extraction.code !== 0)
    throw new Error(`${name} extraction failed: ${extraction.output}`);
  return join(directory, `${name}${platform === "win32" ? ".exe" : ""}`);
}

function expectFailure(label, result, pattern) {
  if (result.code === 0 || !pattern.test(result.output)) {
    throw new Error(`${label} did not fail as expected:\n${result.output}`);
  }
}

async function selfTest(actionlint, zizmor) {
  for (const [runtime, args] of [
    [process.execPath, ["test", "./.github/ci/security-policy.test.mjs"]],
  ]) {
    const result = run(runtime, args);
    if (result.code !== 0) throw new Error(result.output);
  }
  const fixture = (name) => join(fixturesDirectory, `${name}.yml`);
  const valid = fixture("valid-queue");
  const validActionlint = run(actionlint, ["-oneline", valid]);
  const validZizmor = run(zizmor, ["--no-online-audits", valid]);
  const validQueue = await queueErrors([valid]);
  if (
    validActionlint.code !== 0 ||
    validZizmor.code !== 0 ||
    validQueue.length
  ) {
    throw new Error(
      `Valid queue fixture failed:\n${validActionlint.output}${validZizmor.output}${validQueue.join("\n")}`,
    );
  }

  expectFailure(
    "actionlint syntax",
    run(actionlint, ["-oneline", fixture("invalid-actionlint")]),
    /unexpected key "bogus".*\[syntax-check\]/,
  );
  expectFailure(
    "zizmor unpinned action",
    run(zizmor, ["--no-online-audits", fixture("invalid-zizmor")]),
    /error\[unpinned-uses\]/,
  );

  const invalidQueue = await queueErrors([fixture("invalid-queue")]);
  if (!invalidQueue.some((error) => error.includes('queue must be "max"'))) {
    throw new Error(`Invalid queue value passed: ${invalidQueue.join("\n")}`);
  }
  const invalidPair = await queueErrors([fixture("invalid-queue-cancel")]);
  if (
    !invalidPair.some((error) =>
      error.includes("queue requires cancel-in-progress"),
    )
  ) {
    throw new Error(
      `Invalid queue/cancel pairing passed: ${invalidPair.join("\n")}`,
    );
  }
  const invalidExpression = await queueErrors([
    fixture("invalid-queue-expression"),
  ]);
  if (
    !invalidExpression.some((error) =>
      error.includes("queue requires cancel-in-progress"),
    )
  ) {
    throw new Error(
      `Invalid queue/cancel expression passed: ${invalidExpression.join("\n")}`,
    );
  }
  const workflows = await loadWorkflows();
  await verifyReceiverWorkflow(workflows["ops-request-errors.yml"], root);
  await verifyMonitorWorkflow(workflows["ops-monitor.yml"], root);
  const validGraph = gateGraphErrors(workflows);
  if (validGraph.length)
    throw new Error(`Real gate graph failed: ${validGraph.join("\n")}`);
  function rejectMutation(label, mutate, pattern) {
    const changed = structuredClone(workflows);
    mutate(changed);
    if (!gateGraphErrors(changed).some((error) => pattern.test(error))) {
      throw new Error(`${label} passed gate graph validation`);
    }
  }
  for (const [name, callable] of Object.entries(releaseCallables)) {
    const caller = (graph) => graph["release-controls.yml"].jobs[name];
    for (const [label, mutate, pattern] of [
      [
        "missing caller",
        (graph) => delete graph["release-controls.yml"].jobs[name],
        /required prerequisite is missing/,
      ],
      [
        "missing edge",
        (graph) => {
          const job = graph["release-controls.yml"].jobs["release-controls"];
          job.needs = job.needs.filter((key) => key !== name);
        },
        /needs must be exactly/,
      ],
      [
        "wrong path",
        (graph) => (caller(graph).uses += "@main"),
        /wrong callable workflow/,
      ],
      [
        "conditional caller",
        (graph) => (caller(graph).if = "false"),
        /prerequisite must run unconditionally/,
      ],
      [
        "caller dependency",
        (graph) => (caller(graph).needs = "other"),
        /prerequisite must run unconditionally/,
      ],
      [
        "tolerant caller",
        (graph) => (caller(graph)["continue-on-error"] = true),
        /continue-on-error is forbidden/,
      ],
      [
        "matrix caller",
        (graph) => (caller(graph).strategy = { matrix: { duplicate: [1, 2] } }),
        /without a matrix/,
      ],
      [
        "caller input",
        (graph) => (caller(graph).with = { injected: true }),
        /no inputs or secrets/,
      ],
      [
        "caller secrets",
        (graph) => (caller(graph).secrets = "inherit"),
        /no inputs or secrets/,
      ],
      [
        "extra permission",
        (graph) => (caller(graph).permissions.issues = "write"),
        /permissions must match/,
      ],
      [
        "permission shorthand",
        (graph) => (caller(graph).permissions = "read-all"),
        /permissions must match/,
      ],
      [
        "missing callable event",
        (graph) => delete graph[callable.workflow].on.workflow_call,
        /must support workflow_call/,
      ],
    ]) {
      rejectMutation(`${name}: ${label}`, mutate, pattern);
    }
    for (const permission of Object.keys(callable.permissions)) {
      rejectMutation(
        `${name}: missing ${permission}`,
        (graph) => {
          delete caller(graph).permissions[permission];
        },
        /permissions must match/,
      );
      rejectMutation(
        `${name}: changed ${permission}`,
        (graph) => {
          caller(graph).permissions[permission] = "none";
        },
        /permissions must match/,
      );
    }
    for (const field of ["inputs", "secrets", "outputs"]) {
      rejectMutation(
        `${name}: declared ${field}`,
        (graph) => {
          graph[callable.workflow].on.workflow_call = {
            [field]: { injected: {} },
          };
        },
        /workflow_call contract has no inputs, secrets or outputs/,
      );
    }
  }
  for (const { workflow, kind } of Object.values(releaseCallables)) {
    if (kind !== "security") continue;
    rejectMutation(
      `${workflow}: duplicate PR trigger`,
      (graph) => {
        graph[workflow].on.pull_request = {};
      },
      /PR execution must use release-controls/,
    );
  }
  for (const filename of ["check.yml", "release-controls.yml"]) {
    for (const filter of [
      "branches",
      "branches-ignore",
      "paths",
      "paths-ignore",
    ]) {
      const changed = structuredClone(workflows);
      changed[filename].on.pull_request ??= {};
      changed[filename].on.pull_request[filter] = ["main"];
      if (
        !gateGraphErrors(changed).some(
          (error) =>
            error ===
            `${filename}: pull_request must cover every branch and path`,
        )
      ) {
        throw new Error(`${filename} ${filter} passed gate graph validation`);
      }
    }
  }
  for (const [label, mutate, pattern] of [
    [
      "missing edge",
      (graph) => graph["check.yml"].jobs.check.needs.pop(),
      /needs must be exactly/,
    ],
    [
      "missing always",
      (graph) =>
        delete graph["release-controls.yml"].jobs["release-controls"].if,
      /if must be always/,
    ],
    [
      "renamed check",
      (graph) => (graph["check.yml"].jobs.check.name = "other-check"),
      /check-run name must be check/,
    ],
    [
      "continue-on-error",
      (graph) =>
        (graph["release-controls.yml"].jobs.recovery["continue-on-error"] =
          true),
      /continue-on-error is forbidden/,
    ],
    [
      "filtered check trigger",
      (graph) => (graph["check.yml"].on.pull_request = { paths: ["web/**"] }),
      /pull_request must cover every branch and path/,
    ],
    [
      "conditional suite",
      (graph) =>
        (graph["release-runtime-check.yml"].jobs["runtime-policy"].steps.find(
          (step) => step.run === "node --test release/*.test.mjs",
        ).if = "false"),
      /required node --test release\/\*\.test\.mjs step must run once without bypass/,
    ],
    [
      "wrong callable",
      (graph) =>
        (graph["release-controls.yml"].jobs.evidence.uses =
          "$/.github/workflows/unknown.yml"),
      /wrong callable workflow/,
    ],
    [
      "ref suffix",
      (graph) => (graph["release-controls.yml"].jobs.evidence.uses += "@main"),
      /wrong callable workflow/,
    ],
    [
      "unreviewed callable inputs",
      (graph) =>
        (graph["release-controls.yml"].jobs.evidence.with = { changed: true }),
      /callable contract has no inputs or secrets/,
    ],
  ]) {
    const changed = structuredClone(workflows);
    mutate(changed);
    if (!gateGraphErrors(changed).some((error) => pattern.test(error))) {
      throw new Error(`${label} passed gate graph validation`);
    }
  }
  expectFailure(
    "pinned actionlint self-repository compatibility",
    run(actionlint, [
      "-oneline",
      join(root, ".github", "workflows", "release-controls.yml"),
    ]),
    /reusable workflow call "\$\/\.github\/workflows\//,
  );
  expectFailure(
    "actionlint still rejects unrelated syntax with compatibility ignore",
    run(actionlint, [
      "-oneline",
      "-ignore",
      actionlintSelfRepositoryCompatibility,
      fixture("invalid-actionlint"),
    ]),
    /unexpected key "bogus".*\[syntax-check\]/,
  );
  const compatibilityDirectory = await mkdtemp(
    join(toolsDirectory, "compatibility-"),
  );
  for (const [index, target] of [
    "unknown.yml",
    "security-codeql-extra.yml",
    "security-codeql.yaml",
  ].entries()) {
    const filename = join(compatibilityDirectory, `${index}.yml`);
    await Bun.write(
      filename,
      `name: Invalid local call\non: pull_request\npermissions:\n  contents: read\njobs:\n  call:\n    uses: $/.github/workflows/${target}\n`,
    );
    expectFailure(
      `actionlint rejects unregistered target ${target}`,
      run(actionlint, [
        "-oneline",
        "-ignore",
        actionlintSelfRepositoryCompatibility,
        filename,
      ]),
      /reusable workflow call.*not following the format/,
    );
  }
  console.log(
    "Workflow lint self-test passed: actionlint, zizmor, queue policy, and gate graph rejected their negative fixtures.",
  );
}

async function loadWorkflows() {
  const directory = join(root, ".github", "workflows");
  const entries = await readdir(directory);
  return Object.fromEntries(
    await Promise.all(
      entries
        .filter((file) => /\.ya?ml$/.test(file))
        .map(async (file) => [
          file,
          Bun.YAML.parse(await readFile(join(directory, file), "utf8")),
        ]),
    ),
  );
}

const [actionlint, zizmor] = await Promise.all([
  install("actionlint"),
  install("zizmor"),
]);
if (process.argv[2] === "--self-test") {
  await selfTest(actionlint, zizmor);
} else if (process.argv.length === 2) {
  const directory = join(root, ".github", "workflows");
  const files = (await readdir(directory))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => join(directory, file));
  const actionlintResult = run(actionlint, [
    "-oneline",
    "-ignore",
    actionlintSelfRepositoryCompatibility,
    ...files,
  ]);
  const zizmorResult = run(zizmor, ["--no-online-audits", directory]);
  const policyErrors = [
    ...(await queueErrors(files)),
    ...gateGraphErrors(await loadWorkflows()),
  ];
  if (
    actionlintResult.code !== 0 ||
    zizmorResult.code !== 0 ||
    policyErrors.length
  ) {
    throw new Error(
      `${actionlintResult.output}${zizmorResult.output}${policyErrors.join("\n")}`,
    );
  }
  console.log(
    `Workflow lint passed (${files.length} workflows; actionlint ${releases.actionlint.version}, zizmor ${releases.zizmor.version}).`,
  );
} else {
  throw new Error("Usage: bun .github/ci/workflow-lint.mjs [--self-test]");
}
