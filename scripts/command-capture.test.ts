import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureCommand, CaptureRetirementError, doctor } from "./doctor";

type Command = Parameters<typeof captureCommand>[0];
type Capture = Awaited<ReturnType<typeof captureCommand>>;
const secret = "capture-private-sentinel";
const helperPath = fileURLToPath(
  new URL("./capture-helper.ts", import.meta.url),
);

function evalCommand(code: string): Command {
  return [process.execPath, "--no-env-file", "-e", code];
}

async function retirementFailure(
  capture: Promise<Capture>,
): Promise<CaptureRetirementError> {
  try {
    await capture;
  } catch (error) {
    assert.ok(error instanceof CaptureRetirementError);
    return error;
  }
  throw new Error("Expected unverified retirement to reject.");
}

test("capture preserves argv, cwd, environment, ignored stdin and success trim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "doctor spaced-λ-"));
  const cwd = process.cwd();
  const previous = process.env["CAPTURE_PROBE"];
  const args = ["", "two words", 'a"b', "tail\\", "$HOME; echo nope", "λ"];
  try {
    process.env["CAPTURE_PROBE"] = secret;
    process.chdir(directory);
    const result = await captureCommand([
      ...evalCommand(
        "process.stdin.resume(); process.stdin.on('end', () => console.log('  '+JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.CAPTURE_PROBE})+'  '))",
      ),
      "--",
      ...args,
    ]);
    expect(result).toEqual({
      kind: "ok",
      output: JSON.stringify({ args, cwd: directory, env: secret }),
    });
  } finally {
    process.chdir(cwd);
    if (previous === undefined) delete process.env["CAPTURE_PROBE"];
    else process.env["CAPTURE_PROBE"] = previous;
    await rm(directory, { recursive: true });
  }
});

test("combined decoded UTF8 threshold is strict, including malformed UTF8", async () => {
  const command = evalCommand(
    "process.stdout.write(' € '); process.stderr.write('ß');",
  );
  expect(await captureCommand(command, { maxBytes: 7 })).toEqual({
    kind: "ok",
    output: "€",
  });
  expect(await captureCommand(command, { maxBytes: 6 })).toEqual({
    kind: "output-limit",
  });
  const malformed = evalCommand("process.stdout.write(Buffer.from([255]));");
  expect(await captureCommand(malformed, { maxBytes: 3 })).toEqual({
    kind: "ok",
    output: "�",
  });
  expect(await captureCommand(malformed, { maxBytes: 2 })).toEqual({
    kind: "output-limit",
  });
  const split = evalCommand(
    "process.stdout.write(Buffer.from([226])); setImmediate(()=>process.stdout.write(Buffer.from([130,172])));",
  );
  expect(await captureCommand(split, { maxBytes: 3 })).toEqual({
    kind: "ok",
    output: "€",
  });
});

test("payload stdout cannot send control messages", async () => {
  expect(
    await captureCommand(
      evalCommand('console.log(JSON.stringify({kind:"ready"}))'),
    ),
  ).toEqual({ kind: "ok", output: '{"kind":"ready"}' });
});

