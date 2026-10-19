import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  configure,
  environmentPlan,
  assertConfigured,
} from "./configure-github.mjs";

function noRequests() {
  assert.fail("plan must not contact GitHub");
}

function environmentSettings(body) {
  return {
    ...structuredClone(body),
    protection_rules: [
      {
        type: "required_reviewers",
        reviewers: body.reviewers.map(({ type, id }) => ({
          type,
          reviewer: { id },
        })),
      },
    ],
  };
}

async function configured() {
  const plan = await configure("plan", {
    reviewerId: 123,
    request: noRequests,
  });
  const observed = {
    ruleset: structuredClone(plan.ruleset),
    environments: Object.fromEntries(
      Object.entries(plan.environments).map(([name, body]) => [
        name,
        {
          settings: environmentSettings(body),
          policies: { branch_policies: [{ name: "main", type: "branch" }] },
        },
      ]),
    ),
  };
  return { plan, observed };
}

test("plan declares the finite native rule and preserves main and environment policy without requests", async () => {
  const plan = await configure("plan", {
    reviewerId: 123,
    request: noRequests,
  });
  assert.deepEqual(plan.ruleset, {
    name: "Damadama main",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          require_extra_approval_for_unattributed_changes: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ["merge", "squash"],
          required_reviewers: [],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: "release-controls", integration_id: 15368 },
            { context: "check", integration_id: 15368 },
          ],
        },
      },
      {
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
      },
    ],
  });
  assert.deepEqual(plan.environments, {
    staging: {
      wait_timer: 0,
      prevent_self_review: false,
      can_admins_bypass: false,
      reviewers: [],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    },
    production: {
      wait_timer: 0,
      prevent_self_review: false,
      can_admins_bypass: false,
      reviewers: [{ type: "User", id: 123 }],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    },
  });
});

test("plan returns fresh nested configuration data", async () => {
  const first = await configure("plan", {
    reviewerId: 123,
    request: noRequests,
  });
  const second = await configure("plan", {
    reviewerId: 123,
    request: noRequests,
  });
  const untouched = structuredClone(second);
  first.ruleset.rules
    .find((rule) => rule.type === "pull_request")
    .parameters.required_reviewers.push({ id: 456 });
  first.ruleset.rules.find(
    (rule) => rule.type === "required_status_checks",
  ).parameters.required_status_checks[0].integration_id = 1;
  first.ruleset.rules.find(
    (rule) => rule.type === "code_scanning",
  ).parameters.code_scanning_tools[0].tool = "other";
  first.environments.production.reviewers[0].id = 456;
  assert.deepEqual(second, untouched);
});

test("readback accepts automatic staging and protected production", async () => {
  const { plan, observed } = await configured();
  assert.doesNotThrow(() => assertConfigured(plan, observed));
});

for (const [name, change, expected] of [
  [
    "inactive enforcement",
    (o) => (o.ruleset.enforcement = "evaluate"),
    /bypass/,
  ],
  [
    "bypass actor",
    (o) => o.ruleset.bypass_actors.push({ actor_id: 1 }),
    /bypass/,
  ],
  [
    "changed main conditions",
    (o) => o.ruleset.conditions.ref_name.include.push("refs/heads/other"),
    /bypass/,
  ],
  [
    "missing status rule",
    (o) => {
      o.ruleset.rules = o.ruleset.rules.filter(
        (rule) => rule.type !== "required_status_checks",
      );
    },
    /required_status_checks/,
  ],
  [
    "environment administrator bypass",
    (o) => (o.environments.staging.settings.can_admins_bypass = true),
    /approval/,
  ],
  [
    "protected branches instead of custom policies",
    (o) => {
      o.environments.production.settings.deployment_branch_policy = {
        protected_branches: true,
        custom_branch_policies: false,
      };
    },
    /approval/,
  ],
  [
    "extra deployment branch",
    (o) =>
      o.environments.staging.policies.branch_policies.push({
        name: "*",
        type: "tag",
      }),
    /only main/,
  ],
  [
    "wrong production reviewer",
    (o) => {
      o.environments.production.settings.protection_rules[0].reviewers[0].reviewer.id = 456;
    },
    /reviewer/,
  ],
  [
    "extra production reviewer",
    (o) =>
      o.environments.production.settings.protection_rules[0].reviewers.push({
        type: "User",
        reviewer: { id: 456 },
      }),
    /reviewer/,
  ],
  [
    "staging human reviewer",
    (o) =>
      o.environments.staging.settings.protection_rules[0].reviewers.push({
        type: "User",
        reviewer: { id: 456 },
      }),
    /reviewer/,
  ],
  [
    "blocking staging protection",
    (o) =>
      o.environments.staging.settings.protection_rules.push({
        type: "wait_timer",
      }),
    /blocking deployment protection/,
  ],
]) {
  test(`readback refuses ${name}`, async () => {
    const { plan, observed } = await configured();
    change(observed);
    assert.throws(() => assertConfigured(plan, observed), expected);
  });
}

