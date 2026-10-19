import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { selectedFiles } from "./playwright.config.mjs";
import {
  atomicJson,
  createEvidenceDirectory,
  mediaFiles,
  mediaSnapshot,
  preparedInputs,
  retainMedia,
  summarizeTests,
  verifyMedia,
} from "./native-evidence.mjs";
import {
  absence,
  descendants,
  fileIdentity,
  fixtureSnapshot,
  freshFixtures,
  listenerIds,
  newContainer,
  postgresContainers,
  processIdentity,
  removeOwnedFixtures,
  sameFile,
  sameProcess,
  successfulOutput,
} from "./owned-resources.mjs";

function query(root, program, args) {
  return successfulOutput(
    spawnSync(program, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }),
    "input",
  );
}

export async function main() {
  const root = await realpath(
    fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const id = randomUUID();
  const directory = await createEvidenceDirectory(root, id);
  const lock = join(root, ".audit/verification-skill/native.lock");
  const session = {
    schema: 1,
    id,
    status: "incomplete",
    platform: process.platform,
    selfTests: { state: "not-started" },
    doctor: { state: "not-started" },
    invocation: { state: "not-started" },
  };
  const cleanup = { schema: 1, id, status: "unverified", exit: 1, reasons: [] };
  await atomicJson(join(directory, "session.json"), session);
  await atomicJson(join(directory, "cleanup.json"), cleanup);
  let locked = false;
  let active = null;
  let cancellation = null;
  let owned = null;
  let beforeFixtures;
  let beforeMedia;
  const failures = new Set();
  const fail = (error) =>
    failures.add(
      /^[a-z-]+$/.test(error.message)
        ? error.message
        : "native-observation-failed",
    );
  const forward = async (signal) => {
    cancellation = signal;
    failures.add("native-session-cancelled");
    if (
      active?.identity &&
      sameProcess(active.identity, await processIdentity(active.child.pid))
    )
      active.child.kill(signal);
  };
  const onInterrupt = () => {
    void forward("SIGINT").catch(fail);
  };
  const onTerminate = () => {
    void forward("SIGTERM").catch(fail);
  };
  const execute = async (field, program, args, observe) => {
    const child = spawn(program, args, { cwd: root, stdio: "inherit" });
    const command = [program, ...args];
    active = { child, identity: null };
    session[field] = { state: "running", process: null, command };
    let completion;
    child.once("error", () => {
      completion = { state: "exited", code: 127 };
    });
    child.once("exit", (code, signal) => {
      completion = { state: "exited", code, signal };
    });
    const identity = await processIdentity(child.pid).catch((error) => {
      fail(error);
      return null;
    });
    active.identity = identity;
    session[field].process = identity;
    await atomicJson(join(directory, "session.json"), session).catch(fail);
    while (!completion) {
      if (observe && identity) await observe(child.pid).catch(fail);
      await delay(500);
    }
    active = null;
    return { ...completion, process: identity, command };
  };
  try {
    if (process.platform !== "linux") throw new Error("native-linux-required");
    if (process.argv.length !== 2)
      throw new Error("native-command-takes-no-arguments");
    await mkdir(lock).catch((error) => {
      if (error.code === "EEXIST")
        throw new Error("checkout-native-session-already-locked");
      throw error;
    });
    locked = true;
    session.observer = await processIdentity(process.pid);
    await atomicJson(join(lock, "owner.json"), {
      id,
      process: session.observer,
    });
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    session.source = {
      head: query(root, "git", ["rev-parse", "HEAD"]),
      tree: query(root, "git", ["rev-parse", "HEAD^{tree}"]),
      prHead: process.env["VERIFICATION_PR_HEAD"] ?? null,
    };
    if (session.source.prHead) {
      if (!/^[a-f0-9]{40}$/.test(session.source.prHead))
        throw new Error("pr-head-invalid");
      query(root, "git", [
        "merge-base",
        "--is-ancestor",
        session.source.prHead,
        session.source.head,
      ]);
    }
    if (query(root, "git", ["status", "--porcelain"]))
      throw new Error("source-checkout-not-clean");
    session.versions = {
      node: process.version,
      bun: query(root, "bun", ["--version"]),
      dotnet: query(root, "dotnet", ["--version"]),
    };
    session.inputs = await preparedInputs(root);
    session.selfTests = await execute("selfTests", process.execPath, [
      "--test",
      ".agents/skills/verify/owned-resources.test.mjs",
      ".agents/skills/verify/native-linux.test.mjs",
    ]);
    if (session.selfTests.code !== 0 || cancellation)
      throw new Error("native-self-tests-failed");
    session.doctor = await execute("doctor", "bun", [
      "run",
      "doctor",
      "browser",
    ]);
    await atomicJson(join(directory, "session.json"), session);
    if (session.doctor.code !== 0 || cancellation)
      throw new Error("doctor-failed");
    const ports = [
      Number(process.env["DAMADAMA_API_PORT"] ?? "5055"),
      Number(process.env["DAMADAMA_BROWSER_PORT"] ?? "5174"),
    ];
    session.ports = ports;
    const baseline = postgresContainers();
    beforeFixtures = await fixtureSnapshot(root);
    beforeMedia = await mediaSnapshot(root);
    session.baseline = {
      containers: baseline,
      fixtures: beforeFixtures,
      media: beforeMedia,
    };
    const rawReport = ".audit/verification-skill/results.raw.json";
    const beforeReport = await fileIdentity(root, rawReport);
    const processes = new Map();
    const containers = new Set();
    const observe = async (pid) => {
      const identities = await descendants(pid);
      for (const row of identities)
        processes.set(`${row.pid}:${row.startTicks}:${row.bootId}`, row);
      const listeners = ports.map((port) => ({
        port,
        pids: listenerIds(port),
      }));
      const container = newContainer(baseline, postgresContainers());
      if (container) containers.add(container.id);
      if (containers.size > 1) throw new Error("container-ownership-ambiguous");
      if (
        !owned &&
        container?.status.startsWith("Up ") &&
        listeners.every(
          (row) =>
            row.pids.length > 0 &&
            row.pids.every((p) =>
              identities.some((identity) => identity.pid === p),
            ),
        )
      ) {
        const fixtures = await fixtureSnapshot(root);
        if (freshFixtures(beforeFixtures, fixtures))
          owned = { listeners, container, fixtures };
      }
      session.observation = {
        processes: [...processes.values()],
        owned,
      };
      await atomicJson(join(directory, "session.json"), session);
    };
    session.invocation = await execute(
      "invocation",
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        ".agents/skills/verify/playwright.config.mjs",
      ],
      observe,
    );
    cleanup.evidence = await retainMedia(root, directory, beforeMedia);
    try {
      const afterReport = await fileIdentity(root, rawReport);
      if (!afterReport || sameFile(beforeReport, afterReport))
        throw new Error("fresh-test-results-missing");
      const summary = summarizeTests(
        JSON.parse(await readFile(join(root, rawReport), "utf8")),
        selectedFiles,
      );
      await atomicJson(join(directory, "selected-tests.json"), summary);
      if (
        !summary.passed ||
        Object.keys(cleanup.evidence).length !== mediaFiles.length
      )
        throw new Error("complete-feature-evidence-missing");
    } catch (error) {
      fail(error);
    }
    if (owned) {
      owned.processes = [...processes.values()];
      const deadline = Date.now() + 15_000;
      do {
        cleanup.absence = await absence(owned, ports);
        if (cleanup.absence.gone) break;
        await delay(250);
      } while (Date.now() < deadline);
      if (!cleanup.absence.gone) throw new Error("owned-resources-remain");
      await removeOwnedFixtures(root, beforeFixtures, owned.fixtures);
      await verifyMedia(directory, cleanup.evidence);
      cleanup.fixturesRemoved = true;
      cleanup.evidenceSurvived = true;
      cleanup.status = "verified";
      cleanup.exit = 0;
    } else throw new Error("resource-ownership-unverified");
    if (
      JSON.stringify(await preparedInputs(root)) !==
        JSON.stringify(session.inputs) ||
      query(root, "git", ["rev-parse", "HEAD"]) !== session.source.head ||
      query(root, "git", ["status", "--porcelain"])
    )
      throw new Error("source-or-build-inputs-changed");
    if (session.invocation.code !== 0 || cancellation)
      throw new Error("skill-invocation-failed");
  } catch (error) {
    fail(error);
  } finally {
    session.status =
      failures.size === 0 && cleanup.exit === 0 ? "passed" : "failed";
    session.failures = [...failures];
    session.cancellation = cancellation;
    cleanup.reasons = cleanup.exit === 0 ? [] : [...failures];
    await atomicJson(join(directory, "session.json"), session);
    await atomicJson(join(directory, "cleanup.json"), cleanup);
    const neverStarted = session.invocation.state === "not-started";
    if (locked && (cleanup.exit === 0 || neverStarted)) {
      await unlink(join(lock, "owner.json"));
      await rmdir(lock);
    }
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
  console.info(
    `Native skill receipt: .audit/verification-skill/retained/${id}; ${session.status}`,
  );
  return session.status === "passed" ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main();
