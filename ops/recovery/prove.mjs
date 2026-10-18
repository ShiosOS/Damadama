import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { proveRestoreFailures } from "./restore-faults.mjs";
import { selectSource } from "./proof-source.mjs";

const postgres =
  "postgres:17-bookworm@sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df";
const storage =
  "motoserver/moto@sha256:66672d842bf19618966890c574d85198abe92800f4b3b2b5f791015fa1b58831";
const task = randomUUID();
const directory = resolve(".audit", `recovery-proof-${task}`);
await mkdir(directory, { recursive: true });
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const containers = [];
let network;
const password = randomUUID();
const targetPassword = randomUUID();
const startedAt = new Date();
let phase = "identity";
const receipt = {
  schema: 1,
  proofId: task,
  scope: "local-synthetic",
  mode: "unselected",
  outcome: "failed",
  startedAt: startedAt.toISOString(),
  image: null,
  migrations: {},
  assertions: {},
  scenarios: {},
  checks: [],
  hostedRehearsal: "unknown-not-executed",
  previousProductionCompatibility: "unknown-no-supported-image-established",
};
const run = (...args) => {
  const id = docker("run", "-d", "--network", network, ...args);
  containers.push(id);
  return id;
};
const sql = (id, query, database = "habits") =>
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      id,
      "psql",
      "-h",
      "127.0.0.1",
      "-X",
      "-A",
      "-t",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input: query,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trim();
async function wait(ready, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await setTimeout(1000);
  }
  throw new Error(`${label} did not become ready`);
}

const objectsQuery = `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema') + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema') + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON t.typnamespace=n.oid WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema') + (SELECT count(*) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema','public'));`;

const onCheck = (code, status, createdAtDifference) => {
  phase = code;
  const check = { code };
  if (Number.isInteger(status) && status >= 100 && status <= 599)
    check.status = status;
  if (createdAtDifference)
    check.createdAtDifference = {
      postCreatedAt: createdAtDifference.postCreatedAt,
      getCreatedAt: createdAtDifference.getCreatedAt,
      deltaTicks: createdAtDifference.deltaTicks,
    };
  receipt.checks.push(check);
  console.error(
    JSON.stringify({ scope: "synthetic-recovery-check", ...check }),
  );
};

