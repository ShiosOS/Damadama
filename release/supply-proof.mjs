import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  pairedFixtures,
  proofUploadPaths,
  evidenceFiles,
  manifestFiles,
} from "./supply-evidence.mjs";
import { candidateVersion } from "./policy.mjs";
import { buildApplicationWithWebEvidence } from "./supply-web-build.mjs";
import { createFixture, createPairedFixture } from "./supply-fixture.mjs";
import {
  buildRecord,
  localIdentity,
  nativeFixtures,
  nativePairedFixtures,
} from "./supply-native.mjs";
import {
  scanArchive,
  validateEvidence,
  validateScanEvidence,
  compareOriginals,
  verifyCIProof,
  verifyRelease,
} from "./supply-chain.mjs";
import { materializeProducers } from "./supply-producers.mjs";
import {
  save,
  json,
  proof,
  production,
  slsa,
  spdx,
  verifySignature,
  fileHash,
  isolated,
} from "./supply-internal.mjs";

async function build(directory, identity) {
  await mkdir(directory, { recursive: true });
  await save(join(directory, "identity.json"), identity);
  for (const kind of ["clean", "vulnerable"]) {
    const archive = await createFixture(
      join(directory, kind),
      kind === "vulnerable",
    );
    await save(
      join(directory, kind, "build.json"),
      await buildRecord(archive, identity),
    );
  }
  for (const kind of pairedFixtures) {
    const archive = await createPairedFixture(
      join(directory, kind),
      identity,
      kind === "paired-frontend-vulnerable",
    );
    await save(
      join(directory, kind, "build.json"),
      await buildRecord(archive, identity),
    );
  }
  const app = join(directory, "application");
  await mkdir(app, { recursive: true });
  await writeFile(
    ".damadama-release.json",
    JSON.stringify({
      source: identity.source,
      version: candidateVersion(identity.source),
    }),
    { flag: "wx" },
  );
  const archive = await buildApplicationWithWebEvidence(app, identity);
  await save(join(app, "build.json"), await buildRecord(archive, identity));
}

async function scan(input, output) {
  const identity = await json(join(input, "identity.json"));
  await nativeFixtures(output, identity, input);
  await nativePairedFixtures(input, output, identity);
  await save(join(output, "identity.json"), identity);
}

async function scanApplication(input, output) {
  const identity = await json(join(input, "identity.json"));
  const app = join(output, "application");
  const result = await scanArchive({
    ...identity,
    archivePath: join(input, "application", "image.tar"),
    build: await json(join(input, "application", "build.json")),
    evidenceDirectory: app,
    frontendBuildDirectory: join(input, "application"),
  });
  await save(join(output, "identity.json"), identity);
  assert.equal(
    result.decision.status,
    "accepted",
    `application vulnerability policy refused: ${JSON.stringify(result.decision.blocked)}`,
  );
  assert(
    result.coverage.osPackages > 0 && result.coverage.dotnetPackages > 0,
    "application OS/.NET inventory missing",
  );
}

async function prepare(directory, identity) {
  await mkdir(directory);
  const producers = await materializeProducers(
    identity.source,
    identity.authority,
    proof,
    directory,
  );
  await validateEvidence(directory, identity.source, identity.authority, proof);
  await mkdir(join(directory, "signer"));
  await save(join(directory, "producers.json"), producers);
}

async function assemble(directory, identity) {
  const files = await manifestFiles(directory);
  const producers = await isolated(async (originals) => {
    const authenticated = await materializeProducers(
      identity.source,
      identity.authority,
      proof,
      originals,
    );
    assert.deepEqual(
      authenticated,
      await json(join(directory, "producers.json")),
    );
    await compareOriginals(directory, originals);
    const evidence = await validateEvidence(
      originals,
      identity.source,
      identity.authority,
      proof,
    );
    const subject = join(directory, "build/image.tar");
    for (const [name, type] of [
      ["provenance", slsa],
      ["sbom", spdx],
    ]) {
      const statement = await verifySignature(
        subject,
        join(directory, "signer", name + ".bundle.json"),
        proof,
        identity.source,
        identity.authority,
        type,
        files["build/image.tar"],
      );
      if (name === "sbom") assert.deepEqual(statement.predicate, evidence.sbom);
    }
    await compareOriginals(directory, originals);
    return authenticated;
  });
  await validateScanEvidence(
    join(directory, "scan"),
    identity.source,
    identity.authority,
    files["build/image.tar"],
  );
  assert.deepEqual(
    files,
    await manifestFiles(directory),
    "evidence changed during assembly",
  );
  await save(join(directory, "manifest.json"), {
    schema: 2,
    purpose: proof.purpose,
    ...identity,
    image: null,
    producers,
    files,
  });
}

