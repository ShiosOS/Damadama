import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import canonical from "../../../tests/Browser/playwright.config.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

export const selectedFiles = Object.freeze([
  "tests/Browser/habits.spec.ts",
  "tests/Browser/today.spec.ts",
  "tests/Browser/entries.spec.ts",
  "tests/Browser/accessibility.spec.ts",
  ".agents/skills/verify/observations.spec.mjs",
]);

export default defineConfig({
  ...canonical,
  globalTimeout: 300_000,
  maxFailures: 1,
  testDir: root,
  testMatch: selectedFiles.map(
    (path) =>
      new RegExp(path.replaceAll(".", "\\.").replaceAll("/", "[\\\\/]") + "$"),
  ),
  outputDir: join(root, ".audit/verification-skill/test-results"),
  reporter: [
    ["list"],
    [
      "json",
      { outputFile: join(root, ".audit/verification-skill/results.raw.json") },
    ],
    [
      "html",
      {
        outputFolder: join(root, ".audit/verification-skill/report"),
        open: "never",
      },
    ],
  ],
});
