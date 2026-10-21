import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rmdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  atomicJson,
  mediaFiles,
  preparedInputs,
  retainMedia,
  summarizeTests,
  verifyMedia,
} from "./native-evidence.mjs";
import { selectedFiles } from "./playwright.config.mjs";
import {
  containerPresent,
  fileIdentity,
  fixtureFiles,
  fixtureSnapshot,
  freshFixtures,
  listenerIds,
  newContainer,
  parseProcessStat,
  postgresContainers,
  processIdentity,
  removeOwnedFixtures,
  sameProcess,
  successfulOutput,
} from "./owned-resources.mjs";

const result = (stdout = "", status = 0, stderr = "") => ({
  stdout,
  status,
  stderr,
  signal: null,
});
const container = (id) => ({
  id: id.repeat(64),
  image: "postgres:17-alpine",
  status: "Up 1 second",
});

async function temporary(run) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "damadama-native-proof-"));
  try {
    await mkdir(join(root, "tests/Browser"), { recursive: true });
    await mkdir(join(root, ".audit/browser-build"), { recursive: true });
    await mkdir(join(root, ".audit/verification-skill"), { recursive: true });
    await run(root);
  } finally {
    assert.equal(dirname(root), parent);
    await rm(root, { recursive: true, force: true });
  }
}

test("prepared fingerprints use canonical production output and refuse a stale legacy directory", async () =>
  temporary(async (root) => {
    await mkdir(join(root, "server/wwwroot"), { recursive: true });
    await mkdir(join(root, ".audit/check-build/bin/BrowserHost/debug"), {
      recursive: true,
    });
    await writeFile(join(root, "bun.lock"), "locked-input");
    await writeFile(join(root, "server/wwwroot/index.html"), "production");
    await writeFile(join(root, ".audit/browser-build/index.html"), "fixture");
    await writeFile(
      join(root, ".audit/check-build/bin/BrowserHost/debug/BrowserHost.dll"),
      "host",
    );
    const before = await preparedInputs(root);
    assert.deepEqual(
      before.map((input) => input.path),
      [
        "bun.lock",
        "server/wwwroot",
        ".audit/browser-build",
        ".audit/check-build/bin/BrowserHost",
      ],
    );
    for (const path of fixtureFiles)
      await writeFile(join(root, path), "private-sentinel");
    assert.deepEqual(await preparedInputs(root), before);
    await writeFile(join(root, "server/wwwroot/index.html"), "changed");
    assert.notDeepEqual(await preparedInputs(root), before);
    await mkdir(join(root, "web/dist"), { recursive: true });
    await writeFile(join(root, "web/dist/index.html"), "stale");
    await unlink(join(root, "server/wwwroot/index.html"));
    await rmdir(join(root, "server/wwwroot"));
    await assert.rejects(preparedInputs(root), { code: "ENOENT" });
  }));

test("failed commands and diagnostics never become successful empty observations", () => {
  assert.equal(successfulOutput(result("observed\n"), "probe"), "observed");
  for (const observation of [
    result("", 1),
    result("", 0, "private-sentinel"),
    { ...result(), signal: "SIGTERM" },
    { ...result(), error: new Error("private-sentinel") },
  ])
    assert.throws(
      () => successfulOutput(observation, "probe"),
      /^Error: probe-query-failed$/,
    );
});

test("lsof accepts exact no-match and listener PIDs but rejects partial or failed queries", () => {
  assert.deepEqual(
    listenerIds(5055, () => result("", 1)),
    [],
  );
  assert.deepEqual(
    listenerIds(5055, () => result("123\n123\n456\n")),
    [123, 456],
  );
  for (const observation of [
    result("", 0),
    result("", 2),
    result("", 1, "private-sentinel"),
    result("unknown"),
  ])
    assert.throws(
      () => listenerIds(5055, () => observation),
      /listener-query-failed/,
    );
});

test("container observation retains only safe fields and rejects truncation or ambiguous ownership", () => {
  const first = container("a");
  assert.deepEqual(
    postgresContainers((program, args) => {
      assert.equal(program, "docker");
      assert.deepEqual(args.slice(-2), [
        "--format",
        "{{.ID}}\t{{.Image}}\t{{.Status}}",
      ]);
      return result(`${first.id}\t${first.image}\t${first.status}\n`);
    }),
    [first],
  );
  assert.deepEqual(
    postgresContainers(() => result()),
    [],
  );
  assert.throws(
    () => postgresContainers(() => result("", 1)),
    /container-query-failed/,
  );
  assert.throws(
    () =>
      postgresContainers(() => result("abc\tpostgres:17-alpine\tUp 1 second")),
    /invalid/,
  );
  assert.equal(newContainer([first], [first]), null);
  assert.deepEqual(
    newContainer([first], [first, container("b")]),
    container("b"),
  );
  assert.throws(
    () => newContainer([], [first, container("b")]),
    /ownership-ambiguous/,
  );
  assert.equal(
    containerPresent(first.id, () => result(first.id)),
    true,
  );
  assert.equal(
    containerPresent(first.id, () => result()),
    false,
  );
  assert.throws(
    () => containerPresent(first.id, () => result("", 1)),
    /query-failed/,
  );
});

