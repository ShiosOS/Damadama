import { execFileSync } from "node:child_process";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { requireSource } from "./policy.mjs";

const source = requireSource(JSON.parse(await readFile("source.json", "utf8")));
const git = (...args) =>
  execFileSync("git", ["-C", "candidate", ...args], {
    encoding: "utf8",
  }).trim();
if (
  git("rev-parse", "HEAD") !== source.merge ||
  git("rev-parse", "HEAD^{tree}") !== source.tree
)
  throw new Error("checkout differs from proposed source");
const version = `pr-${source.pr}-${source.head.slice(0, 12)}-${source.base.slice(0, 12)}`;
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
execFileSync(
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
execFileSync(
  "docker",
  ["save", "--output", "image.tar", "damadama-candidate"],
  { stdio: "inherit", timeout: 120_000 },
);
const archiveSha256 = createHash("sha256")
  .update(await readFile("image.tar"))
  .digest("hex");
await writeFile(
  "build.json",
  JSON.stringify({ version, archiveSha256 }, null, 2),
);
const container = execFileSync("docker", ["create", "damadama-candidate"], {
  encoding: "utf8",
}).trim();
try {
  execFileSync(
    "docker",
    ["cp", `${container}:/app/migrations.sql`, "migrations.sql"],
    { stdio: "inherit" },
  );
} finally {
  execFileSync("docker", ["rm", container], { stdio: "inherit" });
}
