import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publicChecks } from "../../release/smoke.mjs";
import {
  checkNames,
  failureReceipt,
  origin,
  passedReceipt,
  providerConfig,
  readInputs,
  receiptPath,
  requirePageOrigin,
  requireReceipt,
  requireSession,
  requireSignedOut,
} from "./policy.mjs";

const sha = "a".repeat(40);
const commit = "b".repeat(40);
const tree = "c".repeat(40);
const env = {
  APP_ORIGIN: origin,
  EXPECTED_SOURCE_SHA: commit,
  GITHUB_SHA: sha,
  CLERK_PUBLISHABLE_KEY: "pk_live_synthetic",
  CLERK_SECRET_KEY: "sk_live_synthetic",
  CLERK_TEST_USER_A: "user_synthetic",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "ShiosOS/Damadama",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF:
    "ShiosOS/Damadama/.github/workflows/provider-smoke.yml@refs/heads/main",
};
const checkout = { head: sha, tree, isAncestor: true };
const config = providerConfig(readInputs(env), checkout);
const checks = Object.fromEntries(checkNames.map((name) => [name, true]));
const signedOut = {
  sessionAbsent: true,
  userAbsent: true,
  activeSessions: 0,
  protectedVisible: false,
  signInVisible: true,
};

function rejectsCode(action, code) {
  assert.throws(
    action,
    (error) => error.code === code && error.message.length > 15,
  );
}

test("approved staging inputs produce separate deployed and controls identities", () => {
  assert.deepEqual(config.source, {
    repository: "ShiosOS/Damadama",
    commit,
    tree,
  });
  assert.equal(config.controlsSha, sha);
  assert.equal(config.accountA, env.CLERK_TEST_USER_A);
});

test("every required provider input refuses missing setup", () => {
  for (const name of [
    "APP_ORIGIN",
    "EXPECTED_SOURCE_SHA",
    "GITHUB_SHA",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_TEST_USER_A",
  ]) {
    rejectsCode(() => readInputs({ ...env, [name]: "" }), "missing-config");
  }
});

test("provider execution rejects untrusted event, checkout ref, repository, or workflow identity", () => {
  for (const [name, value] of [
    ["GITHUB_ACTIONS", "false"],
    ["GITHUB_EVENT_NAME", "pull_request_target"],
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_REPOSITORY", "fork/Damadama"],
    ["GITHUB_REF", "refs/heads/codex/provider-auth-smoke"],
    [
      "GITHUB_WORKFLOW_REF",
      "ShiosOS/Damadama/.github/workflows/other.yml@refs/heads/main",
    ],
    [
      "GITHUB_WORKFLOW_REF",
      "ShiosOS/Damadama/.github/workflows/provider-smoke.yml@refs/heads/other",
    ],
  ])
    rejectsCode(() => readInputs({ ...env, [name]: value }), "invalid-context");
});

test("configuration rejects alternate origins, malformed SHAs, development keys, and unapproved account shapes", () => {
  for (const [name, value] of [
    ["APP_ORIGIN", "https://damadama.app"],
    ["APP_ORIGIN", `${origin}/`],
    ["APP_ORIGIN", `${origin}.example.com`],
    ["APP_ORIGIN", "http://staging.damadama.app"],
    ["EXPECTED_SOURCE_SHA", "main"],
    ["EXPECTED_SOURCE_SHA", sha.toUpperCase()],
    ["GITHUB_SHA", "--help"],
    ["CLERK_PUBLISHABLE_KEY", "pk_test_example"],
    ["CLERK_SECRET_KEY", "sk_test_example"],
    ["CLERK_TEST_USER_A", "someone@example.com"],
  ])
    rejectsCode(() => readInputs({ ...env, [name]: value }), "invalid-config");
});

test("source must be an ancestor of the exact controls checkout and have a Git tree SHA", () => {
  for (const change of [
    { head: commit },
    { isAncestor: false },
    { tree: "main" },
    { tree: null },
  ]) {
    rejectsCode(
      () => providerConfig(readInputs(env), { ...checkout, ...change }),
      "invalid-checkout",
    );
  }
});