test("missing boot identity is a query failure, not evidence that a process disappeared", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  await assert.rejects(
    processIdentity(1, async () => {
      throw missing;
    }),
    /query-failed/,
  );
  assert.equal(
    await processIdentity(1, async (path) => {
      if (path.endsWith("boot_id")) return "boot-one";
      throw missing;
    }),
    null,
  );
});

test("process identity uses start ticks and boot identity, without command lines or environments", () => {
  const fields = Array(25).fill("0");
  fields[0] = "S";
  fields[1] = "42";
  fields[19] = "123456";
  const identity = parseProcessStat(
    `99 (node (worker)) ${fields.join(" ")}`,
    "boot-one",
  );
  assert.deepEqual(identity, {
    pid: 99,
    parentPid: 42,
    name: "node (worker)",
    startTicks: "123456",
    bootId: "boot-one",
  });
  assert.equal(sameProcess(identity, { ...identity }), true);
  assert.equal(
    sameProcess(identity, { ...identity, startTicks: "123457" }),
    false,
  );
  assert.equal(
    sameProcess(identity, { ...identity, bootId: "boot-two" }),
    false,
  );
  assert.equal(sameProcess(identity, null), false);
  assert.throws(() => parseProcessStat("bad data", "boot"), /invalid/);
});

test("a process that exits during its stat read is absent", async () => {
  assert.equal(
    await processIdentity(1, async (path) => {
      if (path.endsWith("boot_id")) return "boot-one";
      throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    }),
    null,
  );
});

test("process identity retains only fixed diagnostic stages and allowlisted error codes", async () => {
  await assert.rejects(
    processIdentity(1, async () => {
      throw Object.assign(new Error("private boot query detail"), {
        code: "ESRCH",
      });
    }),
    { message: "process-identity-query-failed-boot-id-read-esrch" },
  );
  await assert.rejects(
    processIdentity(1, async (path) => {
      if (path.endsWith("boot_id")) return "boot-one";
      throw Object.assign(new Error("private stat query detail"), {
        code: "EIO",
      });
    }),
    { message: "process-identity-query-failed-stat-read-eio" },
  );
  await assert.rejects(
    processIdentity(1, async (path) => {
      if (path.endsWith("boot_id")) return "boot-one";
      throw Object.assign(new Error("private stat query detail"), {
        code: "private-code",
        path: "/private/path",
      });
    }),
    { message: "process-identity-query-failed-stat-read-unknown" },
  );
  await assert.rejects(
    processIdentity(1, async (path) => {
      if (path.endsWith("boot_id")) return "boot-one";
      return "private malformed stat content";
    }),
    { message: "process-identity-query-failed-stat-parse-unknown" },
  );
});

test("process identity refuses boot, permission, unknown and malformed-stat failures", async () => {
  for (const code of ["ESRCH", "ENOENT", "EACCES", "EIO", "unexpected"]) {
    await assert.rejects(
      processIdentity(1, async () => {
        throw Object.assign(new Error("boot query failed"), { code });
      }),
      /process-identity-query-failed/,
    );
  }
  for (const code of ["EACCES", "EPERM", "EMFILE", "EIO", "unexpected"]) {
    await assert.rejects(
      processIdentity(1, async (path) => {
        if (path.endsWith("boot_id")) return "boot-one";
        throw Object.assign(new Error("stat query failed"), { code });
      }),
      /process-identity-query-failed/,
    );
  }
  await assert.rejects(
    processIdentity(1, async (path) => {
      if (path.endsWith("boot_id")) return "boot-one";
      return "malformed stat";
    }),
    /process-identity-query-failed/,
  );
});

function browserReport() {
  const report = {
    errors: [],
    suites: selectedFiles.map((file) => ({
      specs: [
        {
          file,
          title: "Source-declared test",
          tests: [
            {
              expectedStatus: "passed",
              results: [{ status: "passed", duration: 12 }],
            },
          ],
        },
      ],
    })),
  };
  report.suites.at(-1).specs[0].tests[0].results[0].attachments = [
    {
      name: "saved-list-state-observations",
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({ emptyWhileLoading: true, emptyAfterRefusal: false }),
      ).toString("base64"),
    },
  ];
  return report;
}

