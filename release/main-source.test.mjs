import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requireSource,
  candidateVersion,
  requireCurrentSource,
} from "./policy.mjs";

const source = {
  repository: "ShiosOS/Damadama",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
};
test("main source has one immutable commit and version", () => {
  assert.deepEqual(requireSource(source), source);
  assert.equal(candidateVersion(source), "main-111111111111");
  assert.throws(() => requireSource({ ...source, pr: 11 }), /source/);
  assert.throws(
    () => requireCurrentSource(source, { ...source, commit: "3".repeat(40) }),
    /stale commit/,
  );
});
