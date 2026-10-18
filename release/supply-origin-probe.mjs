import assert from "node:assert/strict";
import { tinyFixtureOrigin as resolvedContext } from "./supply-frontend-origin.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildkitImage } from "./supply-web-build.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 240_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function imageDescriptor(layout) {
  const index = JSON.parse(await readFile(join(layout, "index.json"), "utf8"));
  const images = index.manifests.filter(
    (entry) =>
      entry.platform?.os === "linux" &&
      entry.platform?.architecture === "amd64",
  );
  assert.equal(
    images.length,
    1,
    "expected one linux/amd64 OCI image descriptor",
  );
  const digest = images[0].digest;
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  const manifestBytes = await readFile(
    join(layout, "blobs", "sha256", digest.slice(7)),
  );
  assert.equal(`sha256:${sha256(manifestBytes)}`, digest);
  const manifest = JSON.parse(manifestBytes);
  const config = await readFile(
    join(layout, "blobs", "sha256", manifest.config.digest.slice(7)),
  );
  assert.equal(`sha256:${sha256(config)}`, manifest.config.digest);
  const parsedConfig = JSON.parse(config);
  return {
    digest,
    configDigest: manifest.config.digest,
    diffIds: parsedConfig.rootfs.diff_ids,
  };
}

async function exportImage(builder, context, target, output) {
  const metadata = join(output, `${target}.metadata.json`);
  const oci = join(output, `${target}.oci.tar`);
  const docker = join(output, `${target}.docker.tar`);
  run(
    "docker",
    [
      "buildx",
      "build",
      "--builder",
      builder,
      "--platform",
      "linux/amd64",
      "--file",
      join(context, "Dockerfile"),
      "--target",
      target,
      "--network",
      "none",
      "--provenance=false",
      "--metadata-file",
      metadata,
      "--output",
      `type=oci,dest=${oci}`,
      "--output",
      `type=docker,dest=${docker}`,
      context,
    ],
    { env: { ...process.env, BUILDX_METADATA_PROVENANCE: "max" } },
  );
  const layout = join(output, `${target}.layout`);
  await mkdir(layout);
  run("tar", ["-xf", oci, "-C", layout]);
  const descriptor = await imageDescriptor(layout);
  const dockerDir = join(output, `${target}.docker`);
  await mkdir(dockerDir);
  run("tar", ["-xf", docker, "-C", dockerDir]);
  const dockerManifest = JSON.parse(
    await readFile(join(dockerDir, "manifest.json"), "utf8"),
  );
  assert.equal(dockerManifest.length, 1, "expected one Docker archive image");
  const dockerConfig = await readFile(
    join(dockerDir, dockerManifest[0].Config),
  );
  assert.equal(`sha256:${sha256(dockerConfig)}`, descriptor.configDigest);
  assert.deepEqual(
    JSON.parse(dockerConfig).rootfs.diff_ids,
    descriptor.diffIds,
  );
  return { descriptor, metadata, oci, docker };
}

async function fixtureAsset(dockerArchive, directory) {
  const extracted = join(directory, "final.docker");
  await mkdir(extracted);
  run("tar", ["-xf", dockerArchive, "-C", extracted]);
  const images = JSON.parse(
    await readFile(join(extracted, "manifest.json"), "utf8"),
  );
  assert.equal(images.length, 1, "expected one final Docker archive image");
  assert.equal(
    images[0].Layers.length,
    1,
    "fixture final image must have one layer",
  );
  const layer = join(extracted, images[0].Layers[0]);
  const members = run("tar", ["-tf", layer]).split("\n");
  const matches = members.filter(
    (member) => member.replace(/^\.\//, "") === "app/wwwroot/index.html",
  );
  assert.equal(matches.length, 1, "expected one copied final index.html");
  const result = spawnSync("tar", ["-xOf", layer, matches[0]], {
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "could not read copied final index.html");
  return result.stdout;
}

async function probe(output) {
  await mkdir(output, { recursive: true });
  const context = await mkdtemp(join(tmpdir(), "damadama-origin-"));
  const builder = `damadama-origin-${process.pid}`;
  const versions = {
    docker: run("docker", ["version", "--format", "{{json .}}"]),
    buildx: run("docker", ["buildx", "version"]),
    buildkitImage,
  };
  await writeFile(
    join(output, "versions.json"),
    JSON.stringify(versions, null, 2),
  );
  run("docker", [
    "buildx",
    "create",
    "--name",
    builder,
    "--driver",
    "docker-container",
    "--driver-opt",
    `image=${buildkitImage}`,
    "--bootstrap",
  ]);
  try {
    await writeFile(join(context, "index.html"), "same visible asset\n");
    await writeFile(
      join(context, "Dockerfile"),
      "FROM scratch AS web\nCOPY index.html /src/server/wwwroot/index.html\nCOPY marker.txt /hidden-marker\nFROM scratch AS final\nCOPY --from=web /src/server/wwwroot /app/wwwroot\n",
    );
    const web = [];
    for (const marker of ["accepted", "other"]) {
      await writeFile(join(context, "marker.txt"), `${marker}\n`);
      const directory = join(output, marker);
      await mkdir(directory);
      web.push(await exportImage(builder, context, "web", directory));
    }
    assert.notEqual(web[0].descriptor.digest, web[1].descriptor.digest);
    const finals = [];
    const assets = [];
    for (const [index, marker] of ["accepted", "other"].entries()) {
      const directory = join(output, marker);
      const reference = `oci-layout://${resolve(directory, "web.layout")}@${web[index].descriptor.digest}`;
      const metadata = join(directory, "final.metadata.json");
      run(
        "docker",
        [
          "buildx",
          "build",
          "--builder",
          builder,
          "--platform",
          "linux/amd64",
          "--file",
          join(context, "Dockerfile"),
          "--target",
          "final",
          "--network",
          "none",
          "--build-context",
          `web=${reference}`,
          "--provenance=false",
          "--metadata-file",
          metadata,
          "--output",
          `type=oci,dest=${join(directory, "final.oci.tar")}`,
          "--output",
          `type=docker,dest=${join(directory, "final.docker.tar")}`,
          context,
        ],
        { env: { ...process.env, BUILDX_METADATA_PROVENANCE: "max" } },
      );
      const finalLayout = join(directory, "final.layout");
      await mkdir(finalLayout);
      run("tar", ["-xf", join(directory, "final.oci.tar"), "-C", finalLayout]);
      finals.push(await imageDescriptor(finalLayout));
      assets.push(
        await fixtureAsset(join(directory, "final.docker.tar"), directory),
      );
      const raw = JSON.parse(await readFile(metadata, "utf8"));
      const provenance = raw["buildx.build.provenance"];
      assert(provenance, "Buildx metadata has no provenance");
      resolvedContext(provenance, web[index].descriptor.digest);
      if (marker === "other") {
        assert.throws(
          () => resolvedContext(provenance, web[0].descriptor.digest),
          /resolved context differs/,
        );
      }
    }
    assert.deepEqual(assets[0], Buffer.from("same visible asset\n"));
    assert.deepEqual(assets[1], assets[0], "copied final assets differ");
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(
        {
          status: "native-origin-probe-passed",
          retainedWeb: web[0].descriptor,
          wrongContext: web[1].descriptor,
          finals,
          copiedAssetSha256: sha256(assets[0]),
        },
        null,
        2,
      ),
    );
  } finally {
    run("docker", ["buildx", "rm", builder]);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await probe(resolve(process.argv[2] ?? ".audit/origin-probe"));
}
