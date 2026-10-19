import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const inactive =
  "Staging monitoring inactive; zero requests. This successful run reports disabled state and does not establish live health or alert delivery.";
const invalid =
  "Staging monitoring refused; invalid activation; zero requests.";
const activationName = "OPS_MONITOR_ENABLED_STAGING";
const capability =
  "https://metadata.example.test/fixed/latest.json?secret=SECRET_QUERY_SENTINEL";

function expression(source, context) {
  if (typeof source === "boolean") return source;
  assert.equal(typeof source, "string", "condition must be an expression");
  const text = source.replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, "$1");
  const tokens = [];
  let offset = 0;
  while (offset < text.length) {
    const match =
      /^\s+|^'(?:[^']|'')*'|^(?:==|!=|&&)|^[A-Za-z_][A-Za-z0-9_.]*/.exec(
        text.slice(offset),
      );
    assert.ok(match, "unsupported monitor Actions expression syntax");
    offset += match[0].length;
    if (!/^\s+$/.test(match[0])) tokens.push(match[0]);
  }
  let index = 0;
  function operand() {
    const token = tokens[index++];
    assert.ok(token, "monitor condition needs an operand");
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === "true" || token === "false") return token === "true";
    assert.match(
      token,
      /^(?:github\.(?:event_name|ref)|(?:vars|secrets)\.[A-Za-z_][A-Za-z0-9_]*)$/i,
      "unsupported monitor Actions property",
    );
    let value = context;
    for (const part of token.split(".")) {
      const key = Object.keys(value ?? {}).find(
        (candidate) => candidate.toLowerCase() === part.toLowerCase(),
      );
      value = value?.[key] ?? "";
    }
    return value;
  }
  function comparison() {
    const left = operand();
    const operator = tokens[index];
    if (operator !== "==" && operator !== "!=") return left;
    index++;
    const right = operand();
    assert.equal(typeof left, "string", "monitor comparison uses strings");
    assert.equal(typeof right, "string", "monitor comparison uses strings");
    const equal = left.toLowerCase() === right.toLowerCase();
    if (operator === "==") return equal;
    return !equal;
  }
  let result = comparison();
  while (tokens[index] === "&&") {
    index++;
    const right = comparison();
    result = Boolean(result) && Boolean(right);
  }
  assert.equal(index, tokens.length, "unsupported monitor Actions suffix");
  return result;
}

function admitted(condition, context, success = true) {
  if (condition === undefined) return success;
  return success && Boolean(expression(condition, context));
}

function context(event, ref, raw, configured = true) {
  return {
    github: { event_name: event, ref },
    vars: {
      [activationName]: raw ?? "",
      BACKUP_METADATA_ORIGIN_STAGING: configured
        ? "https://metadata.example.test"
        : "",
    },
    secrets: { BACKUP_METADATA_URL_STAGING: configured ? capability : "" },
  };
}

function commandStep(job) {
  const commands = job.steps.filter((step) => step.run);
  assert.equal(commands.length, 1, "monitor job has one command");
  return commands[0];
}

function dependencies(job) {
  if (job.needs === undefined) return [];
  if (typeof job.needs === "string") return [job.needs];
  assert.ok(Array.isArray(job.needs), "monitor needs must be names");
  return job.needs;
}

function jobAdmitted(job, input, conclusions) {
  const success = dependencies(job).every(
    (name) => conclusions[name] === "success",
  );
  return admitted(job.if, input, success);
}

