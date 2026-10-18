import assert from "node:assert/strict";
import {
  verifyReceiverTriggers,
  receiverTriggerMutations,
} from "./receiver-triggers.mjs";
import {
  config,
  consoleEvent,
  providerBody,
  runReceiverCommand,
  withProvider,
} from "../../ops/diagnostics/receiver-fixtures.mjs";

const inactive =
  "::notice title=Staging request-error observation::Inactive; zero provider requests.\n";
const invalidActivation =
  "::error title=Request error activation::status=refused reason=invalid-activation\n";
const refusal = (reason) =>
  `::error title=Request error visibility::status=refused reason=${reason}\n`;
const credentialVariables = {
  RAILWAY_PROJECT_ID: config.projectId,
  RAILWAY_ENVIRONMENT_ID: config.environmentId,
  RAILWAY_SERVICE_ID: config.serviceId,
};
const credentialSecrets = {
  RAILWAY_LOG_READER_TOKEN_STAGING: config.token,
};

function expression(source) {
  if (typeof source === "boolean") return { kind: "literal", value: source };
  assert.equal(typeof source, "string", "condition must be an expression");
  const text = source.replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, "$1");
  const tokens = [];
  let offset = 0;
  while (offset < text.length) {
    const match =
      /^\s+|^'(?:[^']|'')*'|^(?:==|&&|\|\||[(),])|^[A-Za-z_][A-Za-z0-9_.]*/.exec(
        text.slice(offset),
      );
    assert.ok(match, "unsupported Actions expression syntax");
    offset += match[0].length;
    if (!/^\s+$/.test(match[0])) tokens.push(match[0]);
  }
  let index = 0;
  const take = (token) => {
    if (tokens[index] !== token) return false;
    index++;
    return true;
  };
  function primary() {
    if (take("(")) {
      const value = or();
      assert.ok(take(")"), "condition needs a closing parenthesis");
      return value;
    }
    const token = tokens[index++];
    assert.ok(token, "condition needs an operand");
    if (token.startsWith("'"))
      return {
        kind: "literal",
        value: token.slice(1, -1).replaceAll("''", "'"),
      };
    if (token === "true" || token === "false")
      return { kind: "literal", value: token === "true" };
    if (take("(")) {
      assert.equal(token, "format", "unsupported Actions function");
      const template = primary();
      assert.ok(take(","), "format needs a branch argument");
      const branch = primary();
      assert.ok(take(")"), "format needs a closing parenthesis");
      assert.deepEqual(template, { kind: "literal", value: "refs/heads/{0}" });
      assert.deepEqual(branch, {
        kind: "property",
        path: "github.event.repository.default_branch",
      });
      return { kind: "format", branch };
    }
    assert.match(
      token,
      /^(?:github|vars|secrets)\.[A-Za-z_][A-Za-z0-9_.]*$/,
      "unsupported Actions property",
    );
    return { kind: "property", path: token };
  }
  function equality() {
    let value = primary();
    while (take("==")) value = { kind: "==", left: value, right: primary() };
    return value;
  }
  function and() {
    let value = equality();
    while (take("&&")) value = { kind: "&&", left: value, right: equality() };
    return value;
  }
  function or() {
    let value = and();
    while (take("||")) value = { kind: "||", left: value, right: and() };
    return value;
  }
  const result = or();
  assert.equal(index, tokens.length, "unsupported Actions expression suffix");
  return result;
}

function property(context, path) {
  let value = context;
  for (const part of path.split(".")) {
    const key = Object.keys(value ?? {}).find(
      (candidate) => candidate.toLowerCase() === part.toLowerCase(),
    );
    if (key === undefined) return "";
    value = value[key];
  }
  return value ?? "";
}

function evaluate(node, context) {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "property":
      return property(context, node.path);
    case "format":
      return `refs/heads/${evaluate(node.branch, context)}`;
    case "==": {
      const left = evaluate(node.left, context);
      const right = evaluate(node.right, context);
      if (typeof left === "string" && typeof right === "string")
        return left.toLowerCase() === right.toLowerCase();
      assert.equal(
        typeof left,
        typeof right,
        "unsupported mixed-type equality",
      );
      return left === right;
    }
    case "&&": {
      const left = evaluate(node.left, context);
      if (!left) return left;
      return evaluate(node.right, context);
    }
    case "||": {
      const left = evaluate(node.left, context);
      if (left) return left;
      return evaluate(node.right, context);
    }
    default:
      throw new Error("unsupported Actions expression node");
  }
}

