import assert from "node:assert/strict";
import { test } from "node:test";
import { publicChecks } from "./smoke.mjs";

function staging(t, overrides = []) {
  const record = {
    deployment: { url: "https://staging.example.com" },
    source: {
      repository: "ShiosOS/Damadama",
      commit: "1".repeat(40),
      tree: "2".repeat(40),
    },
    image: { version: "main-111111111111" },
  };
  const routes = new Map([
    ["https://staging.example.com/health/live", { status: 200 }],
    ["https://staging.example.com/health/ready", { status: 200 }],
    ["https://staging.example.com/api/habits", { status: 401 }],
    [
      "https://staging.example.com/api/config",
      { status: 200, body: { clerkPublishableKey: "pk_live_staging" } },
    ],
    [
      "https://staging.example.com/release.json",
      {
        status: 200,
        body: { source: record.source, version: record.image.version },
      },
    ],
  ]);
  for (const [url, response] of overrides) routes.set(url, response);
  const previousKey = process.env.CLERK_PUBLISHABLE_KEY;
  process.env.CLERK_PUBLISHABLE_KEY = "pk_live_staging";
  t.after(() => {
    if (previousKey === undefined) delete process.env.CLERK_PUBLISHABLE_KEY;
    else process.env.CLERK_PUBLISHABLE_KEY = previousKey;
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const requestUrl = String(url);
    requests.push(requestUrl);
    const route = routes.get(requestUrl);
    if (!route)
      return new Response("<!doctype html><title>Damadama</title>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { record, requests };
}

test("public checks request the exact application routes rather than the SPA fallback", async (t) => {
  const { record, requests } = staging(t);
  assert.deepEqual(await publicChecks(record), {
    readiness: true,
    unauthorized: true,
    runtimeConfig: true,
  });
  assert.deepEqual(requests, [
    "https://staging.example.com/health/live",
    "https://staging.example.com/health/ready",
    "https://staging.example.com/api/habits",
    "https://staging.example.com/api/config",
    "https://staging.example.com/release.json",
  ]);
});

for (const [name, url, response, message] of [
  [
    "unhealthy liveness",
    "https://staging.example.com/health/live",
    { status: 503 },
    /\/health\/live readiness/,
  ],
  [
    "unhealthy readiness",
    "https://staging.example.com/health/ready",
    { status: 503 },
    /\/health\/ready readiness/,
  ],
  [
    "an API that accepts missing authentication",
    "https://staging.example.com/api/habits",
    { status: 200 },
    /API refuses missing authentication/,
  ],
  [
    "another environment's runtime Clerk key",
    "https://staging.example.com/api/config",
    { status: 200, body: { clerkPublishableKey: "pk_live_other" } },
    /runtime Clerk key matches this environment/,
  ],
  [
    "another image's source identity",
    "https://staging.example.com/release.json",
    {
      status: 200,
      body: {
        source: { commit: "3".repeat(40) },
        version: "main-111111111111",
      },
    },
    /running image contains the main source identity/,
  ],
  [
    "another image's version",
    "https://staging.example.com/release.json",
    {
      status: 200,
      body: {
        source: {
          repository: "ShiosOS/Damadama",
          commit: "1".repeat(40),
          tree: "2".repeat(40),
        },
        version: "main-333333333333",
      },
    },
    /running candidate version/,
  ],
]) {
  test(`public checks reject ${name}`, async (t) => {
    const { record, requests } = staging(t, [[url, response]]);
    await assert.rejects(publicChecks(record), message);
    assert.equal(requests.at(-1), url);
  });
}

for (const url of [
  "http://staging.example.com",
  "https://staging.example.com/path",
  "https://staging.example.com/",
]) {
  test(`public checks reject a configured URL that is not an HTTPS origin, ${url}`, async (t) => {
    const { record } = staging(t);
    record.deployment.url = url;
    await assert.rejects(publicChecks(record), /configured HTTPS origin/);
  });
}