test("startup timeout prevents GO and target effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "doctor-pre-go-"));
  const marker = join(directory, "launched");
  try {
    expect(
      await captureCommand(
        evalCommand(
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
        ),
        { timeoutMs: 0 },
      ),
    ).toEqual({ kind: "timeout" });
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("concurrent captures progress while another waits for timeout", async () => {
  const order: string[] = [];
  const slow = captureCommand(evalCommand("setInterval(()=>{},30000)"), {
    timeoutMs: 500,
  }).then((result): Capture => {
    order.push("slow");
    return result;
  });
  const fast = captureCommand(evalCommand("console.log('independent')")).then(
    (result): Capture => {
      order.push("fast");
      return result;
    },
  );
  expect(await fast).toEqual({ kind: "ok", output: "independent" });
  expect(await slow).toEqual({ kind: "timeout" });
  expect(order).toEqual(["fast", "slow"]);
});

test("doctor preserves the original refusal and sanitizes retirement failures", async () => {
  const reasons: CaptureRetirementError["reason"][] = [
    { kind: "timeout" },
    { kind: "output-limit" },
  ];
  for (const reason of reasons) {
    const calls: string[] = [];
    const error = new CaptureRetirementError(reason);
    error.stack = secret;
    const result = await doctor({
      args: ["backend"],
      capture: async (command) => {
        calls.push(command[0]);
        if (command[0] === "bun") throw error;
        const outputs: Record<string, string> = {
          dotnet: "10.0.113",
          docker: "linux",
          node: "v24.21.0",
        };
        return { kind: "ok", output: outputs[command[0]] ?? "" };
      },
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.checks.find((check) => check.id === "runtime.bun")?.message,
    ).toContain(reason.kind);
    expect(
      result.checks.find((check) => check.id === "process.cleanup")?.kind,
    ).toBe("fail");
    expect(calls.sort()).toEqual(["bun", "docker", "dotnet", "node"]);
    expect(JSON.stringify(result)).not.toContain(secret);
  }
});

if (process.platform === "win32") {
  const native = await import("./capture-windows");
  test("native query failure rejects without replacing timeout", async () => {
    const original = native.createJob;
    const mock = spyOn(native, "createJob").mockImplementation(() => {
      const job = original();
      return {
        ...job,
        empty(): boolean {
          throw new Error(secret);
        },
      };
    });
    try {
      const error = await retirementFailure(
        captureCommand(evalCommand("setInterval(()=>{},30000)"), {
          timeoutMs: 150,
        }),
      );
      expect(error.reason).toEqual({ kind: "timeout" });
      expect(error.message).not.toContain(secret);
    } finally {
      mock.mockRestore();
    }
  });

  test("native retirement deadline is finite and does not block another capture", async () => {
    const original = native.createJob;
    let first = true;
    const mock = spyOn(native, "createJob").mockImplementation(() => {
      const job = original();
      if (!first) return job;
      first = false;
      return {
        ...job,
        empty(): boolean {
          return false;
        },
      };
    });
    const order: string[] = [];
    try {
      const uncertain = retirementFailure(
        captureCommand(evalCommand("setInterval(()=>{},30000)"), {
          timeoutMs: 100,
        }),
      ).then((error): CaptureRetirementError => {
        order.push("uncertain");
        return error;
      });
      const quick = await captureCommand(
        evalCommand("console.log('available')"),
      );
      order.push("quick");
      expect(quick).toEqual({ kind: "ok", output: "available" });
      const error = await uncertain;
      expect(error.reason).toEqual({ kind: "timeout" });
      expect(order).toEqual(["quick", "uncertain"]);
    } finally {
      mock.mockRestore();
    }
  }, 4000);

  test("native termination error preserves output refusal even after empty proof", async () => {
    const original = native.createJob;
    const mock = spyOn(native, "createJob").mockImplementation(() => {
      const job = original();
      return {
        ...job,
        terminate(): void {
          job.terminate();
          throw new Error(secret);
        },
      };
    });
    try {
      const error = await retirementFailure(
        captureCommand(
          evalCommand(
            "console.log('x'.repeat(2048));setInterval(()=>{},30000)",
          ),
          { maxBytes: 128 },
        ),
      );
      expect(error.reason).toEqual({ kind: "output-limit" });
      expect(error.message).not.toContain(secret);
    } finally {
      mock.mockRestore();
    }
  });

  test("synchronous helper spawn failure closes the owned job", async () => {
    const original = native.createJob;
    const closes: string[] = [];
    const jobSpy = spyOn(native, "createJob").mockImplementation(() => {
      const job = original();
      return {
        ...job,
        close(): void {
          job.close();
          closes.push(job.name);
        },
      };
    });
    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => {
      throw new Error(secret);
    });
    try {
      expect(await captureCommand(evalCommand("console.log('never')"))).toEqual(
        { kind: "failed" },
      );
      expect(closes).toHaveLength(1);
    } finally {
      spawnSpy.mockRestore();
      jobSpy.mockRestore();
    }
  });

  for (const action of ["stop", "eof", "malformed"]) {
    test(`joined helper does not launch before GO after ${action}`, async () => {
      const job = native.createJob();
      const helper = childProcess.spawn(
        process.execPath,
        ["--no-env-file", helperPath, job.name],
        { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true },
      );
      const closed = once(helper, "close");
      try {
        const ready: unknown = (await once(helper, "message"))[0];
        expect(ready).toEqual({ kind: "ready" });
        expect(job.empty()).toBe(false);
        if (action === "eof") helper.disconnect();
        else helper.send({ kind: action });
        await closed;
        expect(job.empty()).toBe(true);
      } finally {
        job.terminate();
        job.close();
      }
    });
  }

  test("missing Windows job refuses helper before target launch", async () => {
    const helper = childProcess.spawn(
      process.execPath,
      ["--no-env-file", helperPath, "Local\\DamadamaCapture-does-not-exist"],
      { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true },
    );
    const messages: unknown[] = [];
    helper.on("message", (message: unknown) => messages.push(message));
    const code: unknown = (await once(helper, "close"))[0];
    expect(code).toBe(1);
    expect(messages).toEqual([]);
  });
}

if (process.platform === "linux") {
  test("group query permission error remains explicit uncertainty", async () => {
    const original = process.kill.bind(process);
    const mock = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 0)
        throw Object.assign(new Error(secret), { code: "EPERM" });
      return original(pid, signal);
    });
    try {
      const error = await retirementFailure(
        captureCommand(evalCommand("setInterval(()=>{},30000)"), {
          timeoutMs: 100,
        }),
      );
      expect(error.reason).toEqual({ kind: "timeout" });
      expect(error.message).not.toContain(secret);
    } finally {
      mock.mockRestore();
    }
  });
}
