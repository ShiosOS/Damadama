import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { inspect } from "node:util";
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

async function diagnosticFixture(t, operation, respond) {
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

function diagnosticRefusal(operation, boundary, reason) {
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

for (const operation of ["manifest", "auth", "config", "layer"])
  for (const boundary of ["request", "body"])
    test(`registry diagnoses and redacts ${operation} ${boundary} failures`, async (t) => {
      const secret = "https://evil.invalid/?token=diagnostic-secret";
      const failure = Object.assign(new Error(secret), {
        code: secret,
        cause: Object.assign(new Error(secret), { code: secret }),
        Authorization: "diagnostic-secret",
        Location: secret,
      });
      const f = await diagnosticFixture(t, operation, () => {
        if (boundary === "request") throw failure;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(failure);
            },
          }),
        );
      });
      await assert.rejects(
        compareRegistryArchive(f.image, f.path),
        diagnosticRefusal(operation, boundary, "unknown"),
      );
    });

for (const [label, failure, reason] of [
  [
    "redirect",
    new TypeError("fetch failed", { cause: new Error("unexpected redirect") }),
    "redirect",
  ],
  [
    "DNS",
    new TypeError("fetch failed", {
      cause: Object.assign(new Error(), { code: "ENOTFOUND" }),
    }),
    "network",
  ],
  [
    "refused connection",
    Object.assign(new Error(), { code: "ECONNREFUSED" }),
    "network",
  ],
  [
    "reset connection",
    new TypeError("fetch failed", {
      cause: Object.assign(new Error(), { code: "ECONNRESET" }),
    }),
    "socket",
  ],
  ["socket", Object.assign(new Error(), { code: "UND_ERR_SOCKET" }), "socket"],
  [
    "TLS expiry",
    new TypeError("fetch failed", {
      cause: Object.assign(new Error(), { code: "CERT_HAS_EXPIRED" }),
    }),
    "tls",
  ],
  [
    "TLS hostname",
    Object.assign(new Error(), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
    "tls",
  ],
  [
    "unknown TypeError",
    new TypeError("unexpected redirect diagnostic-secret"),
    "unknown",
  ],
  [
    "unknown cause",
    new TypeError("fetch failed", {
      cause: new Error("unexpected redirect diagnostic-secret"),
    }),
    "unknown",
  ],
])
  test(`registry classifies ${label} without relaxing refusal`, async (t) => {
    const f = await diagnosticFixture(t, "manifest", () => {
      throw failure;
    });
    await assert.rejects(
      compareRegistryArchive(f.image, f.path),
      diagnosticRefusal("manifest", "request", reason),
    );
  });

for (const operation of ["manifest", "auth", "config", "layer"])
  test(`registry identifies refused ${operation} redirect status without Location`, async (t) => {
    const f = await diagnosticFixture(
      t,
      operation,
      () =>
        new Response("", {
          status: 307,
          headers: {
            Location: "https://evil.invalid/?token=diagnostic-secret",
          },
        }),
    );
    await assert.rejects(compareRegistryArchive(f.image, f.path), (error) => {
      diagnosticRefusal(operation, "response", "redirect")(error);
      assert.match(error.message, /status=307/);
      return true;
    });
  });

test("archive input TypeError remains distinguishable from registry transport", async (t) => {
  const f = await fixture(t);
  const failure = new TypeError("invalid archive input");
  Object.defineProperty(f.image, "archiveSha256", {
    get() {
      throw failure;
    },
  });
  await assert.rejects(compareRegistryArchive(f.image, f.path), (error) => {
    assert.equal(error, failure);
    assert.equal(f.calls.length, 0);
    return true;
  });
});

test("registry identifies a layer body socket failure", async (t) => {
  const f = await diagnosticFixture(
    t,
    "layer",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              Object.assign(new Error("diagnostic-secret"), {
                code: "UND_ERR_SOCKET",
              }),
            );
          },
        }),
      ),
  );
  await assert.rejects(
    compareRegistryArchive(f.image, f.path),
    diagnosticRefusal("layer", "body", "socket"),
  );
});

