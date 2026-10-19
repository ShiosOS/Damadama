import assert from "node:assert/strict";
import test from "node:test";
import { requireSameDatabase } from "./supply-scanner.mjs";

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

test("database equality remains exact and reports only validated expected and observed identities", () => {
  const expected = {
    schemaVersion: "v6.1.10",
    built: "2026-10-18T06:27:17Z",
    sha256: "5b369df1d93a2a4c062923c1bfd81ff1196db976ec0599b5a92ac10a5994ed43",
  };
  requireSameDatabase(expected, { ...expected });
  for (const change of [
    { schemaVersion: "v6.1.11" },
    { built: "2026-10-18T07:00:00Z" },
    { sha256: "a".repeat(64) },
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
    { ...expected, built: "private-input" },
    { ...expected, schemaVersion: "private-input" },
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
