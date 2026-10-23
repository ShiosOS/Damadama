import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prettierCommand, runDeveloper } from "./developer";

test("both generated formatter commands cover Provider and repair a malformed supported file", async () => {
  const root = await mkdtemp(join(tmpdir(), "common-format-"));
  try {
    const check = prettierCommand(false);
    const write = prettierCommand(true);
    expect(check.slice(5)).toEqual(write.slice(5));
    expect(
      check.slice(5).filter((path) => path === "tests/Provider"),
    ).toHaveLength(1);
    expect(check.slice(5)).toContain(".github");
    for (const path of check.slice(5)) {
      const target = join(root, path);
      if (/\.(json|mjs|md)$/.test(path)) {
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, path.endsWith(".json") ? "{}\n" : "");
      } else {
        await mkdir(target, { recursive: true });
        await writeFile(
          join(target, "fixture.mjs"),
          "export const value = 1;\n",
        );
      }
    }
    await writeFile(
      join(root, "tests/Provider/fixture.mjs"),
      "export const value={a:1}\n",
    );
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(root, "node_modules"),
      "junction",
    );
    async function run(command: string[]): Promise<number> {
      const child = Bun.spawn(command, {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [, , exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return exit;
    }
    expect(await run(check)).toBe(1);
    expect(await run(write)).toBe(0);
    expect(await run(check)).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("focused browser command rejects invalid configuration before installing or building", async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "run", "test:browser"],
    {
      env: {
        ...process.env,
        DAMADAMA_BROWSER_PORT: "invalid-private-sentinel",
        DAMADAMA_API_PORT: "0",
        NODE_ENV: "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(1);
  expect(stdout).toContain("DAMADAMA_BROWSER_PORT must be an integer");
  expect(stdout).not.toContain("Running bun install");
  expect(stdout + stderr).not.toContain("invalid-private-sentinel");
}, 30_000);

test("developer CLI rejects unknown commands with a useful exit", async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "scripts/developer.ts", "unknown"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stderr).text()).toContain(
    "format|format:check|test:backend|test:browser",
  );
});

for (const outcome of ["Passed", "NotExecuted", "missing"]) {
  test(`focused backend command requires fresh complete TRX after actual ${outcome} producer effects`, async () => {
    const root = await mkdtemp(join(tmpdir(), "developer-trx-"));
    try {
      const report = join(root, ".audit/TestResults/backend.trx");
      const trx =
        '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results><UnitTestResult executionId="1" testName="focused probe" outcome="Passed"/></Results><ResultSummary outcome="Completed"><Counters total="1" executed="1" passed="1" notExecuted="0"/></ResultSummary></TestRun>';
      await mkdir(join(root, ".audit/TestResults"), { recursive: true });
      await writeFile(report, trx);
      const run = runDeveloper({
        target: "test:backend",
        root,
        execute: async (command, cwd) => {
          if (command[0] !== "dotnet" || command[1] !== "test") return 0;
          expect(await Bun.file(report).exists()).toBe(false);
          expect(command).toContain("trx;LogFileName=backend.trx");
          if (outcome === "missing") return 0;
          const child = Bun.spawn(
            [
              "node",
              "-e",
              `require("node:fs").writeFileSync(process.argv[1], process.argv[2]);`,
              report,
              trx.replace('outcome="Passed"', `outcome="${outcome}"`),
            ],
            { cwd, stdout: "pipe", stderr: "pipe" },
          );
          return await child.exited;
        },
      });
      if (outcome === "Passed") expect(await run).toBe(0);
      else await assert.rejects(run);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("focused commands preserve a failing child's exit and stop before later effects", async () => {
  const commands: string[][] = [];
  const exit = await runDeveloper({
    target: "test:backend",
    root: process.cwd(),
    execute: async (command, cwd) => {
      commands.push(command);
      return await Bun.spawn(["node", "-e", "process.exit(9)"], { cwd }).exited;
    },
  });
  expect(exit).toBe(9);
  expect(commands).toEqual([["bun", "scripts/doctor.ts", "backend"]]);
});

for (const entry of ["module load", "browser doctor"]) {
  test(`cold checkout preserves ${entry} before installing acceptance dependencies`, async () => {
    const root = await mkdtemp(join(tmpdir(), "developer-cold-"));
    const source = fileURLToPath(new URL("../", import.meta.url));
    try {
      await mkdir(join(root, "scripts"));
      await mkdir(join(root, "node_modules"));
      for (const file of [
        "package.json",
        "global.json",
        "scripts/check.ts",
        "scripts/developer.ts",
        "scripts/doctor.ts",
        "scripts/command-capture.ts",
        "scripts/capture-helper.ts",
        "scripts/capture-windows.ts",
        "scripts/acceptance-results.ts",
      ]) {
        await cp(join(source, file), join(root, file));
      }
      let args = [
        "--eval",
        'await import("./scripts/check.ts"); console.info("cold module loaded");',
      ];
      if (entry === "browser doctor")
        args = ["scripts/developer.ts", "test:browser"];
      const child = Bun.spawn(
        [process.execPath, "--no-install", "--no-env-file", ...args],
        {
          cwd: root,
          env: {
            ...process.env,
            DAMADAMA_BROWSER_PORT: "invalid",
            DAMADAMA_API_PORT: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (entry === "module load") {
        expect(exit, stdout + stderr).toBe(0);
        expect(stdout).toContain("cold module loaded");
      } else {
        expect(exit, stdout + stderr).toBe(1);
        expect(stdout).toContain("DAMADAMA_BROWSER_PORT must be an integer");
        expect(stdout).not.toContain("Running bun install");
      }
      expect(stderr).not.toContain('Cannot find package "saxes"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
