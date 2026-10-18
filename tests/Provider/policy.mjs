import { requireSource, repository } from "../../release/policy.mjs";

export const origin = "https://staging.damadama.app";
export const receiptPath = "test-results/provider-smoke.json";
export const checkNames = [
  "deployedSignIn",
  "ordinarySession",
  "authorizedApi",
  "signedInReload",
  "userMenuSignOut",
  "signedOut",
  "signedOutReload",
  "tokenlessUnauthorized",
  "sourceStable",
];

const failures = {
  "missing-config": [
    "missing-setup",
    "Set the documented provider workflow inputs.",
  ],
  "invalid-context": [
    "rejected-configuration",
    "Run the main provider workflow in ShiosOS/Damadama.",
  ],
  "invalid-config": [
    "rejected-configuration",
    "Use the approved staging origin, live Clerk keys, synthetic account, and full lowercase source SHA.",
  ],
  "invalid-checkout": [
    "rejected-configuration",
    "Check out the workflow SHA with the expected deployed source in its ancestry.",
  ],
  "public-before": [
    "failed",
    "Staging readiness, runtime key, or expected source identity failed before sign-in.",
  ],
  "browser-start": ["failed", "Chromium could not start."],
  "sign-in-ui": [
    "failed",
    "The approved deployed SignIn interface did not appear.",
  ],
  ticket: [
    "failed",
    "Clerk refused the short-lived synthetic-account sign-in ticket.",
  ],
  "ordinary-session": [
    "failed",
    "Clerk did not activate a complete ordinary session for the approved account.",
  ],
  "authenticated-api": [
    "failed",
    "The ordinary session did not receive API 200.",
  ],
  "signed-in-reload": [
    "failed",
    "The ordinary account session or protected interface did not survive reload.",
  ],
  "signout-ui": ["failed", "The UserButton Sign out action did not complete."],
  "signed-out": [
    "failed",
    "Sign-out left a session, user, or protected interface visible.",
  ],
  "signed-out-reload": [
    "failed",
    "The signed-out state did not survive reload.",
  ],
  "tokenless-api": [
    "failed",
    "The tokenless signed-out API request did not receive 401.",
  ],
  "public-after": [
    "failed",
    "Staging readiness, runtime key, or source identity changed during verification.",
  ],
  cleanup: ["failed", "The private browser context could not close cleanly."],
};

export class ProviderFailure extends Error {
  constructor(code) {
    super(failures[code][1]);
    this.code = code;
  }
}

export function requireThat(condition, code) {
  if (!condition) throw new ProviderFailure(code);
}

function exactFields(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...fields].sort().join(",")
  );
}

export function readInputs(env) {
  const names = [
    "APP_ORIGIN",
    "EXPECTED_SOURCE_SHA",
    "GITHUB_SHA",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_TEST_USER_A",
  ];
  requireThat(
    names.every(
      (name) => typeof env[name] === "string" && env[name].length > 0,
    ),
    "missing-config",
  );
  requireThat(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REPOSITORY === repository &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_WORKFLOW_REF ===
        `${repository}/.github/workflows/provider-smoke.yml@refs/heads/main`,
    "invalid-context",
  );
  requireThat(
    env.APP_ORIGIN === origin &&
      /^[a-f0-9]{40}$/.test(env.EXPECTED_SOURCE_SHA) &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA) &&
      /^pk_live_[A-Za-z0-9_-]+$/.test(env.CLERK_PUBLISHABLE_KEY) &&
      /^sk_live_[A-Za-z0-9_-]+$/.test(env.CLERK_SECRET_KEY) &&
      /^user_[A-Za-z0-9]+$/.test(env.CLERK_TEST_USER_A),
    "invalid-config",
  );
  return {
    origin,
    controlsSha: env.GITHUB_SHA,
    expectedCommit: env.EXPECTED_SOURCE_SHA,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    secretKey: env.CLERK_SECRET_KEY,
    accountA: env.CLERK_TEST_USER_A,
  };
}

export function providerConfig(inputs, checkout) {
  requireThat(
    checkout.head === inputs.controlsSha && checkout.isAncestor === true,
    "invalid-checkout",
  );
  const source = {
    repository,
    commit: inputs.expectedCommit,
    tree: checkout.tree,
  };
  try {
    requireSource(source);
  } catch {
    throw new ProviderFailure("invalid-checkout");
  }
  return {
    origin: inputs.origin,
    source,
    controlsSha: inputs.controlsSha,
    publishableKey: inputs.publishableKey,
    secretKey: inputs.secretKey,
    accountA: inputs.accountA,
  };
}

export function requirePageOrigin(url, approvedOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderFailure("sign-in-ui");
  }
  requireThat(parsed.origin === approvedOrigin, "sign-in-ui");
}

export function requireSession(
  observed,
  accountA,
  code = "ordinary-session",
  expectedId = observed?.id,
) {
  requireThat(
    observed?.status === "active" &&
      typeof observed.id === "string" &&
      observed.id.startsWith("sess_") &&
      observed.id === expectedId &&
      observed.userId === accountA &&
      observed.sessionUserId === accountA,
    code,
  );
}

export function requireSignedOut(observed, code) {
  requireThat(
    observed?.sessionAbsent === true &&
      observed.userAbsent === true &&
      observed.activeSessions === 0 &&
      observed.protectedVisible === false &&
      observed.signInVisible === true,
    code,
  );
}

export function failureReceipt(code) {
  const [outcome, message] = failures[code];
  return { schema: 1, outcome, code, message };
}

export function passedReceipt(config, checks) {
  requireThat(
    exactFields(checks, checkNames) &&
      checkNames.every((name) => checks[name] === true),
    "public-after",
  );
  const receipt = {
    schema: 1,
    outcome: "passed",
    mechanism: "clerk-sign-in-ticket",
    origin: config.origin,
    source: config.source,
    controlsSha: config.controlsSha,
    checks,
    testingToken: "not-used",
    emailDelivery: "not-exercised",
  };
  requireReceipt(receipt);
  return receipt;
}

export function requireReceipt(receipt) {
  let valid = receipt?.schema === 1;
  if (receipt?.outcome === "passed") {
    valid =
      valid &&
      exactFields(receipt, [
        "schema",
        "outcome",
        "mechanism",
        "origin",
        "source",
        "controlsSha",
        "checks",
        "testingToken",
        "emailDelivery",
      ]) &&
      receipt.mechanism === "clerk-sign-in-ticket" &&
      receipt.origin === origin &&
      /^[a-f0-9]{40}$/.test(receipt.controlsSha) &&
      exactFields(receipt.checks, checkNames) &&
      checkNames.every((name) => receipt.checks[name] === true) &&
      receipt.testingToken === "not-used" &&
      receipt.emailDelivery === "not-exercised";
    try {
      requireSource(receipt.source);
    } catch {
      valid = false;
    }
  } else {
    const expected = Object.hasOwn(failures, receipt?.code ?? "")
      ? failureReceipt(receipt.code)
      : null;
    valid =
      valid &&
      expected !== null &&
      exactFields(receipt, Object.keys(expected)) &&
      Object.entries(expected).every(([key, value]) => receipt[key] === value);
  }
  if (!valid)
    throw new Error(
      "Provider receipt must contain only the documented allowlisted proof fields and values.",
    );
  return receipt;
}
