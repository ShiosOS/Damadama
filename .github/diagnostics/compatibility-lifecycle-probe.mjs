import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  descendants,
  listenerIds,
  postgresContainers,
  processIdentity,
  sameProcess,
} from "../../.agents/skills/verify/owned-resources.mjs";

const directory = ".audit/compatibility-lifecycle-probe";
const target = `${directory}/observations.jsonl`;
const phaseNames = [
  "Firefox and WebKit smoke",
  "fresh visual comparison 1",
  "fresh visual comparison 2",
  "fresh visual comparison 3",
  "changed-row pixel rejection and same-page restoration",
  "missing-baseline rejection",
];
const ports = [5055, 5174];
const categories = [
  ["database-timeout", /Npgsql.*(?:timeout|timed out)/i],
  ["connection-refused", /connection refused/i],
  ["out-of-memory", /out of memory|OutOfMemoryException/i],
  ["unhandled-backend", /Unhandled exception.*(?:Npgsql|Damadama|Microsoft)/],
  [
    "save-waiter-timeout",
    /page\.waitForResponse: Test timeout of 30000ms exceeded/,
  ],
];

function query(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  const value = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(value))
    throw new Error("source-identity-unavailable");
  return value;
}

function identity(row) {
  return {
    pid: row.pid,
    parentPid: row.parentPid,
    startTicks: row.startTicks,
    bootId: row.bootId,
  };
}

async function emit(event, details) {
  await appendFile(
    target,
    `${JSON.stringify({
      schema: 1,
      monotonicMs: Math.round(performance.now()),
      event,
      ...details,
    })}\n`,
  );
}

async function numericFields(path, fields) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("resource-observation-unavailable");
  }
  return Object.fromEntries(
    fields.map((field) => {
      const match = new RegExp(`^${field}:?\\s+(\\d+)`, "m").exec(text);
      if (!match) throw new Error("resource-observation-invalid");
      return [field, Number(match[1])];
    }),
  );
}

async function memory() {
  return {
    hostKiB: await numericFields("/proc/meminfo", [
      "MemTotal",
      "MemAvailable",
      "SwapTotal",
      "SwapFree",
    ]),
    cgroupEvents: await numericFields("/sys/fs/cgroup/memory.events", [
      "low",
      "high",
      "max",
      "oom",
      "oom_kill",
    ]),
  };
}

async function snapshot(iteration, phase, childPid, observed, baseline) {
  const current = childPid ? await descendants(childPid) : [];
  for (const row of current)
    observed.set(`${row.pid}:${row.startTicks}:${row.bootId}`, row);
  const listeners = [];
  for (const port of ports) {
    const pids = listenerIds(port);
    listeners.push({
      port,
      pids,
      allOwned: pids.every((pid) => current.some((row) => row.pid === pid)),
    });
  }
  const containers = postgresContainers();
  await emit("resource-sample", {
    iteration,
    phase,
    processes: current.map(identity),
    listeners,
    postgres: containers.map((row) => ({
      id: row.id,
      presentAtBaseline: baseline.has(row.id),
      running: row.status.startsWith("Up "),
    })),
    memory: await memory(),
  });
}

await mkdir(directory, { recursive: true });
const release = await readFile("/etc/os-release", "utf8").catch(() => "");
if (
  process.platform !== "linux" ||
  !/^ID=ubuntu$/m.test(release) ||
  !/^VERSION_ID="24\.04"$/m.test(release)
)
  throw new Error("canonical-ubuntu-required");
await emit("source", {
  head: query(["rev-parse", "HEAD"]),
  tree: query(["rev-parse", "HEAD^{tree}"]),
  node: process.version,
  invocations: 5,
  phasesPerInvocation: phaseNames.length,
});
let allPassed = true;
for (let iteration = 1; iteration <= 5; iteration++) {
  const baseline = new Set(postgresContainers().map((row) => row.id));
  const observed = new Map();
  await snapshot(iteration, "before", null, observed, baseline);
  const child = spawn("bun", ["run", "browser:compatibility:verify"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = new Promise((resolve) => {
    child.once("error", () => resolve({ code: 127, signal: null }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let finished = false;
  void completion.then(() => {
    finished = true;
  });
  let phase = phaseNames[0];
  const passedPhases = [];
  const errorCounts = Object.fromEntries(categories.map(([name]) => [name, 0]));
  let pending = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    pending += chunk.toString("utf8");
    if (pending.length > 65536) pending = pending.slice(-65536);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      for (const [name, pattern] of categories)
        if (pattern.test(line)) errorCounts[name]++;
      const index = phaseNames.findIndex((name) => line === `${name}: passed`);
      if (index !== -1) {
        passedPhases.push(phaseNames[index]);
        phase = phaseNames[index + 1] ?? "complete";
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    for (const [name, pattern] of categories)
      if (pattern.test(chunk.toString("utf8"))) errorCounts[name]++;
  });
  let observationError = false;
  while (!finished) {
    try {
      await snapshot(iteration, phase, child.pid, observed, baseline);
    } catch {
      observationError = true;
      await emit("observation-failure", { iteration, phase });
    }
    await delay(500);
  }
  const result = await completion;
  const remaining = [];
  for (const row of observed.values())
    if (sameProcess(row, await processIdentity(row.pid)))
      remaining.push(identity(row));
  await snapshot(iteration, "after", null, observed, baseline);
  const passed =
    result.code === 0 &&
    !result.signal &&
    !observationError &&
    JSON.stringify(passedPhases) === JSON.stringify(phaseNames);
  await emit("invocation-result", {
    iteration,
    ...result,
    passed,
    passedPhases,
    errorCounts,
    remainingObservedProcesses: remaining,
  });
  console.info(
    `lifecycle invocation ${iteration}: ${passed ? "passed" : "failed"}`,
  );
  if (!passed) {
    allPassed = false;
    break;
  }
}
process.exitCode = allPassed ? 0 : 1;
