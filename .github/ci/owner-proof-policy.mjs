import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const head = "${{ github.event.pull_request.head.sha || github.sha }}";
const prHead = "${{ github.event.pull_request.head.sha }}";
const readOnly = { contents: "read" };
const safeSupplyJobs = [
  "origin-probe",
  "proof-build",
  "proof-scan",
  "proof-application-scan",
];

function equal(actual, expected, location) {
  assert.ok(
    isDeepStrictEqual(actual, expected),
    `${location}: must preserve the complete owner proof recipe`,
  );
}

function keys(actual, expected, location) {
  equal(Object.keys(actual ?? {}).sort(), [...expected].sort(), location);
}

function action(uses, inputs, condition) {
  const value = { uses };
  if (inputs !== undefined) value.with = inputs;
  if (condition !== undefined) value.if = condition;
  return value;
}

function checkout(ref, extra = {}) {
  const inputs = { ...extra, "persist-credentials": false };
  if (ref !== undefined) inputs.ref = ref;
  return action("actions/checkout", inputs);
}

function node(version = 24) {
  return action("actions/setup-node", { "node-version": version });
}

function upload(inputs, condition) {
  return action("actions/upload-artifact", inputs, condition);
}

function recipe(actual, expected, location) {
  const observed = structuredClone(actual);
  for (const [index, step] of (observed?.steps ?? []).entries()) {
    delete step.name;
    if (step.uses !== undefined) {
      assert.match(
        step.uses,
        /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+@[a-f0-9]{40}$/,
        `${location}.steps.${index}: use a full immutable Action SHA`,
      );
      step.uses = step.uses.split("@")[0];
    }
    if (step.run?.includes("\n"))
      step.run =
        "sha256:" + createHash("sha256").update(step.run).digest("hex");
    equal(step, expected.steps[index], `${location}.steps.${index}`);
  }
  equal(
    observed?.steps?.length,
    expected.steps.length,
    `${location}.steps.length`,
  );
  equal(observed, expected, location);
}

function owner(workflows, filename, jobs, lane, env) {
  const value = workflows[filename];
  const location = filename;
  keys(
    value,
    [
      "name",
      "on",
      "permissions",
      "concurrency",
      "jobs",
      ...(env ? ["env"] : []),
    ],
    location,
  );
  equal(value.permissions, readOnly, `${location}.permissions`);
  equal(value.env, env, `${location}.env`);
  keys(value.jobs, jobs, `${location}.jobs`);
  equal(
    value.concurrency,
    {
      group:
        lane +
        "-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": true,
    },
    `${location}.concurrency`,
  );
  return value.jobs;
}

function browser(workflows) {
  const filename = "browser-compatibility.yml";
  const jobs = owner(
    workflows,
    filename,
    ["browser-compatibility"],
    "browser-compatibility",
  );
  recipe(
    jobs["browser-compatibility"],
    {
      name: "Browser compatibility (${{ matrix.mode }})",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 25,
      strategy: { "fail-fast": false, matrix: { mode: ["capture", "verify"] } },
      steps: [
        checkout(head),
        node(),
        action("actions/setup-dotnet", { "global-json-file": "global.json" }),
        action("oven-sh/setup-bun", { "bun-version": "1.3.14" }),
        { run: "bun install --frozen-lockfile" },
        { run: "bun test tests/Browser/visual-support.test.ts" },
        {
          run: "dotnet restore --locked-mode --artifacts-path .audit/check-build",
        },
        {
          run: "dotnet build --no-restore --artifacts-path .audit/check-build",
        },
        {
          run: "bun x --no-install vite build --config tests/Browser/compatibility.vite.config.ts",
        },
        {
          run: "node node_modules/@playwright/test/cli.js install --with-deps chromium firefox webkit",
        },
        { run: "bun run browser:compatibility:${{ matrix.mode }}" },
        upload(
          {
            name: "browser-candidates-" + head + "-${{ github.run_attempt }}",
            path: ".audit/browser-quality/candidates/desktop-creation.png\n.audit/browser-quality/candidates/desktop-saved.png\n.audit/browser-quality/candidates/mobile-layout.png\n.audit/browser-quality/candidates/manifest.json\n.audit/browser-quality/receipts/capture.json\n",
            "include-hidden-files": true,
            "if-no-files-found": "error",
            "retention-days": 7,
          },
          "always() && matrix.mode == 'capture'",
        ),
        upload(
          {
            name: "browser-comparison-" + head + "-${{ github.run_attempt }}",
            path: ".audit/browser-quality/receipts/verify.json\n.audit/browser-quality/test-results/**/*-comparison.json\n.audit/browser-quality/test-results/**/*-comparison.png\n.audit/browser-quality/test-results/**/*-actual.png\n.audit/browser-quality/test-results/**/*-expected.png\n.audit/browser-quality/test-results/**/*-diff.png\n",
            "include-hidden-files": true,
            "if-no-files-found": "ignore",
            "retention-days": 7,
          },
          "always() && matrix.mode == 'verify'",
        ),
      ],
    },
    `${filename}.jobs.browser-compatibility`,
  );
}

