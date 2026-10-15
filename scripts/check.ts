import { spawn } from "bun";

const commands = [
  ["docker", "info", "--format", "{{.ServerVersion}}"],
  ["bun", "install", "--frozen-lockfile"],
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
  ["bun", "run", "lint"],
  [
    "bun",
    "x",
    "--no-install",
    "prettier",
    "--check",
    "web",
    "tests/Browser",
    "scripts",
    "package.json",
    "eslint.config.mjs",
    ".github",
    "README.md",
    "AGENTS.md",
    "dev/Properties/launchSettings.json",
  ],
  ["bun", "run", "--cwd", "web", "build"],
  ["node", "node_modules/@playwright/test/cli.js", "install", "chromium"],
  [
    "node",
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "tests/Browser/playwright.config.ts",
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
