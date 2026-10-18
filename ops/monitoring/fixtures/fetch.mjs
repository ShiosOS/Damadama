import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const now = Date.parse("2026-10-18T12:00:00.000Z");
const sentinel =
  "PRIVATE_HABIT_SENTINEL SECRET_TOKEN_SENTINEL https://untrusted.invalid/private-path?secret=SECRET_QUERY_SENTINEL";
const scenario = process.env.MONITOR_TEST_CASE;
let attempts = 0;
const nativeFetch = globalThis.fetch;
process.on("exit", () => {
  if (process.env.MONITOR_TEST_ATTEMPTS)
    writeFileSync(process.env.MONITOR_TEST_ATTEMPTS, JSON.stringify(attempts));
});
const envelope = JSON.parse(
  readFileSync(new URL("healthy.json", import.meta.url)),
);
const source = {
  repository: "ShiosOS/Damadama",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
};
const identity = { source, version: `main-${source.commit.slice(0, 12)}` };
const metadataStatus = {
  missing: 404,
  refused: 403,
  expired: 403,
  "metadata-500": 500,
  "metadata-503": 503,
  redirect: 302,
};
const appStatus = {
  "app-503": 503,
  "app-500": 500,
  "app-404": 404,
  "app-redirect": 302,
};

Date.now = () => now;
switch (scenario) {
  case "synthetic-receipt":
    envelope.origin = "synthetic";
    break;
  case "unknown-origin":
    envelope.origin = "unknown";
    break;
  case "missing-origin":
    delete envelope.origin;
    break;
  case "boundary":
  case "observation-boundary":
  case "stale":
    envelope.completion.backup =
      "damadama/staging/20261017T115900Z-0123456789abcdef.dump.age";
    envelope.completion.completedAt = "2026-10-17T12:00:00.000Z";
    if (scenario === "stale")
      envelope.completion.completedAt = "2026-10-17T11:59:59.999Z";
    if (scenario === "observation-boundary")
      envelope.observedAt = envelope.completion.completedAt;
    break;
  case "stale-observation":
    envelope.observedAt = "2026-10-17T11:59:59.999Z";
    envelope.completion = null;
    break;
  case "wrong-environment":
    envelope.completion.environment = "production";
    break;
  case "future":
    envelope.completion.completedAt = "2026-10-18T12:00:00.001Z";
    break;
  case "future-observation":
    envelope.observedAt = "2026-10-18T12:00:00.001Z";
    break;
  case "malformed-time":
    envelope.completion.completedAt = "2026-02-30T03:00:00Z";
    break;
  case "offset-time":
    envelope.observedAt = "2026-10-18T12:00:00+00:00";
    break;
  case "observation-before-completion":
    envelope.observedAt = "2026-10-18T02:59:59Z";
    break;
  case "wrong-prefix":
    envelope.completion.backup = envelope.completion.backup.replace(
      "staging",
      "production",
    );
    break;
  case "wrong-suffix":
    envelope.completion.backup += ".json";
    break;
  case "future-key":
    envelope.completion.backup =
      "damadama/staging/20261019T025900Z-0123456789abcdef.dump.age";
    break;
  case "malformed-key-time":
    envelope.completion.backup =
      "damadama/staging/20260230T025900Z-0123456789abcdef.dump.age";
    break;
  case "missing-archive":
    envelope.archivePresent = false;
    break;
  case "missing-checksum":
    envelope.checksumPresent = false;
    break;
  case "orphan":
    envelope.completion = null;
    break;
  case "retention-failed":
    envelope.retention = "failed";
    break;
  case "job-failed":
    envelope.job = "failed";
    break;
  case "unknown":
    envelope.job = "unknown";
    envelope.retention = "unknown";
    break;
  case "extra-manifest-field":
    envelope.completion.habit = sentinel;
    break;
  case "extra-envelope-field":
    envelope.habit = sentinel;
    break;
  case "short-retention":
    envelope.completion.retentionDays = 6;
    break;
  case "invalid-duration":
    envelope.completion.durationSeconds = -1;
    break;
  case "zero-duration":
    envelope.completion.durationSeconds = 0;
    break;
  case "fractional-duration":
    envelope.completion.durationSeconds = 0.5;
    break;
  case "unsafe-duration":
    envelope.completion.durationSeconds = Number.MAX_SAFE_INTEGER + 1;
    break;
  case "invalid-job":
    envelope.job = "completed";
    break;
  case "array-job":
    envelope.job = ["succeeded"];
    break;
  case "malformed-identity":
    identity.source.commit = sentinel;
    break;
  case "wrong-repository":
    identity.source.repository = "other/Damadama";
    break;
  case "array-identity":
    identity.source.tree = [source.tree];
    break;
}

globalThis.fetch = async (input, options) => {
  attempts++;
  if (process.env.MONITOR_TEST_TRANSPORT_URL) {
    const response = await nativeFetch(process.env.MONITOR_TEST_TRANSPORT_URL, {
      method: "GET",
      redirect: "manual",
      signal: options.signal,
    });
    await response.body?.cancel();
  }
  const url = new URL(input);
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "manual");
  assert.ok(options.signal instanceof AbortSignal);
  if (url.origin === "https://metadata.example.test") {
    assert.equal(url.pathname, "/fixed/latest.json");
    if (scenario === "timeout")
      throw new DOMException(sentinel, "TimeoutError");
    if (scenario === "network") throw new Error(sentinel);
    if (scenario === "malformed-json") return new Response(sentinel);
    if (scenario === "oversized") return new Response("x".repeat(16_385));
    if (scenario === "declared-oversized")
      return new Response("{}", { headers: { "Content-Length": "16385" } });
    if (metadataStatus[scenario])
      return new Response(sentinel, {
        status: metadataStatus[scenario],
        headers: { Location: `https://untrusted.invalid/${sentinel}` },
      });
    return Response.json(envelope);
  }
  assert.equal(url.origin, "https://staging.damadama.app");
  assert.ok(
    ["/health/live", "/health/ready", "/release.json"].includes(url.pathname),
  );
  if (url.pathname === "/health/ready") {
    if (scenario === "app-204") return new Response(null, { status: 204 });
    if (appStatus[scenario])
      return Response.json(
        { detail: sentinel },
        { status: appStatus[scenario] },
      );
    if (scenario === "trace")
      return Response.json(
        { detail: sentinel, traceId: "0HN7JCQJ7PQ6J:00000001" },
        { status: 503 },
      );
    if (scenario === "header-trace")
      return new Response(sentinel, {
        status: 500,
        headers: { "X-Trace-Id": "c".repeat(32) },
      });
    if (scenario === "invalid-trace")
      return Response.json(
        { traceId: `${sentinel}\n::error::injected` },
        { status: 503 },
      );
    if (scenario === "overlong-trace")
      return Response.json({ traceId: "a".repeat(129) }, { status: 503 });
  }
  if (url.pathname === "/release.json") return Response.json(identity);
  return new Response("Healthy");
};
