import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gates, releaseCallables } from "./required-jobs.mjs";
import {
  readSecurityContract,
  acceptedSecurityErrors,
} from "./security-policy.mjs";
const recipes = [
  [
    "check.yml",
    "workflow-lint",
    [
      { run: "bun .github/ci/workflow-lint.mjs" },
      { run: "bun .github/ci/workflow-lint.mjs --self-test" },
    ],
  ],
  [
    "check.yml",
    "diagnostics-policy",
    [
      {
        id: "policy",
        run: 'bun .github/diagnostics/artifact-policy.mjs prepare "${WORKFLOW}" "${RUNNER_TEMP}/diagnostics/source"',
      },
      {
        uses: "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
      },
      {
        uses: "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
      },
      {
        run: 'bun .github/diagnostics/artifact-policy.mjs verify "${WORKFLOW}" "${RUNNER_TEMP}/diagnostics/download"',
      },
    ],
  ],
  [
    "check.yml",
    "application",
    [
      {
        run: "bun run check",
        if: "steps.application.outputs.state == 'application'",
      },
    ],
  ],
  [
    "release-runtime-check.yml",
    "runtime-policy",
    [
      { run: "node --test release/*.test.mjs" },
      {
        run: "node --check release/operate.mjs && node --check release/smoke.mjs && node --check release/railway.mjs",
      },
    ],
  ],
  [
    "recovery-check.yml",
    "recovery",
    [
      {
        run: "docker build --platform linux/amd64 --file ops/recovery/Dockerfile --tag damadama-recovery-proof .",
      },
      { run: "node ops/recovery/prove.mjs > recovery-check.log 2>&1" },
    ],
  ],
  [
    "pr-evidence.yml",
    "evidence",
    [
      {
        uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      },
    ],
  ],
];

const preflightProof = {
  name: "Read-only release preflight proof",
  on: {
    workflow_dispatch: {
      inputs: {
        staging_run_id: {
          description: "Successful trusted staging run ID",
          type: "string",
          required: true,
        },
        version: {
          description: "Proof version such as v0.0.0-preflight-proof",
          type: "string",
          required: true,
        },
        notes: {
          description: "Short proof notes",
          type: "string",
          required: true,
        },
        recovery: {
          description: "Recovery evidence JSON from the release runbook",
          type: "string",
          required: true,
        },
      },
    },
  },
  permissions: { contents: "read", actions: "read", packages: "read" },
  jobs: {
    "preflight-proof": {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
      steps: [
        {
          id: "checkout",
          uses: "actions/checkout",
          with: {
            ref: "${{ github.sha }}",
            path: "controls",
            "persist-credentials": false,
          },
        },
        {
          id: "node",
          uses: "actions/setup-node",
          with: { "node-version": 24, "package-manager-cache": false },
        },
        {
          id: "install",
          run: "node controls/release/supply-install.mjs verifier",
        },
        {
          id: "preflight",
          shell: "bash",
          run: "a4d060bc7368c62be6d7d63e870f5a2a0d31f40fdecb80aee398dabd5085e379",
          env: {
            GH_TOKEN: "${{ github.token }}",
            GITHUB_TOKEN: "${{ github.token }}",
            STAGING_RUN_ID: "${{ inputs.staging_run_id }}",
            RELEASE_VERSION: "${{ inputs.version }}",
            RELEASE_NOTES: "${{ inputs.notes }}",
            RECOVERY_EVIDENCE: "${{ inputs.recovery }}",
          },
        },
        {
          id: "evidence",
          if: "always()",
          shell: "bash",
          run: "3ba6955b737bec4285e6fd8069c4132dc68fd6125d723e4639ad951ef1a95786",
          env: {
            CHECKOUT_OUTCOME: "${{ steps.checkout.outcome }}",
            NODE_OUTCOME: "${{ steps.node.outcome }}",
            INSTALL_OUTCOME: "${{ steps.install.outcome }}",
            PREFLIGHT_OUTCOME: "${{ steps.preflight.outcome }}",
          },
        },
        {
          uses: "actions/upload-artifact",
          if: "always()",
          with: {
            name: "preflight-proof-${{ github.run_id }}-${{ github.run_attempt }}",
            path: "preflight-proof.json",
            "retention-days": 7,
            "if-no-files-found": "error",
          },
        },
      ],
    },
  },
};

