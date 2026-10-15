import assert from "node:assert/strict";
import { test } from "node:test";
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
