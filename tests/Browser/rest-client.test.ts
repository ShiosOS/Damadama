import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, habitsApi } from "../../web/src/habits";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function respond(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): void {
  globalThis.fetch = Object.assign(
    async () => Response.json(body, { status, headers }),
    { preconnect: originalFetch.preconnect },
  );
}
const habitId = "be3990ed-527d-451e-8a11-981648333ac9";
const date = "2026-01-04";
const entry = {
  habitId,
  habitName: "Walking",
  calendarDate: date,
  result: "Good",
  editedAt: "2026-01-05T00:00:00Z",
  good: "5 minutes",
  better: "15 minutes",
  best: "30 minutes",
};
const input = {
  result: "Good",
  editedAt: entry.editedAt,
  deviceToday: "2026-01-05",
  timeZone: "Asia/Tokyo",
} satisfies Parameters<ReturnType<typeof habitsApi>["saveEntry"]>[2];
const api = habitsApi(async () => "token");
const path = `/api/habits/${habitId}/entries/${date}`;
const editedHabit = {
  id: habitId,
  name: "Walking",
  good: "10 minutes",
  better: "20 minutes",
  best: "40 minutes",
  createdAt: "2026-01-05T00:00:00Z",
  archived: false,
  revision: 1,
  schedule: {
    weekdays: [1, 7],
    repeatEveryWeeks: 2,
    timeZone: "UTC",
    creationDate: date,
    firstWeekMonday: "2025-12-29",
  },
};
const mutation = {
  mutationId: "1e3858a6-414b-473d-b782-783dc8d5bb87",
  deviceToday: "2026-01-05",
  timeZone: "UTC",
};

void test("habit mutations use the exact resource and preserve their retry identity", async () => {
  const observed: {
    path: string;
    method: string | undefined;
    body: unknown;
  }[] = [];
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      observed.push({
        path: url instanceof Request ? url.url : url.toString(),
        method: options?.method,
        body: options?.body,
      });
      return Response.json(editedHabit);
    },
    { preconnect: originalFetch.preconnect },
  );
  const edit = {
    ...mutation,
    name: "Walking",
    good: "10 minutes",
    better: "20 minutes",
    best: "40 minutes",
  };
  assert.deepEqual(await api.edit(habitId, edit), editedHabit);
  await api.edit(habitId, edit);
  await api.archive(habitId, mutation);
  assert.deepEqual(observed, [
    {
      path: `/api/habits/${habitId}`,
      method: "PATCH",
      body: JSON.stringify(edit),
    },
    {
      path: `/api/habits/${habitId}`,
      method: "PATCH",
      body: JSON.stringify(edit),
    },
    {
      path: `/api/habits/${habitId}/archives`,
      method: "POST",
      body: JSON.stringify(mutation),
    },
  ]);
});

void test("the today-choice conflict is validated separately from an entry conflict", async () => {
  respond(
    { status: 409, title: "Choose today", code: "today_choice_required" },
    409,
  );
  await assert.rejects(api.archive(habitId, mutation), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "today_choice_required");
    assert.equal(error.status, 409);
    return true;
  });
  assert.equal(
    new ApiError("Safe message", 409, undefined, "unknown sensitive value")
      .code,
    undefined,
  );
});

void test("habit mutation responses must identify the requested habit", async () => {
  respond({ ...editedHabit, id: "60d32eca-7d8d-427c-a642-16c0935d7d80" });
  const edit = {
    ...mutation,
    name: "Walking",
    good: "10",
    better: "20",
    best: "40",
  };
  await assert.rejects(api.edit(habitId, edit), { status: 502 });
  await assert.rejects(api.archive(habitId, mutation), { status: 502 });
});

void test("domain calls use direct collection URLs without discovery", async () => {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0]) => {
      requests.push(url instanceof Request ? url.url : url.toString());
      return Response.json([]);
    },
    { preconnect: originalFetch.preconnect },
  );
  await api.list();
  await api.scheduled(date);
  await api.entries(date);
  assert.deepEqual(requests, [
    "/api/habits",
    `/api/habits?scheduledOn=${date}`,
    `/api/entries?date=${date}`,
  ]);
});

void test("creation and exact replay accept their documented statuses", async () => {
  respond(entry, 201, { Location: path });
  assert.deepEqual(await api.saveEntry(habitId, date, input), entry);
  respond(entry);
  assert.deepEqual(await api.saveEntry(habitId, date, input), entry);
});