try {
  const prepareSource = await selectSource(process.argv.slice(2), {
    receipt,
    directory,
    run,
    docker,
    sql,
    wait,
    onCheck,
  });
  phase = "isolated-resources";
  network = docker("network", "create", `damadama-proof-${task}`);
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
    `POSTGRES_PASSWORD=${targetPassword}`,
    "-e",
    "POSTGRES_DB=habits",
    postgres,
  );
  for (const id of [source, target])
    await wait(
      () =>
        spawnSync("docker", [
          "exec",
          id,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
        ]).status === 0,
      "isolated PostgreSQL",
    );
  assert.equal(
    sql(target, objectsQuery),
    "0",
    "Restore target starts independently empty",
  );
  phase = "application-source";
  const prepared = await prepareSource(source, password);
  Object.assign(receipt, prepared.evidence);
  phase = "backup-failure-suite";
  const backupSuiteStarted = Date.now();
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
  const invalidDeadline = spawnSync(
    "docker",
    [
      "exec",
      helper,
      "env",
      "BACKUP_MAX_SECONDS=0",
      "sh",
      "/opt/recovery/backup.sh",
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    invalidDeadline.status,
    2,
    "zero deadline fails before backup starts",
  );
  assert.match(
    invalidDeadline.stderr,
    /BACKUP_MAX_SECONDS must be a positive whole number/,
  );
  await mkdir(resolve(directory, "failure-bin"), { recursive: true });
  const storedObjects = () =>
    JSON.parse(
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
  const stalledBackup = (deadline = 3) =>
    spawnSync(
      "docker",
      [
        "exec",
        helper,
        "env",
        "PATH=/proof/failure-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        `BACKUP_MAX_SECONDS=${deadline}`,
        "PGHOST=source-db",
        "BACKUP_ENVIRONMENT=staging",
        "S3_BUCKET=damadama-proof-backups",
        "AWS_ENDPOINT_URL=http://object-store:5000",
        `AGE_RECIPIENT=${recipient}`,
        "sh",
        "/opt/recovery/backup.sh",
      ],
      { encoding: "utf8", timeout: deadline === 3 ? 10_000 : 30_000 },
    );
  const objectsBeforeStall = storedObjects().length;
  await writeFile(
    resolve(directory, "failure-bin/pg_dump"),
    "#!/bin/sh\ntouch /proof/stalled-dump\nsleep 900\n",
  );
  execute("chmod", "+x", "/proof/failure-bin/pg_dump");
  const stalledDump = stalledBackup();
  assert.equal(
    stalledDump.status,
    124,
    "stalled dump reaches the backup deadline",
  );
  execute("test", "-f", "/proof/stalled-dump");
  assert.equal(stalledDump.stdout.includes("completedAt"), false);
  assert.equal(
    storedObjects().length,
    objectsBeforeStall,
    "stalled dump cannot upload a completion manifest",
  );
  assert.equal(
    execute(
      "sh",
      "-c",
      "find /tmp -maxdepth 1 -name 'damadama-backup.*' | wc -l",
    ),
    "0",
    "the deadline removes the temporary dump",
  );
  execute("rm", "/proof/failure-bin/pg_dump");
  await writeFile(
    resolve(directory, "failure-bin/aws"),
    '#!/bin/sh\nfor arg; do case "$arg" in *.dump.age) touch /proof/stalled-upload; sleep 900 ;; esac; done\nexec /usr/bin/aws "$@"\n',
  );
  execute("chmod", "+x", "/proof/failure-bin/aws");
  const stalledUpload = stalledBackup();
  assert.equal(
    stalledUpload.status,
    124,
    "stalled upload reaches the backup deadline",
  );
  execute("test", "-f", "/proof/stalled-upload");
  assert.equal(stalledUpload.stdout.includes("completedAt"), false);
  assert.equal(
    storedObjects().length,
    objectsBeforeStall,
    "stalled upload cannot upload a completion manifest",
  );
  assert.equal(
    execute(
      "sh",
      "-c",
      "find /tmp -maxdepth 1 -name 'damadama-backup.*' | wc -l",
    ),
    "0",
    "the deadline removes the temporary encrypted archive",
  );
  await writeFile(
    resolve(directory, "failure-bin/aws"),
    '#!/bin/sh\nfor arg; do case "$arg" in list-objects-v2) touch /proof/stalled-retention; sleep 900 ;; esac; done\nexec /usr/bin/aws "$@"\n',
  );
  const stalledRetention = stalledBackup(15);
  assert.equal(
    stalledRetention.status,
    124,
    "stalled retention reaches the backup deadline",
  );
  execute("test", "-f", "/proof/stalled-retention");
  assert.equal(stalledRetention.stdout.includes("completedAt"), false);
  const retentionManifests = storedObjects().filter(
    (item) =>
      item.Key.endsWith(".json") && item.Key !== `${backup.backup}.json`,
  );
  assert.equal(
    retentionManifests.length,
    1,
    "data is committed before retention",
  );
  execute(
    "aws",
    "--endpoint-url",
    "http://object-store:5000",
    "s3",
    "cp",
    `s3://damadama-proof-backups/${retentionManifests[0].Key}`,
    "/proof/retention-manifest.json",
  );
  const retentionManifest = JSON.parse(
    execute("cat", "/proof/retention-manifest.json"),
  );
  assert.deepEqual(
    storedObjects()
      .filter((item) => item.Key.startsWith(retentionManifest.backup))
      .map((item) => item.Key)
      .sort(),
    [
      retentionManifest.backup,
      `${retentionManifest.backup}.sha256`,
      `${retentionManifest.backup}.json`,
    ].sort(),
    "stalled retention leaves a complete backup in storage",
  );
  const retentionName = retentionManifest.backup.split("/").at(-1);
  for (const suffix of ["", ".sha256"])
    execute(
      "aws",
      "--endpoint-url",
      "http://object-store:5000",
      "s3",
      "cp",
      `s3://damadama-proof-backups/${retentionManifest.backup}${suffix}`,
      `/proof/${retentionName}${suffix}`,
    );
  execute("sh", "-c", `cd /proof && sha256sum -c ${retentionName}.sha256`);
  assert.equal(
    execute(
      "sh",
      "-c",
      "find /tmp -maxdepth 1 -name 'damadama-backup.*' | wc -l",
    ),
    "0",
    "the deadline removes the temporary retention list",
  );
  const expiredBackup =
    "damadama/staging/20200101T000000Z-aaaaaaaaaaaaaaaa.dump.age";
  const expiredName = expiredBackup.split("/").at(-1);
  execute(
    "aws",
    "--endpoint-url",
    "http://object-store:5000",
    "s3",
    "cp",
    `s3://damadama-proof-backups/${backup.backup}`,
    `/proof/${expiredName}`,
  );
  execute(
    "sh",
    "-c",
    `cd /proof && sha256sum ${expiredName} > ${expiredName}.sha256`,
  );
  await writeFile(
    resolve(directory, `${expiredName}.json`),
    JSON.stringify({ ...backup, backup: expiredBackup }),
  );
  for (const suffix of ["", ".sha256", ".json"])
    execute(
      "aws",
      "--endpoint-url",
      "http://object-store:5000",
      "s3",
      "cp",
      `/proof/${expiredName}${suffix}`,
      `s3://damadama-proof-backups/${expiredBackup}${suffix}`,
    );
  await writeFile(
    resolve(directory, "failure-bin/aws"),
    '#!/bin/sh\ncase "$*" in *"s3 cp"*".json"*) exit 42 ;; *list-objects-v2*) /usr/bin/aws "$@" | awk \'$1 ~ /20200101T000000Z-aaaaaaaaaaaaaaaa/ {$2="2020-01-01T00:00:00Z"} {print}\'; exit ;; esac\nexec /usr/bin/aws "$@"\n',
  );
  const failedManifest = stalledBackup(20);
  assert.equal(
    failedManifest.status,
    42,
    "manifest upload failure fails the backup job",
  );
  assert.equal(failedManifest.stdout.includes("completedAt"), false);
  assert.deepEqual(
    storedObjects()
      .filter((item) => item.Key.startsWith(expiredBackup))
      .map((item) => item.Key)
      .sort(),
    [expiredBackup, `${expiredBackup}.sha256`, `${expiredBackup}.json`].sort(),
    "failed replacement must preserve the expired completed backup",
  );
  await writeFile(
    resolve(directory, "failure-bin/aws"),
    '#!/bin/sh\nfor arg; do case "$arg" in *.sha256) exit 42 ;; esac; done\nexec /usr/bin/aws "$@"\n',
  );
  execute("chmod", "+x", "/proof/failure-bin/aws");
  const manifestsBeforePartial = storedObjects().filter((item) =>
    item.Key.endsWith(".json"),
  ).length;
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
    manifestsBeforePartial,
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
  receipt.scenarios.backupFailureSuite = {
    outcome: "passed",
    durationSeconds: (Date.now() - backupSuiteStarted) / 1000,
  };
  phase = "real-archive-restore";
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
      `PGPASSWORD=${targetPassword}`,
      "RESTORE_TARGET_ACK=isolated-empty-target",
      "AGE_IDENTITY_FILE=/proof/identity",
      "sh",
      "/opt/recovery/restore.sh",
      "/proof/backup.age",
      "/proof/backup.sha256",
    ),
  );
  await prepared.verifyTarget(target, targetPassword);
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
      `PGPASSWORD=${targetPassword}`,
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
    "-h",
    "127.0.0.1",
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
      `PGPASSWORD=${targetPassword}`,
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
      `PGPASSWORD=${targetPassword}`,
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
  for (const code of [
    "nonemptyTargetRefused",
    "viewOnlyTargetRefused",
    "incorrectChecksumRefused",
    "partialUploadCannotAnnounceSuccess",
    "failedCompletionPreservesExpiredBackup",
    "retryPreservesCompletedBackup",
    "invalidBackupDeadline",
    "stalledDumpBounded",
    "stalledUploadBounded",
    "stalledRetentionLeavesCompletedTriplet",
  ])
    receipt.scenarios[code] = { outcome: "passed" };
  phase = "restore-failure-suite";
  await proveRestoreFailures({
    source,
    target,
    sql,
    execute,
    helper,
    targetPassword,
    objectsQuery,
    scenarios: receipt.scenarios,
    setPhase: (code) => {
      phase = code;
    },
  });
  receipt.storage = "isolated-Moto-simulator";
  receipt.backup = backup;

  receipt.restore = restore;
  receipt.restoreIncludingDownloadAndAppReadinessSeconds = restoreSeconds;
  receipt.providerProof = "Clerk-and-email-not-executed";
  receipt.outcome = "passed";
} catch {
  receipt.failureCode = phase;
  receipt.scenarios[phase] = { outcome: "failed" };
  process.exitCode = 1;
} finally {
  const cleanup = [];
  for (const id of containers.reverse())
    cleanup.push(
      spawnSync("docker", ["rm", "-f", id], { timeout: 30_000, stdio: "pipe" })
        .status === 0,
    );
  if (network)
    cleanup.push(
      spawnSync("docker", ["network", "rm", network], {
        timeout: 30_000,
        stdio: "pipe",
      }).status === 0,
    );
  try {
    for (const path of ["identity", "wrong-identity", "authority"])
      await rm(resolve(directory, path), { recursive: true, force: true });
  } catch {
    cleanup.push(false);
  }
  receipt.cleanup = {
    createdContainers: containers.length,
    createdNetwork: Boolean(network),
    outcome: cleanup.every(Boolean) ? "passed" : "failed",
  };
  if (receipt.cleanup.outcome === "failed") {
    receipt.outcome = "failed";
    receipt.failureCode = "cleanup";
    process.exitCode = 1;
  }
  receipt.completedAt = new Date().toISOString();
  receipt.durationSeconds = (Date.now() - startedAt.getTime()) / 1000;
  const json = JSON.stringify(receipt, null, 2);
  await writeFile(resolve(directory, "receipt.json"), json);
  await writeFile(resolve(directory, "result.json"), json);
  console.log(json);
}
