import type {
  Frame as BrowserFrame,
  Page,
  Request,
  Response,
  TestInfo,
} from "@playwright/test";
import { fontSelection, prepareAdmission } from "./font-evidence-admission";
import {
  calibrationMode,
  decisionSchema,
  rawDecisionSchema,
  eventSchema,
  frameSchema,
  identitySchema,
  parseContext,
  prefix,
  type Admission,
  type Context,
  type EventData,
  type Frame,
  type Receipt,
} from "./font-evidence-schema";

type State = {
  context: Context;
  receipt: Receipt;
  phase: "pending" | "observing" | "stopped" | "sealed";
  failureEmitted: boolean;
  document: number;
  requests: number;
  transports: number;
  guards: number;
  detach: () => void;
};
const pages = new WeakMap<Page, State>();
const cases = new WeakMap<TestInfo, State>();
const titles = new Map([
  ["Firefox and WebKit create, save, and reload through the real API", "smoke"],
  ["desktop creation and saved details remain stable", "desktop"],
  ["mobile saved layout remains stable", "mobile"],
]);
const failures = new Map([
  ["net::ERR_ABORTED", "aborted"],
  ["NS_BINDING_ABORTED", "aborted"],
  ["net::ERR_CONNECTION_RESET", "connection-reset"],
  ["net::ERR_CONNECTION_CLOSED", "connection-closed"],
  ["net::ERR_CONNECTION_REFUSED", "connection-refused"],
  ["net::ERR_TIMED_OUT", "timed-out"],
  ["net::ERR_NAME_NOT_RESOLVED", "name-resolution"],
  ["net::ERR_CACHE_READ_FAILURE", "cache-read"],
  ["net::ERR_CONTENT_LENGTH_MISMATCH", "content-length"],
]);

function append(
  state: State,
  data: EventData,
  document = state.document,
): void {
  if (state.phase !== "observing" || state.receipt.loss !== "none") return;
  if (state.receipt.events.length >= 96) {
    state.receipt.loss = "event-bound";
    return;
  }
  const result = eventSchema.safeParse({
    sequence: state.receipt.events.length + 1,
    clock: "node-performance",
    nodeMs: performance.now(),
    document,
    data,
  });
  if (!result.success) {
    state.receipt.loss = "schema-rejected";
    return;
  }
  state.receipt.events.push(result.data);
}

function emit(state: State, kind: Frame["kind"]): void {
  const result = frameSchema.safeParse({
    version: 1,
    kind,
    context: state.context,
    receipt: state.receipt,
  });
  if (!result.success) return;
  const line = prefix + JSON.stringify(result.data);
  if (Buffer.byteLength(line) <= 16384) console.info(line);
}

export async function beginFontEvidence(
  page: Page,
  info: TestInfo,
): Promise<void> {
  if (cases.has(info) || pages.has(page)) return;
  const supplied = parseContext(process.env["COMPAT_FONT_CONTEXT"]);
  const context: Context = supplied ?? {
    run: "0".repeat(64),
    phase: { mode: "verify", invocation: 1, control: "none" },
    admission: { kind: "refused", reason: "invalid-context" },
  };
  const mode = calibrationMode.safeParse(info.title);
  const identity = identitySchema.safeParse({
    scenario: titles.get(info.title) ?? "calibration",
    project: info.project.name,
    retry: info.retry,
    ordinal: info.repeatEachIndex,
    calibration: mode.success ? mode.data : null,
  });
  if (!identity.success) return;
  const now = performance.now();
  const receipt = frameSchema.shape.receipt.parse({
    identity: identity.data,
    admission: { kind: "refused", reason: "admission-incomplete" },
    timeout: 30000,
    startMs: now,
    stopMs: now,
    events: [],
    loss: "none",
    failureCategory: "unclassified",
    lifecycle: { kind: "active" },
    legacyStream: "referenced-not-owned",
  });
  const state: State = {
    context,
    receipt,
    phase: "pending",
    failureEmitted: false,
    document: 0,
    requests: 0,
    transports: 0,
    guards: 0,
    detach: () => {},
  };
  pages.set(page, state);
  cases.set(info, state);
  let admission: Admission = context.admission;
  if (supplied?.admission.kind === "admitted") {
    const actual = await prepareAdmission();
    admission = actual;
    if (
      actual.kind === "admitted" &&
      JSON.stringify(actual) !== JSON.stringify(supplied.admission)
    )
      admission = { kind: "refused", reason: "binding-mismatch" };
  }
  if (
    state.phase !== "pending" ||
    pages.get(page) !== state ||
    cases.get(info) !== state
  )
    return;
  state.phase = "stopped";
  if (page.isClosed()) return;
  receipt.admission = admission;
  if (admission.kind !== "admitted") return;
  let select: ReturnType<typeof fontSelection>;
  try {
    select = fontSelection(
      admission.binding,
      `http://127.0.0.1:${process.env["DAMADAMA_BROWSER_PORT"] ?? "5174"}`,
    );
  } catch {
    receipt.admission = { kind: "refused", reason: "invalid-context" };
    return;
  }
  const requests = new WeakMap<Request, { id: number; document: number }>();
  function transport(data: EventData, request: Request): void {
    const owned = requests.get(request);
    if (!owned || state.phase !== "observing") return;
    if (++state.transports > 32) {
      receipt.loss = "event-bound";
      return;
    }
    append(state, data, owned.document);
  }
  function onRequest(request: Request): void {
    if (state.phase !== "observing" || request.resourceType() !== "font")
      return;
    try {
      if (request.frame() !== page.mainFrame() || request.method() !== "GET")
        return;
      const asset = select(request.url());
      if (!asset) {
        receipt.admission = { kind: "refused", reason: "foreign-font-url" };
        return;
      }
      if (++state.requests > 8) {
        receipt.loss = "request-bound";
        return;
      }
      requests.set(request, { id: state.requests, document: state.document });
      transport(
        { kind: "request", request: state.requests, subset: asset.subset },
        request,
      );
    } catch {
      receipt.loss = "schema-rejected";
    }
  }
  function onResponse(response: Response): void {
    const request = response.request();
    const owned = requests.get(request);
    if (owned)
      transport(
        { kind: "response", request: owned.id, status: response.status() },
        request,
      );
  }
  function onFinished(request: Request): void {
    const owned = requests.get(request);
    if (owned) transport({ kind: "finished", request: owned.id }, request);
  }
  function onFailed(request: Request): void {
    const owned = requests.get(request);
    if (!owned) return;
    const code = request.failure()?.errorText;
    const category = code ? (failures.get(code) ?? "other") : "unknown";
    const data = eventSchema.shape.data.safeParse({
      kind: "failed",
      request: owned.id,
      category,
    });
    if (data.success) transport(data.data, request);
  }
  function onNavigation(frame: BrowserFrame): void {
    if (state.phase !== "observing" || frame !== page.mainFrame()) return;
    if (state.document >= 4) {
      receipt.loss = "document-bound";
      return;
    }
    state.document++;
    append(state, { kind: "navigation" });
  }
  function onClose(): void {
    append(state, { kind: "page-closed" });
    state.phase = "stopped";
    state.detach();
  }
  state.detach = (): void => {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
    page.off("framenavigated", onNavigation);
    page.off("close", onClose);
  };
  state.phase = "observing";
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  page.on("framenavigated", onNavigation);
  page.on("close", onClose);
}

