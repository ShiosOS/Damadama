import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const baseline = "465b8165c1b4b0f29c4daed33d6f3a13b09a8e14";
const baselineTree = "4e7a74ad3e4eaddc03155659d05640c106d483f3";
const roots = ["package.json", "server", "web", "bun.lock"];

export function applicationState(commit, cwd = ".") {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("immutable application commit required");
  const present = git("ls-tree", "--name-only", commit, "--", ...roots)
    .split("\n")
    .filter(Boolean);
  if (present.length === roots.length) return "application";
  if (present.length)
    throw new Error("partial application roots refuse deployment");
  try {
    git("merge-base", "--is-ancestor", baseline, commit);
    if (git("rev-parse", `${baseline}^{tree}`) !== baselineTree)
      throw new Error("tree");
  } catch {
    throw new Error("setup history is not rooted at the approved baseline");
  }
  if (
    git(
      "log",
      "--full-history",
      "--format=%H",
      `${baseline}..${commit}`,
      "--",
      ...roots,
    )
  )
    throw new Error(
      "application previously installed; deletion cannot reopen setup",
    );
  return "setup";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(applicationState(process.argv[2]));
