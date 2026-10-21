import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gateGraphErrors } from "./workflow-policy.mjs";
import { gates, releaseCallables, requireJobs } from "./required-jobs.mjs";
import {
  ownerProofErrors,
  readOwnerProofSources,
} from "./owner-proof-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflows = Object.fromEntries(
  readdirSync(root + ".github/workflows")
    .filter((name) => name.endsWith(".yml"))
    .map((name) => [
      name,
      Bun.YAML.parse(readFileSync(root + ".github/workflows/" + name, "utf8")),
    ]),
);
const lanes = {
  "browser-compatibility": "browser-compatibility.yml",
  "developer-experience": "developer-experience.yml",
  "current-image-recovery": "recovery-current-image.yml",
  "metadata-publication": "recovery-metadata-publication.yml",
  "supply-pr": "supply-pr-proof.yml",
  tracing: "railway-tracing-check.yml",
  preview: "railway-platform-check.yml",
};
const safeSupply = [
  "origin-probe",
  "proof-build",
  "proof-scan",
  "proof-application-scan",
];
const browser = (w) =>
  w["browser-compatibility.yml"].jobs["browser-compatibility"];
const quiet = (w) => w["browser-compatibility.yml"].jobs["quiet-save-probe"];
const developer = (w) => w["developer-experience.yml"].jobs;
const recovery = (w) =>
  w["recovery-current-image.yml"].jobs["current-image-recovery"];
const publication = (w) =>
  w["recovery-metadata-publication.yml"].jobs["synthetic-publication"];
const tracing = (w) => w["railway-tracing-check.yml"].jobs.tracing;
const preview = (w) => w["railway-platform-check.yml"].jobs.definition;
const supply = (w) => w["supply-pr-proof.yml"].jobs;
const command = (job, text) =>
  job.steps.find((step) => step.run?.includes(text));

function reject(label, mutate, pattern = /complete owner proof recipe/) {
  test(label, () => {
    const changed = structuredClone(workflows);
    mutate(changed);
    const errors = gateGraphErrors(changed);
    assert.ok(
      errors.some((message) => pattern.test(message)),
      errors.join("\n"),
    );
  });
}

test("real composed graph retains all seven fixed contents-read-only lanes", () => {
  assert.deepEqual(gateGraphErrors(workflows), []);
  assert.deepEqual(ownerProofErrors(workflows), []);
  for (const [name, filename] of Object.entries(lanes)) {
    assert.equal(releaseCallables[name].workflow, filename);
    assert.deepEqual(workflows["release-controls.yml"].jobs[name], {
      uses: "$/.github/workflows/" + filename,
      permissions: { contents: "read" },
    });
    assert.ok(gates["release-controls"].needs.includes(name));
  }
  assert.deepEqual(gates.check.needs, [
    "application",
    "diagnostics-policy",
    "workflow-lint",
  ]);
  assert.deepEqual(gates["main-release-controls"].needs, [
    "security-codeql",
    "security-dependencies",
  ]);
});

for (const [name, filename] of Object.entries(lanes)) {
  reject(
    `${name}: missing callable`,
    (w) => delete w[filename],
    /missing|required gate|owner proof recipe|workflow_call/,
  );
  reject(
    `${name}: missing caller`,
    (w) => delete w["release-controls.yml"].jobs[name],
    /required prerequisite is missing/,
  );
  reject(
    `${name}: missing reducer edge`,
    (w) =>
      w["release-controls.yml"].jobs["release-controls"].needs.splice(
        gates["release-controls"].needs.indexOf(name),
        1,
      ),
    /needs must be exactly/,
  );
  for (const [field, value] of [
    ["if", "false"],
    ["continue-on-error", true],
    ["environment", "production"],
    ["secrets", "inherit"],
    ["with", { source: "main" }],
  ])
    reject(
      `${name}: caller ${field}`,
      (w) => (w["release-controls.yml"].jobs[name][field] = value),
      /callable must declare only|unconditionally|continue-on-error|no inputs or secrets/,
    );
  reject(
    `${name}: workflow write permission`,
    (w) => (w[filename].permissions.contents = "write"),
  );
  reject(
    `${name}: workflow shell bypass`,
    (w) => (w[filename].defaults = { run: { shell: "bash {0}; true" } }),
  );
  for (const [jobName, job] of Object.entries(workflows[filename].jobs)) {
    for (const [field, value] of [
      ["if", "false"],
      ["continue-on-error", true],
      ["environment", "production"],
      ["permissions", { contents: "read", "id-token": "write" }],
    ])
      reject(
        `${filename}:${jobName} ${field}`,
        (w) => (w[filename].jobs[jobName][field] = value),
      );
    for (const [index, step] of job.steps.entries()) {
      if (step.run === undefined) continue;
      for (const [field, value] of [
        ["run", step.run + " || true"],
        ["continue-on-error", true],
        ["if", "false"],
      ])
        reject(
          `${filename}:${jobName}:${index} ${field}`,
          (w) => (w[filename].jobs[jobName].steps[index][field] = value),
        );
    }
  }
}

