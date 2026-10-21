import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const control = process.argv[2];
if (!["invalid", "held-response"].includes(control))
  throw new Error("Choose invalid or held-response.");
const output = resolve(".audit/compatibility-save-calibration");
await mkdir(output, { recursive: true });
let source = await readFile("tests/Browser/compatibility.pw.ts", "utf8");
function replaceOnce(before, after) {
  if (source.split(before).length !== 2)
    throw new Error("Calibration no longer matches the diagnostic source.");
  source = source.replace(before, after);
}
replaceOnce('"./visual-support"', '"../../tests/Browser/visual-support"');
replaceOnce(
  `  console.info("compatibility-diagnostic", {
    monotonicMs: Math.round(performance.now()),
    event,
    ...details,
  });`,
  `  console.info("compatibility-diagnostic", JSON.stringify({
    monotonicMs: Math.round(performance.now()),
    event,
    ...details,
  }));`,
);
if (control === "invalid") {
  source += `
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("keydown", (event) => {
      if (!(event instanceof KeyboardEvent) || event.key !== "Enter") return;
      const save = document.querySelector("form.habit-form button[type=submit]");
      if (event.target !== save) return;
      const input = document.querySelector('form.habit-form input[aria-label="Name"]');
      if (!(input instanceof HTMLInputElement)) throw new Error("Missing required input.");
      input.value = "";
    }, true);
  });
});
`;
} else {
  source += `
test.beforeEach(async ({ page }) => {
  await page.route("**/api/habits", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    recordDiagnostic("calibration-response-held", { status: response.status() });
    await new Promise<void>(() => {});
  });
});
`;
}
await writeFile(resolve(output, "calibration.pw.ts"), source);
await writeFile(
  resolve(output, "calibration.config.ts"),
  `import shared from "../../tests/Browser/compatibility.config";
const desktop = shared.projects?.find(project => project.name === "chromium-desktop");
if (!desktop) throw new Error("Missing desktop compatibility project.");
export default {
  ...shared,
  testDir: ".",
  testMatch: "calibration.pw.ts",
  snapshotPathTemplate: ${JSON.stringify(resolve("tests/Browser/baselines/{arg}{ext}").replaceAll("\\", "/"))},
  outputDir: "results-${control}",
  projects: [desktop],
  reporter: [[${JSON.stringify(resolve(".github/diagnostics/compatibility-save-calibration-reporter.mjs").replaceAll("\\", "/"))}]],
  maxFailures: 1,
};
`,
);
if (process.argv.includes("--prepare-only")) process.exit(0);
const release = await readFile("/etc/os-release", "utf8").catch(() => "");
const distribution = /^ID="?([^"\n]+)"?$/m.exec(release)?.[1];
const version = /^VERSION_ID="?([^"\n]+)"?$/m.exec(release)?.[1];
if (
  process.platform !== "linux" ||
  distribution !== "ubuntu" ||
  version !== "24.04"
)
  throw new Error("Calibration requires actual Ubuntu 24.04.");
const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
const sha = git.stdout.trim();
if (git.status !== 0 || !/^[a-f0-9]{40}$/.test(sha))
  throw new Error("Cannot establish calibration revision.");
const result = spawnSync(
  "node",
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    resolve(output, "calibration.config.ts"),
    "--grep",
    "desktop creation and saved details remain stable",
    "--update-snapshots=none",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      COMPAT_MODE: "verify",
      COMPAT_CONTROL: "missing",
      COMPAT_CURRENT_SHA: sha,
      COMPAT_OS_DISTRIBUTION: distribution,
      COMPAT_OS_VERSION: version,
      COMPAT_SAVE_CALIBRATION: control,
    },
  },
);
const lines = (await readFile(resolve(output, `${control}.jsonl`), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const results = lines.filter((line) => line.kind === "result");
const events = lines.filter((line) => line.kind === "observation");
const count = (event) => events.filter((line) => line.event === event).length;
let matched =
  result.status === 1 &&
  results.length === 1 &&
  results[0].status === "timedOut" &&
  results[0].responseWait &&
  !results[0].focusAssertion &&
  !results[0].missingBaseline &&
  count("before-save-enter") === 1 &&
  count("after-save-enter") === 1 &&
  !lines.some((line) =>
    ["rejected-observation", "runner-error"].includes(line.kind),
  );
if (control === "invalid") {
  matched &&=
    count("invalid") > 0 &&
    count("submit") === 0 &&
    count("create-request") === 0 &&
    count("create-response") === 0 &&
    events.some(
      (line) =>
        line.event === "invalid" &&
        line.fields?.some(
          (field) => field.label === "Name" && !field.populated && !field.valid,
        ),
    );
} else {
  matched &&=
    count("invalid") === 0 &&
    count("submit") === 1 &&
    count("create-request") === 1 &&
    count("create-response") === 0 &&
    events.filter(
      (line) =>
        line.event === "calibration-response-held" && line.status === 201,
    ).length === 1;
}
console.info(JSON.stringify({ control, calibrationMatched: matched }));
process.exitCode = matched ? 0 : 1;
