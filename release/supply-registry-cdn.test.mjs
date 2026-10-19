import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { sha256, tar } from "./supply-frontend-fixtures.mjs";
import { compareRegistryArchive, registryLimits } from "./supply-registry.mjs";
import {
  fixture,
  diagnosticFixture,
  diagnosticRefusal,
} from "./supply-registry-fixtures.mjs";

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
