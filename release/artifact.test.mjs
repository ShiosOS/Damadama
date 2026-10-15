import assert from "node:assert/strict";
import { test } from "node:test";
import * as github from "./github.mjs";
import { authority, source, jobs } from "./fixtures.mjs";
const artifact = () => ({
  id: 77,
  name: "verified-record-1",
  expired: false,
  digest: `sha256:${"a".repeat(64)}`,
  created_at: "2026-10-14T12:02:00Z",
  workflow_run: { id: 42, head_sha: source.commit },
});
test("receipt requires immutable artifact membership and exact producer interval", () => {
  assert.equal(
    github.selectArtifact([artifact()], "verified-record", authority, jobs()[3])
      .id,
    77,
  );
  for (const mutate of [
    (a) => (a.workflow_run.id = 43),
    (a) => (a.workflow_run.head_sha = "3".repeat(40)),
    (a) => (a.expired = true),
    (a) => delete a.digest,
    (a) => (a.created_at = "2026-10-14T11:00:00Z"),
    (a) => (a.name = "verified-record-2"),
  ]) {
    const a = artifact();
    mutate(a);
    assert.throws(
      () => github.selectArtifact([a], "verified-record", authority, jobs()[3]),
      /artifact/,
    );
  }
  assert.throws(
    () =>
      github.selectArtifact(
        [artifact(), artifact()],
        "verified-record",
        authority,
        jobs()[3],
      ),
    /artifact/,
  );
});