function admitted(condition, context, success = true) {
  if (condition === undefined) return success;
  const parsed = expression(condition);
  return success && Boolean(evaluate(parsed, context));
}

function context(event, ref, branch = "main", vars = {}, secrets = {}) {
  return {
    github: {
      event_name: event,
      ref,
      event: { repository: { default_branch: branch } },
    },
    vars,
    secrets,
  };
}

function receiverStep(workflow) {
  const steps = workflow.jobs.staging.steps.filter((step) => step.run);
  assert.equal(
    steps.length,
    1,
    "receiver command must be the only staging run step",
  );
  return steps[0];
}

function resolveEnvironment(workflow, repository, staging, event = "schedule") {
  const effective = context(
    event,
    "refs/heads/main",
    "main",
    {
      ...repository.vars,
      ...staging.vars,
    },
    {
      ...repository.secrets,
      ...staging.secrets,
    },
  );
  const result = {};
  for (const mapping of [
    workflow.env,
    workflow.jobs.staging.env,
    receiverStep(workflow).env,
  ]) {
    for (const [name, value] of Object.entries(mapping ?? {})) {
      assert.equal(
        typeof value,
        "string",
        "environment bindings must be strings",
      );
      if (/^\s*\$\{\{/.test(value)) {
        result[name] = evaluate(expression(value), effective);
      } else {
        result[name] = value;
      }
    }
  }
  return result;
}

function verifyStructure(workflow) {
  verifyReceiverTriggers(workflow);
  assert.ok(workflow?.jobs?.fixtures, "fixture job must exist");
  assert.ok(workflow?.jobs?.staging, "staging job must exist");
  const staging = workflow.jobs.staging;
  const fixtures = workflow.jobs.fixtures;
  assert.equal(staging.environment, "staging", "staging environment scope");
  assert.equal(
    staging.needs,
    undefined,
    "staging must have no fixture dependency",
  );
  for (const [name, job] of Object.entries({ fixtures, staging })) {
    assert.equal(
      job["continue-on-error"],
      undefined,
      `${name} failures must propagate`,
    );
    const setup = job.steps.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    assert.equal(setup?.with?.["node-version"], "24", `${name} uses Node 24`);
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.equal(
      checkout?.with?.["persist-credentials"],
      false,
      `${name} checkout credential persistence`,
    );
    assert.equal(checkout?.if, undefined, `${name} checkout must run`);
    for (const step of job.steps)
      assert.equal(
        step["continue-on-error"],
        undefined,
        `${name} step failures must propagate`,
      );
  }
  assert.equal(
    staging.steps[0].with.ref,
    "${{ github.event.repository.default_branch }}",
    "staging checkout uses the actual default branch",
  );
  const fixtureCommands = fixtures.steps.filter((step) => step.run);
  assert.equal(fixtureCommands.length, 1, "fixture command must run once");
  assert.equal(
    fixtureCommands[0].run,
    "node ops/diagnostics/receiver-verify.mjs",
    "fixture command",
  );
  const step = receiverStep(workflow);
  assert.equal(
    step.run,
    "node ops/diagnostics/receiver-cli.mjs",
    "receiver command must propagate its exit",
  );
  assert.equal(
    step.env?.REQUEST_ERRORS_ENABLED_STAGING,
    "${{ vars.REQUEST_ERRORS_ENABLED_STAGING }}",
    "activation must forward the raw variable",
  );
  for (const branch of ["main", "trunk-other"]) {
    for (const [event, fixturesExpected, stagingExpected] of [
      ["pull_request", true, false],
      ["push", true, false],
      ["schedule", false, true],
      ["workflow_dispatch", false, true],
    ]) {
      for (const ref of [
        `refs/heads/${branch}`,
        "refs/heads/feature",
        "refs/tags/release",
      ]) {
        for (const raw of ["", "false", "true", "private-invalid-activation"]) {
          const input = context(event, ref, branch, {
            REQUEST_ERRORS_ENABLED_STAGING: raw,
          });
          const fixtureAdmission = admitted(fixtures.if, input);
          assert.equal(
            fixtureAdmission,
            fixturesExpected,
            `fixture event admission ${event} ${ref}`,
          );
          if (fixtureAdmission)
            assert.ok(
              admitted(fixtureCommands[0].if, input),
              "fixture step admission",
            );
          const stagingAdmission = admitted(staging.if, input);
          assert.equal(
            stagingAdmission,
            stagingExpected && ref === `refs/heads/${branch}`,
            `staging event/ref admission ${event} ${ref}`,
          );
          if (stagingAdmission)
            assert.ok(
              admitted(step.if, input),
              "receiver step admission is independent of activation",
            );
          assert.equal(
            admitted(step.if, input, false),
            false,
            "receiver obeys implicit step success",
          );
        }
      }
    }
  }
  for (const raw of [
    "",
    "false",
    "true",
    " TRUE ",
    "private-flag\n::error::private-injection",
  ]) {
    const repository = {
      vars: {
        ...credentialVariables,
        REQUEST_ERRORS_ENABLED_STAGING: "private-repository-flag",
      },
      secrets: credentialSecrets,
    };
    const environment = resolveEnvironment(workflow, repository, {
      vars: { REQUEST_ERRORS_ENABLED_STAGING: raw },
    });
    assert.equal(
      environment.REQUEST_ERRORS_ENABLED_STAGING,
      raw,
      "staging variable wins without coercion",
    );
    assert.equal(
      environment.REQUEST_ERRORS_ENVIRONMENT,
      "staging",
      "declared receiver environment",
    );
  }
  for (const name of Object.keys(credentialVariables)) {
    const environment = resolveEnvironment(
      workflow,
      { vars: { [name]: "private-repository-id" } },
      { vars: credentialVariables, secrets: credentialSecrets },
    );
    assert.equal(
      environment[name],
      credentialVariables[name],
      "staging ID precedence and binding",
    );
  }
  assert.equal(
    resolveEnvironment(
      workflow,
      {
        secrets: {
          RAILWAY_LOG_READER_TOKEN_STAGING: "private-repository-token",
        },
      },
      { secrets: credentialSecrets },
    ).RAILWAY_LOG_READER_TOKEN_STAGING,
    config.token,
    "staging token precedence and binding",
  );
  assert.equal(
    resolveEnvironment(workflow, {}, {}).REQUEST_ERRORS_ENABLED_STAGING,
    "",
    "missing variable resolves to empty",
  );
  assert.equal(
    resolveEnvironment(
      workflow,
      { vars: { REQUEST_ERRORS_ENABLED_STAGING: "false" } },
      {},
    ).REQUEST_ERRORS_ENABLED_STAGING,
    "false",
    "repository fallback is raw",
  );
}

function verifyMutations(workflow) {
  const staging = (changed) => changed.jobs.staging;
  const eventCondition =
    "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";
  const branchCondition =
    "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
  const mutations = [
    ...receiverTriggerMutations,
    [
      "removed branch guard",
      (changed) => {
        staging(changed).if = eventCondition;
      },
      /staging event\/ref admission/,
    ],
    [
      "misgrouped branch guard",
      (changed) => {
        staging(changed).if = `${eventCondition} && ${branchCondition}`;
      },
      /staging event\/ref admission/,
    ],
    [
      "event AND",
      (changed) => {
        staging(changed).if =
          `(${eventCondition.replace("||", "&&")}) && ${branchCondition}`;
      },
      /staging event\/ref admission/,
    ],
    [
      "outer OR",
      (changed) => {
        staging(changed).if = `(${eventCondition}) || ${branchCondition}`;
      },
      /staging event\/ref admission/,
    ],
    [
      "PR observation",
      (changed) => {
        staging(changed).if =
          `(${eventCondition} || github.event_name == 'pull_request') && ${branchCondition}`;
      },
      /staging event\/ref admission/,
    ],
    [
      "hardcoded default branch",
      (changed) => {
        staging(changed).if =
          `(${eventCondition}) && github.ref == 'refs/heads/main'`;
      },
      /staging event\/ref admission/,
    ],
    [
      "missing environment scope",
      (changed) => {
        delete staging(changed).environment;
      },
      /staging environment scope/,
    ],
    [
      "wrong environment scope",
      (changed) => {
        staging(changed).environment = "production";
      },
      /staging environment scope/,
    ],
    [
      "fixture dependency",
      (changed) => {
        staging(changed).needs = "fixtures";
      },
      /no fixture dependency/,
    ],
    [
      "fixture job disabled",
      (changed) => {
        changed.jobs.fixtures.if = "false";
      },
      /fixture event admission/,
    ],
    [
      "fixture events misrouted",
      (changed) => {
        changed.jobs.fixtures.if = "github.event_name == 'schedule'";
      },
      /fixture event admission/,
    ],
    [
      "fixture step disabled",
      (changed) => {
        changed.jobs.fixtures.steps.find((step) => step.run).if = "false";
      },
      /fixture step admission/,
    ],
    [
      "fixture command replaced",
      (changed) => {
        changed.jobs.fixtures.steps.find((step) => step.run).run =
          "node --version";
      },
      /fixture command/,
    ],
    [
      "activation at job",
      (changed) => {
        staging(changed).if +=
          " && vars.REQUEST_ERRORS_ENABLED_STAGING == 'true'";
      },
      /staging event\/ref admission/,
    ],
    [
      "activation at step",
      (changed) => {
        receiverStep(changed).if =
          "vars.REQUEST_ERRORS_ENABLED_STAGING == 'true'";
      },
      /receiver step admission/,
    ],
    [
      "dispatch override",
      (changed) => {
        staging(changed).if += " || github.event_name == 'workflow_dispatch'";
      },
      /staging event\/ref admission/,
    ],
    [
      "raw mapping dropped",
      (changed) => {
        delete receiverStep(changed).env.REQUEST_ERRORS_ENABLED_STAGING;
      },
      /forward the raw variable/,
    ],
    [
      "raw mapping misrouted",
      (changed) => {
        receiverStep(changed).env.REQUEST_ERRORS_ENABLED_STAGING =
          "${{ vars.RAILWAY_PROJECT_ID }}";
      },
      /forward the raw variable/,
    ],
    [
      "raw mapping from secret",
      (changed) => {
        receiverStep(changed).env.REQUEST_ERRORS_ENABLED_STAGING =
          "${{ secrets.REQUEST_ERRORS_ENABLED_STAGING }}";
      },
      /forward the raw variable/,
    ],
    [
      "raw mapping constant",
      (changed) => {
        receiverStep(changed).env.REQUEST_ERRORS_ENABLED_STAGING = "true";
      },
      /forward the raw variable/,
    ],
    [
      "raw mapping coerced",
      (changed) => {
        receiverStep(changed).env.REQUEST_ERRORS_ENABLED_STAGING =
          "${{ vars.REQUEST_ERRORS_ENABLED_STAGING == 'true' }}";
      },
      /forward the raw variable/,
    ],
    [
      "CLI bypassed",
      (changed) => {
        receiverStep(changed).run = "node --version";
      },
      /receiver command/,
    ],
    [
      "CLI failure ignored",
      (changed) => {
        receiverStep(changed).run += " || true";
      },
      /receiver command/,
    ],
    [
      "job failure ignored",
      (changed) => {
        staging(changed)["continue-on-error"] = true;
      },
      /staging failures must propagate/,
    ],
    [
      "step failure ignored",
      (changed) => {
        receiverStep(changed)["continue-on-error"] = true;
      },
      /staging step failures must propagate/,
    ],
  ];
  for (const [label, mutate, expected] of mutations) {
    const changed = structuredClone(workflow);
    mutate(changed);
    assert.throws(
      () => verifyStructure(changed),
      expected,
      `${label} must fail its intended assertion`,
    );
  }
  return mutations.length;
}

async function verifyCommands(workflow, root) {
  const command = receiverStep(workflow).run;
  let children = 0;
  async function check(
    environment,
    expected,
    body = providerBody(),
    status = 200,
  ) {
    await withProvider(
      (reply) => {
        reply.writeHead(status, { "content-type": "application/json" });
        reply.end(JSON.stringify(body));
      },
      async (_fetch, requests, localUrl) => {
        const actual = await runReceiverCommand(
          command,
          root,
          environment,
          localUrl,
        );
        children++;
        assert.equal(actual.exit, expected.exit, expected.label);
        assert.equal(
          actual.attempts,
          expected.requests,
          `${expected.label} attempted fetch count`,
        );
        assert.equal(
          requests.length,
          expected.requests,
          `${expected.label} loopback request count`,
        );
        if (expected.stdout !== undefined)
          assert.equal(actual.stdout, expected.stdout, expected.label);
        if (!expected.requests) return;
        const [request] = requests;
        assert.equal(request.method, "POST");
        assert.equal(request.headers["project-access-token"], config.token);
        assert.equal(request.headers.authorization, undefined);
        assert.equal(request.headers["content-type"], "application/json");
        const { start, end, ...scope } = request.body.variables;
        assert.deepEqual(scope, {
          projectId: config.projectId,
          environmentId: config.environmentId,
          serviceId: config.serviceId,
          filter: `@service:${config.serviceId}`,
        });
        assert.equal(new Date(end) - new Date(start), 30 * 60_000);
        assert.match(
          request.body.query,
          /projectToken\s*\{\s*projectId environmentId\s*\}/,
        );
        assert.match(
          request.body.query,
          /environment\(id: \$environmentId, projectId: \$projectId\)/,
        );
        assert.match(
          request.body.query,
          /serviceInstance\(environmentId: \$environmentId, serviceId: \$serviceId\)/,
        );
        assert.match(request.body.query, /beforeLimit: 500, afterLimit: 0/);
        assert.doesNotMatch(
          request.body.query,
          /mutation|deploymentLogs|afterDate|cursor/,
        );
        assert.equal(
          JSON.stringify(request.body).includes(config.token),
          false,
        );
        assert.equal(
          actual.stdout.includes(inactive.trim()),
          false,
          "enabled observation cannot report inactivity",
        );
        let terminal = expected.reason;
        if (expected.observed !== undefined)
          terminal = `Observed window ${start} through ${end}; accepted failures=${expected.observed}. This observation does not establish application health.\n`;
        if (terminal !== undefined)
          assert.equal(
            actual.stdout,
            `${expected.failure ?? ""}${terminal}`,
            expected.label,
          );
      },
    );
  }
  const missing = {};
  const valid = { vars: credentialVariables, secrets: credentialSecrets };
  const bad = {
    vars: Object.fromEntries(
      Object.keys(credentialVariables).map((name) => [
        name,
        "private-invalid-id",
      ]),
    ),
    secrets: { RAILWAY_LOG_READER_TOKEN_STAGING: "private-invalid-token\n" },
  };
  for (const raw of [undefined, "", "false"]) {
    for (const credentials of [missing, valid, bad]) {
      const vars = { ...credentials.vars };
      if (raw !== undefined) vars.REQUEST_ERRORS_ENABLED_STAGING = raw;
      const env = resolveEnvironment(workflow, {}, { ...credentials, vars });
      await check(env, {
        label: "inactive staging",
        exit: 0,
        requests: 0,
        stdout: inactive,
      });
    }
  }
  const enabled = resolveEnvironment(
    workflow,
    {},
    {
      ...valid,
      vars: { ...valid.vars, REQUEST_ERRORS_ENABLED_STAGING: "true" },
    },
  );
  await check(
    { ...enabled, REQUEST_ERRORS_ENABLED_STAGING: undefined },
    {
      label: "direct staging flag unset",
      exit: 0,
      requests: 0,
      stdout: inactive,
    },
  );
  for (const raw of [
    "TRUE",
    "True",
    "FALSE",
    "False",
    " true",
    "true ",
    " false ",
    "0",
    "1",
    "\t",
    "\n",
    "private-activation\n::error::private-injection",
  ]) {
    await check(
      { ...enabled, REQUEST_ERRORS_ENABLED_STAGING: raw },
      {
        label: "malformed staging activation",
        exit: 2,
        requests: 0,
        stdout: invalidActivation,
      },
    );
  }
  for (const environment of [
    "production",
    undefined,
    "",
    "Staging",
    "staging ",
    "private-environment",
  ]) {
    for (const raw of [
      undefined,
      "",
      "false",
      "true",
      "TRUE",
      "private-activation\n",
    ]) {
      const reason =
        environment === "production" ? "production-disabled" : "invalid-config";
      await check(
        {
          ...enabled,
          REQUEST_ERRORS_ENVIRONMENT: environment,
          REQUEST_ERRORS_ENABLED_STAGING: raw,
        },
        {
          label: "environment precedes activation",
          exit: 2,
          requests: 0,
          stdout: refusal(reason),
        },
      );
    }
  }
  for (const credentials of [missing, bad]) {
    const env = resolveEnvironment(
      workflow,
      {},
      {
        ...credentials,
        vars: { ...credentials.vars, REQUEST_ERRORS_ENABLED_STAGING: "true" },
      },
    );
    await check(env, {
      label: "enabled invalid credentials",
      exit: 2,
      requests: 0,
      stdout: refusal("invalid-config"),
    });
  }
  for (const name of [
    ...Object.keys(credentialVariables),
    ...Object.keys(credentialSecrets),
  ]) {
    await check(
      { ...enabled, [name]: undefined },
      {
        label: "enabled missing credential",
        exit: 2,
        requests: 0,
        stdout: refusal("invalid-config"),
      },
    );
  }
  await check(enabled, {
    label: "enabled empty observation",
    exit: 0,
    requests: 1,
    observed: 0,
  });
  const timestamp = new Date().toISOString();
  const event = consoleEvent();
  const record = { timestamp, message: JSON.stringify(event), attributes: [] };
  const failure = `::error title=Staging request failure::revision=${event.State.Revision} environment=staging route=${event.State.Route} status=500 trace=${event.State.TraceId} classification=unexpected time=${timestamp}\n`;
  await check(
    enabled,
    {
      label: "enabled accepted failure",
      exit: 1,
      requests: 1,
      failure,
      observed: 1,
    },
    providerBody([record]),
  );
  for (const status of [401, 403])
    await check(
      enabled,
      {
        label: "enabled provider refusal",
        exit: 2,
        requests: 1,
        stdout: refusal("provider-refused"),
      },
      { private: "private-provider-error" },
      status,
    );
  const wrongScope = providerBody();
  wrongScope.data.environment.name = "production";
  await check(
    enabled,
    {
      label: "enabled scope refusal",
      exit: 2,
      requests: 1,
      stdout: refusal("scope-mismatch"),
    },
    wrongScope,
  );
  wrongScope.data.environmentLogs = [record];
  await check(
    enabled,
    {
      label: "enabled scope refusal with a failure record",
      exit: 2,
      requests: 1,
      stdout: refusal("scope-mismatch"),
    },
    wrongScope,
  );
  const malformed = {
    ...record,
    message: JSON.stringify({ ...event, Exception: "private-exception" }),
  };
  for (const records of [[malformed], [record, malformed]]) {
    await check(
      enabled,
      {
        label: "enabled incomplete scoped logs",
        exit: 2,
        requests: 1,
        failure: records.length === 2 ? failure : undefined,
        reason:
          "::error title=Request error visibility::status=unavailable reason=invalid-event\n",
      },
      providerBody(records),
    );
  }
  const partial = providerBody([record]);
  partial.errors = [{ message: "private-provider-error" }];
  await check(
    enabled,
    {
      label: "enabled partial provider response",
      exit: 2,
      requests: 1,
      failure,
      reason:
        "::error title=Request error visibility::status=unavailable reason=provider-errors\n",
    },
    partial,
  );
  for (const eventName of ["schedule", "workflow_dispatch"]) {
    const input = context(eventName, "refs/heads/main");
    assert.ok(
      admitted(workflow.jobs.staging.if, input),
      `staging event admission ${eventName} on the default branch`,
    );
    assert.ok(
      admitted(receiverStep(workflow).if, input),
      `receiver step admission ${eventName} on the default branch`,
    );
    for (const [repositoryRaw, stagingRaw, stdout, exit, requests] of [
      ["true", "false", inactive, 0, 0],
      ["true", "", inactive, 0, 0],
      ["false", "true", undefined, 0, 1],
      ["true", undefined, undefined, 0, 1],
      ["false", undefined, inactive, 0, 0],
    ]) {
      const vars = { ...credentialVariables };
      if (stagingRaw !== undefined)
        vars.REQUEST_ERRORS_ENABLED_STAGING = stagingRaw;
      const env = resolveEnvironment(
        workflow,
        { vars: { REQUEST_ERRORS_ENABLED_STAGING: repositoryRaw } },
        { ...valid, vars },
        eventName,
      );
      await check(env, {
        label: `effective scope activation ${eventName}`,
        exit,
        requests,
        stdout,
        observed: requests ? 0 : undefined,
      });
    }
  }
  return children;
}

export async function verifyReceiverWorkflow(workflow, root) {
  const input = context("schedule", "refs/heads/main");
  assert.ok(admitted("github.EVENT_NAME == 'SCHEDULE'", input));
  assert.ok(admitted("vars.missing == ''", input));
  assert.ok(admitted("vars.flag", { vars: { flag: "false" } }));
  assert.ok(admitted("true || false && false", input));
  assert.equal(admitted("(true || false) && false", input), false);
  const inaccessible = {
    get github() {
      throw new Error("short circuit failed");
    },
  };
  assert.ok(admitted("true || github.event_name == 'push'", inaccessible));
  assert.equal(
    admitted("false && github.event_name == 'push'", inaccessible),
    false,
  );
  assert.throws(
    () => admitted("true || always()", input),
    /unsupported Actions function/,
  );
  assert.throws(
    () => admitted("github.event_name != 'push'", input),
    /unsupported Actions expression syntax/,
  );
  verifyStructure(workflow);
  const mutations = verifyMutations(workflow);
  const children = await verifyCommands(workflow, root);
  console.log(
    `Receiver workflow conformance passed (${children} controlled Node 24 children; ${mutations} parsed mutations rejected).`,
  );
}
