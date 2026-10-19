import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import {
  validateScannerConfiguration,
  scannerConfiguration,
  requireSameDatabase,
  databaseDistribution,
  requireScanDatabase,
} from "./supply-scanner.mjs";
import {
  assess,
  coverage,
  freshness,
  reconcileRuntimeReport,
} from "./supply-policy.mjs";
import { prepareArchive } from "./images.mjs";
import { compareRegistryArchive } from "./supply-registry.mjs";
import { materializeProducers } from "./supply-producers.mjs";
import { observePhase } from "./diagnostics.mjs";
import { manifestFiles, evidenceGroups } from "./supply-evidence.mjs";
import {
  reconcileInstalledNpm,
  reconcileInstalledSpdx,
  reconcileFrontendReport,
  reconstructFrontend,
} from "./supply-frontend.mjs";
import {
  root,
  production,
  proof,
  slsa,
  spdx,
  insist,
  json,
  save,
  fileHash,
  hash,
  same,
  requireIdentity,
  requireImage,
  isolated,
  tool,
  toolEnvironment,
  run,
  verifySignature,
  instant,
} from "./supply-internal.mjs";

async function captureDatabase(status, cwd) {
  insist(
    typeof status?.path === "string" && isAbsolute(status.path),
    "missing native database path",
  );
  const withinCache = relative(join(cwd, "db"), status.path);
  insist(
    withinCache && !withinCache.startsWith("..") && !isAbsolute(withinCache),
    "database escaped isolated cache",
  );
  return {
    ...databaseDistribution(status),
    sha256: await fileHash(status.path),
  };
}

async function scannerContext(action) {
  return isolated(async (cwd) => {
    const config = join(cwd, "config.json");
    const configuration = scannerConfiguration(join(cwd, "db"));
    await save(config, configuration);
    const env = {
      ...toolEnvironment(),
      HOME: cwd,
      USERPROFILE: cwd,
      XDG_CONFIG_HOME: cwd,
      XDG_CACHE_HOME: cwd,
    };
    return action({ cwd, env, config, configuration });
  });
}

