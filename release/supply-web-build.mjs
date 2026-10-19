import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  realApplicationOrigin,
  tinyFixtureOrigin,
} from "./supply-frontend-origin.mjs";
import { dockerArchive, ociArchive } from "./supply-frontend-tar.mjs";
import {
  fileHash,
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

export async function buildApplicationWithWebEvidence(
  directory,
  identity,
  application = {},
) {
  return buildPaired(directory, identity, undefined, application);
}

export async function buildTinyWithWebEvidence(directory, identity, context) {
  return buildPaired(directory, identity, context);
}

async function buildPaired(
  directory,
  identity,
  fixtureContext,
  application = {},
) {
  const output = resolve(directory);
  await mkdir(output, { recursive: true });
  const builder = `damadama-application-${process.pid}`;
  const dockerfile = fixtureContext
    ? join(fixtureContext, "Dockerfile")
    : (application.dockerfile ?? join(root, "Dockerfile"));
  const context = fixtureContext ?? application.context ?? ".";
  const releaseMetadata = fixtureContext
    ? join(fixtureContext, "src/server/wwwroot/release.json")
    : join(context, ".damadama-release.json");
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
    const ociArchivePath = join(output, "web.oci.tar");
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
        `type=oci,dest=${ociArchivePath}`,
        "--output",
        `type=docker,dest=${webArchive}`,
        context,
      ],
      { stdio: "inherit", timeout: 900_000 },
    );
    const ociArchiveSha256 = await fileHash(ociArchivePath);
    const dockerArchiveSha256 = await fileHash(webArchive);
    const descriptor = await ociArchive(ociArchivePath, ociArchiveSha256);
    const dockerIdentity = await dockerArchive(webArchive, dockerArchiveSha256);
    assert.equal(dockerIdentity.configDigest, descriptor.configDigest);
    assert.deepEqual(dockerIdentity.diffIds, descriptor.diffIds);
    const layout = join(output, "web.layout");
    await mkdir(layout);
    run("tar", ["-xf", ociArchivePath, "-C", layout]);

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
        ...(application.tag ? ["--tag", application.tag] : []),
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
    assert.equal(await fileHash(ociArchivePath), ociArchiveSha256);
    assert.equal(await fileHash(webArchive), dockerArchiveSha256);
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
        ociArchiveSha256,
        dockerArchiveSha256,
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
