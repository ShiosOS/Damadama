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
const rejected = (name, mutate, pattern) =>
  test(name, () => {
    const changed = structuredClone(workflows);
    mutate(changed);
    assert.ok(
      gateGraphErrors(changed).some((error) => pattern.test(error)),
      `${name}: expected ${pattern}; got ${gateGraphErrors(changed).join("\n")}`,
    );
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
