import { spawn } from "bun";

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
      "trx",
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

if (import.meta.main) {
  const commands = developerCommands(process.argv[2] ?? "");
  if (!commands || process.argv.length !== 3) {
    console.error(
      "Use bun scripts/developer.ts format|format:check|test:backend|test:browser.",
    );
    process.exit(2);
  }
  for (const command of commands) {
    console.info(`Running ${command.join(" ")}`);
    const exitCode = await spawn(command, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).exited;
    if (exitCode !== 0) process.exit(exitCode);
  }
}
