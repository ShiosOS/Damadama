import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  manifestMediaType,
  readOciImage,
  verifyDockerArchive,
} from "./image-archives.mjs";

export const repository = "ShiosOS/Damadama";
const sha = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const hash = /^[a-f0-9]{64}$/;
const buildkitImage =
  "moby/buildkit@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea";
const execute = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
const git = (...args) => execute("git", args);
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function fields(value, names, label) {
  requireThat(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === names.sort().join(","),
    `Invalid ${label} fields`,
  );
}
export function checkoutIdentity({ requireClean = false } = {}) {
  requireThat(
    [
      "git@github.com:ShiosOS/Damadama.git",
      "https://github.com/ShiosOS/Damadama.git",
      "https://github.com/ShiosOS/Damadama",
    ].includes(git("remote", "get-url", "origin")),
    "Proof checkout must use the expected source repository",
  );
  if (requireClean) {
    requireThat(
      git("status", "--porcelain", "--untracked-files=normal") === "",
      "Commit tracked and untracked source changes before running the proof",
    );
  }
  return {
    repository,
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
  };
}
export function migrationIdentity(commit) {
  requireThat(sha.test(commit), "Invalid migration source commit");
  const ids = git("ls-tree", "--name-only", `${commit}:server/Migrations`)
    .split("\n")
    .filter((name) => /^\d{14}_\w+\.cs$/.test(name))
    .map((name) => name.slice(0, -3))
    .sort();
  requireThat(ids.length > 0, "No committed application migrations found");
  return { sourceTree: git("rev-parse", `${commit}:server/Migrations`), ids };
}

export function requireImageIdentity(record, current, migrations) {
  fields(
    record,
    ["schema", "kind", "source", "controller", "image", "migrations"],
    "image identity",
  );
  requireThat(
    record.schema === 1 && record.kind === "synthetic-test-build",
    "Expected schema 1 synthetic-test-build identity",
  );
  for (const name of ["source", "controller"]) {
    fields(record[name], ["repository", "commit", "tree"], name);
    requireThat(
      record[name].repository === repository,
      `Wrong ${name} repository`,
    );
    for (const key of ["commit", "tree"]) {
      requireThat(sha.test(record[name][key]), `Invalid ${name} ${key}`);
      requireThat(
        record[name][key] === current[key],
        `Stale ${name} ${key}; build the exact checked-out source`,
      );
    }
  }
  fields(
    record.image,
    [
      "manifestDigest",
      "manifestMediaType",
      "configId",
      "archiveSha256",
      "ociArchiveSha256",
    ],
    "image",
  );
  requireThat(
    digest.test(record.image.manifestDigest) &&
      record.image.manifestMediaType === manifestMediaType,
    "Invalid image manifest identity",
  );
  requireThat(digest.test(record.image.configId), "Invalid image config ID");
  requireThat(
    hash.test(record.image.archiveSha256),
    "Invalid image archive SHA-256",
  );
  requireThat(
    hash.test(record.image.ociArchiveSha256),
    "Invalid OCI archive SHA-256",
  );
  fields(record.migrations, ["sourceTree", "ids", "sqlSha256"], "migrations");
  requireThat(
    sha.test(record.migrations.sourceTree) &&
      record.migrations.sourceTree === migrations.sourceTree,
    "Migration source tree differs from checkout",
  );
  requireThat(
    hash.test(record.migrations.sqlSha256),
    "Invalid migrations.sql SHA-256",
  );
  requireThat(
    Array.isArray(record.migrations.ids) &&
      JSON.stringify(record.migrations.ids) === JSON.stringify(migrations.ids),
    "Migration IDs differ from committed migrations",
  );
  return record;
}

export async function fileSha256(path) {
  const value = createHash("sha256");
  for await (const chunk of createReadStream(path)) value.update(chunk);
  return value.digest("hex");
}

export async function inspectImage(configId, directory) {
  const container = execute("docker", ["create", configId]);
  try {
    for (const [source, destination] of [
      ["/app/migrations.sql", "migrations.sql"],
      ["/app/wwwroot/release.json", "release.json"],
    ]) {
      execute("docker", [
        "cp",
        `${container}:${source}`,
        resolve(directory, destination),
      ]);
    }
    return {
      sqlSha256: await fileSha256(resolve(directory, "migrations.sql")),
      release: JSON.parse(
        await readFile(resolve(directory, "release.json"), "utf8"),
      ),
    };
  } finally {
    execute("docker", ["rm", container]);
  }
}

function releaseMetadata(source) {
  return {
    source,
    version: `synthetic-test-build-${source.commit.slice(0, 12)}`,
    kind: "synthetic-test-build",
  };
}

export async function verifyImage(record, metadataPath, directory) {
  const witness = await verifyImageArchives(record.image, metadataPath);
  const loaded = JSON.parse(
    execute("docker", ["image", "inspect", record.image.configId]),
  );
  requireLoadedImage(loaded, witness);
  const actual = await inspectImage(witness.configId, directory);
  assert.equal(
    actual.sqlSha256,
    record.migrations.sqlSha256,
    "Image migrations.sql differs",
  );
  assert.deepEqual(
    actual.release,
    releaseMetadata(record.source),
    "Image embedded source differs",
  );
}

