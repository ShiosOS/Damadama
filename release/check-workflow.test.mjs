import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

for (const state of ["partial", "deleted"]) {
  test(`PR check shell refuses ${state} application roots`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "damadama-check-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const git = (...args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
    git("init");
    git("fetch", process.cwd(), "465b8165c1b4b0f29c4daed33d6f3a13b09a8e14");
    git("checkout", "--detach", "FETCH_HEAD");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.invalid");
    copyFileSync(
      "release/application.mjs",
      join(dir, "release/application.mjs"),
    );
    writeFileSync(join(dir, "package.json"), "{}");
    git("add", "package.json");
    git("commit", "-m", "install root");
    if (state === "deleted") {
      git("rm", "package.json");
      git("commit", "-m", "delete root");
    }
    const workflow = readFileSync(".github/workflows/check.yml", "utf8");
    const step = workflow.split("- id: application")[1].split("      - if:")[0];
    const command = step
      .replace(/^\s*run: ?(?:\|\r?\n)?/, "")
      .replace(/^          /gm, "")
      .trim();
    const output = join(dir, "output.txt");
    writeFileSync(output, "");
    const result = spawnSync(
      process.platform === "win32"
        ? "C:/Program Files/Git/bin/bash.exe"
        : "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
          GITHUB_OUTPUT: output,
        },
      },
    );
    assert.match(
      result.stderr,
      state === "partial"
        ? /partial application roots/
        : /deletion cannot reopen/,
    );
    assert.notEqual(
      result.status,
      0,
      `detector failed but shell succeeded and wrote ${JSON.stringify(readFileSync(output, "utf8"))}`,
    );
    assert.equal(readFileSync(output, "utf8"), "");
  });
}