test("saved-list evidence retains exactly two observed booleans and rejects private or missing payloads", () => {
  assert.deepEqual(summarizeTests(browserReport(), selectedFiles).savedList, {
    emptyWhileLoading: true,
    emptyAfterRefusal: false,
  });
  const missing = browserReport();
  missing.suites.at(-1).specs[0].tests[0].results[0].attachments = [];
  assert.equal(summarizeTests(missing, selectedFiles).passed, false);
  for (const value of [
    { emptyWhileLoading: "private-sentinel", emptyAfterRefusal: false },
    {
      emptyWhileLoading: true,
      emptyAfterRefusal: false,
      token: "private-sentinel",
    },
  ]) {
    const invalid = browserReport();
    invalid.suites.at(-1).specs[0].tests[0].results[0].attachments[0].body =
      Buffer.from(JSON.stringify(value)).toString("base64");
    assert.throws(
      () => summarizeTests(invalid, selectedFiles),
      /^Error: saved-list-observation-invalid$/,
    );
  }
});

test("selected-test evidence requires every configured file and actual passing outcomes", () => {
  const good = summarizeTests(browserReport(), selectedFiles);
  assert.equal(good.passed, true);
  assert.equal(good.count, selectedFiles.length);
  const missing = browserReport();
  missing.suites.pop();
  assert.equal(summarizeTests(missing, selectedFiles).passed, false);
  for (const status of ["skipped", "failed", "timedOut", "interrupted"]) {
    const bad = browserReport();
    bad.suites[0].specs[0].tests[0].results[0].status = status;
    assert.equal(summarizeTests(bad, selectedFiles).passed, false);
  }
  const retry = browserReport();
  retry.suites[0].specs[0].tests[0].results.push({
    status: "passed",
    duration: 1,
  });
  assert.equal(summarizeTests(retry, selectedFiles).passed, false);
});

test("selected-test summaries exclude errors, attachments and raw private output", () => {
  const raw = browserReport();
  raw.errors.push({ message: "private-sentinel" });
  raw.suites[0].specs[0].tests[0].results[0].stdout = [
    { text: "private-sentinel" },
  ];
  const sanitized = summarizeTests(raw, selectedFiles);
  assert.equal(sanitized.passed, false);
  assert.equal(JSON.stringify(sanitized).includes("private-sentinel"), false);
  const invalid = browserReport();
  invalid.suites[0].specs[0].tests[0].results[0].duration = {
    private: "private-sentinel",
  };
  assert.throws(() => summarizeTests(invalid, selectedFiles), /result-invalid/);
});

test("stale and replaced fixture files cannot be removed", async () =>
  temporary(async (root) => {
    for (const path of fixtureFiles)
      await writeFile(join(root, path), "before");
    const before = await fixtureSnapshot(root);
    assert.equal(freshFixtures(before, before), false);
    await assert.rejects(
      removeOwnedFixtures(root, before, before),
      /ownership-unverified/,
    );
    for (const path of fixtureFiles)
      await writeFile(join(root, path), "owned-fresh");
    const observed = await fixtureSnapshot(root);
    assert.equal(freshFixtures(before, observed), true);
    await writeFile(
      join(root, fixtureFiles[1]),
      "replacement-after-observation",
    );
    await assert.rejects(
      removeOwnedFixtures(root, before, observed),
      /changed-before-cleanup/,
    );
    assert.equal(
      await readFile(join(root, fixtureFiles[0]), "utf8"),
      "owned-fresh",
    );
  }));

test("only fresh allowlisted media survives staging; token files and changed evidence are refused", async () =>
  temporary(async (root) => {
    const before = {};
    for (const path of mediaFiles)
      before[path] = await fileIdentity(root, path);
    const directory = join(root, "retained");
    await mkdir(directory);
    await writeFile(join(root, mediaFiles[0]), "synthetic-image-fixture");
    await writeFile(join(root, fixtureFiles[0]), "private-sentinel");
    const hashes = await retainMedia(root, directory, before);
    assert.deepEqual(await readdir(directory), ["habit-immediate.png"]);
    await verifyMedia(directory, hashes);
    const unchanged = await retainMedia(root, directory, {
      ...before,
      [mediaFiles[0]]: await fileIdentity(root, mediaFiles[0]),
    });
    assert.deepEqual(unchanged, {});
    await writeFile(join(directory, "habit-immediate.png"), "changed");
    await assert.rejects(verifyMedia(directory, hashes), /evidence-changed/);
  }));

test("atomic receipts retain the completed value and leave no temporary payload", async () =>
  temporary(async (root) => {
    const path = join(root, "session.json");
    await atomicJson(path, { status: "incomplete" });
    await atomicJson(path, { status: "failed", exit: 1 });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      status: "failed",
      exit: 1,
    });
    assert.equal(
      (await readdir(root)).some((name) => name.endsWith(".tmp")),
      false,
    );
  }));
