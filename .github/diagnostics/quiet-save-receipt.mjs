import { z } from "zod";
import { classify, observation } from "./quiet-save-schema.mjs";

export const phases = [
  "Firefox and WebKit smoke",
  "fresh visual comparison 1",
  "fresh visual comparison 2",
  "fresh visual comparison 3",
  "changed-row pixel rejection and same-page restoration",
  "missing-baseline rejection",
];
export const titles = [
  "Firefox and WebKit create, save, and reload through the real API",
  "desktop creation and saved details remain stable",
  "mobile saved layout remains stable",
];
const common = {
  iteration: z.number().int().min(0).max(20),
  control: z.enum(["normal", "invalid", "held-response", "deadline"]),
  phase: z.enum(["calibration", ...phases]),
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
      project: z.enum([
        "firefox-smoke",
        "webkit-smoke",
        "chromium-desktop",
        "chromium-mobile",
      ]),
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
    if (row.control !== control || row.iteration !== iteration)
      throw new Error("Receipt owner differs.");
    if (
      row.kind === "test-result" &&
      row.classification !== classify(row.observation)
    )
      throw new Error("Receipt classification differs.");
    return row;
  });
}

function completePhase(rows, phase, projects, calibration = false) {
  if (rows[0]?.kind !== "phase-start" || rows.at(-1)?.kind !== "phase-end")
    return false;
  if (rows.some((row) => row.phase !== phase)) return false;
  if (
    rows.filter((row) => row.kind === "phase-start").length !== 1 ||
    rows.filter((row) => row.kind === "phase-end").length !== 1
  )
    return false;
  const cases = calibration ? [1] : [0, 1, 2];
  const expected = new Set(
    projects.flatMap((project) => cases.map((id) => `${project}:${id}`)),
  );
  const results = rows.filter((row) => row.kind === "test-result");
  if (rows[0].cases !== expected.size || results.length !== expected.size)
    return false;
  for (const row of results) {
    if (!expected.delete(`${row.project}:${row.case}`)) return false;
    if (row.observationRejected || row.errorOverflow) return false;
  }
  return expected.size === 0;
}

export function calibrationMatched(rows, control, exitCode) {
  if (
    exitCode !== 1 ||
    !completePhase(rows, "calibration", ["chromium-desktop"], true) ||
    rows.at(-1).status !== "failed"
  )
    return false;
  const result = rows.find((row) => row.kind === "test-result");
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
  for (const [index, phase] of phases.entries()) {
    let projects = ["chromium-desktop"];
    if (index === 0) projects = ["firefox-smoke", "webkit-smoke"];
    else if (index <= 3) projects = ["chromium-desktop", "chromium-mobile"];
    const selected = rows.filter((row) => row.phase === phase);
    if (
      !completePhase(selected, phase, projects) ||
      selected.at(-1).status !== "passed"
    )
      return false;
    for (const row of selected.filter((row) => row.kind === "test-result")) {
      let activeCase = 0;
      if (row.project === "chromium-desktop") activeCase = 1;
      if (row.project === "chromium-mobile") activeCase = 2;
      const expectedStatus = row.case === activeCase ? "passed" : "skipped";
      if (
        row.status !== expectedStatus ||
        row.errorCategories.length !== 0 ||
        row.observation !== null
      )
        return false;
    }
  }
  return true;
}
