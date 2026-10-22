import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const frozenSource = "27b4893c85480658af83749f784de80b4e843ba9";
const paths = [
  "scripts/doctor-docker.test.ts",
  "scripts/doctor.ts",
  "scripts/fixtures/doctor-docker-child.ts",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const replace = (source, before, after, count = 1) => {
  assert.equal(
    source.split(before).length,
    count + 1,
    `Unexpected instrumentation anchor count: ${before.slice(0, 80)}`,
  );
  return source.replaceAll(before, after);
};

export function overlaySources(inputs, mode) {
  assert.ok(mode === "control" || mode === "formatter");
  let test = inputs[paths[0]];
  test =
    `import { probeEvent, probeText } from "../.audit/windows-probe-diagnostic/trace.mjs";\n` +
    test;
  test = replace(
    test,
    'const output = join(root, ".audit/doctor-docker");',
    'const output = join(root, ".audit/doctor-docker");\nprobeEvent("test-root", { mode: ' +
      JSON.stringify(mode) +
      " });",
  );
  test = replace(
    test,
    "    DAMADAMA_DOCKER_CLI: executable,",
    '    DAMADAMA_DOCKER_CLI: executable,\n    DAMADAMA_PROBE_ROLE: "worker",',
  );
  test = replace(
    test,
    "    const child = Bun.spawn(\n",
    '    probeEvent("worker-request", { mode, scope, ledger, intended: { ProgramFiles: environment.ProgramFiles, ProgramW6432: environment.ProgramW6432, ProgramData: environment.ProgramData, DOCKER_CONFIG: environment.DOCKER_CONFIG } });\n    const child = Bun.spawn(\n',
  );
  test = replace(
    test,
    "    const [stdout, stderr, exit] = await Promise.all([\n      new Response(child.stdout).text(),\n      new Response(child.stderr).text(),\n      child.exited,\n    ]);",
    '    probeEvent("worker-spawn", { mode, childPid: child.pid });\n    const [stdout, stderr, exit] = await Promise.all([\n      probeText(child.stdout, "worker-stdout"),\n      probeText(child.stderr, "worker-stderr"),\n      child.exited.then((exit) => { probeEvent("worker-exit", { childPid: child.pid, exit, signal: child.signalCode }); return exit; }),\n    ]);\n    probeEvent("case-observation-before-cleanup", { mode, scope, stdout, stderr, exit, signal: child.signalCode });',
  );
  test = replace(
    test,
    "        const identity = pluginIdentity.parse(JSON.parse(started));",
    '        const identity = pluginIdentity.parse(JSON.parse(started));\n        const { stat } = await import("node:fs/promises");\n        const invokedStat = await stat(join(ledger, name));\n        const completedStat = await stat(join(ledger, name.replace(/\\.invoked$/, ".completed")));\n        probeEvent("plugin-ledger", { ...identity, invokedMtimeMs: invokedStat.mtimeMs, completedMtimeMs: completedStat.mtimeMs });',
  );
  test = replace(
    test,
    "        return identity.executable;",
    '        probeEvent("plugin-absent", { pluginPid: identity.pid });\n        return identity.executable;',
  );
  test = replace(
    test,
    "    records.push({\n      fixture,",
    '    probeEvent("parsed-case-observation", { mode, scope, value, requests, invocations });\n    records.push({\n      fixture,',
  );
  test = replace(
    test,
    '        cleanup.push({ scope: "case", kind: "failed" });\n        throw error;',
    '        cleanup.push({ scope: "case", kind: "failed" });\n        probeEvent("case-cleanup-failed", { scope, code: error instanceof Error && "code" in error ? String(error.code) : "unknown" });\n        throw error;',
    2,
  );
  const first = test.indexOf('test("doctor reads the server OS');
  const refusals = test.indexOf("\nfor (const fixture of [", first);
  const formatter = test.indexOf(
    'test("contributor and acceptance formatting',
    refusals,
  );
  assert.ok(first > 0 && refusals > first && formatter > refusals);
  if (mode === "control") {
    let body = test.slice(first, refusals);
    const current = body.indexOf("  const current = await invoke(");
    assert.ok(current > 0);
    body = body.slice(0, current) + "}, 50_000);\n";
    test = test.slice(0, first) + body;
  } else {
    let body = test.slice(formatter);
    body = replace(
      body,
      "        const child = Bun.spawn(command, {",
      '        probeEvent("formatter-request", { command, cwd });\n        const child = Bun.spawn(command, {',
    );
    body = replace(
      body,
      "        const [exit] = await Promise.all([\n          child.exited,\n          new Response(child.stdout).text(),\n          new Response(child.stderr).text(),\n        ]);",
      '        probeEvent("formatter-spawn", { childPid: child.pid });\n        const [exit, stdout, stderr] = await Promise.all([\n          child.exited.then((exit) => { probeEvent("formatter-exit", { childPid: child.pid, exit, signal: child.signalCode }); return exit; }),\n          probeText(child.stdout, "formatter-stdout"),\n          probeText(child.stderr, "formatter-stderr"),\n        ]);\n        probeEvent("formatter-observation-before-cleanup", { childPid: child.pid, command, cwd, exit, signal: child.signalCode, stdout, stderr });',
    );
    const repair = body.indexOf('    assert.equal(await format("format"), 0);');
    const finallyAt = body.indexOf("  } finally {", repair);
    assert.ok(repair > 0 && finallyAt > repair);
    body =
      body.slice(0, repair) +
      '    records.push({ fixture: "C# formatting", refusal: true, repairNotRun: true });\n' +
      body.slice(finallyAt);
    test = test.slice(0, first) + body;
  }
  let doctor = inputs[paths[1]];
  doctor =
    'import { probeEvent } from "../.audit/windows-probe-diagnostic/trace.mjs";\n' +
    doctor;
  doctor = replace(
    doctor,
    "    const child = spawn(command[0], command.slice(1), {",
    '    probeEvent("capture-request", { executable: command[0], operation: command[1], timeoutMs });\n    const child = spawn(command[0], command.slice(1), {',
  );
  doctor = replace(
    doctor,
    '    let output = "";',
    '    probeEvent("capture-spawn-request", { executable: command[0], operation: command[1], childPid: child.pid });\n    child.on("spawn", () => probeEvent("capture-spawn", { childPid: child.pid }));\n    child.on("exit", (code, signal) => probeEvent("capture-exit", { childPid: child.pid, code, signal }));\n    child.stdout.on("end", () => probeEvent("capture-stdout-eof", { childPid: child.pid }));\n    child.stderr.on("end", () => probeEvent("capture-stderr-eof", { childPid: child.pid }));\n    child.stdout.on("close", () => probeEvent("capture-stdout-close", { childPid: child.pid }));\n    child.stderr.on("close", () => probeEvent("capture-stderr-close", { childPid: child.pid }));\n    let output = "";',
  );
  doctor = replace(
    doctor,
    '      child.kill("SIGKILL");',
    '      probeEvent("capture-kill-request", { childPid: child.pid, reason: result.kind });\n      child.kill("SIGKILL");',
  );
  doctor = replace(
    doctor,
    '      stop({ kind: "timeout" });',
    '      probeEvent("capture-timer", { childPid: child.pid, timeoutMs });\n      stop({ kind: "timeout" });',
  );
  doctor = replace(
    doctor,
    '    child.on("close", (code) => {',
    '    child.on("close", (code) => {\n      probeEvent("capture-close", { childPid: child.pid, code });',
  );
  doctor = replace(
    doctor,
    '    child.on("error", (error: NodeJS.ErrnoException) => {',
    '    child.on("error", (error: NodeJS.ErrnoException) => {\n      probeEvent("capture-error", { childPid: child.pid, code: error.code ?? "unknown" });',
  );
  let worker = inputs[paths[2]];
  worker =
    'import { probeEnvironment, probeEvent } from "../../.audit/windows-probe-diagnostic/trace.mjs";\n' +
    worker;
  worker = replace(
    worker,
    "const mode = process.argv[2];",
    'const mode = process.argv[2];\nprobeEvent("worker-entry", { mode });\nprobeEnvironment();',
  );
  return { [paths[0]]: test, [paths[1]]: doctor, [paths[2]]: worker };
}

function main() {
  const [operation, sourceArg, mode] = process.argv.slice(2);
  assert.ok(operation === "record" || operation === "prepare");
  const source = realpathSync(resolve(sourceArg));
  const output = resolve(source, ".audit/windows-probe-diagnostic");
  const git = (...args) =>
    execFileSync("git", args, { cwd: source, encoding: "utf8" });
  assert.equal(git("rev-parse", "HEAD").trim(), frozenSource);
  assert.equal(git("status", "--porcelain", "--untracked-files=no").trim(), "");
  const inputs = Object.fromEntries(
    paths.map((path) => [path, readFileSync(resolve(source, path), "utf8")]),
  );
  for (const path of paths)
    assert.equal(sha256(inputs[path]), sha256(git("show", `HEAD:${path}`)));
  mkdirSync(output, { recursive: true });
  const identity = {
    source: frozenSource,
    tree: git("rev-parse", "HEAD^{tree}").trim(),
    controls: process.env.CONTROLS_SHA,
    node: process.version,
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    expectedFailingImage: "20261021.278.1",
    matchingImage: process.env.ImageVersion === "20261021.278.1",
    before: paths.map((path) => ({ path, sha256: sha256(inputs[path]) })),
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  const controlsRoot = resolve(import.meta.dirname, "..");
  const controlsGit = (...args) =>
    execFileSync("git", args, { cwd: controlsRoot, encoding: "utf8" }).trim();
  assert.match(process.env.CONTROLS_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(controlsGit("rev-parse", "HEAD"), process.env.CONTROLS_SHA);
  assert.equal(
    controlsGit("status", "--porcelain", "--untracked-files=no"),
    "",
  );
  identity.controlsTree = controlsGit("rev-parse", "HEAD^{tree}");
  if (operation === "record") {
    writeFileSync(
      resolve(output, "source.json"),
      JSON.stringify(identity, null, 2) + "\n",
    );
    return;
  }
  assert.deepEqual(
    JSON.parse(readFileSync(resolve(output, "source.json"), "utf8")),
    identity,
  );
  const overlaid = overlaySources(inputs, mode);
  writeFileSync(
    resolve(output, "trace.mjs"),
    readFileSync(new URL("./windows-probe-runtime.mjs", import.meta.url)),
  );
  for (const path of paths)
    writeFileSync(resolve(source, path), overlaid[path]);
  const patch = git("diff", "--no-ext-diff", "--", ...paths);
  writeFileSync(resolve(output, "instrumentation.patch"), patch);
  writeFileSync(
    resolve(output, "overlay.json"),
    JSON.stringify(
      {
        kind: "diagnostic-overlay-not-acceptance",
        mode,
        ...identity,
        after: paths.map((path) => ({ path, sha256: sha256(overlaid[path]) })),
        patchSha256: sha256(patch),
        traceSha256: sha256(readFileSync(resolve(output, "trace.mjs"))),
        bounds: { dockerMs: 10000, workerMs: 15000, formatterMs: 20000 },
        sentinelUnchanged: true,
      },
      null,
      2,
    ) + "\n",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main();
