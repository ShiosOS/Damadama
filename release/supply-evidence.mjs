import { join } from "node:path";
import { fileHash, insist, production, proof } from "./supply-internal.mjs";

export const buildRoles = Object.freeze([
  "image.tar",
  "build.json",
  "web-stage.tar",
  "web.oci.tar",
  "web.metadata.json",
  "final.metadata.json",
  "web-build.json",
  "builder-versions.json",
  "release-metadata.json",
]);
export const runtimeScanRoles = Object.freeze([
  "image.tar",
  "assessment.json",
  "scan.json",
  "sbom.spdx.json",
  "policy.json",
  "decision.json",
  "scanner-config.json",
]);
export const frontendScanRoles = Object.freeze([
  "frontend/observation.json",
  "frontend/syft.json",
  "frontend/sbom.spdx.json",
  "frontend/scan.json",
]);
export const pairedFixtures = Object.freeze([
  "paired-clean",
  "paired-frontend-vulnerable",
]);

export const scanRoles = Object.freeze([
  ...runtimeScanRoles,
  ...frontendScanRoles,
]);
export const signerRoles = Object.freeze([
  "provenance.bundle.json",
  "sbom.bundle.json",
]);
export const evidenceGroups = Object.freeze({
  build: buildRoles,
  scan: scanRoles,
  signer: signerRoles,
});
export const evidenceFiles = Object.freeze(
  Object.entries(evidenceGroups).flatMap(([group, roles]) =>
    roles.map((name) => `${group}/${name}`),
  ),
);

export async function manifestFiles(directory) {
  const hashes = {};
  for (const name of evidenceFiles)
    hashes[name] = await fileHash(join(directory, name));
  return hashes;
}

export function producerLayout(trust, role) {
  insist(trust === proof || trust === production, "unknown supply trust");
  insist(role === "build" || role === "scan", "unknown producer role");
  const roles = evidenceGroups[role];
  if (trust === proof) {
    const prefix = `.audit/proof-${role}/`;
    return {
      job: `proof-${role}`,
      artifact: `supply-proof-${role}`,
      members: proofUploadPaths(role).map((path) => path.slice(prefix.length)),
      selected: roles.map((name) => ({
        member: `paired-clean/${name}`,
        path: `${role}/${name}`,
      })),
      identity: "identity.json",
    };
  }
  return {
    job: role,
    artifact: `supply-${role}`,
    members: [...roles],
    selected: roles.map((name) => ({ member: name, path: `${role}/${name}` })),
    identity: null,
  };
}

export function proofUploadPaths(kind) {
  const members = [];
  const add = (prefix, roles) =>
    members.push(...roles.map((name) => `${prefix}/${name}`));
  if (kind === "build") {
    members.push(".audit/proof-build/identity.json");
    for (const name of ["clean", "vulnerable"])
      add(`.audit/proof-build/${name}`, ["image.tar", "build.json"]);
    for (const name of ["application", ...pairedFixtures])
      add(`.audit/proof-build/${name}`, buildRoles);
  } else if (kind === "scan") {
    members.push(".audit/proof-scan/identity.json");
    for (const name of ["clean", "vulnerable"])
      add(`.audit/proof-scan/${name}`, runtimeScanRoles);
    for (const name of pairedFixtures)
      add(`.audit/proof-scan/${name}`, [
        ...runtimeScanRoles,
        ...frontendScanRoles,
      ]);
    members.push(
      ".audit/proof-scan/vulnerable/fixture-exception-test.json",
      ".audit/proof-scan/paired-gate.json",
    );
  } else if (kind === "application-scan") {
    members.push(".audit/proof-application/identity.json");
    add(".audit/proof-application/application", [
      ...runtimeScanRoles,
      ...frontendScanRoles,
    ]);
  } else if (kind === "signed") {
    add(".audit/proof-signed", [
      ...evidenceFiles,
      "manifest.json",
      "manifest.bundle.json",
    ]);
  } else throw new Error("unknown proof artifact role");
  return members;
}