for (const [type, field, staleValue] of [
  ["pull_request", "required_approving_review_count", 1],
  ["pull_request", "dismiss_stale_reviews_on_push", false],
  ["pull_request", "require_code_owner_review", true],
  ["pull_request", "require_last_push_approval", true],
  ["pull_request", "require_extra_approval_for_unattributed_changes", true],
  ["pull_request", "required_review_thread_resolution", false],
  ["pull_request", "allowed_merge_methods", ["merge", "squash", "rebase"]],
  ["pull_request", "required_reviewers", [{ type: "User", id: 456 }]],
  ["required_status_checks", "strict_required_status_checks_policy", false],
  ["required_status_checks", "do_not_enforce_on_create", true],
  ["required_status_checks", "required_status_checks", []],
]) {
  test(`readback refuses changed ${field}`, async () => {
    const { plan, observed } = await configured();
    observed.ruleset.rules.find((rule) => rule.type === type).parameters[
      field
    ] = staleValue;
    assert.throws(() => assertConfigured(plan, observed), new RegExp(field));
  });
}

for (const [field, wrongValue] of [
  ["context", "other"],
  ["integration_id", 15369],
]) {
  test(`readback refuses changed Actions status ${field}`, async () => {
    const { plan, observed } = await configured();
    const checks = observed.ruleset.rules.find(
      (rule) => rule.type === "required_status_checks",
    ).parameters.required_status_checks;
    checks[0][field] = wrongValue;
    assert.throws(
      () => assertConfigured(plan, observed),
      /required_status_checks/,
    );
  });
}

test("readback reports a missing expected parameter", async () => {
  const { plan, observed } = await configured();
  delete observed.ruleset.rules.find((rule) => rule.type === "pull_request")
    .parameters;
  assert.throws(
    () => assertConfigured(plan, observed),
    /required_approving_review_count/,
  );
});

test("environment plan requires a concrete human reviewer", () => {
  for (const id of [0, -1, 1.5, undefined]) {
    assert.throws(() => environmentPlan(id), /reviewer/);
  }
  assert.equal(environmentPlan(123).can_admins_bypass, false);
});

test("readback refuses a missing native rule", async () => {
  const { plan, observed } = await configured();
  observed.ruleset.rules = observed.ruleset.rules.filter(
    (rule) => rule.type !== "code_scanning",
  );
  assert.throws(
    () => assertConfigured(plan, observed),
    /missing code_scanning/,
  );
});

for (const reverse of [false, true]) {
  test(`readback refuses duplicate native rules with the weaker rule ${reverse ? "first" : "last"}`, async () => {
    const { plan, observed } = await configured();
    const weaker = structuredClone(
      observed.ruleset.rules.find((rule) => rule.type === "code_scanning"),
    );
    weaker.parameters.code_scanning_tools[0].security_alerts_threshold = "none";
    if (reverse) observed.ruleset.rules.unshift(weaker);
    else observed.ruleset.rules.push(weaker);
    assert.throws(() => assertConfigured(plan, observed), /one code_scanning/);
  });
}

