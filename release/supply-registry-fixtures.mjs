import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { inspect } from "node:util";
import { imageArchives, sha256, tar } from "./supply-frontend-fixtures.mjs";

export async function fixture(t, { docker = false, recompress = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "registry-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const layers = [
    tar([{ name: "a", content: "first layer" }]),
    tar([{ name: "b", content: "second layer" }]),
  ];
  const archive = imageArchives(layers);
  const path = join(directory, "image.tar");
  await writeFile(path, archive.docker);
  const config = Buffer.from(
    JSON.stringify({
      os: "linux",
      architecture: "amd64",
      rootfs: { type: "layers", diff_ids: archive.descriptor.diffIds },
    }),
  );
  const configType = docker
    ? "application/vnd.docker.container.image.v1+json"
    : "application/vnd.oci.image.config.v1+json";
  const layerType = docker
    ? "application/vnd.docker.image.rootfs.diff.tar.gzip"
    : "application/vnd.oci.image.layer.v1.tar+gzip";
  const blobs = layers.map((bytes) =>
    gzipSync(bytes, { level: recompress ? 1 : 6 }),
  );
  const manifest = {
    schemaVersion: 2,
    mediaType: docker
      ? "application/vnd.docker.distribution.manifest.v2+json"
      : "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: configType,
      digest: `sha256:${sha256(config)}`,
      size: config.length,
    },
    layers: blobs.map((bytes) => ({
      mediaType: layerType,
      digest: `sha256:${sha256(bytes)}`,
      size: bytes.length,
    })),
  };
  const responses = new Map([
    [manifest.config.digest, config],
    ...blobs.map((bytes) => [`sha256:${sha256(bytes)}`, bytes]),
  ]);
  const previous = globalThis.fetch;
  const calls = [];
  t.after(() => {
    globalThis.fetch = previous;
  });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(
      options.redirect,
      url.includes("/blobs/") ? "manual" : "error",
    );
    assert.match(
      url,
      /^https:\/\/ghcr\.io\/v2\/shiosos\/damadama\/(manifests|blobs)\/sha256:[a-f0-9]{64}$/,
    );
    return new Response(responses.get(url.split("/").at(-1)) ?? "absent");
  };
  const image = { archiveSha256: sha256(archive.docker) };
  const seal = () => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    image.digest = `sha256:${sha256(bytes)}`;
    image.reference = `ghcr.io/shiosos/damadama@${image.digest}`;
    responses.set(image.digest, bytes);
  };
  seal();
  return { image, path, manifest, responses, seal, calls, layers, config };
}

export async function diagnosticFixture(t, operation, respond) {
  const f = await fixture(t);
  const fetch = globalThis.fetch;
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "diagnostic-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  });
  const targets = {
    manifest: `/manifests/${f.image.digest}`,
    auth: "https://ghcr.io/token?",
    config: `/blobs/${f.manifest.config.digest}`,
    layer: `/blobs/${f.manifest.layers[0].digest}`,
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(
      options.redirect,
      url.includes("/blobs/") ? "manual" : "error",
    );
    if (url.includes(targets[operation])) return respond();
    if (operation === "auth")
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:shiosos/damadama:pull"',
        },
      });
    return fetch(url, options);
  };
  return f;
}

export function diagnosticRefusal(operation, boundary, reason) {
  return (error) => {
    assert.match(error.message, /registry (transport|request) refused/);
    assert(error.message.includes(`operation=${operation}`));
    assert(error.message.includes(`boundary=${boundary}`));
    assert(error.message.includes(`reason=${reason}`));
    assert.equal(error.cause, undefined);
    assert.deepEqual(Reflect.ownKeys(error).sort(), ["message", "stack"]);
    assert.doesNotMatch(
      inspect(error, { showHidden: true, depth: null }),
      /diagnostic-secret|evil\.invalid|Authorization|Location/,
    );
    return true;
  };
}
