import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ApplicationProof, createdAtDifference } from "./application-proof.mjs";
import { selectSource } from "./proof-source.mjs";

const id = "00000000-0000-0000-0000-000000000002";
const createdAt = "2026-10-18T08:00:00.1234567+00:00";
const input = {
  name: "Synthetic API restore sample",
  good: "one",
  better: "two",
  best: "three",
  weekdays: [1, 7],
  repeatEveryWeeks: 2,
  timeZone: "America/New_York",
};
const row = {
  id,
  name: input.name,
  good: "one",
  better: "two",
  best: "three",
  createdAt,
  schedule: {
    habitId: id,
    weekdays: [1, 7],
    repeatEveryWeeks: 2,
    timeZone: "America/New_York",
    creationDate: "2026-10-18",
    firstWeekMonday: "2026-10-12",
  },
};
const calendarRow =
  "recovery-sample-owner|Restore sample|five|fifteen|thirty|2026-01-01 04:30:00+00|{1,7}|2|America/New_York|2025-12-31|2025-12-29";
const migrationIds = ["20261011071109_InitialHabits"];
const refused = Object.fromEntries(
  [
    "invalidSignature",
    "wrongIssuer",
    "expired",
    "missingSubject",
    "wrongAuthorizedParty",
    "pendingSession",
  ].map((code) => [code, `fixture-${code}`]),
);

async function api(t, mutate = (value) => value, postBody = (value) => value) {
  const posts = [];
  let saved;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health/ready") return response.end("{}");
    if (request.headers.authorization !== "Bearer fixture-owner-token") {
      response.statusCode = 401;
      return response.end("{}");
    }
    if (request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      posts.push(JSON.parse(text));
      saved = structuredClone(row);
      response.statusCode = 201;
      return response.end(JSON.stringify(postBody(saved)));
    }
    if (request.url === `/api/habits/${id}`)
      return response.end(JSON.stringify(mutate(structuredClone(saved))));
    response.end(JSON.stringify(saved ? [saved] : []));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, posts };
}

function application(checks) {
  return new ApplicationProof({
    authority: { token: () => "fixture-owner-token", refused },
    migrationIds,
    sql: (_source, query) => {
      if (query.includes('SELECT "OwnerId"')) return "recovery-api-owner";
      if (query.includes("__EFMigrationsHistory"))
        return migrationIds.join("\n");
      return "Habits|OwnerId|text\nInitialSchedules|FirstWeekMonday|date";
    },
    onCheck: (code, status, difference) =>
      checks.push({ code, status, difference }),
  });
}

test("source HTTP proof preserves exact POST fields and full GET/list equality before capture", async (t) => {
  const { origin, posts } = await api(t);
  const checks = [];
  const proof = await application(checks).captureSource("fixture-db", origin);
  assert.deepEqual(posts, [input]);
  assert.deepEqual(proof.migrationIds, migrationIds);
  assert.equal(proof.scenarios.productionAuthentication.outcome, "passed");
  assert.equal(Object.keys(proof.scenarios).length, 7);
  assert.ok(
    checks.some((check) => check.code === "source-owner-get-post-match"),
  );
  assert.equal(
    checks.some((check) => check.difference),
    false,
  );
});

test("actual HTTP POST/GET precision mismatch fails source consistency and emits only exact timestamp diagnostics", async (t) => {
  const { origin } = await api(t, (value) => ({
    ...value,
    createdAt: "2026-10-18T08:00:00.123456+00:00",
  }));
  const checks = [];
  await assert.rejects(
    application(checks).captureSource("fixture-db", origin),
    /Owner GET matches committed POST response/,
  );
  const last = checks.at(-1);
  assert.deepEqual(last, {
    code: "source-owner-get-post-match",
    status: 200,
    difference: {
      postCreatedAt: createdAt,
      getCreatedAt: "2026-10-18T08:00:00.123456+00:00",
      deltaTicks: "-7",
    },
  });
  assert.equal(
    checks.some((check) => check.code === "source-owner-list-status"),
    false,
  );
  const diagnostics = JSON.stringify(checks);
  for (const privateValue of [
    id,
    input.name,
    "fixture-owner-token",
    "fixture-invalidSignature",
  ])
    assert.equal(diagnostics.includes(privateValue), false);
});

