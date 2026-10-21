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
  .object({ records: z.array(browserRecord).max(256), overflow: z.boolean() })
  .strict();
export const nodeRecord = z.discriminatedUnion("event", [
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
    schema: z.literal(1),
    node: z.array(nodeRecord).max(64),
    browser: z.array(browserRecord).max(256),
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
