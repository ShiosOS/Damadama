import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

type ResponseFixture =
  | { kind: "os"; os: string }
  | {
      kind:
        | "missing"
        | "no-server"
        | "malformed"
        | "http-error"
        | "timeout"
        | "overflow"
        | "unreachable";
    };
const privateMarker = "doctor-docker-private-fixture";
const root = resolve(import.meta.dirname, "..");
const output = join(root, ".audit/doctor-docker");
const executable = Bun.which("docker");
assert.ok(
  executable,
  "The real Docker CLI is required. No daemon is used by this test.",
);
const commandResult = z.object({
  result: z.object({
    exitCode: z.number(),
    checks: z.array(
      z.object({ id: z.string(), kind: z.enum(["pass", "fail"]) }).loose(),
    ),
  }),
  selected: z.array(z.string()),
  captureKind: z.enum(["ok", "missing", "failed", "timeout", "output-limit"]),
  linuxOutput: z.boolean(),
  partialLinux: z.boolean(),
});
const controlResult = z.object({
  observation: z.object({ kind: z.literal("ok"), output: z.string() }),
});
const records: unknown[] = [];
let directory: string;
let plugins: string;
let dotnetRoot: string;
let fixtureRetired = false;
const cleanup: {
  scope: "build" | "case" | "fixture";
  kind: "retired" | "removed" | "preserved" | "failed";
  code?: string;
}[] = [];
let buildObservation:
  | { kind: "unverified" }
  | {
      kind: "completed";
      exitCode: number;
      signalCode: string | number | null;
    } = {
  kind: "unverified",
};
const pluginIdentity = z.object({
  executable: z.literal("docker-doctorprobe"),
  pid: z.number().int().positive(),
});

async function removeOwned(path: string): Promise<void> {
  const absolute = resolve(path);
  const owner = await realpath(output);
  assert.equal(
    relative(resolve(output), owner),
    "",
    "The proof directory must not be redirected.",
  );
  assert.equal(
    relative(absolute, await realpath(absolute)),
    "",
    "The fixture must not be redirected.",
  );
  assert.equal((await lstat(absolute)).isSymbolicLink(), false);
  const inside = relative(owner, absolute);
  assert.ok(
    inside && !inside.startsWith("..") && !isAbsolute(inside),
    "Remove only a resolved child of the owned proof directory.",
  );
  await rm(absolute, { recursive: true, force: true });
}