for (const [name, change] of [
  ["missing parameters", (rule) => delete rule.parameters],
  ["missing tools", (rule) => delete rule.parameters.code_scanning_tools],
  ["invalid tools", (rule) => (rule.parameters.code_scanning_tools = {})],
  ["empty tools", (rule) => (rule.parameters.code_scanning_tools = [])],
  [
    "duplicate tools",
    (rule) =>
      rule.parameters.code_scanning_tools.push(
        structuredClone(rule.parameters.code_scanning_tools[0]),
      ),
  ],
  [
    "extra tool",
    (rule) => rule.parameters.code_scanning_tools.push({ tool: "other" }),
  ],
]) {
  test(`readback refuses native ${name}`, async () => {
    const { plan, observed } = await configured();
    change(
      observed.ruleset.rules.find((rule) => rule.type === "code_scanning"),
    );
    assert.throws(
      () => assertConfigured(plan, observed),
      /code_scanning.*one tool/,
    );
  });
}

for (const [field, wrongValue] of [
  ["tool", "other"],
  ["security_alerts_threshold", "none"],
  ["alerts_threshold", "errors"],
  ["extra", true],
]) {
  test(`readback refuses changed native tool ${field}`, async () => {
    const { plan, observed } = await configured();
    observed.ruleset.rules.find(
      (rule) => rule.type === "code_scanning",
    ).parameters.code_scanning_tools[0][field] = wrongValue;
    assert.throws(
      () => assertConfigured(plan, observed),
      /code_scanning configuration/,
    );
  });
}

for (const field of ["tool", "security_alerts_threshold", "alerts_threshold"]) {
  test(`readback refuses missing native tool ${field}`, async () => {
    const { plan, observed } = await configured();
    delete observed.ruleset.rules.find((rule) => rule.type === "code_scanning")
      .parameters.code_scanning_tools[0][field];
    assert.throws(
      () => assertConfigured(plan, observed),
      /code_scanning configuration/,
    );
  });
}

test("readback refuses an extra native parameter", async () => {
  const { plan, observed } = await configured();
  observed.ruleset.rules.find(
    (rule) => rule.type === "code_scanning",
  ).parameters.extra = true;
  assert.throws(
    () => assertConfigured(plan, observed),
    /code_scanning configuration/,
  );
});

test("readback accepts reordered object keys and legitimate unrelated semantics", async () => {
  const { plan, observed } = await configured();
  const status = observed.ruleset.rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  status.parameters.required_status_checks =
    status.parameters.required_status_checks.map(
      ({ context, integration_id }) => ({
        integration_id,
        context,
      }),
    );
  status.parameters.extra = true;
  observed.ruleset.rules.push({ type: "unrelated" });
  observed.ruleset.rules.push({
    type: "required_status_checks",
    parameters: {},
  });
  const native = observed.ruleset.rules.find(
    (rule) => rule.type === "code_scanning",
  );
  native.parameters.code_scanning_tools = [
    {
      alerts_threshold: "none",
      security_alerts_threshold: "high_or_higher",
      tool: "CodeQL",
    },
  ];
  native.id = 99;
  observed.ruleset.id = 45;
  assert.doesNotThrow(() => assertConfigured(plan, observed));
  status.parameters.required_status_checks.reverse();
  assert.throws(
    () => assertConfigured(plan, observed),
    /required_status_checks/,
  );
});

function provider(
  plan,
  { nativePresent = false, afterWrite, absentPolicies = false } = {},
) {
  const base = "repos/ShiosOS/Damadama";
  const requests = [];
  let saved = false;
  let ruleset = structuredClone({ ...plan.ruleset, id: 45 });
  if (!nativePresent)
    ruleset.rules = ruleset.rules.filter(
      (rule) => rule.type !== "code_scanning",
    );
  const environments = Object.fromEntries(
    Object.entries(plan.environments).map(([name, body]) => [
      name,
      {
        settings: environmentSettings(body),
        policies: {
          branch_policies: absentPolicies
            ? []
            : [{ name: "main", type: "branch" }],
        },
      },
    ]),
  );
  const request = async (path, { method = "GET", body } = {}) => {
    requests.push({
      path: path.slice(base.length),
      method,
      body: structuredClone(body),
    });
    if (path === `${base}/rulesets?per_page=100`)
      return [{ name: ruleset.name, id: 45 }];
    if (path === `${base}/rulesets/45`) {
      if (method === "PUT") {
        ruleset = { ...structuredClone(body), id: 45 };
        saved = true;
        return { id: 45 };
      }
      const read = structuredClone(ruleset);
      if (saved && afterWrite) afterWrite(read);
      return read;
    }
    for (const [name, environment] of Object.entries(environments)) {
      if (path === `${base}/environments/${name}`) {
        if (method === "PUT") {
          environment.settings = environmentSettings(body);
          return {};
        }
        return structuredClone(environment.settings);
      }
      if (
        path ===
        `${base}/environments/${name}/deployment-branch-policies?per_page=100`
      )
        return structuredClone(environment.policies);
      if (
        path === `${base}/environments/${name}/deployment-branch-policies` &&
        method === "POST"
      ) {
        environment.policies.branch_policies.push(structuredClone(body));
        return {};
      }
    }
    assert.fail(`unexpected mock request ${method} ${path}`);
  };
  return { request, requests, environments };
}

