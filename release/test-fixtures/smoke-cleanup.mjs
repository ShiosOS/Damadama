import { registerHooks } from "node:module";

const scenario = process.argv[2];
const calls = [];
const pageFailure = new Error("synthetic page creation failure");
const contextFailure = new Error("synthetic context cleanup failure");
const browserFailure = new Error("synthetic browser cleanup failure");
const contexts = ["a", "b"].map((name) => ({
  async newPage() {
    calls.push("page");
    throw pageFailure;
  },
  async close() {
    calls.push(`${name}.close.start`);
    await new Promise((resolve) => setImmediate(resolve));
    if (scenario === "context-failure" && name === "a") throw contextFailure;
    calls.push(`${name}.close.complete`);
  },
}));
globalThis.cleanupChromium = {
  async launch() {
    calls.push("launch");
    return {
      async newContext() {
        calls.push("context");
        return contexts.shift();
      },
      async close() {
        calls.push("browser.close");
        if (scenario === "browser-failure") throw browserFailure;
      },
    };
  },
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@playwright/test")
      return { url: "fixture:playwright-cleanup", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "fixture:playwright-cleanup")
      return {
        format: "module",
        shortCircuit: true,
        source: "export const chromium = globalThis.cleanupChromium;",
      };
    return next(url, context);
  },
});
process.env.CLERK_TEST_USER_A = "user_cleanup_a";
process.env.CLERK_TEST_USER_B = "user_cleanup_b";
globalThis.fetch = () => {
  throw new Error("cleanup proof must not access the network");
};
const { stagingBrowserChecks } = await import("../smoke.mjs");
let expected = pageFailure;
if (scenario === "context-failure") expected = contextFailure;
if (scenario === "browser-failure") expected = browserFailure;
let preserved = false;
try {
  await stagingBrowserChecks({});
} catch (error) {
  preserved = error === expected;
}
console.log(JSON.stringify({ calls, preserved }));
