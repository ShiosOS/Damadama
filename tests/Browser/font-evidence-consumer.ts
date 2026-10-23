import { spawnSync } from "node:child_process";
import { z } from "zod";
import { prepareAdmission } from "./font-evidence-admission";
import {
  frameSchema,
  contextSchema,
  prefix,
  type Context,
  type Frame,
  type Receipt,
} from "./font-evidence-schema";

type Consumption =
  | { kind: "absent" }
  | {
      kind: "refused";
      reason:
        | "invalid-frame"
        | "foreign-frame"
        | "conflicting-frame"
        | "admission-refused";
    }
  | {
      kind: "partial";
      reason: "output-incomplete" | "missing-final" | "observation-incomplete";
      frames: Frame[];
    }
  | { kind: "complete"; frames: Frame[] };

function validReceipt(receipt: Receipt): boolean {
  const requests = new Map<
    number,
    { document: number; response: boolean; terminal: boolean }
  >();
  const guards = new Map<
    number,
    {
      document: number;
      readyMs: number | null;
      loaded: boolean | null;
      refused: boolean;
    }
  >();
  let lastTime = receipt.startMs;
  let document = 0;
  let closed = false;
  let transports = 0;
  const markers = [
    "create-waiter-armed",
    "create-response-await-start",
    "create-response-await-complete",
    "create-json-complete",
    "saved-assertions-complete",
  ];
  let save = 0;
  for (const [index, event] of receipt.events.entries()) {
    if (
      event.sequence !== index + 1 ||
      event.nodeMs < lastTime ||
      event.nodeMs > receipt.stopMs ||
      closed
    )
      return false;
    lastTime = event.nodeMs;
    const data = event.data;
    if (data.kind === "navigation") {
      if (event.document !== ++document) return false;
      continue;
    }
    if (event.document > document) return false;
    if (data.kind === "page-closed") {
      closed = true;
      continue;
    }
    if (
      ["request", "response", "finished", "failed"].includes(data.kind) &&
      ++transports > 32
    )
      return false;
    switch (data.kind) {
      case "request":
        if (
          requests.has(data.request) ||
          data.request !== requests.size + 1 ||
          event.document !== document
        )
          return false;
        requests.set(data.request, {
          document: event.document,
          response: false,
          terminal: false,
        });
        break;
      case "response": {
        const request = requests.get(data.request);
        if (
          !request ||
          request.response ||
          request.terminal ||
          request.document !== event.document
        )
          return false;
        request.response = true;
        break;
      }
      case "finished":
      case "failed": {
        const request = requests.get(data.request);
        if (!request || request.terminal || request.document !== event.document)
          return false;
        if (data.kind === "finished" && !request.response) return false;
        request.terminal = true;
        break;
      }
      case "entered":
        if (guards.has(data.guard) || data.guard !== guards.size + 1)
          return false;
        guards.set(data.guard, {
          document: event.document,
          readyMs: null,
          loaded: null,
          refused: false,
        });
        break;
      case "ready-fulfilled": {
        const guard = guards.get(data.guard);
        if (!guard || guard.readyMs !== null) return false;
        guard.readyMs = event.nodeMs;
        break;
      }
      case "decision": {
        const guard = guards.get(data.guard);
        if (
          !guard ||
          guard.readyMs === null ||
          guard.loaded !== null ||
          data.dispatchMs > event.nodeMs ||
          data.dispatchMs < guard.readyMs
        )
          return false;
        if (
          guard.document !== event.document &&
          (data.decision.sample.kind !== "unavailable" ||
            data.decision.sample.reason !== "document-changed")
        )
          return false;
        guard.loaded = data.decision.fontLoaded;
        break;
      }
      case "guard-refusal": {
        const guard = guards.get(data.guard);
        if (!guard || guard.loaded !== false || guard.refused) return false;
        guard.refused = true;
        break;
      }
      case "save":
        if (data.marker !== markers[save++]) return false;
        break;
      default: {
        const exhaustive: never = data;
        return exhaustive;
      }
    }
  }
  const refused = receipt.events.some(
    (event) => event.data.kind === "guard-refusal",
  );
  return (
    receipt.stopMs >= lastTime &&
    refused === (receipt.failureCategory === "bundled-nunito-not-loaded")
  );
}

