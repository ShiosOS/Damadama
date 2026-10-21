import { spawn } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const prettierPaths = [
  "web",
  "tests/Browser",
  "tests/Provider",
  "scripts",
  "package.json",
  "tsconfig.base.json",
  "eslint.config.mjs",
  ".github",
  ".vscode",
  "README.md",
  "AGENTS.md",
  "dev/README.md",
  "dev/Properties/launchSettings.json",
];

export function prettierCommand(write: boolean): [string, ...string[]] {
  let mode = "--check";
  if (write) mode = "--write";
  return ["bun", "x", "--no-install", "prettier", mode, ...prettierPaths];
}

function developerCommands(target: string): string[][] | undefined {
  if (target === "format" || target === "format:check") {
    const dotnet = ["dotnet", "format", "--no-restore"];
    if (target === "format:check") dotnet.push("--verify-no-changes");
    return [
      ["bun", "install", "--frozen-lockfile"],
      ["dotnet", "restore", "--locked-mode"],
      dotnet,
      prettierCommand(target === "format"),
    ];
  }
  if (target !== "test:backend" && target !== "test:browser") return undefined;
  let doctorTarget = "backend";
  let project = "tests/Backend";
  if (target === "test:browser") {
    doctorTarget = "browser";
    project = "tests/BrowserHost";
  }
  const commands = [
    ["bun", "scripts/doctor.ts", doctorTarget],
    ["bun", "install", "--frozen-lockfile"],
    ["bun", "run", "--cwd", "web", "build"],
    [
      "dotnet",
      "restore",
      project,
      "--locked-mode",
      "--artifacts-path",
      ".audit/check-build",
    ],
    [
      "dotnet",
      "build",
      project,
      "--no-restore",
      "--artifacts-path",
      ".audit/check-build",
    ],
  ];
  if (target === "test:backend") {
    commands.push([
      "dotnet",
      "test",
      project,
      "--no-build",
      "--artifacts-path",
      ".audit/check-build",
      "--logger",
      "trx;LogFileName=backend.trx",
      "--results-directory",
      ".audit/TestResults",
    ]);
    return commands;
  }
  commands.push(
    [
      "bun",
      "x",
      "--no-install",
      "vite",
      "build",
      "--config",
      "tests/Browser/vite.config.ts",
    ],
    ["node", "node_modules/@playwright/test/cli.js", "install", "chromium"],
    [
      "node",
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "tests/Browser/playwright.config.ts",
    ],
  );
  return commands;
}

export async function runDeveloper(options: {
  target: string;
  root: string;
  execute?: (command: string[], root: string) => Promise<number>;
}): Promise<number> {
  const commands = developerCommands(options.target);
  if (!commands)
    throw new RangeError(
      "Use bun scripts/developer.ts format|format:check|test:backend|test:browser.",
    );
  for (const command of commands) {
    const backend = command[0] === "dotnet" && command[1] === "test";
    const report = join(options.root, ".audit/TestResults/backend.trx");
    if (backend) await rm(report, { force: true });
    console.info(`Running ${command.join(" ")}`);
    let exitCode: number;
    if (options.execute)
      exitCode = await options.execute(command, options.root);
    else
      exitCode = await spawn(command, {
        cwd: options.root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).exited;
    if (exitCode !== 0) return exitCode;
    if (backend) {
      const { requireCompleteBackendResults } =
        await import("./acceptance-results");
      requireCompleteBackendResults(report);
    }
  }
  return 0;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3)
      throw new RangeError(
        "Use bun scripts/developer.ts format|format:check|test:backend|test:browser.",
      );
    process.exitCode = await runDeveloper({
      target: process.argv[2] ?? "",
      root: process.cwd(),
    });
  } catch (error) {
    console.error(error);
    process.exitCode = error instanceof RangeError ? 2 : 1;
  }
}
