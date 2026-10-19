import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const fixtureFiles = [
  "tests/Browser/fixture.json",
  ".audit/browser-build/fixture.json",
];

function probe(program, args) {
  return spawnSync(program, args, {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 1024 * 1024,
  });
}

export function successfulOutput(result, operation) {
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    result.stderr.trim()
  )
    throw new Error(`${operation}-query-failed`);
  return result.stdout.trim();
}

export function parseProcessStat(text, bootId) {
  const end = text.lastIndexOf(")");
  const match = /^(\d+) \((.*)$/s.exec(text.slice(0, end));
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (
    !match ||
    !/^\d+$/.test(fields[1] ?? "") ||
    !/^\d+$/.test(fields[19] ?? "")
  )
    throw new Error("process-stat-invalid");
  return {
    pid: Number(match[1]),
    parentPid: Number(fields[1]),
    name: match[2],
    startTicks: fields[19],
    bootId,
  };
}

export async function processIdentity(pid, read = readFile) {
  let bootId;
  try {
    bootId = await read("/proc/sys/kernel/random/boot_id", "utf8");
  } catch {
    throw new Error("process-identity-query-failed");
  }
  try {
    const stat = await read(`/proc/${pid}/stat`, "utf8");
    return parseProcessStat(stat, bootId.trim());
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("process-identity-query-failed");
  }
}

export function sameProcess(left, right) {
  return Boolean(
    left &&
    right &&
    left.pid === right.pid &&
    left.startTicks === right.startTicks &&
    left.bootId === right.bootId,
  );
}

export async function descendants(pid) {
  const text = successfulOutput(
    probe("ps", ["-eo", "pid=,ppid="]),
    "process-list",
  );
  const rows = text.split("\n").map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error("process-list-invalid");
    return { pid: Number(match[1]), parentPid: Number(match[2]) };
  });
  const ids = new Set([pid]);
  let previous;
  do {
    previous = ids.size;
    for (const row of rows) if (ids.has(row.parentPid)) ids.add(row.pid);
  } while (ids.size !== previous);
  return (await Promise.all([...ids].map((id) => processIdentity(id)))).filter(
    Boolean,
  );
}

export function listenerIds(port, execute = probe) {
  const result = execute("lsof", [
    "-nP",
    "-t",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
  ]);
  if (result.error || result.signal || result.stderr.trim())
    throw new Error("listener-query-failed");
  const text = result.stdout.trim();
  if (result.status === 1 && text === "") return [];
  if (result.status !== 0 || !/^\d+(?:\s+\d+)*$/.test(text))
    throw new Error("listener-query-failed");
  return [...new Set(text.split(/\s+/).map(Number))];
}

export function postgresContainers(execute = probe) {
  const text = successfulOutput(
    execute("docker", [
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      "ancestor=postgres:17-alpine",
      "--format",
      "{{.ID}}\t{{.Image}}\t{{.Status}}",
    ]),
    "container",
  );
  if (!text) return [];
  return text.split("\n").map((line) => {
    const [id, image, status] = line.split("\t");
    if (
      !/^[a-f0-9]{64}$/.test(id ?? "") ||
      image !== "postgres:17-alpine" ||
      !status
    )
      throw new Error("container-observation-invalid");
    return { id, image, status };
  });
}

export function newContainer(baseline, current) {
  const existing = new Set(baseline.map((row) => row.id));
  const added = current.filter((row) => !existing.has(row.id));
  if (added.length > 1) throw new Error("container-ownership-ambiguous");
  return added[0] ?? null;
}

export function containerPresent(id, execute = probe) {
  const text = successfulOutput(
    execute("docker", [
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `id=${id}`,
      "--format",
      "{{.ID}}",
    ]),
    "container",
  );
  if (text !== "" && text !== id)
    throw new Error("container-absence-query-invalid");
  return text === id;
}

function fileFields(stat, parent) {
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("fixture-file-type-refused");
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    size: String(stat.size),
    modified: String(stat.mtimeNs),
    changed: String(stat.ctimeNs),
    parentDevice: String(parent.dev),
    parentInode: String(parent.ino),
  };
}

export async function fileIdentity(root, relative) {
  const path = join(root, relative);
  if ((await realpath(dirname(path))) !== resolve(dirname(path)))
    throw new Error("fixture-parent-link-refused");
  try {
    return fileFields(
      await lstat(path, { bigint: true }),
      await lstat(dirname(path), { bigint: true }),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function sameFile(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function fixtureSnapshot(root) {
  return Object.fromEntries(
    await Promise.all(
      fixtureFiles.map(async (path) => [path, await fileIdentity(root, path)]),
    ),
  );
}

export function freshFixtures(before, observed) {
  return fixtureFiles.every(
    (path) => observed[path] && !sameFile(before[path], observed[path]),
  );
}

export async function removeOwnedFixtures(root, before, observed) {
  if (!observed || !freshFixtures(before, observed))
    throw new Error("fixture-ownership-unverified");
  const current = await fixtureSnapshot(root);
  for (const path of fixtureFiles) {
    if (current[path] && !sameFile(current[path], observed[path]))
      throw new Error("fixture-changed-before-cleanup");
  }
  for (const path of fixtureFiles) {
    if (!current[path]) continue;
    const parent = await open(
      dirname(join(root, path)),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const parentStat = await parent.stat({ bigint: true });
      const entry = `/proc/self/fd/${parent.fd}/${basename(path)}`;
      const actual = fileFields(
        await lstat(entry, { bigint: true }),
        parentStat,
      );
      if (!sameFile(actual, observed[path]))
        throw new Error("fixture-changed-before-cleanup");
      await unlink(entry);
    } finally {
      await parent.close();
    }
  }
  const after = await fixtureSnapshot(root);
  if (fixtureFiles.some((path) => after[path]))
    throw new Error("fixture-removal-unverified");
}

export async function absence(owned, ports) {
  const alive = [];
  for (const identity of owned.processes) {
    if (sameProcess(identity, await processIdentity(identity.pid)))
      alive.push(identity);
  }
  const listeners = ports.map((port) => ({ port, pids: listenerIds(port) }));
  const containers = [];
  if (containerPresent(owned.container.id))
    containers.push({ id: owned.container.id });
  return {
    gone:
      alive.length === 0 &&
      listeners.every((row) => row.pids.length === 0) &&
      containers.length === 0,
    processes: alive,
    listeners,
    containers,
  };
}
