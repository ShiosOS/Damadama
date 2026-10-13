import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareArchive, publishArchive } from "./images.mjs";

const sha = (character) => character.repeat(40);
const source = {
  repository: "ShiosOS/Damadama",
  pr: 11,
  head: sha("1"),
  base: sha("2"),
  merge: sha("3"),
  tree: sha("4"),
};
const authority = { sha: sha("5"), runId: 42, attempt: 1 };
const digest = `sha256:${"a".repeat(64)}`;

process.env.GITHUB_ACTOR = "recording-executor-actor";
process.env.GH_TOKEN = "recording-executor-token";

async function archive(t) {
  const directory = await mkdtemp(join(tmpdir(), "damadama-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "image.tar");
  await writeFile(path, "recording executor archive");
  return {
    path,
    build: {
      kind: "application",
      source: { ...source },
      authority: { ...authority },
      version: "pr-11-111111111111-222222222222",
      archiveSha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    },
  };
}

function recordingDocker({
  loaded = "Loaded image: damadama-candidate:latest\n",
  pushed = `fixture registry digest: ${digest}\n`,
  manifestError,
} = {}) {
  const calls = [];
  const execute = (command, args, options) => {
    assert.equal(command, "docker");
    calls.push({ args, options });
    switch (args[0]) {
      case "load":
        return loaded;
      case "login":
      case "tag":
        return;
      case "manifest":
        if (manifestError) throw manifestError;
        return;
      case "push":
        return pushed;
      default:
        throw new Error(`unexpected Docker fixture command ${args[0]}`);
    }
  };
  return { calls, execute };
}

test("a fixture registry response without a digest cannot return image evidence", async (t) => {
  const { path, build } = await archive(t);
  const { calls, execute } = recordingDocker({
    pushed: "fixture registry accepted tag\n",
  });
  const prepared = await prepareArchive(
    "application",
    path,
    build,
    source,
    authority,
  );
  assert.throws(
    () => publishArchive(prepared, execute),
    /registry did not return an immutable digest/,
  );
  assert.deepEqual(calls.at(-1).args, [
    "push",
    "ghcr.io/shiosos/damadama:pr-11-111111111111-222222222222-42-1",
  ]);
});

test("fixture manifest inspection failure cannot return image evidence", async (t) => {
  const { path, build } = await archive(t);
  const { calls, execute } = recordingDocker({
    manifestError: new Error("fixture immutable manifest is unavailable"),
  });
  const prepared = await prepareArchive(
    "application",
    path,
    build,
    source,
    authority,
  );
  assert.throws(
    () => publishArchive(prepared, execute),
    /fixture immutable manifest is unavailable/,
  );
  assert.deepEqual(calls.at(-1).args, [
    "manifest",
    "inspect",
    "ghcr.io/shiosos/damadama@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]);
});

test("application publication returns the existing immutable image result", async (t) => {
  const { path, build } = await archive(t);
  const { calls, execute } = recordingDocker();
  const prepared = await prepareArchive(
    "application",
    path,
    build,
    source,
    authority,
  );
  assert.deepEqual(publishArchive(prepared, execute), {
    reference:
      "ghcr.io/shiosos/damadama@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    digest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    archiveSha256:
      "c5cf40083c4b553d8ca3513eebf9a03e24a74f8b3c81c76f445266e24fda03a0",
    version: "pr-11-111111111111-222222222222",
  });
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ["load", "--input", path],
      [
        "login",
        "ghcr.io",
        "--username",
        "recording-executor-actor",
        "--password-stdin",
      ],
      [
        "tag",
        "damadama-candidate",
        "ghcr.io/shiosos/damadama:pr-11-111111111111-222222222222-42-1",
      ],
      ["push", "ghcr.io/shiosos/damadama:pr-11-111111111111-222222222222-42-1"],
      [
        "manifest",
        "inspect",
        "ghcr.io/shiosos/damadama@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
    ],
  );
  assert.deepEqual(calls[1].options, {
    input: "recording-executor-token",
    stdio: ["pipe", "inherit", "inherit"],
  });
  assert.equal(
    calls.some(({ args }) => args.includes("recording-executor-token")),
    false,
  );
});

test("recovery publication uses only the fixed recovery repository and tag", async (t) => {
  const { path, build } = await archive(t);
  const recoverySource = {
    repository: "ShiosOS/Damadama",
    commit: sha("5"),
    tree: sha("6"),
  };
  const { calls, execute } = recordingDocker({
    loaded: "Loaded image: damadama-recovery-candidate:latest\n",
  });
  const prepared = await prepareArchive(
    "recovery",
    path,
    {
      ...build,
      kind: "recovery",
      source: recoverySource,
      version: "main-555555555555",
    },
    recoverySource,
    authority,
  );
  assert.deepEqual(publishArchive(prepared, execute), {
    reference:
      "ghcr.io/shiosos/damadama-recovery@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    digest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    archiveSha256:
      "c5cf40083c4b553d8ca3513eebf9a03e24a74f8b3c81c76f445266e24fda03a0",
    version: "main-555555555555",
  });
  assert.deepEqual(calls[2].args, [
    "tag",
    "damadama-recovery-candidate",
    "ghcr.io/shiosos/damadama-recovery:main-555555555555-42-1",
  ]);
  assert.deepEqual(calls[3].args, [
    "push",
    "ghcr.io/shiosos/damadama-recovery:main-555555555555-42-1",
  ]);
  assert.deepEqual(calls[4].args, [
    "manifest",
    "inspect",
    "ghcr.io/shiosos/damadama-recovery@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]);
});

for (const [label, changed, expected] of [
  ["kind", { kind: "recovery" }, /image kind differs from build record/],
  [
    "missing source",
    { source: undefined },
    /image source differs from build record/,
  ],
  [
    "source",
    { source: { ...source, head: sha("7") } },
    /image source differs from build record/,
  ],
  [
    "extra source field",
    { source: { ...source, target: "elsewhere" } },
    /image source differs from build record/,
  ],
  [
    "authority",
    { authority: { ...authority, runId: 43 } },
    /image authority differs from build record/,
  ],
  [
    "extra authority field",
    { authority: { ...authority, target: "elsewhere" } },
    /image authority differs from build record/,
  ],
  [
    "version",
    { version: "pr-12-111111111111-222222222222" },
    /image version differs from build record/,
  ],
  [
    "archive hash",
    { archiveSha256: "b".repeat(64) },
    /image archive differs from build record/,
  ],
]) {
  test(`different build ${label} refuses all Docker commands`, async (t) => {
    const { path, build } = await archive(t);
    const { calls, execute } = recordingDocker();
    await assert.rejects(async () => {
      const prepared = await prepareArchive(
        "application",
        path,
        { ...build, ...changed },
        source,
        authority,
      );
      publishArchive(prepared, execute);
    }, expected);
    assert.deepEqual(calls, []);
  });
}

for (const kind of ["other", "constructor"]) {
  test(`unsupported image kind ${kind} refuses all Docker commands`, async (t) => {
    const { path, build } = await archive(t);
    const { calls, execute } = recordingDocker();
    await assert.rejects(async () => {
      const prepared = await prepareArchive(
        kind,
        path,
        build,
        source,
        authority,
      );
      publishArchive(prepared, execute);
    }, /unsupported image kind/);
    assert.deepEqual(calls, []);
  });
}

test("tampered archive bytes refuse all Docker commands", async (t) => {
  const { path, build } = await archive(t);
  await writeFile(path, "tampered archive");
  const { calls, execute } = recordingDocker();
  await assert.rejects(async () => {
    const prepared = await prepareArchive(
      "application",
      path,
      build,
      source,
      authority,
    );
    publishArchive(prepared, execute);
  }, /image archive differs from build record/);
  assert.deepEqual(calls, []);
});

test("archive bytes changed after preparation refuse all Docker commands", async (t) => {
  const { path, build } = await archive(t);
  const prepared = await prepareArchive(
    "application",
    path,
    build,
    source,
    authority,
  );
  await writeFile(path, "changed after preparation");
  const { calls, execute } = recordingDocker();
  assert.throws(
    () => publishArchive(prepared, execute),
    /image archive changed after preparation/,
  );
  assert.deepEqual(calls, []);
});

test("preparation keeps the checked version and authority when caller objects change", async (t) => {
  const { path, build } = await archive(t);
  const callerAuthority = { ...authority };
  const preparing = prepareArchive(
    "application",
    path,
    build,
    source,
    callerAuthority,
  );
  build.version = "changed-during-hash";
  callerAuthority.runId = 43;
  const { calls, execute } = recordingDocker();
  const image = publishArchive(await preparing, execute);
  assert.deepEqual(image, {
    reference:
      "ghcr.io/shiosos/damadama@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    digest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    archiveSha256:
      "c5cf40083c4b553d8ca3513eebf9a03e24a74f8b3c81c76f445266e24fda03a0",
    version: "pr-11-111111111111-222222222222",
  });
  assert.deepEqual(calls[3].args, [
    "push",
    "ghcr.io/shiosos/damadama:pr-11-111111111111-222222222222-42-1",
  ]);
});

test("recovery metadata cannot choose a different controller tree", async (t) => {
  const { path, build } = await archive(t);
  const recoverySource = {
    repository: "ShiosOS/Damadama",
    commit: sha("5"),
    tree: sha("6"),
  };
  const { calls, execute } = recordingDocker();
  await assert.rejects(async () => {
    const prepared = await prepareArchive(
      "recovery",
      path,
      {
        ...build,
        kind: "recovery",
        source: { ...recoverySource, tree: sha("7") },
        version: "main-555555555555",
      },
      recoverySource,
      authority,
    );
    publishArchive(prepared, execute);
  }, /image source differs from build record/);
  assert.deepEqual(calls, []);
});

for (const changed of [
  { sha: "not-a-commit" },
  { runId: 0 },
  { runId: "42" },
  { attempt: 0 },
]) {
  test(`invalid controller authority ${JSON.stringify(changed)} refuses Docker`, async (t) => {
    const { path, build } = await archive(t);
    const invalid = { ...authority, ...changed };
    const { calls, execute } = recordingDocker();
    await assert.rejects(async () => {
      const prepared = await prepareArchive(
        "application",
        path,
        { ...build, authority: invalid },
        source,
        invalid,
      );
      publishArchive(prepared, execute);
    }, /invalid image controller authority/);
    assert.deepEqual(calls, []);
  });
}

for (const loaded of [
  "Loaded image: damadama-recovery-candidate:latest\n",
  "Loaded image: damadama-candidate:latest-other\n",
  "Loaded image ID: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
]) {
  test(`archive loading ${loaded.trim()} refuses login and push`, async (t) => {
    const { path, build } = await archive(t);
    const { calls, execute } = recordingDocker({ loaded });
    const prepared = await prepareArchive(
      "application",
      path,
      build,
      source,
      authority,
    );
    assert.throws(
      () => publishArchive(prepared, execute),
      /archive did not load expected image damadama-candidate:latest/,
    );
    assert.deepEqual(
      calls.map(({ args }) => args),
      [["load", "--input", path]],
    );
  });
}

for (const changed of [
  { repository: "someone/else" },
  { commit: "not-a-commit" },
  { commit: sha("7") },
  { tree: "not-a-tree" },
]) {
  test(`invalid trusted recovery source ${JSON.stringify(changed)} refuses Docker`, async (t) => {
    const { path, build } = await archive(t);
    const invalid = {
      repository: "ShiosOS/Damadama",
      commit: sha("5"),
      tree: sha("6"),
      ...changed,
    };
    const { calls, execute } = recordingDocker();
    await assert.rejects(async () => {
      const prepared = await prepareArchive(
        "recovery",
        path,
        {
          ...build,
          kind: "recovery",
          source: invalid,
          version: `main-${invalid.commit.slice(0, 12)}`,
        },
        invalid,
        authority,
      );
      publishArchive(prepared, execute);
    }, /invalid trusted recovery source/);
    assert.deepEqual(calls, []);
  });
}
