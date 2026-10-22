import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("source");
const proof = resolve("proof");
await mkdir(proof, { recursive: true });
const sourceSha = "2de3bd3864b5bbbf17fdd4798fdc06c927e68c59";
const identity = Bun.spawnSync(
  ["git", "-C", source, "rev-parse", "HEAD", "HEAD^{tree}"],
  { stdout: "pipe", stderr: "pipe" },
);
if (identity.exitCode !== 0) throw new Error("Source identity query failed");
const [sha, tree] = identity.stdout.toString().trim().split(/\r?\n/);
if (sha !== sourceSha) throw new Error("Unexpected source revision");
const clean = Bun.spawnSync(
  ["git", "-C", source, "status", "--porcelain", "--untracked-files=no"],
  { stdout: "pipe", stderr: "pipe" },
);
if (clean.exitCode !== 0 || clean.stdout.length)
  throw new Error("Source is not clean");
const runtime = (command, pattern) => {
  const result = Bun.spawnSync(command, {
    cwd: source,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const output = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !pattern.test(output)) return "unverified";
  return output;
};
writeFileSync(
  resolve(proof, "source.json"),
  JSON.stringify(
    {
      sourceSha: sha,
      sourceTree: tree,
      controlsSha: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      platform: process.platform,
      bun: Bun.version,
      imageOS: process.env.ImageOS,
      imageVersion: process.env.ImageVersion,
      purpose: "Diagnostic experiment. No shipping verdict.",
      limitation:
        "The instrumented round follows the original round and may inherit its residue.",
    },
    null,
    2,
  ),
);

async function run(label, args) {
  const prefix = resolve(proof, label);
  const pidFile = `${prefix}-root.json`;
  const stopFile = `${prefix}-stop`;
  const monitor = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve("audit-controls/windows-process-monitor.ps1"),
      "-RootPidFile",
      pidFile,
      "-StopFile",
      stopFile,
      "-Output",
      `${prefix}-processes.jsonl`,
      "-Receipt",
      `${prefix}-monitor-summary.json`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "test",
      "scripts/doctor.test.ts",
      "scripts/developer.test.ts",
      ...args,
    ],
    {
      cwd: source,
      env: {
        ...process.env,
        DAMADAMA_CAPTURE_DIAGNOSTIC: resolve(proof, "captures.jsonl"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 85_000,
    },
  );
  writeFileSync(pidFile, JSON.stringify({ pid: child.pid }));
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const lines = (stdout + "\n" + stderr).split(/\r?\n/);
  const retained = lines.filter((line) =>
    /^\s*(?:\(pass\)|\(fail\)|\d+ pass$|\d+ fail$|\d+ filtered out$|\d+ expect\(\) calls$|Ran \d+ tests)/.test(
      line,
    ),
  );
  writeFileSync(
    `${prefix}-result.json`,
    JSON.stringify(
      {
        label,
        exitCode,
        ebusyObserved: lines.some((line) => /^\s*EBUSY:/.test(line)),
        ebusyCount: lines.filter((line) => /^\s*EBUSY:/.test(line)).length,
        command: [
          "bun",
          "--no-env-file",
          "test",
          "scripts/doctor.test.ts",
          "scripts/developer.test.ts",
          ...args,
        ],
        lines: retained,
      },
      null,
      2,
    ),
  );
  await Bun.sleep(1500);
  writeFileSync(stopFile, "stop\n");
  const [, monitorError, monitorExit] = await Promise.all([
    new Response(monitor.stdout).text(),
    new Response(monitor.stderr).text(),
    monitor.exited,
  ]);
  writeFileSync(
    `${prefix}-monitor.json`,
    JSON.stringify({
      exitCode: monitorExit,
      stderrPresent: monitorError.length > 0,
    }),
  );
  console.info(
    JSON.stringify({
      label,
      exitCode,
      monitorExit,
      retainedLines: retained.length,
    }),
  );
  if (monitorExit !== 0) throw new Error("Process monitor failed");
}

await run("original", []);
const doctorPath = resolve(source, "scripts/doctor.ts");
let doctor = readFileSync(doctorPath, "utf8");
const needle = '    let output = "";';
if (doctor.split(needle).length !== 2)
  throw new Error("Unexpected instrumentation anchor");
doctor = 'import { appendFileSync } from "node:fs";\n' + doctor;
doctor = doctor.replace(
  needle,
  `    const auditCommand = ["bun", "node", "dotnet", "docker"].includes(command[0]) ? command[0] : "other";
    const audit = (event: string, errorCode?: string): void => {
      const path = process.env.DAMADAMA_CAPTURE_DIAGNOSTIC;
      if (!path) throw new Error("Missing audit capture path");
      appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), event, ownerPid: process.pid, pid: child.pid, command: auditCommand, errorCode }) + "\\n");
    };
    audit("spawn");
    child.on("exit", () => audit("exit"));
    child.on("error", (error: NodeJS.ErrnoException) => audit("error", ["ENOENT", "EACCES", "EPERM", "EAGAIN", "ENOMEM", "EINVAL"].includes(error.code ?? "") ? error.code : "other"));
${needle}`,
);
doctor = doctor.replace(
  "      stopped = result;",
  "      audit(`stop-${result.kind}`);\n      stopped = result;",
);
doctor = doctor.replace(
  '    child.on("close", (code) => {',
  '    child.on("close", (code) => {\n      audit("close");',
);
writeFileSync(doctorPath, doctor);
const diff = Bun.spawnSync(
  ["git", "-C", source, "diff", "--", "scripts/doctor.ts"],
  { stdout: "pipe", stderr: "pipe" },
);
if (diff.exitCode !== 0) throw new Error("Instrumentation diff failed");
writeFileSync(resolve(proof, "instrumentation.diff"), diff.stdout);
await run("instrumented", [
  "--test-name-pattern",
  "clean bootstrap|cold checkout preserves browser doctor",
]);
const runtimeReceipt = {
  node: runtime(["node", "--version"], /^v24\.\d+\.\d+$/),
  sdk: runtime(["dotnet", "--version"], /^10\.0\.\d+$/),
};
writeFileSync(
  resolve(proof, "runtime-after.json"),
  JSON.stringify(runtimeReceipt, null, 2),
);
for (const label of ["original", "instrumented"]) {
  await rm(resolve(proof, `${label}-root.json`));
  await rm(resolve(proof, `${label}-stop`));
}
