import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requireVerifiedRecord,
  requirePromotion,
  recordHash,
  mainRules,
} from "./policy.mjs";
import { source, authority, record, run, jobs } from "./fixtures.mjs";
const facts = () => ({
  mainSha: source.commit,
  mainTree: source.tree,
  run: { ...run },
  jobs: jobs(),
  approval: {
    runId: 55,
    attempt: 1,
    recordHash: recordHash(record()),
    reviewers: [{ id: 1, login: "owner" }],
  },
  promotionAuthority: { sha: source.commit, runId: 55, attempt: 1 },
});
test("automatic schema 2 record needs no staging human approval", () =>
  assert.equal(requireVerifiedRecord(record()).schema, 2));
test("production promotes the exact tested digest after bound approval", () =>
  assert.equal(requirePromotion(record(), facts()), record().image.reference));
for (const key of Object.keys(record().evidence.automated))
  test(`missing ${key} refuses staging proof`, () => {
    const r = record();
    delete r.evidence.automated[key];
    assert.throws(() => requireVerifiedRecord(r), new RegExp(key));
  });
test("old schema and PR source are refused", () => {
  const r = record();
  r.schema = 1;
  assert.throws(() => requireVerifiedRecord(r), /record/);
  r.schema = 2;
  r.source.pr = 11;
  assert.throws(() => requireVerifiedRecord(r), /source/);
});
for (const [field, value] of [
  ["event", "pull_request"],
  ["path", "evil.yml"],
  ["run_attempt", 2],
  ["head_sha", "3".repeat(40)],
  ["conclusion", "failure"],
])
  test(`untrusted stage ${field} refuses promotion`, () => {
    const f = facts();
    f.run[field] = value;
    assert.throws(() => requirePromotion(record(), f), /workflow/);
  });
test("same-tree newer main cannot inherit staging", () => {
  const f = facts();
  f.mainSha = "3".repeat(40);
  assert.throws(() => requirePromotion(record(), f), /main/);
});
test("self-issued approval boolean does not authorize production", () => {
  const f = facts();
  delete f.approval;
  f.approved = true;
  assert.throws(() => requirePromotion(record(), f), /approval/);
});
for (const field of ["runId", "attempt", "recordHash"])
  test(`approval binds ${field}`, () => {
    const f = facts();
    f.approval[field] = "other";
    assert.throws(() => requirePromotion(record(), f), /approval/);
  });
test("main merge policy requires real ordinary Actions checks", () => {
  const rules = mainRules();
  assert.deepEqual(rules.bypass_actors, []);
  const checks = rules.rules.find(
    (r) => r.type === "required_status_checks",
  ).parameters;
  assert.equal(checks.strict_required_status_checks_policy, true);
  assert.deepEqual(checks.required_status_checks, [
    { context: "release-controls", integration_id: 15368 },
    { context: "check", integration_id: 15368 },
  ]);
});
test("canonical record hash binds values but ignores key order", () => {
  assert.equal(recordHash({ a: 1, b: 2 }), recordHash({ b: 2, a: 1 }));
  assert.notEqual(recordHash({ a: 1 }), recordHash({ a: 2 }));
});
