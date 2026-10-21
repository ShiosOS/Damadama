import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { classify, errorCategory, observation } from "./quiet-save-schema.mjs";
import { receiptRow, titles } from "./quiet-save-receipt.mjs";

const phase = z.enum([
  "calibration",
  "Firefox and WebKit smoke",
  "fresh visual comparison 1",
  "fresh visual comparison 2",
  "fresh visual comparison 3",
  "changed-row pixel rejection and same-page restoration",
  "missing-baseline rejection",
]);
const project = z.enum([
  "firefox-smoke",
  "webkit-smoke",
  "chromium-desktop",
  "chromium-mobile",
]);
const status = z.enum([
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
]);

export default class QuietSaveReporter {
  directory = resolve(
    process.env.QUIET_SELF_TEST === "1"
      ? ".audit/quiet-save-self-test-evidence"
      : ".audit/quiet-save/evidence",
  );
  iteration = z.coerce
    .number()
    .int()
    .min(0)
    .max(20)
    .parse(process.env.QUIET_ITERATION);
  control = z
    .enum(["normal", "invalid", "held-response", "deadline"])
    .parse(process.env.QUIET_CONTROL);
  phase = phase.parse(process.env.QUIET_PHASE);
  record(data) {
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(
      resolve(this.directory, `${this.control}-${this.iteration}.jsonl`),
      JSON.stringify(
        receiptRow.parse({
          iteration: this.iteration,
          control: this.control,
          phase: this.phase,
          ...data,
        }),
      ) + "\n",
    );
  }
  onBegin(_config, suite) {
    this.record({ kind: "phase-start", cases: suite.allTests().length });
  }
  onTestEnd(test, result) {
    let safe = null;
    let refusal = false;
    const attachments = result.attachments.filter(
      (item) => item.name === "quiet-save-observation",
    );
    if (attachments.length > 1) refusal = true;
    if (attachments.length === 1) {
      try {
        const body = attachments[0].body;
        if (!body || body.length > 65536)
          throw new Error("Observation bytes refused.");
        safe = observation.parse(JSON.parse(body.toString("utf8")));
      } catch {
        refusal = true;
      }
    }
    this.record({
      kind: "test-result",
      case: titles.indexOf(test.title),
      project: project.parse(test.parent.project().name),
      status: status.parse(result.status),
      durationMs: Math.round(result.duration),
      retry: result.retry,
      errorCategories: result.errors.slice(0, 8).map(errorCategory),
      errorOverflow: result.errors.length > 8,
      observation: safe,
      observationRejected: refusal,
      classification: classify(safe),
    });
  }
  onError(error) {
    this.record({ kind: "runner-error", category: errorCategory(error) });
  }
  onEnd(result) {
    this.record({ kind: "phase-end", status: result.status });
  }
}