export function requireLoadedImage(loaded, witness) {
  requireThat(
    Array.isArray(loaded) && loaded.length === 1,
    "Loaded image must identify one image",
  );
  assert.equal(
    loaded[0].Id,
    witness.configId,
    "Loaded image config identity differs",
  );
  requireThat(
    loaded[0].Os === "linux" &&
      loaded[0].Architecture === "amd64" &&
      !loaded[0].Variant,
    "Loaded image platform must be linux/amd64",
  );
  assert.deepEqual(
    loaded[0].RootFS?.Layers,
    witness.diffIds,
    "Loaded image layers differ from archive DiffIDs",
  );
}

export async function verifyImageArchives(image, metadataPath) {
  assert.equal(
    await fileSha256(`${metadataPath}.image.tar`),
    image.archiveSha256,
    "Docker archive hash differs",
  );
  assert.equal(
    await fileSha256(`${metadataPath}.oci.tar`),
    image.ociArchiveSha256,
    "OCI archive hash differs",
  );
  const witness = await readOciImage(`${metadataPath}.oci.tar`);
  assert.equal(
    witness.manifestDigest,
    image.manifestDigest,
    "OCI manifest digest differs from identity",
  );
  assert.equal(
    witness.manifestMediaType,
    image.manifestMediaType,
    "OCI manifest media type differs from identity",
  );
  assert.equal(witness.configId, image.configId, "OCI config identity differs");
  await verifyDockerArchive(`${metadataPath}.image.tar`, witness);
  return witness;
}

export async function buildCurrentImage(output) {
  let directory;
  let builder;
  let phase = "source-identity";
  try {
    const source = checkoutIdentity({ requireClean: true });
    const migrations = migrationIdentity(source.commit);
    await mkdir(dirname(output), { recursive: true });
    directory = await mkdtemp(resolve(dirname(output), "current-image-build-"));
    phase = "source-archive";
    const context = resolve(directory, "source");
    await mkdir(context);
    const archive = resolve(directory, "source.tar");
    execute("git", [
      "archive",
      "--format=tar",
      `--output=${archive}`,
      source.commit,
    ]);
    execute("tar", ["-xf", archive, "-C", context]);
    await writeFile(
      resolve(context, ".damadama-release.json"),
      JSON.stringify(releaseMetadata(source)),
      { flag: "wx" },
    );
    const tag = `damadama-recovery-synthetic:${randomUUID()}`;
    const builderName = `damadama-recovery-${randomUUID()}`;
    phase = "builder-create";
    execute("docker", [
      "buildx",
      "create",
      "--name",
      builderName,
      "--driver",
      "docker-container",
      "--driver-opt",
      `image=${buildkitImage}`,
    ]);
    builder = builderName;
    phase = "application-build";
    execute(
      "docker",
      [
        "buildx",
        "build",
        "--progress=plain",
        "--builder",
        builder,
        "--provenance=false",
        "--platform",
        "linux/amd64",
        "--output",
        `type=docker,dest=${output}.image.tar,compression=uncompressed,force-compression=true,oci-mediatypes=true`,
        "--output",
        `type=oci,dest=${output}.oci.tar,compression=uncompressed,force-compression=true,oci-mediatypes=true`,
        "--file",
        resolve(context, "release/Dockerfile"),
        "--tag",
        tag,
        context,
      ],
      { timeout: 1_200_000, stdio: ["ignore", "pipe", "inherit"] },
    );
    phase = "image-archive";
    const witness = await readOciImage(`${output}.oci.tar`);
    await verifyDockerArchive(`${output}.image.tar`, witness);
    const image = {
      manifestDigest: witness.manifestDigest,
      manifestMediaType: witness.manifestMediaType,
      configId: witness.configId,
      archiveSha256: await fileSha256(`${output}.image.tar`),
      ociArchiveSha256: await fileSha256(`${output}.oci.tar`),
    };
    phase = "image-load";
    execute("docker", ["load", "--input", `${output}.image.tar`]);
    requireLoadedImage(
      JSON.parse(execute("docker", ["image", "inspect", image.configId])),
      witness,
    );
    const actual = await inspectImage(image.configId, directory);
    phase = "embedded-source";
    assert.deepEqual(actual.release, releaseMetadata(source));
    const record = {
      schema: 1,
      kind: "synthetic-test-build",
      source,
      controller: source,
      image,
      migrations: { ...migrations, sqlSha256: actual.sqlSha256 },
    };
    requireImageIdentity(record, source, migrations);
    await writeFile(output, JSON.stringify(record, null, 2));
    return record;
  } catch (error) {
    throw Object.assign(new Error("Synthetic current-image build failed"), {
      phase,
      status: Number.isInteger(error.status) ? error.status : null,
    });
  } finally {
    try {
      if (builder) execute("docker", ["buildx", "rm", builder]);
    } catch {
      throw Object.assign(new Error("Synthetic builder cleanup failed"), {
        phase: "builder-cleanup",
      });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (
    process.argv[2] !== "build" ||
    !process.argv[3] ||
    process.argv.length !== 4
  ) {
    console.error(
      "Usage: node ops/recovery/current-image.mjs build OUTPUT.json",
    );
    process.exitCode = 2;
  } else {
    try {
      const record = await buildCurrentImage(resolve(process.argv[3]));
      console.log(JSON.stringify(record, null, 2));
    } catch (error) {
      console.error(
        JSON.stringify({
          outcome: "failed",
          failureCode: error.phase ?? "cleanup",
          childExitCode: error.status ?? null,
        }),
      );
      process.exitCode = 1;
    }
  }
}
