import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gateGraphErrors } from "./workflow-policy.mjs";
import { source } from "../../release/fixtures.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflows = {};
for (const name of await readdir(join(root, ".github/workflows"))) {
  if (name.endsWith(".yml"))
    workflows[name] = Bun.YAML.parse(
      await readFile(join(root, ".github/workflows", name), "utf8"),
    );
}
const rejected = (name, mutate, pattern) =>
  test(name, () => {
    const changed = structuredClone(workflows);
    mutate(changed);
    assert.ok(
      gateGraphErrors(changed).some((error) => pattern.test(error)),
      `${name}: expected ${pattern}; got ${gateGraphErrors(changed).join("\n")}`,
    );
  });

const proof = (w) => w["release-preflight-proof.yml"];
const proofJob = (w) => proof(w).jobs["preflight-proof"];
for (const [label, mutate, pattern] of [
  [
    "missing workflow",
    (w) => delete w["release-preflight-proof.yml"],
    /proof shape/,
  ],
  [
    "production job",
    (w) =>
      (proof(w).jobs.promote = structuredClone(w["promote.yml"].jobs.promote)),
    /jobs.promote: forbidden/,
  ],
  [
    "production step",
    (w) =>
      proofJob(w).steps.push({
        run: "node controls/release/operate.mjs promote",
      }),
    /steps.6: forbidden/,
  ],
  [
    "environment",
    (w) => (proofJob(w).environment = "production"),
    /environment: forbidden/,
  ],
  [
    "provider secret",
    (w) =>
      (proofJob(w).steps[3].env.RAILWAY_TOKEN = "${{ secrets.RAILWAY_TOKEN }}"),
    /RAILWAY_TOKEN: forbidden/,
  ],
  [
    "token substitution",
    (w) => (proofJob(w).steps[3].env.GH_TOKEN = "${{ secrets.PAT }}"),
    /env.GH_TOKEN: must match/,
  ],
  ["push trigger", (w) => (proof(w).on.push = {}), /on.push: forbidden/],
  [
    "raised timeout",
    (w) => (proofJob(w)["timeout-minutes"] = 6),
    /timeout-minutes: must match/,
  ],
  [
    "matrix",
    (w) => (proofJob(w).strategy = { matrix: { repeat: [1, 2] } }),
    /strategy: forbidden/,
  ],
  ["dependency", (w) => (proofJob(w).needs = "promote"), /needs: forbidden/],
  ["job bypass", (w) => (proofJob(w).if = "false"), /if: forbidden/],
  [
    "job permission override",
    (w) => (proofJob(w).permissions = { contents: "write" }),
    /permissions: forbidden/,
  ],
  [
    "alternate operation",
    (w) =>
      (proofJob(w).steps[3].run = proofJob(w).steps[3].run.replace(
        "'preflight'",
        "'promote'",
      )),
    /steps.3.run: must match/,
  ],
  [
    "alternate command",
    (w) => (proofJob(w).steps[3].run += "\necho bypass"),
    /steps.3.run: must match/,
  ],
  [
    "input interpolation",
    (w) => (proofJob(w).steps[3].run += "\necho '${{ inputs.notes }}'"),
    /steps.3.run: must match/,
  ],
  [
    "alternate installer",
    (w) => (proofJob(w).steps[2].run += " --skip"),
    /steps.2.run: must match/,
  ],
  [
    "broad upload",
    (w) => (proofJob(w).steps[5].with.path = ".audit/**"),
    /steps.5.with.path: must match/,
  ],
  [
    "promotion artifact name",
    (w) => (proofJob(w).steps[5].with.name = "promotion-plan-1"),
    /steps.5.with.name: must match/,
  ],
  [
    "cached tools",
    (w) => (proofJob(w).steps[1].with.cache = "npm"),
    /cache: forbidden/,
  ],
  [
    "forged native metadata",
    (w) => (proofJob(w).steps[3].env.GITHUB_RUN_ATTEMPT = "1"),
    /GITHUB_RUN_ATTEMPT: forbidden/,
  ],
  [
    "raw input evidence",
    (w) => (proofJob(w).steps[4].run += "\necho '${{ inputs.recovery }}'"),
    /steps.4.run: must match/,
  ],
])
  rejected(`read-only proof rejects ${label}`, mutate, pattern);

for (const scope of [
  "contents",
  "actions",
  "packages",
  "id-token",
  "attestations",
])
  rejected(
    `read-only proof rejects ${scope} write`,
    (w) => (proof(w).permissions[scope] = "write"),
    /permissions.*(?:forbidden|must match)/,
  );
for (let index = 0; index < 6; index++) {
  rejected(
    `read-only proof rejects step ${index} bypass`,
    (w) => (proofJob(w).steps[index]["continue-on-error"] = true),
    /continue-on-error: forbidden/,
  );
  rejected(
    `read-only proof rejects step ${index} condition`,
    (w) => (proofJob(w).steps[index].if = "false"),
    /\.if: (?:forbidden|must match)/,
  );
  rejected(
    `read-only proof rejects missing step ${index}`,
    (w) => proofJob(w).steps.splice(index, 1),
    /steps\./,
  );
}
for (const [index, action, substitute] of [
  [0, "actions/checkout", "actions/setup-node"],
  [1, "actions/setup-node", "actions/checkout"],
  [5, "actions/upload-artifact", "actions/download-artifact"],
]) {
  rejected(
    `read-only proof rejects unpinned ${action}`,
    (w) => (proofJob(w).steps[index].uses = action),
    /\.uses: must match/,
  );
  for (const ref of [
    "main",
    "v4",
    "abc1234",
    "a".repeat(39),
    "a".repeat(41),
    "g".repeat(40),
    "a".repeat(40) + "\n",
  ]) {
    rejected(
      "read-only proof rejects invalid " +
        action +
        " ref " +
        JSON.stringify(ref),
      (w) => (proofJob(w).steps[index].uses = action + "@" + ref),
      /\.uses: must match/,
    );
  }
  for (const other of [substitute, "unapproved/action"]) {
    rejected(
      "read-only proof rejects " + action + " substitution with " + other,
      (w) => (proofJob(w).steps[index].uses = other + "@" + "a".repeat(40)),
      /\.uses: must match/,
    );
  }
}

