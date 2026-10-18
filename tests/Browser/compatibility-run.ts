import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  candidateDir,
  candidateManifest,
  loadManifest,
  validateBaselines,
} from "./visual-support";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);

const mode = z.enum(["capture", "verify"]).parse(process.argv[2]);
const checkout = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
});
if (checkout.status !== 0)
  throw new Error("Cannot determine the actual checked-out Git revision.");
const currentCheckoutSHA = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .parse(checkout.stdout.trim());

const osRelease = await readFile("/etc/os-release", "utf8").catch(() => "");
const osDistribution = /^ID="?([^"\n]+)"?$/m.exec(osRelease)?.[1];
const osVersion = /^VERSION_ID="?([^"\n]+)"?$/m.exec(osRelease)?.[1];
if (
  process.platform !== "linux" ||
  osDistribution !== "ubuntu" ||
  osVersion !== "24.04"
)
  throw new Error(
    "Browser compatibility capture and verification require canonical Ubuntu 24.04.",
  );

const cli = [
  "node_modules/@playwright/test/cli.js",
  "test",
  "--config",
  "tests/Browser/compatibility.config.ts",
  "--update-snapshots=none",
];
const receiptDir = ".audit/browser-quality/receipts";
const runResults: { phase: string; outputDir: string; exitCode: number }[] = [];
let generationSHA: string | null = null;

function run(phase: string, projects: string[], control?: string): void {
  const outputDir = `.audit/browser-quality/test-results/${mode}-${runResults.length + 1}`;
  const args = [
    ...cli,
    "--output",
    outputDir,
    ...projects.map((project) => `--project=${project}`),
  ];
  const result = spawnSync("node", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      COMPAT_MODE: mode,
      COMPAT_CONTROL: control ?? "",
      COMPAT_CURRENT_SHA: currentCheckoutSHA,
      COMPAT_OS_DISTRIBUTION: osDistribution,
      COMPAT_OS_VERSION: osVersion,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  const exitCode = result.status ?? 1;
  runResults.push({ phase, outputDir, exitCode });
  if (exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    throw new Error(`${phase} failed (exit ${exitCode}).\n${output}`);
  }
  console.info(`${phase}: passed`);
}

try {
  if (mode === "capture") {
    run("candidate capture", ["chromium-desktop", "chromium-mobile"]);
    const manifest = await candidateManifest(currentCheckoutSHA);
    generationSHA = manifest.generationSHA;
    await writeFile(
      join(candidateDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    console.info(
      `Candidates and measured generation manifest: ${candidateDir}`,
    );
  } else {
    const manifest = await loadManifest();
    generationSHA = manifest.generationSHA;
    await validateBaselines(manifest);
    run("Firefox and WebKit smoke", ["firefox-smoke", "webkit-smoke"]);
    for (let repetition = 1; repetition <= 3; repetition++)
      run(`fresh visual comparison ${repetition}`, [
        "chromium-desktop",
        "chromium-mobile",
      ]);
    run(
      "changed-row pixel rejection and same-page restoration",
      ["chromium-desktop"],
      "mutation",
    );
    run("missing-baseline rejection", ["chromium-desktop"], "missing");
    console.info(`Comparison receipt: ${receiptDir}/verify.json`);
  }
} finally {
  await mkdir(receiptDir, { recursive: true });
  await writeFile(
    join(receiptDir, `${mode}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generationSHA,
        currentCheckoutSHA,
        imageOS: process.env["ImageOS"] ?? null,
        imageVersion: process.env["ImageVersion"] ?? null,
        runs: runResults,
      },
      null,
      2,
    )}\n`,
  );
}
