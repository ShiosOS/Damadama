import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const app = process.argv[2];
const postgres =
  "postgres:17-bookworm@sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df";
const storage =
  "motoserver/moto@sha256:66672d842bf19618966890c574d85198abe92800f4b3b2b5f791015fa1b58831";
const task = randomUUID();
const directory = resolve(".audit", `recovery-proof-${task}`);
await mkdir(directory, { recursive: true });
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 180_000 }).trim();
const containers = [];
const network = docker("network", "create", `damadama-proof-${task}`);
const password = randomUUID();
const run = (...args) => {
  const id = docker("run", "-d", "--network", network, ...args);
  containers.push(id);
  return id;
};
const sql = (id, query) =>
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      id,
      "psql",
      "-X",
      "-A",
      "-t",
      "-U",
      "postgres",
      "-d",
      "habits",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: query, encoding: "utf8" },
  ).trim();
async function wait(ready, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await setTimeout(1000);
  }
  throw new Error(`${label} did not become ready`);
}
async function startApp(host) {
  const id = run(
    "-p",
    "127.0.0.1::8080",
    "-e",
    `ConnectionStrings__habits=Host=${host};Database=habits;Username=postgres;Password=${password}`,
    "-e",
    "Clerk__Issuer=https://invalid.example",
    app,
  );
  const port = docker("port", id, "8080/tcp").match(/:(\d+)$/)?.[1];
  const origin = `http://127.0.0.1:${port}`;
  await wait(async () => {
    try {
      return (await fetch(`${origin}/health/ready`)).status === 200;
    } catch {
      return false;
    }
  }, "production image readiness");
  assert.equal((await fetch(`${origin}/api/habits`)).status, 401);
  return { id, origin };
}

function appOrigin(id) {
  const port = docker("port", id, "8080/tcp").match(/:(\d+)$/)?.[1];
  return `http://127.0.0.1:${port}`;
}

