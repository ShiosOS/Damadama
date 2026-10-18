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

for (const [gate, contract] of Object.entries(gates)) {
  const good = Object.fromEntries(
    contract.needs.map((name) => [name, { result: "success" }]),
  );
  test(`${gate} accepts exactly its successful prerequisites`, () => {
    const result = run(gate, JSON.stringify(good));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /all required jobs succeeded/);
  });
  test(`${gate} rejects missing and extra prerequisites`, () => {
    const missing = structuredClone(good);
    delete missing[contract.needs[0]];
    assert.match(run(gate, JSON.stringify(missing)).stderr, /missing: /);
    assert.match(
      run(gate, JSON.stringify({ ...good, surprise: { result: "success" } }))
        .stderr,
      /extra: surprise/,
    );
  });
  for (const status of ["failure", "cancelled", "skipped", "unknown", null]) {
    test(`${gate} rejects ${String(status)} prerequisite`, () => {
      const bad = structuredClone(good);
      bad[contract.needs[0]].result = status;
      const result = run(gate, JSON.stringify(bad));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /result must be success/);
    });
  }
}

test("gate CLI rejects unknown gate and malformed needs", () => {
  assert.match(run("surprise", "{}").stderr, /Unknown required gate/);
  assert.match(run("check", "{").stderr, /JSON/);
  assert.match(
    run("check", "null").stderr,
    /needs must be a job result object/,
  );
});
