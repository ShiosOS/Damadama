import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { ESLint } from "eslint";
import { gateGraphErrors } from "./workflow-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflows = {};
for (const filename of await readdir(join(root, ".github/workflows"))) {
  if (!/\.ya?ml$/.test(filename)) continue;
  workflows[filename] = Bun.YAML.parse(
    await readFile(join(root, ".github/workflows", filename), "utf8"),
  );
}

function setupNodeSteps(graph) {
  return Object.values(graph)
    .flatMap((workflow) => Object.values(workflow.jobs ?? {}))
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.uses?.startsWith("actions/setup-node@"));
}

test("current workflow graph accepts its complete setup-node cohort", () => {
  assert.ok(setupNodeSteps(workflows).length > 1);
  assert.deepEqual(gateGraphErrors(workflows), []);
});

test("a whole setup-node cohort can move to another reviewed immutable ref", () => {
  const changed = structuredClone(workflows);
  const steps = setupNodeSteps(changed);
  for (const step of steps) step.uses = "actions/setup-node@" + "c".repeat(40);
  assert.equal(steps.length, setupNodeSteps(workflows).length);
  assert.deepEqual(gateGraphErrors(changed), []);
});

for (const ref of [
  "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "249970729cb0ef3589644e2896645e5dc5ba9c38",
]) {
  test(`one historical setup-node ref ${ref} refuses a partial cohort`, () => {
    const changed = structuredClone(workflows);
    const step = changed["check.yml"].jobs["workflow-lint"].steps.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    step.uses = `actions/setup-node@${ref}`;
    const errors = gateGraphErrors(changed);
    const diagnostic = errors.find((error) =>
      error.startsWith("Direct actions/setup-node calls use multiple refs."),
    );
    assert.ok(diagnostic, errors.join("\n"));
    assert.ok(diagnostic.includes(ref));
    assert.match(diagnostic, /check\.yml:jobs\.workflow-lint\.steps\[\d+\]/);
    assert.match(diagnostic, /update every direct setup-node call together/);
  });
}

test("a newly added job must join the existing setup-node cohort", () => {
  const changed = structuredClone(workflows);
  changed["check.yml"].jobs.additional = {
    "runs-on": "ubuntu-latest",
    steps: [{ uses: "actions/setup-node@" + "c".repeat(40) }],
  };
  assert.ok(
    gateGraphErrors(changed).some((error) =>
      error.includes("check.yml:jobs.additional.steps[0]"),
    ),
  );
});

test("coordinated security Action upgrades remain independent of setup-node", () => {
  const changed = structuredClone(workflows);
  changed["security-dependencies.yml"].jobs["dependency-review"].steps[1].uses =
    "actions/dependency-review-action@" + "a".repeat(40);
  changed["security-fixtures.yml"].jobs["dependency-review"].steps[1].with.ref =
    "a".repeat(40);
  for (const job of [
    changed["security-codeql.yml"].jobs.analyze,
    changed["security-codeql.yml"].jobs.upload,
    changed["security-fixtures.yml"].jobs.codeql,
  ]) {
    for (const step of job.steps) {
      if (step.uses?.startsWith("github/codeql-action/")) {
        step.uses = step.uses.split("@")[0] + "@" + "b".repeat(40);
      }
    }
  }
  assert.deepEqual(gateGraphErrors(changed), []);
});

const eslint = new ESLint({ cwd: root });
for (const [name, source, rejected] of [
  [
    "exactly 1000 physical lines",
    "// kept\n".repeat(999) + "export {};\n",
    false,
  ],
  [
    "1001 lines including comments",
    "// kept\n".repeat(1000) + "export {};\n",
    true,
  ],
  ["1001 blank lines", "\n".repeat(1001), true],
  [
    "an inline attempt to disable the cap",
    "/* eslint max-lines: off */\n" + "// kept\n".repeat(1000),
    true,
  ],
]) {
  test(`configured ESLint ${rejected ? "refuses" : "accepts"} ${name}`, async () => {
    const result = await eslint.lintText(source, {
      filePath: join(root, "release/line-limit-proof.mjs"),
    });
    const errors = result.flatMap((file) =>
      file.messages.filter((message) => message.severity === 2),
    );
    if (rejected) {
      assert.ok(errors.some((message) => message.ruleId === "max-lines"));
    } else {
      assert.deepEqual(errors, []);
    }
  });
}
