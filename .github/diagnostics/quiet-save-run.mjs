import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { cpus, release as kernelRelease, totalmem } from "node:os";
import { z } from "zod";
import { generate } from "./quiet-save-generate.mjs";
import { readFontAssets } from "./quiet-save-source.mjs";
import {
  calibrationMatched,
  parseReceipt,
  validateReceiptPrefix,
  concludeInvocation,
} from "./quiet-save-receipt.mjs";
import {
  passiveCalibrationCases,
  validatePassiveCalibrationCapture,
} from "./quiet-save-validate.mjs";
import { readOwnedFile } from "./quiet-save-files.mjs";
import {
  controls,
  mediaDirectory,
  mediaName,
  validateRetainedMedia,
} from "./quiet-save-media.mjs";

async function main() {
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

  async function receipt(control, iteration) {
    let text;
    try {
      text = await readFile(
        resolve(directory, `${control}-${iteration}.jsonl`),
        "utf8",
      );
    } catch (error) {
      if (error.code === "ENOENT") return { receipt: "missing", rows: null };
      return { receipt: "malformed", rows: null };
    }
    try {
      if (text.length === 0) return { receipt: "empty", rows: null };
      return {
        receipt: "bounded-prefix",
        rows: validateReceiptPrefix(
          parseReceipt(text, control, iteration),
          control,
        ),
      };
    } catch {
      return { receipt: "malformed", rows: null };
    }
  }

  async function capture(run, control, iteration) {
    if (run.kind === "not-started") return { outcome: run, rows: null };
    const evidence = await receipt(control, iteration);
    return {
      outcome: concludeInvocation(
        { ...run, receipt: evidence.receipt },
        evidence.rows,
        control,
      ),
      rows: evidence.rows,
    };
  }

  for (const control of controls.slice(1)) {
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
        QUIET_PROFILE: "legacy-control",
        COMPAT_CONTROL: "missing",
        QUIET_CONTROL: control,
        QUIET_ITERATION: "0",
        QUIET_PHASE: "calibration",
      },
      180000,
      deadline,
    );
    const { outcome, rows } = await capture(run, control, 0);
    const matched =
      run.kind === "started" &&
      run.termination === "none" &&
      rows !== null &&
      calibrationMatched(rows, control, run.exitCode);
    await retain({ kind: "calibration", control, outcome, matched });
    if (!matched) process.exit(1);
  }
  for (const target of ["chromium", "firefox", "webkit", "desktop"]) {
    const desktop = target === "desktop";
    const selfTestReceipt = resolve(
      ".audit/quiet-save-self-test-evidence/presave-assertion-0.jsonl",
    );
    if (desktop) {
      const owner = {
        control: "presave-assertion",
        iteration: 0,
        phase: "calibration",
        project: "chromium-desktop",
        case: 1,
      };
      const media = mediaDirectory(owner, true);
      if (
        !media.startsWith(
          resolve(".audit/quiet-save-self-test-evidence") + "/",
        ) &&
        !media.startsWith(
          resolve(".audit/quiet-save-self-test-evidence") + "\\",
        )
      )
        throw new Error("Calibration cleanup ownership differs.");
      await rm(media, { recursive: true, force: true });
      await rm(selfTestReceipt, { force: true });
    }
    const args = desktop
      ? [
          "node_modules/@playwright/test/cli.js",
          "test",
          "--config",
          ".audit/quiet-save/calibration.config.ts",
          "--project=chromium-desktop",
          "--grep",
          "desktop creation and saved details remain stable",
          "--output",
          ".audit/quiet-save/calibration-results",
          "--update-snapshots=none",
        ]
      : ["--test", ".github/diagnostics/quiet-save-passive.test.mjs"];
    const run = await runOwned(
      "node",
      args,
      {
        ...environment,
        QUIET_SELF_TEST: "1",
        QUIET_PROFILE: "passive",
        QUIET_CONTROL: "presave-assertion",
        QUIET_ITERATION: "0",
        QUIET_PHASE: "calibration",
        QUIET_PASSIVE_PREFLIGHT: "1",
        QUIET_PASSIVE_ENGINE: target,
        COMPAT_CONTROL: "mutation",
      },
      180000,
      deadline,
    );
    if (run.kind === "not-started") {
      await retain({
        kind: "passive-calibration",
        target,
        outcome: run,
        matched: false,
      });
      process.exit(1);
    }
    const destination = resolve(directory, `passive-calibration-${target}`);
    let present = false;
    let matched = false;
    let receiptState = "missing";
    try {
      for (const name of desktop
        ? ["desktop.jsonl"]
        : [
            ...passiveCalibrationCases.map((mode) => `${mode}.jsonl`),
            "engine.json",
          ]) {
        const source = desktop
          ? selfTestReceipt
          : resolve(`.audit/quiet-save/passive-calibration/${target}`, name);
        let bytes;
        try {
          bytes = await readOwnedFile(source, 0, 1024 * 1024);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        if (!present) await mkdir(destination);
        present = true;
        await writeFile(resolve(destination, name), bytes, { flag: "wx" });
        if (desktop) {
          const rows = parseReceipt(
            bytes.toString("utf8"),
            "presave-assertion",
            0,
          );
          for (const row of rows) {
            if (row.kind !== "test-result" || !row.media) continue;
            const sourceMedia = mediaDirectory(row.media.owner, true);
            await validateRetainedMedia(row.media, sourceMedia, head);
            const targetMedia = resolve(destination, basename(sourceMedia));
            await mkdir(targetMedia);
            for (const file of [
              "manifest.json",
              ...row.media.entries
                .filter((entry) => entry.state === "present")
                .map(mediaName),
            ])
              await writeFile(
                resolve(targetMedia, file),
                await readOwnedFile(resolve(sourceMedia, file)),
                { flag: "wx" },
              );
          }
        }
      }
      if (present) {
        receiptState = "bounded-prefix";
        const capture = await validatePassiveCalibrationCapture(
          destination,
          target,
          head,
        );
        matched =
          capture.matched &&
          run.termination === "none" &&
          run.exitCode === (desktop ? 1 : 0);
      }
    } catch {
      receiptState = "malformed";
    }
    let conclusion = "incomplete";
    if (matched) conclusion = desktop ? "failure-observed" : "complete-pass";
    await retain({
      kind: "passive-calibration",
      target,
      outcome: { ...run, receipt: receiptState, conclusion },
      matched,
    });
    if (!matched) process.exit(1);
  }
  for (let iteration = 1; iteration <= invocations; iteration++) {
    const run = await runOwned(
      "bun",
      [".audit/quiet-save/observed-run.ts", "verify"],
      {
        ...environment,
        QUIET_PROFILE: "passive",
        QUIET_CONTROL: "normal",
        QUIET_ITERATION: String(iteration),
      },
      9 * 60000,
      deadline,
    );
    const { outcome } = await capture(run, "normal", iteration);
    await retain({ kind: "normal-invocation", iteration, outcome });
    if (outcome.kind !== "started" || outcome.conclusion !== "complete-pass")
      process.exit(1);
  }
}

export async function runOwned(command, args, env, limitMs, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 30000)
    return {
      kind: "not-started",
      reason: "budget-refused",
      receipt: "absent",
      teardown: "not-started",
    };
  return await new Promise((resolveRun) => {
    const child = spawn(command, args, {
      env,
      stdio: "ignore",
      detached: true,
    });
    let spawned = false;
    child.once("spawn", () => {
      spawned = true;
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
      if (!spawned)
        resolveRun({
          kind: "not-started",
          reason: "spawn-refused",
          receipt: "absent",
          teardown: "not-started",
        });
      else
        resolveRun({
          kind: "started",
          exitCode: null,
          termination: "interrupt-unverified",
          teardown: "unverified-stop-no-retry",
        });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      let teardown = "owner-returned-resource-absence-unverified";
      if (termination !== "none") teardown = "unverified-stop-no-retry";
      resolveRun({ kind: "started", exitCode, termination, teardown });
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
