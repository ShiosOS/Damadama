import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRecovery } from "./package-recovery.mjs";

const authority = {
  sha: "2222222222222222222222222222222222222222",
  runId: 42,
  attempt: 2,
};

async function fixture(t) {
  const previous = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "damadama-recovery-package-"));
  process.chdir(directory);
  t.after(async () => {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  });
  const commands = [];
  function execute(command, args) {
    commands.push([command, ...args]);
    if (command === "git")
      return args.at(-1) === "HEAD"
        ? authority.sha
        : "5555555555555555555555555555555555555555";
    if (args[0] === "save") writeFileSync("recovery-image.tar", "abc");
    return "";
  }
  return { commands, execute };
}

test("recovery archive binds only the trusted controls commit and tree", async (t) => {
  const f = await fixture(t);
  await packageRecovery(authority, f.execute);
  assert.deepEqual(JSON.parse(await readFile("recovery-build.json", "utf8")), {
    kind: "recovery",
    source: {
      repository: "ShiosOS/Damadama",
      commit: authority.sha,
      tree: "5555555555555555555555555555555555555555",
    },
    authority,
    version: "main-222222222222",
    archiveSha256:
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  assert.deepEqual(
    f.commands.find((command) => command[1] === "build"),
    [
      "docker",
      "build",
      "--platform",
      "linux/amd64",
      "--file",
      "controls/ops/recovery/Dockerfile",
      "--tag",
      "damadama-recovery-candidate",
      "controls",
    ],
  );
});

test("recovery refuses a checkout different from its controller before building", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    packageRecovery(
      { ...authority, sha: "6666666666666666666666666666666666666666" },
      f.execute,
    ),
    /checkout differs from trusted controller/,
  );
  assert.equal(
    f.commands.some((command) => command[0] === "docker"),
    false,
  );
});
