import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(
  new URL("docker-probe-source.mjs", import.meta.url),
);
const owned = resolve(import.meta.dirname, "../.audit/probe-adapter-tests");
mkdirSync(owned, { recursive: true });
const files = [
  "scripts/doctor-docker.test.ts",
  "scripts/fixtures/doctor-docker-child.ts",
  "scripts/fixtures/docker-doctorprobe/Program.cs",
  "scripts/fixtures/docker-doctorprobe/docker-doctorprobe.csproj",
  "scripts/fixtures/docker-doctorprobe/packages.lock.json",
];
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function setup(t, sourceHasFixture = false) {
  const root = mkdtempSync(resolve(owned, "case-"));
  t.after(() => {
    assert.equal(realpathSync(owned), owned);
    assert.equal(realpathSync(root), root);
    const child = relative(owned, root);
    assert.ok(child && !child.startsWith("..") && !isAbsolute(child));
    rmSync(root, { recursive: true });
  });
  const repositories = {};
  for (const name of ["source", "fixture"]) {
    const cwd = resolve(root, name);
    mkdirSync(resolve(cwd, "scripts"), { recursive: true });
    git(cwd, "init", "--quiet");
    git(cwd, "config", "user.name", "Verifier fixture");
    git(cwd, "config", "user.email", "verifier@example.invalid");
    git(cwd, "config", "core.autocrlf", "false");
    writeFileSync(resolve(cwd, ".gitignore"), ".audit/\n");
    writeFileSync(
      resolve(cwd, "scripts/doctor.ts"),
      `export const doctor = '${name}';\n`,
    );
    if (name === "fixture" || sourceHasFixture) {
      for (const path of files) {
        mkdirSync(dirname(resolve(cwd, path)), { recursive: true });
        writeFileSync(resolve(cwd, path), `owned fixture ${path}\n`);
      }
    }
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", "Fixture source");
    repositories[name] = { cwd, sha: git(cwd, "rev-parse", "HEAD") };
  }
  const invoke = (operation, overlay = true) =>
    spawnSync(
      process.execPath,
      [
        script,
        operation,
        repositories.source.cwd,
        ...(operation === "prepare" && overlay
          ? [repositories.fixture.cwd]
          : []),
      ],
      {
        env: {
          ...process.env,
          SOURCE_SHA: repositories.source.sha,
          CONTROLS_SHA: git(
            resolve(import.meta.dirname, ".."),
            "rev-parse",
            "HEAD",
          ),
          FIXTURE_SHA: overlay ? repositories.fixture.sha : "",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
  return { ...repositories, invoke };
}

test("parent overlay preserves production bytes and records all five committed fixture hashes", (t) => {
  const { source, fixture, invoke } = setup(t);
  const before = readFileSync(resolve(source.cwd, "scripts/doctor.ts"));
  assert.equal(invoke("record").status, 0);
  const result = invoke("prepare");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    readFileSync(resolve(source.cwd, "scripts/doctor.ts")),
    before,
  );
  const receipt = JSON.parse(
    readFileSync(
      resolve(source.cwd, ".audit/independent-docker-probe/overlay.json"),
    ),
  );
  assert.equal(receipt.source.sha, source.sha);
  assert.equal(receipt.fixture.sha, fixture.sha);
  assert.notEqual(receipt.source.doctorBlob, receipt.fixture.doctorBlob);
  assert.equal(receipt.kind, "verifier-fixture-overlay");
  assert.deepEqual(
    receipt.overlay.map(({ path }) => path),
    files,
  );
  for (const path of files) {
    assert.deepEqual(
      readFileSync(resolve(source.cwd, path)),
      readFileSync(resolve(fixture.cwd, path)),
    );
  }
  assert.equal(git(source.cwd, "diff", "--name-only", "HEAD"), "");
});

test("parent overlay refuses any existing target before copying files", (t) => {
  const { source, invoke } = setup(t);
  assert.equal(invoke("record").status, 0);
  const collision = resolve(source.cwd, files.at(-1));
  mkdirSync(dirname(collision), { recursive: true });
  writeFileSync(collision, "keep this file\n");
  const result = invoke("prepare");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refuse existing overlay target/);
  assert.equal(readFileSync(collision, "utf8"), "keep this file\n");
  assert.equal(existsSync(resolve(source.cwd, files[0])), false);
});

test("parent overlay refuses fixture bytes changed after checkout", (t) => {
  const { fixture, source, invoke } = setup(t);
  assert.equal(invoke("record").status, 0);
  writeFileSync(resolve(fixture.cwd, files[0]), "changed after commit\n");
  assert.notEqual(invoke("prepare").status, 0);
  assert.equal(existsSync(resolve(source.cwd, files[0])), false);
});

test("head proof uses its committed fixture without an overlay", (t) => {
  const { source, invoke } = setup(t, true);
  assert.equal(invoke("record", false).status, 0);
  const result = invoke("prepare", false);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(
    readFileSync(
      resolve(source.cwd, ".audit/independent-docker-probe/overlay.json"),
    ),
  );
  assert.equal(receipt.source.sha, source.sha);
  assert.equal(receipt.fixture, null);
  assert.equal(receipt.kind, "committed-head-fixture");
  assert.deepEqual(receipt.overlay, []);
});