export async function scanArchive({
  archivePath,
  build,
  source,
  authority,
  evidenceDirectory,
  frontendBuildDirectory,
}) {
  requireIdentity(source, authority);
  const archive = await prepareArchive(
    "application",
    archivePath,
    build,
    source,
    authority,
  );
  const directory = resolve(evidenceDirectory);
  await mkdir(resolve(directory, ".."), { recursive: true });
  await mkdir(directory);
  const syft = await tool("syft");
  const grype = await tool("grype");
  const policy = await json(join(root, "supply-policy.json"));
  return scannerContext(async ({ cwd, env, config, configuration }) => {
    const authored = structuredClone(configuration);
    authored.db["cache-dir"] = "$SESSION/db";
    await save(join(directory, "scanner-config.json"), authored);
    const syftConfig = join(cwd, "syft.json");
    await save(syftConfig, { "check-for-app-update": false });
    run(grype.binary, ["db", "update", "--config", config], { cwd, env });
    const currentDatabase = async () =>
      captureDatabase(
        JSON.parse(
          run(
            grype.binary,
            ["db", "status", "--config", config, "--output", "json"],
            { cwd, env },
          ),
        ),
        cwd,
      );
    const database = await currentDatabase();
    freshness(new Date().toISOString(), database.built, policy);
    const scans = [];
    const scan = async (kind, input, output) => {
      const before = await currentDatabase();
      insist(same(before, database), "database changed before scan");
      const started = new Date().toISOString();
      const bytes = run(
        grype.binary,
        [input, "--config", config, "--output", "json"],
        { cwd, env },
      );
      const ended = new Date().toISOString();
      await writeFile(output, bytes);
      const after = await currentDatabase();
      const report = JSON.parse(bytes);
      insist(
        same(after, database) &&
          same(
            await captureDatabase(report.descriptor?.db?.status, cwd),
            database,
          ),
        "database changed during scan",
      );
      validateScannerConfiguration(report, join(cwd, "db"));
      scans.push({ kind, started, ended, before, after });
      return report;
    };
    const scanTime = new Date().toISOString();
    const input = `docker-archive:${resolve(archivePath)}`;
    const sbomBytes = run(
      syft.binary,
      ["scan", input, "--config", syftConfig, "--output", "spdx-json"],
      { cwd, env },
    );
    await writeFile(join(directory, "sbom.spdx.json"), sbomBytes);
    const runtime = await scan("runtime", input, join(directory, "scan.json"));
    const runtimeCoverage = coverage(JSON.parse(sbomBytes), runtime);
    const reports = [{ kind: "runtime", report: runtime }];
    let observation;
    if (frontendBuildDirectory !== undefined) {
      const frontend = join(directory, "frontend");
      await mkdir(frontend);
      const reconstructed = await reconstructFrontend({
        directory: frontendBuildDirectory,
        source,
        authority,
        workDirectory: join(cwd, "frontend"),
      });
      insist(
        reconstructed.final.archiveSha256 === archive.archiveSha256,
        "frontend final archive differs from runtime scan",
      );
      const base = [
        "scan",
        `dir:${reconstructed.projectDirectory}`,
        "--config",
        syftConfig,
        "--select-catalogers",
        "+javascript-package-cataloger",
        "--source-name",
        "damadama-frontend-installed",
        "--source-version",
        source.commit,
      ];
      const rawBytes = run(syft.binary, [...base, "--output", "syft-json"], {
        cwd,
        env,
      });
      await writeFile(join(frontend, "syft.json"), rawBytes);
      const raw = JSON.parse(rawBytes);
      insist(
        raw.source?.type === "directory" &&
          raw.source.name === "damadama-frontend-installed" &&
          raw.source.version === source.commit,
        "frontend Syft source differs",
      );
      const packageCount = reconcileInstalledNpm(reconstructed.inventory, raw);
      const frontendSbomBytes = run(
        syft.binary,
        [...base, "--output", "spdx-json"],
        { cwd, env },
      );
      const sbomPath = join(frontend, "sbom.spdx.json");
      await writeFile(sbomPath, frontendSbomBytes);
      const frontendSbom = JSON.parse(frontendSbomBytes);
      reconcileInstalledSpdx(
        reconstructed.inventory,
        frontendSbom,
        source.commit,
      );
      const report = await scan(
        "frontend",
        `sbom:${sbomPath}`,
        join(frontend, "scan.json"),
      );
      reconcileFrontendReport(
        reconstructed.inventory,
        frontendSbom,
        report,
        source.commit,
      );
      reports.push({ kind: "frontend", report });
      observation = {
        schema: 1,
        kind: "unsigned-frontend-observation",
        source,
        authority,
        archiveSha256: archive.archiveSha256,
        web: reconstructed.web,
        final: reconstructed.final,
        origin: reconstructed.origin,
        emitted: reconstructed.emitted,
        inventory: reconstructed.inventory,
        packageCount,
        scanTime: scans.find((entry) => entry.kind === "frontend").started,
        database,
        tools: {
          crane: reconstructed.crane,
          syft: { version: syft.version, sha256: syft.sha256 },
          grype: { version: grype.version, sha256: grype.sha256 },
        },
        status: "incomplete",
      };
      runtimeCoverage.frontend.basis =
        "Paired bytes and installed npm reports observed under one database; signed schema2 binding remains pending.";
    }
    insist(
      (await fileHash(archivePath)) === archive.archiveSha256,
      "archive changed during scan",
    );
    freshness(scanTime, database.built, policy);
    const decision = assess(reports, policy, "ghcr.io/shiosos/damadama");
    await copyFile(archivePath, join(directory, "image.tar"));
    insist(
      (await fileHash(join(directory, "image.tar"))) === archive.archiveSha256,
      "archive mirror changed during copy",
    );
    await copyFile(
      join(root, "supply-policy.json"),
      join(directory, "policy.json"),
    );
    const assessment = {
      schema: 1,
      kind: "unsigned-scan-assessment",
      source,
      authority,
      archiveSha256: archive.archiveSha256,
      scanTime,
      database,
      scans,
      tools: {
        syft: { version: syft.version, sha256: syft.sha256 },
        grype: { version: grype.version, sha256: grype.sha256 },
      },
      coverage: runtimeCoverage,
    };
    if (observation)
      await save(join(directory, "frontend", "observation.json"), observation);
    await save(join(directory, "decision.json"), decision);
    await save(join(directory, "assessment.json"), assessment);
    return { ...assessment, decision };
  });
}

async function requireCurrentDatabase(database) {
  const grype = await tool("grype");
  return scannerContext(async ({ cwd, env, config }) => {
    run(grype.binary, ["db", "update", "--config", config], { cwd, env });
    const current = JSON.parse(
      run(
        grype.binary,
        ["db", "status", "--config", config, "--output", "json"],
        { cwd, env },
      ),
    );
    requireSameDatabase(database, await captureDatabase(current, cwd));
  });
}

