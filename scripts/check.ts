import { spawn } from "bun";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fixtureFormatCommand, prettierCommand } from "./developer";

type Command = readonly [string, ...string[]];
type CheckStep =
  | { kind: "command"; argv: Command }
  | { kind: "backend-and-receiver"; backend: Command };
type Execute = (command: Command, root: string) => Promise<number>;

const beforeBackend: Command[] = [
  ["node", "--test", "scripts/pr-evidence.test.mjs"],
  ["bun", "install", "--frozen-lockfile"],
  ["bun", "run", "check:types"],
  ["bun", "run", "check:railway"],
  [
    "bun",
    "test",
    "scripts/doctor.test.ts",
    "scripts/developer.test.ts",
    "scripts/check.test.ts",
    "scripts/acceptance-results.test.ts",
    "scripts/acceptance-browser.test.ts",
  ],
  ["node", "--test", "tests/Provider/*.test.mjs"],
  ["node", "--test", "ops/monitoring/monitor.test.mjs"],
  ["bun", "--no-env-file", "test", "scripts/doctor-docker.test.ts"],
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
  fixtureFormatCommand(false),
  ["bun", "test", "scripts/acceptance-native.test.ts"],
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
];
const afterBackend: Command[] = [
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
const steps: CheckStep[] = [
  ...beforeBackend.map((argv): CheckStep => ({ kind: "command", argv })),
  {
    kind: "backend-and-receiver",
    backend: [
      "dotnet",
      "test",
      "tests/Backend",
      "--no-build",
      "--artifacts-path",
      ".audit/check-build",
      "--logger",
      "trx;LogFileName=backend.trx",
      "--results-directory",
      ".audit/TestResults",
    ],
  },
  ...afterBackend.map((argv): CheckStep => ({ kind: "command", argv })),
];

async function execute(command: Command, root: string): Promise<number> {
  return await spawn([...command], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
}

export async function runCheck(options: {
  root: string;
  execute?: Execute;
}): Promise<void> {
  const run = options.execute ?? execute;
  const { root } = options;
  await Promise.all([
    rm(join(root, ".audit/api-contract/openapi.json"), { force: true }),
    rm(join(root, ".audit/api-contract/responses.json"), { force: true }),
  ]);
  async function requireSuccess(command: Command): Promise<void> {
    console.info(`Checking ${command.join(" ")}`);
    const exit = await run(command, root);
    if (exit !== 0)
      throw new Error(`Check failed (${exit}): ${command.join(" ")}`);
  }
  for (const step of steps) {
    if (step.kind === "command") {
      await requireSuccess(step.argv);
    } else {
      await rm(join(root, ".audit/TestResults/backend.trx"), { force: true });
      await rm(join(root, ".audit/receiver-console-fixture.json"), {
        force: true,
      });
      await requireSuccess(step.backend);
      await requireSuccess([
        "node",
        "--test",
        "ops/diagnostics/receiver.test.mjs",
        "ops/diagnostics/receiver-handshake.test.mjs",
      ]);
      const { requireCompleteBackendResults } =
        await import("./acceptance-results");
      requireCompleteBackendResults(
        join(root, ".audit/TestResults/backend.trx"),
      );
    }
  }
}

if (import.meta.main)
  await runCheck({ root: fileURLToPath(new URL("../", import.meta.url)) });
