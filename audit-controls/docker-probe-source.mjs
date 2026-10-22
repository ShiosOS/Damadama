import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const files = [
  "scripts/doctor-docker.test.ts",
  "scripts/fixtures/doctor-docker-child.ts",
  "scripts/fixtures/docker-doctorprobe/Program.cs",
  "scripts/fixtures/docker-doctorprobe/docker-doctorprobe.csproj",
  "scripts/fixtures/docker-doctorprobe/packages.lock.json",
];
const [operation, sourceArg, fixtureArg] = process.argv.slice(2);
assert.ok(operation === "record" || operation === "prepare");
assert.ok(sourceArg);
const source = realpathSync(resolve(sourceArg));
const output = resolve(source, ".audit/independent-docker-probe");
const git = (cwd, ...args) => execFileSync("git", args, { cwd });
const text = (cwd, ...args) =>
  git(cwd, ...args)
    .toString("utf8")
    .trim();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = (cwd, expected) => {
  assert.match(expected ?? "", /^[a-f0-9]{40}$/);
  assert.equal(text(cwd, "rev-parse", "HEAD"), expected);
  assert.equal(text(cwd, "status", "--porcelain", "--untracked-files=no"), "");
  return {
    sha: expected,
    tree: text(cwd, "rev-parse", "HEAD^{tree}"),
    doctorBlob: text(cwd, "rev-parse", "HEAD:scripts/doctor.ts"),
    doctorSha256: sha256(readFileSync(resolve(cwd, "scripts/doctor.ts"))),
  };
};
const write = (name, value) => {
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n");
};
const checkedFile = (cwd, path) => {
  const absolute = resolve(cwd, path);
  assert.equal(realpathSync(absolute), absolute);
  assert.equal(lstatSync(absolute).isFile(), true);
  const bytes = readFileSync(absolute);
  assert.equal(sha256(bytes), sha256(git(cwd, "show", `HEAD:${path}`)));
  return {
    path,
    sha256: sha256(bytes),
    gitBlob: text(cwd, "rev-parse", `HEAD:${path}`),
  };
};
const sourceIdentity = identity(source, process.env.SOURCE_SHA);
assert.match(process.env.CONTROLS_SHA ?? "", /^[a-f0-9]{40}$/);
const controlsRoot = resolve(import.meta.dirname, "..");
assert.equal(text(controlsRoot, "rev-parse", "HEAD"), process.env.CONTROLS_SHA);
const controls = {
  sha: process.env.CONTROLS_SHA,
  tree: text(controlsRoot, "rev-parse", "HEAD^{tree}"),
};

if (operation === "record") {
  write("source.json", {
    source: sourceIdentity,
    controls,
    fixture: process.env.FIXTURE_SHA || null,
    platform: process.platform,
    node: process.version,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    trackedInputsClean: true,
  });
} else {
  const before = JSON.parse(
    readFileSync(resolve(output, "source.json"), "utf8"),
  );
  assert.deepEqual(sourceIdentity, before.source);
  let fixture = null;
  const overlay = [];
  if (process.env.FIXTURE_SHA) {
    assert.ok(fixtureArg);
    const fixtureRoot = realpathSync(resolve(fixtureArg));
    fixture = identity(fixtureRoot, process.env.FIXTURE_SHA);
    const entries = files.map((path) => checkedFile(fixtureRoot, path));
    for (const { path } of entries) {
      const target = resolve(source, path);
      const inside = relative(source, target);
      assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
      assert.equal(
        existsSync(target),
        false,
        `Refuse existing overlay target ${path}`,
      );
      let ancestor = dirname(target);
      while (!existsSync(ancestor)) ancestor = dirname(ancestor);
      assert.equal(realpathSync(ancestor), ancestor);
    }
    for (const entry of entries) {
      const target = resolve(source, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(
        resolve(fixtureRoot, entry.path),
        target,
        constants.COPYFILE_EXCL,
      );
      assert.equal(sha256(readFileSync(target)), entry.sha256);
      overlay.push(entry);
    }
  } else {
    assert.equal(fixtureArg, undefined);
    for (const path of files) checkedFile(source, path);
  }
  assert.deepEqual(identity(source, process.env.SOURCE_SHA), before.source);
  write("overlay.json", {
    source: sourceIdentity,
    controls,
    fixture,
    kind: fixture ? "verifier-fixture-overlay" : "committed-head-fixture",
    overlay,
    productionDoctorUnchanged: true,
    trackedInputsClean: true,
  });
}
