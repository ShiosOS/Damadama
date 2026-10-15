import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { record } from "./fixtures.mjs";

function operate(t, scenario) {
  const dir = mkdtempSync(join(tmpdir(), "damadama-operation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./test-fixtures/operation.mjs", import.meta.url)),
      scenario,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  return {
    ...result,
    dir,
    read: (path) => JSON.parse(readFileSync(join(dir, path), "utf8")),
  };
}

test("stage reports the actual deployment when main advances during log summary", (t) => {
  const result = operate(t, "late-main");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /main advanced/);
  assert.equal(existsSync(join(result.dir, "verified.json")), false);
  assert.equal(
    existsSync(join(result.dir, "runtime-evidence/provider-outcome.json")),
    true,
    "applied deployment has no provider outcome",
  );
  const outcome = result.read("runtime-evidence/provider-outcome.json");
  assert.equal(outcome.status, "applied-but-unverified");
  assert.equal(outcome.deployment.id, "deploy-1");
  assert.equal(outcome.image, record().image.reference);
  assert.match(
    readFileSync(join(result.dir, "summary.md"), "utf8"),
    /No rollback was performed/,
  );
});

for (const [failure, error, expectedEvents] of [
  ["write", /EISDIR/, ["draft", "deploy"]],
  ["upload", /release upload failed/, ["draft", "deploy", "upload"]],
  [
    "patch",
    /GitHub PATCH .* returned 503/,
    ["draft", "deploy", "upload", "publish"],
  ],
]) {
  test(`production reports its actual deployment after ${failure} failure`, (t) => {
    const result = operate(t, `production-${failure}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.equal(
      existsSync(join(result.dir, "runtime-evidence/provider-outcome.json")),
      true,
      "applied production deployment has no provider outcome",
    );
    const outcome = result.read("runtime-evidence/provider-outcome.json");
    assert.equal(outcome.status, "applied-but-unverified");
    assert.equal(outcome.deployment.id, "prod-1");
    assert.equal(outcome.deployment.url, "https://prod.damadama.app");
    assert.equal(outcome.image, record().image.reference);
    assert.deepEqual(result.read("verified.json"), record());
    const events = readFileSync(join(result.dir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      events.map((e) => e.type),
      expectedEvents,
    );
    assert.equal(events[0].body.draft, true);
    assert.equal(events[1].image, record().image.reference);
    assert.match(
      readFileSync(join(result.dir, "summary.md"), "utf8"),
      /No rollback was performed/,
    );
  });
}

test("stage assembles its CI and browser evidence in the verified receipt", (t) => {
  const result = operate(t, "stage-success");
  assert.equal(result.status, 0, result.stderr);
  const receipt = result.read("verified.json");
  assert.deepEqual(receipt.source, record().source);
  assert.deepEqual(receipt.evidence.ci, record().evidence.ci);
  assert.deepEqual(receipt.evidence.automated, record().evidence.automated);
  assert.ok(Number.isFinite(Date.parse(receipt.evidence.observedAt)));
});

test("production records its public checks and preserves the original staging receipt", (t) => {
  const result = operate(t, "production-success");
  assert.equal(result.status, 0, result.stderr);
  const receipt = result.read("production.json");
  assert.deepEqual(receipt.automated, {
    readiness: true,
    unauthorized: true,
    runtimeConfig: true,
  });
  assert.deepEqual(result.read("verified.json"), record());
  assert.equal(receipt.deployment.id, "prod-1");
  assert.equal(receipt.recovery.backupId, "backup-1");
  assert.deepEqual(receipt.approval.reviewers, [{ id: 7, login: "operator" }]);
  assert.match(receipt.stagedRecordHash, /^[a-f0-9]{64}$/);
  assert.match(receipt.planHash, /^[a-f0-9]{64}$/);
});

for (const scenario of [
  "stage-summary",
  "production-outcome-write",
  "production-both-sinks",
]) {
  test(`${scenario} still reports the deployment when a reporting sink fails`, (t) => {
    const result = operate(t, scenario);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Applied but unverified/);
    assert.match(
      result.stderr,
      scenario === "stage-summary"
        ? /Deployment deploy-1/
        : /Deployment prod-1/,
    );
    assert.ok(result.stderr.includes(record().image.reference));
    assert.match(result.stderr, /No rollback was performed/);
    if (scenario.startsWith("production-")) {
      assert.match(result.stderr, /release upload failed/);
      assert.match(result.stderr, /Could not write provider outcome/);
      assert.equal(
        result.stderr.trim().split("\n").at(-1),
        "release upload failed",
      );
      if (scenario === "production-both-sinks") {
        assert.match(result.stderr, /Could not write deployment summary/);
      } else {
        assert.match(
          readFileSync(join(result.dir, "summary.md"), "utf8"),
          /release upload failed/,
        );
      }
    } else {
      assert.equal(
        result.read("runtime-evidence/provider-outcome.json").deployment.id,
        "deploy-1",
      );
    }
  });
}

for (const [failure, message] of [
  ["deploy", /deployment observation failed/],
  ["observe", /active image observation failed/],
  ["public", /public check failed/],
  ["recheck", /main advanced/],
  ["browser", /browser check failed/],
  ["invalid", /readiness/],
  ["log", /deployment log request failed/],
  ["log-write", /EISDIR/],
  ["write", /EISDIR/],
]) {
  for (const operation of ["stage", "production"]) {
    if (
      operation === "production" &&
      ["browser", "invalid", "log", "log-write", "write"].includes(failure)
    )
      continue;
    test(`${operation} preserves the applied outcome after ${failure} failure`, (t) => {
      const result = operate(t, `${operation}-${failure}`);
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      const outcome = result.read("runtime-evidence/provider-outcome.json");
      assert.equal(outcome.status, "applied-but-unverified");
      assert.equal(
        outcome.deployment.id,
        operation === "stage" ? "deploy-1" : "prod-1",
      );
      assert.equal(outcome.image, record().image.reference);
      assert.match(outcome.reason, message);
      assert.match(
        readFileSync(join(result.dir, "summary.md"), "utf8"),
        /No rollback was performed/,
      );
    });
  }
}
