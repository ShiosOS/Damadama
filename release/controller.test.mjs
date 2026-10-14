import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requireController,
  requireFreshCandidate,
  requireApproval,
} from "./controller.mjs";

const controllerEnvironment = {
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "ShiosOS/Damadama",
  GITHUB_SHA: "2222222222222222222222222222222222222222",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "2",
  GH_TOKEN: "recorded-github-fixture-token",
};

function recordedGitHub(t, responses, environment = {}) {
  Object.assign(process.env, controllerEnvironment, environment);
  const pending = structuredClone(responses);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const expected = pending.shift();
    assert.ok(expected, `unexpected GitHub request ${url}`);
    assert.equal(url, `https://api.github.com/${expected.path}`);
    assert.equal(options.method, "GET");
    assert.equal(
      options.headers.Authorization,
      "Bearer recorded-github-fixture-token",
    );
    return new Response(JSON.stringify(expected.body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  t.after(() =>
    assert.deepEqual(pending, [], "all recorded responses consumed"),
  );
}

function currentMain(sha = "2222222222222222222222222222222222222222") {
  return {
    path: "repos/ShiosOS/Damadama/git/ref/heads/main",
    body: { ref: "refs/heads/main", object: { type: "commit", sha } },
  };
}

test("controller returns the current main run authority", async (t) => {
  recordedGitHub(t, [currentMain()]);
  assert.deepEqual(await requireController(), {
    sha: "2222222222222222222222222222222222222222",
    runId: 42,
    attempt: 2,
  });
});

for (const [reason, environment] of [
  ["non-main ref", { GITHUB_REF: "refs/pull/11/merge" }],
  ["wrong repository", { GITHUB_REPOSITORY: "someone/Damadama" }],
]) {
  test(`controller refuses ${reason}`, async (t) => {
    recordedGitHub(t, [], environment);
    await assert.rejects(
      requireController(),
      new Error("release controls must run on main in Damadama"),
    );
  });
}

test("controller refuses main advancing after dispatch", async (t) => {
  recordedGitHub(t, [currentMain("6666666666666666666666666666666666666666")]);
  await assert.rejects(
    requireController(),
    new Error("main advanced while this controller was queued; dispatch again"),
  );
});

function candidate() {
  return {
    schema: 1,
    source: {
      repository: "ShiosOS/Damadama",
      pr: 11,
      head: "1111111111111111111111111111111111111111",
      base: "2222222222222222222222222222222222222222",
      merge: "3333333333333333333333333333333333333333",
      tree: "4444444444444444444444444444444444444444",
    },
    authority: {
      sha: "2222222222222222222222222222222222222222",
      runId: 42,
      attempt: 2,
    },
  };
}

function currentSourceResponses() {
  return [
    currentMain(),
    {
      path: "repos/ShiosOS/Damadama/pulls/11",
      body: {
        number: 11,
        state: "open",
        base: {
          ref: "main",
          sha: "2222222222222222222222222222222222222222",
        },
        head: {
          sha: "1111111111111111111111111111111111111111",
          repo: { full_name: "ShiosOS/Damadama" },
        },
        merge_commit_sha: "3333333333333333333333333333333333333333",
      },
    },
    currentMain(),
    {
      path: "repos/ShiosOS/Damadama/git/commits/3333333333333333333333333333333333333333",
      body: {
        sha: "3333333333333333333333333333333333333333",
        tree: { sha: "4444444444444444444444444444444444444444" },
        parents: [
          { sha: "2222222222222222222222222222222222222222" },
          { sha: "1111111111111111111111111111111111111111" },
        ],
      },
    },
    {
      path: "repos/ShiosOS/Damadama/compare/2222222222222222222222222222222222222222...1111111111111111111111111111111111111111",
      body: { status: "ahead" },
    },
    {
      path: "repos/ShiosOS/Damadama/git/commits/1111111111111111111111111111111111111111",
      body: {
        sha: "1111111111111111111111111111111111111111",
        tree: { sha: "4444444444444444444444444444444444444444" },
      },
    },
  ];
}

function successfulChecks() {
  return [
    {
      name: "release-controls",
      id: 7001,
      head_sha: "1111111111111111111111111111111111111111",
      app: { id: 15368, slug: "github-actions" },
      status: "completed",
      conclusion: "success",
      details_url:
        "https://github.com/ShiosOS/Damadama/actions/runs/100/job/7001",
      output: { title: "release controls passed" },
    },
    {
      name: "check",
      id: 7002,
      head_sha: "1111111111111111111111111111111111111111",
      app: { id: 15368, slug: "github-actions" },
      status: "completed",
      conclusion: "success",
      details_url:
        "https://github.com/ShiosOS/Damadama/actions/runs/100/job/7002",
      output: { title: "application check passed" },
    },
  ];
}

function freshResponses(body) {
  return [
    ...currentSourceResponses(),
    {
      path: "repos/ShiosOS/Damadama/commits/1111111111111111111111111111111111111111/check-runs?per_page=100&filter=latest",
      body,
    },
  ];
}

test("fresh candidate returns normalized actual Actions CI evidence", async (t) => {
  recordedGitHub(
    t,
    freshResponses({
      total_count: 2,
      check_runs: successfulChecks().reverse(),
    }),
  );
  assert.deepEqual(await requireFreshCandidate(candidate()), [
    {
      name: "release-controls",
      id: 7001,
      head_sha: "1111111111111111111111111111111111111111",
      app: { id: 15368 },
      status: "completed",
      conclusion: "success",
      details_url:
        "https://github.com/ShiosOS/Damadama/actions/runs/100/job/7001",
    },
    {
      name: "check",
      id: 7002,
      head_sha: "1111111111111111111111111111111111111111",
      app: { id: 15368 },
      status: "completed",
      conclusion: "success",
      details_url:
        "https://github.com/ShiosOS/Damadama/actions/runs/100/job/7002",
    },
  ]);
});

for (const [field, value] of [
  ["sha", "5555555555555555555555555555555555555555"],
  ["runId", 43],
  ["attempt", 1],
]) {
  test(`fresh candidate refuses another controller ${field}`, async (t) => {
    recordedGitHub(t, [currentMain()]);
    const record = candidate();
    record.authority[field] = value;
    await assert.rejects(
      requireFreshCandidate(record),
      new Error("candidate belongs to another controller run"),
    );
  });
}

for (const field of ["head", "base", "merge", "tree"]) {
  test(`fresh candidate refuses stale source ${field}`, async (t) => {
    recordedGitHub(t, currentSourceResponses());
    const record = candidate();
    record.source[field] = "7777777777777777777777777777777777777777";
    await assert.rejects(
      requireFreshCandidate(record),
      new Error(`stale ${field}; stage the current proposed result again`),
    );
  });
}

for (const [reason, change, required] of [
  [
    "missing check-runs",
    (body) => {
      delete body.check_runs;
    },
    "release-controls",
  ],
  [
    "missing required job",
    (body) => {
      body.check_runs.pop();
    },
    "check",
  ],
  [
    "failed job",
    (body) => {
      body.check_runs[0].conclusion = "failure";
    },
    "release-controls",
  ],
  [
    "unfinished job",
    (body) => {
      body.check_runs[0].status = "in_progress";
    },
    "release-controls",
  ],
  [
    "skipped job",
    (body) => {
      body.check_runs[0].conclusion = "skipped";
    },
    "release-controls",
  ],
  [
    "other App",
    (body) => {
      body.check_runs[0].app.id = 9001;
    },
    "release-controls",
  ],
  [
    "other source",
    (body) => {
      body.check_runs[0].head_sha = "3333333333333333333333333333333333333333";
    },
    "release-controls",
  ],
]) {
  test(`fresh candidate refuses actual CI ${reason}`, async (t) => {
    const body = { total_count: 2, check_runs: successfulChecks() };
    change(body);
    recordedGitHub(t, freshResponses(body));
    await assert.rejects(
      requireFreshCandidate(candidate()),
      new Error(
        `CI ${required} must succeed on the current head; skipped, missing, or other-source evidence is insufficient`,
      ),
    );
  });
}

function approvalResponses(body) {
  return [
    {
      path: "repos/ShiosOS/Damadama/actions/runs/42/approvals",
      body,
    },
  ];
}

test("approval returns only reviewers approving the exact environment", async (t) => {
  recordedGitHub(
    t,
    approvalResponses([
      {
        state: "approved",
        environments: [{ id: 1, name: "image-publication" }],
        user: { id: 123, login: "release-reviewer", type: "User" },
      },
      {
        state: "rejected",
        environments: [{ id: 1, name: "image-publication" }],
        user: { id: 456, login: "rejecting-reviewer", type: "User" },
      },
      {
        state: "approved",
        environments: [{ id: 2, name: "staging" }],
        user: { id: 789, login: "staging-reviewer", type: "User" },
      },
      {
        state: "approved",
        environments: [
          { id: 2, name: "staging" },
          { id: 1, name: "image-publication" },
        ],
        user: { id: 321, login: "second-reviewer", type: "User" },
      },
    ]),
  );
  assert.deepEqual(await requireApproval("image-publication"), [
    { id: 123, login: "release-reviewer" },
    { id: 321, login: "second-reviewer" },
  ]);
});

for (const [reason, reviews] of [
  ["missing review", []],
  [
    "rejected review",
    [
      {
        state: "rejected",
        environments: [{ id: 1, name: "image-publication" }],
        user: { id: 123, login: "release-reviewer" },
      },
    ],
  ],
  [
    "other environment",
    [
      {
        state: "approved",
        environments: [{ id: 2, name: "image-publication-other" }],
        user: { id: 123, login: "release-reviewer" },
      },
    ],
  ],
]) {
  test(`approval refuses ${reason}`, async (t) => {
    recordedGitHub(t, approvalResponses(reviews));
    await assert.rejects(
      requireApproval("image-publication"),
      new Error("explicit image-publication environment approval is missing"),
    );
  });
}

test("approval retains the existing staging environment boundary", async (t) => {
  recordedGitHub(
    t,
    approvalResponses([
      {
        state: "approved",
        environments: [{ id: 2, name: "staging" }],
        user: { id: 789, login: "staging-reviewer", type: "User" },
      },
    ]),
  );
  assert.deepEqual(await requireApproval("staging"), [
    { id: 789, login: "staging-reviewer" },
  ]);
});