test("POST field preservation refuses altered synthetic values before source GET", async (t) => {
  const canary = "private-post-field-canary";
  const { origin } = await api(
    t,
    (value) => value,
    (value) => ({ ...value, good: canary }),
  );
  const checks = [];
  await assert.rejects(
    application(checks).captureSource("fixture-db", origin),
    /POST preserves every supplied synthetic field/,
  );
  assert.equal(checks.at(-1).code, "source-created-fields");
  assert.equal(
    checks.some((check) => check.code === "source-owner-get-status"),
    false,
  );
  assert.equal(JSON.stringify(checks).includes(canary), false);
});

test("other response mismatches retain fail-closed source comparison without raw body diagnostics", async (t) => {
  const canary = "private-url-token-row-canary";
  const { origin } = await api(t, (value) => ({ ...value, name: canary }));
  const checks = [];
  await assert.rejects(
    application(checks).captureSource("fixture-db", origin),
    /Owner GET matches committed POST response/,
  );
  assert.equal(checks.at(-1).code, "source-owner-get-post-match");
  assert.equal(checks.at(-1).difference, null);
  assert.equal(JSON.stringify(checks).includes(canary), false);
});

test("timestamp diagnostic keeps 100ns precision and refuses non-date payloads", () => {
  assert.equal(createdAtDifference(createdAt, createdAt), null);
  assert.deepEqual(
    createdAtDifference("2026-10-18T08:00:00.1234567Z", createdAt),
    {
      postCreatedAt: "2026-10-18T08:00:00.1234567Z",
      getCreatedAt: createdAt,
      deltaTicks: "0",
    },
  );
  assert.equal(
    createdAtDifference("2026-10-18T07:59:59.9999999Z", "2026-10-18T08:00:00Z")
      .deltaTicks,
    "1",
  );
  for (const invalid of [
    null,
    {},
    "private-token-canary",
    "2026-02-30T08:00:00Z",
    "2026-10-18T08:00:00.12345678Z",
    "2026-10-18T08:00:00-04:00",
  ])
    assert.equal(createdAtDifference(invalid, createdAt), null);
});

test("fixture selection returns a substantive row verifier and never starts an image", async () => {
  const queries = [];
  const receipt = {};
  const prepare = await selectSource([], {
    receipt,
    sql: (database, query) => {
      queries.push(query);
      if (query.startsWith("SET TIME"))
        return database === "damaged" ? "different" : calendarRow;
    },
    run: () => assert.fail("fixture proof cannot start an image"),
  });
  const prepared = await prepare("source");
  assert.ok(queries.some((query) => query.startsWith("CREATE TABLE")));
  await assert.rejects(prepared.verifyTarget("damaged"), /restored ownership/);
  await prepared.verifyTarget("target");
  assert.equal(
    prepared.evidence.scenarios.fixtureSavedRowsRestored.outcome,
    "passed",
  );
});

test("optional image selection starts, restarts and verifies restored rows plus anonymous refusal", async (t) => {
  const { origin } = await api(t);
  const calls = [];
  const prepare = await selectSource(["sha256:fixture-image"], {
    receipt: {},
    run: (...args) => {
      calls.push(["run", ...args]);
      return "fixture-container";
    },
    docker: (...args) => {
      calls.push(args);
      return `127.0.0.1:${new URL(origin).port}`;
    },
    wait: async (ready) => assert.equal(await ready(), true),
    sql: (database, query) => {
      assert.equal(query.startsWith("CREATE TABLE"), false);
      if (query.startsWith("SET TIME"))
        return database === "damaged" ? "different" : calendarRow;
    },
    onCheck: (code, status) => calls.push(["check", code, status]),
  });
  const prepared = await prepare("source", "fixture-password");
  assert.equal(calls.filter(([command]) => command === "restart").length, 1);
  await assert.rejects(
    prepared.verifyTarget("damaged", "fixture-target-password"),
    /restored ownership/,
  );
  await prepared.verifyTarget("target", "fixture-target-password");
  assert.equal(
    prepared.evidence.scenarios.optionalImageReadinessAndAnonymousRefusal
      .outcome,
    "passed",
  );
  assert.equal(calls.filter(([command]) => command === "run").length, 2);
  assert.ok(
    calls.some(
      (call) => call.includes("target-anonymous-refusal") && call.includes(401),
    ),
  );
});
