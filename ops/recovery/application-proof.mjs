import assert from "node:assert/strict";
import { sha256 } from "./current-image.mjs";

async function request(onCheck, code, origin, path, token, options = {}) {
  onCheck(code);
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  onCheck(code, response.status);
  const text = await response.text();
  let body = null;
  if (text) body = JSON.parse(text);
  return { status: response.status, body };
}

function utcTicks(value) {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?(?:Z|\+00:00)$/.exec(
      value,
    );
  if (!match) return null;
  const milliseconds = Date.parse(`${match[1]}Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== match[1]
  )
    return null;
  return (
    BigInt(milliseconds) * 10_000n + BigInt((match[2] ?? "").padEnd(7, "0"))
  );
}

export function createdAtDifference(postCreatedAt, getCreatedAt) {
  if (postCreatedAt === getCreatedAt) return null;
  const post = utcTicks(postCreatedAt);
  const get = utcTicks(getCreatedAt);
  if (post === null || get === null) return null;
  return { postCreatedAt, getCreatedAt, deltaTicks: (get - post).toString() };
}

const historyQuery =
  'SELECT "MigrationId" FROM "__EFMigrationsHistory" ORDER BY "MigrationId";';
const schemaQuery = `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position;
SELECT c.relname, x.conname, pg_get_constraintdef(x.oid) FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,x.conname;
SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname;`;

export class ApplicationProof {
  #source;

  constructor({ authority, sql, migrationIds, onCheck }) {
    this.authority = authority;
    this.sql = sql;
    this.expectedMigrationIds = [...migrationIds];
    this.onCheck = onCheck;
  }

  migrationHistory(id, code) {
    this.onCheck(code);
    const ids = this.sql(id, historyQuery).split("\n");
    assert.deepEqual(
      ids,
      this.expectedMigrationIds,
      "Real database history must equal committed migrations",
    );
    return ids;
  }

  async captureSource(source, origin) {
    const assertions = {};
    const scenarios = {};
    const authenticationStarted = Date.now();
    assert.equal(
      (
        await request(
          this.onCheck,
          "source-valid-authentication",
          origin,
          "/api/habits",
          this.authority.token(),
        )
      ).status,
      200,
    );
    for (const code of [
      "invalidSignature",
      "wrongIssuer",
      "expired",
      "missingSubject",
      "wrongAuthorizedParty",
      "pendingSession",
    ]) {
      const checkStarted = Date.now();
      assert.equal(
        (
          await request(
            this.onCheck,
            `source-refused-${code}`,
            origin,
            "/api/habits",
            this.authority.refused[code],
          )
        ).status,
        401,
        code,
      );
      scenarios[code] = {
        outcome: "passed",
        durationSeconds: (Date.now() - checkStarted) / 1000,
      };
    }
    const created = await request(
      this.onCheck,
      "source-create-status",
      origin,
      "/api/habits",
      this.authority.token(),
      {
        method: "POST",
        body: JSON.stringify({
          name: "Synthetic API restore sample",
          good: "one",
          better: "two",
          best: "three",
          weekdays: [1, 7],
          repeatEveryWeeks: 2,
          timeZone: "America/New_York",
        }),
      },
    );
    assert.equal(created.status, 201);
    this.onCheck("source-created-id");
    assert.match(created.body.id, /^[a-f0-9-]{36}$/);
    this.onCheck("source-created-fields");
    assert.deepEqual(
      {
        name: created.body.name,
        good: created.body.good,
        better: created.body.better,
        best: created.body.best,
        weekdays: created.body.schedule.weekdays,
        repeatEveryWeeks: created.body.schedule.repeatEveryWeeks,
        timeZone: created.body.schedule.timeZone,
        habitId: created.body.schedule.habitId,
      },
      {
        name: "Synthetic API restore sample",
        good: "one",
        better: "two",
        best: "three",
        weekdays: [1, 7],
        repeatEveryWeeks: 2,
        timeZone: "America/New_York",
        habitId: created.body.id,
      },
      "POST preserves every supplied synthetic field and its schedule association",
    );
    const ownerResponse = await request(
      this.onCheck,
      "source-owner-get-status",
      origin,
      `/api/habits/${created.body.id}`,
      this.authority.token(),
    );
    const ownerResponseHash = sha256(JSON.stringify(ownerResponse));
    const expectedResponseHash = sha256(
      JSON.stringify({ status: 200, body: created.body }),
    );
    this.onCheck(
      "source-owner-get-post-match",
      ownerResponse.status,
      ownerResponseHash === expectedResponseHash
        ? null
        : createdAtDifference(
            created.body.createdAt,
            ownerResponse.body?.createdAt,
          ),
    );
    assert.equal(
      ownerResponseHash,
      expectedResponseHash,
      "Owner GET matches committed POST response",
    );
    const ownerList = await request(
      this.onCheck,
      "source-owner-list-status",
      origin,
      "/api/habits",
      this.authority.token(),
    );
    this.onCheck("source-owner-list-post-match", ownerList.status);
    assert.equal(
      sha256(JSON.stringify(ownerList)),
      sha256(JSON.stringify({ status: 200, body: [created.body] })),
      "Owner list contains the committed synthetic record",
    );
    this.onCheck("source-persisted-owner");
    const storedOwner = this.sql(
      source,
      `SELECT "OwnerId" FROM "Habits" WHERE "Id"='${created.body.id}';`,
    );
    assert.equal(storedOwner, "recovery-api-owner");
    const migrationIds = this.migrationHistory(
      source,
      "source-migration-history",
    );
    this.onCheck("source-schema-read");
    const sourceSchema = this.sql(source, schemaQuery);
    this.onCheck("source-schema-owner-column");
    assert.match(sourceSchema, /Habits\|OwnerId\|text/);
    this.onCheck("source-schema-calendar-column");
    assert.match(sourceSchema, /InitialSchedules\|FirstWeekMonday\|date/);
    assertions.schemaSha256 = sha256(sourceSchema);
    assertions.ownerResponseSha256 = sha256(JSON.stringify(ownerResponse));
    scenarios.productionAuthentication = {
      outcome: "passed",
      durationSeconds: (Date.now() - authenticationStarted) / 1000,
    };
    this.#source = { schema: sourceSchema, ownerResponse, ownerList };
    return { migrationIds, assertions, scenarios };
  }

  assertRestoredSchema(target) {
    const ids = this.migrationHistory(
      target,
      "target-pre-start-migration-history",
    );
    this.onCheck("target-pre-start-schema");
    assert.equal(
      sha256(this.sql(target, schemaQuery)),
      sha256(this.#source.schema),
      "Real schema, constraints and indexes restore before app startup",
    );
    return ids;
  }

  async verifyRestored(target, origin) {
    const ids = this.migrationHistory(
      target,
      "target-post-start-migration-history",
    );
    this.onCheck("target-post-start-schema");
    assert.equal(
      sha256(this.sql(target, schemaQuery)),
      sha256(this.#source.schema),
      "Startup must not repair the restored schema",
    );
    assert.equal(
      sha256(
        JSON.stringify(
          await request(
            this.onCheck,
            "target-owner-get-match",
            origin,
            `/api/habits/${this.#source.ownerResponse.body.id}`,
            this.authority.token(),
          ),
        ),
      ),
      sha256(JSON.stringify(this.#source.ownerResponse)),
      "Restored owner GET equals full source response",
    );
    assert.equal(
      sha256(
        JSON.stringify(
          await request(
            this.onCheck,
            "target-owner-list-match",
            origin,
            "/api/habits",
            this.authority.token(),
          ),
        ),
      ),
      sha256(JSON.stringify(this.#source.ownerList)),
      "Restored owner collection equals full source response",
    );
    const outsider = this.authority.token({ sub: "recovery-outsider" });
    assert.equal(
      (
        await request(
          this.onCheck,
          "target-outsider-record-refusal",
          origin,
          `/api/habits/${this.#source.ownerResponse.body.id}`,
          outsider,
        )
      ).status,
      404,
    );
    const outsiderList = await request(
      this.onCheck,
      "target-outsider-list-status",
      origin,
      "/api/habits",
      outsider,
    );
    assert.equal(outsiderList.status, 200);
    this.onCheck("target-outsider-list-empty");
    assert.deepEqual(outsiderList.body, []);
    assert.equal(
      (
        await request(
          this.onCheck,
          "target-anonymous-api-refusal",
          origin,
          "/api/habits",
        )
      ).status,
      401,
    );

    return ids;
  }
}
