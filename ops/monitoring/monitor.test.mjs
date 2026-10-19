import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { observe, formatObservation } from "./monitor.mjs";

const now = Date.parse("2026-10-18T12:00:00.000Z");
const fixture = () =>
  JSON.parse(readFileSync(new URL("fixtures/healthy.json", import.meta.url)));
const target = {
  environment: "staging",
  metadataOrigin: "https://metadata.example.test",
  metadataUrl:
    "https://metadata.example.test/fixed/latest.json?secret=SECRET_QUERY_SENTINEL",
  monitorRevision: "d".repeat(40),
  runReference:
    "https://github.com/ShiosOS/Damadama/actions/runs/123/attempts/1",
};
const cli = fileURLToPath(new URL("run.mjs", import.meta.url));
const preload = new URL("fixtures/fetch.mjs", import.meta.url).href;
const inactive =
  "Staging monitoring inactive; zero requests. This successful run reports disabled state and does not establish live health or alert delivery.";
const invalidActivation =
  "Staging monitoring refused; invalid activation; zero requests.";

function runCli(environment = {}, imports = []) {
  const directory = mkdtempSync(join(tmpdir(), "monitor-cli-"));
  const summary = join(directory, "summary.md");
  const attempts = join(directory, "attempts.json");
  try {
    writeFileSync(summary, "");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        ...imports.flatMap((url) => ["--import", url]),
        cli,
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          SystemRoot: process.env.SystemRoot,
          MONITOR_TEST_CASE: "healthy",
          MONITOR_TEST_ATTEMPTS: attempts,
          OPS_MONITOR_ENABLED_STAGING: "true",
          BACKUP_METADATA_URL_STAGING: target.metadataUrl,
          BACKUP_METADATA_ORIGIN_STAGING: target.metadataOrigin,
          GITHUB_ACTIONS: "true",
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_SHA: target.monitorRevision,
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          ...environment,
        },
      },
    );
    assert.equal(result.error, undefined);
    return {
      ...result,
      attempts: JSON.parse(readFileSync(attempts, "utf8")),
      summary: readFileSync(summary, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("enabled CLI rejects an unexpected disabled observation", () => {
  const hook = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url.endsWith('/ops/monitoring/monitor.mjs'))
        return { ...result, source: String(result.source).replace('target.enabled === false', 'target.enabled !== undefined') };
      return result;
    } });`;
  const result = runCli({}, [
    `data:text/javascript,${encodeURIComponent(hook)}`,
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.attempts, 0);
  assert.match(result.stdout, /^environment=staging verdict=disabled/);
  assert.match(
    result.stderr,
    /^::error title=Staging operational monitor::environment=staging verdict=disabled/,
  );
  assert.equal(result.summary, result.stdout);
});

for (const name of [
  "BACKUP_METADATA_URL_STAGING",
  "BACKUP_METADATA_ORIGIN_STAGING",
]) {
  test(`enabled CLI fails when ${name} is missing`, () => {
    const result = runCli({ [name]: undefined });
    assert.equal(result.status, 1);
    assert.equal(result.attempts, 3);
    assert.equal(result.summary, result.stdout);
    assert.match(result.stderr, /^::error title=Staging operational monitor::/);
  });
}

for (const raw of [undefined, "", "false"]) {
  test(`CLI inactive activation ${JSON.stringify(raw)} exits zero without fetch`, () => {
    const result = runCli({
      OPS_MONITOR_ENABLED_STAGING: raw,
      BACKUP_METADATA_URL_STAGING: "private-invalid-capability",
      BACKUP_METADATA_ORIGIN_STAGING: "private-invalid-origin",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.attempts, 0);
    assert.ok(result.stdout.startsWith(`${inactive}\n`));
    assert.match(result.stdout, /environment=production verdict=disabled/);
    assert.equal(result.summary, result.stdout);
    assert.equal(
      result.stderr,
      `::notice title=Staging operational monitor::${inactive}\n`,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /private-/);
  });
}

for (const raw of [
  "TRUE",
  "True",
  "FALSE",
  "False",
  " true",
  "true ",
  " false ",
  "0",
  "1",
  "\t",
  "\n",
  "private-activation\n::error::private-injection",
]) {
  test(`CLI invalid activation ${JSON.stringify(raw)} fails without fetch`, () => {
    const result = runCli({ OPS_MONITOR_ENABLED_STAGING: raw });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.attempts, 0);
    assert.ok(result.stdout.startsWith(`${invalidActivation}\n`));
    assert.match(result.stdout, /environment=production verdict=disabled/);
    assert.equal(result.summary, result.stdout);
    assert.equal(
      result.stderr,
      `::error title=Staging operational monitor::${invalidActivation}\n`,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /private-|::error::/);
  });
}
const cases = [
  ["healthy", 0, "completion", "healthy", "completed-triplet"],
  ["zero-duration", 0, "completion", "healthy", "completed-triplet"],
  ...["synthetic-receipt", "unknown-origin"].map((name) => [
    name,
    1,
    "completion",
    "invalid",
    "non-hosted-evidence",
  ]),
  ["boundary", 0, "completion", "healthy", "completed-triplet"],
  ["observation-boundary", 0, "completion", "healthy", "completed-triplet"],
  ["stale", 1, "completion", "stale", "stale-completion"],
  ["stale-observation", 1, "completion", "stale", "stale-observation"],
  ["missing", 1, "completion", "missing", "http-missing"],
  ["refused", 1, "completion", "refused", "http-refused"],
  ["expired", 1, "completion", "refused", "http-refused"],
  ["redirect", 1, "completion", "invalid", "redirect-refused"],
  ["timeout", 1, "completion", "unavailable", "timeout"],
  ["network", 1, "completion", "unavailable", "network-unavailable"],
  ...[
    "wrong-environment",
    "future",
    "malformed-time",
    "wrong-prefix",
    "wrong-suffix",
    "future-key",
    "malformed-key-time",
    "extra-manifest-field",
    "short-retention",
    "invalid-duration",
    "fractional-duration",
    "unsafe-duration",
  ].map((name) => [name, 1, "completion", "invalid", "invalid-completion"]),
  ...["future-observation", "offset-time"].map((name) => [
    name,
    1,
    "completion",
    "invalid",
    "invalid-observation-time",
  ]),
  [
    "observation-before-completion",
    1,
    "completion",
    "invalid",
    "observation-before-completion",
  ],
  ...["missing-archive", "missing-checksum", "orphan"].map((name) => [
    name,
    1,
    "completion",
    "missing",
    "incomplete-triplet",
  ]),
  ["retention-failed", 1, "retention", "unavailable", "retention-failed"],
  ["job-failed", 1, "job", "unavailable", "job-failed"],
  ["unknown", 1, "job", "unknown", "job-unknown"],
  ...["extra-envelope-field", "invalid-job", "array-job", "missing-origin"].map(
    (name) => [name, 1, "completion", "invalid", "invalid-metadata"],
  ),
  ...["malformed-json", "oversized", "declared-oversized"].map((name) => [
    name,
    1,
    "completion",
    "invalid",
    "invalid-json",
  ]),
  ...["malformed-identity", "wrong-repository", "array-identity"].map(
    (name) => [name, 1, "identity", "invalid", "invalid-release-identity"],
  ),
  ["app-503", 1, "readiness", "unavailable", "http-failure"],
  ["app-204", 1, "readiness", "unavailable", "http-failure"],
  ["app-500", 1, "readiness", "unavailable", "http-failure"],
  ["app-404", 1, "readiness", "missing", "http-missing"],
  ["app-redirect", 1, "readiness", "invalid", "redirect-refused"],
  ["metadata-503", 1, "completion", "unavailable", "http-failure"],
  ["metadata-500", 1, "completion", "unavailable", "http-failure"],
  ...["trace", "header-trace", "invalid-trace", "overlong-trace"].map(
    (name) => [name, 1, "readiness", "unavailable", "http-failure"],
  ),
];
const routes = {
  completion: "backup-metadata",
  retention: "backup-retention",
  job: "backup-job",
  readiness: "/health/ready",
  identity: "/release.json",
};

for (const [scenario, exit, component, verdict, reason] of cases) {
  test(`CLI ${scenario} reports ${verdict} and exits ${exit}`, () => {
    const result = runCli({ MONITOR_TEST_CASE: scenario });
    assert.equal(result.status, exit, result.stderr);
    assert.equal(result.summary, result.stdout);
    assert.ok(result.attempts >= 4 && result.attempts <= 5);
    assert.match(
      result.stdout,
      new RegExp(
        `route=${routes[component]} verdict=${verdict} reason=${reason}`,
      ),
    );
    assert.match(result.stdout, /environment=production verdict=disabled/);
    if (
      ["malformed-identity", "wrong-repository", "array-identity"].includes(
        scenario,
      )
    )
      assert.match(
        result.stdout,
        /appRevision=unavailable appTree=unavailable/,
      );
    else
      assert.match(
        result.stdout,
        /appRevision=a{40} appTree=b{40} monitorRevision=d{40}/,
      );
    if (["retention-failed", "job-failed", "unknown"].includes(scenario))
      assert.match(result.stdout, /route=backup-metadata verdict=healthy/);
    if (scenario === "unknown")
      assert.match(result.stdout, /^environment=staging verdict=unknown/);
    if (scenario === "trace")
      assert.match(result.stdout, /trace=0HN7JCQJ7PQ6J:00000001/);
    if (scenario === "header-trace") assert.match(result.stdout, /trace=c{32}/);
    if (["invalid-trace", "overlong-trace", "app-503"].includes(scenario))
      assert.match(
        result.stdout,
        /route=\/health\/ready .*trace=unavailable run=https:\/\/github.com/,
      );
    const output = result.stdout + result.stderr;
    for (const secret of [
      "PRIVATE_HABIT_SENTINEL",
      "SECRET_TOKEN_SENTINEL",
      "SECRET_QUERY_SENTINEL",
      "metadata.example.test",
      "untrusted.invalid",
      "private-path",
      "::error::injected",
    ])
      assert.ok(!output.includes(secret), secret);
    for (const line of result.stdout.trim().split("\n"))
      assert.ok(line.length < 600);
    if (exit === 1) {
      assert.match(
        result.stderr,
        /^::error title=Staging operational monitor::environment=staging verdict=/,
      );
      assert.match(result.stderr, /appRevision=(?:a{40}|unavailable)/);
      assert.ok(
        result.stderr.includes(
          `route=${routes[component]} verdict=${verdict} reason=${reason}`,
        ),
      );
      assert.ok(result.stderr.includes("status="));
      assert.ok(result.stderr.includes("trace="));
    } else assert.equal(result.stderr, "");
  });
}

function fetchFixture(metadata, count = { metadata: 0 }) {
  return async (input) => {
    const url = new URL(input);
    if (url.origin === target.metadataOrigin) {
      count.metadata++;
      return metadata();
    }
    if (url.pathname === "/release.json")
      return Response.json({
        source: {
          repository: "ShiosOS/Damadama",
          commit: "a".repeat(40),
          tree: "b".repeat(40),
        },
        version: `main-${"a".repeat(12)}`,
      });
    return new Response("Healthy");
  };
}

test("metadata starts before a delayed app probe completes", async () => {
  const delayed = Promise.withResolvers();
  const requests = [];
  const fetcher = fetchFixture(() => {
    requests.push("metadata");
    return Response.json(fixture());
  });
  const pending = observe(target, {
    now,
    fetch: (input, options) => {
      if (new URL(input).pathname === "/health/ready")
        return delayed.promise.then(() => {
          requests.push("readiness-complete");
          return new Response("Healthy");
        });
      return fetcher(input, options);
    },
  });
  try {
    assert.deepEqual(requests, ["metadata"]);
  } finally {
    delayed.resolve();
    await pending;
  }
  const result = await pending;
  assert.equal(result.verdict, "healthy");
  assert.deepEqual(requests, ["metadata", "readiness-complete"]);
  assert.deepEqual(Object.keys(result.checks), [
    "liveness",
    "readiness",
    "identity",
    "job",
    "retention",
    "completion",
  ]);
});

test("disabled production makes no requests and never reports healthy", async () => {
  const result = await observe(
    { environment: "production" },
    { now, fetch: () => assert.fail("disabled request") },
  );
  assert.equal(result.verdict, "disabled");
  assert.ok(
    Object.values(result.checks).every((entry) => entry.verdict === "disabled"),
  );
});

test("missing capability fails without contacting metadata", async () => {
  const result = await observe(
    { ...target, metadataUrl: undefined },
    { now, fetch: fetchFixture(() => assert.fail("metadata requested")) },
  );
  assert.equal(result.checks.completion.verdict, "missing");
  assert.equal(result.checks.job.verdict, "unknown");
});

for (const [name, config] of [
  ["HTTP", { metadataUrl: "http://metadata.example.test/fixed/latest.json" }],
  [
    "userinfo",
    { metadataUrl: "https://secret@metadata.example.test/fixed/latest.json" },
  ],
  ["fragment", { metadataUrl: `${target.metadataUrl}#secret` }],
  [
    "unapproved origin",
    { metadataUrl: "https://other.example.test/latest.json" },
  ],
  [
    "invalid approval",
    {
      metadataOrigin:
        "https://metadata.example.test/path?secret=SECRET_QUERY_SENTINEL",
    },
  ],
  ["missing approval", { metadataOrigin: undefined }],
]) {
  test(`rejects ${name} before a metadata request`, async () => {
    const calls = [];
    const fetcher = fetchFixture(() => assert.fail("metadata requested"));
    const result = await observe(
      { ...target, ...config },
      {
        now,
        fetch: (input, options) => {
          calls.push(String(input));
          return fetcher(input, options);
        },
      },
    );
    assert.equal(result.checks.completion.verdict, "invalid");
    assert.equal(calls.length, 3);
  });
}

