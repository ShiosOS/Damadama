import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  configure,
  environmentPlan,
  assertConfigured,
} from "./configure-github.mjs";
import { mainRules } from "./policy.mjs";

test("staging is automatic and production requires protected approval", async () => {
  const plan = await configure("plan", { reviewerId: 123 });
  assert.deepEqual(Object.keys(plan.environments), ["staging", "production"]);
  assert.deepEqual(plan.environments.staging.reviewers, []);
  assert.deepEqual(plan.environments.production.reviewers, [
    { type: "User", id: 123 },
  ]);
});
function configured() {
  const plan = {
    ruleset: mainRules(),
    environments: { staging: environmentPlan(123) },
  };
  const observed = {
    ruleset: structuredClone(plan.ruleset),
    environments: {
      staging: {
        settings: {
          ...environmentPlan(123),
          protection_rules: [
            {
              type: "required_reviewers",
              reviewers: [{ type: "User", reviewer: { id: 123 } }],
            },
          ],
        },
        policies: { branch_policies: [{ name: "main", type: "branch" }] },
      },
    },
  };
  return { plan, observed };
}

test("readback accepts the intended approval and gate policy", () => {
  const { plan, observed } = configured();
  assert.doesNotThrow(() => assertConfigured(plan, observed));
});
for (const [change, expected] of [
  [
    (o) => {
      o.ruleset.bypass_actors.push({ actor_id: 1 });
    },
    /bypass/,
  ],
  [
    (o) => {
      o.ruleset.rules.pop();
    },
    /required_status_checks/,
  ],
  [
    (o) => {
      o.environments.staging.settings.can_admins_bypass = true;
    },
    /approval/,
  ],
  [
    (o) => {
      o.environments.staging.policies.branch_policies.push({
        name: "*",
        type: "tag",
      });
    },
    /only main/,
  ],
  [
    (o) => {
      o.environments.staging.settings.protection_rules[0].reviewers[0].reviewer.id = 456;
    },
    /reviewer/,
  ],
]) {
  test(`readback detects a weakened policy (${expected.source})`, () => {
    const { plan, observed } = configured();
    change(observed);
    assert.throws(() => assertConfigured(plan, observed), expected);
  });
}
test("environment plan requires a concrete human reviewer", () => {
  assert.throws(() => environmentPlan(0), /reviewer/);
  assert.equal(environmentPlan(123).can_admins_bypass, false);
});

test("readback rejects an extra environment approver", () => {
  const { plan, observed } = configured();
  observed.environments.staging.settings.protection_rules[0].reviewers.push({
    type: "User",
    reviewer: { id: 456 },
  });
  assert.throws(() => assertConfigured(plan, observed), /reviewer/);
});

function provider(drift = false) {
  const writes = [];
  const requests = [];
  const ruleset = { ...mainRules(), id: 45 };
  const request = async (path, options = {}) => {
    requests.push({ path, method: options.method ?? "GET" });
    if (options.method) {
      writes.push({ path, method: options.method });
      if (path.endsWith("/rulesets/45")) return ruleset;
      return {};
    }
    if (path.endsWith("/rulesets?per_page=100"))
      return [{ name: ruleset.name, id: 45 }];
    if (path.endsWith("/rulesets/45")) {
      const read = structuredClone(ruleset);
      if (
        drift &&
        writes.some((write) => write.path.endsWith("/rulesets/45"))
      ) {
        read.rules.find(
          (rule) => rule.type === "required_status_checks",
        ).parameters.required_status_checks = [];
      }
      return read;
    }
    if (path.endsWith("/deployment-branch-policies?per_page=100")) {
      return { branch_policies: [{ name: "main", type: "branch" }] };
    }
    const name = path.endsWith("/staging") ? "staging" : "production";
    const settings = environmentPlan(123, name === "staging");
    return {
      ...settings,
      protection_rules:
        name === "staging"
          ? []
          : [
              {
                type: "required_reviewers",
                reviewers: [{ type: "User", reviewer: { id: 123 } }],
              },
            ],
    };
  };
  return { request, requests, writes };
}

test("apply rejects a stale write echo when fresh ruleset readback drifts", async () => {
  const api = provider(true);
  await assert.rejects(
    configure("apply", { reviewerId: 123, request: api.request }),
    /required_status_checks/,
  );
  assert.deepEqual(
    api.requests
      .filter((item) => item.path.endsWith("/rulesets/45"))
      .map((item) => item.method),
    ["GET", "PUT", "GET"],
  );
});

test("apply accepts a fresh ruleset readback", async () => {
  const api = provider();
  const result = await configure("apply", {
    reviewerId: 123,
    request: api.request,
  });
  assert.equal(result.observed.ruleset.id, 45);
  assert.equal(
    api.writes.filter((item) => item.path.endsWith("/rulesets/45")).length,
    1,
  );
});

test("inspect verifies readback without writing", async () => {
  const api = provider();
  const result = await configure("inspect", {
    reviewerId: 123,
    request: api.request,
    verify: true,
  });
  assert.equal(result.observed.ruleset.id, 45);
  assert.deepEqual(api.writes, []);
});

test("CLI rejects invalid verification options before contacting GitHub", () => {
  for (const args of [
    ["apply", "123", "--verify"],
    ["inspect", "123", "--unknown"],
    ["inspect", "123", "--verify", "extra"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["release/configure-github.mjs", ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      args[0] === "apply"
        ? /--verify requires inspect/
        : /Unknown configure option/,
    );
    assert.doesNotMatch(result.stderr, /HTTP|gh|fetch failed/);
  }
});
for (const [field, staleValue] of [
  ["required_approving_review_count", 1],
  ["require_last_push_approval", true],
  ["require_extra_approval_for_unattributed_changes", true],
]) {
  test(`readback rejects a stale second-reviewer requirement (${field})`, () => {
    const { plan, observed } = configured();
    observed.ruleset.rules.find(
      (rule) => rule.type === "pull_request",
    ).parameters[field] = staleValue;
    assert.throws(() => assertConfigured(plan, observed), new RegExp(field));
  });
}