export async function compareOriginals(directory, originals) {
  for (const group of ["build", "scan"])
    for (const name of evidenceGroups[group]) {
      insist(
        (await fileHash(join(directory, group, name))) ===
          (await fileHash(join(originals, group, name))),
        `original ${group} member differs: ${name}`,
      );
    }
}

async function requireToolObservation(observed, names) {
  const pins = await json(join(root, "supply-tools.json"));
  insist(
    same(Object.keys(observed ?? {}).sort(), [...names].sort()),
    "tool observation roles differ",
  );
  for (const name of names)
    insist(
      same(observed[name], {
        version: pins[name].version,
        sha256: pins[name].executables["linux-x64"].sha256,
      }),
      `untrusted ${name} tool identity`,
    );
}

export async function validateScanEvidence(
  directory,
  source,
  authority,
  archiveSha256,
) {
  requireIdentity(source, authority);
  const assessment = await json(join(directory, "assessment.json"));
  insist(
    assessment?.schema === 1 && assessment.kind === "unsigned-scan-assessment",
    "unsupported scan assessment",
  );
  insist(
    same(assessment.source, source) && same(assessment.authority, authority),
    "scan source or authority differs",
  );
  insist(
    assessment.archiveSha256 === archiveSha256 &&
      (await fileHash(join(directory, "image.tar"))) === archiveSha256,
    "archive differs from signed evidence",
  );
  insist(
    (await fileHash(join(directory, "policy.json"))) ===
      (await fileHash(join(root, "supply-policy.json"))),
    "policy differs from current trusted policy",
  );
  const policy = await json(join(root, "supply-policy.json"));
  insist(
    same(
      await json(join(directory, "scanner-config.json")),
      scannerConfiguration("$SESSION/db"),
    ),
    "authored scanner configuration differs",
  );
  const report = await json(join(directory, "scan.json"));
  const sbom = await json(join(directory, "sbom.spdx.json"));
  const frontend = await json(join(directory, "frontend/scan.json"));
  const observation = await json(join(directory, "frontend/observation.json"));
  const reports = [
    { kind: "runtime", report },
    { kind: "frontend", report: frontend },
  ];
  const scanTime = instant(assessment.scanTime, "scan time");
  const database = assessment.database;
  const cache = report.descriptor?.configuration?.db?.["cache-dir"];
  insist(
    typeof cache === "string" &&
      /(?:^\/|^[A-Za-z]:[\\/])/.test(cache) &&
      /[\\/]db$/.test(cache),
    "invalid original scanner cache",
  );
  await requireToolObservation(assessment.tools, ["syft", "grype"]);
  await requireToolObservation(observation.tools, ["syft", "grype", "crane"]);
  insist(
    Array.isArray(assessment.scans) && assessment.scans.length === 2,
    "complete ordered runtime/frontend scans required",
  );
  let previous = scanTime;
  for (const [index, tagged] of reports.entries()) {
    const scan = assessment.scans[index];
    const started = instant(scan.started, "scan start");
    const ended = instant(scan.ended, "scan end");
    const rawTime = instant(
      tagged.report.descriptor?.timestamp,
      "raw scanner timestamp",
    );
    insist(
      started >= previous &&
        ended >= started &&
        ended <= Date.now() &&
        rawTime >= started &&
        rawTime <= ended,
      "scan interval or raw timestamp differs",
    );
    previous = ended;
    const status = tagged.report.descriptor?.db?.status;
    validateScannerConfiguration(tagged.report, cache);
    insist(
      status?.path?.replaceAll("\\", "/") ===
        `${cache.replaceAll("\\", "/")}/6/vulnerability.db`,
      "database identity differs from raw scan",
    );
  }
  requireScanDatabase(database, assessment.scans, reports);
  freshness(assessment.scanTime, database.built, policy);
  const decision = assess(reports, policy, "ghcr.io/shiosos/damadama");
  insist(
    same(decision, await json(join(directory, "decision.json"))),
    "persisted scan decision differs",
  );
  insist(
    decision.status === "accepted",
    "vulnerability policy refused archive",
  );
  const expectedCoverage = coverage(sbom, report);
  reconcileRuntimeReport(sbom, report);
  expectedCoverage.frontend.basis =
    "Paired bytes and installed npm reports observed under one database; signed schema2 binding remains pending.";
  insist(
    same(assessment.coverage, expectedCoverage),
    "coverage differs from inventory",
  );
  return { assessment, decision, sbom, report, frontend, observation };
}

