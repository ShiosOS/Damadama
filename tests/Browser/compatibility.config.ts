import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import shared from "./playwright.config";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outputDir = resolve(root, ".audit/browser-quality/test-results");
const webServers = shared.webServer;
if (!Array.isArray(webServers) || webServers.length !== 2)
  throw new Error(
    "Compatibility tests require the shared BrowserHost and Vite servers.",
  );
const [browserHost, vitePreview] = webServers;
if (!browserHost || !vitePreview)
  throw new Error("Compatibility tests require both shared web servers.");

export default defineConfig({
  ...shared,
  webServer: [
    browserHost,
    {
      ...vitePreview,
      command:
        "bun x --no-install vite preview --config tests/Browser/compatibility.vite.config.ts",
      url: `${vitePreview.url}/compatibility.html`,
    },
  ],
  testMatch: "*.pw.ts",
  outputDir,
  snapshotPathTemplate: "{testDir}/baselines/{arg}{ext}",
  updateSnapshots: "none",
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    ...shared.use,
    locale: "en-US",
    timezoneId: "America/New_York",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    { name: "firefox-smoke", use: { browserName: "firefox" } },
    { name: "webkit-smoke", use: { browserName: "webkit" } },
    {
      name: "chromium-desktop",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 900 },
        screen: { width: 1280, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: "chromium-mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        screen: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
