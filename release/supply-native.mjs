import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assess } from "./supply-policy.mjs";
import { createFixture } from "./supply-fixture.mjs";
import { scanArchive } from "./supply-chain.mjs";
import { json, save, root, run, fileHash } from "./supply-internal.mjs";
import { pairedFixtures } from "./supply-evidence.mjs";
import { tinyFixtureOrigin } from "./supply-frontend-origin.mjs";
import { candidateVersion } from "./policy.mjs";

export function localIdentity() {
  const commit = run("git", ["rev-parse", "HEAD"]).trim();
  return {
    source: {
      repository: "ShiosOS/Damadama",
      commit,
      tree: run("git", ["rev-parse", "HEAD^{tree}"]).trim(),
    },
    authority: {
      sha: commit,
      runId: Number(process.env.GITHUB_RUN_ID ?? 1),
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    },
  };
}

export async function buildRecord(archivePath, identity) {
  return {
    kind: "application",
    ...identity,
    version: candidateVersion(identity.source),
    archiveSha256: await fileHash(archivePath),
  };
}

export async function nativeFixtures(
  output,
  identity = localIdentity(),
  fixtureRoot,
) {
  const directory = resolve(output);
  const policy = await json(join(root, "supply-policy.json"));
  for (const kind of ["clean", "vulnerable"]) {
    const evidenceDirectory = join(directory, kind);
    let archivePath;
    if (fixtureRoot) archivePath = join(fixtureRoot, kind, "image.tar");
    else
      archivePath = await createFixture(
        join(directory, `${kind}-build`),
        kind === "vulnerable",
      );
    const build = await buildRecord(archivePath, identity);
    const result = await scanArchive({
      archivePath,
      build,
      ...identity,
      evidenceDirectory,
    });
    if (kind === "clean") {
      assert.equal(
        result.decision.status,
        "accepted",
        JSON.stringify(result.decision),
      );
    } else {
      assert.equal(result.decision.status, "refused");
      assert(
        result.decision.blocked.some(
          (finding) =>
            finding.purl === "pkg:npm/lodash@4.17.15" &&
            ["GHSA-35jh-r3h4-6jhm", "CVE-2021-23337"].includes(finding.id),
        ),
        "expected lodash command injection vulnerability, not a tool error",
      );
      const exceptions = result.decision.blocked.map((finding) => ({
        namespace: finding.namespace,
        id: finding.id,
        purl: finding.purl,
        version: finding.version,
        image: "ghcr.io/shiosos/damadama",
        owner: "fixture-owner",
        reviewer: "fixture-reviewer",
        reason: "Native policy behavior fixture only",
        issue: "https://github.com/ShiosOS/Damadama/issues/1",
        expires: new Date(Date.now() + 3_600_000).toISOString(),
      }));
      const report = await json(join(evidenceDirectory, "scan.json"));
      const permitted = assess(
        [{ kind: "runtime", report: report }],
        { ...policy, exceptions },
        "ghcr.io/shiosos/damadama",
      );
      assert.equal(permitted.status, "accepted");
      for (const mutation of [
        { expires: "2000-01-01T00:00:00Z" },
        { purl: "pkg:npm/*" },
        { reviewer: "" },
      ]) {
        assert.throws(() =>
          assess(
            [{ kind: "runtime", report: report }],
            {
              ...policy,
              exceptions: exceptions.map((entry) => ({
                ...entry,
                ...mutation,
              })),
            },
            "ghcr.io/shiosos/damadama",
          ),
        );
      }
      await save(join(evidenceDirectory, "fixture-exception-test.json"), {
        kind: "fixture-only",
        accepted: permitted,
        refusalCases: ["expired", "broad", "malformed"],
      });
    }
    console.log(`Native ${kind} fixture: ${result.decision.status}`);
  }
}

