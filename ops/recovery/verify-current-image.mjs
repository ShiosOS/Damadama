import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  link,
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  checkoutIdentity,
  fileSha256,
  migrationIdentity,
  requireImageIdentity,
  verifyImage,
} from "./current-image.mjs";

const metadataPath = resolve(process.argv[2] ?? ".audit/current-image.json");
const summaryPath = resolve(
  process.argv[3] ?? ".audit/current-image-verification.json",
);
const checks = [];
let directory;
let scenario = "identity";
try {
  const current = checkoutIdentity({ requireClean: true });
  const record = requireImageIdentity(
    JSON.parse(await readFile(metadataPath, "utf8")),
    current,
    migrationIdentity(current.commit),
  );
  directory = await mkdtemp(
    resolve(dirname(metadataPath), "image-verification-"),
  );
  scenario = "accepted-built-image";
  await verifyImage(record, metadataPath, directory);
  checks.push(scenario);

  for (const [name, mutate, error] of [
    [
      "unrelated-manifest",
      (value) => {
        value.image.manifestDigest = `sha256:${"0".repeat(64)}`;
      },
      /OCI manifest digest differs from identity/,
    ],
    [
      "wrong-sql-hash",
      (value) => {
        value.migrations.sqlSha256 = "0".repeat(64);
      },
      /Image migrations.sql differs/,
    ],
    [
      "stale-embedded-source",
      (value) => {
        value.source.commit = "0".repeat(40);
      },
      /Image embedded source differs/,
    ],
    [
      "foreign-embedded-source",
      (value) => {
        value.source.repository = "foreign/repository";
      },
      /Image embedded source differs/,
    ],
  ]) {
    scenario = name;
    const changed = structuredClone(record);
    mutate(changed);
    await assert.rejects(verifyImage(changed, metadataPath, directory), error);
    checks.push(scenario);
  }

  const changedPath = resolve(directory, "changed.json");
  await link(`${metadataPath}.oci.tar`, `${changedPath}.oci.tar`);
  scenario = "altered-docker-archive";
  await copyFile(`${metadataPath}.image.tar`, `${changedPath}.image.tar`);
  const archive = await open(`${changedPath}.image.tar`, "r+");
  try {
    const byte = Buffer.alloc(1);
    await archive.read(byte, 0, 1, 0);
    byte[0] ^= 1;
    await archive.write(byte, 0, 1, 0);
  } finally {
    await archive.close();
  }
  await assert.rejects(
    verifyImage(record, changedPath, directory),
    /Docker archive hash differs/,
  );
  checks.push(scenario);

  scenario = "foreign-docker-archive-with-matching-checksum";
  await unlink(`${changedPath}.image.tar`);
  execFileSync(
    "docker",
    ["save", "--output", `${changedPath}.image.tar`, "damadama-recovery-proof"],
    { timeout: 180_000, stdio: "pipe" },
  );
  const foreign = structuredClone(record);
  foreign.image.archiveSha256 = await fileSha256(`${changedPath}.image.tar`);
  await assert.rejects(
    verifyImage(foreign, changedPath, directory),
    /Docker archive(?::| (?:manifest|config|layer):)/,
  );
  checks.push(scenario);

  const summary = { schema: 1, outcome: "passed", checks };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch {
  const summary = {
    schema: 1,
    outcome: "failed",
    failureCode: scenario,
    checks,
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary));
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
