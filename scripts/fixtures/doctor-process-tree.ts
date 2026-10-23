import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { connect } from "node:net";

const [role, port, token, directory, completion, node] = process.argv.slice(2);
assert.ok(role === "root" || role === "descendant" || role === "sentinel");
assert.ok(port && token && directory);
process.chdir(directory);

setTimeout(() => process.exit(90), 20_000);

async function spawnDescendant(): Promise<void> {
  assert.ok(port && token && directory && node);
  const args = [import.meta.filename, "descendant", port, token, directory];
  if (process.platform === "win32") {
    // Native creation avoids the runtime's own child-exit cleanup masking the leak.
    const { dlopen } = await import("bun:ffi");
    const native = dlopen("kernel32.dll", {
      CreateProcessW: {
        args: [
          "buffer",
          "buffer",
          "ptr",
          "ptr",
          "i32",
          "u32",
          "ptr",
          "buffer",
          "buffer",
          "buffer",
        ],
        returns: "i32",
      },
      CloseHandle: { args: ["u64"], returns: "i32" },
      GetLastError: { args: [], returns: "u32" },
    });
    const wide = (value: string): Buffer =>
      Buffer.from(`${value}\0`, "utf16le");
    const startup = Buffer.alloc(104);
    startup.writeUInt32LE(104);
    const information = Buffer.alloc(24);
    try {
      const created = native.symbols.CreateProcessW(
        wide(node),
        wide([node, ...args].map((arg) => `"${arg}"`).join(" ")),
        null,
        null,
        0,
        0x08000000,
        null,
        wide(directory),
        startup,
        information,
      );
      assert.ok(
        created,
        `CreateProcessW failed with ${native.symbols.GetLastError()}`,
      );
      assert.ok(native.symbols.CloseHandle(information.readBigUInt64LE(0)));
      assert.ok(native.symbols.CloseHandle(information.readBigUInt64LE(8)));
    } finally {
      native.close();
    }
    return;
  }
  let stdio: "ignore" | "inherit" = "inherit";
  if (completion === "natural") stdio = "ignore";
  const descendant = spawn(node, args, { cwd: directory, stdio });
  descendant.on("error", () => process.exit(91));
  descendant.unref();
}

const control = connect(Number(port), "127.0.0.1");
control.on("connect", () => {
  control.write(`${token} ${role} ${process.pid}\n`);
  if (role !== "root") return;
  void spawnDescendant().catch(() => process.exit(91));
});
control.setEncoding("utf8");
control.on("data", (command: string) => {
  if (command.trim() === "stop") process.exit(0);
  if (command.trim() !== "go" || role !== "root") return;
  if (completion === "natural") {
    writeSync(1, "complete\n");
    process.exit(0);
  }
  if (completion === "stdout") writeSync(1, "private-tree-output".repeat(1024));
  if (completion === "stderr") writeSync(2, "private-tree-output".repeat(1024));
});
control.on("error", () => process.exit(92));
