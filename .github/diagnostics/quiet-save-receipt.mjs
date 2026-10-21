import { z } from "zod";
import { classify, observation, passiveFailure } from "./quiet-save-schema.mjs";
import {
  caseNames,
  controls,
  mediaManifest,
  ownerSchema,
  phaseNames,
} from "./quiet-save-media.mjs";
import { failureSchema, failureStage } from "./quiet-save-source.mjs";

export const phases = phaseNames.slice(1);
export const titles = caseNames;
const common = {
  iteration: z.number().int().min(0).max(20),
  control: z.enum(controls),
  phase: ownerSchema.shape.phase,
};
const error = z.enum([
  "pending-waiter-global-timeout",
  "whole-test-timeout",
  "unknown-runner-error",
]);
export const receiptRow = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("phase-start"),
      cases: z.number().int().min(1).max(6),
    })
    .strict(),
  z
    .object({ ...common, kind: z.literal("runner-error"), category: error })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("phase-end"),
      status: z.enum(["passed", "failed", "timedout", "interrupted"]),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("test-result"),
      project: ownerSchema.shape.project,
      case: z.number().int().min(0).max(2),
      status: z.enum([
        "passed",
        "failed",
        "timedOut",
        "skipped",
        "interrupted",
      ]),
      durationMs: z.number().int().nonnegative(),
      retry: z.literal(0),
      errorCategories: z.array(error).max(8),
      errorOverflow: z.boolean(),
      observation: observation.nullable(),
      observationRejected: z.boolean(),
      failure: failureSchema.nullable(),
      passive: passiveFailure.nullable().optional(),
      media: mediaManifest.nullable(),
      mediaRejected: z.boolean(),
      classification: z.enum([
        "unknown",
        "deadline-before-enter",
        "response-observed",
        "request-failed",
        "post-without-response",
        "native-invalid",
        "submit-without-post",
      ]),
    })
    .strict(),
]);

export function parseReceipt(text, control, iteration) {
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new Error("Receipt byte bound exceeded.");
  const lines = text.trim().split("\n");
  if (lines.length > 128) throw new Error("Receipt row bound exceeded.");
  return lines.map((line) => {
    if (Buffer.byteLength(line) > 66560)
      throw new Error("Receipt row byte bound exceeded.");
    const row = receiptRow.parse(JSON.parse(line));
    if (
      row.kind === "test-result" &&
      row.observation &&
      (row.observation.font === null) !==
        ["passed", "skipped"].includes(row.status)
    )
      throw new Error("Receipt font status differs.");
    if (row.control !== control || row.iteration !== iteration)
      throw new Error("Receipt owner differs.");
    if (control === "normal") {
      if (iteration < 1 || row.phase === "calibration")
        throw new Error("Normal receipt phase differs.");
      if (
        row.kind === "test-result" &&
        (row.passive === undefined ||
          row.observation !== null ||
          row.failure !== null ||
          row.observationRejected ||
          row.classification !== "unknown")
      )
        throw new Error("Normal receipt requires passive profile.");
      if (
        row.kind === "test-result" &&
        !["passed", "skipped"].includes(row.status) &&
        row.passive === null
      )
        throw new Error("Normal failure detail missing.");
    } else if (iteration !== 0 || row.phase !== "calibration")
      throw new Error("Calibration receipt phase differs.");
    if (row.kind === "test-result" && row.media) {
      const owner = row.media.owner;
      if (
        owner.control !== row.control ||
        owner.iteration !== row.iteration ||
        owner.phase !== row.phase ||
        owner.project !== row.project ||
        owner.case !== row.case
      )
        throw new Error("Receipt media owner differs.");
    }
    if (row.kind === "test-result" && row.passive) {
      const owner = row.passive.owner;
      if (
        owner.control !== row.control ||
        owner.iteration !== row.iteration ||
        owner.phase !== row.phase ||
        owner.project !== row.project ||
        owner.case !== row.case ||
        ["passed", "skipped"].includes(row.status)
      )
        throw new Error("Passive receipt owner or status differs.");
      if (
        row.observation !== null ||
        row.failure !== null ||
        row.classification !== "unknown"
      )
        throw new Error("Passive and legacy detail profiles differ.");
      if (
        row.control === "normal" &&
        row.passive.budget.configuredWholeTestMs !== 30000
      )
        throw new Error("Normal case budget differs.");
      if (
        row.passive.errors.kind === "complete" &&
        (row.errorOverflow ||
          row.passive.errors.value.length !== row.errorCategories.length)
      )
        throw new Error("Passive result error inventory differs.");
      validatePassiveDetail(row.passive);
    }
    if (
      row.kind === "test-result" &&
      row.failure &&
      row.failure.stage !== failureStage(row.observation)
    )
      throw new Error("Receipt failure stage differs.");
    if (
      row.kind === "test-result" &&
      row.classification !== classify(row.observation)
    )
      throw new Error("Receipt classification differs.");
    return row;
  });
}

