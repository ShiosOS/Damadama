import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSecurityContract,
  acceptedSecurityErrors,
} from "./security-policy.mjs";
import { gateGraphErrors } from "./workflow-policy.mjs";
import { exerciseBunAudit } from "./security-fixtures.mjs";
import { gates, releaseCallables, requireJobs } from "./required-jobs.mjs";
import { requireFreshCandidate } from "../../release/controller.mjs";
import { source, authority, jobs, run } from "../../release/fixtures.mjs";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflows = {};
for (const name of await readdir(join(root, ".github/workflows"))) {
  if (name.endsWith(".yml"))
    workflows[name] = Bun.YAML.parse(
      await readFile(join(root, ".github/workflows", name), "utf8"),
    );
}
const dependencies = (w) => w["security-dependencies.yml"].jobs;
const codeql = (w) => w["security-codeql.yml"].jobs;
const fixtures = (w) => w["security-fixtures.yml"].jobs;
const main = (w) => w["stage.yml"].jobs;
const rejected = (name, mutate, pattern) =>
  test(name, () => {
    const changed = structuredClone(workflows);
    mutate(changed);
    assert.ok(
      gateGraphErrors(changed).some((error) => pattern.test(error)),
      `${name}: expected ${pattern}; got ${gateGraphErrors(changed).join("\n")}`,
    );
  });

test("main native alias keeps the public check name and separate PR portfolio", () => {
  assert.deepEqual(gates["main-release-controls"], {
    workflow: "stage.yml",
    job: "release-controls",
    needs: ["security-codeql", "security-dependencies"],
  });
  const changed = structuredClone(workflows);
  main(changed)["release-controls"].name = "release-controls";
  for (const name of gates["main-release-controls"].needs)
    main(changed)[name].permissions = Object.fromEntries(
      Object.entries(main(changed)[name].permissions).reverse(),
    );
  main(changed).build.needs.reverse();
  main(changed).stage.needs.reverse();
  assert.deepEqual(gateGraphErrors(changed), []);
});

for (const name of gates["main-release-controls"].needs) {
  const caller = (w) => main(w)[name];
  for (const [label, mutate, pattern] of [
    [
      "missing caller",
      (w) => delete main(w)[name],
      /required prerequisite is missing/,
    ],
    [
      "missing edge",
      (w) =>
        main(w)["release-controls"].needs.splice(
          main(w)["release-controls"].needs.indexOf(name),
          1,
        ),
      /needs must be exactly/,
    ],
    [
      "wrong path",
      (w) => (caller(w).uses += "@main"),
      /wrong callable workflow/,
    ],
    [
      "PR path",
      (w) =>
        (caller(w).uses =
          "$/.github/workflows/" + releaseCallables[name].workflow),
      /wrong callable workflow/,
    ],
    [
      "conditional caller",
      (w) => (caller(w).if = "false"),
      /prerequisite must run unconditionally/,
    ],
    [
      "caller dependency",
      (w) => (caller(w).needs = "source"),
      /prerequisite must run unconditionally/,
    ],
    [
      "tolerated caller",
      (w) => (caller(w)["continue-on-error"] = true),
      /continue-on-error is forbidden/,
    ],
    [
      "matrix caller",
      (w) => (caller(w).strategy = { matrix: { duplicate: [1, 2] } }),
      /without a matrix/,
    ],
    [
      "caller input",
      (w) => (caller(w).with = { injected: true }),
      /no inputs or secrets/,
    ],
    [
      "caller secrets",
      (w) => (caller(w).secrets = "inherit"),
      /no inputs or secrets/,
    ],
    [
      "extra permission",
      (w) => (caller(w).permissions.issues = "write"),
      /permissions must match/,
    ],
    [
      "permission shorthand",
      (w) => (caller(w).permissions = "read-all"),
      /permissions must match/,
    ],
  ])
    rejected(`main ${name} ${label}`, mutate, pattern);
  for (const permission of Object.keys(releaseCallables[name].permissions)) {
    rejected(
      `main ${name} missing ${permission}`,
      (w) => delete caller(w).permissions[permission],
      /permissions must match/,
    );
    rejected(
      `main ${name} changed ${permission}`,
      (w) => (caller(w).permissions[permission] = "none"),
      /permissions must match/,
    );
  }
}
for (const [label, mutate, pattern] of [
  [
    "missing barrier",
    (w) => delete main(w)["release-controls"],
    /required gate is missing/,
  ],
  [
    "helper alias as native name",
    (w) => (main(w)["release-controls"].name = "main-release-controls"),
    /check-run name must be release-controls/,
  ],
  [
    "extra barrier edge",
    (w) => main(w)["release-controls"].needs.push("source"),
    /needs must be exactly/,
  ],
  [
    "missing always",
    (w) => delete main(w)["release-controls"].if,
    /if must be always/,
  ],
  [
    "check condition bypass",
    (w) => (main(w).check.if = "false"),
    /must check every application source/,
  ],
  [
    "check source dependency bypass",
    (w) => delete main(w).check.needs,
    /must check every application source/,
  ],
  [
    "conditional barrier",
    (w) => (main(w)["release-controls"].if = "success()"),
    /if must be always/,
  ],
  [
    "reusable barrier",
    (w) =>
      (main(w)["release-controls"].uses =
        "./.github/workflows/release-controls.yml"),
    /ordinary running job/,
  ],
  [
    "wrong helper",
    (w) =>
      (main(w)["release-controls"].steps.at(-1).run =
        "node .github/ci/required-jobs.mjs release-controls"),
    /exact needs result/,
  ],
  [
    "fabricated helper input",
    (w) => (main(w)["release-controls"].steps.at(-1).env.REQUIRED_JOBS = "{}"),
    /exact needs result/,
  ],
  [
    "conditional barrier setup",
    (w) => (main(w)["release-controls"].steps[0].if = "false"),
    /all barrier steps must run unconditionally/,
  ],
  [
    "duplicate suite elsewhere",
    (w) => main(w).check.steps.push({ run: "node --test release/*.test.mjs" }),
    /suite must run exactly once/,
  ],
])
  rejected(`main ${label}`, mutate, pattern);

