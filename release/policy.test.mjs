import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  requireCurrentSource,
  requireVerifiedRecord,
  requirePromotion,
  mainRules,
  recordHash,
} from "./policy.mjs";

const sha = (c) => c.repeat(40);
const digest = `sha256:${"a".repeat(64)}`;
const source = {
  repository: "ShiosOS/Damadama",
  pr: 11,
  head: sha("1"),
  base: sha("2"),
  merge: sha("3"),
  tree: sha("4"),
};
const record = () => ({
  schema: 1,
  source: { ...source },
  authority: { sha: sha("5"), runId: 42, attempt: 1 },
  image: {
    reference: `ghcr.io/shiosos/damadama@${digest}`,
    digest,
    archiveSha256: "b".repeat(64),
    version: "pr-11-111111111111-222222222222",
  },
  deployment: {
    id: "deployment-1",
    environmentId: "staging-1",
    url: "https://staging.example.com",
    image: `ghcr.io/shiosos/damadama@${digest}`,
  },
  evidence: {
    automated: {
      readiness: true,
      unauthorized: true,
      runtimeConfig: true,
      clerk: true,
      habits: true,
      ownership: true,
      signOut: true,
    },
    operator: {
      approvalRunId: 42,
      email: "approved-attestation",
      migrations: "approved-attestation",
      rollback: "approved-attestation",
    },
  },
});
const checkFor = (r) => ({
  name: "staging/verified",
  head_sha: source.merge,
  conclusion: "success",
  status: "completed",
  app: { id: 9001 },
  external_id: recordHash(r),
  details_url: "https://github.com/ShiosOS/Damadama/actions/runs/42",
});
const run = {
  id: 42,
  run_attempt: 1,
  event: "workflow_dispatch",
  path: ".github/workflows/stage.yml",
  head_branch: "main",
  head_sha: sha("5"),
  conclusion: "success",
};

test("unchanged proposed result may be verified", () => {
  assert.doesNotThrow(() => requireCurrentSource(source, { ...source }));
});
for (const field of ["repository", "pr", "head", "base", "merge", "tree"]) {
  test(`a changed ${field} invalidates earlier staging`, () => {
    const current = { ...source, [field]: field === "pr" ? 12 : "changed" };
    assert.throws(
      () => requireCurrentSource(source, current),
      new RegExp(field),
    );
  });
}
test("absent staging record refuses verification", () => {
  assert.throws(() => requireVerifiedRecord(null), /record/);
});
for (const field of [
  "readiness",
  "unauthorized",
  "runtimeConfig",
  "clerk",
  "habits",
  "ownership",
  "signOut",
]) {
  test(`missing ${field} runtime evidence refuses success`, () => {
    const r = record();
    r.evidence.automated[field] = false;
    assert.throws(() => requireVerifiedRecord(r), new RegExp(field));
  });
}
test("test mail cannot count as actual email attestation", () => {
  const r = record();
  r.evidence.operator.email = "test-code-bypass";
  assert.throws(() => requireVerifiedRecord(r), /email/);
});
test("changed deployment image cannot verify the candidate", () => {
  const r = record();
  r.deployment.image = `ghcr.io/shiosos/damadama@sha256:${"c".repeat(64)}`;
  assert.throws(() => requireVerifiedRecord(r), /image/);
});
test("full gate has strict App-bound staging, CI, review, and no bypass", () => {
  const rules = mainRules(9001);
  const checks = rules.rules.find(
    (r) => r.type === "required_status_checks",
  ).parameters;
  assert.equal(checks.strict_required_status_checks_policy, true);
  assert.deepEqual(checks.required_status_checks, [
    { context: "release-controls", integration_id: 15368 },
    { context: "check", integration_id: 15368 },
    { context: "staging/verified", integration_id: 9001 },
  ]);
  assert.deepEqual(rules.bypass_actors, []);
  const reviews = rules.rules.find((r) => r.type === "pull_request").parameters;
  assert.equal(reviews.required_approving_review_count, 1);
  assert.equal(reviews.dismiss_stale_reviews_on_push, true);
  assert.equal(reviews.require_last_push_approval, true);
});
test("gate cannot activate without a dedicated App", () => {
  assert.throws(() => mainRules(0), /App/);
  assert.throws(() => mainRules(15368), /App/);
});
test("record hashes ignore object key order but bind every value", () => {
  assert.equal(recordHash({ a: 1, b: 2 }), recordHash({ b: 2, a: 1 }));
  assert.notEqual(recordHash({ a: 1 }), recordHash({ a: 2 }));
  assert.equal(
    recordHash({ a: 1 }),
    createHash("sha256").update('{"a":1}').digest("hex"),
  );
});
const production = (r) => ({
  approved: true,
  mainSha: sha("6"),
  mainTree: source.tree,
  merged: true,
  mergedHead: source.head,
  mergeCommit: sha("6"),
  appId: 9001,
  check: checkFor(r),
  run,
});
test("a merged matching tree promotes the exact staged digest", () => {
  const r = record();
  assert.equal(requirePromotion(r, production(r)), r.image.reference);
});
for (const [field, value, reason] of [
  ["approved", false, "approval"],
  ["mainTree", sha("7"), "tree"],
  ["merged", false, "merged"],
  ["mergedHead", sha("7"), "head"],
  ["mergeCommit", sha("7"), "main"],
]) {
  test(`production refuses ${reason} mismatch`, () => {
    const r = record();
    assert.throws(
      () => requirePromotion(r, { ...production(r), [field]: value }),
      new RegExp(reason),
    );
  });
}
for (const [change, reason] of [
  [
    (c) => {
      c.app.id = 15368;
    },
    "App",
  ],
  [
    (c) => {
      c.conclusion = "skipped";
    },
    "success",
  ],
  [
    (c) => {
      c.external_id = "forged";
    },
    "hash",
  ],
  [
    (c) => {
      c.head_sha = source.head;
    },
    "merge",
  ],
]) {
  test(`a forged or incomplete check refuses promotion (${reason})`, () => {
    const r = record();
    const p = production(r);
    change(p.check);
    assert.throws(() => requirePromotion(r, p), new RegExp(reason));
  });
}
test("a PR-owned workflow cannot authenticate a release record", () => {
  const r = record();
  const p = production(r);
  p.run = { ...run, event: "pull_request" };
  assert.throws(() => requirePromotion(r, p), /workflow/);
});