export function recordSaveMarker(
  page: Page,
  marker: Extract<EventData, { kind: "save" }>["marker"],
): void {
  const state = pages.get(page);
  if (state) append(state, { kind: "save", marker });
}

export type GuardObservation = {
  guard: number;
  document: number;
  dispatchMs: number;
};
export function enterFontGuard(
  info: TestInfo,
  checkpoint: Extract<EventData, { kind: "entered" }>["checkpoint"],
): GuardObservation | null {
  const state = cases.get(info);
  if (state?.phase !== "observing") return null;
  if (++state.guards > 8) {
    state.receipt.loss = "guard-bound";
    return null;
  }
  append(state, { kind: "entered", guard: state.guards, checkpoint });
  return {
    guard: state.guards,
    document: state.document,
    dispatchMs: performance.now(),
  };
}
export function fontReady(
  info: TestInfo,
  observation: GuardObservation | null,
): void {
  const state = cases.get(info);
  if (state?.phase !== "observing" || !observation) return;
  append(state, { kind: "ready-fulfilled", guard: observation.guard });
  observation.dispatchMs = performance.now();
}
export function recordFontDecision(
  info: TestInfo,
  observation: GuardObservation | null,
  value: unknown,
): void {
  const state = cases.get(info);
  if (state?.phase !== "observing" || !observation) return;
  const parsed = decisionSchema.safeParse(value);
  const raw = rawDecisionSchema.safeParse(value);
  if (!raw.success) {
    state.receipt.loss = "schema-rejected";
    return;
  }
  const decision = parsed.success
    ? parsed.data
    : decisionSchema.parse({
        fontLoaded: raw.data.fontLoaded,
        sample: { kind: "unavailable", reason: "schema-rejected" },
      });
  if (observation.document !== state.document)
    decision.sample = { kind: "unavailable", reason: "document-changed" };
  const data = eventSchema.shape.data.safeParse({
    kind: "decision",
    guard: observation.guard,
    dispatchMs: observation.dispatchMs,
    decision,
  });
  if (data.success) append(state, data.data);
  else state.receipt.loss = "schema-rejected";
}
export function recordFontRefusal(
  info: TestInfo,
  observation: GuardObservation | null,
): void {
  const state = cases.get(info);
  if (state?.phase !== "observing" || !observation) return;
  state.receipt.failureCategory = "bundled-nunito-not-loaded";
  append(state, {
    kind: "guard-refusal",
    guard: observation.guard,
    category: "bundled-nunito-not-loaded",
  });
  state.receipt.stopMs = eventSchema.shape.nodeMs.parse(performance.now());
  if (!state.failureEmitted) {
    state.failureEmitted = true;
    emit(state, "guard-failure");
  }
}

export function finishFontEvidence(page: Page, info: TestInfo): void {
  const state = cases.get(info);
  if (!state || state.phase === "sealed") return;
  state.phase = "sealed";
  state.detach();
  state.receipt.stopMs = eventSchema.shape.nodeMs.parse(performance.now());
  state.receipt.lifecycle = {
    kind: "disposed",
    detached: true,
    status: info.status ?? "interrupted",
  };
  if (info.status !== "passed" && info.status !== "skipped")
    emit(state, "case-final");
  if (pages.get(page) === state) pages.delete(page);
}