function validatePassiveDetail(detail) {
  const orders = new Set();
  const samples = [];
  if (detail.operations.kind === "complete") {
    let previous = 0;
    for (const [index, row] of detail.operations.value.entries()) {
      if (
        row.sequence !== index + 1 ||
        row.receiptOrder <= previous ||
        orders.has(row.receiptOrder)
      )
        throw new Error("Passive operation order differs.");
      previous = row.receiptOrder;
      orders.add(row.receiptOrder);
      samples.push({ order: row.receiptOrder, at: row.start });
      if (row.end.kind !== "not-observed") {
        if (
          row.end.receiptOrder <= row.receiptOrder ||
          orders.has(row.end.receiptOrder)
        )
          throw new Error("Passive operation terminal order differs.");
        orders.add(row.end.receiptOrder);
        samples.push({ order: row.end.receiptOrder, at: row.end.at });
        if (
          row.start.kind === "complete" &&
          row.end.at.kind === "complete" &&
          row.end.at.value < row.start.value
        )
          throw new Error("Passive operation time reversed.");
      }
    }
  }
  samples.sort((left, right) => left.order - right.order);
  if (
    samples.some(
      (sample, index) =>
        sample.at.kind === "complete" &&
        samples[index - 1]?.at.kind === "complete" &&
        sample.at.value < samples[index - 1].at.value,
    )
  )
    throw new Error("Passive receipt wall order differs.");
  if (detail.errors.kind === "complete") {
    for (const [index, error] of detail.errors.value.entries()) {
      if (error.errorIndex !== index)
        throw new Error("Passive error index differs.");
      if (
        error.correlation.kind === "unique-step" &&
        (detail.operations.kind !== "complete" ||
          detail.operations.value[error.correlation.occurrence - 1]?.end
            .kind !== "error")
      )
        throw new Error("Passive error correlation differs.");
    }
  }
  const offsets = [];
  if (detail.operations.kind === "complete")
    for (const row of detail.operations.value) {
      offsets.push(row.start);
      if (row.end.kind !== "not-observed") offsets.push(row.end.at);
    }
  if (detail.network.kind === "complete") {
    const network = detail.network.value;
    if (JSON.stringify(network.owner) !== JSON.stringify(detail.owner))
      throw new Error("Passive network owner differs.");
    offsets.push(network.installationWall, network.end.wall);
    const wallSamples = [
      network.installationWall,
      ...network.events.map((event) => event.wall),
      network.end.wall,
    ];
    if (
      wallSamples.some(
        (sample, index) =>
          sample.kind === "complete" &&
          wallSamples[index - 1]?.kind === "complete" &&
          sample.value < wallSamples[index - 1].value,
      )
    )
      throw new Error("Passive network wall order differs.");
    if (network.installationWall.kind === "complete")
      for (const sample of [...network.events, network.end])
        if (
          sample.wall.kind === "complete" &&
          Math.abs(
            sample.wall.value - network.installationWall.value - sample.at,
          ) > 10
        )
          throw new Error("Passive network clock differs.");
    let prior = 0;
    const requests = new Map();
    for (const [index, event] of network.events.entries()) {
      offsets.push(event.wall);
      if (
        event.sequence !== index + 1 ||
        event.at < prior ||
        event.at > network.end.at
      )
        throw new Error("Passive network order differs.");
      prior = event.at;
      if (event.event.kind === "request") {
        if (event.requestOrdinal !== requests.size + 1)
          throw new Error("Passive request order differs.");
        requests.set(event.requestOrdinal, false);
      } else {
        if (requests.get(event.requestOrdinal) !== false)
          throw new Error("Passive request lifecycle differs.");
        requests.set(event.requestOrdinal, true);
      }
    }
  }
  if (
    detail.budget.wallOffsets === "unavailable" &&
    offsets.some((offset) => offset.kind === "complete")
  )
    throw new Error("Passive unavailable clock has trusted offsets.");
  if (
    detail.budget.wallOffsets !== "unavailable" &&
    offsets.some((offset) => offset.kind !== "complete")
  )
    throw new Error("Passive available clock has refused offsets.");
}