beforeAll(async () => {
  await mkdir(output, { recursive: true });
  await rm(join(output, "receipt.json"), { force: true });
  await rm(join(output, "cleanup.json"), { force: true });
  directory = await mkdtemp(join(output, "fixture-"));
  plugins = join(directory, "plugins");
  const build = Bun.spawn(
    [
      "dotnet",
      "build",
      "scripts/fixtures/docker-doctorprobe/docker-doctorprobe.csproj",
      "--output",
      plugins,
      "--artifacts-path",
      join(directory, "build"),
      "--nologo",
      "--verbosity",
      "quiet",
      "--disable-build-servers",
      "-nodeReuse:false",
      "-p:UseSharedCompilation=false",
      "-p:RestoreLockedMode=true",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MSBUILDDISABLENODEREUSE: "1",
        DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      killSignal: "SIGKILL",
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  buildObservation = {
    kind: "completed",
    exitCode: exit,
    signalCode: build.signalCode,
  };
  assert.equal(exit, 0, `Native plugin build failed.\n${stdout}\n${stderr}`);
  assert.equal(
    build.signalCode,
    null,
    "A bounded build failure preserves its fixture.",
  );
  fixtureRetired = true;
  cleanup.push({ scope: "build", kind: "retired" });
  const dotnet = Bun.which("dotnet");
  assert.ok(dotnet);
  dotnetRoot = resolve(dotnet, "..");
}, 75_000);

afterAll(async () => {
  await writeFile(
    join(output, "receipt.json"),
    JSON.stringify(
      {
        source: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        diff: execFileSync("git", ["diff", "--name-only", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .filter(Boolean),
        platform: process.platform,
        bun: Bun.version,
        build: buildObservation,
        dockerSha256: createHash("sha256")
          .update(await readFile(executable))
          .digest("hex"),
        records,
      },
      null,
      2,
    ) + "\n",
  );
  try {
    if (directory && fixtureRetired) {
      await removeOwned(directory);
      cleanup.push({ scope: "fixture", kind: "removed" });
    } else cleanup.push({ scope: "fixture", kind: "preserved" });
  } catch (error) {
    let code = "unknown";
    if (
      error instanceof Error &&
      "code" in error &&
      ["EBUSY", "EACCES", "EPERM", "ENOENT"].includes(String(error.code))
    )
      code = String(error.code);
    cleanup.push({ scope: "fixture", kind: "failed", code });
    throw error;
  } finally {
    await writeFile(
      join(output, "cleanup.json"),
      JSON.stringify({ fixtureRetired, outcomes: cleanup }, null, 2) + "\n",
    );
  }
});

async function invoke(
  fixture: ResponseFixture,
  mode = "doctor",
): Promise<{
  value: unknown;
  requests: { method: string; path: string }[];
  invocations: string[];
}> {
  const scope = await mkdtemp(join(directory, "case-"));
  const config = join(scope, "config");
  const ledger = join(scope, "ledger");
  await mkdir(config);
  await mkdir(ledger);
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({ cliPluginsExtraDirs: [plugins] }),
  );
  const requests: { method: string; path: string }[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    requests.push({ method: request.method ?? "", path });
    if (path === "/_ping") {
      response.setHeader("API-Version", "1.47");
      response.end("OK");
      return;
    }
    const endpoint = path.replace(/^\/v\d+\.\d+/, "");
    if (endpoint !== "/info" && endpoint !== "/version") {
      response
        .writeHead(404)
        .end(JSON.stringify({ message: "Unexpected fixture endpoint" }));
      return;
    }
    response.setHeader("Content-Type", "application/json");
    const respond = (): void => {
      if (fixture.kind === "http-error") {
        response.writeHead(500).end(JSON.stringify({ message: privateMarker }));
      } else if (fixture.kind === "malformed") {
        response.end(privateMarker);
      } else if (fixture.kind === "no-server") {
        response.end("null");
      } else {
        let os = "";
        if (fixture.kind === "os") os = fixture.os;
        if (fixture.kind === "overflow") os = privateMarker.repeat(1000);
        const data: {
          Version: string;
          ApiVersion: string;
          MinAPIVersion: string;
          ServerVersion: string;
          Os?: string;
          OSType?: string;
        } = {
          Version: "fixture",
          ApiVersion: "1.47",
          MinAPIVersion: "1.24",
          ServerVersion: "fixture",
        };
        if (fixture.kind !== "missing") {
          data.Os = os;
          data.OSType = os;
        }
        response.end(JSON.stringify(data));
      }
    };
    if (fixture.kind === "timeout") {
      void delay(1000).then(() => {
        if (!response.destroyed) respond();
      });
    } else respond();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  if (fixture.kind === "unreachable")
    await new Promise<void>((resolve) => server.close(() => resolve()));
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.toUpperCase().startsWith("DOCKER_") &&
        !name.startsWith("DAMADAMA_DOCKER_"),
    ),
  );
  let scopeRetired = false;
  Object.assign(environment, {
    DOCKER_HOST: `tcp://127.0.0.1:${address.port}`,
    DOCKER_CONFIG: config,
    DAMADAMA_DOCKER_CLI: executable,
    DAMADAMA_DOCKER_PLUGIN_LEDGER: ledger,
    DAMADAMA_DOCKER_TIMEOUT_MS: fixture.kind === "timeout" ? "500" : "10000",
  });
  if (process.platform === "win32")
    Object.assign(environment, {
      ProgramFiles: scope,
      ProgramData: scope,
      DOTNET_ROOT_X64: dotnetRoot,
    });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(root, "scripts/fixtures/doctor-docker-child.ts"),
        mode,
      ],
      {
        cwd: scope,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const files = await readdir(ledger);
    const invoked = files.filter((name) => name.endsWith(".invoked")).sort();
    const completed = files
      .filter((name) => name.endsWith(".completed"))
      .sort();
    assert.deepEqual(
      completed,
      invoked.map((name) => name.replace(/\.invoked$/, ".completed")),
      "Every finite plugin must complete before fixture removal.",
    );
    const invocations = await Promise.all(
      invoked.map(async (name) => {
        const started = await readFile(join(ledger, name), "utf8");
        assert.equal(
          await readFile(
            join(ledger, name.replace(/\.invoked$/, ".completed")),
            "utf8",
          ),
          started,
        );
        const identity = pluginIdentity.parse(JSON.parse(started));
        assert.throws(
          () => process.kill(identity.pid, 0),
          (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "ESRCH",
          "The completed finite plugin must already be absent.",
        );
        return identity.executable;
      }),
    );
    assert.equal(exit, 0, "Controlled doctor child must finish normally.");
    assert.equal(
      child.signalCode,
      null,
      "A bounded worker failure preserves its fixture.",
    );
    scopeRetired = true;
    assert.equal(stderr, "");
    const value: unknown = JSON.parse(stdout);
    for (const { method, path } of requests) {
      assert.ok(
        (path === "/_ping" && (method === "HEAD" || method === "GET")) ||
          (method === "GET" &&
            /^\/(?:v\d+\.\d+\/)?(?:info|version)$/.test(path)),
        "Only the client's ping and exact read endpoints are allowed.",
      );
    }
    records.push({
      fixture,
      mode,
      requests,
      invocations,
      value,
      completed: true,
    });
    return { value, requests, invocations };
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (scopeRetired) {
      try {
        await removeOwned(scope);
        cleanup.push({ scope: "case", kind: "removed" });
      } catch (error) {
        fixtureRetired = false;
        cleanup.push({ scope: "case", kind: "failed" });
        throw error;
      }
    } else {
      fixtureRetired = false;
      cleanup.push({ scope: "case", kind: "preserved" });
    }
  }
}

test("doctor reads the server OS without executing accepted client plugins", async () => {
  const identity = await invoke({ kind: "os", os: "linux" }, "identity");
  assert.match(
    controlResult.parse(identity.value).observation.output,
    /^Docker version \d+\.\d+\.\d+, build [a-f0-9]+$/,
  );
  let mode = "plugin";
  let expected = "Finite doctor plugin accepted";
  if (process.platform === "win32") {
    mode = "control";
    expected = "linux Damadama 1.0.0 <nil>";
  }
  const old = await invoke({ kind: "os", os: "linux" }, mode);
  assert.equal(controlResult.parse(old.value).observation.output, expected);
  assert.ok(
    old.invocations.includes("docker-doctorprobe"),
    "Old info must execute the valid native sentinel.",
  );
  if (process.platform === "win32")
    assert.ok(
      old.requests.some(({ path }) => /\/(?:v\d+\.\d+\/)?info$/.test(path)),
    );
  const current = await invoke({ kind: "os", os: "linux" });
  const result = commandResult.parse(current.value);
  assert.equal(result.result.exitCode, 0);
  assert.equal(result.linuxOutput, true);
  assert.deepEqual(
    current.invocations,
    [],
    "Doctor must avoid client plugin discovery.",
  );
  assert.ok(
    current.requests.some(({ path }) =>
      /\/(?:v\d+\.\d+\/)?version$/.test(path),
    ),
    "Doctor must read the server version endpoint.",
  );
  assert.equal(
    current.requests.some(({ path }) => /\/info$/.test(path)),
    false,
  );
}, 50_000);

for (const fixture of [
  { kind: "os", os: "windows" },
  { kind: "os", os: "" },
  { kind: "os", os: "unknown" },
  { kind: "missing" },
  { kind: "no-server" },
  { kind: "malformed" },
  { kind: "http-error" },
  { kind: "os", os: privateMarker },
  { kind: "timeout" },
  { kind: "overflow" },
  { kind: "unreachable" },
] satisfies ResponseFixture[]) {
  test(`doctor refuses controlled Docker ${JSON.stringify(fixture)}`, async () => {
    const current = await invoke(fixture);
    const result = commandResult.parse(current.value);
    assert.equal(result.result.exitCode, 1);
    assert.equal(
      result.result.checks.find(({ id }) => id === "docker.linux")?.kind,
      "fail",
    );
    assert.equal(JSON.stringify(result.result).includes(privateMarker), false);
    assert.deepEqual(current.invocations, []);
    if (fixture.kind !== "unreachable")
      assert.ok(
        current.requests.some(({ path }) =>
          /\/(?:v\d+\.\d+\/)?version$/.test(path),
        ),
        "A refusal must observe the controlled server response.",
      );
    if (
      fixture.kind === "os" ||
      fixture.kind === "missing" ||
      fixture.kind === "no-server"
    )
      assert.equal(result.captureKind, "ok");
    if (
      fixture.kind === "malformed" ||
      fixture.kind === "http-error" ||
      fixture.kind === "unreachable"
    )
      assert.equal(result.captureKind, "failed");
    if (fixture.kind === "timeout") assert.equal(result.captureKind, "timeout");
    if (fixture.kind === "overflow")
      assert.equal(result.captureKind, "output-limit");
  }, 20_000);
}

test("doctor refuses an actual Docker template failure even after it prints linux", async () => {
  const current = await invoke({ kind: "os", os: "linux" }, "nonzero");
  const result = commandResult.parse(current.value);
  assert.equal(result.captureKind, "failed");
  assert.equal(result.partialLinux, true);
  assert.equal(result.result.exitCode, 1);
  assert.equal(
    result.result.checks.find(({ id }) => id === "docker.linux")?.kind,
    "fail",
  );
  assert.equal(JSON.stringify(result.result).includes(privateMarker), false);
  assert.deepEqual(current.invocations, []);
}, 20_000);