test("registry redacts an authentication challenge body cancellation failure", async (t) => {
  const f = await diagnosticFixture(
    t,
    "manifest",
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error("diagnostic-secret");
          },
        }),
        {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:shiosos/damadama:pull"',
          },
        },
      ),
  );
  await assert.rejects(
    compareRegistryArchive(f.image, f.path),
    diagnosticRefusal("manifest", "body", "unknown"),
  );
});

test("registry identifies an HTTP refusal without response text", async (t) => {
  const f = await diagnosticFixture(
    t,
    "config",
    () =>
      new Response("diagnostic-secret", {
        status: 403,
        statusText: "diagnostic-secret",
      }),
  );
  await assert.rejects(compareRegistryArchive(f.image, f.path), (error) => {
    diagnosticRefusal("config", "response", "http")(error);
    assert.match(error.message, /status=403/);
    return true;
  });
});

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
    assert.equal(
      options.redirect,
      url.includes("/blobs/") ? "manual" : "error",
    );
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

const cdn = "https://pkg-containers.githubusercontent.com";
const signedBlob = (digest) =>
  `${cdn}/ghcr1/blobs/${digest}?se=2026-10-19T01%3A00%3A00Z&sig=diagnostic-secret`;

async function redirectedFixture(
  t,
  {
    location = signedBlob,
    status = 307,
    respond,
    authenticate = false,
    cancel,
  } = {},
) {
  const f = await fixture(t);
  const fetch = globalThis.fetch;
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "diagnostic-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  });
  const delivery = [];
  const registry = [];
  let cancellations = 0;
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url.startsWith("https://ghcr.io/")) {
      registry.push({ url, options });
      if (url.startsWith("https://ghcr.io/token?")) {
        assert.equal(
          options.headers.Authorization,
          `Basic ${Buffer.from("x-access-token:diagnostic-secret").toString("base64")}`,
        );
        return new Response(JSON.stringify({ token: "diagnostic-bearer" }));
      }
      if (authenticate && !options.headers.Authorization)
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:shiosos/damadama:pull"',
          },
        });
      if (authenticate)
        assert.equal(options.headers.Authorization, "Bearer diagnostic-bearer");
      if (url.includes("/blobs/")) {
        const destination = location(url.split("/").at(-1));
        const headers = new Headers();
        if (destination !== null) headers.set("location", destination);
        return new Response(
          new ReadableStream({
            cancel() {
              cancellations++;
              cancel?.();
            },
          }),
          { status, headers },
        );
      }
      return fetch(url, options);
    }
    delivery.push({ url, options });
    const digest = new URL(url).pathname.split("/").at(-1);
    if (respond) return respond(f, digest, options);
    return new Response(f.responses.get(digest));
  };
  return { ...f, delivery, registry, cancellations: () => cancellations };
}

test("registry delivers config and layers through one credential-free CDN hop", async (t) => {
  const f = await redirectedFixture(t, { authenticate: true });
  await compareRegistryArchive(f.image, f.path);
  assert.equal(f.delivery.length, 3);
  assert.equal(f.cancellations(), 3);
  assert.deepEqual(
    f.delivery.map(({ url }) => url),
    [f.manifest.config, ...f.manifest.layers].map(({ digest }) =>
      signedBlob(digest),
    ),
  );
  for (const [index, { options }] of f.delivery.entries()) {
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.signal, f.registry[0].options.signal);
    assert.deepEqual(Object.fromEntries(new Headers(options.headers)), {
      accept: [f.manifest.config, ...f.manifest.layers][index].mediaType,
      "accept-encoding": "identity",
    });
  }
  for (const { url, options } of f.registry)
    assert.equal(
      options.redirect,
      url.includes("/blobs/") ? "manual" : "error",
    );
});

