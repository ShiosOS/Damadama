import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

type State = "joining" | "ready" | "running" | "stopping";
let state: State = "joining";
let isolatedGroup = false;

function stop(): void {
  state = "stopping";
  if (isolatedGroup) process.kill(0, "SIGKILL");
  process.exit(1);
}

function report(kind: "ready" | "ok" | "missing" | "failed"): void {
  if (!process.send) return stop();
  process.send({ kind }, undefined, undefined, (error: Error | null) => {
    if (error) stop();
  });
}

function commandFrom(message: unknown): [string, ...string[]] | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("kind" in message) ||
    message.kind !== "go" ||
    !("command" in message) ||
    !Array.isArray(message.command)
  )
    return undefined;
  const command: unknown[] = message.command;
  const [first, ...rest] = command;
  if (typeof first !== "string" || first.length === 0) return undefined;
  const args: string[] = [];
  for (const arg of rest) {
    if (typeof arg !== "string") return undefined;
    args.push(arg);
  }
  return [first, ...args];
}

process.on("disconnect", stop);
process.on("message", (message: unknown) => {
  if (state !== "ready") return stop();
  const command = commandFrom(message);
  if (!command) return stop();
  state = "running";
  try {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      report(error.code === "ENOENT" ? "missing" : "failed");
    });
    child.once("exit", (code) => report(code === 0 ? "ok" : "failed"));
  } catch {
    report("failed");
  }
});

try {
  if (process.platform === "win32" && process.arch === "x64") {
    const name = process.argv[2];
    if (!name?.startsWith("Local\\DamadamaCapture-")) throw new Error();
    const { joinJob } = await import("./capture-windows");
    joinJob(name);
  } else if (process.platform === "linux") {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (
      Number(fields[2]) !== process.pid ||
      Number(fields[3]) !== process.pid
    ) {
      throw new Error();
    }
    isolatedGroup = true;
  } else {
    throw new Error();
  }
  state = "ready";
  report("ready");
} catch {
  stop();
}
