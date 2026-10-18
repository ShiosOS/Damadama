import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { imageArchives, sha256, tar } from "./supply-frontend-fixtures.mjs";
import { fileHash } from "./supply-internal.mjs";
import {
  compareRegistryArchive,
  registryLimits,
  registryChallenge,
} from "./supply-registry.mjs";

async function fixture(t, { docker = false, recompress = false } = {}) {
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
    assert.equal(options.redirect, "error");
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

for (const options of [{}, { docker: true }, { recompress: true }])
  test(`registry matches authenticated archive ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    assert.equal(await compareRegistryArchive(f.image, f.path), undefined);
    assert.equal(f.calls.length, 4);
  });

for (const [name, mutate, pattern] of [
  [
    "raw manifest hash",
    (f) => f.responses.set(f.image.digest, Buffer.from("{}")),
    /manifest digest/,
  ],
  [
    "config bytes",
    (f) => f.responses.set(f.manifest.config.digest, Buffer.from("{}")),
    /config size/,
  ],
  [
    "config size",
    (f) => {
      f.manifest.config.size++;
      f.seal();
    },
    /config size/,
  ],
  [
    "layer bytes",
    (f) =>
      f.responses.set(
        f.manifest.layers[0].digest,
        Buffer.alloc(f.manifest.layers[0].size),
      ),
    /header|gzip|compression/i,
  ],
  [
    "layer size",
    (f) => {
      f.manifest.layers[0].size++;
      f.seal();
    },
    /layer size/,
  ],
  [
    "layer order",
    (f) => {
      f.manifest.layers.reverse();
      f.seal();
    },
    /ordered DiffID/,
  ],
  [
    "missing layer",
    (f) => {
      f.manifest.layers.pop();
      f.seal();
    },
    /layer count/,
  ],
  [
    "extra layer",
    (f) => {
      f.manifest.layers.push(f.manifest.layers[0]);
      f.seal();
    },
    /layer count/,
  ],
  [
    "foreign URL",
    (f) => {
      f.manifest.layers[0].urls = ["https://example.invalid/private"];
      f.seal();
    },
    /external registry/,
  ],
  [
    "foreign media",
    (f) => {
      f.manifest.layers[0].mediaType =
        "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip";
      f.seal();
    },
    /media type/,
  ],
  [
    "prototype media",
    (f) => {
      f.manifest.mediaType = "__proto__";
      delete f.manifest.config.mediaType;
      for (const layer of f.manifest.layers) delete layer.mediaType;
      f.seal();
    },
    /unsupported registry manifest/,
  ],
  [
    "constructor media",
    (f) => {
      f.manifest.mediaType = "constructor";
      delete f.manifest.config.mediaType;
      for (const layer of f.manifest.layers) delete layer.mediaType;
      f.seal();
    },
    /unsupported registry manifest/,
  ],
  [
    "index",
    (f) => {
      f.manifest.mediaType = "application/vnd.oci.image.index.v1+json";
      f.seal();
    },
    /unsupported registry manifest/,
  ],
])
  test(`registry refuses ${name}`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(compareRegistryArchive(f.image, f.path), pattern);
  });

test("expanded and compressed bounds accept equality and refuse one byte over", async (t) => {
  const f = await fixture(t);
  const exact = {
    ...registryLimits,
    layerBytes: f.layers[0].length,
    expandedBytes: f.layers.reduce((n, b) => n + b.length, 0),
    compressedBytes: f.manifest.layers.reduce((n, b) => n + b.size, 0),
  };
  await compareRegistryArchive(f.image, f.path, exact);
  for (const key of ["layerBytes", "expandedBytes", "compressedBytes"])
    await assert.rejects(
      compareRegistryArchive(f.image, f.path, {
        ...exact,
        [key]: exact[key] - 1,
      }),
      /bound/,
    );
});

test("stream bytes are bounded without content length", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    compareRegistryArchive(f.image, f.path, {
      ...registryLimits,
      manifestBytes: f.responses.get(f.image.digest).length - 1,
    }),
    /streamed bytes/,
  );
});

test("original mutation during registry reads refuses admission", async (t) => {
  const f = await fixture(t);
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await fetch(...args);
    await writeFile(f.path, "changed");
    return response;
  };
  await assert.rejects(
    compareRegistryArchive(f.image, f.path),
    /original archive changed/,
  );
});

test("registry challenges have one exact credential destination and pull scope", () => {
  const challenge =
    'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:shiosos/damadama:pull"';
  assert.equal(
    registryChallenge(challenge),
    "https://ghcr.io/token?service=ghcr.io&scope=repository%3Ashiosos%2Fdamadama%3Apull",
  );
  for (const changed of [
    challenge.replace("ghcr.io/token", "evil.invalid/token"),
    challenge.replace('service="ghcr.io"', 'service="evil.invalid"'),
    challenge.replace(":pull", ":push"),
    challenge + ',extra="x"',
  ])
    assert.throws(
      () => registryChallenge(changed),
      /unsupported registry authentication/,
    );
});

test("private registry exchange scopes the ephemeral token and refuses redirects", async (t) => {
  const f = await fixture(t);
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "synthetic-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  });
  const fetch = globalThis.fetch;
  let authorized = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, "error");
    if (url.startsWith("https://ghcr.io/token?")) {
      assert.equal(
        options.headers.Authorization,
        `Basic ${Buffer.from("x-access-token:synthetic-secret").toString("base64")}`,
      );
      authorized = true;
      return new Response(JSON.stringify({ token: "synthetic-bearer" }));
    }
    if (!authorized)
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:shiosos/damadama:pull"',
        },
      });
    assert.equal(options.headers.Authorization, "Bearer synthetic-bearer");
    return fetch(url, options);
  };
  await compareRegistryArchive(f.image, f.path);
  assert(authorized);
  globalThis.fetch = async () =>
    new Response("", {
      status: 307,
      headers: { location: "https://example.invalid/private" },
    });
  await assert.rejects(
    compareRegistryArchive(f.image, f.path),
    /registry request refused/,
  );
});

test("registry deadline cancels a pending streamed body", async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  globalThis.fetch = async (url, { signal }) =>
    new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              controller.error(new Error("aborted"));
            },
            { once: true },
          );
          controller.enqueue(new Uint8Array([123]));
        },
      }),
    );
  await assert.rejects(
    compareRegistryArchive(f.image, f.path, {
      ...registryLimits,
      timeoutMs: 500,
    }),
    /deadline exceeded/,
  );
  assert(cancelled);
});

for (const mode of ["malformed", "stalled"])
  test(`registry ${mode} token response refuses without credential text`, async (t) => {
    const f = await fixture(t);
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "synthetic-secret";
    t.after(() => {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    });
    let cancelled = false;
    globalThis.fetch = async (url, { signal }) => {
      if (!url.startsWith("https://ghcr.io/token?"))
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:shiosos/damadama:pull"',
          },
        });
      if (mode === "malformed")
        return new Response('synthetic-secret{"token":');
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                controller.error(new Error("aborted"));
              },
              { once: true },
            );
            controller.enqueue(
              new TextEncoder().encode('{"token":"synthetic-secret'),
            );
          },
        }),
      );
    };
    await assert.rejects(
      compareRegistryArchive(f.image, f.path, {
        ...registryLimits,
        timeoutMs: 500,
      }),
      (error) => {
        assert.match(
          error.message,
          mode === "malformed"
            ? /invalid registry token response/
            : /deadline exceeded/,
        );
        assert.doesNotMatch(error.stack, /synthetic-secret/);
        return true;
      },
    );
    if (mode === "stalled") assert(cancelled);
  });

test("canonical file hashing cancels an in-progress stream", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hash-cancellation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "archive.tar");
  await writeFile(path, Buffer.alloc(16 * 1024 * 1024));
  const controller = new AbortController();
  const pending = fileHash(path, controller.signal);
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: "AbortError" });
});

test("production OCI verification isolates ephemeral credentials and removes them after success and failures", () => {
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { readFileSync, existsSync } from 'node:fs';
    let mode, observed;
    globalThis.fixtureExec = (binary, args, options) => {
      observed = options;
      assert.equal(binary, 'controlled-gh');
      assert(!JSON.stringify(args).includes('synthetic-secret'));
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      if (args[2].startsWith('oci://')) {
        const config = JSON.parse(readFileSync(options.env.DOCKER_CONFIG + '/config.json'));
        assert.deepEqual(config, {auths:{'ghcr.io':{auth:Buffer.from('x-access-token:synthetic-secret').toString('base64')}}});
      } else assert.equal(options.env.DOCKER_CONFIG, undefined);
      if (mode === 'error') throw Object.assign(Error('native refusal'), {status:1});
      if (mode === 'timeout') throw Object.assign(Error('native timeout'), {code:'ETIMEDOUT'});
      const identity='https://github.com/ShiosOS/Damadama/.github/workflows/stage.yml@refs/heads/main';
      return JSON.stringify([{verificationResult:{signature:{certificate:{
        subjectAlternativeName:identity,issuer:'https://token.actions.githubusercontent.com',
        sourceRepositoryURI:'https://github.com/ShiosOS/Damadama',sourceRepositoryIdentifier:'1412858535',
        sourceRepositoryOwnerIdentifier:'31512984',sourceRepositoryOwnerURI:'https://github.com/ShiosOS',
        sourceRepositoryDigest:'a'.repeat(40),sourceRepositoryRef:'refs/heads/main',buildSignerDigest:'a'.repeat(40),
        buildSignerURI:identity,runnerEnvironment:'github-hosted',runInvocationURI:'https://github.com/ShiosOS/Damadama/actions/runs/1/attempts/1',
      }},verifiedTimestamps:[{type:'Tlog',uri:'https://example.invalid/log',timestamp:'2026-10-18T12:00:00Z'}],
      statement:{_type:'https://in-toto.io/Statement/v1',predicateType:'https://slsa.dev/provenance/v1',subject:[{name:'ghcr.io/shiosos/damadama',digest:{sha256:'c'.repeat(64)}}]}}}]);
    };
    registerHooks({load(url, context, next) {
      if (url === 'node:child_process') return {format:'module',shortCircuit:true,source:'export const execFileSync = (...args) => globalThis.fixtureExec(...args);'};
      const result = next(url, context);
      if (url.endsWith('/supply-internal.mjs')) {
        const source = result.source.toString();
        assert.equal(source.split('const gh = await tool("gh");').length, 2);
        return {...result,source:source.replace('const gh = await tool("gh");', 'const gh = {binary:"controlled-gh"};')};
      }
      return result;
    }});
    const {verifySignature,production,proof,slsa} = await import('./release/supply-internal.mjs');
    process.env.GITHUB_TOKEN='synthetic-secret';
    process.env.DOCKER_CONFIG='ambient-helper-config';
    process.env.GH_TOKEN='ambient-gh-secret';
    const source={repository:'ShiosOS/Damadama',commit:'a'.repeat(40),tree:'b'.repeat(40)};
    const authority={sha:source.commit,runId:1,attempt:1};
    for (mode of ['success','error','timeout']) {
      const pending=verifySignature('oci://ghcr.io/shiosos/damadama@sha256:'+'c'.repeat(64),'bundle',production,source,authority,slsa,'c'.repeat(64));
      if(mode==='success')assert.equal((await pending).subject[0].name,'ghcr.io/shiosos/damadama');
      else await assert.rejects(pending,/failed/);
      assert(!existsSync(observed.cwd));
      assert(!existsSync(observed.env.DOCKER_CONFIG));
    }
    await assert.rejects(verifySignature('archive.tar','bundle',proof,source,authority,slsa,'c'.repeat(64)), /failed/);
    assert.equal(observed.env.DOCKER_CONFIG,undefined);
    assert(!existsSync(observed.cwd));
    delete process.env.GITHUB_TOKEN;
    await assert.rejects(verifySignature('oci://ghcr.io/shiosos/damadama@sha256:'+'c'.repeat(64),'bundle',production,source,authority,slsa,'c'.repeat(64)), /missing ephemeral registry token/);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
});
