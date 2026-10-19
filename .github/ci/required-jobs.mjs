import { pathToFileURL } from "node:url";

export const releaseCallables = {
  "runtime-policy": {
    workflow: "release-runtime-check.yml",
    permissions: { contents: "read" },
    kind: "core-leaf",
  },
  recovery: {
    workflow: "recovery-check.yml",
    permissions: { contents: "read" },
    kind: "core-leaf",
  },
  evidence: {
    workflow: "pr-evidence.yml",
    permissions: { contents: "read", "pull-requests": "read" },
    kind: "core-leaf",
  },
  "security-codeql": {
    workflow: "security-codeql.yml",
    permissions: {
      contents: "read",
      actions: "read",
      "security-events": "write",
    },
    kind: "security",
  },
  "security-dependencies": {
    workflow: "security-dependencies.yml",
    permissions: { contents: "read", "pull-requests": "read" },
    kind: "security",
  },
  "security-fixtures": {
    workflow: "security-fixtures.yml",
    permissions: { contents: "read" },
    kind: "security",
  },
};

export const gates = {
  "main-release-controls": {
    workflow: "stage.yml",
    job: "release-controls",
    needs: ["security-codeql", "security-dependencies"],
  },
  check: {
    workflow: "check.yml",
    needs: ["application", "diagnostics-policy", "workflow-lint"],
  },
  "release-controls": {
    workflow: "release-controls.yml",
    needs: Object.keys(releaseCallables),
  },
};

export function requireJobs(gate, needs) {
  const expected = gates[gate]?.needs;
  if (!expected) throw new Error(`Unknown required gate: ${gate}`);
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    throw new Error(`${gate}: needs must be a job result object`);
  }
  const actual = Object.keys(needs);
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length || extra.length) {
    throw new Error(
      `${gate}: prerequisite jobs differ; missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}`,
    );
  }
  for (const name of expected) {
    if (needs[name]?.result !== "success") {
      throw new Error(
        `${gate}: ${name} result must be success, got ${String(needs[name]?.result)}`,
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    requireJobs(process.argv[2], JSON.parse(process.env.REQUIRED_JOBS ?? ""));
    console.log(`${process.argv[2]}: all required jobs succeeded`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
