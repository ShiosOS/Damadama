import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCommand, doctor } from "./doctor";

const secret = "doctor-test-private-sentinel";
type Capture = Awaited<ReturnType<typeof captureCommand>>;
type Command = Parameters<typeof captureCommand>[0];
type DoctorResult = Awaited<ReturnType<typeof doctor>>;
type Failure = Extract<DoctorResult["checks"][number], { kind: "fail" }>;

function failure(result: DoctorResult, id: string): Failure {
  const check = result.checks.find(
    (check) => check.id === id && check.kind === "fail",
  );
  if (!check || check.kind !== "fail")
    throw new Error(`Expected failing check ${id}.`);
  return check;
}

function runtimeFixture(
  overrides: Record<string, Capture> = {},
): (command: Command) => Promise<Capture> {
  const responses: Record<string, Capture> = {
    bun: { kind: "ok", output: "1.3.14" },
    node: { kind: "ok", output: "v24.21.0" },
    dotnet: { kind: "ok", output: "10.0.113" },
    docker: { kind: "ok", output: "linux" },
    ...overrides,
  };
  return async (command) => responses[command[0]] ?? { kind: "missing" };
}

function configuration(): NodeJS.ProcessEnv {
  return {
    Clerk__Issuer: `https://${secret}.example`,
    Clerk__PublishableKey: `pk_test_${secret}`,
    Parameters__postgresPassword: secret,
    Clerk__AuthorizedParties__0: "http://localhost:5173",
  };
}

async function listener(
  host: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host, ipv6Only: true }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP address.");
  return {
    port: address.port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => {
          if (error) return reject(error);
          resolve();
        }),
      ),
  };
}

async function availablePort(): Promise<number> {
  const socket = await listener("127.0.0.1");
  await socket.close();
  return socket.port;
}

