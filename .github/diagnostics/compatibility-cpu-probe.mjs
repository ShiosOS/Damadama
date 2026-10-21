import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const rate = process.argv[2];
if (!["1", "8"].includes(rate)) throw new Error("Choose CPU rate 1 or 8.");
const output = resolve(".audit/compatibility-cpu-probe");
await mkdir(output, { recursive: true });
const accounts = [
  "owner",
  "other",
  "reload",
  "list",
  "listRecovery",
  "errors",
  "cleanup",
  "performance",
  "accessibility",
  "accessibilityControl",
  "accessibilityMobile",
  "accessibilityZoom",
  "stale",
  "saveVisibilityIneligible",
  "saveVisibilityEligible",
  "saveVisibilityHeld",
  "saveVisibilityReduced",
  "saveVisibilityPopulated",
  "saveVisibilityError",
  "saveVisibilityReopen",
];
const host = await readFile("tests/BrowserHost/Program.cs", "utf8");
for (const account of accounts)
  if (!host.includes(`    ${account} = app.Token(`))
    throw new Error("A selected synthetic account is missing.");

let source = await readFile("tests/Browser/compatibility.pw.ts", "utf8");
function replaceOnce(before, after) {
  if (source.split(before).length !== 2)
    throw new Error(
      "Diagnostic generator no longer matches the frozen source.",
    );
  source = source.replace(before, after);
}
replaceOnce('"./visual-support"', '"../../tests/Browser/visual-support"');
replaceOnce(
  '  await start(page, accounts["chromium-desktop"]);',
  `  const account = ${JSON.stringify(accounts)}[testInfo.repeatEachIndex];
  if (!account) throw new Error("Missing fresh synthetic account.");
  await start(page, account);`,
);
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
source += `
test.beforeEach(async ({ page }) => {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: ${rate} });
});
`;
await writeFile(resolve(output, "stress.pw.ts"), source);
await writeFile(
  resolve(output, "stress.config.ts"),
  `import shared from "../../tests/Browser/compatibility.config";
const desktop = shared.projects?.find(project => project.name === "chromium-desktop");
if (!desktop) throw new Error("Missing desktop compatibility project.");
export default {
  ...shared,
  testDir: ".",
  testMatch: "stress.pw.ts",
  snapshotPathTemplate: ${JSON.stringify(resolve("tests/Browser/baselines/{arg}{ext}").replaceAll("\\", "/"))},
  outputDir: "results-rate-${rate}",
  projects: [desktop],
  reporter: [[${JSON.stringify(resolve(".github/diagnostics/compatibility-cpu-reporter.mjs").replaceAll("\\", "/"))}]],
  repeatEach: 20,
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
  throw new Error("The CPU experiment requires actual Ubuntu 24.04.");
const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
const sha = git.stdout.trim();
if (git.status !== 0 || !/^[a-f0-9]{40}$/.test(sha))
  throw new Error("Cannot establish experiment revision.");
const result = spawnSync(
  "node",
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    resolve(output, "stress.config.ts"),
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
      COMPAT_STRESS_CPU_RATE: rate,
    },
  },
);
process.exitCode = result.status ?? 1;
