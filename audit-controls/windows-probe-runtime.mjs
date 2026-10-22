import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(import.meta.dirname);
const role = process.env.DAMADAMA_PROBE_ROLE === "worker" ? "worker" : "test";
mkdirSync(output, { recursive: true });

export function probeEvent(kind, detail = {}) {
  appendFileSync(
    resolve(output, `events-${role}.jsonl`),
    JSON.stringify({
      utc: new Date().toISOString(),
      pid: process.pid,
      kind,
      ...detail,
    }) + "\n",
  );
}

export async function probeText(stream, name) {
  const reader = stream.getReader();
  const buffer = Buffer.alloc(16_384);
  let bytes = 0;
  let retained = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    const keep = Math.min(value.byteLength, 16_384 - retained);
    if (keep > 0) {
      buffer.set(value.subarray(0, keep), retained);
      retained += keep;
    }
  }
  probeEvent("stream-eof", {
    stream: name,
    bytes,
    truncated: bytes > retained,
  });
  return buffer.subarray(0, retained).toString("utf8");
}

export function probeEnvironment() {
  const keys = ["ProgramFiles", "ProgramW6432", "ProgramData", "DOCKER_CONFIG"];
  const effective = Object.fromEntries(
    keys.map((key) => [key, process.env[key] ?? null]),
  );
  const roots = [
    effective.DOCKER_CONFIG && resolve(effective.DOCKER_CONFIG, "cli-plugins"),
    effective.ProgramFiles &&
      resolve(effective.ProgramFiles, "Docker/cli-plugins"),
  ].filter(Boolean);
  try {
    const config = JSON.parse(
      readFileSync(resolve(effective.DOCKER_CONFIG, "config.json"), "utf8"),
    );
    if (Array.isArray(config.cliPluginsExtraDirs)) {
      roots.push(
        ...config.cliPluginsExtraDirs.filter(
          (path) => typeof path === "string",
        ),
      );
    }
  } catch {
    probeEvent("extra-plugin-directories-unavailable");
  }
  const candidates = roots.map((directory) => {
    try {
      return {
        directory,
        files: readdirSync(directory)
          .filter((name) => /^docker-.*\.exe$/i.test(name))
          .sort(),
      };
    } catch (error) {
      return { directory, code: error.code ?? "unknown" };
    }
  });
  probeEvent("effective-discovery-environment", { effective, candidates });
}
