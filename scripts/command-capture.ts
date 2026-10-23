import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { createJob } from "./capture-windows";

export type Command = [string, ...string[]];
type Refusal = { kind: "missing" | "failed" | "timeout" | "output-limit" };
export type Capture = { kind: "ok"; output: string } | Refusal;

export class CaptureRetirementError extends Error {
  constructor(readonly reason: Refusal) {
    super("Owned command retirement could not be verified.");
    this.name = "CaptureRetirementError";
  }
}

function groupAbsent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return true;
    }
    throw error;
  }
}

export async function captureCommand(
  command: Command,
  { timeoutMs = 10_000, maxBytes = 4096 } = {},
): Promise<Capture> {
  const executionDeadline = performance.now() + timeoutMs;
  const cwd = process.cwd();
  const env = { ...process.env };
  let job: ReturnType<typeof createJob> | undefined;
  try {
    if (process.platform === "win32" && process.arch === "x64") {
      job = (await import("./capture-windows")).createJob();
    } else if (process.platform !== "linux") {
      return { kind: "failed" };
    }
  } catch {
    return { kind: "failed" };
  }

  let helper: ChildProcess;
  try {
    helper = spawn(
      process.execPath,
      [
        "--no-env-file",
        fileURLToPath(new URL("./capture-helper.ts", import.meta.url)),
        job?.name ?? "",
      ],
      {
        cwd,
        env,
        detached: process.platform === "linux",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    );
  } catch {
    try {
      job?.close();
    } catch {
      throw new CaptureRetirementError({ kind: "failed" });
    }
    return { kind: "failed" };
  }
  const stdout = helper.stdout;
  const stderr = helper.stderr;
  if (!stdout || !stderr) {
    try {
      helper.kill("SIGKILL");
      job?.close();
    } catch {
      throw new CaptureRetirementError({ kind: "failed" });
    }
    throw new CaptureRetirementError({ kind: "failed" });
  }

  return new Promise<Capture>((resolve, reject) => {
    type Phase = "starting" | "running" | "retiring" | "done";
    let phase: Phase = "starting";
    let refusal: Refusal | undefined;
    let output = "";
    let bytes = 0;
    let closed = false;
    let exited = false;
    let controlFailed = false;
    const timer = setTimeout(
      () => retire({ kind: "timeout" }),
      Math.max(0, executionDeadline - performance.now()),
    );

    const finish = async (deadline: number): Promise<void> => {
      let verified = false;
      try {
        while (performance.now() < deadline) {
          if (exited && closed) {
            if (job) verified = job.empty();
            else if (helper.pid !== undefined)
              verified = groupAbsent(helper.pid);
            else verified = true;
            if (verified) break;
          }
          await wait(Math.min(10, Math.max(0, deadline - performance.now())));
        }
      } catch {
        verified = false;
      }
      phase = "done";
      try {
        job?.close();
      } catch {
        verified = false;
      }
      try {
        stdout.destroy();
        stderr.destroy();
        if (helper.connected) helper.disconnect();
      } catch {
        verified = false;
      }
      helper.unref();
      if (!verified || controlFailed) {
        reject(new CaptureRetirementError(refusal ?? { kind: "failed" }));
      } else if (refusal) {
        resolve(refusal);
      } else {
        resolve({ kind: "ok", output: output.trim() });
      }
    };

    function retire(reason?: Refusal): void {
      if (phase === "done") return;
      refusal ??= reason;
      if (phase === "retiring") return;
      const beforeGo = phase === "starting";
      phase = "retiring";
      const deadline = performance.now() + 2000;
      clearTimeout(timer);
      try {
        if (job) {
          // A helper cancelled before membership must never receive GO.
          if (beforeGo && !exited) helper.kill("SIGKILL");
          job.terminate();
        } else if (helper.connected) {
          helper.send({ kind: "stop" }, (error) => {
            if (error && !exited) controlFailed = true;
          });
        } else if (beforeGo && !exited) {
          helper.kill("SIGKILL");
        }
      } catch {
        controlFailed = true;
      }
      void finish(deadline);
    }

    function collect(data: string, retain: boolean): void {
      if (phase === "done" || refusal) return;
      bytes += Buffer.byteLength(data);
      if (bytes > maxBytes) return retire({ kind: "output-limit" });
      if (retain) output += data;
    }
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (data: string) => collect(data, true));
    stderr.on("data", (data: string) => collect(data, false));
    stdout.on("error", () => retire({ kind: "failed" }));
    stderr.on("error", () => retire({ kind: "failed" }));
    helper.on("message", (message: unknown) => {
      if (phase === "retiring" || phase === "done") return;
      if (
        typeof message !== "object" ||
        message === null ||
        !("kind" in message)
      ) {
        return retire({ kind: "failed" });
      }
      if (phase === "starting" && message.kind === "ready") {
        if (performance.now() >= executionDeadline)
          return retire({ kind: "timeout" });
        phase = "running";
        helper.send({ kind: "go", command }, (error) => {
          if (error) retire({ kind: "failed" });
        });
      } else if (
        phase === "running" &&
        (message.kind === "ok" ||
          message.kind === "missing" ||
          message.kind === "failed")
      ) {
        if (message.kind === "ok") retire();
        else retire({ kind: message.kind });
      } else {
        retire({ kind: "failed" });
      }
    });
    helper.on("error", () => {
      if (helper.pid === undefined) exited = true;
      retire({ kind: "failed" });
    });
    helper.on("exit", () => {
      exited = true;
      if (phase === "starting" || phase === "running")
        retire({ kind: "failed" });
    });
    helper.on("close", () => {
      closed = true;
    });
  });
}