function developer(workflows) {
  const filename = "developer-experience.yml";
  const jobs = owner(
    workflows,
    filename,
    ["prerequisites", "focused"],
    "developer-experience",
    {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "false",
    },
  );
  const setup = () => [
    checkout(prHead),
    node("24"),
    action("actions/setup-dotnet", { "global-json-file": "global.json" }),
    action("oven-sh/setup-bun", { "bun-version-file": "package.json" }),
  ];
  recipe(
    jobs.prerequisites,
    {
      name: "Prerequisites (${{ matrix.os }})",
      "runs-on": "${{ matrix.os }}",
      "timeout-minutes": 20,
      strategy: {
        "fail-fast": false,
        matrix: { os: ["ubuntu-latest", "windows-latest"] },
      },
      steps: [
        ...setup(),
        { run: "bun install --frozen-lockfile" },
        { run: "bun test scripts/doctor.test.ts scripts/developer.test.ts" },
        { run: "bun run check:types" },
        { run: "bun run format:check" },
        { if: "runner.os == 'Linux'", run: "bun run doctor backend" },
      ],
    },
    `${filename}.jobs.prerequisites`,
  );
  recipe(
    jobs.focused,
    {
      name: "Clean checkout (${{ matrix.suite }})",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 20,
      strategy: {
        "fail-fast": false,
        matrix: { suite: ["backend", "browser"] },
      },
      steps: [
        ...setup(),
        {
          if: "matrix.suite == 'browser'",
          run: "bun install --frozen-lockfile",
        },
        {
          if: "matrix.suite == 'browser'",
          run: "node node_modules/@playwright/test/cli.js install --with-deps chromium",
        },
        { run: "bun run test:${{ matrix.suite }}" },
      ],
    },
    `${filename}.jobs.focused`,
  );
}

function recovery(workflows) {
  const filename = "recovery-current-image.yml";
  const jobs = owner(
    workflows,
    filename,
    ["current-image-recovery"],
    "recovery-current-image",
  );
  recipe(
    jobs["current-image-recovery"],
    {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 40,
      steps: [
        checkout(head),
        node(),
        {
          run: "node --test ops/recovery/current-image.test.mjs ops/recovery/image-archives.test.mjs ops/recovery/application-proof.test.mjs",
        },
        {
          id: "helper",
          run: "docker build --platform linux/amd64 --file ops/recovery/Dockerfile --tag damadama-recovery-proof .",
        },
        {
          run: "node ops/recovery/current-image.mjs build .audit/current-image.json",
        },
        {
          id: "image-verification",
          run: "node ops/recovery/verify-current-image.mjs .audit/current-image.json",
        },
        {
          run: "node ops/recovery/prove.mjs --require-app .audit/current-image.json",
        },
        {
          if: "${{ !cancelled() && steps.helper.outcome == 'success' }}",
          run: "node ops/recovery/prove.mjs",
        },
        {
          if: "${{ !cancelled() && steps.image-verification.outcome == 'success' }}",
          run: "sha256:9cc53e47f9313ad815596d7d9dfb6bb319241fece655eecf7f16ed3c43c3195b",
        },
        upload(
          {
            name: "synthetic-recovery-receipts",
            "include-hidden-files": true,
            path: ".audit/current-image.json\n.audit/current-image-verification.json\n.audit/recovery-proof-*/receipt.json\n",
            "if-no-files-found": "warn",
            "retention-days": 7,
          },
          "${{ !cancelled() }}",
        ),
      ],
    },
    `${filename}.jobs.current-image-recovery`,
  );
}

function publication(workflows) {
  const filename = "recovery-metadata-publication.yml";
  const jobs = owner(
    workflows,
    filename,
    ["synthetic-publication"],
    "recovery-metadata-publication",
  );
  recipe(
    jobs["synthetic-publication"],
    {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 20,
      steps: [
        checkout(head),
        node(),
        checkout("bef623aa440feeb9a697f610693122889ffc56e4", {
          path: ".audit/ops-consumer",
          "sparse-checkout": "ops/monitoring/monitor.mjs",
          "sparse-checkout-cone-mode": false,
        }),
        {
          run: "python3 -m unittest discover -s ops/recovery -p '*_test.py' -v",
        },
        { run: "sh -n ops/recovery/backup-with-metadata.sh" },
        {
          run: "docker build --platform linux/amd64 --file ops/recovery/Dockerfile --tag damadama-recovery-metadata-proof .",
        },
        { run: "python3 ops/recovery/prove_completion_publication.py" },
        {
          run: "node ops/recovery/verify-completion-consumer.mjs .audit/ops-consumer/ops/monitoring/monitor.mjs .audit/metadata-envelope.json .audit/consumer-compatibility.json",
        },
        {
          run: "sha256:952dd7117bf5730e15ff98a6150a4d60f59307d298f19028dedd274353aab353",
        },
        upload(
          {
            name: "synthetic-metadata-publication-summaries",
            "include-hidden-files": true,
            path: ".audit/completion-publication-proof.json\n.audit/consumer-compatibility.json\n",
            "if-no-files-found": "warn",
            "retention-days": 7,
          },
          "${{ !cancelled() }}",
        ),
      ],
    },
    `${filename}.jobs.synthetic-publication`,
  );
}