test("network failures and 503 have at most one retry", async () => {
  for (const metadata of [
    () => {
      throw new Error("SECRET_TOKEN_SENTINEL");
    },
    () => new Response("SECRET_TOKEN_SENTINEL", { status: 503 }),
  ]) {
    const count = { metadata: 0 };
    const result = await observe(target, {
      now,
      fetch: fetchFixture(metadata, count),
    });
    assert.equal(count.metadata, 2);
    assert.equal(result.checks.completion.verdict, "unavailable");
  }
});

test("a 403 or redirect never retries or follows Location", async () => {
  for (const status of [403, 302]) {
    const count = { metadata: 0 };
    await observe(target, {
      now,
      fetch: fetchFixture(
        () =>
          new Response("", {
            status,
            headers: { Location: "https://untrusted.invalid" },
          }),
        count,
      ),
    });
    assert.equal(count.metadata, 1);
  }
});

test("known HTTP failures survive a stalled optional trace body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [status, verdict, reason] of [
    [401, "refused", "http-refused"],
    [403, "refused", "http-refused"],
    [404, "missing", "http-missing"],
    [418, "unavailable", "http-failure"],
  ]) {
    const reading = Promise.withResolvers();
    let attempts = 0;
    let aborted = false;
    const fetcher = fetchFixture(() => Response.json(fixture()));
    const pending = observe(target, {
      now,
      fetch: (input, options) => {
        if (new URL(input).pathname === "/health/ready") {
          attempts++;
          if (attempts > 1) return new Response("", { status });
          options.signal.addEventListener("abort", () => {
            aborted = true;
          });
          return new Response(
            new ReadableStream(
              { pull: () => reading.resolve() },
              { highWaterMark: 0 },
            ),
            { status },
          );
        }
        return fetcher(input, options);
      },
    });
    await reading.promise;
    t.mock.timers.tick(10_000);
    const result = await pending;
    assert.equal(attempts, 1);
    assert.equal(aborted, true);
    assert.deepEqual(result.checks.readiness, {
      verdict,
      reason,
      status,
      traceId: "unavailable",
    });
  }
});

test(
  "the ten second deadline includes the streamed body",
  { timeout: 15_000 },
  async () => {
    let attempts = 0;
    let aborted = false;
    const fetcher = fetchFixture(() => Response.json(fixture()));
    const result = await observe(target, {
      now,
      fetch: (input, options) => {
        if (
          new URL(input).origin === target.metadataOrigin &&
          ++attempts === 1
        ) {
          options.signal.addEventListener("abort", () => {
            aborted = true;
          });
          return Promise.resolve(
            new Response(new ReadableStream({ start() {} })),
          );
        }
        return fetcher(input, options);
      },
    });
    assert.equal(aborted, true);
    assert.equal(attempts, 2);
    assert.equal(result.verdict, "healthy");
  },
);

test("untrusted revision and run context cannot inject output", async () => {
  const result = await observe(
    {
      ...target,
      monitorRevision: `${"a".repeat(40)}\n::error::injected`,
      runReference: `${target.runReference}\n::error::injected`,
    },
    { now, fetch: fetchFixture(() => Response.json(fixture())) },
  );
  const output = formatObservation(result);
  assert.match(output, /monitorRevision=unavailable run=unavailable/);
  assert.ok(!output.includes("::error"));
});
