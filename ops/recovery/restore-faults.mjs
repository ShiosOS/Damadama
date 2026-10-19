import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

function background(args, input) {
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  const done = new Promise((resolve) => {
    child.once("error", () => resolve({ status: null }));
    child.once("close", (status) => resolve({ status }));
  });
  child.stdin.end(input);
  return done;
}

async function until(predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await setTimeout(100);
  }
  throw new Error("Restore did not reach the expected database barrier");
}

export async function proveRestoreFailures({
  source,
  target,
  sql,
  execute,
  helper,
  targetPassword,
  objectsQuery,
  scenarios,
  setPhase,
}) {
  const args = (
    database,
    archive = "/proof/backup.age",
    checksum = "/proof/backup.sha256",
    extra = [],
  ) => [
    "exec",
    helper,
    "env",
    "PGHOST=target-db",
    `PGPASSWORD=${targetPassword}`,
    `PGDATABASE=${database}`,
    "RESTORE_TARGET_ACK=isolated-empty-target",
    "AGE_IDENTITY_FILE=/proof/identity",
    ...extra,
    "sh",
    "/opt/recovery/restore.sh",
    archive,
    checksum,
  ];
  const restore = (...values) =>
    spawnSync("docker", args(...values), { encoding: "utf8", timeout: 40_000 });
  const empty = (database) =>
    assert.equal(
      sql(target, objectsQuery, database),
      "0",
      "Failed restore must leave zero user objects",
    );
  for (const database of [
    "damaged",
    "wrongidentity",
    "faulttarget",
    "timeouttarget",
  ]) {
    sql(target, `CREATE DATABASE ${database};`);
    empty(database);
  }
  setPhase("invalidRestoreDeadlines");
  for (const value of ["", "0", "-1", "1.5", "text"]) {
    const result = restore("damaged", undefined, undefined, [
      `RESTORE_MAX_SECONDS=${value}`,
    ]);
    assert.equal(result.status, 2, "Invalid restore deadline must exit 2");
    assert.match(
      result.stderr,
      /RESTORE_MAX_SECONDS must be a positive whole number/,
    );
    empty("damaged");
  }
  scenarios.invalidRestoreDeadlines = { outcome: "passed" };

  setPhase("damagedCiphertextMatchingChecksum");
  execute(
    "sh",
    "-c",
    "head -c -16 /proof/backup.age > /proof/damaged.age; sha256sum /proof/damaged.age > /proof/damaged.sha256",
  );
  const damaged = restore(
    "damaged",
    "/proof/damaged.age",
    "/proof/damaged.sha256",
  );
  assert.notEqual(damaged.status, 0);
  assert.match(
    damaged.stderr,
    /age: error:/,
    "Matching checksum must still fail authenticated decryption",
  );
  empty("damaged");
  scenarios.damagedCiphertextMatchingChecksum = { outcome: "passed" };
  setPhase("wrongAgeIdentity");
  execute("age-keygen", "-o", "/proof/wrong-identity");
  const wrongIdentity = restore("wrongidentity", undefined, undefined, [
    "AGE_IDENTITY_FILE=/proof/wrong-identity",
  ]);
  assert.notEqual(wrongIdentity.status, 0);
  assert.match(wrongIdentity.stderr, /age: error:/);
  empty("wrongidentity");
  scenarios.wrongAgeIdentity = { outcome: "passed" };

  setPhase("faultArchivePreparation");
  sql(source, "CREATE DATABASE faultsource;");
  sql(
    source,
    `CREATE FUNCTION public.recovery_gate(integer) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(472091); RETURN true; END $$;
CREATE TABLE public."RecoveryGate" ("Value" integer CHECK (public.recovery_gate("Value")));
INSERT INTO public."RecoveryGate" ("Value") VALUES (73);`,
    "faultsource",
  );
  execute(
    "env",
    "PGHOST=source-db",
    "PGDATABASE=faultsource",
    "pg_dump",
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--file=/proof/fault.dump",
  );
  const recipient = execute("age-keygen", "-y", "/proof/identity");
  execute(
    "age",
    "--recipient",
    recipient,
    "--output",
    "/proof/fault.age",
    "/proof/fault.dump",
  );
  execute("sh", "-c", "sha256sum /proof/fault.age > /proof/fault.sha256");

  for (const [database, code, timeout] of [
    ["faulttarget", "interruptedRestoreRollbackAndRetry", false],
    ["timeouttarget", "boundedRestoreRollbackAndRetry", true],
  ]) {
    setPhase(code);
    const started = Date.now();
    const holderName = `recovery-holder-${randomUUID()}`;
    const restoreName = `recovery-restore-${randomUUID()}`;
    const holder = background(
      [
        "exec",
        "-i",
        "-e",
        `PGAPPNAME=${holderName}`,
        target,
        "psql",
        "-h",
        "127.0.0.1",
        "-X",
        "-q",
        "-U",
        "postgres",
        "-d",
        database,
        "-v",
        "ON_ERROR_STOP=1",
      ],
      "SELECT pg_advisory_lock(472091); SELECT pg_sleep(120);\n",
    );
    let operation;
    try {
      await until(
        () =>
          sql(
            target,
            `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='${holderName}' AND l.locktype='advisory' AND l.granted;`,
            database,
          ) === "1",
      );
      operation = background(
        args(database, "/proof/fault.age", "/proof/fault.sha256", [
          `PGAPPNAME=${restoreName}`,
          `RESTORE_MAX_SECONDS=${timeout ? 8 : 30}`,
        ]),
      );
      await until(
        () =>
          sql(
            target,
            `SELECT count(*) FROM pg_stat_activity WHERE application_name='${restoreName}' AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE 'COPY public.%RecoveryGate%';`,
            database,
          ) === "1",
      );
      if (!timeout) {
        assert.equal(
          sql(
            target,
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='${restoreName}';`,
            database,
          ),
          "t",
        );
      }
      const result = await operation;
      if (timeout)
        assert.equal(
          result.status,
          124,
          "The restore shell must enforce its whole-operation deadline",
        );
      else
        assert.notEqual(result.status, 0, "Interrupted pg_restore must fail");
      empty(database);
    } finally {
      sql(
        target,
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name IN ('${holderName}','${restoreName}');`,
        database,
      );
      await holder;
      if (operation) await operation;
    }
    const retry = restore(database, "/proof/fault.age", "/proof/fault.sha256", [
      "RESTORE_MAX_SECONDS=30",
    ]);
    assert.equal(
      retry.status,
      0,
      "Retry the same ciphertext into the unchanged empty target",
    );
    assert.equal(
      sql(target, 'SELECT "Value" FROM public."RecoveryGate";', database),
      "73",
    );
    scenarios[code] = {
      outcome: "passed",
      durationSeconds: (Date.now() - started) / 1000,
    };
  }
}
