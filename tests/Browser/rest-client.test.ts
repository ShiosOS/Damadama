import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, readApplication } from "../../web/src/habits";

const origin = "https://app.example";
const savedFetch = globalThis.fetch;
function installFetch(
  handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
): void {
  globalThis.fetch = Object.assign(handler, {
    preconnect: savedFetch.preconnect,
  });
}
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin } },
  });
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
const habitId = "be3990ed-527d-451e-8a11-981648333ac9";
const date = "2026-01-04";
const writeFields = ["result", "editedAt", "deviceToday", "timeZone"];
function form(
  name: string,
  method: string,
  href: string,
  names: string[],
): object {
  return {
    name,
    method,
    href,
    type:
      method === "GET"
        ? "application/x-www-form-urlencoded"
        : "application/json",
    fields: names.map((name) => ({ name, type: "text" })),
  };
}
function entity(
  kind: string,
  properties: unknown,
  actions: object[] = [],
  entities: object[] = [],
): object {
  return {
    class: [kind],
    properties,
    actions,
    entities,
    links: [
      { rel: ["self"], href: "/opaque/self" },
      { rel: ["profile"], href: "/opaque/profile" },
    ],
  };
}
function bootstrap(href = "/opaque/list"): object {
  return {
    ...entity("application", { clerkPublishableKey: "pk_test" }),
    links: [
      { rel: ["self"], href: "/api/config" },
      { rel: ["profile"], href: "/opaque/profile" },
      { rel: ["https://github.com/ShiosOS/Damadama/rels/habits"], href },
    ],
    actions: [
      form("create-habit", "POST", "/opaque/create", [
        "name",
        "good",
        "better",
        "best",
        "weekdays",
        "repeatEveryWeeks",
        "timeZone",
      ]),
      form("scheduled-habits", "GET", "/opaque/scheduled", ["date"]),
      form("entries-by-date", "GET", "/opaque/entries", ["date"]),
    ],
  };
}
function scheduled(actions: object[]): object {
  return entity(
    "scheduled-habits",
    {},
    [],
    [
      entity(
        "habit",
        {
          id: habitId,
          name: "Walking",
          good: "5",
          better: "15",
          best: "30",
          createdAt: "2026-01-05T00:30:00Z",
          schedule: {
            weekdays: [7],
            repeatEveryWeeks: 1,
            timeZone: "America/New_York",
            creationDate: date,
            firstWeekMonday: "2025-12-29",
          },
        },
        actions,
      ),
    ],
  );
}
function response(
  body: unknown,
  status = 200,
  media = "application/vnd.siren+json",
): Response {
  return Response.json(body, { status, headers: { "Content-Type": media } });
}
function isApiError(status: number): (error: unknown) => boolean {
  return (error) => error instanceof ApiError && error.status === status;
}

void test("a discovered foreign target is rejected before acquiring a bearer token", () => {
  assert.throws(
    () => readApplication(bootstrap("https://foreign.example/token")),
    isApiError(502),
  );
  assert.throws(
    () => readApplication(bootstrap("javascript:alert(1)")),
    isApiError(502),
  );
  assert.throws(
    () => readApplication(bootstrap("https://user:password@app.example/list")),
    isApiError(502),
  );
});

void test("an API cannot acquire or send the next account's token", async () => {
  let account: string | null = "first";
  let tokenCalls = 0;
  let fetchCalls = 0;
  const token = Promise.withResolvers<string | null>();
  const api = readApplication(bootstrap()).forAccount(
    "first",
    () => {
      tokenCalls++;
      return token.promise;
    },
    () => account,
  );
  installFetch(async () => {
    fetchCalls++;
    return response(entity("habits", {}));
  });
  const pending = api.list();
  account = "second";
  token.resolve("second-account-token");
  await assert.rejects(pending, isApiError(401));
  await assert.rejects(api.list(), isApiError(401));
  assert.equal(tokenCalls, 1);
  assert.equal(fetchCalls, 0);
});

