import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const registry = "https://ghcr.io";
const repository = registry + "/v2/shiosos/damadama";
const target = {
  source: "f7b7f964d2c1d36d851c0f6bc657636d8cf9dd1f",
  runId: 39178994019,
  attempt: 1,
  tag: "main-f7b7f964d2c1-39178994019-1",
};
const destinations = new Set([
  "https://ghcr.io",
  "https://pkg-containers.githubusercontent.com",
  "https://github-registry-files.githubusercontent.com",
]);
const manifestTypes = {
  "application/vnd.oci.image.manifest.v1+json": {
    config: "application/vnd.oci.image.config.v1+json",
    layer: "application/vnd.oci.image.layer.v1.tar+gzip",
  },
  "application/vnd.docker.distribution.manifest.v2+json": {
    config: "application/vnd.docker.container.image.v1+json",
    layer: "application/vnd.docker.image.rootfs.diff.tar.gzip",
  },
};
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const hash = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const report = {
  schema: 1,
  purpose: "registry-diagnostic-only",
  target,
  probeSource: process.env.GITHUB_SHA,
  probeRunId: process.env.GITHUB_RUN_ID,
  probeAttempt: process.env.GITHUB_RUN_ATTEMPT,
  node: process.version,
  authenticatedRelease: false,
  registryArchiveEquality: "not tested",
  observations: [],
};
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 90_000);
let bearer;
let requests = 0;
let refused = false;

