import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as poll } from "node:timers/promises";
import { captureCommand } from "./doctor";

type Role = "root" | "descendant" | "sentinel";
type Peer = { pid: number; socket: Socket; identity: string };
const fixture = join(import.meta.dir, "fixtures/doctor-process-tree.ts");
const node = Bun.which("node");
assert.ok(node, "Node 24 is required by the prerequisite recipe");

async function identity(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") {
    const observation = Bun.spawnSync([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `try { $owned = [System.Diagnostics.Process]::GetProcessById(${pid}) } catch [System.ArgumentException] { exit 0 }; try { if (!$owned.HasExited) { $owned.StartTime.ToUniversalTime().Ticks } } finally { $owned.Dispose() }`,
    ]);
    assert.equal(observation.exitCode, 0, observation.stderr.toString());
    return observation.stdout.toString().trim() || undefined;
  }
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return String(pid);
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "ENOENT")
    )
      return undefined;
    throw error;
  }
}

async function absent(peer: Peer): Promise<boolean> {
  return (await identity(peer.pid)) !== peer.identity;
}

async function until(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    assert.ok(
      Date.now() < deadline,
      "Owned fixture condition did not complete",
    );
    await poll(10);
  }
}

for (const completion of ["timeout", "stdout", "stderr", "natural"]) {
  test(`capture completion retires its descendant after ${completion}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "doctor-owned-tree-"));
    const token = randomUUID();
    const peers = new Map<Role, Peer>();
    const sockets = new Set<Socket>();
    const handshakes: Promise<void>[] = [];
    let stopping = false;
    let removalAttempted = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", (data: string) => {
        input += data;
        if (!input.includes("\n")) return;
        const [received, role, rawPid] = input.trim().split(" ");
        assert.equal(received, token);
        assert.ok(
          role === "root" || role === "descendant" || role === "sentinel",
        );
        assert.ok(rawPid && /^\d+$/.test(rawPid));
        const pid = Number(rawPid);
        socket.removeAllListeners("data");
        handshakes.push(
          (async (): Promise<void> => {
            const observed = await identity(pid);
            assert.ok(observed, `Ready ${role} must actually be alive`);
            peers.set(role, { pid, socket, identity: observed });
            if (stopping) socket.write("stop\n");
          })(),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = String(address.port);
    const sentinel = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fixture,
        "sentinel",
        port,
        token,
        tmpdir(),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const capture = captureCommand(
      [
        process.execPath,
        "--no-env-file",
        fixture,
        "root",
        port,
        token,
        directory,
        completion,
        node,
      ],
      { timeoutMs: 5000, maxBytes: 128 },
    );
    const captureSettlement = Promise.allSettled([capture]);
    const failures: unknown[] = [];
    try {
      await until(async () => peers.size === 3, 4000);
      const root = peers.get("root");
      const descendant = peers.get("descendant");
      const unrelated = peers.get("sentinel");
      assert.ok(root && descendant && unrelated);
      root.socket.write("go\n");
      const result = await capture;
      let expected: Awaited<ReturnType<typeof captureCommand>> = {
        kind: "output-limit",
      };
      if (completion === "timeout") expected = { kind: "timeout" };
      if (completion === "natural")
        expected = { kind: "ok", output: "complete" };
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain("private-tree-output");
      expect(
        await absent(unrelated),
        "Unrelated sentinel must remain alive",
      ).toBe(false);
      expect(
        await absent(root),
        "Capture must retire its root before completing",
      ).toBe(true);
      expect(
        await absent(descendant),
        "Capture completed with a live owned descendant",
      ).toBe(true);
      removalAttempted = true;
      await rm(directory, { recursive: true });
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        stopping = true;
        for (const peer of peers.values()) {
          if (!peer.socket.destroyed) peer.socket.write("stop\n");
        }
        const settlements = [
          ...(await captureSettlement),
          ...(await Promise.allSettled(handshakes)),
        ];
        for (const settlement of settlements) {
          if (
            settlement.status === "rejected" &&
            !failures.includes(settlement.reason)
          )
            failures.push(settlement.reason);
        }
        await until(async () => {
          const gone = await Promise.all([...peers.values()].map(absent));
          return gone.every(Boolean) && peers.size === 3;
        }, 22_000);
        await sentinel.exited;
        if (!removalAttempted) {
          removalAttempted = true;
          await rm(directory, { recursive: true });
        }
      } catch (error) {
        failures.push(
          new Error(`Cleanup absence unproven. Preserved ${directory}`, {
            cause: error,
          }),
        );
      } finally {
        for (const socket of sockets) socket.destroy();
        try {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            }),
          );
        } catch (error) {
          failures.push(error);
        }
      }
    }
    const [failure] = failures;
    if (failures.length === 1 && failure instanceof Error) throw failure;
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Capture or owned-fixture cleanup failed",
      );
  }, 35_000);
}
