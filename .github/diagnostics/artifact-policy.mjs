import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const uploadAction =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const reports = [
  ".audit/TestResults/backend/results.trx",
  ".audit/performance-assets.json",
  ".audit/performance-browser.json",
  ".audit/performance-saved.png",
  ".audit/accessibility-creation-panel.json",
  ".audit/accessibility-creation-panel.png",
  ".audit/today-populated.png",
  ".audit/today-mobile.png",
  ".audit/today-empty.png",
  ".audit/today-flow.webm",
  ".audit/entries-populated.png",
  ".audit/entries-mobile.png",
  ".audit/entries-empty.png",
  ".audit/entries-flow.webm",
  "test-results/habit-creation/failure.png",
  "test-results/habit-creation/error-context.md",
  "tests/Browser/playwright-report/index.html",
  "tests/Browser/playwright-report/data/failure.png",
];
const excluded = [
  ".audit/tokens.json",
  ".audit/unintended.json",
  ".audit/accessibility-token.json",
  ".audit/accessibility-token.png",
  ".audit/today-token.png",
  ".audit/today-token.webm",
  ".audit/entries-token.png",
  ".audit/entries-token.webm",
  ".audit/browser-build/fixture.json",
  ".audit/TestResults/token.json",
  ".audit/TestResults/token.trx",
  ".audit/TestResults/unintended.json",
  "tests/Browser/fixture.json",
  "test-results/.auth/state.json",
  "test-results/.auth/failure.png",
  "test-results/trace.zip",
  "test-results/unintended.json",
  "test-results/habit-creation/token.png",
  "test-results/habit-creation/.env.png",
  "tests/Browser/playwright-report/fixture.json",
  "tests/Browser/playwright-report/access-token.json",
  "tests/Browser/playwright-report/.env.local",
  "tests/Browser/playwright-report/storage-state-user.json",
  "tests/Browser/playwright-report/.auth/state.json",
  "tests/Browser/playwright-report/data/trace.zip",
];
const [command, workflow, directory] = process.argv.slice(2);
assert(
  ["prepare", "verify"].includes(command) &&
    ["check", "stage"].includes(workflow) &&
    directory,
  "Usage: bun .github/diagnostics/artifact-policy.mjs <prepare|verify> <check|stage> <directory>",
);
const root = resolve(directory);
const safePayload = (path) => `Synthetic diagnostic report ${path}\n`;

if (command === "prepare") {
  const source = await readFile(
    new URL(`../workflows/${workflow}.yml`, import.meta.url),
    "utf8",
  );
  const policy = Bun.YAML.parse(source).jobs.check.steps.find(
    (step) => step.id === "failure-reports",
  );
  assert(policy, `${workflow} must have a failure-reports upload step`);
  assert.equal(policy.uses, uploadAction, "Pin the diagnostic upload action");
  assert.equal(
    policy.with["include-hidden-files"],
    true,
    "Include allowlisted reports under .audit",
  );
  assert.equal(
    policy.with["retention-days"],
    { check: 7, stage: 3 }[workflow],
    "Preserve short workflow-specific diagnostic retention",
  );
  assert.equal(typeof policy.with.path, "string", "Define diagnostic paths");
  const paths = policy.with.path.trim().split(/\r?\n/).filter(Boolean);
  assert(paths.length > 0, "Define at least one diagnostic path");
  for (const path of paths) {
    assert(
      /^!?[.\w*]/.test(path) &&
        !path.includes("\\") &&
        !path.includes(":") &&
        !path.replace(/^!/, "").split("/").includes(".."),
      `Keep diagnostic pattern ${path} inside its synthetic fixture`,
    );
  }
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root);
  for (const path of [...reports, ...excluded]) {
    const filename = join(root, path);
    await mkdir(dirname(filename), { recursive: true });
    const payload = reports.includes(path)
      ? safePayload(path)
      : `FORBIDDEN_SYNTHETIC_CREDENTIAL ${path}\n`;
    await writeFile(filename, payload);
  }
  const output = paths
    .map((path) => {
      if (path.startsWith("!")) {
        return `!${root}/${path.slice(1)}`;
      }
      return `${root}/${path}`;
    })
    .join("\n");
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `path<<DIAGNOSTIC_PATHS\n${output}\nDIAGNOSTIC_PATHS\ninclude_hidden_files=${policy.with["include-hidden-files"]}\nretention_days=${policy.with["retention-days"]}\n`,
    );
  } else {
    console.info(output);
  }
  console.info(`Prepared ${workflow} artifact policy with synthetic reports`);
} else {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const actual = entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort();
  assert.deepEqual(
    actual,
    [...reports].sort(),
    "Downloaded diagnostics must contain every allowed report and no credentials, traces, or unrelated files",
  );
  for (const path of reports) {
    assert.equal(
      await readFile(join(root, path), "utf8"),
      safePayload(path),
      `Downloaded report ${path} must contain only its synthetic safe payload`,
    );
  }
  console.info(
    `Verified ${workflow} downloaded artifact with ${actual.length} safe reports`,
  );
}