export async function nativePairedFixtures(input, output, identity) {
  const policy = await json(join(root, "supply-policy.json"));
  const observations = [];
  const outcomes = [];
  for (const kind of pairedFixtures) {
    const buildDirectory = join(input, kind);
    const evidenceDirectory = join(output, kind);
    const result = await scanArchive({
      ...identity,
      archivePath: join(buildDirectory, "image.tar"),
      build: await json(join(buildDirectory, "build.json")),
      frontendBuildDirectory: buildDirectory,
      evidenceDirectory,
    });
    const observation = await json(
      join(evidenceDirectory, "frontend/observation.json"),
    );
    observations.push(observation);
    const runtime = await json(join(evidenceDirectory, "scan.json"));
    const frontend = await json(join(evidenceDirectory, "frontend/scan.json"));
    const reports = [
      { kind: "runtime", report: runtime },
      { kind: "frontend", report: frontend },
    ];
    assert.equal(
      assess([reports[0]], policy, "ghcr.io/shiosos/damadama").status,
      "accepted",
      "paired runtime must remain clean",
    );
    const workspaceVersion = kind === "paired-clean" ? "4.18.1" : "4.17.15";
    assert.deepEqual(
      observation.inventory.installed.map(({ location, name, version }) => ({
        location,
        name,
        version,
      })),
      [
        {
          location: "/node_modules/lodash/package.json",
          name: "lodash",
          version: "4.18.1",
        },
        {
          location: "/web/node_modules/lodash/helper/package.json",
          name: "lodash",
          version: workspaceVersion,
        },
        {
          location: "/web/node_modules/lodash/package.json",
          name: "lodash",
          version: workspaceVersion,
        },
      ],
    );
    assert.deepEqual(
      observation.inventory.unversioned.map(({ path }) => path),
      [
        "src/package.json",
        "src/web/node_modules/lodash/unversioned/package.json",
        "src/web/package.json",
      ],
    );
    assert.equal(
      new Set(observation.inventory.installed.map((item) => item.purl)).size,
      kind === "paired-clean" ? 1 : 2,
    );
    const sbom = await json(join(evidenceDirectory, "frontend/sbom.spdx.json"));
    const packages = sbom.packages.filter((item) => item.name === "lodash");
    assert.equal(packages.length, 3);
    assert.equal(new Set(packages.map((item) => item.SPDXID)).size, 3);
    assert.equal(runtime.matches.length, 0, "paired runtime findings changed");
    assert.equal(result.coverage.frontend.status, "incomplete");
    let exceptionTest;
    if (kind === "paired-clean") {
      assert.equal(
        frontend.matches.length,
        0,
        "paired clean frontend findings changed",
      );
      assert.equal(
        result.decision.status,
        "accepted",
        JSON.stringify(result.decision),
      );
    } else {
      assert.equal(result.decision.status, "refused");
      assert(
        frontend.matches.length > 0 &&
          frontend.matches.every(({ artifact }) => {
            const item = packages.find(
              (item) => item.SPDXID === `SPDXRef-${artifact.id}`,
            );
            return (
              item?.versionInfo === "4.17.15" &&
              item.sourceInfo.startsWith(
                "acquired package info from installed node module manifest file: /web/node_modules/lodash/",
              )
            );
          }),
        "vulnerable findings must join the workspace-local package locations",
      );
      assert(
        result.decision.blocked.some(
          (finding) =>
            finding.purl === "pkg:npm/lodash@4.17.15" &&
            ["GHSA-35jh-r3h4-6jhm", "CVE-2021-23337"].includes(finding.id),
        ),
        "expected frontend lodash vulnerability",
      );
      assert(
        result.decision.blocked.every((finding) =>
          finding.occurrences.every(
            (occurrence) => occurrence.report === "frontend",
          ),
        ),
        "expected frontend-only refusal",
      );
      const exceptions = result.decision.blocked.map((finding) => ({
        namespace: finding.namespace,
        id: finding.id,
        purl: finding.purl,
        version: finding.version,
        image: "ghcr.io/shiosos/damadama",
        owner: "fixture-owner",
        reviewer: "fixture-reviewer",
        reason: "Native frontend-only exception fixture",
        issue: "https://github.com/ShiosOS/Damadama/issues/1",
        expires: new Date(Date.now() + 3_600_000).toISOString(),
      }));
      const accepted = assess(
        reports,
        { ...policy, exceptions },
        "ghcr.io/shiosos/damadama",
      );
      assert.equal(accepted.status, "accepted");
      exceptionTest = {
        kind: "fixture-only",
        policy: { ...policy, exceptions },
        accepted,
        refused: ["expired", "broad", "malformed", "duplicate", "unmatched"],
      };
      for (const mutation of [
        { expires: "2000-01-01T00:00:00Z" },
        { purl: "pkg:npm/*" },
        { reviewer: "" },
        { id: "unmatched-vulnerability" },
      ])
        assert.throws(() =>
          assess(
            reports,
            {
              ...policy,
              exceptions: exceptions.map((entry) => ({
                ...entry,
                ...mutation,
              })),
            },
            "ghcr.io/shiosos/damadama",
          ),
        );
      assert.throws(
        () =>
          assess(
            reports,
            { ...policy, exceptions: [...exceptions, exceptions[0]] },
            "ghcr.io/shiosos/damadama",
          ),
        /duplicate/,
      );
      assert(
        result.decision.blocked.some(
          (finding) => finding.occurrences.length === 2,
        ),
        "native duplicate locations must preserve both finding occurrences",
      );
    }
    outcomes.push({
      kind,
      status: result.decision.status,
      database: result.database,
      scans: result.scans,
      exceptionTest,
    });
  }
  assert.deepEqual(
    observations[0].emitted,
    observations[1].emitted,
    "frontend-only change altered final assets",
  );
  assert.notEqual(observations[0].web.digest, observations[1].web.digest);
  const metadata = await json(
    join(input, pairedFixtures[0], "final.metadata.json"),
  );
  assert.throws(
    () =>
      tinyFixtureOrigin(
        metadata["buildx.build.provenance"],
        observations[1].web.digest,
      ),
    /resolved context differs/,
  );
  await save(join(output, "paired-gate.json"), {
    kind: "unsigned-native-paired-gate",
    outcomes,
    exceptions:
      "frontend-only exact accepted; expired/broad/malformed/duplicate/unmatched refused",
    wrongContext: "refused despite identical final assets",
    status: "incomplete",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await nativeFixtures(process.argv[2]);
