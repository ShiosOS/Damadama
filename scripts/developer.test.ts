import { expect, test } from "bun:test";

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
