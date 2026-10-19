import { pathToFileURL } from "node:url";
import { github } from "./github.mjs";
import { repository, mainRules, recordHash } from "./policy.mjs";

export function environmentPlan(reviewerId, automatic = false) {
  if (!automatic && (!Number.isSafeInteger(reviewerId) || reviewerId < 1))
    throw new Error("reviewer user ID is required");
  return {
    wait_timer: 0,
    prevent_self_review: false,
    can_admins_bypass: false,
    reviewers: automatic ? [] : [{ type: "User", id: reviewerId }],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
}

export async function configure(
  operation,
  { reviewerId, request = github, verify = false },
) {
  const ruleset = mainRules();
  ruleset.rules.find(
    (rule) => rule.type === "pull_request",
  ).parameters.required_reviewers = [];
  ruleset.rules.push({
    type: "code_scanning",
    parameters: {
      code_scanning_tools: [
        {
          tool: "CodeQL",
          security_alerts_threshold: "high_or_higher",
          alerts_threshold: "none",
        },
      ],
    },
  });
  const plan = {
    ruleset,
    environments: Object.fromEntries(
      ["staging", "production"].map((name) => [
        name,
        environmentPlan(reviewerId, name === "staging"),
      ]),
    ),
  };
  if (operation === "plan") return plan;
  if (!["inspect", "apply"].includes(operation))
    throw new Error("use plan, inspect, apply, or probe");
  const rulesets = await request(`repos/${repository}/rulesets?per_page=100`);
  const matches = rulesets.filter((rule) => rule.name === plan.ruleset.name);
  if (matches.length > 1)
    throw new Error("duplicate Damadama main rulesets require reconciliation");
  let existing = matches[0]
    ? await request(`repos/${repository}/rulesets/${matches[0].id}`)
    : null;
  if (operation === "apply") {
    for (const [name, body] of Object.entries(plan.environments)) {
      const policies = await request(
        `repos/${repository}/environments/${name}/deployment-branch-policies?per_page=100`,
        { missing: true },
      );
      if (
        policies?.branch_policies.some(
          (policy) => policy.name !== "main" || policy.type !== "branch",
        )
      )
        throw new Error(
          `unexpected ${name} branch policy; reconcile before apply`,
        );
      await request(`repos/${repository}/environments/${name}`, {
        method: "PUT",
        body,
      });
      if (!policies?.branch_policies.length)
        await request(
          `repos/${repository}/environments/${name}/deployment-branch-policies`,
          { method: "POST", body: { name: "main", type: "branch" } },
        );
    }
    const saved = await request(
      `repos/${repository}/rulesets${existing ? `/${existing.id}` : ""}`,
      { method: existing ? "PUT" : "POST", body: plan.ruleset },
    );
    if (!Number.isSafeInteger(saved?.id) || saved.id < 1)
      throw new Error("ruleset write did not return an ID");
    existing = await request(`repos/${repository}/rulesets/${saved.id}`);
  }
  const environments = {};
  for (const name of Object.keys(plan.environments)) {
    environments[name] = {
      settings: await request(`repos/${repository}/environments/${name}`, {
        missing: true,
      }),
      policies: await request(
        `repos/${repository}/environments/${name}/deployment-branch-policies?per_page=100`,
        { missing: true },
      ),
    };
  }
  const observed = { ruleset: existing, environments };
  if (operation === "apply" || verify) assertConfigured(plan, observed);
  return { plan, observed };
}

export function assertConfigured(plan, observed) {
  const actual = observed.ruleset;
  if (
    !actual ||
    actual.enforcement !== "active" ||
    actual.bypass_actors.length ||
    recordHash(actual.conditions) !== recordHash(plan.ruleset.conditions)
  )
    throw new Error("ruleset did not enforce main without bypass");
  for (const expected of plan.ruleset.rules) {
    const rule = actual.rules.find((item) => item.type === expected.type);
    if (!rule) throw new Error(`missing ${expected.type} rule`);
    if (expected.type === "code_scanning") {
      if (
        actual.rules.filter((item) => item.type === "code_scanning").length !==
        1
      )
        throw new Error("expected exactly one code_scanning rule");
      const tools = rule.parameters?.code_scanning_tools;
      if (!Array.isArray(tools) || tools.length !== 1)
        throw new Error("code_scanning requires exactly one tool");
      if (recordHash(rule.parameters) !== recordHash(expected.parameters))
        throw new Error("ruleset did not enforce code_scanning configuration");
      continue;
    }
    for (const [key, value] of Object.entries(expected.parameters ?? {})) {
      if (
        rule.parameters?.[key] === undefined ||
        recordHash(rule.parameters[key]) !== recordHash(value)
      )
        throw new Error(`ruleset did not enforce ${key}`);
    }
  }
  for (const name of Object.keys(plan.environments)) {
    const env = observed.environments[name];
    const settings = env?.settings;
    const review = settings?.protection_rules.find(
      (rule) => rule.type === "required_reviewers",
    );
    if (
      settings?.can_admins_bypass !== false ||
      settings.deployment_branch_policy?.custom_branch_policies !== true ||
      settings.deployment_branch_policy?.protected_branches !== false
    )
      throw new Error(`${name} lacks protected approval`);
    if (
      name === "staging" &&
      settings.protection_rules.some(
        (rule) => !["branch_policy", "required_reviewers"].includes(rule.type),
      )
    )
      throw new Error("staging must not have blocking deployment protection");
    if (
      recordHash(
        (review?.reviewers ?? []).map((item) => ({
          type: item.type,
          id: item.reviewer.id,
        })),
      ) !== recordHash(plan.environments[name].reviewers)
    )
      throw new Error(`${name} has the wrong reviewer`);
    if (
      env.policies?.branch_policies.length !== 1 ||
      env.policies.branch_policies[0].name !== "main" ||
      env.policies.branch_policies[0].type !== "branch"
    )
      throw new Error(`${name} must allow only main`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [operation, id, flag, ...extra] = process.argv.slice(2);
  const verify = flag === "--verify";
  if ((flag && !verify) || extra.length)
    throw new Error("Unknown configure option");
  if (verify && operation !== "inspect")
    throw new Error("--verify requires inspect");
  const result = await configure(operation, {
    reviewerId: Number(id),
    verify: false,
  });
  console.log(JSON.stringify(result, null, 2));
  if (verify) {
    assertConfigured(result.plan, result.observed);
  }
}
