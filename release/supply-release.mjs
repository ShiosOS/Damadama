import assert from "node:assert/strict";
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireFreshCandidate } from "./controller.mjs";
import { prepareArchive, publishArchive } from "./images.mjs";
import { requireSupplyIdentity } from "./policy.mjs";
import {
  materializeProducers,
  materializePublication,
  materializeRelease,
} from "./supply-producers.mjs";
import {
  compareOriginals,
  validateEvidence,
  verifyRelease,
} from "./supply-chain.mjs";
import { manifestFiles, productionUploadPaths } from "./supply-evidence.mjs";
import { compareRegistryArchive } from "./supply-registry.mjs";
import {
  production,
  json,
  save,
  isolated,
  same,
  insist,
  requireIdentity,
  requireImage,
  verifySignature,
  slsa,
  spdx,
} from "./supply-internal.mjs";

async function publication(candidate) {
  requireIdentity(candidate.source, candidate.authority);
  return isolated(async (directory) => {
    const value = await materializePublication(
      candidate.source,
      candidate.authority,
      directory,
    );
    insist(
      same(Object.keys(value ?? {}).sort(), ["authority", "image", "source"]) &&
        same(value.source, candidate.source) &&
        same(value.authority, candidate.authority),
      "publication source or authority differs",
    );
    requireImage(value.image, candidate.source);
    return value.image;
  });
}

export async function publishCandidate(candidate) {
  await requireFreshCandidate(candidate);
  return isolated(async (directory) => {
    await materializeProducers(
      candidate.source,
      candidate.authority,
      production,
      directory,
    );
    await validateEvidence(
      directory,
      candidate.source,
      candidate.authority,
      production,
    );
    await requireFreshCandidate(candidate);
    const archive = join(directory, "build/image.tar");
    const prepared = await prepareArchive(
      "application",
      archive,
      await json(join(directory, "build/build.json")),
      candidate.source,
      candidate.authority,
    );
    await requireFreshCandidate(candidate);
    const image = publishArchive(prepared);
    await requireFreshCandidate(candidate);
    await compareRegistryArchive(image, archive);
    await requireFreshCandidate(candidate);
    return image;
  });
}

export async function prepareRelease(candidate, directory) {
  await requireFreshCandidate(candidate);
  const image = await publication(candidate);
  await mkdir(directory);
  const producers = await materializeProducers(
    candidate.source,
    candidate.authority,
    production,
    directory,
  );
  await validateEvidence(
    directory,
    candidate.source,
    candidate.authority,
    production,
  );
  await compareRegistryArchive(image, join(directory, "build/image.tar"));
  await mkdir(join(directory, "signer"));
  await save(join(directory, "producers.json"), producers);
  await save(join(directory, "image.json"), image);
  await requireFreshCandidate(candidate);
  return image;
}

export async function assembleRelease(candidate, directory) {
  await requireFreshCandidate(candidate);
  const image = await publication(candidate);
  assert.deepEqual(
    image,
    await json(join(directory, "image.json")),
    "publication changed during issuance",
  );
  const files = await manifestFiles(directory);
  const producers = await isolated(async (originals) => {
    const authenticated = await materializeProducers(
      candidate.source,
      candidate.authority,
      production,
      originals,
    );
    assert.deepEqual(
      authenticated,
      await json(join(directory, "producers.json")),
    );
    await compareOriginals(directory, originals);
    const evidence = await validateEvidence(
      originals,
      candidate.source,
      candidate.authority,
      production,
    );
    await compareRegistryArchive(image, join(originals, "build/image.tar"));
    for (const [name, type] of [
      ["provenance", slsa],
      ["sbom", spdx],
    ]) {
      const statement = await verifySignature(
        `oci://${image.reference}`,
        join(directory, "signer", `${name}.bundle.json`),
        production,
        candidate.source,
        candidate.authority,
        type,
        image.digest.slice(7),
      );
      assert.equal(
        statement.subject[0].name,
        "ghcr.io/shiosos/damadama",
        "OCI subject name differs",
      );
      if (name === "sbom")
        assert.deepEqual(
          statement.predicate,
          evidence.sbom,
          "signed SPDX differs from scanned SBOM",
        );
    }
    await compareOriginals(directory, originals);
    return authenticated;
  });
  assert.deepEqual(
    files,
    await manifestFiles(directory),
    "evidence changed during assembly",
  );
  assert.equal(
    files["build/image.tar"],
    image.archiveSha256,
    "published archive differs",
  );
  await requireFreshCandidate(candidate);
  await save(join(directory, "manifest.json"), {
    schema: 2,
    purpose: production.purpose,
    source: candidate.source,
    authority: candidate.authority,
    image,
    producers,
    files,
  });
}

export async function locateRelease(candidate) {
  const image = await publication(candidate);
  return isolated(async (directory) => {
    const identity = await materializeRelease(
      candidate.source,
      candidate.authority,
      directory,
    );
    const receipt = await verifyRelease({
      expectedSource: candidate.source,
      expectedAuthority: candidate.authority,
      expectedImage: image,
      evidenceDirectory: directory,
    });
    insist(
      receipt?.kind === "authenticated-release-receipt" &&
        same(receipt.image, image),
      "unexpected production verification receipt",
    );
    const supply = requireSupplyIdentity(
      { schema: 1, ...identity, manifestSha256: receipt.manifestSha256 },
      candidate.authority,
    );
    return { image, supply };
  });
}

export async function authenticateRelease(candidate, image, supply) {
  requireSupplyIdentity(supply, candidate.authority);
  const current = await locateRelease(candidate);
  insist(
    same(current.image, image) && same(current.supply, supply),
    "frozen signed release identity changed",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, path, role] = process.argv.slice(2);
  insist(
    ["publish", "prepare", "assemble", "verify", "upload-paths"].includes(
      command,
    ),
    "unknown production supply command",
  );
  const arity = command === "upload-paths" ? 3 : 2;
  insist(
    process.argv.slice(2).length === arity,
    "invalid production supply command arguments",
  );
  insist(
    typeof path === "string" && path.length > 0,
    "supply output directory required",
  );
  const directory = resolve(path);
  if (command === "upload-paths") {
    const paths = productionUploadPaths(role, directory).join("\n");
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `paths<<SUPPLY_PATHS\n${paths}\nSUPPLY_PATHS\n`,
      );
    else console.log(paths);
  } else {
    const candidate = await json("candidate.json");
    if (command === "publish") {
      await mkdir(directory);
      const image = await publishCandidate(candidate);
      await save(join(directory, "image.json"), {
        source: candidate.source,
        authority: candidate.authority,
        image,
      });
    } else if (command === "prepare") {
      const image = await prepareRelease(candidate, directory);
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `digest=${image.digest}\nreference=${image.reference}\n`,
      );
    } else if (command === "assemble")
      await assembleRelease(candidate, directory);
    else if (command === "verify") {
      const release = await locateRelease(candidate);
      await mkdir(directory);
      await save(join(directory, "verification.json"), release);
    } else throw new Error("unknown production supply command");
  }
}