export async function validateEvidence(directory, source, authority, trust) {
  insist(trust === production || trust === proof, "unknown supply trust");
  const buildDirectory = join(directory, "build");
  const scanDirectory = join(directory, "scan");
  const build = await json(join(buildDirectory, "build.json"));
  const archive = await prepareArchive(
    "application",
    join(buildDirectory, "image.tar"),
    build,
    source,
    authority,
  );
  const webBuild = await json(join(buildDirectory, "web-build.json"));
  const purpose =
    trust === production
      ? "real-application-origin-observation"
      : "tiny-fixture-origin-observation";
  insist(
    webBuild.purpose === purpose,
    "build purpose differs from fixed verifier contract",
  );
  const evidence = await validateScanEvidence(
    scanDirectory,
    source,
    authority,
    archive.archiveSha256,
  );
  const reconstructed = await isolated((workDirectory) =>
    reconstructFrontend({
      directory: buildDirectory,
      source,
      authority,
      workDirectory,
    }),
  );
  const raw = await json(join(scanDirectory, "frontend/syft.json"));
  const supplemental = await json(
    join(scanDirectory, "frontend/sbom.spdx.json"),
  );
  insist(
    raw.source?.type === "directory" &&
      raw.source.name === "damadama-frontend-installed" &&
      raw.source.version === source.commit &&
      raw.descriptor?.name === "syft" &&
      raw.descriptor.version === evidence.assessment.tools.syft.version,
    "frontend Syft source or tool differs",
  );
  const packageCount = reconcileInstalledNpm(reconstructed.inventory, raw);
  reconcileFrontendReport(
    reconstructed.inventory,
    supplemental,
    evidence.frontend,
    source.commit,
  );
  insist(
    same(evidence.observation, {
      schema: 1,
      kind: "unsigned-frontend-observation",
      source,
      authority,
      archiveSha256: archive.archiveSha256,
      web: reconstructed.web,
      final: reconstructed.final,
      origin: reconstructed.origin,
      emitted: reconstructed.emitted,
      inventory: reconstructed.inventory,
      packageCount,
      scanTime: evidence.assessment.scans[1].started,
      database: evidence.assessment.database,
      tools: evidence.observation.tools,
      status: "incomplete",
    }),
    "frontend observation differs from independent reconstruction",
  );
  const target = evidence.report.source?.target;
  insist(
    target?.imageID === reconstructed.final.configDigest &&
      target.os === "linux" &&
      target.architecture === "amd64" &&
      same(
        target.layers?.map((layer) => layer.digest),
        reconstructed.final.diffIds,
      ),
    "runtime report image differs from original build",
  );
  const config = Buffer.from(target.config ?? "", "base64");
  insist(
    `sha256:${hash(config)}` === reconstructed.final.configDigest,
    "runtime report config differs",
  );
  const manifest = Buffer.from(target.manifest ?? "", "base64");
  insist(
    `sha256:${hash(manifest)}` === target.manifestDigest &&
      JSON.parse(manifest).config?.digest === reconstructed.final.configDigest,
    "runtime report manifest differs",
  );
  const roots = evidence.sbom.packages.filter(
    (item) => item.primaryPackagePurpose === "CONTAINER",
  );
  insist(
    roots.length === 1 &&
      roots[0].versionInfo === target.manifestDigest &&
      roots[0].name === target.userInput &&
      evidence.sbom.name === target.userInput &&
      evidence.sbom.creationInfo?.creators?.includes(
        `Tool: syft-${evidence.assessment.tools.syft.version}`,
      ),
    "runtime SPDX image identity differs",
  );
  const completeCoverage = {
    ...coverage(evidence.sbom, evidence.report),
    frontend: {
      status: "complete",
      installedLocations: packageCount,
      unversionedManifests: reconstructed.inventory.unversioned.length,
      emittedAssets: reconstructed.emitted.length,
    },
  };
  if (trust === production)
    insist(
      completeCoverage.osPackages > 0 && completeCoverage.dotnetPackages > 0,
      "production OS/.NET coverage incomplete",
    );
  await validateScanEvidence(
    scanDirectory,
    source,
    authority,
    archive.archiveSha256,
  );
  return { ...evidence, coverage: completeCoverage };
}
async function verifyCapsule(
  {
    expectedSource: source,
    expectedAuthority: authority,
    expectedImage: image,
    evidenceDirectory,
  },
  trust,
) {
  requireIdentity(source, authority);
  if (trust === production) requireImage(image, source);
  const directory = resolve(evidenceDirectory);
  const manifestPath = join(directory, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = hash(manifestBytes);
  const signatureSha256 = await fileHash(
    join(directory, "manifest.bundle.json"),
  );
  await observePhase("supply.signature.manifest", () =>
    verifySignature(
      manifestPath,
      join(directory, "manifest.bundle.json"),
      trust,
      source,
      authority,
      slsa,
      manifestSha256,
    ),
  );
  insist(
    manifestBytes.equals(await readFile(manifestPath)),
    "manifest changed during verification",
  );
  const manifest = JSON.parse(manifestBytes);
  insist(
    manifest?.schema === 2 && manifest.purpose === trust.purpose,
    "signed schema2 with authorized purpose is required; schema1 is unsupported",
  );
  insist(
    same(Object.keys(manifest).sort(), [
      "authority",
      "files",
      "image",
      "producers",
      "purpose",
      "schema",
      "source",
    ]),
    "unsupported manifest fields",
  );
  insist(
    same(manifest.source, source) && same(manifest.authority, authority),
    "signed source or authority differs",
  );
  if (trust === production)
    insist(same(manifest.image, image), "signed registry image differs");
  else insist(manifest.image === null, "proof must not claim a registry image");
  await observePhase("supply.manifest.compare.initial", async () => {
    insist(
      same(manifest.files, await manifestFiles(directory)),
      "signed evidence hash differs",
    );
  });
  const archiveSha256 = manifest.files["build/image.tar"];
  if (trust === production)
    insist(
      archiveSha256 === image.archiveSha256,
      "published archive differs from signed archive",
    );
  const evidence = await isolated(async (originals) => {
    const producers = await observePhase("supply.originals.materialize", () =>
      materializeProducers(source, authority, trust, originals),
    );
    insist(
      same(manifest.producers, producers),
      "immutable producer artifact membership differs",
    );
    await observePhase("supply.originals.compare.before", () =>
      compareOriginals(directory, originals),
    );
    const validated = await observePhase("supply.evidence.validate", () =>
      validateEvidence(originals, source, authority, trust),
    );
    await observePhase("supply.originals.compare.after", () =>
      compareOriginals(directory, originals),
    );
    return validated;
  });
  let subject = join(directory, "build/image.tar");
  let digest = archiveSha256;
  if (trust === production) {
    subject = `oci://${image.reference}`;
    digest = image.digest.slice(7);
    await observePhase("supply.registry.compare", () =>
      compareRegistryArchive(image, join(directory, "build/image.tar")),
    );
  }
  const provenance = await observePhase("supply.signature.provenance", () =>
    verifySignature(
      subject,
      join(directory, "signer/provenance.bundle.json"),
      trust,
      source,
      authority,
      slsa,
      digest,
    ),
  );
  const sbomStatement = await observePhase("supply.signature.sbom", () =>
    verifySignature(
      subject,
      join(directory, "signer/sbom.bundle.json"),
      trust,
      source,
      authority,
      spdx,
      digest,
    ),
  );
  insist(
    same(sbomStatement.predicate, evidence.sbom),
    "signed SPDX predicate differs from scanned SBOM",
  );
  if (trust === production)
    insist(
      provenance.subject[0].name === "ghcr.io/shiosos/damadama" &&
        sbomStatement.subject[0].name === "ghcr.io/shiosos/damadama",
      "OCI subject name differs",
    );
  await observePhase("supply.database.current", () =>
    requireCurrentDatabase(evidence.assessment.database),
  );
  await observePhase("supply.scan.recheck", () =>
    validateScanEvidence(
      join(directory, "scan"),
      source,
      authority,
      archiveSha256,
    ),
  );
  await observePhase("supply.manifest.compare.final", async () => {
    insist(
      same(manifest.files, await manifestFiles(directory)),
      "evidence changed during verification",
    );
    insist(
      (await fileHash(manifestPath)) === manifestSha256,
      "manifest changed during verification",
    );
    insist(
      (await fileHash(join(directory, "manifest.bundle.json"))) ===
        signatureSha256,
      "manifest signature changed during verification",
    );
  });
  if (trust === production) {
    insist(
      evidence.coverage.osPackages > 0 &&
        evidence.coverage.dotnetPackages > 0 &&
        evidence.coverage.frontend.status === "complete",
      "production coverage incomplete; bind frontend inventory before activation",
    );
    return { kind: "authenticated-release-receipt", image, manifestSha256 };
  }
  return { kind: "ci-signature-proof", manifestSha256 };
}

export async function verifyRelease(request) {
  return verifyCapsule(request, production);
}
export async function verifyCIProof(request) {
  return verifyCapsule(request, proof);
}
