import assert from "node:assert/strict";
import { test } from "node:test";
import { requireCIEvidence } from "./policy.mjs";
import { source, authority, jobs } from "./fixtures.mjs";
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
