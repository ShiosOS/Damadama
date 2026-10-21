import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "node_modules/@playwright/test/cli.js");

async function probe(
  source: string,
  config: string,
  options = "",
): Promise<{ exit: number; output: string }> {
  await mkdir(join(root, ".audit/acceptance-browser"), { recursive: true });
  const directory = await mkdtemp(join(root, ".audit/acceptance-browser/run-"));
  try {
    const fixtureConfig = join(directory, "playwright.config.mjs");
    const imported = pathToFileURL(join(root, config)).href;
    await writeFile(
      fixtureConfig,
      `import base from ${JSON.stringify(imported)};
export default {
  ...base,
  testDir: ${JSON.stringify(directory)},
  testMatch: "case.spec.ts",
  webServer: [],
  outputDir: ${JSON.stringify(join(directory, "results"))},
  reporter: base.reporter.map(([name, options]) => {
    if (name === "html") return [name, {...options, outputFolder: ${JSON.stringify(join(directory, "html"))}}];
    if (name === "json") return [name, {...options, outputFile: ${JSON.stringify(join(directory, "raw.json"))}}];
    return [name, options];
  }),
  ${options}
};
`,
    );
    await writeFile(
      join(directory, "case.spec.ts"),
      `import { test, expect } from "@playwright/test";\n${source}\n`,
    );
    const child = Bun.spawn(["node", cli, "test", "--config", fixtureConfig], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exit, output: stdout + stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const config of [
  "tests/Browser/playwright.config.ts",
  ".agents/skills/verify/playwright.config.mjs",
]) {
  test(`actual ${config} accepts additional passing cases`, async () => {
    for (const count of [1, 2]) {
      const source = Array.from(
        { length: count },
        (_, index) => `test("pass ${index}", () => expect(true).toBe(true));`,
      ).join("\n");
      const result = await probe(source, config);
      expect(result.output).toContain(`${count} passed`);
      expect(result.exit).toBe(0);
    }
  }, 60_000);

  test(`actual ${config} refuses an empty suite`, async () => {
    const result = await probe("", config);
    expect(result.exit).not.toBe(0);
    expect(result.output).toContain("No tests found");
  }, 60_000);

  for (const [name, source, diagnostic, options] of [
    ["focused test", 'test.only("excluded", () => {});', "forbidOnly", ""],
    [
      "focused group",
      'test.describe.only("group", () => { test("excluded", () => {}); });',
      "forbidOnly",
      "",
    ],
    [
      "declared skip",
      'test.skip("excluded", () => {});',
      "observed skipped",
      "",
    ],
    [
      "runtime skip",
      'test("excluded", () => { test.skip(true, "probe"); });',
      "observed skipped",
      "",
    ],
    ["fixme", 'test.fixme("excluded", () => {});', "observed skipped", ""],
    [
      "mixed pass and skip",
      'test("pass", () => {}); test.skip("excluded", () => {});',
      "observed skipped",
      "",
    ],
    [
      "expected failure",
      'test("excluded", () => { test.fail(); expect(true).toBe(false); });',
      "expected failed",
      "",
    ],
    [
      "retried failure",
      'test("excluded", ({}, info) => { expect(info.retry).toBe(1); });',
      "observed failed, passed",
      "retries: 1,",
    ],
    [
      "unexecuted case",
      'test("first", () => { expect(true).toBe(false); }); test("excluded", () => {});',
      "not executed",
      "maxFailures: 1,",
    ],
  ] satisfies [string, string, string, string][]) {
    test(`actual ${config} rejects ${name}`, async () => {
      const result = await probe(source, config, options);
      expect(result.output).toContain(diagnostic);
      expect(result.exit).not.toBe(0);
    }, 60_000);
  }
}
