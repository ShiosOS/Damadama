import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRegistryArchive } from "./supply-registry.mjs";
import {
  fixture,
  diagnosticFixture,
  diagnosticRefusal,
} from "./supply-registry-fixtures.mjs";

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
