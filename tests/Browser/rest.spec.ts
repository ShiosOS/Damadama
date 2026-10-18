import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { fixtureSchema } from "./siren-test";

async function createHabit(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Add habit", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Create a habit" });
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Good", { exact: true }).fill("5 minutes");
  await form.getByLabel("Better", { exact: true }).fill("15 minutes");
  await form.getByLabel("Best", { exact: true }).fill("30 minutes");
  await form.getByLabel("Sunday", { exact: true }).check();
  await form.getByLabel("Monday", { exact: true }).check();
  await form.getByRole("button", { name: "Save habit", exact: true }).click();
  await expect(form).toHaveCount(0);
}

test("opaque advertisements drive list, create, date reads, exact retry and conflict adoption", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-01-05T00:30:00Z"));
  const aliases = new Map<string, string>();
  const reverse = new Map<string, string>();
  const visited: string[] = [];
  const direct: string[] = [];
  const writes: string[] = [];
  let entryTarget: string | undefined;

  function alias(href: string): string {
    const existing = reverse.get(href);
    if (existing) return existing;
    const path = `/advertised/${crypto.randomUUID()}`;
    reverse.set(href, path);
    aliases.set(path, href);
    return path;
  }
  function rewrite(value: unknown): unknown {
    if (Array.isArray(value))
      return z.array(z.unknown()).parse(value).map(rewrite);
    if (value !== null && typeof value === "object") {
      const object = z.record(z.string(), z.unknown()).parse(value);
      return Object.fromEntries(
        Object.entries(object).map(([key, item]) => [
          key,
          key === "href" && typeof item === "string"
            ? alias(item)
            : rewrite(item),
        ]),
      );
    }
    return value;
  }
  await page.route("**/fixture.json", async (route) => {
    const response = await route.fetch();
    const data: unknown = await response.json();
    const fixture = fixtureSchema.parse(data);
    await route.fulfill({
      response,
      json: { ...fixture, bootstrap: rewrite(fixture.bootstrap) },
    });
  });
  await page.route("**/api/**", async (route) => {
    direct.push(route.request().url());
    await route.abort();
  });
  await page.route("**/advertised/**", async (route) => {
    const incoming = new URL(route.request().url());
    const destination = aliases.get(incoming.pathname);
    if (!destination)
      throw new Error("The browser guessed an unadvertised target.");
    const target = new URL(destination, incoming.origin);
    for (const [key, value] of incoming.searchParams)
      target.searchParams.set(key, value);
    visited.push(
      `${route.request().method()} ${target.pathname}${target.search}`,
    );
    const response = await route.fetch({ url: target.href });
    if (route.request().method() === "PUT") {
      entryTarget = target.href;
      writes.push(route.request().postData() ?? "");
      if (writes.length === 1) {
        expect(response.status()).toBe(201);
        await route.fulfill({
          status: 503,
          contentType: "application/problem+json",
          json: {
            type: "about:blank",
            title: "Acknowledgment lost after commit.",
            status: 503,
          },
        });
        return;
      }
    }
    const data: unknown = await response.json();
    const headers = { ...response.headers() };
    const location = headers["location"];
    if (location) headers["location"] = alias(location);
    await route.fulfill({ response, headers, json: rewrite(data) });
  });

  await page.goto("/?account=restHypermedia");
  await expect(
    page.getByText("No habits saved yet.", { exact: true }),
  ).toBeVisible();
  await createHabit(page, "Advertised walking");
  const controls = page.getByRole("group", {
    name: "Result for Advertised walking",
    exact: true,
  });
  await expect(controls).toBeVisible();
  await controls.getByRole("button", { name: "Good", exact: true }).click();
  await expect(controls.getByRole("alert")).toContainText(
    "Could not confirm the save",
  );
  await page.clock.setFixedTime(new Date("2026-01-05T00:31:00Z"));
  await controls
    .getByRole("button", { name: "Retry save", exact: true })
    .click();
  await expect(controls.getByRole("status")).toHaveText("Good is saved.");
  expect(writes).toHaveLength(2);
  expect(writes[1]).toBe(writes[0]);

  const fixture = fixtureSchema.parse(
    await (await page.request.get("/fixture.json")).json(),
  );
  const token = fixture.tokens["restHypermedia"];
  if (!entryTarget || !token)
    throw new Error("The first advertised save must identify its resource.");
  const winner = await page.request.put(entryTarget, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      result: "Best",
      editedAt: "2026-01-05T00:40:00Z",
      deviceToday: "2026-01-04",
      timeZone: "America/New_York",
    },
  });
  expect(winner.status()).toBe(200);
  const conflict = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" && response.status() === 409,
  );
  const beforeConflict = visited.length;
  await controls.getByRole("button", { name: "Better", exact: true }).click();
  await conflict;
  await expect(controls.getByRole("status")).toHaveText("Best is saved.");
  await expect(controls.getByRole("alert")).toHaveCount(0);
  expect(visited.length - beforeConflict).toBe(1);
  await page.getByLabel("Calendar date", { exact: true }).fill("2026-01-03");
  await expect(controls).toHaveCount(0);
  await page.getByLabel("Calendar date", { exact: true }).fill("2026-01-04");
  await expect(controls.getByRole("status")).toHaveText("Best is saved.");
  expect(direct).toEqual([]);
  expect(visited).toContain("GET /api/habits");
  expect(visited).toContain("POST /api/habits");
  expect(visited).toContain("GET /api/habits/scheduled?date=2026-01-03");
  expect(visited).toContain("GET /api/entries?date=2026-01-04");
});

for (const fault of [
  "missing action",
  "foreign action",
  "wrong media",
  "malformed problem",
]) {
  test(`a ${fault} fails at the client boundary without guessing a save target`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-01-05T00:30:00Z"));
    const puts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT") puts.push(request.url());
    });
    await page.goto("/?account=restInvalid");
    await createHabit(page, `Protocol ${fault}`);
    await page.route("**/api/habits/scheduled?date=*", async (route) => {
      const response = await route.fetch();
      if (fault === "malformed problem") {
        await route.fulfill({
          status: 503,
          contentType: "application/problem+json",
          body: "{",
        });
        return;
      }
      if (fault === "wrong media") {
        await route.fulfill({ response, contentType: "application/json" });
        return;
      }
      const data: unknown = await response.json();
      const collection = z
        .object({
          entities: z.array(
            z
              .object({
                actions: z.array(z.object({ href: z.string() }).loose()),
              })
              .loose(),
          ),
        })
        .loose()
        .parse(data);
      const entities = collection.entities.map((entity) => ({
        ...entity,
        actions:
          fault === "missing action"
            ? []
            : entity.actions.map((action) => ({
                ...action,
                href: "https://foreign.invalid/steal-token",
              })),
      }));
      await route.fulfill({ response, json: { ...collection, entities } });
    });
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Could not load today");
    await expect(
      page.getByRole("group", {
        name: `Result for Protocol ${fault}`,
        exact: true,
      }),
    ).toHaveCount(0);
    expect(puts).toEqual([]);
  });
}
