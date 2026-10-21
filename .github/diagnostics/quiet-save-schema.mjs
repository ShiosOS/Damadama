import { z } from "zod";
import { ownerSchema } from "./quiet-save-media.mjs";

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

export const passiveRefusal = z.enum([
  "source-mismatch",
  "site-unadmitted",
  "operation-mismatch",
  "owner-mismatch",
  "malformed",
  "duplicate",
  "overflow",
  "missing",
  "clock-unusable",
  "lifecycle-incomplete",
]);
export const unverified = (reason) => ({ kind: "unverified", reason });
export const complete = (value) => ({ kind: "complete", value });
const evidence = (schema) =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("complete"), value: schema }).strict(),
    z
      .object({ kind: z.literal("unverified"), reason: passiveRefusal })
      .strict(),
  ]);
const elapsed = z.number().finite().min(0).max(300000);
const wall = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const workerIndex = z.number().int().min(0).max(32);
const sample = z.object({ at: elapsed, wall }).strict();
const event = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request") }).strict(),
  z
    .object({
      kind: z.literal("response"),
      status: z.number().int().min(100).max(599),
    })
    .strict(),
  z.object({ kind: z.literal("request-failed") }).strict(),
]);
const networkEvent = {
  sequence: z.number().int().min(1).max(12),
  requestOrdinal: z.number().int().min(1).max(4),
  at: elapsed,
  event,
};
export const passiveAttachment = z
  .object({
    schema: z.literal(1),
    owner: z.lazy(() => ownerSchema),
    workerIndex,
    journal: evidence(
      z
        .object({
          installationWall: wall,
          end: sample,
          events: z.array(z.object({ ...networkEvent, wall }).strict()).max(12),
        })
        .strict(),
    ),
  })
  .strict();
const offset = evidence(elapsed);
export const passiveSite = z
  .object({
    id: z.number().int().min(1).max(512),
    source: z.enum(["canonical-test", "visual-support", "calibration-test"]),
    line: z.number().int().min(1).max(10000),
    column: z.number().int().min(1).max(1000),
    operation: z.enum([
      "keyboard.press",
      "keyboard.type",
      "page.waitForResponse",
      "page.goto",
      "page.reload",
      "page.evaluate",
      "locator.evaluate",
      "locator.screenshot",
      "assertion",
      "other-admitted-source-call",
    ]),
    role: z.enum([
      "save-enter",
      "dialog-enter",
      "save-response-waiter",
      "other-original",
    ]),
  })
  .strict();
const order = z.number().int().min(1).max(4096);
const occurrence = z.number().int().min(1).max(512);
export const passiveFailure = z
  .object({
    kind: z.literal("passive-save"),
    owner: z.lazy(() => ownerSchema),
    operations: evidence(
      z
        .array(
          z
            .object({
              sequence: occurrence,
              site: passiveSite,
              start: offset,
              receiptOrder: order,
              end: z.discriminatedUnion("kind", [
                z.object({ kind: z.literal("not-observed") }).strict(),
                ...["success", "error"].map((kind) =>
                  z
                    .object({
                      kind: z.literal(kind),
                      at: offset,
                      receiptOrder: order,
                    })
                    .strict(),
                ),
              ]),
            })
            .strict(),
        )
        .max(512),
    ),
    network: evidence(
      z
        .object({
          owner: z.lazy(() => ownerSchema),
          workerIndex,
          installationWall: offset,
          end: z
            .object({
              provenance: z.literal("afterEach-start"),
              at: elapsed,
              wall: offset,
            })
            .strict(),
          events: z
            .array(z.object({ ...networkEvent, wall: offset }).strict())
            .max(12),
        })
        .strict(),
    ),
    errors: evidence(
      z
        .array(
          z
            .object({
              errorIndex: z.number().int().min(0).max(7),
              category: z.enum([
                "whole-test-timeout",
                "pending-waiter-global-timeout",
                "other-error",
              ]),
              correlation: z.discriminatedUnion("kind", [
                z
                  .object({ kind: z.literal("unique-step"), occurrence })
                  .strict(),
                z
                  .object({ kind: z.literal("result-site"), site: passiveSite })
                  .strict(),
                z
                  .object({
                    kind: z.literal("unavailable"),
                    reason: z.enum(["no-site", "ambiguous"]),
                  })
                  .strict(),
              ]),
            })
            .strict(),
        )
        .max(8),
    ),
    budget: z
      .object({
        configuredWholeTestMs: z.number().int().positive().max(30000),
        resultDurationMs: elapsed,
        wallOffsetOrigin: z.literal("transported-worker-test-start"),
        wallOffsets: z.enum([
          "estimates-from-transported-worker-wall-time",
          "unavailable",
        ]),
        exactBudgetOrigin: z.literal("not-observed"),
        exactRemainingMs: z.literal("not-observed"),
        deadlineInstant: z.literal("not-observed"),
      })
      .strict(),
    observationMeaning: z.literal("observed-events-through-afterEach-start"),
    cause: z.literal("unknown"),
  })
  .strict();
