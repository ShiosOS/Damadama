import { execFileSync } from "node:child_process";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { requireSource, candidateVersion } from "./policy.mjs";
import { pathToFileURL } from "node:url";

export async function packageApplication(record, execute = execFileSync) {
  const source = requireSource(record.source);
  const git = (...args) =>
    execute("git", ["-C", "candidate", ...args], {
      encoding: "utf8",
    }).trim();
  if (
    git("rev-parse", "HEAD") !== source.merge ||
    git("rev-parse", "HEAD^{tree}") !== source.tree
  )
    throw new Error("checkout differs from proposed source");
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
  execute(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "--file",
      "controls/release/Dockerfile",
      "--tag",
      "damadama-candidate",
      "candidate",
    ],
    { stdio: "inherit", timeout: 900_000 },
  );
  execute("docker", ["save", "--output", "image.tar", "damadama-candidate"], {
    stdio: "inherit",
    timeout: 120_000,
  });
  const archiveSha256 = createHash("sha256")
    .update(await readFile("image.tar"))
    .digest("hex");
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