test("owner workflows omit direct PR triggers and retain disjoint concurrency", () => {
  for (const filename of Object.values(lanes).filter(
    (name) => name !== "supply-pr-proof.yml",
  )) {
    const w = workflows[filename];
    assert.equal(Object.hasOwn(w.on, "pull_request"), false, filename);
    assert.ok(Object.hasOwn(w.on, "workflow_call"), filename);
    assert.equal(w.concurrency["cancel-in-progress"], true);
    const group = (workflow) =>
      w.concurrency.group
        .replace("${{ github.workflow }}", workflow)
        .replace(
          "${{ github.event.pull_request.number || github.ref }}",
          "123",
        );
    assert.notEqual(group(w.name), group("Release controls"));
  }
  assert.deepEqual(workflows["recovery-current-image.yml"].on.schedule, [
    { cron: "37 3 * * *" },
  ]);
  assert.deepEqual(workflows["browser-compatibility.yml"].on.schedule, [
    { cron: "17 4 * * 1" },
  ]);
  assert.equal(
    Object.hasOwn(workflows["supply-chain-proof.yml"].on, "pull_request"),
    false,
  );
  assert.deepEqual(workflows["supply-chain-proof.yml"].on.push, {
    branches: ["codex/polish-image-supply-chain"],
  });
});

for (const filename of Object.values(lanes).filter(
  (name) => name !== "supply-pr-proof.yml",
))
  reject(
    `${filename}: parent/direct concurrency collision`,
    (w) => (w[filename].concurrency.group = "proof-${{ github.ref }}"),
  );

for (const [label, mutate] of [
  [
    "quiet diagnostic skips the passive integration selftests",
    (w) => {
      const step = command(quiet(w), "--test-concurrency=1");
      step.run = step.run.replace(
        " .github/diagnostics/quiet-save-integration.test.mjs",
        "",
      );
    },
  ],
  [
    "quiet diagnostic bypasses validation before upload",
    (w) => {
      quiet(w).steps.find((step) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      ).if = "always()";
    },
  ],
  [
    "quiet diagnostic uploads raw output",
    (w) => {
      quiet(w).steps.find((step) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      ).with.path = ".audit/quiet-save/";
    },
  ],
  [
    "quiet diagnostic relaxes the pinned Node runtime",
    (w) => {
      quiet(w).steps.find((step) =>
        step.uses?.startsWith("actions/setup-node@"),
      ).with["node-version"] = 24;
    },
  ],
  [
    "quiet diagnostic extends the job deadline",
    (w) => {
      quiet(w)["timeout-minutes"] = 46;
    },
  ],
  [
    "quiet diagnostic loses the first-step job origin",
    (w) => {
      quiet(w).steps.shift();
    },
  ],
  [
    "quiet diagnostic swaps preparation and origin",
    (w) => {
      [quiet(w).steps[0], quiet(w).steps[1]] = [
        quiet(w).steps[1],
        quiet(w).steps[0],
      ];
    },
  ],
  [
    "quiet diagnostic dispatch also runs the normal matrix",
    (w) => {
      delete browser(w).if;
    },
  ],
  ["browser capture only", (w) => browser(w).strategy.matrix.mode.pop()],
  [
    "browser skipped engine",
    (w) =>
      (command(browser(w), "install --with-deps").run =
        "node node_modules/@playwright/test/cli.js install --with-deps chromium"),
  ],
  [
    "browser snapshots replaced",
    (w) =>
      (command(browser(w), "browser:compatibility").run +=
        " --update-snapshots"),
  ],
  [
    "DX missing Windows",
    (w) => developer(w).prerequisites.strategy.matrix.os.pop(),
  ],
  [
    "DX missing browser wrapper",
    (w) => developer(w).focused.strategy.matrix.suite.pop(),
  ],
  [
    "DX missing alternate fixture ports",
    (w) => delete command(developer(w).focused, "test:").env,
  ],
  [
    "DX default browser port",
    (w) =>
      (command(developer(w).focused, "test:").env.DAMADAMA_BROWSER_PORT =
        "5174"),
  ],
  [
    "DX default API port",
    (w) =>
      (command(developer(w).focused, "test:").env.DAMADAMA_API_PORT = "5055"),
  ],
  [
    "DX shallow format command",
    (w) =>
      (command(developer(w).prerequisites, "format:check").run =
        "echo format checked"),
  ],
  [
    "recovery optional application",
    (w) =>
      (command(recovery(w), "--require-app").run =
        "node ops/recovery/prove.mjs"),
  ],
  [
    "recovery verification omitted",
    (w) =>
      (recovery(w).steps = recovery(w).steps.filter(
        (s) => !s.run?.includes("verify-current-image.mjs"),
      )),
  ],
  [
    "recovery image build omitted",
    (w) =>
      (recovery(w).steps = recovery(w).steps.filter(
        (s) => !s.run?.includes("current-image.mjs build"),
      )),
  ],
  [
    "metadata packaged producer omitted",
    (w) =>
      (command(publication(w), "prove_completion_publication").run =
        "echo fixture"),
  ],
  [
    "metadata unpinned consumer",
    (w) => (publication(w).steps[2].with.ref = "main"),
  ],
  [
    "metadata omitted envelope equality",
    (w) =>
      (command(
        publication(w),
        "assert.equal(consumer.inputEnvelopeSha256",
      ).run = "echo equal"),
  ],
  [
    "tracing HTTP-only shortcut",
    (w) => (command(tracing(w), "dotnet run").run += " -- --http-only"),
  ],
  ["tracing missing real database", (w) => delete tracing(w).services],
  [
    "tracing mutable service image",
    (w) => (tracing(w).services.postgres.image = "postgres:17"),
  ],
  [
    "tracing wrong project",
    (w) =>
      (command(tracing(w), "dotnet run").run =
        "dotnet run --project server/Damadama.csproj --no-restore"),
  ],
  [
    "preview missing real build",
    (w) =>
      (preview(w).steps = preview(w).steps.filter(
        (s) => !s.run?.startsWith("docker build"),
      )),
  ],
  [
    "preview wrong build root",
    (w) =>
      (command(preview(w), "docker build").run = command(
        preview(w),
        "docker build",
      ).run.replace(/ \.$/, " .railway")),
  ],
  [
    "preview missing exported runtime assertions",
    (w) =>
      (command(preview(w), "docker cp").run =
        'docker image inspect "$PREVIEW_IMAGE"'),
  ],
  [
    "browser broad artifact upload",
    (w) => (browser(w).steps.at(-1).with.path = ".audit/**"),
  ],
])
  reject(label, mutate);

