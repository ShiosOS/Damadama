import { pathToFileURL } from "node:url";
import { github, captureSource } from "./github.mjs";
import {
  repository,
  mainRules,
  stagingContext,
  recordHash,
} from "./policy.mjs";

export function environmentPlan(reviewerId) {
  if (!Number.isSafeInteger(reviewerId) || reviewerId < 1)
    throw new Error("reviewer user ID is required");
  return {
    wait_timer: 0,
    prevent_self_review: false,
    can_admins_bypass: false,
    reviewers: [{ type: "User", id: reviewerId }],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
}

export async function configure(operation, { bootstrap, appId, reviewerId }) {
  const plan = {
    ruleset: mainRules(appId, bootstrap),
    environments: Object.fromEntries(
      ["staging", "staging-verification", "production"].map((name) => [
        name,
        environmentPlan(reviewerId),
      ]),
    ),
  };
  if (operation === "plan") return plan;
  if (!["inspect", "apply"].includes(operation))
    throw new Error("use plan, inspect, apply, or probe");
  const rulesets = await github(`repos/${repository}/rulesets?per_page=100`);
  const matches = rulesets.filter((rule) => rule.name === plan.ruleset.name);
  if (matches.length > 1)
    throw new Error("duplicate Damadama main rulesets require reconciliation");
  let existing = matches[0]
    ? await github(`repos/${repository}/rulesets/${matches[0].id}`)
    : null;
  if (operation === "apply") {
    const sealed = existing?.rules.some(
      (rule) =>
        rule.type === "required_status_checks" &&
        rule.parameters.required_status_checks.some(
          (check) => check.context === stagingContext,
        ),
    );
    if (bootstrap && sealed)
      throw new Error("refusing to weaken an activated staging gate");
    for (const [name, body] of Object.entries(plan.environments)) {
      const policies = await github(
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
      await github(`repos/${repository}/environments/${name}`, {
        method: "PUT",
        body,
      });
      if (!policies?.branch_policies.length)
        await github(
          `repos/${repository}/environments/${name}/deployment-branch-policies`,
          { method: "POST", body: { name: "main", type: "branch" } },
        );
    }
    existing = await github(
      `repos/${repository}/rulesets${existing ? `/${existing.id}` : ""}`,
      { method: existing ? "PUT" : "POST", body: plan.ruleset },
    );
  }
  const environments = {};
  for (const name of Object.keys(plan.environments)) {
    environments[name] = {
      settings: await github(`repos/${repository}/environments/${name}`, {
        missing: true,
      }),
      policies: await github(
        `repos/${repository}/environments/${name}/deployment-branch-policies?per_page=100`,
        { missing: true },
      ),
    };
  }
  const observed = { ruleset: existing, environments };
  if (operation === "apply") assertConfigured(plan, observed);
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
    for (const [key, value] of Object.entries(expected.parameters ?? {})) {
      if (JSON.stringify(rule.parameters[key]) !== JSON.stringify(value))
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
      !review ||
      settings.can_admins_bypass !== false ||
      settings.deployment_branch_policy?.custom_branch_policies !== true ||
      settings.deployment_branch_policy?.protected_branches !== false
    )
      throw new Error(`${name} lacks protected approval`);
    if (
      recordHash(
        review.reviewers.map((item) => ({
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

export async function probe(prNumber) {
  const source = await captureSource(prNumber);
  const rules = await github(`repos/${repository}/rules/branches/main`);
  const checkRuns = await github(
    `repos/${repository}/commits/${source.merge}/check-runs?per_page=100&filter=latest`,
  );
  const statusRules = rules.filter(
    (rule) => rule.type === "required_status_checks",
  );
  const required = statusRules.flatMap(
    (rule) => rule.parameters.required_status_checks,
  );
  const checks = required.map((requirement) => ({
    ...requirement,
    success: checkRuns.check_runs.some(
      (check) =>
        check.name === requirement.context &&
        check.app.id === requirement.integration_id &&
        check.head_sha === source.merge &&
        check.status === "completed" &&
        check.conclusion === "success",
    ),
  }));
  return {
    source,
    strict: statusRules.some(
      (rule) => rule.parameters.strict_required_status_checks_policy === true,
    ),
    stagingRequired: required.some((check) => check.context === stagingContext),
    checks,
    note: "Read-only inspection. No merge attempt and no staging pass is fabricated.",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [operation, mode, id] = process.argv.slice(2);
  if (operation !== "probe" && !["bootstrap", "gated"].includes(mode))
    throw new Error("mode must be bootstrap or gated");
  const result =
    operation === "probe"
      ? await probe(Number(mode))
      : await configure(operation, {
          bootstrap: mode === "bootstrap",
          appId: Number(process.env.RELEASE_GATE_APP_ID),
          reviewerId: Number(id),
        });
  console.log(JSON.stringify(result, null, 2));
}
