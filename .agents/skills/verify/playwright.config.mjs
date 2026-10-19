import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import canonical from "../../../tests/Browser/playwright.config.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  ...canonical,
  testDir: root,
  testMatch: [
    /tests[\\/]Browser[\\/](habits|today|entries|accessibility)\.spec\.ts$/,
    /\.agents[\\/]skills[\\/]verify[\\/]observations\.spec\.mjs$/,
  ],
  outputDir: join(root, ".audit/verification-skill/test-results"),
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: join(root, ".audit/verification-skill/report"),
        open: "never",
      },
    ],
  ],
});
