import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

/**
 * @typedef {object} SecurityContract
 * @property {{ref: string, severity: string, scopes: string[], warnOnly: boolean}} dependencyReview
 * @property {{argv: string[]}} bunAudit
 * @property {{analysis: {language: string, buildMode: string}[], uploads: string[], detector: string[]}} coverage
 */

const accepted = {
  dependencyReview: {
    severity: "high",
    scopes: ["runtime", "development", "unknown"],
    warnOnly: false,
  },
  bunAudit: { argv: ["bun", "audit", "--audit-level", "high"] },
  coverage: {
    analysis: [
      { language: "csharp", buildMode: "manual" },
      { language: "javascript-typescript", buildMode: "none" },
      { language: "actions", buildMode: "none" },
    ],
    uploads: ["csharp", "javascript-typescript", "actions"],
    detector: ["csharp", "javascript-typescript", "actions"],
  },
};
const severities = ["low", "moderate", "high", "critical"];
const languages = ["csharp", "javascript-typescript", "actions"];
const language = "${{ matrix.language }}";
const attemptArtifact =
  "security-codeql-sarif-${{ matrix.language }}-${{ github.run_attempt }}";
const analysisPath =
  "${{ runner.temp }}/security-codeql/${{ matrix.language }}";
const csharp = "matrix.language == 'csharp'";

