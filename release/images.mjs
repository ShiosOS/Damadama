import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  candidateVersion,
  recordHash,
  repository,
  requireSource,
} from "./policy.mjs";

const roles = {
  application: {
    localTag: "damadama-candidate",
    repository: "ghcr.io/shiosos/damadama",
  },
  recovery: {
    localTag: "damadama-recovery-candidate",
    repository: "ghcr.io/shiosos/damadama-recovery",
  },
};

export async function prepareArchive(
  kind,
  archivePath,
  build,
  source,
  authority,
) {
  if (!Object.hasOwn(roles, kind)) throw new Error("unsupported image kind");
  if (
    !/^[a-f0-9]{40}$/.test(authority?.sha) ||
    !Number.isSafeInteger(authority.runId) ||
    authority.runId < 1 ||
    !Number.isSafeInteger(authority.attempt) ||
    authority.attempt < 1
  )
    throw new Error("invalid image controller authority");
  if (kind === "application") {
    requireSource(source);
  } else if (
    source?.repository !== repository ||
    !/^[a-f0-9]{40}$/.test(source.commit) ||
    source.commit !== authority.sha ||
    !/^[a-f0-9]{40}$/.test(source.tree)
  ) {
    throw new Error("invalid trusted recovery source");
  }
  if (build?.kind !== kind)
    throw new Error("image kind differs from build record");
  if (!build.source || recordHash(build.source) !== recordHash(source))
    throw new Error("image source differs from build record");
  if (!build.authority || recordHash(build.authority) !== recordHash(authority))
    throw new Error("image authority differs from build record");
  const version =
    kind === "application"
      ? candidateVersion(source)
      : `main-${source.commit.slice(0, 12)}`;
  if (build.version !== version)
    throw new Error("image version differs from build record");
  const controller = { ...authority };
  const expectedArchiveSha256 = build.archiveSha256;
  const archiveSha256 = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  if (expectedArchiveSha256 !== archiveSha256)
    throw new Error("image archive differs from build record");
  return {
    kind,
    archivePath,
    archiveSha256,
    version,
    authority: controller,
  };
}

export function publishArchive(prepared, execute = execFileSync) {
  const role = roles[prepared.kind];
  const archiveSha256 = createHash("sha256")
    .update(readFileSync(prepared.archivePath))
    .digest("hex");
  if (archiveSha256 !== prepared.archiveSha256)
    throw new Error("image archive changed after preparation");
  const loaded = execute("docker", ["load", "--input", prepared.archivePath], {
    encoding: "utf8",
  });
  if (!loaded.split(/\r?\n/).includes(`Loaded image: ${role.localTag}:latest`))
    throw new Error(
      `archive did not load expected image ${role.localTag}:latest`,
    );
  execute(
    "docker",
    [
      "login",
      "ghcr.io",
      "--username",
      process.env.GITHUB_ACTOR,
      "--password-stdin",
    ],
    { input: process.env.GH_TOKEN, stdio: ["pipe", "inherit", "inherit"] },
  );
  const tag = `${role.repository}:${prepared.version}-${prepared.authority.runId}-${prepared.authority.attempt}`;
  execute("docker", ["tag", role.localTag, tag], { stdio: "inherit" });
  const output = execute("docker", ["push", tag], {
    encoding: "utf8",
    timeout: 180_000,
  });
  const digest = output.match(/digest: (sha256:[a-f0-9]{64})/)?.[1];
  if (!digest) throw new Error("registry did not return an immutable digest");
  const image = {
    reference: `${role.repository}@${digest}`,
    digest,
    archiveSha256: prepared.archiveSha256,
    version: prepared.version,
  };
  execute("docker", ["manifest", "inspect", image.reference], {
    stdio: "ignore",
  });
  return image;
}
