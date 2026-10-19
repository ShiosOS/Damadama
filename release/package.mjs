import { execFileSync } from "node:child_process";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { fileHash, requireIdentity } from "./supply-internal.mjs";
import { buildApplicationWithWebEvidence } from "./supply-web-build.mjs";
import { requireSource, candidateVersion } from "./policy.mjs";
import { pathToFileURL } from "node:url";

export async function packageApplication(
  record,
  execute = execFileSync,
  build = buildApplicationWithWebEvidence,
) {
  const source = requireSource(record.source);
  requireIdentity(source, record.authority);
  const git = (...args) =>
    execute("git", ["-C", "candidate", ...args], {
      encoding: "utf8",
    }).trim();
  if (
    git("rev-parse", "HEAD") !== source.commit ||
    git("rev-parse", "HEAD^{tree}") !== source.tree
  )
    throw new Error("checkout differs from main source");
  const version = candidateVersion(source);
  const metadata = JSON.stringify({ source, version });
  const path = "candidate/.damadama-release.json";
  let exists;
  try {
    exists = await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (exists) {
    if (!exists.isFile() || (await readFile(path, "utf8")) !== metadata)
      throw new Error(
        "reserved release metadata path differs from trusted source",
      );
  } else {
    await writeFile(path, metadata, { flag: "wx" });
  }
  await build(
    ".",
    { source, authority: record.authority },
    {
      context: "candidate",
      dockerfile: "controls/release/Dockerfile",
      tag: "damadama-candidate",
    },
  );
  const archiveSha256 = await fileHash("image.tar");
  await writeFile(
    "build.json",
    JSON.stringify(
      {
        kind: "application",
        source,
        authority: record.authority,
        version,
        archiveSha256,
      },
      null,
      2,
    ),
  );
  const loaded = execute("docker", ["load", "--input", "image.tar"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (
    !loaded.split(/\r?\n/).includes("Loaded image: damadama-candidate:latest")
  )
    throw new Error("paired archive did not load the candidate image");
  const container = execute("docker", ["create", "damadama-candidate"], {
    encoding: "utf8",
  }).trim();
  try {
    execute(
      "docker",
      ["cp", `${container}:/app/migrations.sql`, "migrations.sql"],
      { stdio: "inherit" },
    );
  } finally {
    execute("docker", ["rm", container], { stdio: "inherit" });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await packageApplication(
    JSON.parse(await readFile("candidate.json", "utf8")),
  );
}