test("read-only proof accepts coordinated full immutable action refs", () => {
  const changed = structuredClone(workflows);
  for (const [index, action, sha] of [
    [0, "actions/checkout", "a".repeat(40)],
    [1, "actions/setup-node", "b".repeat(40)],
    [5, "actions/upload-artifact", "c".repeat(40)],
  ])
    proofJob(changed).steps[index].uses = action + "@" + sha;
  for (const workflow of Object.values(changed)) {
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/setup-node@")) {
          step.uses = "actions/setup-node@" + "b".repeat(40);
        }
      }
    }
  }
  assert.deepEqual(gateGraphErrors(changed), []);
});

test("read-only proof accepts the loaded graph and reordered permission keys", () => {
  assert.deepEqual(gateGraphErrors(workflows), []);
  const changed = structuredClone(workflows);
  proof(changed).permissions = Object.fromEntries(
    Object.entries(proof(changed).permissions).reverse(),
  );
  assert.deepEqual(gateGraphErrors(changed), []);
});

for (const scenario of [
  "preflight-success",
  "preflight-barrier-failure",
  "install-failure",
  "missing-command-evidence",
]) {
  test(`read-only proof actual wrapper records ${scenario} without provider effects`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "preflight-proof-"));
    try {
      const env = {
        ...process.env,
        GITHUB_REPOSITORY: source.repository,
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: source.commit,
        GITHUB_RUN_ID: "43",
        GITHUB_RUN_ATTEMPT: "1",
        CHECKOUT_OUTCOME: "success",
        NODE_OUTCOME: "success",
        INSTALL_OUTCOME: "success",
        PREFLIGHT_OUTCOME: "success",
        GH_TOKEN: "synthetic-do-not-retain",
        RELEASE_NOTES: "private-do-not-retain",
      };
      const execute = (index) =>
        spawnSync(
          "node",
          [
            "--input-type=module",
            "-e",
            proofJob(workflows)
              .steps[index].run.split("\n")
              .slice(1, -2)
              .join("\n"),
          ],
          { cwd: directory, env, encoding: "utf8" },
        );
      if (scenario.startsWith("preflight-")) {
        await mkdir(join(directory, "controls/release"), { recursive: true });
        await writeFile(
          join(directory, "controls/release/operate.mjs"),
          `
          import assert from 'node:assert/strict';
          assert.equal(process.argv[2], 'preflight');
          process.argv[2] = ${JSON.stringify(scenario)};
          await import(${JSON.stringify(pathToFileURL(join(root, "release/test-fixtures/operation.mjs")).href)});
        `,
        );
        const result = execute(3);
        const success = scenario === "preflight-success";
        assert.equal(result.status, success ? 0 : 1, result.stderr);
        if (!success) assert.match(result.stderr, /CI release-controls/);
        env.PREFLIGHT_OUTCOME = success ? "success" : "failure";
        assert.equal(
          existsSync(join(directory, "promotion-plan.json")),
          success,
        );
      } else if (scenario === "install-failure") {
        env.INSTALL_OUTCOME = "failure";
        env.PREFLIGHT_OUTCOME = "skipped";
      } else env.PREFLIGHT_OUTCOME = "failure";
      const evidence = execute(4);
      assert.equal(evidence.status, 0, evidence.stderr);
      const raw = await readFile(
        join(directory, "preflight-proof.json"),
        "utf8",
      );
      assert.ok(Buffer.byteLength(raw) < 2048);
      assert.doesNotMatch(
        raw,
        /synthetic-do-not-retain|private-do-not-retain|backupId|migrations/,
      );
      const result = JSON.parse(raw);
      assert.equal(result.sourceSha, source.commit);
      assert.equal(result.runId, "43");
      assert.equal(result.runAttempt, "1");
      assert.equal(
        result.durationAuthority,
        "native-job-started_at-and-completed_at",
      );
      assert.equal(result.steps.install, env.INSTALL_OUTCOME);
      assert.equal(result.steps.preflight, env.PREFLIGHT_OUTCOME);
      if (scenario.startsWith("preflight-")) {
        assert.equal(result.commandEvidence, "recorded");
        assert.equal(
          result.command.exitCode,
          scenario === "preflight-success" ? 0 : 1,
        );
        assert.equal(result.command.signal, null);
        assert.equal(result.command.spawnFailed, false);
        assert.ok(result.command.elapsedMs >= 0);
        assert.ok(
          Date.parse(result.command.completedAt) >=
            Date.parse(result.command.startedAt),
        );
      } else {
        assert.equal(result.command, null);
        assert.equal(
          result.commandEvidence,
          scenario === "install-failure" ? "not-reached" : "absent",
        );
      }
      assert.equal(existsSync(join(directory, "events.jsonl")), false);
      assert.equal(existsSync(join(directory, "production.json")), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
