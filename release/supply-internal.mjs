import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireSource, recordHash, candidateVersion } from "./policy.mjs";

export const root = fileURLToPath(new URL(".", import.meta.url));
export const production = Object.freeze({
  purpose: "release-supply",
  workflow: "stage.yml",
  ref: "refs/heads/main",
});
export const proof = Object.freeze({
  purpose: "ci-signature-proof",
  workflow: "supply-chain-proof.yml",
  ref: "refs/heads/codex/polish-image-supply-chain",
});
export const slsa = "https://slsa.dev/provenance/v1";
export const spdx = "https://spdx.dev/Document/v2.3";
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const same = (a, b) => recordHash(a) === recordHash(b);
export function insist(condition, message) {
  if (!condition) throw new Error(message);
}
export async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
export async function save(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
export async function fileHash(path, signal) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path, { signal }))
    digest.update(bytes);
  return digest.digest("hex");
}

export function databaseMetadata(status) {
  insist(
    status?.valid === true && !status.error,
    "scanner database unavailable or invalid",
  );
  insist(
    typeof status.schemaVersion === "string" &&
      /^v6\.\d+\.\d+$/.test(status.schemaVersion),
    "unsupported database schema",
  );
  instant(status.built, "database time");
  return { schemaVersion: status.schemaVersion, built: status.built };
}

export function requireIdentity(source, authority) {
  requireSource(source);
  insist(source.commit === authority?.sha, "source differs from controller");
  for (const field of ["runId", "attempt"])
    insist(
      Number.isSafeInteger(authority[field]) && authority[field] > 0,
      `invalid authority ${field}`,
    );
}

export function requireImage(image, source) {
  insist(
    /^sha256:[a-f0-9]{64}$/.test(image?.digest),
    "invalid registry image digest",
  );
  insist(
    image.reference === `ghcr.io/shiosos/damadama@${image.digest}`,
    "invalid registry image reference",
  );
  insist(
    /^[a-f0-9]{64}$/.test(image.archiveSha256),
    "invalid image archive hash",
  );
  insist(
    image.version === candidateVersion(source),
    "image version differs from source",
  );
}

export function toolEnvironment(environment = process.env) {
  const clean = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ]) {
    if (environment[key]) clean[key] = environment[key];
  }
  return clean;
}

export async function tool(name) {
  const pins = await json(join(root, "supply-tools.json"));
  const pin = pins[name];
  const platform = `${process.platform}-${process.arch}`;
  insist(
    pin?.executables?.[platform],
    `unsupported ${name} platform ${platform}`,
  );
  const binary = join(
    root,
    "../.audit/supply-tools",
    platform,
    pin.executables[platform].name,
  );
  insist(
    (await fileHash(binary)) === pin.executables[platform].sha256,
    `${name} binary integrity mismatch; run supply-install.mjs`,
  );
  return {
    binary,
    version: pin.version,
    sha256: pin.executables[platform].sha256,
  };
}

export function run(binary, args, options = {}) {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
      env: toolEnvironment(),
      ...options,
    });
  } catch (error) {
    throw new Error(
      `${binary.split(/[\\/]/).at(-1)} failed (${error.status ?? error.code}); no trusted result`,
      { cause: error },
    );
  }
}

export async function isolated(action) {
  const directory = await mkdtemp(join(tmpdir(), "damadama-supply-"));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function instant(value, label) {
  insist(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 19) === value.slice(0, 19),
    `invalid UTC ${label}`,
  );
  return Date.parse(value);
}

