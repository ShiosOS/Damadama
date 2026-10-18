import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("plan.mjs", import.meta.url));
for (const environment of ["preview-base", "pr-42", "Production", ""]) {
  test(`credentialed plan refuses ${environment || "missing environment"}`, () => {
    const result = spawnSync(
      process.execPath,
      [file, environment, "0".repeat(40)],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Plan only staging or production/);
  });
}
test("credentialed plan requires the exact reviewed checkout before invoking Railway", () => {
  const result = spawnSync(
    process.execPath,
    [file, "staging", "0".repeat(40)],
    {
      encoding: "utf8",
      env: { ...process.env, RAILWAY_CLI: "missing-railway-binary" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Reviewed SHA must equal the current checkout/);
});