void test("one authenticated day read contains scheduled habits and retained entries", async () => {
  const requests: { path: string; authorization: string | null }[] = [];
  const day = { date, habits: [editedHabit], entries: [entry] };
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      requests.push({
        path: url instanceof Request ? url.url : url.toString(),
        authorization: new Headers(options?.headers).get("Authorization"),
      });
      return Response.json(day);
    },
    { preconnect: originalFetch.preconnect },
  );
  assert.deepEqual(await api.day(date), day);
  assert.deepEqual(requests, [
    { path: `/api/habit-days/${date}`, authorization: "Bearer token" },
  ]);
});

for (const day of [
  { date: "2026-01-03", habits: [], entries: [] },
  { date, habits: [], entries: [{ ...entry, calendarDate: "2026-01-03" }] },
  { date, habits: [editedHabit, editedHabit], entries: [] },
  { date, habits: [], entries: [entry, entry] },
  { date, habits: null, entries: [] },
  { date, habits: [], entries: null },
]) {
  void test(`a day read rejects inconsistent or malformed data ${JSON.stringify(day)}`, async () => {
    respond(day);
    await assert.rejects(api.day(date), { status: 502 });
  });
}

void test("day reads preserve media status refusal and session boundaries", async () => {
  const day = { date, habits: [], entries: [] };
  for (const [status, headers] of [
    [201, {}],
    [200, { "Content-Type": "text/plain" }],
  ] satisfies [number, Record<string, string>][]) {
    respond(day, status, headers);
    await assert.rejects(api.day(date), { status: 502 });
  }
  respond({ title: "Temporarily unavailable.", traceId: "day-read-01" }, 503);
  await assert.rejects(api.day(date), {
    status: 503,
    message: "Temporarily unavailable. Support reference: day-read-01.",
  });
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Unexpected request");
    },
    { preconnect: originalFetch.preconnect },
  );
  await assert.rejects(habitsApi(async () => null).day(date), { status: 401 });
});

void test("409 adopts a validated current entry in the same request", async () => {
  const current = { ...entry, result: "Best" };
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests++;
      return Response.json(
        { status: 409, title: "A newer entry is saved.", current },
        {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  assert.deepEqual(await api.saveEntry(habitId, date, input), current);
  assert.equal(requests, 1);
});

for (const current of [
  undefined,
  {},
  { ...entry, habitId: "c782d172-a403-4cbb-a138-0e97f903df24" },
  { ...entry, calendarDate: "2026-01-03" },
  { ...entry, result: "Unknown" },
]) {
  void test(`rejects an invalid or mismatched conflict ${JSON.stringify(current)}`, async () => {
    respond(
      { status: 409, title: "Conflict", current, traceId: "conflict-probe-01" },
      409,
      {
        "Content-Type": "application/problem+json",
      },
    );
    await assert.rejects(
      api.saveEntry(habitId, date, input),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 502 &&
        error.traceId === "conflict-probe-01" &&
        error.message.endsWith("Support reference: conflict-probe-01."),
    );
  });
}
for (const [status, headers] of [
  [202, {}],
  [201, {}],
  [201, { Location: "/wrong" }],
  [200, { "Content-Type": "text/plain" }],
] satisfies [number, Record<string, string>][]) {
  void test(`rejects undocumented success ${status} ${JSON.stringify(headers)}`, async () => {
    respond({ ...entry, traceId: "entry-probe-01" }, status, headers);
    await assert.rejects(
      api.saveEntry(habitId, date, input),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 502 &&
        error.traceId === "entry-probe-01",
    );
  });
}
void test("retry sends the exact edit and token without an extra read", async () => {
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      requests.push({
        url: url instanceof Request ? url.url : url.toString(),
        options,
      });
      if (requests.length === 1)
        return Response.json(
          { title: "Storage is unavailable" },
          { status: 503 },
        );
      return Response.json(entry);
    },
    { preconnect: originalFetch.preconnect },
  );
  await assert.rejects(api.saveEntry(habitId, date, input));
  await api.saveEntry(habitId, date, input);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[0], {
    url: path,
    options: {
      method: "PUT",
      body: JSON.stringify(input),
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
    },
  });
});

void test("missing authentication prevents a request", async () => {
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Unexpected request");
    },
    { preconnect: originalFetch.preconnect },
  );
  await assert.rejects(
    habitsApi(async () => null).list(),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
});

for (const traceId of [
  "0HNABCDEF0123:00000001",
  "00-abc_123-456",
  "a".repeat(128),
]) {
  void test(`refusal displays a validated reference of length ${traceId.length}`, async () => {
    respond({ title: "Unavailable", detail: "Try again later.", traceId }, 503);
    await assert.rejects(api.list(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 503);
      assert.equal(error.traceId, traceId);
      assert.equal(
        error.message,
        `Try again later. Support reference: ${traceId}.`,
      );
      return true;
    });
  });
}