describe("doctor policy with runtime observation fixtures (not host capability proof)", () => {
  test("backend accepts Node 24 without provider settings or application ports", async () => {
    const result = await doctor({
      args: ["backend"],
      environment: {},
      capture: runtimeFixture({ node: { kind: "ok", output: "v24.19.0" } }),
    });
    expect(result.exitCode).toBe(0);
    expect(
      result.checks.find((check) => check.id === "runtime.node")?.kind,
    ).toBe("pass");
    expect(result.checks.every((check) => check.kind === "pass")).toBe(true);
    expect(
      result.checks.some(
        (check) =>
          check.id.startsWith("config.") || check.id.startsWith("port."),
      ),
    ).toBe(false);
  });

  test.each([
    { kind: "missing" },
    { kind: "ok", output: "v22.20.0" },
  ] satisfies Capture[])(
    "backend rejects unavailable or incompatible Node %j",
    async (node) => {
      const result = await doctor({
        args: ["backend"],
        environment: {},
        capture: runtimeFixture({ node }),
      });
      expect(result.exitCode).toBe(1);
      expect(failure(result, "runtime.node").remedy).toContain("Node.js 24");
    },
  );

  test.each([
    "10.0.111",
    "10.0.200",
    "10.1.112",
    "11.0.112",
    "10.0.113-preview.1",
    secret,
  ])("rejects incompatible selected .NET SDK %s", async (output) => {
    const result = await doctor({
      args: ["backend"],
      capture: runtimeFixture({ dotnet: { kind: "ok", output } }),
    });
    expect(result.exitCode).toBe(1);
    expect(failure(result, "runtime.dotnet").remedy).toContain(
      "dotnet --version",
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("collects independent runtime failures and never repeats arbitrary child output", async () => {
    const result = await doctor({
      args: ["browser"],
      environment: { DAMADAMA_BROWSER_PORT: "bad", DAMADAMA_API_PORT: "bad" },
      capture: runtimeFixture({
        bun: { kind: "ok", output: `1.3.13 ${secret}` },
        node: { kind: "ok", output: `v26.8.1 ${secret}` },
        dotnet: { kind: "missing" },
        docker: { kind: "ok", output: `windows ${secret}` },
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.checks
        .filter((check) => check.kind === "fail")
        .map((check) => check.id),
    ).toEqual([
      "runtime.bun",
      "runtime.dotnet",
      "docker.linux",
      "runtime.node",
      "port.DAMADAMA_BROWSER_PORT",
      "port.DAMADAMA_API_PORT",
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(
      result.checks.every(
        (check) => check.kind === "pass" || check.remedy.length > 0,
      ),
    ).toBe(true);
  });

  test.each([
    "missing",
    "failed",
    "timeout",
    "output-limit",
  ] satisfies Capture["kind"][])(
    "reports a bounded Docker observation failure: %s",
    async (kind) => {
      const result = await doctor({
        args: ["backend"],
        capture: runtimeFixture({ docker: { kind } }),
      });
      expect(result.exitCode).toBe(1);
      const check = failure(result, "docker.linux");
      expect(check.message).toContain(kind);
      expect(check.remedy).toContain("Linux");
    },
  );

  test("start accepts configured names while hiding their values", async () => {
    const result = await doctor({
      args: [],
      environment: configuration(),
      capture: runtimeFixture(),
    });
    const settings = result.checks.filter((check) =>
      check.id.startsWith("config."),
    );
    expect(settings).toHaveLength(4);
    expect(settings.every((check) => check.kind === "pass")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    const ports = result.checks.filter((check) => check.id.startsWith("port."));
    expect(ports).toHaveLength(12);
    for (const port of [5050, 5173, 17100, 17101, 17201, 17301]) {
      expect(ports.some((check) => check.message.includes(String(port)))).toBe(
        true,
      );
    }
    expect(JSON.stringify(ports)).not.toContain("5432");
  });

  test.each([
    undefined,
    "",
    "  ",
    "replace-with-example",
    "pk_test_replace_with_example",
  ])(
    "rejects missing, blank, or documented placeholders without revealing settings",
    async (value) => {
      const environment = configuration();
      if (value === undefined) {
        delete environment["Clerk__Issuer"];
        delete environment["Clerk__PublishableKey"];
        delete environment["Parameters__postgresPassword"];
        delete environment["Clerk__AuthorizedParties__0"];
      } else {
        environment["Clerk__Issuer"] = value;
        environment["Clerk__PublishableKey"] = value;
        environment["Parameters__postgresPassword"] = value;
        environment["Clerk__AuthorizedParties__9"] = value;
      }
      const result = await doctor({
        args: ["start"],
        environment,
        capture: runtimeFixture(),
      });
      expect(result.exitCode).toBe(1);
      for (const name of [
        "Clerk__Issuer",
        "Clerk__PublishableKey",
        "Parameters__postgresPassword",
      ]) {
        expect(failure(result, `config.${name}`).remedy).toContain(
          ".env.example",
        );
      }
      expect(
        result.checks.some(
          (check) =>
            check.id.startsWith("config.Clerk__AuthorizedParties__") &&
            check.kind === "fail",
        ),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  test("browser accepts overridden free ports without Clerk settings and closes probes", async () => {
    const browser = await listener("127.0.0.1");
    const api = await listener("127.0.0.1");
    await Promise.all([browser.close(), api.close()]);
    const environment = {
      DAMADAMA_BROWSER_PORT: String(browser.port),
      DAMADAMA_API_PORT: String(api.port),
    };
    for (let count = 0; count < 2; count++) {
      const result = await doctor({
        args: ["browser"],
        environment,
        capture: runtimeFixture(),
      });
      expect(result.exitCode).toBe(0);
      expect(
        result.checks.some((check) => check.id.startsWith("config.")),
      ).toBe(false);
      expect(
        result.checks.filter((check) => check.id.startsWith("port.")),
      ).toHaveLength(4);
    }
  });

  test.each(["0", "65536", "-1", "1.5", "1e3", "", "NaN", " 5174 "])(
    "rejects invalid browser port %s",
    async (value) => {
      const result = await doctor({
        args: ["browser"],
        environment: { DAMADAMA_BROWSER_PORT: value, DAMADAMA_API_PORT: "bad" },
        capture: runtimeFixture(),
      });
      expect(result.exitCode).toBe(1);
      expect(failure(result, "port.DAMADAMA_BROWSER_PORT").message).toContain(
        "1 through 65535",
      );
    },
  );

  test("rejects duplicate effective browser and API ports before probing", async () => {
    const port = String(await availablePort());
    const result = await doctor({
      args: ["browser"],
      environment: { DAMADAMA_BROWSER_PORT: port, DAMADAMA_API_PORT: port },
      capture: runtimeFixture(),
    });
    expect(result.exitCode).toBe(1);
    expect(failure(result, "port.browser-distinct").remedy).toContain(
      "distinct free TCP ports",
    );
  });

  test.each([
    { args: ["--help"] },
    { args: ["unexpected"] },
    { args: ["backend", "extra"] },
  ])("invalid arguments cause no observations", async ({ args }) => {
    let calls = 0;
    const result = await doctor({
      args,
      capture: async () => {
        calls++;
        return { kind: "missing" };
      },
    });
    expect(result.exitCode).toBe(2);
    expect(calls).toBe(0);
    expect(failure(result, "usage").remedy).toContain(
      "[start|backend|browser]",
    );
  });
});

describe("real operating-system effects", () => {
  test("clean bootstrap needs no installed packages and sanitizes invalid runtime policies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "damadama-doctor-"));
    try {
      await mkdir(join(directory, "scripts"));
      await copyFile(
        new URL("./doctor.ts", import.meta.url),
        join(directory, "scripts", "doctor.ts"),
      );
      await writeFile(
        join(directory, "package.json"),
        '{"packageManager":"bun@1.3.14"}',
      );
      await writeFile(
        join(directory, "global.json"),
        '{"sdk":{"version":"10.0.112","rollForward":"latestPatch"}}',
      );
      const ready = Bun.spawn(
        [process.execPath, "--no-env-file", "scripts/doctor.ts", "backend"],
        { cwd: directory, stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(ready.stdout).text();
      await ready.exited;
      expect(output).toContain("[pass] runtime.bun");
      expect(output).toContain("docker.linux");
      for (const invalid of [
        JSON.stringify({ packageManager: secret }),
        '{"packageManager":"bun@wrong"}',
        "{}",
      ]) {
        await writeFile(join(directory, "package.json"), invalid);
        const child = Bun.spawn(
          [process.execPath, "--no-env-file", "scripts/doctor.ts", "backend"],
          { cwd: directory, stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode).toBe(1);
        expect(stdout).toContain("repository.runtimes");
        expect(stdout).toContain("Restore package.json");
        expect(stdout + stderr).not.toContain(secret);
      }
      await writeFile(
        join(directory, "package.json"),
        '{"packageManager":"bun@1.3.14"}',
      );
      for (const invalid of [
        secret,
        '{"sdk":{"version":"10.0.112","rollForward":"latestFeature"}}',
      ]) {
        await writeFile(join(directory, "global.json"), invalid);
        const child = Bun.spawn(
          [process.execPath, "--no-env-file", "scripts/doctor.ts", "backend"],
          { cwd: directory, stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode).toBe(1);
        expect(stdout).toContain("repository.runtimes");
        expect(stdout + stderr).not.toContain(secret);
      }
      await rm(join(directory, "global.json"));
      const missing = Bun.spawn(
        [process.execPath, "--no-env-file", "scripts/doctor.ts", "backend"],
        { cwd: directory, stdout: "pipe", stderr: "pipe" },
      );
      expect(await missing.exited).toBe(1);
      expect(await new Response(missing.stdout).text()).toContain(
        "repository.runtimes",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test.each(["127.0.0.1", "::1"])(
    "detects an actual listener on %s and leaves it running",
    async (host) => {
      const socket = await listener(host);
      try {
        const result = await doctor({
          args: ["browser"],
          environment: {
            DAMADAMA_BROWSER_PORT: String(socket.port),
            DAMADAMA_API_PORT: String(await availablePort()),
          },
          capture: runtimeFixture(),
        });
        expect(result.exitCode).toBe(1);
        expect(failure(result, "port.DAMADAMA_BROWSER_PORT").message).toContain(
          `occupied on ${host}`,
        );
      } finally {
        await socket.close();
      }
    },
  );

  test("captures successful child output and hides failed output", async () => {
    expect(
      await captureCommand([
        process.execPath,
        "--no-env-file",
        "-e",
        "console.info('24.21.0')",
      ]),
    ).toEqual({ kind: "ok", output: "24.21.0" });
    const failed = await captureCommand([
      process.execPath,
      "--no-env-file",
      "-e",
      `console.error('${secret}'); process.exit(7)`,
    ]);
    expect(failed).toEqual({ kind: "failed" });
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect(
      await captureCommand(["damadama-doctor-nonexistent-executable"]),
    ).toEqual({ kind: "missing" });
  });

  test("bounds real child time and stdout/stderr output", async () => {
    expect(
      await captureCommand(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          "setTimeout(() => {}, 30000)",
        ],
        { timeoutMs: 100 },
      ),
    ).toEqual({ kind: "timeout" });
    for (const stream of ["stdout", "stderr"]) {
      const result = await captureCommand(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `process.${stream}.write('${secret}'.repeat(1000))`,
        ],
        { maxBytes: 128 },
      );
      expect(result).toEqual({ kind: "output-limit" });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  test("real CLI returns usage exit 2 without leaking arbitrary arguments", async () => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "scripts/doctor.ts", secret],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(2);
    expect(output).toContain("Use bun run doctor");
    expect(output).not.toContain(secret);
    expect(await new Response(child.stderr).text()).not.toContain(secret);
  });
});