for (const [type, field, value] of [
  ["required_status_checks", "required_status_checks", []],
  [
    "code_scanning",
    "code_scanning_tools",
    [
      {
        tool: "CodeQL",
        security_alerts_threshold: "none",
        alerts_threshold: "none",
      },
    ],
  ],
]) {
  test(`apply refuses fresh ${type} drift despite a successful write echo`, async () => {
    const { plan } = await configured();
    const api = provider(plan, {
      afterWrite: (read) => {
        read.rules.find((rule) => rule.type === type).parameters[field] = value;
      },
    });
    await assert.rejects(
      configure("apply", { reviewerId: 123, request: api.request }),
      new RegExp(type),
    );
    assert.deepEqual(
      api.requests
        .filter((item) => item.path === "/rulesets/45")
        .map((item) => item.method),
      ["GET", "PUT", "GET"],
    );
    assert.deepEqual(
      api.requests.find(
        (item) => item.method === "PUT" && item.path === "/rulesets/45",
      ).body,
      plan.ruleset,
    );
  });
}

for (const absentPolicies of [false, true]) {
  test(`apply persists the complete plan after environment writes${absentPolicies ? " and creates missing branch policies" : ""}`, async () => {
    const { plan } = await configured();
    const api = provider(plan, { absentPolicies });
    const result = await configure("apply", {
      reviewerId: 123,
      request: api.request,
    });
    assert.deepEqual(result.observed.ruleset, { ...plan.ruleset, id: 45 });
    const writes = api.requests.filter((item) => item.method !== "GET");
    const expected = [
      {
        path: "/environments/staging",
        method: "PUT",
        body: plan.environments.staging,
      },
      {
        path: "/environments/production",
        method: "PUT",
        body: plan.environments.production,
      },
      { path: "/rulesets/45", method: "PUT", body: plan.ruleset },
    ];
    if (absentPolicies) {
      expected.splice(1, 0, {
        path: "/environments/staging/deployment-branch-policies",
        method: "POST",
        body: { name: "main", type: "branch" },
      });
      expected.splice(3, 0, {
        path: "/environments/production/deployment-branch-policies",
        method: "POST",
        body: { name: "main", type: "branch" },
      });
    }
    assert.deepEqual(writes, expected);
  });
}

test("apply refuses an unexpected existing environment branch policy before writing", async () => {
  const { plan } = await configured();
  const api = provider(plan);
  api.environments.staging.policies.branch_policies[0].name = "other";
  await assert.rejects(
    configure("apply", { reviewerId: 123, request: api.request }),
    /unexpected staging branch policy/,
  );
  assert.ok(api.requests.every((item) => item.method === "GET"));
});

for (const nativePresent of [false, true]) {
  test(`inspect verifies ${nativePresent ? "matching" : "missing native"} readback using GET only`, async () => {
    const { plan } = await configured();
    const api = provider(plan, { nativePresent });
    const inspection = configure("inspect", {
      reviewerId: 123,
      request: api.request,
      verify: true,
    });
    if (nativePresent) assert.equal((await inspection).observed.ruleset.id, 45);
    else await assert.rejects(inspection, /missing code_scanning/);
    assert.equal(api.requests.length, 6);
    assert.ok(api.requests.every((item) => item.method === "GET"));
  });
}

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
