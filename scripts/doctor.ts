import { spawn } from "node:child_process";
import { createServer } from "node:net";

type Command = [string, ...string[]];
type Capture =
  | { kind: "ok"; output: string }
  | { kind: "missing" | "failed" | "timeout" | "output-limit" };
type Check =
  | { id: string; kind: "pass"; message: string }
  | { id: string; kind: "fail"; message: string; remedy: string };
type Target = "start" | "backend" | "browser";
type Port = { name: string; number: number };
type RuntimePolicy = { bun: string; sdk: string };

const targets = {
  start: { config: true },
  backend: { config: false },
  browser: { config: false },
} satisfies Record<Target, { config: boolean }>;

export function captureCommand(
  command: Command,
  { timeoutMs = 10_000, maxBytes = 4096 } = {},
): Promise<Capture> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let bytes = 0;
    let stopped: Capture | undefined;
    const stop = (result: Capture): void => {
      stopped = result;
      clearTimeout(timer);
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      stop({ kind: "timeout" });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (data: string, retain: boolean): void => {
      bytes += Buffer.byteLength(data);
      if (bytes > maxBytes) {
        if (!stopped) stop({ kind: "output-limit" });
        return;
      }
      if (retain) output += data;
    };
    child.stdout.on("data", (data: string) => collect(data, true));
    child.stderr.on("data", (data: string) => collect(data, false));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        stopped ??= { kind: "missing" };
        return;
      }
      stopped ??= { kind: "failed" };
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped) return resolve(stopped);
      if (code !== 0) return resolve({ kind: "failed" });
      resolve({ kind: "ok", output: output.trim() });
    });
  });
}

function fail(id: string, message: string, remedy: string): Check {
  return { id, kind: "fail", message, remedy };
}

function runtimeCheck(
  id: string,
  observation: Capture,
  accepts: (output: string) => boolean,
  requirement: string,
  remedy: string,
): Check {
  if (observation.kind === "ok" && accepts(observation.output)) {
    return { id, kind: "pass", message: requirement };
  }
  let reason = "unsupported or malformed response";
  if (observation.kind !== "ok") reason = observation.kind;
  return fail(id, `${requirement}: ${reason}.`, remedy);
}

async function readRuntimePolicy(): Promise<RuntimePolicy | undefined> {
  try {
    const metadata: unknown = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();
    const global: unknown = await Bun.file(
      new URL("../global.json", import.meta.url),
    ).json();
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("packageManager" in metadata) ||
      typeof metadata.packageManager !== "string"
    )
      return undefined;
    const bun = /^bun@(\d+\.\d+\.\d+)$/.exec(metadata.packageManager)?.[1];
    if (
      !bun ||
      typeof global !== "object" ||
      global === null ||
      !("sdk" in global)
    )
      return undefined;
    const sdk = global.sdk;
    if (
      typeof sdk !== "object" ||
      sdk === null ||
      !("version" in sdk) ||
      typeof sdk.version !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(sdk.version) ||
      !("rollForward" in sdk) ||
      sdk.rollForward !== "latestPatch"
    )
      return undefined;
    return { bun, sdk: sdk.version };
  } catch {
    return undefined;
  }
}

function acceptsSdk(output: string, requiredVersion: string): boolean {
  const required = requiredVersion.split(".").map(Number);
  const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(output);
  if (!actual) return false;
  const [, major, minor, patch] = actual;
  const [requiredMajor, requiredMinor, requiredPatch] = required;
  if (requiredPatch === undefined) return false;
  return (
    Number(major) === requiredMajor &&
    Number(minor) === requiredMinor &&
    Math.floor(Number(patch) / 100) === Math.floor(requiredPatch / 100) &&
    Number(patch) >= requiredPatch
  );
}

function configured(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return !/replace[-_]with/i.test(value);
}

function configurationChecks(environment: NodeJS.ProcessEnv): Check[] {
  const names = [
    "Clerk__Issuer",
    "Clerk__PublishableKey",
    "Parameters__postgresPassword",
  ];
  const parties = Object.keys(environment).filter((name) =>
    /^Clerk__AuthorizedParties__\d+$/.test(name),
  );
  if (parties.length === 0) names.push("Clerk__AuthorizedParties__0");
  names.push(...parties.sort());
  return names.map((name) => {
    const id = `config.${name}`;
    if (configured(environment[name])) {
      return { id, kind: "pass", message: `${name} is configured.` };
    }
    return fail(
      id,
      `${name} is missing, blank, or a placeholder.`,
      `Set ${name} in .env.local using .env.example. Keep its value private.`,
    );
  });
}

function browserPort(
  name: string,
  fallback: number,
  environment: NodeJS.ProcessEnv,
): Port | Check {
  const value = environment[name] ?? String(fallback);
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    if (number >= 1 && number <= 65535) return { name, number };
  }
  return fail(
    `port.${name}`,
    `${name} must be an integer from 1 through 65535.`,
    `Unset ${name} to use ${fallback}, or set a free TCP port in that range.`,
  );
}