for (const name of safeSupply) {
  for (const filename of ["supply-chain-proof.yml", "supply-pr-proof.yml"]) {
    for (const [label, mutate] of [
      ["command", (job) => (job.steps.find((s) => s.run).run += " || true")],
      [
        "pin",
        (job) => (job.steps[0].uses = "actions/checkout@" + "f".repeat(40)),
      ],
      ["source", (job) => (job.steps[0].with.ref = "main")],
      ["guard", (job) => (job.steps[0].if = "false")],
      ["artifact", (job) => (job.steps.at(-1).with.path = ".audit/**")],
      ["needs", (job) => (job.needs = "proof-sign")],
      ["privilege", (job) => (job.permissions = { "id-token": "write" })],
    ])
      reject(
        `${filename}:${name}: unilateral ${label} drift`,
        (w) => mutate(w[filename].jobs[name]),
        /trusted\/PR drift/,
      );
  }
}

for (const name of ["proof-scan", "proof-application-scan"]) {
  reject(
    `${name}: matching missing scan edge refuses independently of equality`,
    (w) => {
      for (const filename of ["supply-chain-proof.yml", "supply-pr-proof.yml"])
        delete w[filename].jobs[name].needs;
    },
  );
  reject(
    `${name}: matching omitted scan refuses independently of equality`,
    (w) => {
      for (const filename of ["supply-chain-proof.yml", "supply-pr-proof.yml"])
        w[filename].jobs[name].steps = w[filename].jobs[name].steps.filter(
          (s) => !s.run?.startsWith("node release/supply-proof.mjs scan"),
        );
    },
  );
}
reject(
  "matching omitted Supply build refuses independently of equality",
  (w) => {
    for (const filename of ["supply-chain-proof.yml", "supply-pr-proof.yml"])
      command(w[filename].jobs["proof-build"], "supply-proof.mjs build").run =
        "echo built";
  },
);
reject(
  "safe Supply cannot include a signer",
  (w) =>
    (supply(w)["proof-sign"] = structuredClone(
      w["supply-chain-proof.yml"].jobs["proof-sign"],
    )),
);
reject(
  "safe Supply cannot call the trusted parent",
  (w) =>
    (supply(w)["proof-build"] = {
      uses: "$/.github/workflows/supply-chain-proof.yml",
    }),
);