try {
  const source = run(
    "--network-alias",
    "source-db",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=habits",
    postgres,
  );
  const target = run(
    "--network-alias",
    "target-db",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=habits",
    postgres,
  );
  for (const id of [source, target])
    await wait(
      () =>
        spawnSync("docker", ["exec", id, "pg_isready", "-U", "postgres"])
          .status === 0,
      "isolated PostgreSQL",
    );
  let running;
  if (app) running = await startApp("source-db");
  else
    sql(
      source,
      'CREATE TABLE "Habits" ("Id" uuid PRIMARY KEY, "OwnerId" text, "Name" text, "Good" text, "Better" text, "Best" text, "CreatedAt" timestamptz); CREATE TABLE "InitialSchedules" ("HabitId" uuid PRIMARY KEY, "Weekdays" integer[], "RepeatEveryWeeks" integer, "TimeZone" text, "CreationDate" date, "FirstWeekMonday" date);',
    );
  sql(
    source,
    `INSERT INTO "Habits" VALUES ('00000000-0000-0000-0000-000000000001','recovery-sample-owner','Restore sample','five','fifteen','thirty','2026-01-01T04:30:00Z'); INSERT INTO "InitialSchedules" VALUES ('00000000-0000-0000-0000-000000000001',ARRAY[1,7],2,'America/New_York','2025-12-31','2025-12-29');`,
  );
  const query = `SET TIME ZONE 'UTC'; SELECT h."OwnerId", h."Name", h."Good", h."Better", h."Best", h."CreatedAt", s."Weekdays", s."RepeatEveryWeeks", s."TimeZone", s."CreationDate", s."FirstWeekMonday" FROM "Habits" h JOIN "InitialSchedules" s ON h."Id"=s."HabitId" ORDER BY h."Id";`;
  const expected = sql(source, query);
  assert.match(
    expected,
    /recovery-sample-owner\|Restore sample\|five\|fifteen\|thirty/,
  );
  assert.match(expected, /2025-12-31\|2025-12-29/);
  if (running) {
    docker("restart", running.id);
    const previousOrigin = running.origin;
    running.origin = appOrigin(running.id);
    console.log(`Docker restart origin ${previousOrigin} -> ${running.origin}`);
    await wait(async () => {
      try {
        return (await fetch(`${running.origin}/health/ready`)).status === 200;
      } catch {
        return false;
      }
    }, "restart readiness");
    assert.equal(
      sql(source, query),
      expected,
      "persistent database content survives app restart",
    );
  }
  run("--network-alias", "object-store", storage);
  const helper = run(
    "--entrypoint",
    "sh",
    "--mount",
    `type=bind,source=${directory},target=/proof`,
    "-e",
    "AWS_ACCESS_KEY_ID=local-test-key",
    "-e",
    "AWS_SECRET_ACCESS_KEY=local-test-secret",
    "-e",
    "AWS_DEFAULT_REGION=us-east-1",
    "-e",
    `PGPASSWORD=${password}`,
    "-e",
    "PGUSER=postgres",
    "-e",
    "PGDATABASE=habits",
    "damadama-recovery-proof",
    "-c",
    "sleep 900",
  );
  const execute = (...args) => docker("exec", helper, ...args);
  await wait(
    () =>
      spawnSync("docker", [
        "exec",
        helper,
        "aws",
        "--endpoint-url",
        "http://object-store:5000",
        "s3api",
        "list-buckets",
      ]).status === 0,
    "local S3 simulator",
  );
  execute(
    "aws",
    "--endpoint-url",
    "http://object-store:5000",
    "s3api",
    "create-bucket",
    "--bucket",
    "damadama-proof-backups",
  );
  execute("age-keygen", "-o", "/proof/identity");
  const recipient = execute("age-keygen", "-y", "/proof/identity");
  const backup = JSON.parse(
    execute(
      "env",
      "PGHOST=source-db",
      "BACKUP_ENVIRONMENT=staging",
      "S3_BUCKET=damadama-proof-backups",
      "AWS_ENDPOINT_URL=http://object-store:5000",
      `AGE_RECIPIENT=${recipient}`,
      "sh",
      "/opt/recovery/backup.sh",
    ),
  );
  assert.equal(backup.retentionDays, 7);
  await mkdir(resolve(directory, "failure-bin"), { recursive: true });
  await writeFile(
    resolve(directory, "failure-bin/aws"),
    '#!/bin/sh\nfor arg; do case "$arg" in *.sha256) exit 42 ;; esac; done\nexec /usr/bin/aws "$@"\n',
  );
  execute("chmod", "+x", "/proof/failure-bin/aws");
  const partial = spawnSync(
    "docker",
    [
      "exec",
      helper,
      "env",
      "PATH=/proof/failure-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "PGHOST=source-db",
      "BACKUP_ENVIRONMENT=staging",
      "S3_BUCKET=damadama-proof-backups",
      "AWS_ENDPOINT_URL=http://object-store:5000",
      `AGE_RECIPIENT=${recipient}`,
      "sh",
      "/opt/recovery/backup.sh",
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    partial.status,
    42,
    "checksum upload failure fails the backup job",
  );
  assert.equal(
    partial.stdout.includes("completedAt"),
    false,
    "partial upload cannot announce success",
  );
  const objectsAfterFailure = JSON.parse(
    execute(
      "aws",
      "--endpoint-url",
      "http://object-store:5000",
      "s3api",
      "list-objects-v2",
      "--bucket",
      "damadama-proof-backups",
    ),
  ).Contents;
  assert.equal(
    objectsAfterFailure.filter((item) => item.Key.endsWith(".json")).length,
    1,
    "partial upload leaves no completion manifest",
  );
  const retry = JSON.parse(
    execute(
      "env",
      "PGHOST=source-db",
      "BACKUP_ENVIRONMENT=staging",
      "S3_BUCKET=damadama-proof-backups",
      "AWS_ENDPOINT_URL=http://object-store:5000",
      `AGE_RECIPIENT=${recipient}`,
      "sh",
      "/opt/recovery/backup.sh",
    ),
  );
  assert.notEqual(
    retry.backup,
    backup.backup,
    "retry cannot overwrite completed backup",
  );
  const restoreStart = Date.now();
  execute(
    "aws",
    "--endpoint-url",
    "http://object-store:5000",
    "s3",
    "cp",
    `s3://damadama-proof-backups/${backup.backup}`,
    "/proof/backup.age",
  );
  execute(
    "aws",
    "--endpoint-url",
    "http://object-store:5000",
    "s3",
    "cp",
    `s3://damadama-proof-backups/${backup.backup}.sha256`,
    "/proof/backup.sha256",
  );
  const restore = JSON.parse(
    execute(
      "env",
      "PGHOST=target-db",
      "RESTORE_TARGET_ACK=isolated-empty-target",
      "AGE_IDENTITY_FILE=/proof/identity",
      "sh",
      "/opt/recovery/restore.sh",
      "/proof/backup.age",
      "/proof/backup.sha256",
    ),
  );
  assert.equal(
    sql(target, query),
    expected,
    "restored ownership, text, UTC instant and calendar dates match independently read source rows",
  );
  if (app) await startApp("target-db");
  const restoreSeconds = (Date.now() - restoreStart) / 1000;
  assert.ok(
    restoreSeconds < 3600,
    "local measured restore meets one-hour target",
  );
  const nonempty = spawnSync(
    "docker",
    [
      "exec",
      helper,
      "env",
      "PGHOST=target-db",
      "RESTORE_TARGET_ACK=isolated-empty-target",
      "AGE_IDENTITY_FILE=/proof/identity",
      "sh",
      "/opt/recovery/restore.sh",
      "/proof/backup.age",
      "/proof/backup.sha256",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(nonempty.status, 0);
  assert.match(nonempty.stderr, /empty isolated database/);
  sql(target, "CREATE DATABASE viewonly;");
  docker(
    "exec",
    target,
    "psql",
    "-U",
    "postgres",
    "-d",
    "viewonly",
    "-c",
    "CREATE VIEW sample AS SELECT 1 AS n;",
  );
  const viewonly = spawnSync(
    "docker",
    [
      "exec",
      helper,
      "env",
      "PGHOST=target-db",
      "PGDATABASE=viewonly",
      "RESTORE_TARGET_ACK=isolated-empty-target",
      "AGE_IDENTITY_FILE=/proof/identity",
      "sh",
      "/opt/recovery/restore.sh",
      "/proof/backup.age",
      "/proof/backup.sha256",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(viewonly.status, 0);
  assert.match(viewonly.stderr, /empty isolated database/);
  execute("sh", "-c", "printf invalid > /proof/bad.sha256");
  const corrupt = spawnSync(
    "docker",
    [
      "exec",
      helper,
      "env",
      "PGHOST=target-db",
      "RESTORE_TARGET_ACK=isolated-empty-target",
      "AGE_IDENTITY_FILE=/proof/identity",
      "sh",
      "/opt/recovery/restore.sh",
      "/proof/backup.age",
      "/proof/bad.sha256",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /checksum mismatch/);
  const result = {
    appImage: app ?? null,
    storage: "isolated Moto S3 simulator, not Railway storage",
    backup,
    restore,
    restoreIncludingDownloadAndAppReadinessSeconds: restoreSeconds,
    storedDates: ["2025-12-31", "2025-12-29"],
    nonemptyRefused: true,
    viewOnlyTargetRefused: true,
    corruptRefused: true,
    partialUploadCannotAnnounceSuccess: true,
    retryPreservedCompletedBackup: true,
    authentication:
      "No actual Clerk or email verification; production image has no fixture issuer or signing keys",
  };
  await writeFile(
    resolve(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const id of containers.reverse()) spawnSync("docker", ["rm", "-f", id]);
  spawnSync("docker", ["network", "rm", network]);
}