function reason(error) {
  if (controller.signal.aborted) return "deadline";
  const codes = new Set([
    "ENOTFOUND",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  if (codes.has(error?.cause?.code)) return error.cause.code;
  if (
    error instanceof TypeError &&
    error.cause?.message === "unexpected redirect"
  )
    return "redirect";
  return "unknown";
}

async function request(operation, url, accept, authorization) {
  assert.equal(new URL(url).origin, registry);
  assert.ok(++requests <= 10);
  const headers = { Accept: accept, "Accept-Encoding": "identity" };
  if (authorization) headers.Authorization = authorization;
  try {
    const response = await fetch(url, {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    report.observations.push({
      operation,
      variant: "redirect-error",
      status: response.status,
    });
    return response;
  } catch (error) {
    refused = true;
    const label = reason(error);
    report.observations.push({
      operation,
      variant: "redirect-error",
      reason: label,
    });
    if (label === "redirect") {
      try {
        assert.ok(++requests <= 10);
        const response = await fetch(url, {
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
        const observation = {
          operation,
          variant: "manual-no-follow",
          status: response.status,
        };
        const location = response.headers.get("location");
        if (location) {
          try {
            const value = new URL(location, registry);
            observation.destinationOrigin =
              destinations.has(value.origin) &&
              !value.username &&
              !value.password
                ? value.origin
                : "not-allowlisted";
            observation.hasQuery = value.search.length > 0;
          } catch {
            observation.destinationOrigin = "invalid";
          }
        }
        report.observations.push(observation);
        await response.body?.cancel();
      } catch (manualError) {
        report.observations.push({
          operation,
          variant: "manual-no-follow",
          reason: reason(manualError),
        });
      }
    }
    return null;
  }
}

async function bytes(response, maximum) {
  let reader;
  try {
    assert.equal(response.status, 200);
    assert.ok(
      !response.headers.get("content-encoding") ||
        response.headers.get("content-encoding") === "identity",
    );
    const length = response.headers.get("content-length");
    if (length !== null)
      assert.ok(/^\d+$/.test(length) && Number(length) <= maximum);
    assert.ok(response.body);
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      assert.ok(size <= maximum);
      chunks.push(item.value);
    }
    if (length !== null) assert.equal(size, Number(length));
    return Buffer.concat(chunks);
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    else await response.body?.cancel().catch(() => {});
  }
}

async function manifestRequest(operation, suffix) {
  const accept = Object.keys(manifestTypes).join(", ");
  const url = repository + "/manifests/" + suffix;
  let response = await request(
    operation,
    url,
    accept,
    bearer && "Bearer " + bearer,
  );
  if (response?.status === 401 && !bearer) {
    const challenge = response.headers.get("www-authenticate");
    await response.body?.cancel();
    assert.ok(
      /^Bearer realm="https:\/\/ghcr\.io\/token",service="ghcr\.io",scope="repository:shiosos\/damadama:pull"$/.test(
        challenge ?? "",
      ),
    );
    const token = process.env.GITHUB_TOKEN;
    assert.ok(typeof token === "string" && token.length > 0);
    const authorization =
      "Basic " + Buffer.from("x-access-token:" + token).toString("base64");
    const auth = await request(
      "token",
      registry +
        "/token?service=ghcr.io&scope=repository%3Ashiosos%2Fdamadama%3Apull",
      "application/json",
      authorization,
    );
    assert.ok(auth);
    bearer = JSON.parse((await bytes(auth, 64 * 1024)).toString("utf8")).token;
    assert.ok(
      typeof bearer === "string" &&
        /^[A-Za-z0-9._~+\/-]+=*$/.test(bearer) &&
        bearer.length <= 32 * 1024,
    );
    response = await request(operation, url, accept, "Bearer " + bearer);
  }
  assert.ok(response);
  const returned = response.headers.get("docker-content-digest");
  const content = await bytes(response, 64 * 1024);
  assert.match(returned ?? "", digestPattern);
  assert.equal(returned, hash(content));
  return { digest: returned, bytes: content };
}

try {
  assert.equal(process.version, "v24.21.0");
  assert.equal(process.env.GITHUB_REPOSITORY, "ShiosOS/Damadama");
  assert.equal(process.env.GITHUB_EVENT_NAME, "pull_request");
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1");
  const tagged = await manifestRequest("manifest-tag", target.tag);
  report.resolvedDigest = tagged.digest;
  const immutable = await manifestRequest("manifest-digest", tagged.digest);
  assert.equal(immutable.digest, tagged.digest);
  assert.ok(immutable.bytes.equals(tagged.bytes));
  const manifest = JSON.parse(immutable.bytes.toString("utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.ok(Object.hasOwn(manifestTypes, manifest.mediaType));
  assert.ok(!manifest.manifests && !manifest.subject);
  assert.ok(
    Array.isArray(manifest.layers) &&
      manifest.layers.length > 0 &&
      manifest.layers.length <= 64,
  );
  const types = manifestTypes[manifest.mediaType];
  for (const [operation, descriptor, type, maximum] of [
    ["config", manifest.config, types.config, 1024 * 1024],
    ["first-layer", manifest.layers[0], types.layer, 128 * 1024 * 1024],
  ]) {
    assert.equal(descriptor.mediaType, type);
    assert.match(descriptor.digest, digestPattern);
    assert.ok(
      !Object.hasOwn(descriptor, "urls") && !Object.hasOwn(descriptor, "data"),
    );
    assert.ok(
      Number.isSafeInteger(descriptor.size) &&
        descriptor.size > 0 &&
        descriptor.size <= maximum,
    );
    const response = await request(
      operation,
      repository + "/blobs/" + descriptor.digest,
      type,
      bearer && "Bearer " + bearer,
    );
    if (response) {
      if (response.status !== 200) refused = true;
      await response.body?.cancel();
    }
  }
  report.outcome = refused ? "observed-refusal" : "headers-observed-no-refusal";
} catch (error) {
  report.outcome = "incomplete";
  report.reason = reason(error);
  refused = true;
} finally {
  clearTimeout(timer);
  controller.abort();
  report.requests = requests;
  writeFileSync(
    "registry-diagnostic.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    "Registry diagnostic only. Outcome " +
      report.outcome +
      ". Requests " +
      requests +
      ". No redirect followed.",
  );
  process.exitCode = refused ? 1 : 0;
}
