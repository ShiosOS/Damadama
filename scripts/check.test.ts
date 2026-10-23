import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "./check";
import { fixtureFormatCommand } from "./developer";

const source = fileURLToPath(new URL("../", import.meta.url));
const receiver = [
  "node",
  "--test",
  "ops/diagnostics/receiver.test.mjs",
  "ops/diagnostics/receiver-handshake.test.mjs",
];
const provider = ["node", "--test", "tests/Provider/*.test.mjs"];
const monitor = ["node", "--test", "ops/monitoring/monitor.test.mjs"];
const fonts = [
  "bun",
  "test",
  "tests/Browser/font-evidence.test.ts",
  "tests/Browser/font-evidence-files.test.ts",
  "tests/Browser/font-evidence-lifecycle.test.ts",
];
const dockerProbe = [
  "bun",
  "--no-env-file",
  "test",
  "scripts/doctor-docker.test.ts",
];
const clients = [
  "bun",
  "test",
  "tests/Browser/rest-client.test.ts",
  "tests/Browser/heatmap-client.test.ts",
];
type Producer =
  | "valid"
  | "missing"
  | "malformed"
  | "empty"
  | "failure"
  | "skipped"
  | "missing-trx";

const passingTrx =
  '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results><UnitTestResult executionId="1" testName="passing" outcome="Passed"/></Results><ResultSummary outcome="Completed"><Counters total="1" executed="1" passed="1" failed="0" notExecuted="0"/></ResultSummary></TestRun>';