for (const [name, location] of [
  ["HTTP", "http://pkg-containers.githubusercontent.com/blob"],
  ["alternate host", "https://evil.invalid/blob?sig=diagnostic-secret"],
  [
    "suffix lookalike",
    "https://pkg-containers.githubusercontent.com.evil.invalid/blob",
  ],
  [
    "prefix lookalike",
    "https://evil.pkg-containers.githubusercontent.com/blob",
  ],
  ["port", `${cdn}:8443/blob`],
  ["default port", `${cdn}:443/blob`],
  [
    "userinfo",
    "https://diagnostic-secret@pkg-containers.githubusercontent.com/blob",
  ],
  ["fragment", `${cdn}/blob#diagnostic-secret`],
  ["empty fragment", `${cdn}/blob#`],
  ["relative", "/blob?sig=diagnostic-secret"],
  ["scheme relative", "//pkg-containers.githubusercontent.com/blob"],
  ["missing", null],
  ["empty", ""],
  ["malformed", "https://[diagnostic-secret"],
  ["backslash", `${cdn}\\blob?sig=diagnostic-secret`],
  ["embedded tab", "https://pkg-containers.githubuser\tcontent.com/blob"],
  ["escaped authority", "https://%70kg-containers.githubusercontent.com/blob"],
])
  test(`registry refuses ${name} blob redirect before any destination request`, async (t) => {
    const f = await redirectedFixture(t, { location: () => location });
    await assert.rejects(
      compareRegistryArchive(f.image, f.path),
      diagnosticRefusal("config", "response", "redirect"),
    );
    assert.equal(f.delivery.length, 0);
    assert.equal(f.cancellations(), 1);
  });

for (const status of [301, 302, 303, 308])
  test(`registry refuses unexpected blob redirect status ${status}`, async (t) => {
    const f = await redirectedFixture(t, { status });
    await assert.rejects(
      compareRegistryArchive(f.image, f.path),
      diagnosticRefusal("config", "response", "redirect"),
    );
    assert.equal(f.delivery.length, 0);
  });

for (const status of [201, 301, 302, 303, 307, 308])
  test(`registry refuses CDN status ${status} without following another hop`, async (t) => {
    const f = await redirectedFixture(t, {
      respond: () =>
        new Response("diagnostic-secret", {
          status,
          headers: { location: "https://evil.invalid/?sig=diagnostic-secret" },
        }),
    });
    await assert.rejects(
      compareRegistryArchive(f.image, f.path),
      diagnosticRefusal(
        "config",
        "response",
        status === 201 ? "http" : "redirect",
      ),
    );
    assert.equal(f.delivery.length, 1);
    assert.equal(f.delivery[0].options.redirect, "error");
  });

for (const operation of ["manifest", "auth"])
  test(`registry refuses even the allowed CDN for ${operation} redirects`, async (t) => {
    let requests = 0;
    const f = await diagnosticFixture(t, operation, () => {
      requests++;
      return new Response("", {
        status: 307,
        headers: { location: signedBlob("config") },
      });
    });
    await assert.rejects(
      compareRegistryArchive(f.image, f.path),
      diagnosticRefusal(operation, "response", "redirect"),
    );
    assert.equal(requests, 1);
  });

for (const boundary of ["request", "body"])
  test(`registry redacts a signed CDN ${boundary} failure`, async (t) => {
    const f = await redirectedFixture(t, {
      respond: () => {
        const failure = new TypeError(signedBlob("diagnostic-secret"));
        if (boundary === "request") throw failure;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(failure);
            },
          }),
        );
      },
    });
    await assert.rejects(
      compareRegistryArchive(f.image, f.path),
      diagnosticRefusal("config", boundary, "unknown"),
    );
    assert.equal(f.delivery.length, 1);
  });

test("CDN authentication refusal cannot trigger a registry credential exchange", async (t) => {
  const f = await redirectedFixture(t, {
    respond: () =>
      new Response("", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:shiosos/damadama:pull"',
        },
      }),
  });
  await assert.rejects(
    compareRegistryArchive(f.image, f.path),
    diagnosticRefusal("config", "response", "http"),
  );
  assert.equal(f.delivery.length, 1);
  assert.equal(
    f.registry.some(({ url }) => url.startsWith("https://ghcr.io/token?")),
    false,
  );
});

