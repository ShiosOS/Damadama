import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, release as kernelRelease, totalmem } from "node:os";
import { z } from "zod";
import { generate } from "./quiet-save-generate.mjs";
import { readFontAssets } from "./quiet-save-source.mjs";
import {
  calibrationMatched,
  invocationPassed,
  parseReceipt,
} from "./quiet-save-receipt.mjs";

const directory = resolve(".audit/quiet-save/evidence");
await mkdir(directory, { recursive: true });
const hashes = await generate();
await writeFile(
  resolve(directory, "source-map.json"),
  await readFile(".audit/quiet-save/source-map.json"),
);
const invocations = z.coerce
  .number()
  .int()
  .min(1)
  .max(20)
  .parse(process.env.QUIET_INVOCATIONS ?? "20");
if (process.argv.includes("--prepare-only")) process.exit(0);
const release = await readFile("/etc/os-release", "utf8").catch(() => "");
if (
  process.platform !== "linux" ||
  !/^ID=ubuntu$/m.test(release) ||
  !/^VERSION_ID="24.04"$/m.test(release)
)
  throw new Error("Quiet experiment requires Ubuntu 24.04.");
if (process.version !== "v24.21.0")
  throw new Error("Quiet experiment requires the original Node runtime.");
const started = Number(process.env.QUIET_JOB_STARTED) * 1000;
if (
  !Number.isSafeInteger(started) ||
  started < Date.now() - 45 * 60000 ||
  started > Date.now()
)
  throw new Error("Missing bounded job start.");
const deadline = started + 39 * 60000;
const identity = (reference) => {
  const result = spawnSync("git", ["rev-parse", reference], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(result.stdout.trim()))
    throw new Error("Cannot establish source identity.");
  return result.stdout.trim();
};
const head = identity("HEAD");
await writeFile(
  resolve(directory, "source.json"),
  JSON.stringify({
    schema: 2,
    fontBuild: (await readFontAssets()).proof,
    head,
    tree: identity("HEAD^{tree}"),
    node: process.version,
    kernel: z
      .string()
      .regex(/^[A-Za-z0-9._+-]{1,80}$/)
      .parse(kernelRelease()),
    arch: z.enum(["x64", "arm64"]).parse(process.arch),
    cpus: cpus().length,
    memoryBytes: totalmem(),
    imageOS: z
      .string()
      .regex(/^[A-Za-z0-9._+-]{1,80}$/)
      .nullable()
      .parse(process.env.ImageOS ?? null),
    imageVersion: z
      .string()
      .regex(/^[A-Za-z0-9._+-]{1,80}$/)
      .nullable()
      .parse(process.env.ImageVersion ?? null),
    ...hashes,
    kind: "diagnostic-not-acceptance",
    invocations,
    phases: 6,
    deadlineMinutesAfterJobStart: 39,
  }) + "\n",
);
const environment = {
  ...process.env,
  COMPAT_MODE: "verify",
  COMPAT_CURRENT_SHA: head,
  COMPAT_OS_DISTRIBUTION: "ubuntu",
  COMPAT_OS_VERSION: "24.04",
};
const outcomes = [];
async function retain(outcome) {
  outcomes.push(outcome);
  await writeFile(
    resolve(directory, "outcomes.json"),
    JSON.stringify(outcomes) + "\n",
  );
  console.info(JSON.stringify(outcome));
}

async function runOwned(command, args, env, limitMs) {
  const remaining = deadline - Date.now();
  if (remaining < 30000)
    return {
      exitCode: null,
      termination: "budget-refused",
      teardown: "not-started",
    };
  return await new Promise((resolveRun) => {
    const child = spawn(command, args, {
      env,
      stdio: "ignore",
      detached: true,
    });
    let termination = "none";
    let killTimer;
    const timer = setTimeout(
      () => {
        termination = "owned-group-interrupt";
        if (child.exitCode === null && child.pid) {
          try {
            process.kill(-child.pid, "SIGINT");
          } catch {
            termination = "interrupt-unverified";
          }
          killTimer = setTimeout(() => {
            if (child.exitCode === null && child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
                termination = "owned-group-kill";
              } catch {
                termination = "kill-unverified";
              }
            }
          }, 15000);
        }
      },
      Math.min(limitMs, remaining),
    );
    child.once("error", () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolveRun({
        exitCode: null,
        termination: "spawn-refused",
        teardown: "not-started",
      });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      let teardown = "owner-returned-resource-absence-unverified";
      if (termination !== "none") teardown = "unverified-stop-no-retry";
      resolveRun({ exitCode, termination, teardown });
    });
  });
}

async function receipt(control, iteration) {
  try {
    return parseReceipt(
      await readFile(
        resolve(directory, `${control}-${iteration}.jsonl`),
        "utf8",
      ),
      control,
      iteration,
    );
  } catch {
    return null;
  }
}

for (const control of [
  "invalid",
  "held-response",
  "deadline",
  "presave-assertion",
  "pixel-mismatch",
]) {
  await writeFile(resolve(directory, `${control}-0.jsonl`), "");
  const run = await runOwned(
    "node",
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      ".audit/quiet-save/observed.config.ts",
      "--project=chromium-desktop",
      "--grep",
      "desktop creation and saved details remain stable",
      "--output",
      `.audit/quiet-save/results-${control}`,
      "--update-snapshots=none",
    ],
    {
      ...environment,
      COMPAT_CONTROL: "missing",
      QUIET_CONTROL: control,
      QUIET_ITERATION: "0",
      QUIET_PHASE: "calibration",
    },
    180000,
  );
  const rows = await receipt(control, 0);
  const matched =
    run.termination === "none" &&
    rows !== null &&
    calibrationMatched(rows, control, run.exitCode);
  await retain({
    kind: "calibration",
    control,
    ...run,
    receiptValid: rows !== null,
    matched,
  });
  if (!matched) process.exit(1);
}
for (let iteration = 1; iteration <= invocations; iteration++) {
  await writeFile(resolve(directory, `normal-${iteration}.jsonl`), "");
  const run = await runOwned(
    "bun",
    [".audit/quiet-save/observed-run.ts", "verify"],
    {
      ...environment,
      QUIET_CONTROL: "normal",
      QUIET_ITERATION: String(iteration),
    },
    9 * 60000,
  );
  const rows = await receipt("normal", iteration);
  const passed =
    run.termination === "none" &&
    rows !== null &&
    invocationPassed(rows, run.exitCode);
  await retain({
    kind: "normal-invocation",
    iteration,
    ...run,
    receiptValid: rows !== null,
    passed,
  });
  if (!passed) process.exit(1);
}
