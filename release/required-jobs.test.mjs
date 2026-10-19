import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { gates } from "../.github/ci/required-jobs.mjs";

function run(gate, needs) {
  return spawnSync(process.execPath, [".github/ci/required-jobs.mjs", gate], {
    encoding: "utf8",
    env: { ...process.env, REQUIRED_JOBS: needs },
  });
}

test("release gate includes all thirteen required callable outcomes", () => {
  assert.deepEqual([...gates["release-controls"].needs].sort(), [
    "browser-compatibility",
    "current-image-recovery",
    "developer-experience",
    "evidence",
    "metadata-publication",
    "preview",
    "recovery",
    "runtime-policy",
    "security-codeql",
    "security-dependencies",
    "security-fixtures",
    "supply-pr",
    "tracing",
  ]);
});

for (const [gate, contract] of Object.entries(gates)) {
  const good = Object.fromEntries(
    contract.needs.map((name) => [name, { result: "success" }]),
  );
  test(`${gate} accepts exactly its successful prerequisites`, () => {
    const result = run(gate, JSON.stringify(good));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /all required jobs succeeded/);
  });
  test(`${gate} rejects extra prerequisites`, () => {
    const result = run(
      gate,
      JSON.stringify({ ...good, surprise: { result: "success" } }),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /extra: surprise/);
  });
  for (const name of contract.needs) {
    test(`${gate} rejects missing ${name}`, () => {
      const missing = structuredClone(good);
      delete missing[name];
      const result = run(gate, JSON.stringify(missing));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /missing: /);
    });
    for (const status of [
      "failure",
      "cancelled",
      "skipped",
      "unknown",
      null,
      undefined,
      0,
      true,
    ]) {
      test(`${gate} rejects ${name} result ${String(status)}`, () => {
        const bad = structuredClone(good);
        bad[name].result = status;
        const result = run(gate, JSON.stringify(bad));
        assert.equal(result.status, 1);
        assert.match(result.stderr, /result must be success/);
      });
    }
  }
}

test("gate CLI rejects unknown gate and malformed needs", () => {
  assert.match(run("surprise", "{}").stderr, /Unknown required gate/);
  assert.match(run("check", "{").stderr, /JSON/);
  for (const value of [null, [], 1, "success", false]) {
    const result = run("check", JSON.stringify(value));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs must be a job result object/);
  }
});
