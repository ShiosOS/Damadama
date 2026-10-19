import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const consumerRevision = "bef623aa440feeb9a697f610693122889ffc56e4";
const consumerSha256 =
  "f24892510b76ce9abd3cc389d7c7beee83b8bddec4998ce3873d09176a8127eb";
const checks = [];
let scenario = "consumer-identity";
let inputEnvelopeSha256;
const output = resolve(process.argv[4] ?? ".audit/consumer-compatibility.json");

async function consumer(bytes) {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    consumerSha256,
    "Consumer source hash differs",
  );
  return import(`data:text/javascript;base64,${bytes.toString("base64")}`);
}

try {
  assert.equal(
    process.argv.length,
    5,
    "Pass external consumer, produced synthetic envelope, and summary paths",
  );
  const source = await readFile(process.argv[2]);
  const altered = Buffer.from(source);
  altered[0] ^= 1;
  await assert.rejects(consumer(altered), /Consumer source hash differs/);
  const { observe } = await consumer(source);
  const input = await readFile(process.argv[3]);
  inputEnvelopeSha256 = createHash("sha256").update(input).digest("hex");
  const actual = JSON.parse(input.toString("utf8"));
  assert.equal(
    actual.origin,
    "synthetic",
    "Produced envelope must remain synthetic",
  );
  const target = {
    environment: "staging",
    metadataUrl: "https://metadata.invalid/completion.json",
    metadataOrigin: "https://metadata.invalid",
    monitorRevision: consumerRevision,
  };
  const release = {
    source: {
      repository: "ShiosOS/Damadama",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    },
    version: `main-${"a".repeat(12)}`,
  };
  async function inspect(value, now, status = 200) {
    return observe(target, {
      now,
      fetch: async (address) => {
        const url = new URL(address);
        if (url.origin === target.metadataOrigin)
          return new Response(JSON.stringify(value), { status });
        if (url.pathname === "/release.json") return Response.json(release);
        return new Response("", { status: 200 });
      },
    });
  }
  scenario = "produced-synthetic-envelope-refused";
  const actualResult = await inspect(actual, Date.parse(actual.observedAt));
  assert.equal(actualResult.checks.completion.reason, "non-hosted-evidence");
  assert.equal(actualResult.verdict, "invalid");
  checks.push(scenario);

  const now = Date.parse("2026-10-18T10:00:00Z");
  const simulatedHosted = {
    schemaVersion: 1,
    origin: "hosted",
    observedAt: "2026-10-18T10:00:00Z",
    completion: {
      environment: "staging",
      backup: "damadama/staging/20261018T095900Z-aaaaaaaaaaaaaaaa.dump.age",
      completedAt: "2026-10-18T09:59:01Z",
      retentionDays: 7,
      durationSeconds: 0,
    },
    archivePresent: true,
    checksumPresent: true,
    job: "succeeded",
    retention: "succeeded",
  };
  scenario = "simulated-hosted-contract-fixture-accepted";
  assert.equal((await inspect(simulatedHosted, now)).verdict, "healthy");
  checks.push(scenario);

  for (const [name, mutate, route, expected, status = 200] of [
    ["missing-metadata", () => {}, "completion", "http-missing", 404],
    ["refused-metadata", () => {}, "completion", "http-refused", 403],
    [
      "missing-completion",
      (x) => {
        x.completion = null;
      },
      "completion",
      "incomplete-triplet",
    ],
    [
      "missing-archive",
      (x) => {
        x.archivePresent = false;
      },
      "completion",
      "incomplete-triplet",
    ],
    [
      "missing-checksum",
      (x) => {
        x.checksumPresent = false;
      },
      "completion",
      "incomplete-triplet",
    ],
    [
      "stale-observation",
      (x) => {
        x.observedAt = "2026-10-17T09:59:59Z";
        x.completion = null;
      },
      "completion",
      "stale-observation",
    ],
    [
      "stale-completion",
      (x) => {
        x.completion.backup = x.completion.backup.replace(
          "20261018",
          "20261017",
        );
        x.completion.completedAt = "2026-10-17T09:59:01Z";
      },
      "completion",
      "stale-completion",
    ],
    [
      "future-observation",
      (x) => {
        x.observedAt = "2026-10-18T10:00:00.001Z";
      },
      "completion",
      "invalid-observation-time",
    ],
    [
      "future-completion",
      (x) => {
        x.completion.completedAt = "2026-10-18T10:00:00.001Z";
      },
      "completion",
      "invalid-completion",
    ],
    [
      "wrong-environment",
      (x) => {
        x.completion.environment = "production";
      },
      "completion",
      "invalid-completion",
    ],
    [
      "failed-job",
      (x) => {
        x.job = "failed";
      },
      "job",
      "job-failed",
    ],
    [
      "unknown-job",
      (x) => {
        x.job = "unknown";
      },
      "job",
      "job-unknown",
    ],
    [
      "failed-retention",
      (x) => {
        x.retention = "failed";
      },
      "retention",
      "retention-failed",
    ],
    [
      "unknown-retention",
      (x) => {
        x.retention = "unknown";
      },
      "retention",
      "retention-unknown",
    ],
  ]) {
    scenario = `simulated-${name}-refused`;
    const value = structuredClone(simulatedHosted);
    mutate(value);
    const result = await inspect(value, now, status);
    assert.equal(result.checks[route].reason, expected);
    assert.notEqual(result.verdict, "healthy");
    checks.push(scenario);
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        schema: 1,
        outcome: "passed",
        consumerRevision,
        consumerSha256,
        inputEnvelopeSha256,
        transport: "simulated-consumer-fetch",
        hostedExecution: "not-executed",
        checks,
      },
      null,
      2,
    ),
  );
} catch {
  await writeFile(
    output,
    JSON.stringify(
      { schema: 1, outcome: "failed", failureCode: scenario, checks },
      null,
      2,
    ),
  );
  console.error(JSON.stringify({ outcome: "failed", failureCode: scenario }));
  process.exitCode = 1;
}