test("both scans consume exactly one PR build and trusted jobs keep plain identities", () => {
  const jobs = supply(workflows);
  assert.deepEqual(gates["supply-pr"].needs, safeSupply);
  for (const name of safeSupply) {
    assert.deepEqual(
      jobs[name],
      workflows["supply-chain-proof.yml"].jobs[name],
    );
    assert.equal(jobs[name].name, name);
  }
  for (const name of ["proof-scan", "proof-application-scan"])
    assert.equal(jobs[name].needs, "proof-build");
  assert.deepEqual(
    workflows["supply-chain-proof.yml"].jobs["proof-sign"].needs,
    ["proof-build", "proof-scan", "proof-application-scan"],
  );
  assert.equal(
    workflows["supply-chain-proof.yml"].jobs["proof-verify"].needs,
    "proof-sign",
  );
});

test("the exact Supply replica deliberately repeats the release suite at two fixed PR locations", () => {
  const locations = Object.values(releaseCallables).flatMap(({ workflow }) =>
    Object.entries(workflows[workflow].jobs).flatMap(
      ([job, definition]) =>
        definition.steps
          ?.filter((s) => s.run === "node --test release/*.test.mjs")
          .map(() => `${workflow}:${job}`) ?? [],
    ),
  );
  assert.deepEqual(locations.sort(), [
    "release-runtime-check.yml:runtime-policy",
    "supply-pr-proof.yml:proof-build",
  ]);
});
reject(
  "extra PR release suite copy",
  (w) =>
    w["pr-evidence.yml"].jobs.evidence.steps.push({
      run: "node --test release/*.test.mjs",
    }),
  /suite must run exactly in/,
);
reject(
  "missing Supply release suite copy",
  (w) => {
    for (const filename of ["supply-chain-proof.yml", "supply-pr-proof.yml"])
      w[filename].jobs["proof-build"].steps = w[filename].jobs[
        "proof-build"
      ].steps.filter((s) => s.run !== "node --test release/*.test.mjs");
  },
  /suite must run exactly in/,
);

for (const gate of Object.keys(gates)) {
  const successful = () =>
    Object.fromEntries(
      gates[gate].needs.map((name) => [name, { result: "success" }]),
    );
  test(`${gate}: exact successful native needs accepts`, () =>
    requireJobs(gate, successful()));
  for (const name of gates[gate].needs)
    for (const result of [
      "failure",
      "skipped",
      "cancelled",
      "neutral",
      "timed_out",
      undefined,
    ])
      test(`${gate}: ${name} ${String(result)} refuses`, () => {
        const needs = successful();
        needs[name].result = result;
        assert.throws(() => requireJobs(gate, needs), /result must be success/);
      });
  for (const value of [null, [], "success", 1])
    test(`${gate}: malformed needs ${JSON.stringify(value)} refuses`, () =>
      assert.throws(() => requireJobs(gate, value), /job result object/));
  test(`${gate}: extra prerequisite refuses`, () =>
    assert.throws(
      () =>
        requireJobs(gate, { ...successful(), extra: { result: "success" } }),
      /extra: extra/,
    ));
  for (const name of gates[gate].needs)
    test(`${gate}: missing ${name} refuses`, () => {
      const needs = successful();
      delete needs[name];
      assert.throws(() => requireJobs(gate, needs), /prerequisite jobs differ/);
    });
}

for (const [label, mutate] of [
  [
    "browser verify wrapper now captures",
    (s) =>
      (s.package.scripts["browser:compatibility:verify"] =
        s.package.scripts["browser:compatibility:capture"]),
  ],
  [
    "DX backend script bypass",
    (s) => (s.package.scripts["test:backend"] = "echo passed"),
  ],
  [
    "DX type gate bypass",
    (s) => (s.package.scripts["check:types"] = "echo checked"),
  ],
  [
    "preview effective package script bypass",
    (s) => (s.railway.scripts.check = "echo checked"),
  ],
  [
    "telemetry effective project suppresses build",
    (s) =>
      (s.telemetry = s.telemetry.replace(
        "</Project>",
        '<Target Name="Build" />\n</Project>',
      )),
  ],
])
  test(label, () => {
    const sources = readOwnerProofSources();
    mutate(sources);
    assert.ok(
      ownerProofErrors(workflows, sources).some((e) =>
        /complete owner proof recipe/.test(e),
      ),
    );
  });
