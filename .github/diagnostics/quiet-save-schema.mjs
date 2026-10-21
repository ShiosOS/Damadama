import { z } from "zod";

export const targets = [
  "Name",
  "Good",
  "Better",
  "Best",
  "Repeat every (weeks)",
  "save",
  "form",
  "weekday",
  "other",
];
const time = z.number().finite().nonnegative();
export const fontKinds = [
  "latin",
  "latin-ext",
  "cyrillic",
  "cyrillic-ext",
  "vietnamese",
];
const fontCount = z.number().int().min(0).max(32);
const documentOrdinal = z.number().int().min(0).max(4);
const fontFailureCodes = new Map([
  ["net::ERR_ABORTED", "aborted"],
  ["net::ERR_CONNECTION_RESET", "connection-reset"],
  ["net::ERR_CONNECTION_CLOSED", "connection-closed"],
  ["net::ERR_CONNECTION_REFUSED", "connection-refused"],
  ["net::ERR_TIMED_OUT", "timed-out"],
  ["net::ERR_CONNECTION_TIMED_OUT", "timed-out"],
  ["net::ERR_NAME_NOT_RESOLVED", "name-resolution"],
  ["net::ERR_CACHE_READ_FAILURE", "cache-read"],
  ["net::ERR_CONTENT_LENGTH_MISMATCH", "content-length"],
]);
export function fontFailureCategory(value) {
  if (typeof value !== "string") return "unknown";
  return fontFailureCodes.get(value) ?? "other";
}
export const fontSnapshot = z
  .object({
    origin: z.literal("browser-performance"),
    ms: time,
    sampledAt: z.literal("failure-drain"),
    setStatus: z.enum(["loading", "loaded"]),
    family: z.discriminatedUnion("state", [
      z.object({ state: z.literal("missing") }).strict(),
      z
        .object({
          state: z.literal("present"),
          counts: z
            .object({
              unloaded: fontCount,
              loading: fontCount,
              loaded: fontCount,
              error: fontCount,
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine((value) => {
    if (value.family.state === "missing") return true;
    const count = Object.values(value.family.counts).reduce((a, b) => a + b, 0);
    return count > 0 && count <= 32;
  }, "Font face count differs.");
export const fontRead = z.union([
  fontSnapshot,
  z
    .object({ refusal: z.enum(["face-bound-exceeded", "read-failed"]) })
    .strict(),
]);
const fontEventBase = {
  origin: z.literal("node-performance"),
  ms: time,
  request: z.number().int().min(1).max(8),
  document: documentOrdinal,
  kind: z.enum(fontKinds),
};
export const fontEvent = z.discriminatedUnion("event", [
  z.object({ ...fontEventBase, event: z.literal("font-request") }).strict(),
  z
    .object({
      ...fontEventBase,
      event: z.literal("font-response"),
      status: z.number().int().min(100).max(599),
    })
    .strict(),
  z
    .object({
      ...fontEventBase,
      event: z.literal("font-request-finished"),
    })
    .strict(),
  z
    .object({
      ...fontEventBase,
      event: z.literal("font-request-failed"),
      category: z.enum([
        ...new Set(fontFailureCodes.values()),
        "unknown",
        "other",
      ]),
    })
    .strict(),
]);
export const fontEvidence = z
  .object({
    scope: z.literal("verified-bundled-nunito-main-frame"),
    transport: z
      .object({
        events: z.array(fontEvent).max(32),
        stop: z
          .object({
            origin: z.literal("node-performance"),
            ms: time,
            reason: z.literal("case-finished"),
          })
          .strict(),
        refusal: z.enum(["none", "overflow", "selection-unavailable"]),
      })
      .strict(),
    sample: z.discriminatedUnion("state", [
      z
        .object({
          state: z.literal("available"),
          document: documentOrdinal,
          snapshot: fontSnapshot,
        })
        .strict(),
      z
        .object({
          state: z.enum([
            "missing-page",
            "read-failed",
            "schema-rejected",
            "face-bound-exceeded",
            "document-bound-exceeded",
            "document-changed",
          ]),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const reject = () =>
      context.addIssue({ code: "custom", message: "Font evidence differs." });
    if (Buffer.byteLength(JSON.stringify(value)) > 4096)
      context.addIssue({
        code: "custom",
        message: "Font evidence byte bound exceeded.",
      });
    const requests = new Map();
    let previousTime = 0;
    let previousDocument = 0;
    for (const event of value.transport.events) {
      if (event.ms < previousTime || event.ms > value.transport.stop.ms)
        reject();
      previousTime = event.ms;
      if (event.event === "font-request") {
        if (
          requests.has(event.request) ||
          event.request !== requests.size + 1 ||
          event.document < previousDocument
        )
          reject();
        previousDocument = event.document;
        requests.set(event.request, {
          kind: event.kind,
          document: event.document,
          response: false,
          terminal: false,
        });
        continue;
      }
      const request = requests.get(event.request);
      if (
        !request ||
        request.kind !== event.kind ||
        request.document !== event.document ||
        request.terminal
      ) {
        reject();
        continue;
      }
      if (event.event === "font-response") {
        if (request.response) reject();
        request.response = true;
      } else {
        if (event.event === "font-request-finished" && !request.response)
          reject();
        request.terminal = true;
      }
    }
    if (
      value.sample.state === "available" &&
      value.sample.document < previousDocument
    )
      reject();
  });
const field = z
  .object({
    label: z.enum(targets.slice(0, 5)),
    present: z.boolean(),
    focused: z.boolean(),
    populated: z.boolean(),
    valid: z.boolean(),
  })
  .strict();
export const browserRecord = z
  .object({
    origin: z.literal("browser-performance"),
    ms: time,
    event: z.enum(["enter", "invalid", "submit", "focus", "input"]),
    target: z.enum(targets),
    focus: z.enum(targets),
    defaultPrevented: z.boolean(),
    alt: z.boolean(),
    ctrl: z.boolean(),
    meta: z.boolean(),
    shift: z.boolean(),
    composing: z.boolean(),
    repeat: z.boolean(),
    saveFocused: z.boolean(),
    saveDisabled: z.boolean(),
    fields: z.array(field).max(5),
  })
  .strict();
export const browserSnapshot = z
  .object({
    records: z.array(browserRecord).max(256),
    overflow: z.boolean(),
    font: z.unknown(),
  })
  .strict();
export const nodeRecord = z.discriminatedUnion("event", [
  z
    .object({
      origin: z.literal("node-performance"),
      ms: time,
      event: z.literal("phase-boundary"),
      stage: z.enum(["dialog-open", "creation-comparison"]),
      edge: z.enum(["start", "complete"]),
    })
    .strict(),
  z
    .object({
      origin: z.literal("node-performance"),
      ms: time,
      event: z.literal("fill-boundary"),
      stage: z.enum([
        "Name",
        "Good",
        "Better",
        "Best",
        "weekdays",
        "repeat",
        "save-focus",
      ]),
      edge: z.enum(["before", "after"]),
    })
    .strict(),
  z
    .object({
      origin: z.literal("node-performance"),
      ms: time,
      event: z.enum([
        "test-start",
        "waiter-armed",
        "enter-sent",
        "enter-returned",
        "request",
        "request-failed",
        "deadline-gate",
        "gate-cancelled",
      ]),
    })
    .strict(),
  z
    .object({
      origin: z.literal("node-performance"),
      ms: time,
      event: z.enum(["response", "held-response"]),
      status: z.number().int().min(100).max(599),
    })
    .strict(),
]);
export const observation = z
  .object({
    schema: z.literal(2),
    node: z.array(nodeRecord).max(64),
    browser: z.array(browserRecord).max(256),
    font: fontEvidence.nullable(),
    refusal: z.enum([
      "none",
      "overflow",
      "read-failed",
      "schema-rejected",
      "missing-page",
    ]),
  })
  .strict();

export function classify(value) {
  const parsed = observation.safeParse(value);
  if (!parsed.success || parsed.data.refusal !== "none") return "unknown";
  const { node, browser } = parsed.data;
  const has = (event) => node.some((record) => record.event === event);
  const saw = (event) => browser.some((record) => record.event === event);
  if (!has("test-start") || !has("waiter-armed")) return "unknown";
  if (!has("enter-sent")) {
    if (has("deadline-gate") && !has("request") && !saw("submit"))
      return "deadline-before-enter";
    return "unknown";
  }
  if (!has("enter-returned")) return "unknown";
  if (has("response")) return "response-observed";
  if (has("request-failed")) return "request-failed";
  if (has("request")) return "post-without-response";
  if (saw("invalid") && !saw("submit")) return "native-invalid";
  if (saw("submit")) return "submit-without-post";
  return "unknown";
}

export function errorCategory(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  const plain = message.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (
    /^(?:Error: )?page\.waitForResponse: Test timeout of 30000ms exceeded\./.test(
      plain,
    )
  )
    return "pending-waiter-global-timeout";
  if (/^Test timeout of 30000ms exceeded\.?$/.test(plain))
    return "whole-test-timeout";
  return "unknown-runner-error";
}
