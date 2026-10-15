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

const source = {
  repository: "ShiosOS/Damadama",
  commit: "2".repeat(40),
  tree: "4".repeat(40),
};
const authority = { sha: source.commit, runId: 42, attempt: 2 };
const candidate = () => ({
  schema: 2,
  source: { ...source },
  authority: { ...authority },
});
const jobs = () =>
  ["release-controls", "check"].map((name, i) => ({
    name,
    id: 7001 + i,
    head_sha: source.commit,
    run_id: 42,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/ShiosOS/Damadama/actions/runs/42/job/${7001 + i}`,
  }));
function currentSourceResponses() {
  return [
    currentMain(),
    currentMain(),
    {
      path: `repos/ShiosOS/Damadama/git/commits/${source.commit}`,
      body: { sha: source.commit, tree: { sha: source.tree } },
    },
  ];
}
function freshResponses(evidence = jobs(), runChange = {}) {
  return [
    ...currentSourceResponses(),
    {
      path: "repos/ShiosOS/Damadama/actions/runs/42",
      body: {
        id: 42,
        run_attempt: 2,
        event: "push",
        path: ".github/workflows/stage.yml",
        head_branch: "main",
        head_sha: source.commit,
        repository: { full_name: source.repository },
        ...runChange,
      },
    },
    {
      path: "repos/ShiosOS/Damadama/actions/runs/42/attempts/2/jobs?per_page=100",
      body: { total_count: evidence.length, jobs: evidence },
    },
  ];
}
test("fresh candidate returns actual same-attempt job evidence", async (t) => {
  recordedGitHub(t, freshResponses());
  assert.deepEqual(await requireFreshCandidate(candidate()), jobs());
});
for (const [field, value] of [
  ["sha", "5".repeat(40)],
  ["runId", 43],
  ["attempt", 1],
])
  test(`fresh candidate refuses other controller ${field}`, async (t) => {
    recordedGitHub(t, [currentMain()]);
    const r = candidate();
    r.authority[field] = value;
    await assert.rejects(requireFreshCandidate(r), /another controller run/);
  });
for (const field of ["commit", "tree"])
  test(`fresh candidate refuses stale ${field}`, async (t) => {
    const r = candidate();
    r.source[field] = "7".repeat(40);
    recordedGitHub(
      t,
      field === "commit"
        ? [currentMain(), currentMain()]
        : currentSourceResponses(),
    );
    await assert.rejects(requireFreshCandidate(r), /superseded|stale/);
  });
for (const [field, value] of [
  ["head_sha", "3".repeat(40)],
  ["run_id", 43],
  ["run_attempt", 1],
  ["status", "in_progress"],
  ["conclusion", "skipped"],
  ["conclusion", "failure"],
])
  test(`fresh candidate refuses invalid CI ${field} ${value}`, async (t) => {
    const evidence = jobs();
    evidence[0][field] = value;
    recordedGitHub(t, freshResponses(evidence));
    await assert.rejects(requireFreshCandidate(candidate()), /CI/);
  });
test("PR workflow success cannot authorize main staging", async (t) => {
  const responses = freshResponses(jobs(), { event: "pull_request" });
  responses.pop();
  recordedGitHub(t, responses);
  await assert.rejects(requireFreshCandidate(candidate()), /workflow/);
});

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
        environments: [{ id: 1, name: "production" }],
        user: { id: 123, login: "release-reviewer", type: "User" },
      },
      {
        state: "rejected",
        environments: [{ id: 1, name: "production" }],
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
          { id: 1, name: "production" },
        ],
        user: { id: 321, login: "second-reviewer", type: "User" },
      },
    ]),
  );
  assert.deepEqual(await requireApproval("production"), [
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
        environments: [{ id: 1, name: "production" }],
        user: { id: 123, login: "release-reviewer" },
      },
    ],
  ],
  [
    "other environment",
    [
      {
        state: "approved",
        environments: [{ id: 2, name: "production-other" }],
        user: { id: 123, login: "release-reviewer" },
      },
    ],
  ],
]) {
  test(`approval refuses ${reason}`, async (t) => {
    recordedGitHub(t, approvalResponses(reviews));
    await assert.rejects(
      requireApproval("production"),
      new Error("explicit production environment approval is missing"),
    );
  });
}
