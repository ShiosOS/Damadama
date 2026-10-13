import assert from "node:assert/strict";
import { test } from "node:test";
import { environmentPlan, assertConfigured } from "./configure-github.mjs";
import { mainRules } from "./policy.mjs";

function configured() {
  const plan = {
    ruleset: mainRules(9001),
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
test("bootstrap explicitly omits staging and cannot be confused with full enforcement", () => {
  const bootstrap = mainRules(undefined, true);
  const checks = bootstrap.rules.find(
    (r) => r.type === "required_status_checks",
  ).parameters.required_status_checks;
  assert.deepEqual(
    checks.map((c) => c.context),
    ["release-controls"],
  );
});
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
