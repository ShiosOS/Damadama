import assert from "node:assert/strict";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  realApplicationOrigin,
  tinyFixtureOrigin,
} from "./supply-frontend-origin.mjs";
import {
  fileHash,
  hash,
  json,
  root,
  run,
  save,
  toolEnvironment,
} from "./supply-internal.mjs";

export const buildkitImage =
  "moby/buildkit@sha256:de10faf919fc71ba4eb1dd7bd6449566d012b0c9436b1c61bfee21d621b009aa";

function docker(args, options = {}) {
  return run("docker", args, {
    env: { ...toolEnvironment(), BUILDX_METADATA_PROVENANCE: "max" },
    ...options,
  });
}

async function webDescriptor(layout) {
  const index = await json(join(layout, "index.json"));
  const images = index.manifests.filter(
    (entry) =>
      entry.platform?.os === "linux" &&
      entry.platform?.architecture === "amd64",
  );
  assert.equal(images.length, 1, "web OCI layout needs one linux/amd64 image");
  const digest = images[0].digest;
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  const manifestBytes = await readFile(
    join(layout, "blobs", "sha256", digest.slice(7)),
  );
  assert.equal(`sha256:${hash(manifestBytes)}`, digest);
  const manifest = JSON.parse(manifestBytes);
  const configBytes = await readFile(
    join(layout, "blobs", "sha256", manifest.config.digest.slice(7)),
  );
  assert.equal(`sha256:${hash(configBytes)}`, manifest.config.digest);
  const diffIds = JSON.parse(configBytes).rootfs.diff_ids;
  assert(Array.isArray(diffIds) && diffIds.length > 0);
  assert(diffIds.every((digest) => /^sha256:[a-f0-9]{64}$/.test(digest)));
  return {
    digest,
    configDigest: manifest.config.digest,
    diffIds,
  };
}

async function dockerArchiveIdentity(archive, directory) {
  await mkdir(directory);
  run("tar", ["-xf", archive, "-C", directory]);
  const images = await json(join(directory, "manifest.json"));
  assert.equal(images.length, 1, "web Docker archive needs one image");
  const configBytes = await readFile(join(directory, images[0].Config));
  const diffIds = JSON.parse(configBytes).rootfs.diff_ids;
  assert(Array.isArray(diffIds) && diffIds.length > 0);
  assert(diffIds.every((digest) => /^sha256:[a-f0-9]{64}$/.test(digest)));
  return {
    configDigest: `sha256:${hash(configBytes)}`,
    diffIds,
  };
}

export async function buildApplicationWithWebEvidence(directory, identity) {
  return buildPaired(directory, identity);
}

export async function buildTinyWithWebEvidence(directory, identity, context) {
  return buildPaired(directory, identity, context);
}

async function buildPaired(directory, identity, fixtureContext) {
  const output = resolve(directory);
  await mkdir(output, { recursive: true });
  const builder = `damadama-application-${process.pid}`;
  const dockerfile = fixtureContext
    ? join(fixtureContext, "Dockerfile")
    : join(root, "Dockerfile");
  const context = fixtureContext ?? ".";
  const releaseMetadata = fixtureContext
    ? join(fixtureContext, "src/server/wwwroot/release.json")
    : ".damadama-release.json";
  await copyFile(releaseMetadata, join(output, "release-metadata.json"));
  const finalOptions = fixtureContext
    ? ["--target", "final", "--network", "none"]
    : [];
  const dockerBinaryPath = run("which", ["docker"]).trim();
  const versions = {
    docker: docker(["version", "--format", "{{json .}}"]),
    dockerBinaryPath,
    dockerBinarySha256: await fileHash(dockerBinaryPath),
    buildx: docker(["buildx", "version"]),
    buildxBinarySha256: null,
    buildkitImage,
  };
  await save(join(output, "builder-versions.json"), versions);
  docker(
    [
      "buildx",
      "create",
      "--name",
      builder,
      "--driver",
      "docker-container",
      "--driver-opt",
      `image=${buildkitImage}`,
      "--bootstrap",
    ],
    { timeout: 240_000 },
  );
  try {
    const ociArchive = join(output, "web.oci.tar");
    const webArchive = join(output, "web-stage.tar");
    const webMetadata = join(output, "web.metadata.json");
    docker(
      [
        "buildx",
        "build",
        "--builder",
        builder,
        "--platform",
        "linux/amd64",
        "--file",
        dockerfile,
        "--target",
        "web",
        "--provenance=false",
        "--metadata-file",
        webMetadata,
        "--output",
        `type=oci,dest=${ociArchive}`,
        "--output",
        `type=docker,dest=${webArchive}`,
        context,
      ],
      { stdio: "inherit", timeout: 900_000 },
    );
    const layout = join(output, "web.layout");
    await mkdir(layout);
    run("tar", ["-xf", ociArchive, "-C", layout]);
    const descriptor = await webDescriptor(layout);
    const dockerIdentity = await dockerArchiveIdentity(
      webArchive,
      join(output, "web.docker"),
    );
    assert.equal(dockerIdentity.configDigest, descriptor.configDigest);
    assert.deepEqual(dockerIdentity.diffIds, descriptor.diffIds);

    const reference = `oci-layout://${layout}@${descriptor.digest}`;
    const finalMetadata = join(output, "final.metadata.json");
    const archive = join(output, "image.tar");
    docker(
      [
        "buildx",
        "build",
        "--builder",
        builder,
        "--platform",
        "linux/amd64",
        "--file",
        dockerfile,
        ...finalOptions,
        "--build-context",
        `web=${reference}`,
        "--provenance=false",
        "--metadata-file",
        finalMetadata,
        "--output",
        `type=docker,dest=${archive}`,
        context,
      ],
      { stdio: "inherit", timeout: 900_000 },
    );
    const raw = await json(finalMetadata);
    const provenance = raw["buildx.build.provenance"];
    const origin = fixtureContext
      ? tinyFixtureOrigin(provenance, descriptor.digest)
      : realApplicationOrigin(provenance, descriptor.digest);
    await save(join(output, "web-build.json"), {
      schema: 1,
      purpose: fixtureContext
        ? "tiny-fixture-origin-observation"
        : "real-application-origin-observation",
      ...identity,
      platform: "linux/amd64",
      builder: versions,
      dockerfileSha256: await fileHash(dockerfile),
      releaseMetadataSha256: await fileHash(
        join(output, "release-metadata.json"),
      ),
      web: {
        descriptor,
        ociArchiveSha256: await fileHash(ociArchive),
        dockerArchiveSha256: await fileHash(webArchive),
        metadataSha256: await fileHash(webMetadata),
      },
      final: {
        dockerArchiveSha256: await fileHash(archive),
        metadataSha256: await fileHash(finalMetadata),
        origin,
      },
      coverage: "unsigned-paired-observation",
    });
    return archive;
  } finally {
    docker(["buildx", "rm", builder]);
  }
}
