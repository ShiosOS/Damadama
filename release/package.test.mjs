import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageApplication } from "./package.mjs";

const record = {
  schema: 1,
  source: {
    repository: "ShiosOS/Damadama",
    pr: 11,
    head: "1111111111111111111111111111111111111111",
    base: "2222222222222222222222222222222222222222",
    merge: "3333333333333333333333333333333333333333",
    tree: "4444444444444444444444444444444444444444",
  },
  authority: {
    sha: "2222222222222222222222222222222222222222",
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
      return args.at(-1) === "HEAD" ? record.source.merge : record.source.tree;
    if (args[0] === "save") writeFileSync("image.tar", "abc");
    if (args[0] === "create") return "test-only-container";
    return "";
  }
  return { commands, execute };
}

test("application archive metadata binds its source and controller attempt", async (t) => {
  const f = await fixture(t);
  await packageApplication(record, f.execute);
  assert.deepEqual(JSON.parse(await readFile("build.json", "utf8")), {
    kind: "application",
    source: record.source,
    authority: record.authority,
    version: "pr-11-111111111111-222222222222",
    archiveSha256:
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  assert.deepEqual(
    JSON.parse(await readFile("candidate/.damadama-release.json", "utf8")),
    {
      source: record.source,
      version: "pr-11-111111111111-222222222222",
    },
  );
  assert.deepEqual(
    f.commands.find((command) => command[1] === "build"),
    [
      "docker",
      "build",
      "--platform",
      "linux/amd64",
      "--file",
      "controls/release/Dockerfile",
      "--tag",
      "damadama-candidate",
      "candidate",
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
    packageApplication(record, f.execute),
    /reserved release metadata path differs/,
  );
  assert.equal(
    f.commands.some((command) => command[0] === "docker"),
    false,
  );
});
