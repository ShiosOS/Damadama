import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: fileURLToPath(new URL("./", import.meta.url)),
  testMatch: "compatibility-font.calibration.ts",
  outputDir: fileURLToPath(
    new URL(
      "../../.audit/browser-font-implementation/test-results",
      import.meta.url,
    ),
  ),
  timeout: 30000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  updateSnapshots: "none",
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 900 },
    screen: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "America/New_York",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [{ name: "chromium-desktop" }],
});
