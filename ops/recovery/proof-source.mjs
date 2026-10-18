import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  checkoutIdentity,
  migrationIdentity,
  requireImageIdentity,
  sha256,
  verifyImage,
} from "./current-image.mjs";
import {
  authorizedParty,
  authorityImage,
  issuer,
  syntheticAuthority,
} from "./synthetic-authority.mjs";
import { ApplicationProof } from "./application-proof.mjs";
import { ApplicationRuntime } from "./application-runtime.mjs";

const savedRowsQuery = `SET TIME ZONE 'UTC'; SELECT h."OwnerId", h."Name", h."Good", h."Better", h."Best", h."CreatedAt", s."Weekdays", s."RepeatEveryWeeks", s."TimeZone", s."CreationDate", s."FirstWeekMonday" FROM "Habits" h JOIN "InitialSchedules" s ON h."Id"=s."HabitId" ORDER BY h."Id";`;

function seedCalendarSample(source, sql) {
  sql(
    source,
    `INSERT INTO "Habits" ("Id","OwnerId","Name","Good","Better","Best","CreatedAt") VALUES ('00000000-0000-0000-0000-000000000001','recovery-sample-owner','Restore sample','five','fifteen','thirty','2026-01-01T04:30:00Z'); INSERT INTO "InitialSchedules" ("HabitId","Weekdays","RepeatEveryWeeks","TimeZone","CreationDate","FirstWeekMonday") VALUES ('00000000-0000-0000-0000-000000000001',ARRAY[1,7],2,'America/New_York','2025-12-31','2025-12-29');`,
  );
}

function savedRows(source, sql) {
  const expected = sql(source, savedRowsQuery);
  assert.match(
    expected,
    /recovery-sample-owner\|Restore sample\|five\|fifteen\|thirty/,
  );
  assert.match(expected, /2025-12-31\|2025-12-29/);
  assert.ok(
    expected.includes(
      "recovery-sample-owner|Restore sample|five|fifteen|thirty|2026-01-01 04:30:00+00|{1,7}|2|America/New_York|2025-12-31|2025-12-29",
    ),
    "Literal ownership, text, UTC, ISO weekdays, timezone, device date and Monday anchor are preserved",
  );
  return expected;
}

function verifySavedRows(target, expected, sql) {
  assert.equal(
    sha256(sql(target, savedRowsQuery)),
    sha256(expected),
    "restored ownership, text, UTC instant and calendar dates match independently read source rows",
  );
}

async function restartWithSavedRows(runtime, running, source, expected, sql) {
  await runtime.restart(running);
  assert.equal(
    sha256(sql(source, savedRowsQuery)),
    sha256(expected),
    "persistent database content survives app restart",
  );
}

function evidence(expected) {
  return {
    migrations: {},
    assertions: { savedRowsSha256: sha256(expected) },
    scenarios: {},
  };
}

async function prepareFixture(source, { sql }) {
  sql(
    source,
    'CREATE TABLE "Habits" ("Id" uuid PRIMARY KEY, "OwnerId" text, "Name" text, "Good" text, "Better" text, "Best" text, "CreatedAt" timestamptz); CREATE TABLE "InitialSchedules" ("HabitId" uuid PRIMARY KEY, "Weekdays" integer[], "RepeatEveryWeeks" integer, "TimeZone" text, "CreationDate" date, "FirstWeekMonday" date);',
  );
  seedCalendarSample(source, sql);
  const expected = savedRows(source, sql);
  const sourceEvidence = evidence(expected);
  return {
    evidence: sourceEvidence,
    async verifyTarget(target) {
      verifySavedRows(target, expected, sql);
      sourceEvidence.scenarios.fixtureSavedRowsRestored = { outcome: "passed" };
    },
  };
}

async function prepareAnonymousImage(source, password, image, operations) {
  const runtime = new ApplicationRuntime({
    ...operations,
    image,
    configuration: ["-e", "Clerk__Issuer=https://invalid.example"],
  });
  const running = await runtime.start("source-db", password, "source");
  seedCalendarSample(source, operations.sql);
  const expected = savedRows(source, operations.sql);
  await restartWithSavedRows(
    runtime,
    running,
    source,
    expected,
    operations.sql,
  );
  const sourceEvidence = evidence(expected);
  return {
    evidence: sourceEvidence,
    async verifyTarget(target, targetPassword) {
      verifySavedRows(target, expected, operations.sql);
      await runtime.start("target-db", targetPassword, "target");
      sourceEvidence.scenarios.optionalImageReadinessAndAnonymousRefusal = {
        outcome: "passed",
      };
    },
  };
}