test("ticket injection accepts the approved page origin and refuses navigation away", () => {
  requirePageOrigin(`${origin}/#/sign-in`, origin);
  for (const url of [
    "about:blank",
    "https://example.com",
    `${origin}.example.com`,
    "not a URL",
  ]) {
    rejectsCode(() => requirePageOrigin(url, origin), "sign-in-ui");
  }
});

test("ordinary session proof requires an active session bound to the synthetic account", () => {
  const session = {
    id: "sess_synthetic",
    status: "active",
    userId: config.accountA,
    sessionUserId: config.accountA,
  };
  requireSession(session, config.accountA);
  requireSession(session, config.accountA, "signed-in-reload", session.id);
  rejectsCode(
    () =>
      requireSession(
        session,
        config.accountA,
        "signed-in-reload",
        "sess_other",
      ),
    "signed-in-reload",
  );
  for (const change of [
    { id: null },
    { status: "pending" },
    { userId: "user_other" },
    { sessionUserId: "user_other" },
  ]) {
    rejectsCode(
      () => requireSession({ ...session, ...change }, config.accountA),
      "ordinary-session",
    );
  }
  rejectsCode(
    () =>
      requireSession(
        { ...session, status: "ended" },
        config.accountA,
        "signed-in-reload",
      ),
    "signed-in-reload",
  );
});

test("signed-out proof refuses residual session, user, protected UI, and missing SignIn", () => {
  requireSignedOut(signedOut, "signed-out");
  for (const change of [
    { sessionAbsent: false },
    { userAbsent: false },
    { activeSessions: 1 },
    { protectedVisible: true },
    { signInVisible: false },
  ]) {
    rejectsCode(
      () => requireSignedOut({ ...signedOut, ...change }, "signed-out"),
      "signed-out",
    );
  }
  rejectsCode(
    () =>
      requireSignedOut(
        { ...signedOut, sessionAbsent: false },
        "signed-out-reload",
      ),
    "signed-out-reload",
  );
});

test("pass receipt includes only complete new session proof and no credentials or account IDs", () => {
  const receipt = passedReceipt(config, checks);
  assert.equal(requireReceipt(receipt), receipt);
  assert.equal(receipt.emailDelivery, "not-exercised");
  assert.equal(receipt.testingToken, "not-used");
  for (const sensitive of [
    config.secretKey,
    config.publishableKey,
    config.accountA,
    "habitsBeforeReload",
    "ownership",
  ]) {
    assert.equal(JSON.stringify(receipt).includes(sensitive), false);
  }
  for (const name of checkNames)
    rejectsCode(
      () => passedReceipt(config, { ...checks, [name]: false }),
      "public-after",
    );
  rejectsCode(
    () => passedReceipt(config, { ...checks, ownership: true }),
    "public-after",
  );
});

test("receipt boundary rejects unknown and token-like fields and values", () => {
  const receipt = passedReceipt(config, checks);
  for (const changed of [
    { ...receipt, token: "Bearer secret" },
    {
      ...receipt,
      source: { ...receipt.source, authorization: "Bearer secret" },
    },
    { ...receipt, checks: { ...checks, token: "eyJhbGci.abc.signature" } },
    { ...receipt, controlsSha: "Bearer secret" },
    { ...receipt, mechanism: "eyJhbGci.abc.signature" },
    { ...receipt, checks: { ...checks, ordinarySession: "Bearer secret" } },
    { ...receipt, emailDelivery: "verified" },
    { ...failureReceipt("ticket"), message: "sk_live_doNotPrint" },
    { ...failureReceipt("ticket"), stack: "a raw provider error" },
    { schema: 1, outcome: "passed" },
  ])
    assert.throws(() => requireReceipt(changed), /allowlisted proof/);
});

