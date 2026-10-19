import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageApplication } from "./package.mjs";

const record = {
  schema: 2,
  source: {
    repository: "ShiosOS/Damadama",
    commit: "1111111111111111111111111111111111111111",
    tree: "4444444444444444444444444444444444444444",
  },
  authority: {
    sha: "1111111111111111111111111111111111111111",
    runId: 42,
    attempt: 2,
  },
};

async function fixture(t) {
  const previous = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "damadama-package-"));
  await mkdir(join(directory, "candidate"));
  process.chdir(directory);
  t.after(async () => {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  });
  const commands = [];
  function execute(command, args) {
    commands.push([command, ...args]);
    if (command === "git")
      return args.at(-1) === "HEAD" ? record.source.commit : record.source.tree;
    if (args[0] === "load") return "Loaded image: damadama-candidate:latest";
    if (args[0] === "create") return "test-only-container";
    return "";
  }
  const builds = [];
  async function build(...args) {
    builds.push(args);
    await writeFile("image.tar", "abc");
  }
  return { commands, execute, build, builds };
}

test("application archive metadata binds its source and controller attempt", async (t) => {
  const f = await fixture(t);
  await packageApplication(record, f.execute, f.build);
  assert.deepEqual(JSON.parse(await readFile("build.json", "utf8")), {
    kind: "application",
    source: record.source,
    authority: record.authority,
    version: "main-111111111111",
    archiveSha256:
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  assert.deepEqual(
    JSON.parse(await readFile("candidate/.damadama-release.json", "utf8")),
    {
      source: record.source,
      version: "main-111111111111",
    },
  );
  assert.deepEqual(f.builds, [
    [
      ".",
      { source: record.source, authority: record.authority },
      {
        context: "candidate",
        dockerfile: "controls/release/Dockerfile",
        tag: "damadama-candidate",
      },
    ],
  ]);
  assert.deepEqual(
    f.commands.filter(([name]) => name === "docker"),
    [
      ["docker", "load", "--input", "image.tar"],
      ["docker", "create", "damadama-candidate"],
      [
        "docker",
        "cp",
        "test-only-container:/app/migrations.sql",
        "migrations.sql",
      ],
      ["docker", "rm", "test-only-container"],
    ],
  );
});

test("a changed reserved metadata file refuses the application build", async (t) => {
  const f = await fixture(t);
  await writeFile(
    "candidate/.damadama-release.json",
    "candidate-controlled content",
  );
  await assert.rejects(
    packageApplication(record, f.execute, f.build),
    /reserved release metadata path differs/,
  );
  assert.equal(
    f.commands.some((command) => command[0] === "docker"),
    false,
  );
});

for (const field of ["commit", "tree"]) {
  test(`a changed source ${field} refuses the paired build`, async (t) => {
    const f = await fixture(t);
    const changed = structuredClone(record);
    changed.source[field] = "a".repeat(40);
    if (field === "commit") changed.authority.sha = changed.source.commit;
    await assert.rejects(
      packageApplication(changed, f.execute, f.build),
      /checkout differs/,
    );
    assert.equal(f.builds.length, 0);
  });
}

test("production upload paths contain only canonical role members", async () => {
  const { productionUploadPaths, buildRoles, scanRoles, releaseMembers } =
    await import("./supply-evidence.mjs");
  for (const [role, members] of [
    ["build", buildRoles],
    ["scan", scanRoles],
    ["release", releaseMembers],
  ])
    assert.deepEqual(
      productionUploadPaths(role, "out"),
      members.map((name) => join("out", name)),
    );
  assert.equal(buildRoles.length, 9);
  assert.equal(scanRoles.length, 11);
  assert.equal(releaseMembers.length, 24);
  assert.throws(
    () => productionUploadPaths("unknown", "out"),
    /unknown production/,
  );
});

test("a mismatched controller refuses before any paired build", async (t) => {
  const f = await fixture(t);
  const changed = structuredClone(record);
  changed.authority.sha = "a".repeat(40);
  await assert.rejects(
    packageApplication(changed, f.execute, f.build),
    /source differs from controller/,
  );
  assert.equal(f.builds.length, 0);
  assert.equal(f.commands.length, 0);
});

for (const failure of ["timeout", "wrong image"])
  test(`archive load ${failure} prevents migration extraction`, async (t) => {
    const f = await fixture(t);
    const execute = (command, args, options) => {
      const result = f.execute(command, args);
      if (command === "docker" && args[0] === "load") {
        assert.equal(options.timeout, 120_000);
        if (failure === "timeout")
          throw Object.assign(new Error("load timed out"), {
            code: "ETIMEDOUT",
          });
        return "Loaded image: another-image:latest";
      }
      return result;
    };
    await assert.rejects(
      packageApplication(record, execute, f.build),
      failure === "timeout" ? /load timed out/ : /did not load the candidate/,
    );
    assert.equal(f.builds.length, 1);
    assert.deepEqual(
      f.commands.filter(([command]) => command === "docker"),
      [["docker", "load", "--input", "image.tar"]],
    );
  });
