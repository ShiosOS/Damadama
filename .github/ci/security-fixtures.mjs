import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { readSecurityContract } from "./security-policy.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
export async function exerciseBunAudit(contract) {
  const scenarios = [
    {
      name: "clean",
      severity: null,
      scope: "runtime",
      code: 0,
      message: "No vulnerabilities found",
    },
    {
      name: "below threshold",
      severity: "low",
      scope: "runtime",
      code: 0,
      message: "",
    },
    {
      name: "high runtime",
      severity: "high",
      scope: "runtime",
      code: 1,
      message: "high: Fixture advisory",
    },
    {
      name: "high development",
      severity: "high",
      scope: "development",
      code: 1,
      message: "high: Fixture advisory",
    },
    {
      name: "critical",
      severity: "critical",
      scope: "runtime",
      code: 1,
      message: "critical: Fixture advisory",
    },
    {
      name: "registry error",
      severity: "error",
      scope: "runtime",
      code: 1,
      message: "audit request failed (status 503)",
    },
  ];

  for (const scenario of scenarios) {
    const fixture = await mkdtemp(join(tmpdir(), "security-bun-"));
    const requests = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      requests.push({
        method: request.method,
        path: request.url,
        payload: JSON.parse(
          request.headers["content-encoding"] === "gzip"
            ? gunzipSync(body)
            : body,
        ),
      });
      response.setHeader("content-type", "application/json");
      if (scenario.severity === "error") {
        response.statusCode = 503;
        response.end('{"error":"fixture registry unavailable"}');
        return;
      }
      const advisory = {
        id: 12345,
        url: "https://example.test/advisory/12345",
        title: "Fixture advisory",
        severity: scenario.severity,
        vulnerable_versions: "<=1.0.0",
        cwe: ["CWE-79"],
      };
      response.end(
        scenario.severity
          ? JSON.stringify({ "fixture-package": [advisory] })
          : "{}",
      );
    });

    try {
      server.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const manifest = { name: "security-fixture", version: "1.0.0" };
      const workspace = { name: "security-fixture" };
      manifest[
        scenario.scope === "development" ? "devDependencies" : "dependencies"
      ] = { "fixture-package": "1.0.0" };
      workspace[
        scenario.scope === "development" ? "devDependencies" : "dependencies"
      ] = { "fixture-package": "1.0.0" };
      await writeFile(join(fixture, "package.json"), JSON.stringify(manifest));
      await writeFile(
        join(fixture, "bun.lock"),
        JSON.stringify({
          lockfileVersion: 1,
          configVersion: 1,
          workspaces: { "": workspace },
          packages: {
            "fixture-package": ["fixture-package@1.0.0", "", {}, "sha512-test"],
          },
        }),
      );
      const port = server.address().port;
      const child = spawn(
        contract.bunAudit.argv[0],
        contract.bunAudit.argv.slice(1),
        {
          cwd: fixture,
          env: {
            ...process.env,
            BUN_CONFIG_REGISTRY: `http://127.0.0.1:${port}/`,
          },
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(
        code,
        scenario.code,
        `${scenario.name}: unexpected exit ${code}\n${output}`,
      );
      assert.equal(
        requests.length,
        1,
        `${scenario.name}: expected one native advisory request`,
      );
      assert.equal(requests[0].method, "POST");
      assert.equal(requests[0].path, "/-/npm/v1/security/advisories/bulk");
      assert.deepEqual(requests[0].payload, { "fixture-package": ["1.0.0"] });
      assert.ok(
        output.includes(scenario.message),
        `${scenario.name}: missing diagnostic\n${output}`,
      );
      if (scenario.severity === "high" || scenario.severity === "critical") {
        assert.ok(
          output.includes("fixture-package") &&
            output.includes("https://example.test/advisory/12345"),
        );
      }
      console.log(
        `${scenario.name}: exit ${code}, native request and diagnostic verified`,
      );
    } finally {
      server.close();
      await rm(fixture, { recursive: true, force: true });
    }
  }
}
export async function exerciseDependencyReview(contract) {
  const version = spawnSync("node", ["-p", "process.versions.node"], {
    encoding: "utf8",
  });
  assert.equal(version.status, 0, "native dependency review requires Node");
  assert.match(
    version.stdout,
    /^24\./,
    "native dependency review requires Node 24",
  );

  const scenarios = [
    { name: "clean", severity: null, scope: "runtime", code: 0 },
    { name: "moderate", severity: "moderate", scope: "runtime", code: 0 },
    { name: "high runtime", severity: "high", scope: "runtime", code: 1 },
    {
      name: "high development",
      severity: "high",
      scope: "development",
      code: 1,
    },
    { name: "high unknown", severity: "high", scope: "unknown", code: 1 },
    { name: "critical", severity: "critical", scope: "runtime", code: 1 },
  ];

  for (const scenario of scenarios) {
    const directory = await mkdtemp(join(tmpdir(), "security-dependency-"));
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify([
          {
            change_type: "added",
            manifest: "package-lock.json",
            ecosystem: "npm",
            name: "fixture-package",
            version: "1.0.0",
            package_url: "pkg:npm/fixture-package@1.0.0",
            license: "MIT",
            source_repository_url: null,
            scope: scenario.scope,
            vulnerabilities: scenario.severity
              ? [
                  {
                    severity: scenario.severity,
                    advisory_ghsa_id: "GHSA-abcd-1234-5678",
                    advisory_summary: "Fixture advisory",
                    advisory_url: "https://example.test/GHSA-abcd-1234-5678",
                  },
                ]
              : [],
          },
        ]),
      );
    });
    try {
      server.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const port = server.address().port;
      const outputPath = join(directory, "output");
      const summaryPath = join(directory, "summary");
      await writeFile(outputPath, "");
      await writeFile(summaryPath, "");
      const env = {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_REPOSITORY: "ShiosOS/Damadama",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        "INPUT_REPO-TOKEN": "fixture-token",
        "INPUT_BASE-REF": "base",
        "INPUT_HEAD-REF": "head",
        "INPUT_FAIL-ON-SEVERITY": contract.dependencyReview.severity,
        "INPUT_FAIL-ON-SCOPES": contract.dependencyReview.scopes.join(", "),
        "INPUT_WARN-ONLY": String(contract.dependencyReview.warnOnly),
        "INPUT_SHOW-OPENSSF-SCORECARD": "false",
        "INPUT_LICENSE-CHECK": "false",
        "INPUT_COMMENT-SUMMARY-IN-PR": "never",
      };
      const child = spawn(
        "node",
        [join(root, "fixture-dependency-action/dist/index.js")],
        { env },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(
        code,
        scenario.code,
        `${scenario.name}: exit ${code}\n${output}`,
      );
      assert.equal(
        requests.length,
        1,
        `${scenario.name}: ${requests.join(", ")}`,
      );
      assert.ok(requests[0].includes("/dependency-graph/compare/base...head"));
      if (scenario.code === 1) {
        assert.ok(
          output.includes("fixture-package@1.0.0") &&
            output.includes("Fixture advisory"),
          output,
        );
      } else {
        assert.ok(
          output.includes("did not detect any vulnerable packages"),
          output,
        );
      }
      console.log(
        `${scenario.name}: exit ${code}; native dependency review request and diagnostic verified`,
      );
    } finally {
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
if (import.meta.main) {
  const mode = process.argv[2];
  assert.ok(
    process.argv.length === 3 &&
      ["bun-audit", "dependency-review"].includes(mode),
    "Use security-fixtures.mjs bun-audit|dependency-review",
  );
  const workflows = {};
  for (const name of [
    "security-dependencies.yml",
    "security-codeql.yml",
    "security-fixtures.yml",
  ]) {
    workflows[name] = Bun.YAML.parse(
      await readFile(join(root, ".github/workflows", name), "utf8"),
    );
  }
  const contract = readSecurityContract(workflows);
  if (mode === "bun-audit") await exerciseBunAudit(contract);
  else await exerciseDependencyReview(contract);
}
