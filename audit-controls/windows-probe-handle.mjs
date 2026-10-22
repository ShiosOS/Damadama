import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const [executable, casePath, output, mode] = process.argv.slice(2);
assert.equal(basename(executable).toLowerCase(), "handle64.exe");
assert.ok(mode === "control" || mode === "formatter");
assert.match(
  basename(casePath),
  mode === "control" ? /^case-[a-zA-Z0-9]+$/ : /^format-[a-zA-Z0-9]+$/,
);
const fixturePath = dirname(resolve(casePath));
assert.match(basename(fixturePath), /^fixture-[a-zA-Z0-9]+$/);
assert.equal(
  dirname(fixturePath).toLowerCase(),
  resolve(output, "../doctor-docker").toLowerCase(),
);
const start = new Date().toISOString();
const child = spawn(executable, ["-accepteula", "-nobanner", casePath], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  timeout: 5000,
  killSignal: "SIGKILL",
});
const streams = {
  stdout: { bytes: 0, buffer: Buffer.alloc(16384), kept: 0 },
  stderr: { bytes: 0, buffer: Buffer.alloc(16384), kept: 0 },
};
for (const [name, stream] of Object.entries(streams)) {
  child[name].on("data", (bytes) => {
    stream.bytes += bytes.length;
    const retained = Math.min(bytes.length, 16384 - stream.kept);
    if (retained > 0) {
      bytes.copy(stream.buffer, stream.kept, 0, retained);
      stream.kept += retained;
    }
  });
}
let errorCode = null;
child.on("error", (error) => {
  errorCode = error.code ?? "unknown";
});
child.on("close", (code, signal) => {
  const result = {
    start,
    end: new Date().toISOString(),
    pid: child.pid,
    casePath,
    code,
    signal,
    errorCode,
    boundMs: 5000,
    output: Object.fromEntries(
      Object.entries(streams).map(([name, stream]) => [
        name,
        {
          bytes: stream.bytes,
          truncated: stream.bytes > stream.kept,
          text: stream.buffer.subarray(0, stream.kept).toString("utf8"),
        },
      ]),
    ),
  };
  writeFileSync(
    resolve(output, "handle-query.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  process.exitCode =
    code === 0 && signal === null && errorCode === null ? 0 : 1;
});
