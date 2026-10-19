import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prettierCommand } from "./developer";

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