function tracing(workflows) {
  const filename = "railway-tracing-check.yml";
  const jobs = owner(workflows, filename, ["tracing"], "railway-tracing");
  recipe(
    jobs.tracing,
    {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      services: {
        postgres: {
          image:
            "postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3",
          env: {
            POSTGRES_DB: "telemetry_proof",
            POSTGRES_USER: "telemetry_proof",
            POSTGRES_PASSWORD: "${{ github.run_id }}-${{ github.run_attempt }}",
          },
          ports: ["5432:5432"],
          options:
            '--health-cmd "pg_isready -U telemetry_proof -d telemetry_proof" --health-interval 5s --health-timeout 5s --health-retries 12',
        },
      },
      steps: [
        checkout(),
        action("actions/setup-dotnet", { "dotnet-version": "10.0.112" }),
        {
          run: "dotnet restore tests/TelemetryProof/TelemetryProof.csproj --locked-mode",
        },
        {
          run: "dotnet format server/Damadama.csproj --no-restore --verify-no-changes",
        },
        {
          run: "dotnet format tests/TelemetryProof/TelemetryProof.csproj --no-restore --verify-no-changes",
        },
        {
          run: "dotnet run --project tests/TelemetryProof/TelemetryProof.csproj --no-restore",
          env: {
            TELEMETRY_POSTGRES:
              "Host=localhost;Port=5432;Database=telemetry_proof;Username=telemetry_proof;Password=${{ github.run_id }}-${{ github.run_attempt }}",
          },
        },
      ],
    },
    `${filename}.jobs.tracing`,
  );
}

function preview(workflows) {
  const filename = "railway-platform-check.yml";
  const jobs = owner(workflows, filename, ["definition"], "railway-platform");
  recipe(
    jobs.definition,
    {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
      steps: [
        checkout(),
        node(),
        {
          run: "npm ci --prefix .railway --ignore-scripts --no-audit --no-fund",
        },
        { run: "npm run check --prefix .railway" },
        {
          run:
            "docker build --file .railway/Preview.Dockerfile --tag damadama-preview:" +
            prHead +
            " .",
        },
        {
          env: {
            PREVIEW_IMAGE: "damadama-preview:" + prHead,
            PUBLISHED_SHA: prHead,
          },
          run: "sha256:ebaaf4e5e52f5d82f641fcf0c91d168bc19cdb358f652e95897e3f8d0c51a978",
        },
        upload({
          name: "preview-runtime-" + prHead,
          path: ".audit/preview-runtime/proof.json",
          "if-no-files-found": "error",
          "include-hidden-files": true,
          "retention-days": 7,
        }),
      ],
    },
    `${filename}.jobs.definition`,
  );
}

