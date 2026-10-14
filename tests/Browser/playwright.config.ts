import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  fullyParallel: false,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:5174",
    timezoneId: "America/New_York",
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command:
        "dotnet run --project tests/BrowserHost --artifacts-path .audit/check-build --no-build",
      cwd: root,
      url: "http://localhost:5055/health/ready",
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command:
        "bun x --no-install vite preview --config tests/Browser/vite.config.ts",
      cwd: root,
      url: "http://127.0.0.1:5174",
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