function activeCase(project) {
  if (project === "chromium-desktop") return 1;
  if (project === "chromium-mobile") return 2;
  return 0;
}

function phaseInventory(phase, control) {
  let projects = ["chromium-desktop"];
  if (control === "normal") {
    const index = phases.indexOf(phase);
    if (index === 0) projects = ["firefox-smoke", "webkit-smoke"];
    else if (index <= 3) projects = ["chromium-desktop", "chromium-mobile"];
  }
  const cases =
    control === "normal"
      ? [...titles.keys()]
      : [activeCase("chromium-desktop")];
  return projects.flatMap((project) => cases.map((id) => `${project}:${id}`));
}

function completePhase(rows, phase, control) {
  if (rows[0]?.kind !== "phase-start" || rows.at(-1)?.kind !== "phase-end")
    return false;
  if (rows.some((row) => row.phase !== phase)) return false;
  if (
    rows.filter((row) => row.kind === "phase-start").length !== 1 ||
    rows.filter((row) => row.kind === "phase-end").length !== 1
  )
    return false;
  const expected = new Set(phaseInventory(phase, control));
  const results = rows.filter((row) => row.kind === "test-result");
  if (rows[0].cases !== expected.size || results.length !== expected.size)
    return false;
  for (const row of results) {
    if (!expected.delete(`${row.project}:${row.case}`)) return false;
    if (row.observationRejected || row.errorOverflow || row.mediaRejected)
      return false;
  }
  return expected.size === 0;
}

export function calibrationMatched(rows, control, exitCode) {
  if (
    exitCode !== 1 ||
    !completePhase(rows, "calibration", control) ||
    rows.at(-1).status !== "failed"
  )
    return false;
  const result = rows.find((row) => row.kind === "test-result");
  if (["presave-assertion", "pixel-mismatch"].includes(control)) {
    if (
      result.status !== "failed" ||
      result.failure?.stage !== "creation-comparison" ||
      result.failure.category !== "expect" ||
      result.failure.candidateOverflow ||
      result.failure.locationOrigin !== "step" ||
      !result.observation ||
      result.observation.refusal !== "none" ||
      result.observation.node.some((row) =>
        ["waiter-armed", "enter-sent", "request"].includes(row.event),
      ) ||
      rows.some((row) => row.kind === "runner-error") ||
      result.media?.refusal !== "none"
    )
      return false;
    if (control === "presave-assertion")
      return (
        result.failure.site.source === "generated-test" &&
        result.failure.operation === "toBe" &&
        result.media.entries.every((entry) => entry.state === "absent")
      );
    return (
      result.failure.site.source === "visual-support" &&
      result.failure.operation === "toHaveScreenshot" &&
      ["actual", "expected", "diff"].every((kind) =>
        result.media.entries.some(
          (entry) =>
            entry.checkpoint === "desktop-creation" &&
            entry.kind === kind &&
            entry.state === "present",
        ),
      )
    );
  }
  if (
    result.status !== "timedOut" ||
    !result.observation ||
    result.observation.refusal !== "none"
  )
    return false;
  if (
    !result.errorCategories.includes("pending-waiter-global-timeout") ||
    result.errorCategories.some(
      (category) => category === "unknown-runner-error",
    )
  )
    return false;
  if (
    rows.some(
      (row) =>
        row.kind === "runner-error" &&
        (control !== "deadline" ||
          row.category !== "pending-waiter-global-timeout"),
    )
  )
    return false;
  const { node, browser } = result.observation;
  const count = (event) => node.filter((row) => row.event === event).length;
  const saw = (event) => browser.filter((row) => row.event === event);
  if (
    count("test-start") !== 1 ||
    count("waiter-armed") !== 1 ||
    count("response") !== 0 ||
    count("request-failed") !== 0
  )
    return false;
  if (control === "deadline")
    return (
      result.classification === "deadline-before-enter" &&
      count("deadline-gate") === 1 &&
      count("gate-cancelled") === 1 &&
      count("enter-sent") === 0 &&
      count("enter-returned") === 0 &&
      count("request") === 0 &&
      saw("submit").length === 0
    );
  if (
    count("enter-sent") !== 1 ||
    count("enter-returned") !== 1 ||
    !saw("enter").some((row) => row.target === "save")
  )
    return false;
  if (control === "invalid")
    return (
      result.classification === "native-invalid" &&
      saw("submit").length === 0 &&
      count("request") === 0 &&
      saw("invalid").some((row) =>
        row.fields.some(
          (field) =>
            field.label === "Name" &&
            field.present &&
            !field.populated &&
            !field.valid,
        ),
      )
    );
  return (
    result.classification === "post-without-response" &&
    saw("invalid").length === 0 &&
    saw("submit").length === 1 &&
    saw("submit")[0].fields.length === 5 &&
    saw("submit")[0].fields.every(
      (field) => field.present && field.populated && field.valid,
    ) &&
    count("request") === 1 &&
    count("held-response") === 1 &&
    node.some((row) => row.event === "held-response" && row.status === 201)
  );
}

