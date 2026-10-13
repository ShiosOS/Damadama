import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("the publication workflow confines package write to its secretless approval job", async () => {
  const workflow = (
    await readFile(
      new URL("../.github/workflows/publish-images.yml", import.meta.url),
      "utf8",
    )
  ).replaceAll("\r\n", "\n");
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|id-token:|checks: write|actions: write|contents: write|pull_request_target:/,
  );
  assert.equal(workflow.match(/packages: write/g)?.length, 1);
  const publisher = workflow.slice(workflow.indexOf("  publish:\n"));
  assert.match(publisher, /environment: image-publication/);
  assert.match(publisher, /packages: write/);
  assert.deepEqual(
    [...publisher.matchAll(/run: (.+)/g)].map((match) => match[1]),
    ["node controls/release/publish-images.mjs publish"],
  );
  assert.deepEqual(
    [...publisher.matchAll(/ref: (.+)/g)].map((match) => match[1]),
    ["${{ github.sha }}"],
  );
  assert.doesNotMatch(
    publisher,
    /path: candidate|cache:|npm |bun |docker build|run-id:/,
  );
  assert.match(workflow, /run: node controls\/release\/package-recovery.mjs/);
});

test("publication reaches only the fixed GitHub and Docker control modules", async () => {
  const expected = {
    "publish-images.mjs": [
      "./controller.mjs",
      "./github.mjs",
      "./publication.mjs",
    ],
    "publication.mjs": [
      "./github.mjs",
      "./controller.mjs",
      "./policy.mjs",
      "./images.mjs",
    ],
    "controller.mjs": ["./github.mjs", "./policy.mjs"],
    "images.mjs": ["./policy.mjs"],
    "github.mjs": ["./policy.mjs"],
    "policy.mjs": [],
  };
  for (const [file, imports] of Object.entries(expected)) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.deepEqual(
      [...source.matchAll(/from "(\.\/[^\"]+)"/g)].map((match) => match[1]),
      imports,
      file,
    );
    assert.doesNotMatch(
      source,
      /RAILWAY_|CLERK_|STAGING_CHECK_TOKEN|import\(|node_modules\//,
      file,
    );
  }
});