async function prepareRequiredImage(source, password, identity, operations) {
  const { directory, run, wait, sql, onCheck } = operations;
  onCheck("source-issuer-creation");
  const authorityDirectory = resolve(directory, "authority");
  await mkdir(authorityDirectory);
  const authority = await syntheticAuthority(
    authorityDirectory,
    (command, args) =>
      execFileSync(command, args, {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
  );
  const issuerContainer = run(
    "--network-alias",
    "proof-issuer",
    "--mount",
    `type=bind,source=${authorityDirectory},target=/authority,readonly`,
    "-e",
    "NODE_EXTRA_CA_CERTS=/authority/ca.pem",
    authorityImage,
    "node",
    "/authority/issuer.mjs",
  );
  onCheck("source-issuer-discovery");
  await wait(
    () =>
      spawnSync(
        "docker",
        [
          "exec",
          issuerContainer,
          "node",
          "-e",
          "fetch('https://proof-issuer:8443/.well-known/openid-configuration', { signal: AbortSignal.timeout(1000) }).then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))",
        ],
        { timeout: 5000 },
      ).status === 0,
    "synthetic HTTPS discovery",
  );
  const runtime = new ApplicationRuntime({
    ...operations,
    image: identity.image.configId,
    configuration: [
      "--mount",
      `type=bind,source=${authority.ca},target=/proof-ca.pem,readonly`,
      "-e",
      "SSL_CERT_FILE=/proof-ca.pem",
      "-e",
      `Clerk__AuthorizedParties__0=${authorizedParty}`,
      "-e",
      `Clerk__Issuer=${issuer}`,
    ],
  });
  const application = new ApplicationProof({
    authority,
    sql,
    migrationIds: identity.migrations.ids,
    onCheck,
  });
  const running = await runtime.start("source-db", password, "source");
  seedCalendarSample(source, sql);
  const proof = await application.captureSource(source, running.origin);
  const expected = savedRows(source, sql);
  await restartWithSavedRows(runtime, running, source, expected, sql);
  const sourceEvidence = evidence(expected);
  sourceEvidence.migrations.beforeBackup = application.migrationHistory(
    source,
    "source-migration-history-after-restart",
  );
  Object.assign(sourceEvidence.assertions, proof.assertions);
  Object.assign(sourceEvidence.scenarios, proof.scenarios);
  return {
    evidence: sourceEvidence,
    async verifyTarget(target, targetPassword) {
      verifySavedRows(target, expected, sql);
      onCheck("pre-start-schema-data");
      sourceEvidence.migrations.preStart =
        application.assertRestoredSchema(target);
      sourceEvidence.scenarios.schemaAndSavedRowsBeforeStartup = {
        outcome: "passed",
      };
      const restoredApp = await runtime.start(
        "target-db",
        targetPassword,
        "target",
      );
      onCheck("post-restore-saved-rows");
      assert.equal(
        sha256(sql(target, savedRowsQuery)),
        sha256(expected),
        "Startup must not change saved rows",
      );
      sourceEvidence.migrations.postStart = await application.verifyRestored(
        target,
        restoredApp.origin,
      );
      sourceEvidence.scenarios.restoredApiOwnershipAndReadiness = {
        outcome: "passed",
      };
    },
  };
}

export async function selectSource(args, { receipt, ...operations }) {
  if (args[0] === "--require-app") {
    receipt.mode = "required-current-image";
    assert.equal(
      args.length,
      2,
      "Required application mode needs one identity file",
    );
    const current = checkoutIdentity({ requireClean: true });
    receipt.controller = current;
    const identity = requireImageIdentity(
      JSON.parse(await readFile(args[1], "utf8")),
      current,
      migrationIdentity(current.commit),
    );
    receipt.image = identity;
    await verifyImage(identity, resolve(args[1]), operations.directory);
    receipt.authentication =
      "Production-JWT-middleware-with-ephemeral-synthetic-HTTPS-issuer";
    return (source, password) =>
      prepareRequiredImage(source, password, identity, operations);
  }
  assert.ok(
    args.length <= 1 && !args[0]?.startsWith("--"),
    "Invalid proof arguments",
  );
  receipt.mode = "legacy-optional-image";
  receipt.authentication = "anonymous-refusal-only-if-optional-image-provided";
  if (args.length === 1)
    return (source, password) =>
      prepareAnonymousImage(source, password, args[0], operations);
  return (source) => prepareFixture(source, operations);
}