void test("a loaded editing capability remains bound to its account", async () => {
  let account: string | null = "first";
  let calls = 0;
  installFetch(async () => {
    calls++;
    return response(
      scheduled([form("replace-entry", "PUT", "/opaque/edit", writeFields)]),
    );
  });
  const api = readApplication(bootstrap()).forAccount(
    "first",
    async () => "first-token",
    () => account,
  );
  const [habit] = await api.scheduled(date);
  assert.ok(habit);
  account = null;
  await assert.rejects(
    habit.editor.save(
      { result: "Good", editedAt: "2026-01-05T00:30:00Z" },
      { deviceToday: date, timeZone: "America/New_York" },
    ),
    isApiError(401),
  );
  assert.equal(calls, 1);
});

void test("an absent save action fails discovery instead of manufacturing an entry URI", async () => {
  let calls = 0;
  installFetch(async () => {
    calls++;
    return response(scheduled([]));
  });
  const api = readApplication(bootstrap()).forAccount(
    "owner",
    async () => "token",
    () => "owner",
  );
  await assert.rejects(api.scheduled(date), isApiError(502));
  assert.equal(calls, 1);
});

void test("empty and malformed problem bodies become typed errors with the HTTP status", async () => {
  const api = readApplication(bootstrap()).forAccount(
    "owner",
    async () => "token",
    () => "owner",
  );
  for (const body of [
    "",
    "{",
    "null",
    '{"title":"wrong status","status":400}',
  ]) {
    installFetch(
      async () =>
        new Response(body, {
          status: 503,
          headers: { "Content-Type": "application/problem+json" },
        }),
    );
    await assert.rejects(api.list(), isApiError(503));
  }
});

void test("success requires both the advertised media and an operation's expected status", async () => {
  const api = readApplication(bootstrap()).forAccount(
    "owner",
    async () => "token",
    () => "owner",
  );
  installFetch(async () =>
    response(entity("habits", {}), 200, "application/json"),
  );
  await assert.rejects(api.list(), isApiError(502));
  installFetch(async () => response(entity("habits", {}), 202));
  await assert.rejects(api.list(), isApiError(502));
});

void test("a 409 yields its authoritative winner through the discovered editor without another fetch", async () => {
  const visited: string[] = [];
  const edit = form("replace-entry", "PUT", "/opaque/edit", writeFields);
  installFetch(async (input, options) => {
    visited.push(input instanceof Request ? input.url : String(input));
    if (options?.method === "GET") return response(scheduled([edit]));
    assert.ok(options);
    assert.equal(options.method, "PUT");
    assert.equal(
      options.body,
      JSON.stringify({
        result: "Good",
        editedAt: "2026-01-05T00:30:00Z",
        deviceToday: date,
        timeZone: "America/New_York",
      }),
    );
    return response(
      {
        type: "about:blank",
        title: "Superseded",
        status: 409,
        current: entity(
          "entry",
          {
            habitId,
            habitName: "Walking",
            calendarDate: date,
            result: "Best",
            editedAt: "2026-01-05T00:40:00Z",
            good: "5",
            better: "15",
            best: "30",
          },
          [edit],
        ),
      },
      409,
      "application/problem+json",
    );
  });
  const api = readApplication(bootstrap()).forAccount(
    "owner",
    async () => "token",
    () => "owner",
  );
  const [habit] = await api.scheduled(date);
  assert.ok(habit);
  const outcome = await habit.editor.save(
    { result: "Good", editedAt: "2026-01-05T00:30:00Z" },
    { deviceToday: date, timeZone: "America/New_York" },
  );
  assert.equal(outcome.kind, "superseded");
  assert.equal(outcome.entry.result, "Best");
  assert.deepEqual(visited, [
    `${origin}/opaque/scheduled?date=${date}`,
    `${origin}/opaque/edit`,
  ]);
});