export function authenticatedStatement(
  output,
  trust,
  source,
  authority,
  predicateType,
  digest,
) {
  insist(
    Array.isArray(output) && output.length === 1,
    "missing or ambiguous cryptographic verification result",
  );
  const verified = output[0]?.verificationResult;
  const certificate = verified?.signature?.certificate;
  const identity = `https://github.com/ShiosOS/Damadama/.github/workflows/${trust.workflow}@${trust.ref}`;
  const required = {
    subjectAlternativeName: identity,
    issuer: "https://token.actions.githubusercontent.com",
    sourceRepositoryURI: "https://github.com/ShiosOS/Damadama",
    sourceRepositoryIdentifier: "1412858535",
    sourceRepositoryOwnerIdentifier: "31512984",
    sourceRepositoryOwnerURI: "https://github.com/ShiosOS",
    sourceRepositoryDigest: source.commit,
    sourceRepositoryRef: trust.ref,
    buildSignerDigest: authority.sha,
    buildSignerURI: identity,
    runnerEnvironment: "github-hosted",
    runInvocationURI: `https://github.com/ShiosOS/Damadama/actions/runs/${authority.runId}/attempts/${authority.attempt}`,
  };
  for (const [key, value] of Object.entries(required))
    insist(
      certificate?.[key] === value,
      `authenticated certificate ${key} differs`,
    );
  insist(
    Array.isArray(verified.verifiedTimestamps) &&
      verified.verifiedTimestamps.some(
        (entry) =>
          ["Tlog", "TimestampAuthority"].includes(entry.type) &&
          typeof entry.uri === "string" &&
          entry.uri.startsWith("https://") &&
          Number.isFinite(Date.parse(entry.timestamp)),
      ),
    "missing authenticated signing timestamp",
  );
  const statement = verified.statement;
  insist(
    statement?._type === "https://in-toto.io/Statement/v1" &&
      statement.predicateType === predicateType &&
      Array.isArray(statement.subject) &&
      statement.subject.length === 1 &&
      statement.subject[0]?.digest?.sha256 === digest,
    "authenticated statement subject or predicate differs",
  );
  return statement;
}

export async function verifySignature(
  subject,
  bundle,
  trust,
  source,
  authority,
  predicateType,
  digest,
) {
  const gh = await tool("gh");
  return isolated(async (cwd) => {
    const env = {
      ...toolEnvironment(),
      HOME: cwd,
      USERPROFILE: cwd,
      XDG_CONFIG_HOME: cwd,
      XDG_CACHE_HOME: cwd,
      GH_HOST: "github.com",
      GH_CONFIG_DIR: cwd,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
    };
    const privateOCI = trust === production && subject.startsWith("oci://");
    if (privateOCI) {
      insist(
        /^oci:\/\/ghcr\.io\/shiosos\/damadama@sha256:[a-f0-9]{64}$/.test(
          subject,
        ),
        "invalid production OCI subject",
      );
      const token = process.env.GITHUB_TOKEN;
      insist(
        typeof token === "string" && token.length > 0,
        "missing ephemeral registry token",
      );
      const config = join(cwd, "docker");
      await mkdir(config, { mode: 0o700 });
      await writeFile(
        join(config, "config.json"),
        JSON.stringify({
          auths: {
            "ghcr.io": {
              auth: Buffer.from(`x-access-token:${token}`).toString("base64"),
            },
          },
        }),
        { flag: "wx", mode: 0o600 },
      );
      env.DOCKER_CONFIG = config;
    }
    let parsed;
    try {
      const output = run(
        gh.binary,
        [
          "attestation",
          "verify",
          subject,
          "--bundle",
          resolve(bundle),
          "--hostname",
          "github.com",
          "--repo",
          "ShiosOS/Damadama",
          "--cert-identity",
          `https://github.com/ShiosOS/Damadama/.github/workflows/${trust.workflow}@${trust.ref}`,
          "--cert-oidc-issuer",
          "https://token.actions.githubusercontent.com",
          "--source-ref",
          trust.ref,
          "--source-digest",
          source.commit,
          "--signer-digest",
          authority.sha,
          "--deny-self-hosted-runners",
          "--predicate-type",
          predicateType,
          "--format",
          "json",
        ],
        { cwd, env },
      );
      insist(
        output.trim().length > 0,
        "empty cryptographic verification result",
      );
      parsed = JSON.parse(output);
    } catch (error) {
      if (privateOCI)
        throw new Error("production OCI signature verification failed");
      throw error;
    }
    return authenticatedStatement(
      parsed,
      trust,
      source,
      authority,
      predicateType,
      digest,
    );
  });
}

export const installScopes = Object.freeze({
  all: Object.freeze(["cosign", "syft", "grype", "gh", "crane"]),
  scanner: Object.freeze(["cosign", "syft", "grype", "crane"]),
  signer: Object.freeze(["gh", "crane"]),
  verifier: Object.freeze(["cosign", "grype", "gh", "crane"]),
});
