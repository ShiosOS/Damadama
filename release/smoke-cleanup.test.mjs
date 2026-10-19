import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const [scenario, cleanupCalls, expectedMarkers] of [
  [
    "success",
    [
      "a.close.start",
      "a.close.complete",
      "b.close.start",
      "b.close.complete",
      "browser.close",
    ],
    [
      ["stage.browser.contexts.close", "start"],
      ["stage.browser.contexts.close", "complete"],
      ["stage.browser.close", "start"],
      ["stage.browser.close", "complete"],
    ],
  ],
  [
    "context-failure",
    ["a.close.start"],
    [
      ["stage.browser.contexts.close", "start"],
      ["stage.browser.contexts.close", "failed"],
    ],
  ],
  [
    "browser-failure",
    [
      "a.close.start",
      "a.close.complete",
      "b.close.start",
      "b.close.complete",
      "browser.close",
    ],
    [
      ["stage.browser.contexts.close", "start"],
      ["stage.browser.contexts.close", "complete"],
      ["stage.browser.close", "start"],
      ["stage.browser.close", "failed"],
    ],
  ],
])
  test(`actual smoke finally diagnoses ${scenario} and preserves sequential cleanup`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "damadama-smoke-cleanup-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./test-fixtures/smoke-cleanup.mjs", import.meta.url),
        ),
        scenario,
      ],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      calls: ["launch", "context", "context", "page", ...cleanupCalls],
      preserved: true,
    });
    const markers = result.stderr
      .trim()
      .split("\n")
      .map((line) => {
        assert.ok(line.startsWith("release-phase "));
        return JSON.parse(line.slice("release-phase ".length));
      });
    assert.deepEqual(
      markers.map(({ phase, event }) => [phase, event]),
      expectedMarkers,
    );
    for (let index = 0; index < markers.length; index += 2)
      assert.equal(markers[index + 1].invocation, markers[index].invocation);
  });
