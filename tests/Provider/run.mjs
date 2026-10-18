import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { candidateVersion } from "../../release/policy.mjs";
import { publicChecks } from "../../release/smoke.mjs";
import {
  ProviderFailure,
  failureReceipt,
  passedReceipt,
  providerConfig,
  readInputs,
  receiptPath,
  requirePageOrigin,
  requireSession,
  requireSignedOut,
  requireThat,
} from "./policy.mjs";

function readCheckout(inputs) {
  const git = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    const head = git("rev-parse", "HEAD");
    git(
      "merge-base",
      "--is-ancestor",
      inputs.expectedCommit,
      inputs.controlsSha,
    );
    const tree = git("rev-parse", `${inputs.expectedCommit}^{tree}`);
    return { head, tree, isAncestor: true };
  } catch {
    throw new ProviderFailure("invalid-checkout");
  }
}

async function sessionObservation(page) {
  return page.evaluate(() => ({
    id: window.Clerk.session?.id,
    status: window.Clerk.session?.status,
    userId: window.Clerk.user?.id,
    sessionUserId: window.Clerk.session?.user.id,
  }));
}

async function signedOutObservation(page) {
  const state = await page.evaluate(() => ({
    sessionAbsent: window.Clerk.session === null,
    userAbsent: window.Clerk.user === null,
    activeSessions: window.Clerk.client.sessions.filter(
      (session) => session.status === "active",
    ).length,
  }));
  return {
    ...state,
    protectedVisible: await page
      .getByRole("button", { name: "Add habit", exact: true })
      .isVisible(),
    signInVisible: await page.locator(".cl-signIn-root").isVisible(),
  };
}

async function runBrowser(config, stage) {
  const checks = {};
  const record = {
    source: config.source,
    deployment: { url: config.origin },
    image: { version: candidateVersion(config.source) },
  };
  stage("public-before");
  await publicChecks(record);
  stage("browser-start");
  const { chromium, expect } = await import("@playwright/test");
  let browser;
  let context;
  try {
    browser = await chromium.launch();
    context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    stage("sign-in-ui");
    await page.goto(config.origin);
    await page.waitForFunction(() => window.Clerk?.loaded);
    requirePageOrigin(page.url(), config.origin);
    await expect(page.locator(".cl-signIn-root")).toBeVisible();
    requireSignedOut(await signedOutObservation(page), "sign-in-ui");
    checks.deployedSignIn = true;

    stage("ticket");
    const response = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: config.accountA,
        expires_in_seconds: 120,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    requireThat(response.status === 200, "ticket");
    const { token } = await response.json();
    requireThat(
      typeof token === "string" && token.length > 0 && token.length < 16_384,
      "ticket",
    );
    requirePageOrigin(page.url(), config.origin);
    stage("ordinary-session");
    const complete = await page.evaluate(
      async ({ ticket, origin }) => {
        if (location.origin !== origin) return false;
        const attempt = await window.Clerk.client.signIn.create({
          strategy: "ticket",
          ticket,
        });
        if (attempt.status !== "complete" || !attempt.createdSessionId)
          return false;
        await window.Clerk.setActive({ session: attempt.createdSessionId });
        return window.Clerk.session?.id === attempt.createdSessionId;
      },
      { ticket: token, origin: config.origin },
    );
    requireThat(complete, "ordinary-session");
    const session = await sessionObservation(page);
    requireSession(session, config.accountA);
    await expect(
      page.getByRole("button", { name: "Add habit", exact: true }),
    ).toBeVisible();
    checks.ordinarySession = true;

    stage("authenticated-api");
    const status = await page.evaluate(async (origin) => {
      if (location.origin !== origin) return 0;
      const token = await window.Clerk.session.getToken();
      if (!token) return 0;
      const response = await fetch("/api/habits", {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      return response.status;
    }, config.origin);
    requireThat(status === 200, "authenticated-api");
    checks.authorizedApi = true;

    stage("signed-in-reload");
    await page.reload();
    await page.waitForFunction(
      () => window.Clerk?.loaded && window.Clerk.session?.status === "active",
    );
    requirePageOrigin(page.url(), config.origin);
    const reloadedSession = await sessionObservation(page);
    requireSession(
      reloadedSession,
      config.accountA,
      "signed-in-reload",
      session.id,
    );
    await expect(
      page.getByRole("button", { name: "Add habit", exact: true }),
    ).toBeVisible();
    checks.signedInReload = true;

    stage("signout-ui");
    await page
      .getByRole("button", { name: "Open user menu", exact: true })
      .click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    checks.userMenuSignOut = true;
    stage("signed-out");
    await page.waitForFunction(
      () => window.Clerk?.loaded && window.Clerk.session === null,
    );
    await expect(page.locator(".cl-signIn-root")).toBeVisible();
    requirePageOrigin(page.url(), config.origin);
    requireSignedOut(await signedOutObservation(page), "signed-out");
    checks.signedOut = true;

    stage("signed-out-reload");
    await page.reload();
    await page.waitForFunction(
      () => window.Clerk?.loaded && window.Clerk.session === null,
    );
    await expect(page.locator(".cl-signIn-root")).toBeVisible();
    requirePageOrigin(page.url(), config.origin);
    requireSignedOut(await signedOutObservation(page), "signed-out-reload");
    checks.signedOutReload = true;
    stage("tokenless-api");
    const anonymous = await page.evaluate(async (origin) => {
      if (location.origin !== origin) return 0;
      const response = await fetch("/api/habits", {
        credentials: "omit",
        headers: {},
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      return response.status;
    }, config.origin);
    requireThat(anonymous === 401, "tokenless-api");
    checks.tokenlessUnauthorized = true;
    stage("public-after");
    await publicChecks(record);
    checks.sourceStable = true;
    return passedReceipt(config, checks);
  } finally {
    try {
      try {
        await context?.close();
      } finally {
        await browser?.close();
      }
    } catch {
      throw new ProviderFailure("cleanup");
    }
  }
}

let stage = "invalid-config";
let receipt;
try {
  const inputs = readInputs(process.env);
  const config = providerConfig(inputs, readCheckout(inputs));
  receipt = await runBrowser(config, (value) => {
    stage = value;
  });
} catch (error) {
  const code = error instanceof ProviderFailure ? error.code : stage;
  receipt = failureReceipt(code);
  process.exitCode = 1;
}
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
  mode: 0o600,
});
console.info(JSON.stringify(receipt));
