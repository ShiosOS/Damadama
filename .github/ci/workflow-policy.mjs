import { readFile } from "node:fs/promises";
import { gates, releaseCallables } from "./required-jobs.mjs";
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
        uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      },
      {
        uses: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
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

export function gateGraphErrors(workflows) {
  const errors = [];
  const expect = (condition, message) => {
    if (!condition) errors.push(message);
  };
  for (const [gate, { workflow: filename, needs }] of Object.entries(gates)) {
    const workflow = workflows[filename];
    const job = workflow?.jobs?.[gate];
    const location = `${filename}:jobs.${gate}`;
    expect(Boolean(job), `${location}: required gate is missing`);
    if (!job) continue;
    expect(
      job.name === undefined || job.name === gate,
      `${location}: check-run name must be ${gate}`,
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
      if (gate === "release-controls") {
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
    if (kind !== "core-leaf") continue;
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
