import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../../web/src/habits";
import { heatmapApi } from "../../web/src/heatmap";
import { heatmapSchema, type Heatmap } from "../../web/src/heatmap.schema";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const anchor = { deviceToday: "2026-01-04", timeZone: "America/New_York" };
const start = "2025-01-05";
function emptyHeatmap(): Heatmap {
  return {
    start,
    end: anchor.deviceToday,
    days: Array.from({ length: 365 }, (_, index) => {
      const date = new Date(start + "T00:00:00Z");
      date.setUTCDate(date.getUTCDate() + index);
      return {
        date: date.toISOString().slice(0, 10),
        scheduledCount: 0,
        earnedPoints: 0,
        maximumPoints: 0,
        completion: null,
      };
    }),
  };
}
function respond(
  body: unknown,
  status = 200,
  contentType = "application/json",
): void {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json(body, { status, headers: { "Content-Type": contentType } }),
    { preconnect: originalFetch.preconnect },
  );
}

void test("a heatmap read sends the device anchor with its authenticated request", async () => {
  const requests: { path: string; authorization: string | null }[] = [];
  const heatmap = emptyHeatmap();
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      requests.push({
        path: url instanceof Request ? url.url : url.toString(),
        authorization: new Headers(options?.headers).get("Authorization"),
      });
      return Response.json(heatmap);
    },
    { preconnect: originalFetch.preconnect },
  );

  assert.deepEqual(
    await heatmapApi(async () => "owner-token")(anchor),
    heatmap,
  );
  assert.deepEqual(requests, [
    {
      path: "/api/heatmap?deviceToday=2026-01-04&timeZone=America%2FNew_York",
      authorization: "Bearer owner-token",
    },
  ]);
});

void test("an absent session refuses before sending a heatmap request", async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests++;
      return Response.json(emptyHeatmap());
    },
    { preconnect: originalFetch.preconnect },
  );

  await assert.rejects(
    heatmapApi(async () => null)(anchor),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(requests, 0);
});

void test("a no-schedule day has no completion value and each scheduled habit adds three maximum points", () => {
  const heatmap = emptyHeatmap();
  const today = heatmap.days[364];
  assert.ok(today);
  today.scheduledCount = 4;
  today.earnedPoints = 6;
  today.maximumPoints = 12;
  today.completion = 0.5;
  assert.deepEqual(heatmapSchema.parse(heatmap), heatmap);
});

for (const [label, malformed] of [
  [
    "missing dates",
    (heatmap: Heatmap): unknown => ({
      ...heatmap,
      days: heatmap.days.slice(1),
    }),
  ],
  [
    "reversed dates",
    (heatmap: Heatmap): unknown => ({
      ...heatmap,
      days: [...heatmap.days].reverse(),
    }),
  ],
  [
    "wrong end date",
    (heatmap: Heatmap): unknown => ({ ...heatmap, end: "2026-01-05" }),
  ],
  [
    "percentage on an empty date",
    (heatmap: Heatmap): unknown => ({
      ...heatmap,
      days: heatmap.days.map((day) => ({ ...day, completion: 0 })),
    }),
  ],
  [
    "incorrect completion ratio",
    (heatmap: Heatmap): unknown => ({
      ...heatmap,
      days: heatmap.days.map((day) => ({
        ...day,
        scheduledCount: 1,
        earnedPoints: 1,
        maximumPoints: 3,
        completion: 1,
      })),
    }),
  ],
  [
    "incorrect daily maximum",
    (heatmap: Heatmap): unknown => ({
      ...heatmap,
      days: heatmap.days.map((day) => ({
        ...day,
        scheduledCount: 1,
        earnedPoints: 2,
        maximumPoints: 1,
        completion: 1,
      })),
    }),
  ],
] satisfies [string, (heatmap: Heatmap) => unknown][]) {
  void test(`the response boundary refuses ${label}`, async () => {
    respond(malformed(emptyHeatmap()));
    await assert.rejects(
      heatmapApi(async () => "token")(anchor),
      (error: unknown) => error instanceof ApiError && error.status === 502,
    );
  });
}

void test("a structurally valid response for another anchor is refused", async () => {
  respond(emptyHeatmap());
  await assert.rejects(
    heatmapApi(async () => "token")({ ...anchor, deviceToday: "2026-01-05" }),
    (error: unknown) => error instanceof ApiError && error.status === 502,
  );
});

void test("successful reads require the JSON media type and HTTP 200 status", async () => {
  for (const [status, media] of [
    [201, "application/json"],
    [200, "text/plain"],
  ] satisfies [number, string][]) {
    respond(emptyHeatmap(), status, media);
    await assert.rejects(
      heatmapApi(async () => "token")(anchor),
      (error: unknown) => error instanceof ApiError && error.status === 502,
    );
  }
});

void test("a service refusal retains its safe support reference", async () => {
  respond(
    { title: "Try again later.", traceId: "trace-123" },
    503,
    "application/problem+json",
  );
  await assert.rejects(
    heatmapApi(async () => "token")(anchor),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 503 &&
      error.message === "Try again later. Support reference: trace-123.",
  );
});
