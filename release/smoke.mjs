import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

export async function publicChecks(record) {
  const origin = new URL(record.deployment.url);
  if (origin.protocol !== "https:" || origin.origin !== record.deployment.url)
    throw new Error("a configured HTTPS origin is required");
  for (const endpoint of ["/health/live", "/health/ready"]) {
    const response = await fetch(`${origin}${endpoint}`, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, `${endpoint} readiness`);
  }
  const unauthenticated = await fetch(`${origin}/api/habits`, {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(
    unauthenticated.status,
    401,
    "API refuses missing authentication",
  );
  const config = await (
    await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(15_000) })
  ).json();
  assert.equal(
    config.clerkPublishableKey,
    process.env.CLERK_PUBLISHABLE_KEY,
    "runtime Clerk key matches this environment",
  );
  assert.match(
    config.clerkPublishableKey,
    /^pk_live_/,
    "hosted environment uses an isolated production Clerk instance",
  );
  const runtime = await (
    await fetch(`${origin}/release.json`, {
      signal: AbortSignal.timeout(15_000),
    })
  ).json();
  assert.deepEqual(
    runtime.source,
    record.source,
    "running image contains the proposed source identity",
  );
  assert.equal(
    runtime.version,
    record.image.version,
    "running candidate version",
  );
  return { readiness: true, unauthorized: true, runtimeConfig: true };
}

async function ticket(userId) {
  if (
    !process.env.CLERK_SECRET_KEY?.startsWith("sk_live_") ||
    !userId?.startsWith("user_")
  )
    throw new Error(
      "isolated staging Clerk secret and two actual test-account IDs are required",
    );
  const response = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 120 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`Clerk ticket request failed with ${response.status}`);
  return (await response.json()).token;
}

async function signIn(page, userId, origin) {
  await page.goto(origin);
  await page.waitForFunction(() => window.Clerk?.loaded, { timeout: 30_000 });
  const token = await ticket(userId);
  await page.evaluate(async (ticket) => {
    const attempt = await window.Clerk.client.signIn.create({
      strategy: "ticket",
      ticket,
    });
    if (!attempt.createdSessionId)
      throw new Error("Clerk did not create an ordinary session");
    await window.Clerk.setActive({ session: attempt.createdSessionId });
  }, token);
  await page.getByRole("button", { name: "Add habit", exact: true }).waitFor();
}

async function authenticatedGet(page, path) {
  return page.evaluate(async (path) => {
    const token = await window.Clerk.session.getToken();
    const response = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return {
      status: response.status,
      body: response.status === 200 ? await response.json() : null,
    };
  }, path);
}

export async function stagingBrowserChecks(record) {
  const a = process.env.CLERK_TEST_USER_A;
  const b = process.env.CLERK_TEST_USER_B;
  if (a === b || !a || !b)
    throw new Error("two distinct staging Clerk accounts are required");
  await mkdir("runtime-evidence", { recursive: true });
  const browser = await chromium.launch();
  const contexts = [];
  try {
    const contextA = await browser.newContext({
      timezoneId: "America/New_York",
      recordVideo: { dir: "runtime-evidence" },
    });
    const contextB = await browser.newContext({
      timezoneId: "America/New_York",
    });
    contexts.push(contextA, contextB);
    const page = await contextA.newPage();
    await signIn(page, a, record.deployment.url);
    const name = `Release ${record.authority.runId} attempt ${record.authority.attempt}`;
    await page.getByRole("button", { name: "Add habit", exact: true }).click();
    for (const [label, value] of [
      ["Name", name],
      ["Good", "five minutes"],
      ["Better", "fifteen minutes"],
      ["Best", "thirty minutes"],
    ])
      await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByLabel("Monday", { exact: true }).check();
    await page.getByLabel("Sunday", { exact: true }).check();
    await page.getByLabel("Repeat every (weeks)", { exact: true }).fill("2");
    await page.getByRole("button", { name: "Save habit", exact: true }).click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    const saved = await authenticatedGet(page, "/api/habits");
    assert.equal(saved.status, 200);
    const habit = saved.body.find((habit) => habit.name === name);
    assert.ok(habit, "committed habit is returned");
    assert.equal(habit.good, "five minutes");
    assert.equal(habit.better, "fifteen minutes");
    assert.equal(habit.best, "thirty minutes");
    assert.deepEqual(habit.schedule.weekdays, [1, 7]);
    assert.equal(habit.schedule.repeatEveryWeeks, 2);
    assert.equal(habit.schedule.timeZone, "America/New_York");
    await page.reload();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    const reloaded = await authenticatedGet(page, `/api/habits/${habit.id}`);
    assert.deepEqual(
      reloaded.body,
      habit,
      "all values and stored dates survive reload",
    );
    await page.screenshot({
      path: "runtime-evidence/saved-habit.png",
      fullPage: true,
    });
    const other = await contextB.newPage();
    await signIn(other, b, record.deployment.url);
    const foreign = await authenticatedGet(other, `/api/habits/${habit.id}`);
    assert.equal(
      foreign.status,
      404,
      "another actual Clerk account cannot read the habit",
    );
    const list = await authenticatedGet(other, "/api/habits");
    assert.equal(
      list.body.some((item) => item.id === habit.id),
      false,
      "owner filtering excludes the habit",
    );
    await page.evaluate(() => window.Clerk.signOut());
    await page
      .getByRole("heading", { name, exact: true })
      .waitFor({ state: "detached" });
    const evidence = {
      clerk: true,
      habits: true,
      ownership: true,
      signOut: true,
    };
    await writeFile(
      "runtime-evidence/authentication.json",
      JSON.stringify(
        {
          mechanism:
            "Actual staging Clerk sessions created by short-lived Backend API tickets",
          emailDelivery:
            "Not exercised by this automation; final approval requires an actual email-code sign-in",
          checks: evidence,
        },
        null,
        2,
      ),
    );
    return evidence;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
}
