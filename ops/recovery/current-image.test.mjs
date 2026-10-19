import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import {
  checkoutIdentity,
  migrationIdentity,
  requireImageIdentity,
  requireLoadedImage,
} from "./current-image.mjs";

const current = {
  repository: "ShiosOS/Damadama",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
};
const migrations = {
  sourceTree: "c".repeat(40),
  ids: ["20261011071109_InitialHabits", "20261012210223_GroupHabitLevels"],
};
const image = {
  manifestDigest: `sha256:${"d".repeat(64)}`,
  manifestMediaType: "application/vnd.oci.image.manifest.v1+json",
  configId: `sha256:${"e".repeat(64)}`,
  archiveSha256: "f".repeat(64),
  ociArchiveSha256: "2".repeat(64),
};
const identity = () => ({
  schema: 1,
  kind: "synthetic-test-build",
  source: { ...current },
  controller: { ...current },
  image: { ...image },
  migrations: {
    ...migrations,
    ids: [...migrations.ids],
    sqlSha256: "1".repeat(64),
  },
});

test("exact synthetic image identity keeps manifest, config, archive and migrations distinct", () => {
  const record = identity();
  assert.equal(requireImageIdentity(record, current, migrations), record);
  assert.notEqual(record.image.configId, record.image.manifestDigest);
});

for (const [label, mutate, error] of [
  ["missing identity", () => null, /image identity fields/],
  [
    "wrong source repository",
    (x) => {
      x.source.repository = "other/repository";
      return x;
    },
    /source repository/,
  ],
  [
    "wrong source commit",
    (x) => {
      x.source.commit = "2".repeat(40);
      return x;
    },
    /Stale source commit/,
  ],
  [
    "wrong source tree",
    (x) => {
      x.source.tree = "2".repeat(40);
      return x;
    },
    /Stale source tree/,
  ],
  [
    "stale controller",
    (x) => {
      x.controller.commit = "2".repeat(40);
      return x;
    },
    /Stale controller/,
  ],
  [
    "promotion claim",
    (x) => {
      x.kind = "verified-production";
      return x;
    },
    /synthetic-test-build/,
  ],
  [
    "missing manifest",
    (x) => {
      delete x.image.manifestDigest;
      return x;
    },
    /image fields/,
  ],
  [
    "bad manifest format",
    (x) => {
      x.image.manifestDigest = "invalid";
      return x;
    },
    /manifest identity/,
  ],
  [
    "image index",
    (x) => {
      x.image.manifestMediaType = "application/vnd.oci.image.index.v1+json";
      return x;
    },
    /manifest identity/,
  ],
  [
    "bad config ID",
    (x) => {
      x.image.configId = "mutable:tag";
      return x;
    },
    /config ID/,
  ],
  [
    "bad archive hash",
    (x) => {
      x.image.archiveSha256 = "invalid";
      return x;
    },
    /archive SHA/,
  ],
  [
    "bad OCI archive hash",
    (x) => {
      x.image.ociArchiveSha256 = "invalid";
      return x;
    },
    /OCI archive SHA/,
  ],
  [
    "wrong migration source",
    (x) => {
      x.migrations.sourceTree = "2".repeat(40);
      return x;
    },
    /source tree/,
  ],
  [
    "missing migrations",
    (x) => {
      x.migrations.ids = [];
      return x;
    },
    /Migration IDs/,
  ],
  [
    "bad SQL hash",
    (x) => {
      x.migrations.sqlSha256 = "invalid";
      return x;
    },
    /migrations.sql SHA/,
  ],
  [
    "extra untrusted fields",
    (x) => {
      x.rawLogs = "not allowed";
      return x;
    },
    /identity fields/,
  ],
]) {
  test(`image boundary refuses ${label} with a useful error`, () =>
    assert.throws(
      () => requireImageIdentity(mutate(identity()), current, migrations),
      error,
    ));
}

test("loaded image binds config, platform and ordered DiffIDs", () => {
  const witness = {
    configId: image.configId,
    diffIds: [image.configId, image.manifestDigest],
  };
  const loaded = [
    {
      Id: image.configId,
      Os: "linux",
      Architecture: "amd64",
      RootFS: { Layers: [...witness.diffIds] },
    },
  ];
  requireLoadedImage(loaded, witness);
  for (const [mutate, error] of [
    [
      (x) => {
        x[0].Id = image.manifestDigest;
      },
      /config identity/,
    ],
    [
      (x) => {
        x[0].Os = "windows";
      },
      /platform must be linux\/amd64/,
    ],
    [
      (x) => {
        x[0].Architecture = "arm64";
      },
      /platform must be linux\/amd64/,
    ],
    [
      (x) => {
        x[0].Variant = "v8";
      },
      /platform must be linux\/amd64/,
    ],
    [
      (x) => {
        x[0].RootFS.Layers.reverse();
      },
      /layers differ/,
    ],
    [
      (x) => {
        x.push(x[0]);
      },
      /identify one image/,
    ],
  ]) {
    const changed = structuredClone(loaded);
    mutate(changed);
    assert.throws(() => requireLoadedImage(changed, witness), error);
  }
});

test("migration IDs come from this real committed source", () => {
  const actual = checkoutIdentity();
  const committed = migrationIdentity(actual.commit);
  assert.match(committed.sourceTree, /^[a-f0-9]{40}$/);
  assert.deepEqual(committed.ids.slice(0, 2), migrations.ids);
  assert.deepEqual(committed.ids, [...new Set(committed.ids)].sort());
  assert.ok(committed.ids.every((id) => /^\d{14}_\w+$/.test(id)));
});

test("required-image CLI refuses invalid metadata before creating containers and emits a sanitized failure receipt", async () => {
  await mkdir(".audit", { recursive: true });
  const directory = await mkdtemp(resolve(".audit", "identity-refusal-"));
  const path = resolve(directory, "identity.json");
  const canary = "private-token-row-canary-never-echo";
  let proofDirectory;
  try {
    await writeFile(path, JSON.stringify({ ...identity(), rawLogs: canary }));
    const result = spawnSync(
      process.execPath,
      ["ops/recovery/prove.mjs", "--require-app", path],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(canary), false);
    const receipt = JSON.parse(result.stdout);
    assert.match(
      receipt.proofId,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    proofDirectory = resolve(".audit", `recovery-proof-${receipt.proofId}`);
    assert.equal(dirname(proofDirectory), resolve(".audit"));
    assert.equal(receipt.outcome, "failed");
    assert.equal(receipt.failureCode, "identity");
    assert.equal(receipt.image, null);
    assert.deepEqual(receipt.cleanup, {
      createdContainers: 0,
      createdNetwork: false,
      outcome: "passed",
    });
  } finally {
    if (proofDirectory)
      await rm(proofDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
