import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("monitor child reports spawn-error diagnostics and POSIX signal stream tails before refusal", async () => {
  const module = new URL("./monitor-conformance.mjs", import.meta.url).href;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  // Failed Windows spawns retain Node's timeout, so exit after the assertions.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { verifyMonitorChildFailure } from ${JSON.stringify(module)}; await verifyMonitorChildFailure(${JSON.stringify(root)}); process.exit(0);`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.error, undefined);
});
