import assert from "node:assert/strict";
import test from "node:test";
import {
  databaseDistribution,
  requireSameDatabase,
  requireScanDatabase,
} from "./supply-scanner.mjs";

const database = {
  schemaVersion: "v6.1.10",
  built: "2026-10-18T06:27:17Z",
  archiveSha256:
    "e3d1010ec6e5dee9d3e84b2d5723c534d799e104e6573160e05b22c5292f091e",
  sha256: "5b369df1d93a2a4c062923c1bfd81ff1196db976ec0599b5a92ac10a5994ed43",
};
const status = {
  schemaVersion: database.schemaVersion,
  built: database.built,
  from: `https://grype.anchore.io/databases/v6/vulnerability-db_v6.1.10_2026-10-17T00:31:44Z_1792304837.tar.zst?checksum=sha256%3A${database.archiveSha256}`,
  path: "/tmp/damadama-supply-dIpdRx/db/6/vulnerability.db",
  valid: true,
};

test("the same upstream archive survives different valid SQLite hydration layouts", () => {
  const expected = {
    schemaVersion: "v6.1.10",
    built: "2026-10-18T06:27:17Z",
    archiveSha256:
      "5f0d362fadbad5e2c0e5356e76d7eb8748cea839d4afab8f16e8579c2cc6e137",
    sha256: "add8514015a57075c27b8e7df2c010a04cc84716322bdb77d3b5df804ab6e2a2",
  };
  requireSameDatabase(expected, {
    ...expected,
    sha256: "484a848dc884aba8a6164296bcadebe9a084b749df9b90eecc553061cead60e5",
  });
});

test("cross-session equality requires the exact archive and metadata and reports only validated identities", () => {
  const expected = database;
  requireSameDatabase(expected, { ...expected });
  for (const change of [
    { schemaVersion: "v6.1.11" },
    { built: "2026-10-18T07:00:00Z" },
    { archiveSha256: "a".repeat(64) },
  ]) {
    const observed = { ...expected, ...change };
    assert.throws(
      () => requireSameDatabase(expected, observed),
      (error) => {
        assert.equal(
          error.message,
          `database changed since scan; rescan exact archive and sign new evidence; expected=${JSON.stringify(expected)}; observed=${JSON.stringify(observed)}`,
        );
        return true;
      },
    );
  }
  for (const invalid of [
    { ...expected, path: "private-cache-path" },
    { ...expected, sha256: "private-input" },
    { ...expected, archiveSha256: "private-input" },
    { ...expected, built: "private-input" },
    { ...expected, schemaVersion: "private-input" },
    { schemaVersion: expected.schemaVersion, built: expected.built },
    {
      schemaVersion: expected.schemaVersion,
      built: expected.built,
      archiveSha256: expected.archiveSha256,
    },
    {
      schemaVersion: expected.schemaVersion,
      built: expected.built,
      sha256: expected.sha256,
    },
  ]) {
    for (const pair of [
      [expected, invalid],
      [invalid, expected],
    ])
      assert.throws(
        () => requireSameDatabase(...pair),
        (error) => {
          assert(!error.message.includes("expected="));
          assert(!error.message.includes("observed="));
          assert(!error.message.includes("private-"));
          return true;
        },
      );
  }
});

test("native distribution syntax requires the exact canonical Anchore source and one archive checksum", () => {
  assert.deepEqual(databaseDistribution(status), {
    schemaVersion: database.schemaVersion,
    built: database.built,
    archiveSha256: database.archiveSha256,
  });
  for (const from of [
    undefined,
    "manual import",
    status.from.replace("https:", "http:"),
    status.from.replace("grype.anchore.io", "other.example"),
    status.from.replace("grype.anchore.io", "grype.anchore.io:443"),
    status.from.replace("grype.anchore.io", "user@grype.anchore.io"),
    status.from.replace("grype.anchore.io", "GRYPE.ANCHORE.IO"),
    status.from.replace("/databases/v6/", "/databases/v6/../v6/"),
    status.from.replace("/databases/v6/", "/databases%2Fv6/"),
    status.from.replace("vulnerability-db_v6.1.10", "vulnerability-db_v6.1.11"),
    status.from.replace("2026-10-17T", "2026-02-30T"),
    status.from.replace(".tar.zst", ".tar.gz"),
    status.from.replace("%3A", ":"),
    status.from.replace("%3A", "%3a"),
    status.from.replace("%3A", "%253A"),
    status.from.replace(
      database.archiveSha256,
      database.archiveSha256.toUpperCase(),
    ),
    status.from.split("?")[0],
    `${status.from}#fragment`,
    `${status.from}&checksum=sha256%3A${database.archiveSha256}`,
    `${status.from}&other=value`,
    `${status.from}\n`,
  ])
    assert.throws(() => databaseDistribution({ ...status, from }));
  for (const change of [{ valid: false }, { error: "corrupt" }])
    assert.throws(() => databaseDistribution({ ...status, ...change }));
});

function pairedScans() {
  const scans = ["runtime", "frontend"].map((kind) => ({
    kind,
    before: { ...database },
    after: { ...database },
  }));
  const reports = ["runtime", "frontend"].map((kind) => ({
    kind,
    report: { descriptor: { db: { status: { ...status } } } },
  }));
  return { scans, reports };
}

test("paired original reports must agree with the frozen distribution and preserve each local checkpoint", () => {
  const accepted = pairedScans();
  requireScanDatabase(database, accepted.scans, accepted.reports);
  for (const index of [0, 1]) {
    for (const checkpoint of ["before", "after"]) {
      const { scans, reports } = pairedScans();
      scans[index][checkpoint].sha256 = "a".repeat(64);
      assert.throws(
        () => requireScanDatabase(database, scans, reports),
        /frozen database checkpoint differs/,
      );
    }
    for (const change of [
      { from: status.from.replace(database.archiveSha256, "a".repeat(64)) },
      { built: "2026-10-18T07:00:00Z" },
      { from: "manual import" },
    ]) {
      const { scans, reports } = pairedScans();
      Object.assign(reports[index].report.descriptor.db.status, change);
      assert.throws(() => requireScanDatabase(database, scans, reports));
    }
  }
  for (const key of ["scans", "reports"]) {
    const pair = pairedScans();
    pair[key].reverse();
    assert.throws(
      () => requireScanDatabase(database, pair.scans, pair.reports),
      /complete ordered runtime\/frontend/,
    );
  }
});
