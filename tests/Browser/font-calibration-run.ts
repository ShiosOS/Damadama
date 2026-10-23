import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { prepareAdmission, sourceRoot } from "./font-evidence-admission";
import {
  consumeFontEvidence,
  runCompatibilityChild,
} from "./font-evidence-consumer";
import {
  calibrationMode,
  frameSchema,
  prefix,
  type Context,
  type Frame,
} from "./font-evidence-schema";

const audit = join(sourceRoot, ".audit/browser-font-implementation");
const lifecycleSchema = z
  .object({
    mode: calibrationMode,
    status: z.enum(["passed", "failed", "timedOut", "skipped", "interrupted"]),
    before: z.array(z.number().int()),
    after: z.array(z.number().int()),
    ownedInstalled: z.number().int(),
    ownedRemaining: z.literal(0),
    unrelatedPreserved: z.literal(true),
    partial: z.boolean(),
    posts: z.number().int(),
    released: z.boolean(),
    validated: z.boolean(),
    nativeEvents: z.array(z.enum(["invalid", "submit"])).max(8),
    platform: z.string(),
    nodeVersion: z.literal("v24.21.0"),
    ubuntuStrings: z.literal("fixture-inputs-only"),
    cwdRestored: z.literal(true),
  })
  .strict();

async function matrix(): Promise<void> {
  const admission = await prepareAdmission();
  assert.equal(
    admission.kind,
    "admitted",
    "Current committed source and optimized build must be admitted before calibration.",
  );
  const before = new Set(await readdir(audit));
  const groups = [
    ["healthy", "delayed", "abort", "corrupt", "missing", "unused"],
    [
      "mixed",
      "overflow",
      "reload",
      "redirect",
      "pass",
      "skip",
      "page-close",
      "refused",
    ],
    ["hold", "invalid-form", "held-response", "later-font-failure"],
  ];
  const summaries: { mode: string; kind: string; events: number }[] = [];
  const byMode = new Map<string, Frame[]>();
  for (const [index, modes] of groups.entries()) {
    const context: Context = {
      run: randomBytes(32).toString("hex"),
      admission,
      phase: { mode: "calibration", invocation: index + 1, control: "none" },
    };
    const result = await runCompatibilityChild({
      args: [
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        "tests/Browser/font-calibration.config.ts",
        "--grep",
        `(?:${modes.join("|")})$`,
      ],
      cwd: sourceRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      context,
    });
    await writeFile(join(audit, `phase-${index + 1}.log`), result.output);
    await writeFile(
      join(audit, `phase-${index + 1}-consumer.json`),
      JSON.stringify(
        {
          exitCode: result.exitCode,
          evidence: result.evidence,
          consumption: result.consumption,
        },
        null,
        2,
      ),
    );
    assert.equal(
      result.exitCode,
      1,
      "Deliberate child failures retain Playwright exit 1.",
    );
    if (index === 0) assert.equal(result.consumption.kind, "complete");
    if (index === 1) assert.equal(result.consumption.kind, "refused");
    if (index === 2) assert.equal(result.consumption.kind, "partial");
    const framed = result.output
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith(prefix));
    assert.ok(!framed.join("\n").includes("privacy-canary"));
    assert.ok(!framed.join("\n").includes("127.0.0.1"));
    for (const line of framed) {
      const input: unknown = JSON.parse(line.trimStart().slice(prefix.length));
      const frame = frameSchema.parse(input);
      const mode = frame.receipt.identity.calibration;
      assert.ok(mode && modes.includes(mode));
      const frames = byMode.get(mode) ?? [];
      frames.push(frame);
      byMode.set(mode, frames);
    }
    for (const mode of modes) {
      const frames = byMode.get(mode) ?? [];
      const consumption = consumeFontEvidence({
        stdout: frames
          .map((frame) => prefix + JSON.stringify(frame))
          .join("\n"),
        stderr: "",
        context,
        outputComplete: true,
      });
      const final = frames.find((frame) => frame.kind === "case-final");
      const events = final?.receipt.events ?? [];
      summaries.push({ mode, kind: consumption.kind, events: events.length });
      if (mode === "pass" || mode === "skip") {
        assert.equal(consumption.kind, "absent");
        continue;
      }
      if (mode === "refused") {
        assert.equal(consumption.kind, "refused");
        continue;
      }
      assert.ok(final, `${mode} must retain its disposed final frame`);
      if (mode === "redirect") assert.equal(consumption.kind, "refused");
      else if (mode === "reload") {
        const pending = events.some(
          (event) =>
            event.data.kind === "request" &&
            !events.some(
              (later) =>
                (later.data.kind === "finished" ||
                  later.data.kind === "failed") &&
                event.data.kind === "request" &&
                later.data.request === event.data.request,
            ),
        );
        assert.equal(consumption.kind, pending ? "partial" : "complete");
      } else if (
        ["hold", "overflow", "invalid-form", "held-response"].includes(mode)
      )
        assert.equal(consumption.kind, "partial");
      else assert.equal(consumption.kind, "complete");
      const decision = events.find(
        (event) => event.data.kind === "decision",
      )?.data;
      const refusal = events.find(
        (event) => event.data.kind === "guard-refusal",
      );
      if (mode === "hold") {
        assert.ok(events.some((event) => event.data.kind === "entered"));
        assert.ok(
          !events.some((event) => event.data.kind === "ready-fulfilled"),
        );
        assert.equal(decision, undefined);
        assert.equal(refusal, undefined);
      } else {
        assert.ok(decision?.kind === "decision");
        assert.equal(
          decision.decision.fontLoaded,
          ![
            "abort",
            "corrupt",
            "missing",
            "unused",
            "later-font-failure",
          ].includes(mode),
        );
        if (mode === "overflow")
          assert.deepEqual(decision.decision.sample, {
            kind: "unavailable",
            reason: "face-bound-exceeded",
          });
        if (mode === "abort")
          assert.ok(
            events.some(
              (event) =>
                event.data.kind === "failed" &&
                event.data.category === "aborted",
            ),
          );
        if (mode === "corrupt")
          assert.ok(events.some((event) => event.data.kind === "finished"));
        if (mode === "missing" || mode === "unused") {
          assert.ok(decision.decision.sample.kind === "available");
          assert.equal(
            decision.decision.sample.counts.unloaded,
            mode === "unused" ? 5 : 0,
          );
          assert.equal(
            events.filter((event) => event.data.kind === "request").length,
            0,
          );
        }
        if (!decision.decision.fontLoaded) assert.ok(refusal);
        else assert.equal(refusal, undefined);
      }
      if (mode === "reload")
        assert.equal(
          events.filter((event) => event.data.kind === "navigation").length,
          2,
        );
      if (mode === "later-font-failure") {
        const saved = events.findIndex(
          (event) =>
            event.data.kind === "save" &&
            event.data.marker === "saved-assertions-complete",
        );
        const entered = events.findIndex(
          (event) => event.data.kind === "entered",
        );
        assert.ok(saved >= 0 && saved < entered);
        assert.ok(
          result.output.includes(
            "compatibility-diagnostic create-response 201",
          ),
        );
      }
    }
  }
  const lifecycles = [];
  for (const directory of await readdir(audit, { withFileTypes: true })) {
    if (!directory.isDirectory() || before.has(directory.name)) continue;
    const path = join(audit, directory.name, "lifecycle.json");
    const raw = await readFile(path, "utf8").catch(() => null);
    if (!raw) continue;
    const input: unknown = JSON.parse(raw);
    const lifecycle = lifecycleSchema.parse(input);
    assert.equal(
      lifecycle.ownedInstalled,
      lifecycle.mode === "refused" ? 0 : 6,
    );
    const timedOut = ["hold", "invalid-form", "held-response"].includes(
      lifecycle.mode,
    );
    assert.equal(
      lifecycle.validated,
      !timedOut,
      `${lifecycle.mode} must finish every intended assertion`,
    );
    if (timedOut) assert.equal(lifecycle.status, "timedOut");
    else if (lifecycle.mode === "pass")
      assert.equal(lifecycle.status, "passed");
    else if (lifecycle.mode === "skip")
      assert.equal(lifecycle.status, "skipped");
    else assert.equal(lifecycle.status, "failed");
    if (lifecycle.mode === "hold") {
      assert.equal(lifecycle.partial, true);
      assert.equal(lifecycle.status, "timedOut");
    }
    if (lifecycle.mode === "delayed") assert.equal(lifecycle.released, true);
    if (lifecycle.mode === "invalid-form") {
      assert.equal(lifecycle.posts, 0);
      assert.ok(lifecycle.nativeEvents.includes("invalid"));
      assert.ok(!lifecycle.nativeEvents.includes("submit"));
    }
    if (["held-response", "later-font-failure"].includes(lifecycle.mode)) {
      assert.equal(lifecycle.posts, 1);
      assert.ok(lifecycle.nativeEvents.includes("submit"));
      assert.ok(!lifecycle.nativeEvents.includes("invalid"));
    }
    lifecycles.push(lifecycle);
  }
  assert.deepEqual(
    lifecycles.map((entry) => entry.mode).sort(),
    [...calibrationMode.options].sort(),
  );
  assert.equal(
    JSON.stringify(await prepareAdmission()),
    JSON.stringify(admission),
  );
  await writeFile(
    join(audit, "matrix-results.json"),
    JSON.stringify(
      {
        admission,
        summaries,
        lifecycles,
        supervisor: {
          runtime: "bun",
          version: Bun.version,
          nodeCompatibility: process.version,
        },
        workerNodeVersions: [
          ...new Set(lifecycles.map((entry) => entry.nodeVersion)),
        ],
        platform: process.platform,
        ubuntuStrings: "fixture-inputs-only",
        canonicalAcceptance: false,
      },
      null,
      2,
    ),
  );
  console.info(`Current-source calibration passed ${summaries.length} modes.`);
}

await mkdir(audit, { recursive: true });
if (process.argv[2] === "worker") {
  await matrix();
} else {
  const command = fileURLToPath(import.meta.url);
  const child = spawn("bun", [command, "worker"], {
    cwd: sourceRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const output: Buffer[] = [];
  let size = 0;
  let incomplete = false;
  function stop(): void {
    incomplete = true;
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
      });
    else process.kill(-pid, "SIGKILL");
  }
  function collect(chunk: Buffer): void {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) {
      stop();
      return;
    }
    output.push(chunk);
  }
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const deadline = setTimeout(stop, 120000);
  const exit = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(deadline));
  await writeFile(join(audit, "matrix.log"), Buffer.concat(output));
  await writeFile(
    join(audit, "matrix-exit.json"),
    JSON.stringify({ exit, incomplete }),
  );
  assert.equal(
    incomplete,
    false,
    "Outer timeout or output bound is incomplete proof.",
  );
  assert.equal(
    exit,
    0,
    "Current-source matrix failed. Read the private matrix log.",
  );
  console.info(Buffer.concat(output).toString("utf8"));
}
