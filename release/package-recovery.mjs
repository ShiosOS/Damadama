import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { repository } from "./policy.mjs";

export async function packageRecovery(authority, execute = execFileSync) {
  const git = (...args) =>
    execute("git", ["-C", "controls", ...args], { encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  if (commit !== authority.sha)
    throw new Error("recovery checkout differs from trusted controller");
  const source = { repository, commit, tree: git("rev-parse", "HEAD^{tree}") };
  const version = `main-${commit.slice(0, 12)}`;
  execute(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "--file",
      "controls/ops/recovery/Dockerfile",
      "--tag",
      "damadama-recovery-candidate",
      "controls",
    ],
    { stdio: "inherit", timeout: 900_000 },
  );
  execute(
    "docker",
    ["save", "--output", "recovery-image.tar", "damadama-recovery-candidate"],
    { stdio: "inherit", timeout: 120_000 },
  );
  const archiveSha256 = createHash("sha256")
    .update(await readFile("recovery-image.tar"))
    .digest("hex");
  await writeFile(
    "recovery-build.json",
    JSON.stringify(
      { kind: "recovery", source, authority, version, archiveSha256 },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { authority } = JSON.parse(await readFile("candidate.json", "utf8"));
  await packageRecovery(authority);
}