function preflightProofErrors(workflow) {
  const observed = structuredClone(workflow);
  const errors = [];
  for (const [index, step] of (
    observed?.jobs?.["preflight-proof"]?.steps ?? []
  ).entries()) {
    if (typeof step.uses === "string") {
      const action = step.uses.match(
        /^(actions\/(?:checkout|setup-node|upload-artifact))@[a-fA-F0-9]{40}$/,
      );
      if (action && action[0] === step.uses) step.uses = action[1];
      else
        errors.push(
          `release-preflight-proof.yml.jobs.preflight-proof.steps.${index}.uses: must match an approved action with a full immutable SHA`,
        );
    }
    if (
      ["preflight", "evidence"].includes(step.id) &&
      typeof step.run === "string"
    )
      step.run = createHash("sha256").update(step.run).digest("hex");
  }
  function compare(expected, actual, path) {
    if (expected !== null && typeof expected === "object") {
      if (
        actual === null ||
        typeof actual !== "object" ||
        Array.isArray(actual) !== Array.isArray(expected)
      ) {
        errors.push(path + ": must match the read-only preflight proof shape");
        return;
      }
      for (const key of new Set([
        ...Object.keys(expected),
        ...Object.keys(actual),
      ])) {
        if (!Object.hasOwn(expected, key))
          errors.push(
            path + "." + key + ": forbidden in read-only preflight proof",
          );
        else compare(expected[key], actual[key], path + "." + key);
      }
    } else if (actual !== expected)
      errors.push(
        path + ": must match the fixed read-only preflight proof contract",
      );
  }
  compare(preflightProof, observed, "release-preflight-proof.yml");
  return errors;
}

function setupNodeCohortErrors(workflows) {
  const refs = new Map();
  for (const [filename, workflow] of Object.entries(workflows)) {
    for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
      for (const [index, step] of (definition.steps ?? []).entries()) {
        if (!step.uses?.startsWith("actions/setup-node@")) continue;
        const ref = step.uses.slice("actions/setup-node@".length);
        if (!refs.has(ref)) refs.set(ref, []);
        refs.get(ref).push(`${filename}:jobs.${job}.steps[${index}]`);
      }
    }
  }
  if (refs.size <= 1) return [];
  const locations = [...refs]
    .map(([ref, sites]) => `${ref}: ${sites.join(", ")}`)
    .join("; ");
  return [
    `Direct actions/setup-node calls use multiple refs. Choose one reviewed full SHA and update every direct setup-node call together, including new jobs. ${locations}`,
  ];
}