async function prove(directory, identity) {
  const request = {
    expectedSource: identity.source,
    expectedAuthority: identity.authority,
    evidenceDirectory: directory,
  };
  assert.equal((await verifyCIProof(request)).kind, "ci-signature-proof");
  const manifest = join(directory, "manifest.json");
  const bundle = join(directory, "manifest.bundle.json");
  const digest = await fileHash(manifest);
  for (const changed of ["manifest.json", ...evidenceFiles]) {
    const path = join(directory, changed);
    const original = await readFile(path);
    try {
      await writeFile(path, Buffer.concat([original, Buffer.from(" ")]));
      if (changed === "manifest.json")
        await assert.rejects(verifyCIProof(request), /failed/);
      else
        await assert.rejects(
          verifyCIProof(request),
          /signed evidence hash differs/,
        );
    } finally {
      await writeFile(path, original);
    }
  }
  const original = await readFile(bundle);
  try {
    await save(bundle, {
      verificationResult: {
        statement: { subject: [{ digest: { sha256: digest } }] },
      },
    });
    await assert.rejects(verifyCIProof(request), /failed/);
  } finally {
    await writeFile(bundle, original);
  }
  for (const authority of [
    { ...identity.authority, runId: identity.authority.runId + 1 },
    { ...identity.authority, attempt: identity.authority.attempt + 1 },
  ]) {
    await assert.rejects(
      verifySignature(
        manifest,
        bundle,
        proof,
        identity.source,
        authority,
        slsa,
        digest,
      ),
      /authenticated certificate runInvocationURI differs/,
    );
  }
  await assert.rejects(
    verifySignature(
      manifest,
      bundle,
      proof,
      identity.source,
      { ...identity.authority, sha: "f".repeat(40) },
      slsa,
      digest,
    ),
    /failed/,
  );
  await assert.rejects(
    verifySignature(
      manifest,
      bundle,
      proof,
      { ...identity.source, commit: "f".repeat(40) },
      identity.authority,
      slsa,
      digest,
    ),
  );
  await assert.rejects(
    verifySignature(
      manifest,
      bundle,
      production,
      identity.source,
      identity.authority,
      slsa,
      digest,
    ),
  );
  const archiveSha256 = await fileHash(join(directory, "build/image.tar"));
  const imageDigest = `sha256:${"a".repeat(64)}`;
  await assert.rejects(
    verifyRelease({
      ...request,
      expectedImage: {
        digest: imageDigest,
        reference: `ghcr.io/shiosos/damadama@${imageDigest}`,
        archiveSha256,
        version: candidateVersion(identity.source),
      },
    }),
  );
  await save(join(directory, "native-proof-result.json"), {
    kind: "ci-signature-proof",
    source: identity.source,
    authority: identity.authority,
    accepted: "native GitHub-signed manifest and file provenance/SPDX",
    tamperedFiles: ["manifest.json", ...evidenceFiles],
    refused: [
      "archive",
      "manifest",
      "scan",
      "SBOM",
      "policy",
      "decision",
      "bundles",
      "forged JSON",
      "source",
      "signer",
      "run",
      "attempt",
      "production identity",
    ],
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, path, output] = process.argv.slice(2);
  if (command === "upload-paths") {
    const paths = proofUploadPaths(path).join("\n");
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `paths<<SUPPLY_PATHS\n${paths}\nSUPPLY_PATHS\n`,
      );
    else console.log(paths);
  } else {
    const directory = resolve(path);
    const identity = localIdentity();
    if (command === "build") await build(directory, identity);
    else if (command === "scan") await scan(directory, resolve(output));
    else if (command === "scan-application")
      await scanApplication(directory, resolve(output));
    else if (command === "prepare") await prepare(directory, identity);
    else if (command === "assemble") await assemble(directory, identity);
    else if (command === "prove") await prove(directory, identity);
    else
      throw new Error(
        "expected build, scan, scan-application, prepare, assemble, or prove",
      );
  }
}
