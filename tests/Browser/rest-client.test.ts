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
    respond({ status: 409, title: "Conflict", current }, 409, {
      "Content-Type": "application/problem+json",
    });
    await assert.rejects(
      api.saveEntry(habitId, date, input),
      (error: unknown) => error instanceof ApiError && error.status === 502,
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
    respond(entry, status, headers);
    await assert.rejects(
      api.saveEntry(habitId, date, input),
      (error: unknown) => error instanceof ApiError && error.status === 502,
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