export function invocationPassed(rows, exitCode) {
  if (
    exitCode !== 0 ||
    rows.some(
      (row) => row.kind === "runner-error" || !phases.includes(row.phase),
    )
  )
    return false;
  const starts = rows
    .filter((row) => row.kind === "phase-start")
    .map((row) => row.phase);
  if (JSON.stringify(starts) !== JSON.stringify(phases)) return false;
  for (const phase of phases) {
    const selected = rows.filter((row) => row.phase === phase);
    if (
      !completePhase(selected, phase, "normal") ||
      selected.at(-1).status !== "passed"
    )
      return false;
    for (const row of selected.filter((row) => row.kind === "test-result")) {
      const expectedStatus =
        row.case === activeCase(row.project) ? "passed" : "skipped";
      if (
        row.status !== expectedStatus ||
        row.errorCategories.length !== 0 ||
        row.observation !== null ||
        row.failure !== null ||
        row.passive != null ||
        row.media !== null ||
        row.mediaRejected
      )
        return false;
    }
  }
  return true;
}

export const invocationOutcome = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("not-started"),
      reason: z.enum(["budget-refused", "spawn-refused"]),
      receipt: z.literal("absent"),
      teardown: z.literal("not-started"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("started"),
      exitCode: z.number().int().min(0).max(255).nullable(),
      termination: z.enum([
        "none",
        "owned-group-interrupt",
        "interrupt-unverified",
        "owned-group-kill",
        "kill-unverified",
      ]),
      teardown: z.enum([
        "owner-returned-resource-absence-unverified",
        "unverified-stop-no-retry",
      ]),
      receipt: z.enum(["bounded-prefix", "missing", "empty", "malformed"]),
      conclusion: z.enum(["complete-pass", "failure-observed", "incomplete"]),
    })
    .strict(),
]);

export function validateReceiptPrefix(rows, control) {
  const expectedPhases = control === "normal" ? phases : ["calibration"];
  let index = -1;
  let active = false;
  let expected;
  const seen = new Set();
  for (const row of rows) {
    if (row.kind === "phase-start") {
      if (active || row.phase !== expectedPhases[++index])
        throw new Error("Receipt phase order differs.");
      active = true;
      seen.clear();
      expected = new Set(phaseInventory(row.phase, control));
      if (row.cases !== expected.size)
        throw new Error("Receipt case inventory differs.");
    } else {
      if (!active || row.phase !== expectedPhases[index])
        throw new Error("Receipt row outside active phase.");
      if (row.kind === "test-result") {
        const key = `${row.project}:${row.case}`;
        if (!expected.has(key) || seen.has(key))
          throw new Error("Receipt duplicate or foreign case.");
        if (key !== [...expected][seen.size])
          throw new Error("Receipt case order differs.");
        seen.add(key);
      }
      if (row.kind === "phase-end") active = false;
    }
  }
  return rows;
}

export function concludeInvocation(run, rows, control) {
  if (run.kind === "not-started") return invocationOutcome.parse(run);
  let conclusion = "incomplete";
  if (rows && run.termination === "none") {
    if (control === "normal" && invocationPassed(rows, run.exitCode))
      conclusion = "complete-pass";
    else if (
      rows.some(
        (row) =>
          row.kind === "test-result" &&
          ["failed", "timedOut", "interrupted"].includes(row.status),
      )
    )
      conclusion = "failure-observed";
  }
  return invocationOutcome.parse({ ...run, conclusion });
}
