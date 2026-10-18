import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildRoles,
  runtimeScanRoles,
  frontendScanRoles,
  pairedFixtures,
  proofUploadPaths,
} from "./supply-evidence.mjs";

test("proof CLI emits the exact fixed role paths consumed by workflow uploads", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/supply-chain-proof.yml", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(join(tmpdir(), "supply-paths-"));
  try {
    for (const [role, job] of [
      ["build", "proof-build"],
      ["scan", "proof-scan"],
      ["application-scan", "proof-application-scan"],
      ["signed", "proof-sign"],
    ]) {
      const expected = proofUploadPaths(role);
      assert.equal(new Set(expected).size, expected.length);
      const output = join(directory, `${role}.txt`);
      execFileSync(
        process.execPath,
        ["release/supply-proof.mjs", "upload-paths", role],
        { env: { ...process.env, GITHUB_OUTPUT: output } },
      );
      assert.equal(
        await readFile(output, "utf8"),
        `paths<<SUPPLY_PATHS\n${expected.join("\n")}\nSUPPLY_PATHS\n`,
      );
      const section = workflow
        .split(`  ${job}:`)[1]
        .split(/\n  [a-z][a-z-]+:/)[0];
      assert(
        section.includes(
          `run: node release/supply-proof.mjs upload-paths ${role}`,
        ),
      );
      assert(section.includes("path: ${{ steps.paths.outputs.paths }}"));
    }
    const builds = proofUploadPaths("build");
    for (const name of ["application", ...pairedFixtures])
      for (const role of buildRoles)
        assert(builds.includes(`.audit/proof-build/${name}/${role}`));
    const scans = proofUploadPaths("scan");
    for (const name of pairedFixtures)
      for (const role of [...runtimeScanRoles, ...frontendScanRoles])
        assert(scans.includes(`.audit/proof-scan/${name}/${role}`));
    assert(
      !buildRoles.some(
        (name) => name.startsWith("frontend/") || name === "decision.json",
      ),
    );
    assert(!runtimeScanRoles.includes("web-build.json"));
    assert.throws(() => proofUploadPaths("../other"), /unknown/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