test("registry redacts blob redirect cancellation failure before CDN delivery", async (t) => {
  const f = await redirectedFixture(t, {
    cancel: () => {
      throw new Error(signedBlob("diagnostic-secret"));
    },
  });
  await assert.rejects(
    compareRegistryArchive(f.image, f.path),
    diagnosticRefusal("config", "body", "unknown"),
  );
  assert.equal(f.delivery.length, 0);
});

for (const [name, mutate, limits, pattern] of [
  [
    "config hash",
    (f) => {
      const bytes = Buffer.from(f.config);
      bytes[0] ^= 1;
      f.responses.set(f.manifest.config.digest, bytes);
    },
    () => registryLimits,
    /config digest/,
  ],
  [
    "config bound",
    (f) => {
      f.responses.set(
        f.manifest.config.digest,
        Buffer.concat([f.config, Buffer.from("x")]),
      );
    },
    (f) => ({ ...registryLimits, configBytes: f.config.length }),
    /streamed bytes/,
  ],
  [
    "compressed bound",
    (f) => {
      const layer = f.manifest.layers[0];
      f.responses.set(layer.digest, Buffer.alloc(layer.size + 1));
    },
    () => registryLimits,
    /streamed bytes/,
  ],
  [
    "compressed hash",
    (f) => {
      const layer = f.manifest.layers[0];
      const bytes = Buffer.from(f.responses.get(layer.digest));
      bytes[9] ^= 1;
      f.responses.set(layer.digest, bytes);
    },
    () => registryLimits,
    /compressed layer digest/,
  ],
  [
    "ordered DiffID",
    (f) => {
      f.manifest.layers.reverse();
      f.seal();
    },
    () => registryLimits,
    /ordered DiffID/,
  ],
  [
    "expanded bound",
    (f) => {
      const bytes = gzipSync(
        tar([{ name: "large", content: Buffer.alloc(8192) }]),
      );
      const layer = f.manifest.layers[0];
      layer.digest = `sha256:${sha256(bytes)}`;
      layer.size = bytes.length;
      f.responses.set(layer.digest, bytes);
      f.seal();
    },
    (f) => ({ ...registryLimits, layerBytes: f.layers[0].length }),
    /bound/,
  ],
])
  test(`redirected bytes retain the ${name} check`, async (t) => {
    const f = await redirectedFixture(t);
    mutate(f);
    await assert.rejects(
      compareRegistryArchive(f.image, f.path, limits(f)),
      pattern,
    );
    assert(f.delivery.length > 0);
  });

test("original mutation during CDN delivery refuses admission", async (t) => {
  const f = await redirectedFixture(t, {
    respond: async (fixture, digest) => {
      await writeFile(fixture.path, "changed");
      return new Response(fixture.responses.get(digest));
    },
  });
  await assert.rejects(
    compareRegistryArchive(f.image, f.path),
    /original archive changed/,
  );
  assert.equal(f.delivery.length, 3);
});

for (const boundary of ["request", "body"])
  test(`registry deadline cancels the redirected ${boundary}`, async (t) => {
    let cancelled = false;
    const f = await redirectedFixture(t, {
      respond: (fixture, digest, { signal }) => {
        const stall = (reject) =>
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("diagnostic-secret"));
            },
            { once: true },
          );
        if (boundary === "request")
          return new Promise((resolve, reject) => stall(reject));
        return new Response(
          new ReadableStream({
            start(controller) {
              stall((error) => controller.error(error));
            },
          }),
        );
      },
    });
    await assert.rejects(
      compareRegistryArchive(f.image, f.path, {
        ...registryLimits,
        timeoutMs: 500,
      }),
      /deadline exceeded/,
    );
    assert(cancelled);
    assert.equal(f.delivery.length, 1);
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