async function probePort(port: Port, host: string): Promise<Check> {
  return new Promise((resolve) => {
    const server = createServer();
    const id = `port.${port.name}`;
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (
        host === "::1" &&
        (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL")
      ) {
        resolve({ id, kind: "pass", message: `IPv6 loopback is unavailable.` });
        return;
      }
      if (error.code === "EADDRINUSE") {
        resolve(
          fail(
            id,
            `${port.name} TCP port ${port.number} is occupied on ${host}.`,
            "Stop the owning application yourself or choose a supported port override.",
          ),
        );
        return;
      }
      resolve(
        fail(
          id,
          `${port.name} TCP port ${port.number} cannot be probed on ${host}.`,
          "Check local socket permissions and loopback networking, then retry.",
        ),
      );
    });
    server.listen(
      { port: port.number, host, exclusive: true, ipv6Only: true },
      () => {
        server.close(() =>
          resolve({
            id,
            kind: "pass",
            message: `${port.name} TCP port ${port.number} is available on ${host}.`,
          }),
        );
      },
    );
  });
}

function targetPorts(
  target: Target,
  environment: NodeJS.ProcessEnv,
): (Port | Check)[] {
  if (target === "backend") return [];
  if (target === "browser") {
    const browser = browserPort("DAMADAMA_BROWSER_PORT", 5174, environment);
    const api = browserPort("DAMADAMA_API_PORT", 5055, environment);
    if (
      "number" in browser &&
      "number" in api &&
      browser.number === api.number
    ) {
      return [
        fail(
          "port.browser-distinct",
          "Browser and API fixture ports must be different.",
          "Set DAMADAMA_BROWSER_PORT and DAMADAMA_API_PORT to distinct free TCP ports, or unset both for the defaults.",
        ),
      ];
    }
    return [browser, api];
  }
  return [
    { name: "API", number: 5050 },
    { name: "Vite", number: 5173 },
    { name: "Aspire HTTPS dashboard", number: 17100 },
    { name: "Aspire HTTP dashboard", number: 17101 },
    { name: "Aspire OTLP", number: 17201 },
    { name: "Aspire resource service", number: 17301 },
  ];
}

export async function doctor({
  args,
  environment = process.env,
  capture = captureCommand,
}: {
  args: readonly string[];
  environment?: NodeJS.ProcessEnv;
  capture?: (command: Command) => Promise<Capture>;
}): Promise<{ exitCode: number; checks: Check[] }> {
  const target = args[0] ?? "start";
  if (
    args.length > 1 ||
    (target !== "start" && target !== "backend" && target !== "browser")
  ) {
    return {
      exitCode: 2,
      checks: [
        fail(
          "usage",
          "Unknown doctor target or extra arguments.",
          "Use bun run doctor [start|backend|browser].",
        ),
      ],
    };
  }
  const policy = targets[target];
  const runtimes = await readRuntimePolicy();
  if (!runtimes) {
    return {
      exitCode: 1,
      checks: [
        fail(
          "repository.runtimes",
          "Runtime policy cannot be read.",
          "Restore package.json's exact Bun packageManager pin and global.json's SDK version with latestPatch, then retry.",
        ),
      ],
    };
  }
  const bunVersion = runtimes.bun;
  const checks = await Promise.all([
    capture(["bun", "--version"]).then((result) =>
      runtimeCheck(
        "runtime.bun",
        result,
        (value) => value === bunVersion,
        `Bun ${bunVersion} required by package.json`,
        "Select the packageManager version of Bun in this project's PATH.",
      ),
    ),
    capture(["dotnet", "--version"]).then((result) =>
      runtimeCheck(
        "runtime.dotnet",
        result,
        (value) => acceptsSdk(value, runtimes.sdk),
        `.NET ${runtimes.sdk} or a later patch in the same feature band (global.json latestPatch)`,
        "Install a compatible .NET SDK and run dotnet --version from the repository root.",
      ),
    ),
    capture(["docker", "info", "--format", "{{.OSType}}"]).then((result) =>
      runtimeCheck(
        "docker.linux",
        result,
        (value) => value === "linux",
        "Reachable Linux Docker engine required",
        "Install Docker if missing, start it, and select its Linux container engine, then retry. Doctor never starts it.",
      ),
    ),
  ]);
  checks.push(
    runtimeCheck(
      "runtime.node",
      await capture(["node", "--version"]),
      (value) => /^v24\.\d+\.\d+$/.test(value),
      "Node.js 24 required",
      "Select Node.js 24 in this project's process PATH; keep other projects' runtimes unchanged.",
    ),
  );
  if (policy.config) checks.push(...configurationChecks(environment));
  for (const port of targetPorts(target, environment)) {
    if ("kind" in port) {
      checks.push(port);
      continue;
    }
    checks.push(
      ...(await Promise.all([
        probePort(port, "127.0.0.1"),
        probePort(port, "::1"),
      ])),
    );
  }
  let exitCode = 0;
  if (checks.some((check) => check.kind === "fail")) exitCode = 1;
  return { exitCode, checks };
}

function printChecks(checks: Check[]): void {
  for (const check of checks) {
    console.info(`[${check.kind}] ${check.id}: ${check.message}`);
    if (check.kind === "fail") console.info(`  Fix: ${check.remedy}`);
  }
}

if (import.meta.main) {
  const result = await doctor({ args: process.argv.slice(2) });
  printChecks(result.checks);
  process.exitCode = result.exitCode;
}