export function consumeFontEvidence(input: {
  stdout: string;
  stderr: string;
  context: Context;
  outputComplete: boolean;
}): Consumption {
  const expected = contextSchema.safeParse(input.context);
  if (!expected.success) return { kind: "refused", reason: "foreign-frame" };
  const frames: Frame[] = [];
  let total = 0;
  for (const stream of [input.stdout, input.stderr]) {
    for (const line of stream.split(/\r?\n/)) {
      if (!line.includes(prefix)) continue;
      if (!/^(?: {0,4})compatibility-evidence-v1 /.test(line))
        return { kind: "refused", reason: "invalid-frame" };
      const text = line.trimStart().slice(prefix.length);
      total += Buffer.byteLength(line);
      if (Buffer.byteLength(line) > 16384 || total > 65536)
        return { kind: "refused", reason: "invalid-frame" };
      try {
        const value: unknown = JSON.parse(text);
        const parsed = frameSchema.safeParse(value);
        if (!parsed.success || !validReceipt(parsed.data.receipt))
          return { kind: "refused", reason: "invalid-frame" };
        if (
          JSON.stringify(parsed.data.context) !== JSON.stringify(expected.data)
        )
          return { kind: "refused", reason: "foreign-frame" };
        frames.push(parsed.data);
      } catch {
        return { kind: "refused", reason: "invalid-frame" };
      }
    }
  }
  if (!input.outputComplete)
    return { kind: "partial", reason: "output-incomplete", frames };
  if (frames.length === 0) return { kind: "absent" };
  const cases = new Map<
    string,
    { failure: Frame | null; final: Frame | null }
  >();
  for (const frame of frames) {
    const key = JSON.stringify(frame.receipt.identity);
    const found = cases.get(key) ?? { failure: null, final: null };
    if (frame.kind === "guard-failure") {
      if (
        found.failure ||
        found.final ||
        frame.receipt.lifecycle.kind !== "active" ||
        frame.receipt.events.at(-1)?.data.kind !== "guard-refusal"
      )
        return { kind: "refused", reason: "conflicting-frame" };
      found.failure = frame;
    } else {
      if (
        found.final ||
        frame.receipt.lifecycle.kind !== "disposed" ||
        ["passed", "skipped"].includes(frame.receipt.lifecycle.status)
      )
        return { kind: "refused", reason: "conflicting-frame" };
      found.final = frame;
      if (found.failure) {
        const before = found.failure.receipt;
        const after = frame.receipt;
        if (
          before.startMs !== after.startMs ||
          before.stopMs > after.stopMs ||
          JSON.stringify(before.events) !==
            JSON.stringify(after.events.slice(0, before.events.length))
        )
          return { kind: "refused", reason: "conflicting-frame" };
      }
    }
    cases.set(key, found);
  }
  if (
    frames.some(
      (frame) =>
        frame.receipt.admission.kind === "refused" ||
        JSON.stringify(frame.receipt.admission) !==
          JSON.stringify(expected.data.admission),
    )
  )
    return { kind: "refused", reason: "admission-refused" };
  if ([...cases.values()].some((item) => !item.final))
    return { kind: "partial", reason: "missing-final", frames };
  for (const { final } of cases.values()) {
    if (!final) continue;
    const events = final.receipt.events;
    if (
      events.some(
        (event) =>
          event.data.kind === "decision" &&
          !event.data.decision.fontLoaded &&
          !events.some(
            (later) =>
              later.data.kind === "guard-refusal" &&
              event.data.kind === "decision" &&
              later.data.guard === event.data.guard,
          ),
      )
    )
      return { kind: "partial", reason: "observation-incomplete", frames };
    const saves = events.filter((event) => event.data.kind === "save");
    const lastSave = saves.at(-1)?.data;
    if (
      events.length === 0 ||
      (lastSave?.kind === "save" &&
        lastSave.marker !== "saved-assertions-complete") ||
      events.some(
        (event) =>
          event.data.kind === "request" &&
          !events.some(
            (later) =>
              (later.data.kind === "finished" ||
                later.data.kind === "failed") &&
              event.data.kind === "request" &&
              later.data.request === event.data.request,
          ),
      )
    )
      return { kind: "partial", reason: "observation-incomplete", frames };
  }
  if (
    [...cases.values()].some(({ final }) =>
      final?.receipt.events.some(
        (event) =>
          event.data.kind === "entered" &&
          !final.receipt.events.some(
            (later) =>
              later.data.kind === "decision" &&
              event.data.kind === "entered" &&
              later.data.guard === event.data.guard,
          ),
      ),
    )
  )
    return { kind: "partial", reason: "observation-incomplete", frames };
  if (
    frames.some(
      (frame) =>
        frame.receipt.loss !== "none" ||
        frame.receipt.events.some(
          (event) =>
            event.data.kind === "decision" &&
            event.data.decision.sample.kind === "unavailable",
        ),
    )
  )
    return { kind: "partial", reason: "observation-incomplete", frames };
  return { kind: "complete", frames };
}

export function failedChildEvidence(
  input: Parameters<typeof consumeFontEvidence>[0] & { exitCode: number },
): string {
  const verdict = consumeFontEvidence(input);
  const safe =
    verdict.kind === "complete" || verdict.kind === "absent"
      ? { kind: verdict.kind }
      : { kind: verdict.kind, reason: verdict.reason };
  return `compatibility-evidence-consumption ${JSON.stringify({ ...safe, exitCode: input.exitCode, context: input.context })}`;
}

export async function runCompatibilityChild(input: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  context: Context;
}): Promise<{
  exitCode: number;
  output: string;
  evidence: string;
  consumption: Consumption;
}> {
  const result = spawnSync("node", input.args, {
    cwd: input.cwd,
    encoding: "utf8",
    env: { ...input.env, COMPAT_FONT_CONTEXT: JSON.stringify(input.context) },
    maxBuffer: 8 * 1024 * 1024,
  });
  const exitCode = result.status ?? 1;
  const stdout = z.string().safeParse(result.stdout);
  const stderr = z.string().safeParse(result.stderr);
  const evidenceInput = {
    stdout: stdout.success ? stdout.data : "",
    stderr: stderr.success ? stderr.data : "",
    context: input.context,
    outputComplete:
      !result.error &&
      result.signal === null &&
      result.status !== null &&
      stdout.success &&
      stderr.success,
  };
  let consumption = consumeFontEvidence(evidenceInput);
  const current = await prepareAdmission(input.cwd);
  if (
    input.context.admission.kind === "admitted" &&
    JSON.stringify(current) !== JSON.stringify(input.context.admission)
  )
    consumption = { kind: "refused", reason: "admission-refused" };
  let evidence = failedChildEvidence({ ...evidenceInput, exitCode });
  if (consumption.kind === "refused")
    evidence = `compatibility-evidence-consumption ${JSON.stringify({ ...consumption, exitCode, context: input.context })}`;
  return {
    exitCode,
    output: `${result.stdout}\n${result.stderr}`,
    evidence,
    consumption,
  };
}
