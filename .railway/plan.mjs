import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [environment, reviewedSha] = process.argv.slice(2);

try {
  assert.ok(
    ["staging", "production"].includes(environment),
    "Plan only staging or production. Preview activation needs its separate review.",
  );
  assert.match(
    reviewedSha ?? "",
    /^[0-9a-f]{40}$/,
    "Supply the full independently reviewed commit SHA.",
  );
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(head.status, 0, "Cannot read the current commit.");
  assert.equal(
    head.stdout.trim(),
    reviewedSha,
    "Reviewed SHA must equal the current checkout.",
  );
  const status = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ".railway"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(status.status, 0, "Cannot verify authoring files.");
  assert.equal(
    status.stdout.trim(),
    "",
    "Commit and independently review every authoring change before a credentialed plan.",
  );
  const cli = process.env.RAILWAY_CLI ?? "railway";
  const version = spawnSync(cli, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(
    version.status,
    0,
    "Install the private pinned Railway CLI and set RAILWAY_CLI to its executable.",
  );
  assert.equal(
    version.stdout.trim(),
    "railway 5.70.0",
    "Use Railway CLI 5.70.0 with SDK 3.16.0.",
  );
  const plan = spawnSync(
    cli,
    [
      "config",
      "plan",
      "--file",
      ".railway/railway.ts",
      "--environment",
      environment,
      "--detailed-exit-code",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        CI: "true",
        RAILWAY_CALLER: "skill:use-railway@1.7.0",
        RAILWAY_AGENT_SESSION: "damadama-reviewed-plan",
      },
    },
  );
  if (plan.status === 0) {
    console.log(
      `${environment} live plan reports no changes for ${reviewedSha}.`,
    );
  } else if (plan.status === 2) {
    console.error(
      `${environment} has infrastructure drift. Review a fresh local redacted plan. Nothing was applied.`,
    );
    process.exitCode = 2;
  } else {
    console.error(
      `${environment} live plan failed. Verify legitimate CLI authentication and project linking, then retry. No live-plan verification is claimed.`,
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
