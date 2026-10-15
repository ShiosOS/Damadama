import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as application from "./application.mjs";
test("approved controls baseline is nondeployable", () => {
  assert.equal(
    application.applicationState("465b8165c1b4b0f29c4daed33d6f3a13b09a8e14"),
    "setup",
  );
});
test("unrooted absence refuses setup", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "damadama-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, "README"), "controls");
  git("add", ".");
  git("commit", "-m", "controls");
  assert.throws(
    () => application.applicationState(git("rev-parse", "HEAD"), dir),
    /baseline/,
  );
});

test("application deletion cannot reopen the baseline setup exception", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "damadama-deletion-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("fetch", process.cwd(), "465b8165c1b4b0f29c4daed33d6f3a13b09a8e14");
  git("checkout", "--detach", "FETCH_HEAD");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, "package.json"), "{}");
  git("add", "package.json");
  git("commit", "-m", "install application root");
  assert.throws(
    () => application.applicationState(git("rev-parse", "HEAD"), dir),
    /partial/,
  );
  git("rm", "package.json");
  git("commit", "-m", "delete application root");
  assert.throws(
    () => application.applicationState(git("rev-parse", "HEAD"), dir),
    /deletion cannot reopen/,
  );
});
