import { spawn } from "bun";
import { rm } from "node:fs/promises";
import { prettierCommand } from "./developer";

await Promise.all([
  rm(".audit/api-contract/openapi.json", { force: true }),
  rm(".audit/api-contract/responses.json", { force: true }),
]);

const commands = [
  ["node", "--test", "scripts/pr-evidence.test.mjs"],
  ["bun", "install", "--frozen-lockfile"],
  ["bun", "run", "check:types"],
  ["bun", "test", "scripts/doctor.test.ts", "scripts/developer.test.ts"],
  ["bun", "run", "doctor", "backend"],
  ["docker", "info", "--format", "{{.ServerVersion}}"],
  [
    "docker",
    "build",
    "--platform",
    "linux/amd64",
    "--target",
    "web",
    "--file",
    "release/Dockerfile",
    ".",
  ],
  ["dotnet", "tool", "restore"],
  ["dotnet", "restore", "--locked-mode"],
  [
    "dotnet",
    "restore",
    "--locked-mode",
    "--artifacts-path",
    ".audit/check-build",
  ],
  ["dotnet", "build", "--no-restore", "--artifacts-path", ".audit/check-build"],
  ["dotnet", "format", "--no-restore", "--verify-no-changes"],
  ["bun", "test", "tests/Browser/rest-client.test.ts"],
  prettierCommand(false),
  ["bun", "run", "--cwd", "web", "build"],
  ["bun", "run", "check:performance"],
  [
    "bun",
    "x",
    "--no-install",
    "vite",
    "build",
    "--config",
    "tests/Browser/vite.config.ts",
  ],
  [
    "dotnet",
    "test",
    "tests/Backend",
    "--no-build",
    "--artifacts-path",
    ".audit/check-build",
    "--logger",
    "trx",
    "--results-directory",
    ".audit/TestResults",
  ],

  ["node", "scripts/api-contract.mjs"],
  ["node", "node_modules/@playwright/test/cli.js", "install", "chromium"],
  [
    "node",
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "tests/Browser/playwright.config.ts",
  ],
];
for (const command of commands) {
  console.info(`Checking ${command.join(" ")}`);
  const result = await spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  if (result !== 0) process.exit(result);
}
