import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requireCIEvidence,
  requireVerifiedRecord,
  requirePromotion,
  recordHash,
} from "./policy.mjs";
import { source, authority, jobs, record, run } from "./fixtures.mjs";
test("CI accepts only successful jobs of the exact main attempt", () => {
  assert.equal(requireCIEvidence(source, jobs(), authority).length, 2);
  for (const [field, value] of [
    ["head_sha", "3".repeat(40)],
    ["run_id", 43],
    ["run_attempt", 2],
    ["conclusion", "skipped"],
    ["status", "in_progress"],
  ]) {
    const evidence = jobs();
    evidence[0][field] = value;
    assert.throws(() => requireCIEvidence(source, evidence, authority), /CI/);
  }
  assert.throws(
    () => requireCIEvidence(source, [...jobs(), jobs()[0]], authority),
    /CI/,
  );
});

test("publish refusal names the first failed fixed category without echoing job data", (t) => {
  const valid = {
    ...jobs()[0],
    name: "publish",
  };
  const output = [];
  t.mock.method(console, "error", (...args) => output.push(args));
  t.mock.method(console, "log", (...args) => output.push(args));
  assert.strictEqual(
    requireCIEvidence(source, [valid], authority, ["publish"])[0],
    valid,
  );
  assert.deepEqual(output, []);

  const sentinel = "arbitrary-provider-value";
  const cases = [
    ["job_missing", []],
    ["job_ambiguous", [valid, { ...valid }]],
    ["head_sha_mismatch", [{ ...valid, head_sha: sentinel }]],
    ["head_sha_mismatch", [{ ...valid, head_sha: undefined }]],
    ["run_id_mismatch", [{ ...valid, run_id: String(authority.runId) }]],
    ["run_id_mismatch", [{ ...valid, run_id: undefined }]],
    [
      "run_attempt_mismatch",
      [{ ...valid, run_attempt: String(authority.attempt) }],
    ],
    ["run_attempt_mismatch", [{ ...valid, run_attempt: undefined }]],
    ["status_not_completed", [{ ...valid, status: sentinel }]],
    ["status_not_completed", [{ ...valid, status: undefined }]],
    ["conclusion_not_success", [{ ...valid, conclusion: sentinel }]],
    ["conclusion_not_success", [{ ...valid, conclusion: undefined }]],
    ["job_id_invalid", [{ ...valid, id: 0 }]],
    ["job_id_invalid", [{ ...valid, id: Number.MAX_SAFE_INTEGER + 1 }]],
    ["job_id_invalid", [{ ...valid, id: "10" }]],
    ["job_url_mismatch", [{ ...valid, html_url: `https://${sentinel}/job` }]],
    [
      "head_sha_mismatch",
      [{ ...valid, head_sha: sentinel, run_id: 0, status: sentinel }],
    ],
    [
      "run_attempt_mismatch",
      [{ ...valid, run_attempt: 3, conclusion: sentinel, id: 0 }],
    ],
    ["job_id_invalid", [{ ...valid, id: 0, html_url: sentinel }]],
  ];
  for (const [reason, evidence] of cases) {
    assert.throws(
      () => requireCIEvidence(source, evidence, authority, ["publish"]),
      (error) => {
        assert.equal(
          error.message,
          `CI publish must succeed in the exact main workflow attempt: ${reason}`,
        );
        assert.ok(!error.message.includes(sentinel));
        return true;
      },
    );
  }
  assert.deepEqual(output, []);
});

import { requireFreshCandidate } from "./controller.mjs";
import { attemptJobs } from "./github.mjs";
import { requireJobs } from "../.github/ci/required-jobs.mjs";

test("both native promotion consumers and fresh candidate refuse causal security barrier failures", async (t) => {
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
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let current = jobs(),
    count = current.length;
  t.mock.method(globalThis, "fetch", async (url) => {
    let value;
    if (url.includes("/git/ref/heads/main"))
      value = { object: { sha: source.commit } };
    else if (url.includes("/git/commits/"))
      value = { sha: source.commit, tree: { sha: source.tree } };
    else if (
      url ===
      "https://api.github.com/repos/ShiosOS/Damadama/actions/runs/42/attempts/1/jobs?per_page=100"
    )
      value = { total_count: count, jobs: current };
    else if (url.endsWith("/actions/runs/42")) value = run;
    else throw Error("unexpected controlled API request");
    return new Response(JSON.stringify(value));
  });
  assert.equal((await requireFreshCandidate({ source, authority })).length, 2);
  for (const callable of ["security-codeql", "security-dependencies"])
    for (const result of ["failure", "skipped", "cancelled", undefined]) {
      const needs = {
        "security-codeql": { result: "success" },
        "security-dependencies": { result: "success" },
      };
      needs[callable].result = result;
      assert.throws(
        () => requireJobs("main-release-controls", needs),
        /result must be success/,
      );
      current = jobs();
      current[0].conclusion = "failure";
      await assert.rejects(
        requireFreshCandidate({ source, authority }),
        /CI release-controls/,
      );
      const staged = record();
      staged.evidence.ci = current.slice(0, 2);
      assert.throws(() => requireVerifiedRecord(staged), /CI release-controls/);
      const valid = record();
      assert.throws(
        () =>
          requirePromotion(valid, {
            mainSha: source.commit,
            mainTree: source.tree,
            run,
            jobs: current,
            approval: {
              runId: 55,
              attempt: 1,
              recordHash: recordHash(valid),
              reviewers: [{}],
            },
            promotionAuthority: { runId: 55, attempt: 1 },
          }),
        /CI release-controls/,
      );
    }
  for (const mutate of [
    (list) => list.slice(1),
    (list) => [...list, list[0]],
    ...["failure", "skipped", "cancelled"].map((conclusion) => (list) => [
      { ...list[0], conclusion },
      ...list.slice(1),
    ]),
    ...[
      { status: "in_progress" },
      { run_id: 43 },
      { run_attempt: 2 },
      { id: 0 },
      { html_url: "https://example.invalid/job" },
      { head_sha: "f".repeat(40) },
    ].map((patch) => (list) => [{ ...list[0], ...patch }, ...list.slice(1)]),
  ]) {
    current = mutate(jobs());
    count = current.length;
    await assert.rejects(
      requireFreshCandidate({ source, authority }),
      /CI release-controls/,
    );
  }
  current = jobs();
  count = 101;
  await assert.rejects(attemptJobs(authority), /ambiguous workflow jobs/);
});