function environment(workflow, input) {
  const result = {};
  for (const mapping of [
    workflow.env,
    workflow.jobs.staging.env,
    commandStep(workflow.jobs.staging).env,
  ]) {
    for (const [name, value] of Object.entries(mapping ?? {})) {
      assert.equal(typeof value, "string", "monitor env values are strings");
      result[name] = /^\s*\$\{\{/.test(value)
        ? expression(value, input)
        : value;
    }
  }
  return result;
}

function verifyStructure(workflow) {
  assert.deepEqual(
    workflow.on.schedule,
    [{ cron: "2-57/5 * * * *" }],
    "monitor schedule declaration",
  );
  assert.ok(
    Object.hasOwn(workflow.on, "workflow_dispatch"),
    "monitor manual declaration",
  );
  assert.deepEqual(
    workflow.on.pull_request,
    { paths: ["ops/monitoring/**", ".github/workflows/ops-monitor.yml"] },
    "monitor PR declaration",
  );
  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "monitor permissions",
  );
  assert.ok(workflow.jobs.fixtures, "monitor fixtures exist");
  assert.ok(workflow.jobs.staging, "monitor staging exists");
  const { fixtures, staging } = workflow.jobs;
  assert.equal(
    staging.name,
    "Staging monitoring activation and observation",
    "honest staging job name",
  );
  assert.equal(
    staging.environment,
    undefined,
    "monitor has no environment scope",
  );
  assert.deepEqual(
    dependencies(staging),
    ["fixtures"],
    "monitor fixture prerequisite",
  );
  assert.deepEqual(
    dependencies(fixtures),
    [],
    "monitor fixtures have no prerequisite",
  );
  const fixture = commandStep(fixtures);
  const cli = commandStep(staging);
  assert.equal(
    fixture.run,
    "node --test ops/monitoring/monitor.test.mjs",
    "monitor fixture command",
  );
  assert.equal(
    cli.run,
    "node ops/monitoring/run.mjs",
    "monitor CLI command propagates exit",
  );
  assert.equal(
    cli.env?.[activationName],
    "${{ vars.OPS_MONITOR_ENABLED_STAGING }}",
    "monitor raw activation mapping",
  );
  for (const [name, job] of Object.entries({ fixtures, staging })) {
    assert.equal(
      job["continue-on-error"],
      undefined,
      `${name} failures propagate`,
    );
    const setup = job.steps.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    assert.equal(
      String(setup?.with?.["node-version"]),
      "24",
      `${name} Node 24`,
    );
    assert.equal(
      setup.uses,
      "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
      `${name} pinned Node action`,
    );
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.equal(
      checkout?.uses,
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      `${name} pinned checkout`,
    );
    assert.equal(
      checkout.with?.["persist-credentials"],
      false,
      `${name} credential persistence`,
    );
    for (const step of job.steps)
      assert.equal(
        step["continue-on-error"],
        undefined,
        `${name} step failures propagate`,
      );
  }
  for (const [event, ref, expected] of [
    ["pull_request", "refs/heads/main", false],
    ["pull_request", "refs/heads/other", false],
    ["schedule", "refs/heads/main", true],
    ["workflow_dispatch", "refs/heads/main", true],
    ["workflow_dispatch", "refs/heads/other", false],
    ["SCHEDULE", "REFS/HEADS/MAIN", true],
  ]) {
    for (const [raw, configured] of [
      undefined,
      "",
      "false",
      "true",
      "private-invalid",
    ].flatMap((raw) => [
      [raw, true],
      [raw, false],
    ])) {
      const input = context(event, ref, raw, configured);
      assert.ok(jobAdmitted(fixtures, input, {}), "monitor fixture admission");
      assert.ok(admitted(fixture.if, input), "monitor fixture step admission");
      assert.equal(
        jobAdmitted(staging, input, { fixtures: "success" }),
        expected,
        `monitor event/ref admission ${event} ${ref}`,
      );
      for (const conclusion of ["failure", "skipped", "cancelled"])
        assert.equal(
          jobAdmitted(staging, input, { fixtures: conclusion }),
          false,
          "unsuccessful fixtures block monitor",
        );
      if (expected)
        assert.ok(
          admitted(cli.if, input),
          "monitor CLI admission independent of activation",
        );
      assert.equal(
        admitted(cli.if, input, false),
        false,
        "monitor CLI default success",
      );
      assert.equal(
        environment(workflow, input)[activationName],
        raw ?? "",
        "monitor activation forwarded unchanged",
      );
    }
  }
}

function verifyMutations(workflow) {
  const mutations = [
    [
      "PR trigger deleted",
      (w) => delete w.on.pull_request,
      /monitor PR declaration/,
    ],
    [
      "PR paths deleted",
      (w) => delete w.on.pull_request.paths,
      /monitor PR declaration/,
    ],
    [
      "PR path changed",
      (w) => (w.on.pull_request.paths[0] = "ops/diagnostics/**"),
      /monitor PR declaration/,
    ],
    [
      "PR path removed",
      (w) => w.on.pull_request.paths.pop(),
      /monitor PR declaration/,
    ],
    [
      "PR branch filter added",
      (w) => (w.on.pull_request.branches = ["main"]),
      /monitor PR declaration/,
    ],
    [
      "removed main guard",
      (w) => (w.jobs.staging.if = "github.event_name != 'pull_request'"),
      /monitor event\/ref admission/,
    ],
    [
      "PR admitted",
      (w) => (w.jobs.staging.if = "github.ref == 'refs/heads/main'"),
      /monitor event\/ref admission/,
    ],
    [
      "fixtures suppressed",
      (w) => (w.jobs.fixtures.if = "false"),
      /monitor fixture admission/,
    ],
    [
      "fixture step suppressed",
      (w) => (commandStep(w.jobs.fixtures).if = "false"),
      /monitor fixture step admission/,
    ],
    [
      "fixture command replaced",
      (w) => (commandStep(w.jobs.fixtures).run = "node --version"),
      /monitor fixture command/,
    ],
    [
      "fixtures detached",
      (w) => delete w.jobs.staging.needs,
      /monitor fixture prerequisite/,
    ],
    [
      "activation job gate",
      (w) =>
        (w.jobs.staging.if += " && vars.OPS_MONITOR_ENABLED_STAGING == 'true'"),
      /monitor event\/ref admission/,
    ],
    [
      "activation step gate",
      (w) =>
        (commandStep(w.jobs.staging).if =
          "vars.OPS_MONITOR_ENABLED_STAGING == 'true'"),
      /monitor CLI admission/,
    ],
    [
      "metadata origin presence gate",
      (w) =>
        (w.jobs.staging.if += " && vars.BACKUP_METADATA_ORIGIN_STAGING != ''"),
      /monitor event\/ref admission/,
    ],
    [
      "mapping dropped",
      (w) => delete commandStep(w.jobs.staging).env[activationName],
      /monitor raw activation mapping/,
    ],
    [
      "mapping misrouted",
      (w) =>
        (commandStep(w.jobs.staging).env[activationName] =
          "${{ vars.BACKUP_METADATA_ORIGIN_STAGING }}"),
      /monitor raw activation mapping/,
    ],
    [
      "mapping from secret",
      (w) =>
        (commandStep(w.jobs.staging).env[activationName] =
          "${{ secrets.OPS_MONITOR_ENABLED_STAGING }}"),
      /monitor raw activation mapping/,
    ],
    [
      "mapping coerced",
      (w) =>
        (commandStep(w.jobs.staging).env[activationName] =
          "${{ vars.OPS_MONITOR_ENABLED_STAGING == 'true' }}"),
      /monitor raw activation mapping/,
    ],
    [
      "CLI replaced",
      (w) => (commandStep(w.jobs.staging).run = "node --version"),
      /monitor CLI command/,
    ],
    [
      "CLI failure ignored",
      (w) => (commandStep(w.jobs.staging).run += " || true"),
      /monitor CLI command/,
    ],
    [
      "job tolerant",
      (w) => (w.jobs.staging["continue-on-error"] = true),
      /staging failures propagate/,
    ],
    [
      "step tolerant",
      (w) => (commandStep(w.jobs.staging)["continue-on-error"] = true),
      /staging step failures propagate/,
    ],
  ];
  for (const [label, mutate, expected] of mutations) {
    const changed = structuredClone(workflow);
    mutate(changed);
    assert.throws(
      () => verifyStructure(changed),
      expected,
      `${label} rejected at intended assertion`,
    );
  }
  return mutations.length;
}

async function child(command, root, environment, preload, scenario) {
  const [runtime, ...args] = command.split(" ");
  assert.equal(runtime, "node", "monitor command runtime");
  const argv = ["node", "--import", preload, ...args];
  const started = performance.now();
  const child = spawn(argv[0], argv.slice(1), {
    cwd: root,
    env: Object.fromEntries(
      Object.entries({
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ...environment,
      }).filter(([, value]) => value !== undefined),
    ),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value) => (stdout += value));
  child.stderr.setEncoding("utf8").on("data", (value) => (stderr += value));
  function diagnostic(failure) {
    console.error(
      JSON.stringify({
        scenario,
        argv,
        pid: child.pid ?? null,
        elapsedMs: Math.round(performance.now() - started),
        ...failure,
        stdout: stdout.slice(-4096),
        stderr: stderr.slice(-4096),
      }),
    );
  }
  let exit;
  let signal;
  try {
    [exit, signal] = await once(child, "close");
  } catch (error) {
    diagnostic({ error: error.code ?? error.name });
    throw error;
  }
  if (signal !== null) diagnostic({ signal });
  assert.equal(signal, null, "monitor child terminated normally");
  return { exit, stdout, stderr };
}

async function verifyCommands(workflow, root) {
  const version =
    "data:text/javascript,if(Number(process.versions.node.split('.')[0])!==24)throw Error('Monitor conformance requires Node 24')";
  const fixture = await child(
    commandStep(workflow.jobs.fixtures).run,
    root,
    {},
    version,
    "parsed fixture command",
  );
  console.log(JSON.stringify({ label: "parsed fixture command", ...fixture }));
  assert.equal(fixture.exit, 0, fixture.stdout + fixture.stderr);
  assert.match(
    fixture.stdout,
    /CLI inactive activation/,
    "actual monitor fixture command ran",
  );
  const directory = await mkdtemp(join(tmpdir(), "monitor-workflow-"));
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.method, "GET");
    response.writeHead(204);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let children = 1;
  const preload = pathToFileURL(
    join(root, "ops/monitoring/fixtures/fetch.mjs"),
  ).href;
  try {
    for (const event of ["schedule", "workflow_dispatch"]) {
      for (const [
        label,
        raw,
        scenario,
        configuration,
        expectedExit,
        expectedAttempts,
        expected,
      ] of [
        ["unset", undefined, "healthy", {}, 0, 0, inactive],
        ["empty", "", "healthy", {}, 0, 0, inactive],
        [
          "false invalid metadata",
          "false",
          "healthy",
          {
            BACKUP_METADATA_URL_STAGING: "private-capability",
            BACKUP_METADATA_ORIGIN_STAGING: "private-origin",
          },
          0,
          0,
          inactive,
        ],
        [
          "invalid",
          "private-activation\n::error::private-injection",
          "healthy",
          {},
          1,
          0,
          invalid,
        ],
        ["case invalid", "TRUE", "healthy", {}, 1, 0, invalid],
        [
          "healthy",
          "true",
          "healthy",
          {},
          0,
          4,
          "environment=staging verdict=healthy",
        ],
        [
          "missing URL",
          "true",
          "healthy",
          { BACKUP_METADATA_URL_STAGING: undefined },
          1,
          3,
          "reason=metadata-url-missing",
        ],
        [
          "missing origin",
          "true",
          "healthy",
          { BACKUP_METADATA_ORIGIN_STAGING: undefined },
          1,
          3,
          "reason=metadata-origin-invalid",
        ],
        [
          "stale",
          "true",
          "stale",
          {},
          1,
          4,
          "verdict=stale reason=stale-completion",
        ],
        [
          "refused",
          "true",
          "refused",
          {},
          1,
          4,
          "verdict=refused reason=http-refused",
        ],
        [
          "unhealthy",
          "true",
          "app-503",
          {},
          1,
          5,
          "verdict=unavailable reason=http-failure",
        ],
      ]) {
        const input = context(event, "refs/heads/main", raw);
        assert.ok(
          jobAdmitted(workflow.jobs.staging, input, { fixtures: "success" }),
        );
        const attempts = join(directory, "attempts.json");
        const summary = join(directory, "summary.md");
        await writeFile(summary, "");
        requests = 0;
        const env = {
          ...environment(workflow, input),
          ...configuration,
          MONITOR_TEST_CASE: scenario,
          MONITOR_TEST_ATTEMPTS: attempts,
          MONITOR_TEST_TRANSPORT_URL: `http://127.0.0.1:${server.address().port}/request`,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_ACTIONS: "true",
          GITHUB_SHA: "d".repeat(40),
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
        };
        if (label === "unset") delete env[activationName];
        const actual = await child(
          commandStep(workflow.jobs.staging).run,
          root,
          env,
          preload,
          `${event} ${label}`,
        );
        children++;
        const attempted = JSON.parse(await readFile(attempts, "utf8"));
        const summaryText = await readFile(summary, "utf8");
        assert.equal(actual.exit, expectedExit, `${event} ${label} exit`);
        assert.equal(
          attempted,
          expectedAttempts,
          `${event} ${label} fetch attempts`,
        );
        assert.equal(
          requests,
          expectedAttempts,
          `${event} ${label} independent loopback requests`,
        );
        assert.ok(actual.stdout.includes(expected), `${event} ${label} stdout`);
        assert.equal(
          summaryText,
          actual.stdout,
          `${event} ${label} actual step summary`,
        );
        assert.match(actual.stdout, /environment=production verdict=disabled/);
        if (expectedAttempts === 0) {
          const severity = expectedExit ? "error" : "notice";
          assert.equal(
            actual.stderr,
            `::${severity} title=Staging operational monitor::${expected}\n`,
            `${event} ${label} annotation`,
          );
        } else if (expectedExit) {
          assert.match(
            actual.stderr,
            /^::error title=Staging operational monitor::environment=staging verdict=/,
          );
          assert.ok(actual.stderr.includes(expected));
        } else assert.equal(actual.stderr, "");
        assert.doesNotMatch(
          actual.stdout + actual.stderr + summaryText,
          /private-|SECRET_|PRIVATE_|metadata\.example\.test|untrusted\.invalid|::error::/,
        );
        console.log(
          JSON.stringify({
            event,
            label,
            ...actual,
            attempted,
            requests,
            summary: summaryText,
          }),
        );
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
  return children;
}

export async function verifyMonitorChildFailure(root) {
  const preload =
    "data:text/javascript," +
    encodeURIComponent(
      "process.stdout.write('x'.repeat(5000) + '\\n::error::stdout-sentinel\\n'); process.stderr.write('y'.repeat(5000) + '\\n::error::stderr-sentinel\\n'); process.kill(process.pid, 'SIGTERM');",
    );
  const diagnostics = [];
  const previous = console.error;
  console.error = (value) => diagnostics.push(value);
  try {
    await assert.rejects(
      child(
        "node --eval 0",
        join(root, "missing-monitor-test-directory"),
        { PRIVATE_TEST_ENV: "never-print-this" },
        preload,
        "controlled spawn error",
      ),
      { code: "ENOENT" },
    );
    if (process.platform !== "win32") {
      await assert.rejects(
        child(
          "node --eval 0",
          root,
          { PRIVATE_TEST_ENV: "never-print-this" },
          preload,
          "controlled immediate signal",
        ),
        /monitor child terminated normally/,
      );
    }
  } finally {
    console.error = previous;
  }
  const failedSpawn = JSON.parse(diagnostics[0]);
  assert.equal(failedSpawn.scenario, "controlled spawn error");
  assert.equal(failedSpawn.error, "ENOENT");
  assert.equal(failedSpawn.pid, null);
  assert.equal(failedSpawn.stdout, "");
  assert.equal(failedSpawn.stderr, "");
  for (const line of diagnostics) {
    assert.ok(!line.includes("\n"), "diagnostic must JSON-escape child lines");
    assert.ok(
      !line.includes("never-print-this"),
      "diagnostic excludes environment",
    );
    const actual = JSON.parse(line);
    assert.deepEqual(actual.argv, ["node", "--import", preload, "--eval", "0"]);
    assert.ok(Number.isInteger(actual.elapsedMs) && actual.elapsedMs >= 0);
  }
  if (process.platform === "win32") {
    assert.equal(diagnostics.length, 1);
    return;
  }
  assert.equal(diagnostics.length, 2);
  const actual = JSON.parse(diagnostics[1]);
  assert.equal(actual.scenario, "controlled immediate signal");
  assert.ok(Number.isInteger(actual.pid) && actual.pid > 0);
  assert.equal(actual.signal, "SIGTERM");
  assert.equal(actual.stdout.length, 4096);
  assert.equal(actual.stderr.length, 4096);
  assert.match(actual.stdout, /stdout-sentinel/);
  assert.match(actual.stderr, /stderr-sentinel/);
}

export async function verifyMonitorWorkflow(workflow, root) {
  assert.equal(
    expression(
      "github.EVENT_NAME != 'PULL_REQUEST' && github.REF == 'REFS/HEADS/MAIN'",
      context("schedule", "refs/heads/main"),
    ),
    true,
  );
  assert.throws(
    () => expression("always()", {}),
    /unsupported monitor Actions/,
  );
  assert.throws(
    () => expression("true || false", {}),
    /unsupported monitor Actions/,
  );
  verifyStructure(workflow);
  const mutations = verifyMutations(workflow);
  const children = await verifyCommands(workflow, root);
  console.log(
    `Monitor workflow conformance passed (${children} controlled Node 24 children; ${mutations} parsed mutations rejected). Declared configuration proof only.`,
  );
}