export function gateGraphErrors(workflows) {
  const errors = preflightProofErrors(workflows["release-preflight-proof.yml"]);
  errors.push(...setupNodeCohortErrors(workflows));
  try {
    errors.push(...acceptedSecurityErrors(readSecurityContract(workflows)));
  } catch (error) {
    errors.push(error.message);
  }
  const expect = (condition, message) => {
    if (!condition) errors.push(message);
  };
  for (const [gate, contract] of Object.entries(gates)) {
    const { workflow: filename, needs } = contract;
    const nativeJob = contract.job ?? gate;
    const workflow = workflows[filename];
    const job = workflow?.jobs?.[nativeJob];
    const location = `${filename}:jobs.${nativeJob}`;
    expect(Boolean(job), `${location}: required gate is missing`);
    if (!job) continue;
    expect(
      job.name === undefined || job.name === nativeJob,
      `${location}: check-run name must be ${nativeJob}`,
    );
    const actual = Array.isArray(job.needs)
      ? job.needs
      : [job.needs].filter(Boolean);
    expect(
      actual.length === needs.length &&
        needs.every((name) => actual.includes(name)),
      `${location}: needs must be exactly [${needs.join(", ")}]`,
    );
    expect(job.if === "always()", `${location}: if must be always()`);
    expect(
      Boolean(job["runs-on"] && job.steps?.length) && !job.uses,
      `${location}: must be an ordinary running job`,
    );
    expect(
      job["continue-on-error"] === undefined,
      `${location}: continue-on-error is forbidden`,
    );
    expect(
      job.steps?.every((step) => step["continue-on-error"] === undefined),
      `${location}: steps cannot continue on error`,
    );
    expect(
      job.steps?.some(
        (step) =>
          step.run === `node .github/ci/required-jobs.mjs ${gate}` &&
          step.env?.REQUIRED_JOBS === "${{ toJSON(needs) }}" &&
          step.if === undefined,
      ),
      `${location}: must evaluate the exact needs result`,
    );
    for (const name of needs) {
      const dependency = workflow.jobs[name];
      expect(
        Boolean(dependency),
        `${filename}:jobs.${name}: required prerequisite is missing`,
      );
      if (!dependency) continue;
      expect(
        dependency.if === undefined && dependency.needs === undefined,
        `${filename}:jobs.${name}: prerequisite must run unconditionally`,
      );
      expect(
        dependency["continue-on-error"] === undefined,
        `${filename}:jobs.${name}: continue-on-error is forbidden`,
      );
      expect(
        dependency.steps?.every(
          (step) => step["continue-on-error"] === undefined,
        ) ?? true,
        `${filename}:jobs.${name}: steps cannot continue on error`,
      );
      if (gate === "release-controls" || gate === "main-release-controls") {
        const callable = releaseCallables[name];
        expect(
          dependency.uses === `$/.github/workflows/${callable.workflow}`,
          `${filename}:jobs.${name}: wrong callable workflow`,
        );
        expect(
          dependency.with === undefined && dependency.secrets === undefined,
          `${filename}:jobs.${name}: callable contract has no inputs or secrets`,
        );
        expect(
          dependency.strategy === undefined,
          `${filename}:jobs.${name}: callable must run once without a matrix`,
        );
        expect(
          Boolean(dependency.permissions) &&
            typeof dependency.permissions === "object" &&
            !Array.isArray(dependency.permissions) &&
            Object.keys(dependency.permissions).length ===
              Object.keys(callable.permissions).length &&
            Object.entries(callable.permissions).every(
              ([key, value]) => dependency.permissions[key] === value,
            ),
          `${filename}:jobs.${name}: permissions must match the callable contract`,
        );
      }
    }
  }

  const release = workflows["release-controls.yml"];
  const check = workflows["check.yml"];
  expect(
    Object.keys(release?.jobs ?? {}).length ===
      Object.keys(releaseCallables).length + 1 &&
      Object.keys(release?.jobs ?? {}).every(
        (name) =>
          name === "release-controls" || Object.hasOwn(releaseCallables, name),
      ),
    "release-controls.yml: jobs must be exactly the callable prerequisites and native gate",
  );
  expect(
    Boolean(check?.on && Object.hasOwn(check.on, "pull_request")) &&
      !Object.keys(check.on).some((name) => name !== "pull_request") &&
      !["branches", "branches-ignore", "paths", "paths-ignore"].some((name) =>
        Object.hasOwn(check.on.pull_request ?? {}, name),
      ),
    "check.yml: pull_request must cover every branch and path",
  );
  const pull = release?.on?.pull_request;
  expect(
    Boolean(pull) &&
      !["branches", "branches-ignore", "paths", "paths-ignore"].some((name) =>
        Object.hasOwn(pull, name),
      ),
    "release-controls.yml: pull_request must cover every branch and path",
  );
  expect(
    ["opened", "reopened", "synchronize", "edited"].every((type) =>
      pull?.types?.includes(type),
    ),
    "release-controls.yml: pull_request must rerun on edits and head changes",
  );
  expect(
    release?.jobs?.["release-controls"]?.permissions?.contents === "read",
    "release-controls.yml:jobs.release-controls: needs contents: read",
  );
  for (const [jobName, { workflow: filename, kind }] of Object.entries(
    releaseCallables,
  )) {
    const leaf = workflows[filename];
    expect(
      Boolean(leaf?.on && Object.hasOwn(leaf.on, "workflow_call")),
      `${filename}: must support workflow_call`,
    );
    expect(
      leaf?.on?.workflow_call?.inputs === undefined &&
        leaf?.on?.workflow_call?.secrets === undefined &&
        leaf?.on?.workflow_call?.outputs === undefined,
      `${filename}: workflow_call contract has no inputs, secrets or outputs`,
    );
    if (kind === "security") {
      expect(
        !Object.hasOwn(leaf?.on ?? {}, "pull_request"),
        `${filename}: PR execution must use release-controls`,
      );
      continue;
    }
    expect(
      Object.keys(leaf?.on ?? {}).length === 1,
      `${filename}: must be workflow_call only`,
    );
    const job = leaf?.jobs?.[jobName];
    expect(
      Boolean(job) && job.if === undefined && job.needs === undefined,
      `${filename}:jobs.${jobName}: must run unconditionally`,
    );
    expect(
      job?.["continue-on-error"] === undefined,
      `${filename}:jobs.${jobName}: continue-on-error is forbidden`,
    );
    expect(
      job?.steps?.every((step) => step["continue-on-error"] === undefined),
      `${filename}:jobs.${jobName}: steps cannot continue on error`,
    );
  }
  for (const [filename, jobName, required] of recipes) {
    const steps = workflows[filename]?.jobs?.[jobName]?.steps ?? [];
    for (const recipe of required) {
      const matches = steps.filter(
        (step) =>
          step.if === recipe.if &&
          Object.entries(recipe).every(([key, value]) => step[key] === value),
      );
      expect(
        matches.length === 1 && matches[0]["continue-on-error"] === undefined,
        `${filename}:jobs.${jobName}: required ${recipe.run ?? recipe.uses} step must run once without bypass`,
      );
    }
  }
  for (const jobName of ["workflow-lint", "diagnostics-policy"]) {
    expect(
      check?.jobs?.[jobName]?.steps?.every(
        (step) =>
          step.if === undefined && step["continue-on-error"] === undefined,
      ),
      `check.yml:jobs.${jobName}: all validation steps must run unconditionally`,
    );
  }
  const evidenceScript = workflows[
    "pr-evidence.yml"
  ]?.jobs?.evidence?.steps?.find((step) =>
    step.uses?.startsWith("actions/github-script@"),
  )?.with?.script;
  expect(
    typeof evidenceScript === "string" &&
      evidenceScript.includes("context.payload.pull_request.head.sha") &&
      evidenceScript.includes("core.setFailed"),
    "pr-evidence.yml: evidence script must validate the current head",
  );
  const recoveryUpload = workflows[
    "recovery-check.yml"
  ]?.jobs?.recovery?.steps?.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  expect(
    recoveryUpload?.if === "failure()" &&
      recoveryUpload.with?.["include-hidden-files"] === true &&
      [
        "recovery-check.log",
        ".audit/recovery-proof-*/result.json",
        "!**/*token*",
        "!**/.env*",
        "!**/storage-state*.json",
        "!**/.auth/**",
      ].every((path) => recoveryUpload.with.path.includes(path)),
    "recovery-check.yml: failure upload must include safe hidden recovery proof",
  );
  const suite = "node --test release/*.test.mjs";
  const prSuiteCount = [
    "check.yml",
    "release-controls.yml",
    ...Object.values(releaseCallables).map((callable) => callable.workflow),
  ]
    .flatMap((filename) => Object.values(workflows[filename]?.jobs ?? {}))
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.run === suite).length;
  expect(
    prSuiteCount === 1,
    "release runtime suite must run exactly once per PR in runtime-policy",
  );
  const stage = workflows["stage.yml"]?.jobs;
  for (const name of ["release-controls", "check"]) {
    expect(
      Boolean(stage?.[name]?.["runs-on"] && stage[name].steps?.length) &&
        !stage[name].uses &&
        (stage[name].name === undefined || stage[name].name === name),
      `stage.yml:jobs.${name}: preserve native controller job`,
    );
    expect(
      stage?.[name]?.["continue-on-error"] === undefined &&
        stage?.[name]?.strategy === undefined,
      `stage.yml:jobs.${name}: native controller must run once without tolerated errors`,
    );
  }
  for (const [name, needs] of [
    ["build", ["source", "release-controls", "check"]],
    ["stage", ["build", "verify"]],
  ]) {
    const actual = stage?.[name]?.needs;
    expect(
      Array.isArray(actual) &&
        actual.length === needs.length &&
        needs.every((dependency) => actual.includes(dependency)),
      `stage.yml:jobs.${name}: needs must be exactly [${needs.join(", ")}]`,
    );
  }
  expect(
    stage?.check?.needs === "source" &&
      stage.check.if === "needs.source.outputs.state == 'application'",
    "stage.yml:jobs.check: must check every application source",
  );
  const mainSuiteCount = Object.values(stage ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.run === suite).length;
  expect(
    mainSuiteCount === 1,
    "stage.yml: release runtime suite must run exactly once",
  );
  expect(
    stage?.["release-controls"]?.steps?.every((step) => step.if === undefined),
    "stage.yml:jobs.release-controls: all barrier steps must run unconditionally",
  );
  for (const [name, commands] of [
    [
      "release-controls",
      [suite, "node .github/ci/required-jobs.mjs main-release-controls"],
    ],
    [
      "check",
      [
        "bun install --frozen-lockfile",
        "bun .github/ci/workflow-lint.mjs",
        "node node_modules/@playwright/test/cli.js install --with-deps chromium",
        "bun run check",
      ],
    ],
  ]) {
    const steps = stage?.[name]?.steps ?? [];
    let previous = -1;
    for (const command of commands) {
      const matches = steps.filter((step) => step.run === command);
      const index = steps.findIndex((step) => step.run === command);
      expect(
        matches.length === 1 &&
          matches[0].if === undefined &&
          matches[0]["continue-on-error"] === undefined &&
          index > previous,
        `stage.yml:jobs.${name}: required ${command} step must run once in order without bypass`,
      );
      previous = index;
    }
  }
  return errors;
}

export async function queueErrors(files) {
  const errors = [];
  for (const file of files) {
    const workflow = Bun.YAML.parse(await readFile(file, "utf8"));
    const scopes = [["workflow", workflow?.concurrency]];
    for (const [job, definition] of Object.entries(workflow?.jobs ?? {})) {
      scopes.push([`jobs.${job}`, definition?.concurrency]);
    }
    for (const [scope, concurrency] of scopes) {
      if (concurrency?.queue === undefined) continue;
      const location = `${file}:${scope}.concurrency`;
      if (concurrency.queue !== "max") {
        errors.push(`${location}: queue must be "max"`);
      }
      if (
        concurrency["cancel-in-progress"] !== undefined &&
        concurrency["cancel-in-progress"] !== false
      ) {
        errors.push(
          `${location}: queue requires cancel-in-progress: false or omitted`,
        );
      }
    }
  }
  return errors;
}
