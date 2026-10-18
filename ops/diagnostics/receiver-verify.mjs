import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Use Node.js 24 to verify the receiver.");
mkdirSync(new URL("../../.audit", import.meta.url), { recursive: true });
rmSync(new URL("../../.audit/receiver-console-fixture.json", import.meta.url), {
  force: true,
});
for (const [command, args] of [
  ["dotnet", ["restore", "tests/Backend", "--locked-mode"]],
  [
    "dotnet",
    [
      "test",
      "tests/Backend",
      "--no-restore",
      "--filter",
      "FullyQualifiedName~Damadama.ReceiverProtocol",
      "--logger",
      "trx;LogFileName=receiver-formatter.trx",
      "--results-directory",
      ".audit/receiver-results",
    ],
  ],
  [
    process.execPath,
    [
      "--test",
      "ops/diagnostics/receiver.test.mjs",
      "ops/diagnostics/receiver-handshake.test.mjs",
    ],
  ],
]) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    process.exitCode = 1;
    break;
  }
}
