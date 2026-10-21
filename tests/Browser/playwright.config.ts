import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const browserOrigin = `http://127.0.0.1:${process.env["DAMADAMA_BROWSER_PORT"] ?? "5174"}`;
const apiOrigin = `http://localhost:${process.env["DAMADAMA_API_PORT"] ?? "5055"}`;
export const acceptanceReporter = fileURLToPath(
  new URL("./acceptance-reporter.ts", import.meta.url),
);

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [
    [acceptanceReporter],
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: browserOrigin,
    timezoneId: "America/New_York",
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command:
        "dotnet run --project tests/BrowserHost --artifacts-path .audit/check-build --no-build",
      cwd: root,
      url: `${apiOrigin}/health/ready`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command:
        "bun x --no-install vite preview --config tests/Browser/vite.config.ts",
      cwd: root,
      url: browserOrigin,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