function equal(actual, expected, location) {
  assert.ok(
    isDeepStrictEqual(actual, expected),
    `${location}: expected ${JSON.stringify(expected)}`,
  );
}
function keys(value, expected, location) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${location}: expected mapping`,
  );
  equal(Object.keys(value).sort(), [...expected].sort(), location);
}
function step(actual, expected, location) {
  assert.ok(actual && typeof actual === "object", `${location}: missing step`);
  const { name, ...execution } = actual;
  equal(execution, expected, location);
}
function action(actual, repository, inputs, location, condition) {
  assert.equal(
    typeof actual?.uses,
    "string",
    `${location}: missing ${repository}`,
  );
  const prefix = repository + "@";
  assert.ok(
    actual.uses.startsWith(prefix),
    `${location}: expected ${repository}`,
  );
  const ref = actual.uses.slice(prefix.length);
  assert.match(
    ref,
    /^[a-f0-9]{40}$/,
    `${location}: use an immutable Action ref`,
  );
  const expected = { uses: actual.uses };
  if (inputs !== undefined) expected.with = inputs;
  if (condition !== undefined) expected.if = condition;
  step(actual, expected, location);
  return ref;
}
function workflow(workflows, filename, names) {
  const value = workflows?.[filename];
  assert.ok(value, `${filename}: missing security workflow`);
  equal(value.permissions, { contents: "read" }, `${filename}:permissions`);
  equal(value.env, undefined, `${filename}:env`);
  equal(value.defaults, undefined, `${filename}:defaults`);
  keys(value.jobs, names, `${filename}:jobs`);
  for (const name of names) {
    assert.ok(
      value.jobs[name] &&
        typeof value.jobs[name] === "object" &&
        !Array.isArray(value.jobs[name]),
      `${filename}:jobs.${name}: expected job mapping`,
    );
  }
  return value.jobs;
}
function job(
  value,
  location,
  { count, permissions, matrix, condition, needs, env } = {},
) {
  const {
    name,
    "runs-on": runner,
    "timeout-minutes": timeout,
    steps,
    ...execution
  } = value;
  assert.ok(Array.isArray(steps), `${location}:steps must be ordered`);
  equal(steps.length, count, `${location}:steps cardinality`);
  for (const [index, value] of steps.entries()) {
    assert.ok(
      value && typeof value === "object" && !Array.isArray(value),
      `${location}:steps[${index}]: expected step mapping`,
    );
  }
  const expected = {};
  if (permissions !== undefined) expected.permissions = permissions;
  if (matrix !== undefined) expected.strategy = { "fail-fast": false, matrix };
  if (condition !== undefined) expected.if = condition;
  if (needs !== undefined) expected.needs = needs;
  if (env !== undefined) expected.env = env;
  equal(execution, expected, location);
  return steps;
}
function inventory(matrix, axis, location) {
  keys(matrix, [axis], location);
  assert.ok(Array.isArray(matrix[axis]), `${location}: finite matrix required`);
  if (axis === "include") {
    return matrix.include.map((entry, index) => {
      keys(entry, ["language", "build-mode"], `${location}.include[${index}]`);
      assert.ok(
        languages.includes(entry.language),
        `${location}: unsupported language`,
      );
      assert.ok(
        ["manual", "none"].includes(entry["build-mode"]),
        `${location}: unsupported build mode`,
      );
      return { language: entry.language, buildMode: entry["build-mode"] };
    });
  }
  assert.ok(
    matrix.language.every((value) => languages.includes(value)),
    `${location}: unsupported language`,
  );
  return [...matrix.language];
}
function baselineScript(actual, digest, expected, location) {
  assert.equal(
    typeof actual?.run,
    "string",
    `${location}: missing baseline detector program`,
  );
  const hash = createHash("sha256").update(actual.run.trim()).digest("hex");
  equal(
    hash,
    digest,
    `${location}: baseline detector program changed; re-establish unsafe and safe controls`,
  );
  step(actual, { ...expected, run: actual.run }, location);
}

/** @returns {SecurityContract} */
export function readSecurityContract(workflows) {
  const dependencies = workflow(workflows, "security-dependencies.yml", [
    "dependency-review",
    "bun-audit",
  ]);
  const reviewLocation = "security-dependencies.yml:jobs.dependency-review";
  const reviewSteps = job(dependencies["dependency-review"], reviewLocation, {
    count: 2,
    permissions: { contents: "read", "pull-requests": "read" },
    condition: "github.event_name == 'pull_request'",
  });
  action(
    reviewSteps[0],
    "actions/checkout",
    { "persist-credentials": false },
    reviewLocation + ".steps[0]",
  );
  const inputs = reviewSteps[1].with;
  keys(
    inputs,
    [
      "fail-on-severity",
      "fail-on-scopes",
      "warn-only",
      "comment-summary-in-pr",
    ],
    reviewLocation + ".with",
  );
  assert.ok(
    severities.includes(inputs["fail-on-severity"]),
    reviewLocation + ": supported severity required",
  );
  assert.equal(
    typeof inputs["fail-on-scopes"],
    "string",
    reviewLocation + ": explicit scopes required",
  );
  const scopes = inputs["fail-on-scopes"]
    .split(",")
    .map((value) => value.trim());
  assert.ok(
    scopes.length > 0 &&
      scopes.every((value) => accepted.dependencyReview.scopes.includes(value)),
    reviewLocation + ": supported scopes required",
  );
  assert.equal(
    typeof inputs["warn-only"],
    "boolean",
    reviewLocation + ": explicit boolean warn-only required",
  );
  equal(
    inputs["comment-summary-in-pr"],
    "never",
    reviewLocation + ": comment transport",
  );
  const ref = action(
    reviewSteps[1],
    "actions/dependency-review-action",
    inputs,
    reviewLocation + ".steps[1]",
  );
  const auditLocation = "security-dependencies.yml:jobs.bun-audit";
  const auditSteps = job(dependencies["bun-audit"], auditLocation, {
    count: 3,
  });
  action(
    auditSteps[0],
    "actions/checkout",
    { "persist-credentials": false },
    auditLocation + ".steps[0]",
  );
  action(
    auditSteps[1],
    "oven-sh/setup-bun",
    { "bun-version": "1.3.14" },
    auditLocation + ".steps[1]",
  );
  const command = auditSteps[2].run;
  assert.equal(
    typeof command,
    "string",
    auditLocation + ": audit command required",
  );
  const match = /^bun audit --audit-level (low|moderate|high|critical)$/.exec(
    command.trim(),
  );
  assert.ok(
    match,
    auditLocation + ": use only bun audit --audit-level <severity>",
  );
  step(auditSteps[2], { run: command }, auditLocation + ".steps[2]");
  const argv = ["bun", "audit", "--audit-level", match[1]];

  const codeql = workflow(workflows, "security-codeql.yml", [
    "analyze",
    "upload",
  ]);
  const analysisLocation = "security-codeql.yml:jobs.analyze";
  const analysis = inventory(
    codeql.analyze.strategy?.matrix,
    "include",
    analysisLocation + ".strategy.matrix",
  );
  const analyze = job(codeql.analyze, analysisLocation, {
    count: 6,
    permissions: { contents: "read" },
    matrix: codeql.analyze.strategy.matrix,
  });
  action(
    analyze[0],
    "actions/checkout",
    { "persist-credentials": false },
    analysisLocation + ".steps[0]",
  );
  action(
    analyze[1],
    "actions/setup-dotnet",
    { "global-json-file": "global.json" },
    analysisLocation + ".steps[1]",
    csharp,
  );
  const codeqlRef = action(
    analyze[2],
    "github/codeql-action/init",
    { languages: language, "build-mode": "${{ matrix.build-mode }}" },
    analysisLocation + ".steps[2]",
  );
  step(
    analyze[3],
    {
      if: csharp,
      run: "dotnet restore Damadama.slnx --locked-mode\ndotnet build Damadama.slnx --no-restore\n",
    },
    analysisLocation + ".steps[3]",
  );
  equal(
    action(
      analyze[4],
      "github/codeql-action/analyze",
      {
        category: "/language:" + language,
        output: analysisPath,
        upload: "never",
        "upload-database": false,
      },
      analysisLocation + ".steps[4]",
    ),
    codeqlRef,
    analysisLocation + ": coordinated CodeQL ref",
  );
  action(
    analyze[5],
    "actions/upload-artifact",
    {
      name: attemptArtifact,
      path: analysisPath + "/*.sarif",
      "if-no-files-found": "error",
      "retention-days": 3,
    },
    analysisLocation + ".steps[5]",
  );
  const uploadLocation = "security-codeql.yml:jobs.upload";
  const uploads = inventory(
    codeql.upload.strategy?.matrix,
    "language",
    uploadLocation + ".strategy.matrix",
  );
  const upload = job(codeql.upload, uploadLocation, {
    count: 3,
    permissions: {
      actions: "read",
      contents: "read",
      "security-events": "write",
    },
    matrix: codeql.upload.strategy.matrix,
    needs: "analyze",
  });
  action(
    upload[0],
    "actions/checkout",
    { ref: "${{ github.sha }}", "persist-credentials": false },
    uploadLocation + ".steps[0]",
  );
  action(
    upload[1],
    "actions/download-artifact",
    { name: attemptArtifact, path: analysisPath },
    uploadLocation + ".steps[1]",
  );
  equal(
    action(
      upload[2],
      "github/codeql-action/upload-sarif",
      { sarif_file: analysisPath, category: "/language:" + language },
      uploadLocation + ".steps[2]",
    ),
    codeqlRef,
    uploadLocation + ": coordinated CodeQL ref",
  );

  const fixtures = workflow(workflows, "security-fixtures.yml", [
    "fixtures",
    "codeql",
    "dependency-review",
  ]);
  const detectorLocation = "security-fixtures.yml:jobs.codeql";
  const detector = inventory(
    fixtures.codeql.strategy?.matrix,
    "language",
    detectorLocation + ".strategy.matrix",
  );
  const detect = job(fixtures.codeql, detectorLocation, {
    count: 6,
    permissions: { contents: "read" },
    matrix: fixtures.codeql.strategy.matrix,
    env: { CODEQL_ACTION_DIFF_INFORMED_QUERIES: "false" },
  });
  action(
    detect[0],
    "actions/setup-dotnet",
    { "dotnet-version": "10.0.x" },
    detectorLocation + ".steps[0]",
    csharp,
  );
  baselineScript(
    detect[1],
    "cc62a723d027e008b39cc88988af4888d7f3dfb5e4566fcd40b30137185da14e",
    { env: { LANGUAGE: language }, shell: "bash" },
    detectorLocation + ".steps[1]",
  );
  equal(
    action(
      detect[2],
      "github/codeql-action/init",
      {
        languages: language,
        "build-mode":
          "${{ matrix.language == 'csharp' && 'manual' || 'none' }}",
        "db-location": "${{ runner.temp }}/fixture-codeql-db",
      },
      detectorLocation + ".steps[2]",
    ),
    codeqlRef,
    detectorLocation + ": coordinated CodeQL init ref",
  );
  step(
    detect[3],
    { if: csharp, run: "dotnet build Fixture.csproj" },
    detectorLocation + ".steps[3]",
  );
  equal(
    action(
      detect[4],
      "github/codeql-action/analyze",
      {
        output: "${{ runner.temp }}/fixture-codeql-sarif",
        upload: "never",
        "upload-database": false,
      },
      detectorLocation + ".steps[4]",
    ),
    codeqlRef,
    detectorLocation + ": coordinated CodeQL analyze ref",
  );
  baselineScript(
    detect[5],
    "3f572d15a2de42e713b9a60216428e4a42e88e436dd51a883c09e771e0d3e490",
    {
      env: {
        LANGUAGE: language,
        SARIF_DIR: "${{ runner.temp }}/fixture-codeql-sarif",
      },
      shell: "bash",
    },
    detectorLocation + ".steps[5]",
  );

  const bunFixtureLocation = "security-fixtures.yml:jobs.fixtures";
  const bunFixture = job(fixtures.fixtures, bunFixtureLocation, { count: 4 });
  action(
    bunFixture[0],
    "actions/checkout",
    { ref: "${{ github.sha }}", "persist-credentials": false },
    bunFixtureLocation + ".steps[0]",
  );
  action(
    bunFixture[1],
    "actions/setup-node",
    { "node-version": 24 },
    bunFixtureLocation + ".steps[1]",
  );
  action(
    bunFixture[2],
    "oven-sh/setup-bun",
    { "bun-version": "1.3.14" },
    bunFixtureLocation + ".steps[2]",
  );
  step(
    bunFixture[3],
    { shell: "bash", run: "bun .github/ci/security-fixtures.mjs bun-audit" },
    bunFixtureLocation + ".steps[3]",
  );
  const reviewFixtureLocation = "security-fixtures.yml:jobs.dependency-review";
  const reviewFixture = job(
    fixtures["dependency-review"],
    reviewFixtureLocation,
    { count: 5, permissions: { contents: "read" } },
  );
  action(
    reviewFixture[0],
    "actions/checkout",
    { ref: "${{ github.sha }}", "persist-credentials": false },
    reviewFixtureLocation + ".steps[0]",
  );
  action(
    reviewFixture[1],
    "actions/checkout",
    {
      repository: "actions/dependency-review-action",
      ref,
      path: "fixture-dependency-action",
      "persist-credentials": false,
    },
    reviewFixtureLocation + ".steps[1]",
  );
  action(
    reviewFixture[2],
    "actions/setup-node",
    { "node-version": 24 },
    reviewFixtureLocation + ".steps[2]",
  );
  action(
    reviewFixture[3],
    "oven-sh/setup-bun",
    { "bun-version": "1.3.14" },
    reviewFixtureLocation + ".steps[3]",
  );
  step(
    reviewFixture[4],
    {
      shell: "bash",
      run: "bun .github/ci/security-fixtures.mjs dependency-review",
    },
    reviewFixtureLocation + ".steps[4]",
  );
  return {
    dependencyReview: {
      ref,
      severity: inputs["fail-on-severity"],
      scopes,
      warnOnly: inputs["warn-only"],
    },
    bunAudit: { argv },
    coverage: { analysis, uploads, detector },
  };
}

export function acceptedSecurityErrors(contract) {
  const errors = [];
  const { ref, ...review } = contract.dependencyReview;
  for (const [name, actual, expected] of [
    [
      "dependency review severity, scopes and warn-only",
      review,
      accepted.dependencyReview,
    ],
    ["Bun audit argv", contract.bunAudit, accepted.bunAudit],
    [
      "analysis inventory",
      contract.coverage.analysis,
      accepted.coverage.analysis,
    ],
    [
      "isolated upload inventory",
      contract.coverage.uploads,
      accepted.coverage.uploads,
    ],
    [
      "detector inventory",
      contract.coverage.detector,
      accepted.coverage.detector,
    ],
  ]) {
    if (!isDeepStrictEqual(actual, expected))
      errors.push(`Security ${name}: expected ${JSON.stringify(expected)}`);
  }
  return errors;
}