test("every emitted failure is fixed, useful, and accepted by the receipt boundary", () => {
  for (const code of [
    "missing-config",
    "invalid-context",
    "invalid-config",
    "invalid-checkout",
    "public-before",
    "browser-start",
    "sign-in-ui",
    "ticket",
    "ordinary-session",
    "authenticated-api",
    "signed-in-reload",
    "signout-ui",
    "signed-out",
    "signed-out-reload",
    "tokenless-api",
    "public-after",
    "cleanup",
  ]) {
    const receipt = failureReceipt(code);
    assert.equal(requireReceipt(receipt), receipt);
    assert.equal(receipt.code, code);
    assert.notEqual(receipt.outcome, "passed");
    assert.ok(receipt.message.length > 15);
  }
});

test("reused public boundary detects runtime source, version, key, and readiness drift", async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.CLERK_PUBLISHABLE_KEY;
  const record = {
    source: config.source,
    deployment: { url: origin },
    image: { version: `main-${commit.slice(0, 12)}` },
  };
  let change = {};
  process.env.CLERK_PUBLISHABLE_KEY = config.publishableKey;
  globalThis.fetch = async (url) => {
    if (url.endsWith("/api/config"))
      return Response.json({
        clerkPublishableKey: change.key ?? config.publishableKey,
      });
    if (url.endsWith("/release.json"))
      return Response.json({
        source: change.source ?? config.source,
        version: change.version ?? record.image.version,
      });
    if (url.endsWith("/api/habits")) return new Response(null, { status: 401 });
    return new Response(null, { status: change.readiness ?? 200 });
  };
  try {
    await publicChecks(record);
    for (const drift of [
      { source: { ...config.source, commit: sha } },
      { source: { ...config.source, tree: sha } },
      { version: "main-wrong" },
      { key: "pk_live_other" },
      { readiness: 503 },
    ]) {
      change = drift;
      await assert.rejects(publicChecks(record));
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.CLERK_PUBLISHABLE_KEY;
    else process.env.CLERK_PUBLISHABLE_KEY = oldKey;
  }
});

test("real CLI refuses missing configuration before Git, browser, or provider access", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "damadama-provider-")),
  );
  try {
    const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "data:text/javascript,globalThis.fetch=()=>{process.stderr.write('NETWORK_CALLED');throw Error('unexpected network')}",
        runner,
      ],
      {
        cwd: directory,
        env: { PATH: "", SystemRoot: process.env.SystemRoot ?? "" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(
      JSON.parse(result.stdout),
      failureReceipt("missing-config"),
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, receiptPath), "utf8")),
      failureReceipt("missing-config"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real CLI accepts ancestor source and refuses unrelated source or mismatched controls checkout before network access", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "damadama-provider-git-")),
  );
  const git = (...args) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Provider fixture",
        "-c",
        "user.email=provider-fixture@example.invalid",
        ...args,
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "--initial-branch=fixture");
    git("commit", "--allow-empty", "--no-gpg-sign", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "--no-gpg-sign", "-m", "controls");
    const head = git("rev-parse", "HEAD");
    const orphan = git("commit-tree", "HEAD^{tree}", "-m", "orphan");
    const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
    for (const [expectedCommit, controlsSha, code, marker] of [
      [base, head, "public-before", "FETCH_CALLED"],
      [orphan, head, "invalid-checkout", ""],
      [base, base, "invalid-checkout", ""],
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "data:text/javascript,globalThis.fetch=()=>{process.stderr.write('FETCH_CALLED');throw Error('fixed fetch stop')}",
          runner,
        ],
        {
          cwd: directory,
          env: {
            ...env,
            PATH: process.env.PATH ?? "",
            SystemRoot: process.env.SystemRoot ?? "",
            EXPECTED_SOURCE_SHA: expectedCommit,
            GITHUB_SHA: controlsSha,
          },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stderr, marker);
      assert.deepEqual(JSON.parse(result.stdout), failureReceipt(code));
      assert.deepEqual(
        JSON.parse(await readFile(join(directory, receiptPath), "utf8")),
        failureReceipt(code),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