async function child(argv: string[], root: string): Promise<number> {
  const process = Bun.spawn(argv, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, , exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return exit;
}

const produce = `
  import { writeFile } from 'node:fs/promises';
  import { consoleEvent } from './ops/diagnostics/receiver-fixtures.mjs';
  const events = [consoleEvent(), consoleEvent({Route:'/api/habits', Status:503, Classification:'storage-unavailable', TraceId:'storage:2'}), consoleEvent({Route:'/health/ready', Status:503, Classification:'readiness-unavailable', TraceId:'ready:3'})];
  const expected = events.map(({State:s}) => ({revision:s.Revision, environment:s.Environment, route:s.Route, status:s.Status, traceId:s.TraceId, classification:s.Classification}));
  await writeFile('.audit/receiver-console-fixture.json', JSON.stringify({lines:events.map(event => JSON.stringify(event)), expected}));
`;

test("common check stops when a real child cannot spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "check-spawn-"));
  const commands: string[][] = [];
  try {
    await assert.rejects(
      runCheck({
        root,
        execute: async (command, cwd) => {
          commands.push([...command]);
          return await child([join(root, "missing-check-executable")], cwd);
        },
      }),
    );
    expect(commands).toEqual([
      ["node", "--test", "scripts/pr-evidence.test.mjs"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function exercise(
  producer: Producer,
  failCommand?: string[],
): Promise<{
  commands: string[][];
  receipts: string[];
  error: unknown;
  fixtureExists: boolean;
}> {
  const root = await mkdtemp(join(tmpdir(), "common-check-"));
  const commands: string[][] = [];
  let error: unknown;
  try {
    await mkdir(join(root, ".audit"));
    await mkdir(join(root, ".audit/TestResults"));
    await writeFile(join(root, ".audit/TestResults/backend.trx"), passingTrx);
    await cp(join(source, "ops/diagnostics"), join(root, "ops/diagnostics"), {
      recursive: true,
    });
    expect(
      await child(["node", "--input-type=module", "-e", produce], root),
    ).toBe(0);
    await writeFile(join(root, "receipts.jsonl"), "");
    try {
      await runCheck({
        root,
        execute: async (command, cwd) => {
          commands.push([...command]);
          const receipt = `require('node:fs').appendFileSync('receipts.jsonl', ${JSON.stringify(JSON.stringify(command) + "\n")});`;
          let code = receipt;
          if (JSON.stringify(command) === JSON.stringify(failCommand))
            code += "process.exit(9);";
          if (command[0] === "dotnet" && command[1] === "test") {
            expect(
              await Bun.file(
                join(cwd, ".audit/TestResults/backend.trx"),
              ).exists(),
            ).toBe(false);
            if (producer !== "missing-trx") {
              let trx = passingTrx;
              if (producer === "skipped")
                trx = trx.replace('outcome="Passed"', 'outcome="NotExecuted"');
              await writeFile(join(cwd, ".audit/TestResults/backend.trx"), trx);
            }
            if (["valid", "skipped", "missing-trx"].includes(producer)) {
              expect(
                await child(
                  ["node", "--input-type=module", "-e", produce],
                  cwd,
                ),
              ).toBe(0);
            } else if (producer === "failure") code += "process.exit(8);";
            else if (producer === "malformed")
              code +=
                "require('node:fs').writeFileSync('.audit/receiver-console-fixture.json', '{bad');";
            else if (producer === "empty")
              code +=
                "require('node:fs').writeFileSync('.audit/receiver-console-fixture.json', '');";
          }
          const exit = await child(["node", "-e", code], cwd);
          if (exit !== 0) return exit;
          if (JSON.stringify(command) === JSON.stringify(receiver))
            return await child([...command], cwd);
          return exit;
        },
      });
    } catch (caught) {
      error = caught;
    }
    const receipts = (await readFile(join(root, "receipts.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(receipts).toEqual(
      commands.map((command) => JSON.stringify(command)),
    );
    return {
      commands,
      receipts,
      error,
      fixtureExists: await Bun.file(
        join(root, ".audit/receiver-console-fixture.json"),
      ).exists(),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("common check executes Provider and monitor before Docker and both real receiver consumers immediately after one backend producer", async () => {
  const { commands, receipts, error } = await exercise("valid");
  expect(error).toBeUndefined();
  expect(commands).toContainEqual(fonts);
  expect(
    commands.findIndex(
      (command) => JSON.stringify(command) === JSON.stringify(fonts),
    ),
  ).toBeLessThan(commands.findIndex((command) => command[0] === "docker"));
  expect(commands).toContainEqual([
    "bun",
    "test",
    "scripts/doctor.test.ts",
    "scripts/command-capture.test.ts",
    "scripts/doctor-process-tree.test.ts",
    "scripts/developer.test.ts",
    "scripts/check.test.ts",
    "scripts/acceptance-results.test.ts",
    "scripts/acceptance-browser.test.ts",
  ]);
  for (const required of [provider, monitor, dockerProbe]) {
    expect(
      receipts.filter((command) => command === JSON.stringify(required)),
    ).toHaveLength(1);
    expect(
      commands.findIndex(
        (command) => JSON.stringify(command) === JSON.stringify(required),
      ),
    ).toBeLessThan(commands.findIndex((command) => command[0] === "docker"));
  }
  const index = (required: string[]): number =>
    commands.findIndex(
      (command) => JSON.stringify(command) === JSON.stringify(required),
    );
  expect(index(dockerProbe)).toBeGreaterThan(index(provider));
  expect(index(dockerProbe)).toBeGreaterThan(index(monitor));
  expect(receipts).toContain(JSON.stringify(fixtureFormatCommand(false)));
  const backend = commands.filter(
    (command) => command[0] === "dotnet" && command[1] === "test",
  );
  expect(backend).toEqual([
    [
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
  ]);
  expect(
    commands[commands.findIndex((command) => command === backend[0]) + 1],
  ).toEqual(receiver);
  expect(receipts.at(-1)).toEqual(
    JSON.stringify([
      "node",
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "tests/Browser/playwright.config.ts",
    ]),
  );
}, 30_000);

test("common check runs both client boundary suites and refuses their failure before backend production", async () => {
  const passing = await exercise("valid");
  expect(passing.error).toBeUndefined();
  expect(
    passing.receipts.filter((command) => command === JSON.stringify(clients)),
  ).toHaveLength(1);

  const failing = await exercise("valid", clients);
  expect(failing.error).toBeInstanceOf(Error);
  expect(failing.commands.at(-1)).toEqual(clients);
  expect(
    failing.commands.some(
      (command) => command[0] === "dotnet" && command[1] === "test",
    ),
  ).toBe(false);
}, 30_000);

for (const producer of [
  "missing",
  "malformed",
  "empty",
  "failure",
] satisfies Producer[]) {
  test(`common check refuses ${producer} production and cannot reuse seeded valid bytes`, async () => {
    const { commands, error, fixtureExists } = await exercise(producer);
    expect(error).toBeInstanceOf(Error);
    expect(
      commands.some((command) => command.includes("scripts/api-contract.mjs")),
    ).toBe(false);
    if (producer === "missing" || producer === "failure")
      expect(fixtureExists).toBe(false);
    if (producer === "failure") {
      expect(
        commands.some(
          (command) => JSON.stringify(command) === JSON.stringify(receiver),
        ),
      ).toBe(false);
      expect(commands.at(-1)?.slice(0, 3)).toEqual([
        "dotnet",
        "test",
        "tests/Backend",
      ]);
    } else {
      expect(commands.at(-1)).toEqual(receiver);
    }
  }, 30_000);
}

for (const required of [provider, monitor, dockerProbe]) {
  test(`common check stops on real failed ${required[2]} child`, async () => {
    const { commands, error } = await exercise("valid", required);
    expect(error).toBeInstanceOf(Error);
    expect(commands.at(-1)).toEqual(required);
    expect(commands.some((command) => command[0] === "docker")).toBe(false);
  }, 30_000);
}

for (const producer of ["skipped", "missing-trx"] satisfies Producer[]) {
  test(`common check refuses ${producer} after the immediate receiver consumers and cannot reuse a seeded passing TRX`, async () => {
    const { commands, error } = await exercise(producer);
    expect(error).toBeInstanceOf(Error);
    expect(commands.at(-1)).toEqual(receiver);
    expect(
      commands.some((command) => command.includes("scripts/api-contract.mjs")),
    ).toBe(false);
  }, 30_000);
}
