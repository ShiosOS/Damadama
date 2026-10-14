import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { publishImages } from "./publication.mjs";
import { requireVerifiedRecord } from "./policy.mjs";

const source = {
  repository: "ShiosOS/Damadama",
  pr: 11,
  head: "1111111111111111111111111111111111111111",
  base: "2222222222222222222222222222222222222222",
  merge: "3333333333333333333333333333333333333333",
  tree: "4444444444444444444444444444444444444444",
};
const authority = { sha: source.base, runId: 42, attempt: 2 };
const recoverySource = {
  repository: "ShiosOS/Damadama",
  commit: source.base,
  tree: "5555555555555555555555555555555555555555",
};
const ci = ["release-controls", "check"].map((name, i) => ({
  name,
  id: 100 + i,
  head_sha: source.head,
  app: { id: 15368 },
  status: "completed",
  conclusion: "success",
  details_url: `https://github.com/ShiosOS/Damadama/actions/runs/10/job/${100 + i}`,
}));
const jobs = ["source", "build-app", "build-recovery"].map((name, i) => ({
  name,
  id: 200 + i,
  run_id: 42,
  head_sha: source.base,
  status: "completed",
  conclusion: "success",
}));

async function fixture(t) {
  Object.assign(process.env, {
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "ShiosOS/Damadama",
    GITHUB_SHA: source.base,
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_ACTOR: "operator",
    GH_TOKEN: "test-only-registry-token",
  });
  const record = {
    schema: 1,
    source: structuredClone(source),
    authority: { ...authority },
  };
  const responses = {
    "git/ref/heads/main": { object: { sha: source.base } },
    "pulls/11": {
      state: "open",
      base: { ref: "main", sha: source.base },
      head: { sha: source.head, repo: { full_name: "ShiosOS/Damadama" } },
      merge_commit_sha: source.merge,
    },
    [`git/commits/${source.merge}`]: {
      sha: source.merge,
      tree: { sha: source.tree },
      parents: [{ sha: source.base }, { sha: source.head }],
    },
    [`compare/${source.base}...${source.head}`]: { status: "ahead" },
    [`git/commits/${source.head}`]: {
      sha: source.head,
      tree: { sha: source.tree },
    },
    [`git/commits/${source.base}`]: {
      sha: source.base,
      tree: { sha: recoverySource.tree },
    },
    [`commits/${source.head}/check-runs?per_page=100&filter=latest`]: {
      check_runs: structuredClone(ci),
    },
    "actions/runs/42": {
      id: 42,
      run_attempt: 2,
      event: "workflow_dispatch",
      path: ".github/workflows/publish-images.yml",
      head_branch: "main",
      head_sha: source.base,
      repository: { full_name: "ShiosOS/Damadama" },
      status: "in_progress",
    },
    "actions/runs/42/attempts/2/jobs?per_page=100": {
      total_count: 4,
      jobs: structuredClone(jobs),
    },
    "actions/runs/42/approvals": [
      {
        state: "approved",
        environments: [{ name: "image-publication" }],
        user: { id: 123, login: "operator" },
      },
    ],
  };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(
      options.headers.Authorization,
      "Bearer test-only-registry-token",
    );
    const path = url.replace(
      "https://api.github.com/repos/ShiosOS/Damadama/",
      "",
    );
    assert.ok(
      Object.hasOwn(responses, path),
      `unexpected GitHub request ${url}`,
    );
    requests.push(path);
    return new Response(JSON.stringify(responses[path]), { status: 200 });
  });
  const directory = await mkdtemp(join(tmpdir(), "damadama-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archives = {};
  for (const kind of ["application", "recovery"]) {
    const bytes = Buffer.from(`${kind}-image-fixture`);
    const archivePath = join(directory, `${kind}.tar`);
    await writeFile(archivePath, bytes);
    archives[kind] = {
      archivePath,
      build: {
        kind,
        source: kind === "application" ? source : recoverySource,
        authority,
        version:
          kind === "application"
            ? "pr-11-111111111111-222222222222"
            : "main-222222222222",
        archiveSha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  }
  const commands = [];
  function execute(command, args, options) {
    assert.equal(command, "docker");
    commands.push(args);
    if (args[0] === "load")
      return `Loaded image: ${args[2] === archives.application.archivePath ? "damadama-candidate" : "damadama-recovery-candidate"}:latest\n`;
    if (args[0] === "login")
      assert.equal(options.input, "test-only-registry-token");
    if (args[0] === "push")
      return `digest: sha256:${(args[1].startsWith("ghcr.io/shiosos/damadama-recovery:") ? "b" : "a").repeat(64)}`;
    return "";
  }
  return { record, responses, requests, archives, commands, execute };
}

test("approved current builds publish two immutable images without runtime success", async (t) => {
  const f = await fixture(t);
  const receipt = await publishImages(f.record, f.archives, f.execute);
  assert.deepEqual(receipt, {
    schema: 1,
    kind: "image-publication",
    authority,
    reviewers: [{ id: 123, login: "operator" }],
    application: {
      source,
      image: {
        reference: `ghcr.io/shiosos/damadama@sha256:${"a".repeat(64)}`,
        digest: `sha256:${"a".repeat(64)}`,
        archiveSha256: f.archives.application.build.archiveSha256,
        version: "pr-11-111111111111-222222222222",
      },
    },
    recovery: {
      source: recoverySource,
      image: {
        reference: `ghcr.io/shiosos/damadama-recovery@sha256:${"b".repeat(64)}`,
        digest: `sha256:${"b".repeat(64)}`,
        archiveSha256: f.archives.recovery.build.archiveSha256,
        version: "main-222222222222",
      },
    },
    evidence: { ci },
  });
  assert.equal(f.commands.filter((args) => args[0] === "push").length, 2);
  assert.ok(
    f.requests.includes("actions/runs/42/attempts/2/jobs?per_page=100"),
  );
  assert.throws(() => requireVerifiedRecord(receipt), /wrong repository/);
});

for (const [label, change, error] of [
  [
    "another workflow",
    (f) => {
      f.responses["actions/runs/42"].path = ".github/workflows/stage.yml";
    },
    /trusted publication workflow/,
  ],
  [
    "another run attempt",
    (f) => {
      f.responses["actions/runs/42"].run_attempt = 1;
    },
    /trusted publication workflow/,
  ],
  [
    "skipped recovery build",
    (f) => {
      f.responses[
        "actions/runs/42/attempts/2/jobs?per_page=100"
      ].jobs[2].conclusion = "skipped";
    },
    /build-recovery must succeed/,
  ],
  [
    "approval for deployment only",
    (f) => {
      f.responses["actions/runs/42/approvals"][0].environments[0].name =
        "staging";
    },
    /image-publication environment approval is missing/,
  ],
  [
    "failed current CI",
    (f) => {
      f.responses[
        `commits/${source.head}/check-runs?per_page=100&filter=latest`
      ].check_runs[1].conclusion = "failure";
    },
    /CI check must succeed/,
  ],
  [
    "changed recovery archive",
    (f) => writeFile(f.archives.recovery.archivePath, "changed"),
    /image archive differs/,
  ],
  [
    "another recovery tree",
    (f) => {
      f.archives.recovery.build.source = {
        ...recoverySource,
        tree: source.tree,
      };
    },
    /image source differs/,
  ],
]) {
  test(`publication refuses ${label} before any Docker operation`, async (t) => {
    const f = await fixture(t);
    await change(f);
    await assert.rejects(publishImages(f.record, f.archives, f.execute), error);
    assert.deepEqual(f.commands, []);
  });
}

test("main moving after the first push refuses the second push and receipt", async (t) => {
  const f = await fixture(t);
  const execute = (command, args, options) => {
    const result = f.execute(command, args, options);
    if (args[0] === "push")
      f.responses["git/ref/heads/main"].object.sha =
        "6666666666666666666666666666666666666666";
    return result;
  };
  await assert.rejects(
    publishImages(f.record, f.archives, execute),
    /main advanced/,
  );
  assert.equal(f.commands.filter((args) => args[0] === "push").length, 1);
});

for (const interruptedReads of [1, 3]) {
  test(`final freshness read with ${interruptedReads} socket failures never repeats image pushes`, async (t) => {
    const f = await fixture(t);
    const fetch = globalThis.fetch;
    let finalReadAttempts = 0;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (
        f.commands.filter((args) => args[0] === "push").length === 2 &&
        url.endsWith("git/ref/heads/main") &&
        finalReadAttempts < interruptedReads
      ) {
        finalReadAttempts += 1;
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("other side closed"), {
            code: "UND_ERR_SOCKET",
          }),
        });
      }
      return fetch(url, options);
    });

    const publication = publishImages(f.record, f.archives, f.execute);
    if (interruptedReads === 1) {
      const receipt = await publication;
      assert.deepEqual(
        [
          receipt.kind,
          receipt.application.image.digest,
          receipt.recovery.image.digest,
        ],
        [
          "image-publication",
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ],
      );
    } else {
      await assert.rejects(publication, {
        name: "TypeError",
        message:
          "GitHub GET repos/ShiosOS/Damadama/git/ref/heads/main failed after 3 attempts: fetch failed",
      });
    }
    assert.equal(finalReadAttempts, interruptedReads);
    assert.deepEqual(
      f.commands.filter((args) => args[0] === "push"),
      [
        [
          "push",
          "ghcr.io/shiosos/damadama:pr-11-111111111111-222222222222-42-2",
        ],
        ["push", "ghcr.io/shiosos/damadama-recovery:main-222222222222-42-2"],
      ],
    );
  });
}

test("a failed second push emits no publication receipt", async (t) => {
  const f = await fixture(t);
  const execute = (command, args, options) => {
    if (
      args[0] === "push" &&
      args[1].startsWith("ghcr.io/shiosos/damadama-recovery:")
    )
      throw new Error("recorded registry refusal");
    return f.execute(command, args, options);
  };
  await assert.rejects(
    publishImages(f.record, f.archives, execute),
    /recorded registry refusal/,
  );
});