function supply(workflows) {
  const filename = "supply-pr-proof.yml";
  const value = workflows[filename];
  keys(value, ["name", "on", "permissions", "jobs"], filename);
  equal(value.on, { workflow_call: null }, `${filename}.on`);
  equal(value.permissions, readOnly, `${filename}.permissions`);
  keys(value.jobs, [...safeSupplyJobs, "supply-pr"], `${filename}.jobs`);
  for (const name of safeSupplyJobs) {
    const actual = value.jobs[name];
    equal(
      actual,
      workflows["supply-chain-proof.yml"]?.jobs?.[name],
      `${filename}.jobs.${name}: trusted/PR drift`,
    );
    const output = { name, "runs-on": "ubuntu-24.04", "timeout-minutes": 30 };
    let steps;
    if (name === "origin-probe") {
      output["timeout-minutes"] = 15;
      steps = [
        checkout(),
        node("24.22.0"),
        { run: "node --test release/supply-origin-probe.test.mjs" },
        { run: "node release/supply-origin-probe.mjs .audit/origin-probe" },
        upload(
          {
            name: "supply-origin-probe-${{ github.run_attempt }}",
            path: ".audit/origin-probe",
            "if-no-files-found": "error",
            "include-hidden-files": true,
            "retention-days": 3,
          },
          "always()",
        ),
      ];
    } else if (name === "proof-build") {
      steps = [
        checkout(undefined, { "fetch-depth": 0 }),
        node("24.22.0"),
        { run: "node --test release/*.test.mjs" },
        { run: "node release/supply-proof.mjs build .audit/proof-build" },
        {
          id: "paths",
          if: "always()",
          run: "node release/supply-proof.mjs upload-paths build",
        },
        upload(
          {
            name: "supply-proof-build-${{ github.run_attempt }}",
            path: "${{ steps.paths.outputs.paths }}",
            "if-no-files-found": "error",
            "include-hidden-files": true,
            "retention-days": 3,
          },
          "always()",
        ),
      ];
    } else {
      output.needs = "proof-build";
      let command = "scan";
      let destination = ".audit/proof-scan";
      let uploadMode = "scan";
      let artifactName = "supply-proof-scan-${{ github.run_attempt }}";
      if (name === "proof-application-scan") {
        command = "scan-application";
        destination = ".audit/proof-application";
        uploadMode = "application-scan";
        artifactName = "supply-proof-application-${{ github.run_attempt }}";
      }
      steps = [
        checkout(),
        node("24.22.0"),
        action("actions/download-artifact", {
          name: "supply-proof-build-${{ github.run_attempt }}",
          path: ".audit/proof-build",
        }),
        { run: "node release/supply-install.mjs scanner" },
        {
          run: `node release/supply-proof.mjs ${command} .audit/proof-build ${destination}`,
        },
        {
          id: "paths",
          if: "always()",
          run: `node release/supply-proof.mjs upload-paths ${uploadMode}`,
        },
        upload(
          {
            name: artifactName,
            path: "${{ steps.paths.outputs.paths }}",
            "if-no-files-found": "error",
            "include-hidden-files": true,
            "retention-days": 90,
          },
          "always()",
        ),
      ];
    }
    output.steps = steps;
    recipe(actual, output, `${filename}.jobs.${name}`);
  }
  recipe(
    value.jobs["supply-pr"],
    {
      needs: safeSupplyJobs,
      if: "always()",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 3,
      permissions: readOnly,
      steps: [
        checkout(),
        node(),
        {
          run: "node .github/ci/required-jobs.mjs supply-pr",
          env: { REQUIRED_JOBS: "${{ toJSON(needs) }}" },
        },
      ],
    },
    `${filename}.jobs.supply-pr`,
  );
}

export function readOwnerProofSources() {
  const read = (path) =>
    readFileSync(new URL("../../" + path, import.meta.url), "utf8");
  return {
    package: JSON.parse(read("package.json")),
    railway: JSON.parse(read(".railway/package.json")),
    telemetry: read("tests/TelemetryProof/TelemetryProof.csproj"),
  };
}

function effectiveRecipes(sources) {
  for (const [name, command] of Object.entries({
    "browser:compatibility:capture":
      "bun tests/Browser/compatibility-run.ts capture",
    "browser:compatibility:verify":
      "bun tests/Browser/compatibility-run.ts verify",
    "test:backend": "bun scripts/developer.ts test:backend",
    "test:browser": "bun scripts/developer.ts test:browser",
    doctor: "bun scripts/doctor.ts",
    "format:check": "bun scripts/developer.ts format:check",
    "check:types":
      "node scripts/type-coverage.mjs && vue-tsc -p web/tsconfig.json --noEmit && tsc -p tests/Browser/tsconfig.json --noEmit && vue-tsc -p tests/Browser/tsconfig.json --noEmit && tsc -p scripts/tsconfig.json --noEmit && tsc -p .railway/tsconfig.json --noEmit && eslint . && node --test scripts/typecheck.test.mjs",
  }))
    equal(
      sources.package.scripts[name],
      command,
      `package.json.scripts.${name}`,
    );
  equal(
    sources.railway.scripts.check,
    "tsc -p tsconfig.json && node --test railway.test.mjs plan.test.mjs && node verify.mjs",
    ".railway/package.json.scripts.check",
  );
  const telemetry = sources.telemetry
    .replace(/\r\n/g, "\n")
    .replace(/Version="[0-9.]+"/, 'Version="VERSION"');
  equal(
    telemetry,
    '<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>\n  <ItemGroup>\n    <ProjectReference Include="../../server/Damadama.csproj" />\n    <PackageReference Include="Npgsql" Version="VERSION" />\n  </ItemGroup>\n</Project>\n',
    "tests/TelemetryProof/TelemetryProof.csproj",
  );
}

export function ownerProofErrors(workflows, sources = readOwnerProofSources()) {
  const errors = [];
  for (const validate of [
    browser,
    developer,
    recovery,
    publication,
    tracing,
    preview,
    supply,
  ]) {
    try {
      validate(workflows);
    } catch (error) {
      errors.push(error.message);
    }
  }
  try {
    effectiveRecipes(sources);
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}
