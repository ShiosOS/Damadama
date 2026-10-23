import { z } from "zod";

export const prefix = "compatibility-evidence-v1 ";
export const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const subset = z.enum([
  "cyrillic-ext",
  "cyrillic",
  "vietnamese",
  "latin-ext",
  "latin",
]);
export const checkpoint = z.enum([
  "desktop-creation",
  "desktop-saved",
  "mobile-layout",
]);
const nodeMs = z.number().nonnegative().brand<"NodeMs">();
const browserMs = z.number().nonnegative().brand<"BrowserMs">();
const count = z.number().int().min(0).max(32);
const counts = z
  .object({ unloaded: count, loading: count, loaded: count, error: count })
  .strict()
  .refine((value) => Object.values(value).reduce((a, b) => a + b, 0) <= 32);
export const sampleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      sampledAt: z.literal("guard-decision"),
      clock: z.literal("browser-performance"),
      browserMs,
      setStatus: z.enum(["loading", "loaded"]),
      counts,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum([
        "face-bound-exceeded",
        "read-failed",
        "schema-rejected",
        "document-changed",
      ]),
    })
    .strict(),
]);
export type SampleInput = z.input<typeof sampleSchema>;
export const rawDecisionSchema = z
  .object({ fontLoaded: z.boolean(), sample: z.unknown() })
  .strict();
export const decisionSchema = rawDecisionSchema
  .extend({ sample: sampleSchema })
  .strict()
  .refine(
    ({ fontLoaded, sample }) =>
      sample.kind === "unavailable" || fontLoaded === sample.counts.loaded > 0,
  );
export const saveMarker = z.enum([
  "create-waiter-armed",
  "create-response-await-start",
  "create-response-await-complete",
  "create-json-complete",
  "saved-assertions-complete",
]);
const guard = z.number().int().min(1).max(8);
const request = z.number().int().min(1).max(8);
const document = z.number().int().min(0).max(4);
export const eventDataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigation") }).strict(),
  z.object({ kind: z.literal("page-closed") }).strict(),
  z.object({ kind: z.literal("request"), request, subset }).strict(),
  z
    .object({
      kind: z.literal("response"),
      request,
      status: z.number().int().min(100).max(599),
    })
    .strict(),
  z.object({ kind: z.literal("finished"), request }).strict(),
  z
    .object({
      kind: z.literal("failed"),
      request,
      category: z.enum([
        "aborted",
        "connection-reset",
        "connection-closed",
        "connection-refused",
        "timed-out",
        "name-resolution",
        "cache-read",
        "content-length",
        "other",
        "unknown",
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("entered"), guard, checkpoint }).strict(),
  z.object({ kind: z.literal("ready-fulfilled"), guard }).strict(),
  z
    .object({
      kind: z.literal("decision"),
      guard,
      dispatchMs: nodeMs,
      decision: decisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("guard-refusal"),
      guard,
      category: z.literal("bundled-nunito-not-loaded"),
    })
    .strict(),
  z.object({ kind: z.literal("save"), marker: saveMarker }).strict(),
]);
export const eventSchema = z
  .object({
    sequence: z.number().int().min(1).max(96),
    clock: z.literal("node-performance"),
    nodeMs,
    document,
    data: eventDataSchema,
  })
  .strict();
export type EventData = z.infer<typeof eventDataSchema>;
export type Event = z.infer<typeof eventSchema>;
export const calibrationMode = z.enum([
  "healthy",
  "delayed",
  "abort",
  "corrupt",
  "hold",
  "missing",
  "unused",
  "mixed",
  "overflow",
  "reload",
  "redirect",
  "pass",
  "skip",
  "page-close",
  "invalid-form",
  "held-response",
  "later-font-failure",
  "refused",
]);
export const identitySchema = z
  .object({
    scenario: z.enum(["smoke", "desktop", "mobile", "calibration"]),
    project: z.enum([
      "firefox-smoke",
      "webkit-smoke",
      "chromium-desktop",
      "chromium-mobile",
    ]),
    retry: z.literal(0),
    ordinal: z.number().int().min(0).max(32),
    calibration: calibrationMode.nullable(),
  })
  .strict();
export const phaseSchema = z
  .object({
    mode: z.enum(["capture", "verify", "calibration"]),
    invocation: z.number().int().min(1).max(32),
    control: z.enum(["none", "mutation", "missing"]),
  })
  .strict();
export type Phase = z.infer<typeof phaseSchema>;
export const assetSchema = z
  .object({
    subset,
    file: z
      .string()
      .regex(
        /^assets\/nunito-(?:cyrillic-ext|cyrillic|vietnamese|latin-ext|latin)-wght-normal-[A-Za-z0-9_-]{8}\.woff2$/,
      ),
    sha256: digest,
    bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024),
  })
  .strict();
export const bindingSchema = z
  .object({
    manifest: digest,
    source: digest,
    build: digest,
    html: digest,
    css: digest,
    assets: z.array(assetSchema).length(5),
    playwright: z.literal("1.64.1"),
    nunito: z.literal("5.3.0"),
    runtimeFixture: z.literal("excluded-unread"),
  })
  .strict()
  .refine(({ assets }) =>
    assets.every((asset, index) => asset.subset === subset.options[index]),
  );
export type Binding = z.infer<typeof bindingSchema>;
export const admissionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("admitted"), binding: bindingSchema }).strict(),
  z
    .object({
      kind: z.literal("refused"),
      reason: z.enum([
        "unsupported-source",
        "unsupported-build",
        "binding-mismatch",
        "invalid-context",
        "foreign-font-url",
      ]),
    })
    .strict(),
]);
export type Admission = z.infer<typeof admissionSchema>;
export const contextSchema = z
  .object({ run: digest, phase: phaseSchema, admission: admissionSchema })
  .strict();
export type Context = z.infer<typeof contextSchema>;
export const receiptSchema = z
  .object({
    identity: identitySchema,
    admission: admissionSchema,
    timeout: z.literal(30000),
    startMs: nodeMs,
    stopMs: nodeMs,
    events: z.array(eventSchema).max(96),
    loss: z.enum([
      "none",
      "event-bound",
      "request-bound",
      "document-bound",
      "guard-bound",
      "schema-rejected",
    ]),
    failureCategory: z.enum(["unclassified", "bundled-nunito-not-loaded"]),
    lifecycle: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("active") }).strict(),
      z
        .object({
          kind: z.literal("disposed"),
          detached: z.literal(true),
          status: z.enum([
            "passed",
            "failed",
            "timedOut",
            "skipped",
            "interrupted",
          ]),
        })
        .strict(),
    ]),
    legacyStream: z.literal("referenced-not-owned"),
  })
  .strict();
export type Receipt = z.infer<typeof receiptSchema>;
export const frameSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["guard-failure", "case-final"]),
    context: contextSchema,
    receipt: receiptSchema,
  })
  .strict();
export type Frame = z.infer<typeof frameSchema>;

export function parseContext(value: string | undefined): Context | null {
  if (!value || Buffer.byteLength(value) > 8192) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = contextSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