for (const name of ["release-controls", "check"]) {
  rejected(
    `main ${name} tolerated job`,
    (w) => (main(w)[name]["continue-on-error"] = true),
    /native controller must run once without tolerated errors/,
  );
  rejected(
    `main ${name} matrix job`,
    (w) => (main(w)[name].strategy = { matrix: { duplicate: [1, 2] } }),
    /native controller must run once without tolerated errors/,
  );
}
for (const name of ["build", "stage"]) {
  for (const dependency of main(workflows)[name].needs)
    rejected(
      `main ${name} missing ${dependency} edge`,
      (w) =>
        (main(w)[name].needs = main(w)[name].needs.filter(
          (value) => value !== dependency,
        )),
      new RegExp(`jobs.${name}: needs must be exactly`),
    );
  rejected(
    `main ${name} extra edge`,
    (w) => main(w)[name].needs.push("security-codeql"),
    /needs must be exactly/,
  );
  rejected(
    `main ${name} duplicate edge`,
    (w) => main(w)[name].needs.push(main(w)[name].needs[0]),
    /needs must be exactly/,
  );
}
for (const [name, commands] of [
  [
    "release-controls",
    [
      "node --test release/*.test.mjs",
      "node .github/ci/required-jobs.mjs main-release-controls",
    ],
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
  for (const command of commands) {
    const selected = (w) =>
      main(w)[name].steps.find((step) => step.run === command);
    for (const [label, mutate] of [
      [
        "missing",
        (w) =>
          (main(w)[name].steps = main(w)[name].steps.filter(
            (step) => step.run !== command,
          )),
      ],
      [
        "duplicated",
        (w) => main(w)[name].steps.push(structuredClone(selected(w))),
      ],
      ["conditional", (w) => (selected(w).if = "false")],
      ["tolerated", (w) => (selected(w)["continue-on-error"] = true)],
      ["shell bypass", (w) => (selected(w).run += " || true")],
    ])
      rejected(
        `main ${name} ${label} ${command}`,
        mutate,
        /step must run once in order without bypass/,
      );
  }
  for (let index = 1; index < commands.length; index++)
    rejected(
      `main ${name} reversed command order ${index}`,
      (w) => {
        const steps = main(w)[name].steps;
        const before = steps.findIndex(
          (step) => step.run === commands[index - 1],
        );
        const after = steps.findIndex((step) => step.run === commands[index]);
        [steps[before], steps[after]] = [steps[after], steps[before]];
      },
      /step must run once in order without bypass/,
    );
}

const security = readSecurityContract(workflows);
const mandatory = [
  ...security.coverage.analysis.map(({ language }) => [
    "analysis-" + language,
    "security-codeql",
  ]),
  ...security.coverage.uploads.map((language) => [
    "upload-" + language,
    "security-codeql",
  ]),
  [security.bunAudit.argv.join(" "), "security-dependencies"],
];
for (const [leaf, callable] of mandatory)
  for (const result of ["failure", "skipped", "cancelled", undefined])
    test(`main controlled ${leaf} ${String(result)} fails helper and actual native admissions`, async () => {
      assert.deepEqual(gateGraphErrors(workflows), []);
      const needs = Object.fromEntries(
        gates["main-release-controls"].needs.map((name) => [
          name,
          { result: "success" },
        ]),
      );
      requireJobs("main-release-controls", needs);
      needs[callable].result = result;
      let barrier = "success";
      try {
        requireJobs("main-release-controls", needs);
      } catch (error) {
        assert.match(error.message, /result must be success/);
        barrier = "failure";
      }
      assert.equal(barrier, "failure");
      const environment = {
        GH_TOKEN: "synthetic",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: source.repository,
        GITHUB_SHA: source.commit,
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
      };
      const saved = Object.fromEntries(
        Object.keys(environment).map((key) => [key, process.env[key]]),
      );
      const originalFetch = globalThis.fetch;
      const current = jobs();
      current[0].conclusion = barrier;
      Object.assign(process.env, environment);
      globalThis.fetch = async (url) => {
        let value;
        if (url.includes("/git/ref/heads/main"))
          value = { object: { sha: source.commit } };
        else if (url.includes("/git/commits/"))
          value = { sha: source.commit, tree: { sha: source.tree } };
        else if (url.includes("/jobs?"))
          value = { total_count: current.length, jobs: current };
        else if (url.endsWith("/actions/runs/42")) value = run;
        else throw Error("unexpected controlled API request");
        return new Response(JSON.stringify(value));
      };
      try {
        await assert.rejects(
          requireFreshCandidate({ source, authority }),
          /CI release-controls/,
        );
      } finally {
        globalThis.fetch = originalFetch;
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      for (const operation of ["preflight", "production"]) {
        const directory = await mkdtemp(join(tmpdir(), "security-admission-"));
        try {
          const child = spawnSync(
            "node",
            [
              join(root, "release/test-fixtures/operation.mjs"),
              `${operation}-barrier-${barrier}`,
            ],
            { cwd: directory, encoding: "utf8" },
          );
          assert.equal(child.status, 1, child.stderr);
          assert.match(child.stderr, /CI release-controls/);
          for (const path of [
            "promotion-plan.json",
            "production.json",
            "events.jsonl",
          ])
            assert.equal(existsSync(join(directory, path)), false, path);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    });

test("real production contract has independent exact ordered inventories", () => {
  const actual = readSecurityContract(workflows);
  assert.deepEqual(acceptedSecurityErrors(actual), []);
  assert.deepEqual(gateGraphErrors(workflows), []);
  assert.deepEqual(actual.coverage, {
    analysis: [
      { language: "csharp", buildMode: "manual" },
      { language: "javascript-typescript", buildMode: "none" },
      { language: "actions", buildMode: "none" },
    ],
    uploads: ["csharp", "javascript-typescript", "actions"],
    detector: ["csharp", "javascript-typescript", "actions"],
  });
  assert.deepEqual(actual.bunAudit.argv, [
    "bun",
    "audit",
    "--audit-level",
    "high",
  ]);
  assert.equal(actual.dependencyReview.severity, "high");
  assert.deepEqual(actual.dependencyReview.scopes, [
    "runtime",
    "development",
    "unknown",
  ]);
  assert.equal(actual.dependencyReview.warnOnly, false);
});
test("object key order and coordinated different immutable refs are accepted without claiming remote availability", () => {
  const changed = structuredClone(workflows);
  const review = dependencies(changed)["dependency-review"].steps[1];
  review.uses = "actions/dependency-review-action@" + "a".repeat(40);
  fixtures(changed)["dependency-review"].steps[1].with.ref = "a".repeat(40);
  for (const job of [
    codeql(changed).analyze,
    codeql(changed).upload,
    fixtures(changed).codeql,
  ]) {
    for (const step of job.steps)
      if (step.uses?.startsWith("github/codeql-action/"))
        step.uses = step.uses.split("@")[0] + "@" + "b".repeat(40);
  }
  review.with = Object.fromEntries(Object.entries(review.with).reverse());
  assert.deepEqual(gateGraphErrors(changed), []);
});
rejected(
  "historical runtime-only review",
  (w) =>
    (dependencies(w)["dependency-review"].steps[1].with["fail-on-scopes"] =
      "runtime"),
  /dependency review/,
);
rejected(
  "historical critical-only audit",
  (w) =>
    (dependencies(w)["bun-audit"].steps[2].run =
      "bun audit --audit-level critical"),
  /Bun audit argv/,
);
rejected(
  "warn-only review",
  (w) =>
    (dependencies(w)["dependency-review"].steps[1].with["warn-only"] = true),
  /dependency review/,
);
rejected(
  "review stays PR-only",
  (w) => delete dependencies(w)["dependency-review"].if,
  /security-dependencies.yml:jobs.dependency-review/,
);
rejected(
  "new unsupported review behavior input",
  (w) =>
    (dependencies(w)["dependency-review"].steps[1].with["allow-ghsas"] =
      "GHSA-test"),
  /dependency-review.with/,
);
rejected(
  "review ref mismatch",
  (w) => (fixtures(w)["dependency-review"].steps[1].with.ref = "a".repeat(40)),
  /dependency-review.steps\[1\]/,
);
rejected(
  "CodeQL ref mismatch",
  (w) =>
    (fixtures(w).codeql.steps[2].uses =
      "github/codeql-action/init@" + "a".repeat(40)),
  /coordinated CodeQL init ref/,
);
for (const command of [
  "bun audit --audit-level high || true",
  "bun audit --audit-level high --production",
  "bun audit --audit-level ${{ vars.LEVEL }}",
  "echo ok\nbun audit --audit-level high",
  "bun audit --audit-level high; true",
  "bun audit --audit-level high | cat",
  "bun audit --audit-level $(echo high)",
]) {
  rejected(
    "unsupported audit shell " + command,
    (w) => (dependencies(w)["bun-audit"].steps[2].run = command),
    /use only bun audit/,
  );
}
for (const [name, select, axis, expected] of [
  ["analysis", (w) => codeql(w).analyze, "include", /analysis inventory/],
  ["upload", (w) => codeql(w).upload, "language", /isolated upload inventory/],
  ["detector", (w) => fixtures(w).codeql, "language", /detector inventory/],
]) {
  for (let index = 0; index < 3; index++)
    rejected(
      `${name} omits member ${index}`,
      (w) => select(w).strategy.matrix[axis].splice(index, 1),
      expected,
    );
  rejected(
    name + " duplicates a member",
    (w) =>
      select(w).strategy.matrix[axis].push(select(w).strategy.matrix[axis][0]),
    expected,
  );
  rejected(
    name + " reorders executable members",
    (w) => select(w).strategy.matrix[axis].reverse(),
    expected,
  );
  rejected(
    name + " excludes a member",
    (w) => (select(w).strategy.matrix.exclude = [{ language: "actions" }]),
    /strategy.matrix/,
  );
  rejected(
    name + " uses a dynamic matrix",
    (w) => (select(w).strategy.matrix = "${{ fromJSON(inputs.matrix) }}"),
    /strategy.matrix/,
  );
  rejected(
    name + " conditioned job",
    (w) => (select(w).if = "false"),
    /security-.*jobs/,
  );
  rejected(
    name + " tolerated job",
    (w) => (select(w)["continue-on-error"] = true),
    /security-.*jobs/,
  );
  const count = select(workflows).steps.length;
  for (let index = 0; index < count; index++) {
    rejected(
      `${name} omitted step ${index}`,
      (w) => select(w).steps.splice(index, 1),
      /steps cardinality/,
    );
    rejected(
      `${name} tolerated step ${index}`,
      (w) => (select(w).steps[index]["continue-on-error"] = true),
      /steps\[/,
    );
    rejected(
      `${name} conditioned step ${index}`,
      (w) => (select(w).steps[index].if = "false"),
      /steps\[/,
    );
  }
}
rejected(
  "coordinated narrowing cannot shrink independent accepted inventory",
  (w) => {
    codeql(w).analyze.strategy.matrix.include.pop();
    codeql(w).upload.strategy.matrix.language.pop();
    fixtures(w).codeql.strategy.matrix.language.pop();
  },
  /inventory/,
);
rejected(
  "upload detached from analysis",
  (w) => delete codeql(w).upload.needs,
  /jobs.upload/,
);
rejected(
  "analysis permission broadened",
  (w) => (codeql(w).analyze.permissions["security-events"] = "write"),
  /jobs.analyze/,
);
rejected(
  "unsafe detector upload enabled",
  (w) => (fixtures(w).codeql.steps[4].with.upload = "always"),
  /codeql.steps\[4\]/,
);
rejected(
  "safe artifact loses current attempt",
  (w) =>
    (codeql(w).analyze.steps[5].with.name =
      "security-codeql-sarif-${{ matrix.language }}"),
  /analyze.steps\[5\]/,
);
rejected(
  "artifact download uses different attempt",
  (w) =>
    (codeql(w).upload.steps[1].with.name =
      "security-codeql-sarif-${{ matrix.language }}-1"),
  /upload.steps\[1\]/,
);
rejected(
  "missing safe artifact tolerated",
  (w) => (codeql(w).analyze.steps[5].with["if-no-files-found"] = "warn"),
  /analyze.steps\[5\]/,
);
rejected(
  "detector assertion replaced by success",
  (w) => (fixtures(w).codeql.steps[5].run = "true"),
  /baseline detector program changed/,
);
rejected(
  "detector generator narrowed",
  (w) => (fixtures(w).codeql.steps[1].run += "\necho changed"),
  /baseline detector program changed/,
);
rejected(
  "detector checkout contaminates examples",
  (w) => fixtures(w).codeql.steps.unshift(codeql(w).analyze.steps[0]),
  /steps cardinality/,
);
for (const jobName of ["fixtures", "dependency-review"]) {
  rejected(
    jobName + " native fixture execution omitted",
    (w) => fixtures(w)[jobName].steps.pop(),
    /steps cardinality/,
  );
  rejected(
    jobName + " native fixture execution ignored",
    (w) => (fixtures(w)[jobName].steps.at(-1)["continue-on-error"] = true),
    /steps\[/,
  );
}
test("native Bun scenarios consume actual production argv and expose historical critical-only weakening", async () => {
  await exerciseBunAudit(readSecurityContract(workflows));
  const changed = structuredClone(workflows);
  dependencies(changed)["bun-audit"].steps[2].run =
    "bun audit --audit-level critical";
  const observed = readSecurityContract(changed);
  assert.deepEqual(observed.bunAudit.argv, [
    "bun",
    "audit",
    "--audit-level",
    "critical",
  ]);
  await assert.rejects(
    exerciseBunAudit(observed),
    /high runtime: unexpected exit 0/,
  );
}, 30_000);

for (const [language, rule, extension] of [
  ["csharp", "cs/path-injection", "cs"],
  ["javascript-typescript", "js/reflected-xss", "js"],
  ["actions", "actions/code-injection/critical", "yml"],
]) {
  test(
    language +
      " selected native SARIF assertion accepts unsafe-only and rejects missing unsafe or flagged safe",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "security-sarif-"));
      try {
        const script = fixtures(workflows)
          .codeql.steps[5].run.split("\n")
          .slice(1, -2)
          .join("\n");
        for (const scenario of [
          "valid",
          "missing-unsafe",
          "flagged-safe",
          "missing-sarif",
        ]) {
          const result = (uri) => ({
            ruleId: rule,
            locations: [{ physicalLocation: { artifactLocation: { uri } } }],
          });
          const results = [];
          if (scenario !== "missing-unsafe")
            results.push(result("Bad." + extension));
          if (scenario === "flagged-safe")
            results.push(result("Safe." + extension));
          const path = join(directory, "fixture.sarif");
          if (scenario === "missing-sarif") await rm(path);
          else await writeFile(path, JSON.stringify({ runs: [{ results }] }));
          const child = Bun.spawn(
            ["node", "--input-type=module", "-e", script],
            {
              env: { ...process.env, LANGUAGE: language, SARIF_DIR: directory },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const [stdout, stderr, exit] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          assert.equal(exit, scenario === "valid" ? 0 : 1, stdout + stderr);
          if (scenario === "valid")
            assert.match(stdout, /unsafe example found, safe example clear/);
          if (scenario === "missing-unsafe")
            assert.match(stderr, /missing unsafe example finding/);
          if (scenario === "flagged-safe")
            assert.match(stderr, /safe example was flagged/);
          if (scenario === "missing-sarif")
            assert.match(stderr, /CodeQL produced no SARIF file/);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
}