for (const traceId of [
  undefined,
  null,
  42,
  {},
  "",
  "a".repeat(129),
  "has space",
  "has\nnewline",
  "has\rreturn",
  "has\ttab",
  "<script>",
  "path/value",
  "unicode-\u00e9",
]) {
  void test(`invalid reference ${JSON.stringify(traceId)} preserves useful problem text`, async () => {
    respond({ title: "Unavailable", detail: "Try again later.", traceId }, 503);
    await assert.rejects(api.list(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 503);
      assert.equal(error.traceId, undefined);
      assert.equal(error.message, "Try again later.");
      return true;
    });
  });
}

void test("the constructor rejects an unsafe reference for every view", () => {
  const error = new ApiError("Try again later.", 503, "unsafe\nvalue");
  assert.equal(error.traceId, undefined);
  assert.equal(error.message, "Try again later.");
});

void test("a reference is independent of problem validation", async () => {
  respond({ title: 42, traceId: "problem-probe-01" }, 500);
  await assert.rejects(api.list(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 500);
    assert.equal(error.traceId, "problem-probe-01");
    assert.equal(
      error.message,
      "The request could not be completed. Support reference: problem-probe-01.",
    );
    return true;
  });
});

void test("validation messages and authentication status keep their reference", async () => {
  respond(
    {
      title: "Check fields",
      errors: { name: ["Use a name."], good: ["Use a good level."] },
      traceId: "validation-probe-01",
    },
    400,
  );
  await assert.rejects(
    api.list(),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 400 &&
      error.message ===
        "Use a name. Use a good level. Support reference: validation-probe-01.",
  );
  respond(
    { title: "Authentication required.", traceId: "authentication-probe-01" },
    401,
  );
  await assert.rejects(
    api.list(),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 401 &&
      error.traceId === "authentication-probe-01" &&
      error.message ===
        "Sign in to continue. Support reference: authentication-probe-01.",
  );
});

for (const [name, call, body, status, headers] of [
  ["collection body shape", (): Promise<unknown> => api.list(), {}, 200, {}],
  [
    "collection success status",
    (): Promise<unknown> => api.list(),
    {},
    201,
    {},
  ],
  [
    "collection media type",
    (): Promise<unknown> => api.list(),
    {},
    200,
    { "Content-Type": "text/plain" },
  ],
  [
    "entry body shape",
    (): Promise<unknown> => api.saveEntry(habitId, date, input),
    {},
    200,
    {},
  ],
  [
    "entry habit relationship",
    (): Promise<unknown> => api.saveEntry(habitId, date, input),
    { ...entry, habitId: "c782d172-a403-4cbb-a138-0e97f903df24" },
    200,
    {},
  ],
  [
    "entry date relationship",
    (): Promise<unknown> => api.saveEntry(habitId, date, input),
    { ...entry, calendarDate: "2026-01-03" },
    200,
    {},
  ],
] satisfies [
  string,
  () => Promise<unknown>,
  object,
  number,
  Record<string, string>,
][]) {
  void test(`${name} rejection preserves the response reference`, async () => {
    respond({ ...body, traceId: "boundary-probe-01" }, status, headers);
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 502);
      assert.equal(error.traceId, "boundary-probe-01");
      assert.equal(
        error.message,
        "The service returned an unexpected response. Support reference: boundary-probe-01.",
      );
      return true;
    });
  });
}

void test("validated conflict adoption ignores an invalid optional reference", async () => {
  respond(
    {
      status: 409,
      title: "Conflict",
      current: entry,
      traceId: { invalid: true },
    },
    409,
    {
      "Content-Type": "application/problem+json",
    },
  );
  assert.deepEqual(await api.saveEntry(habitId, date, input), entry);
});

for (const [name, call] of [
  ["collection", (): Promise<unknown> => api.list()],
  ["entry", (): Promise<unknown> => api.saveEntry(habitId, date, input)],
] satisfies [string, () => Promise<unknown>][]) {
  void test(`malformed ${name} JSON becomes a safe error without a fabricated reference`, async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          '{"traceId":"fake-body-reference","private-body":"private-json-sentinel"',
          {
            status: 503,
            headers: { "Content-Type": "application/problem+json" },
          },
        ),
      { preconnect: originalFetch.preconnect },
    );
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 502);
      assert.equal(
        error.message,
        "The service returned an unexpected response.",
      );
      assert.equal(error.traceId, undefined);
      assert.equal("cause" in error, false);
      assert.deepEqual(Object.keys(error).sort(), ["status", "traceId"]);
      assert.doesNotMatch(
        JSON.stringify(error),
        /fake-body-reference|private-json-sentinel|Bearer|token|api\/habits/,
      );
      return true;
    });
  });
}
