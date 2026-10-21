import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { classify, errorCategory, observation } from "./quiet-save-schema.mjs";
import { receiptRow, titles } from "./quiet-save-receipt.mjs";
import { controls, mediaManifest } from "./quiet-save-media.mjs";
import {
  digest,
  failedStep,
  failureStage,
  loadSources,
  normalizeSite,
  unavailableSite,
} from "./quiet-save-source.mjs";

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

function errorKey(error) {
  if (
    typeof error?.message !== "string" ||
    !error.message ||
    typeof error.stack !== "string" ||
    !error.stack
  )
    return null;
  return digest(JSON.stringify([error.message, error.stack]));
}

export default class QuietSaveReporter {
  candidates = new Map();
  sources = loadSources(process.env.QUIET_SELF_TEST === "1");
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
  control = z.enum(controls).parse(process.env.QUIET_CONTROL);
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
  onStepEnd(test, _result, step) {
    if (!step.error || step.steps?.some((child) => child.error)) return;
    let state = this.candidates.get(test.id);
    if (!state) {
      state = { rows: [], overflow: false };
      this.candidates.set(test.id, state);
    }
    if (state.rows.length >= 8) {
      state.overflow = true;
      return;
    }
    const key = errorKey(step.error);
    if (key === null) return;
    state.rows.push({
      key,
      ...failedStep(step, this.sources),
    });
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
    let media = null;
    let mediaRejected = false;
    const mediaAttachments = result.attachments.filter(
      (item) => item.name === "quiet-save-media",
    );
    if (mediaAttachments.length > 1) mediaRejected = true;
    if (mediaAttachments.length === 1) {
      try {
        const body = mediaAttachments[0].body;
        if (!body || body.length > 16384)
          throw new Error("Media manifest refused.");
        media = mediaManifest.parse(JSON.parse(body.toString("utf8")));
        if (
          media.owner.control !== this.control ||
          media.owner.iteration !== this.iteration ||
          media.owner.phase !== this.phase ||
          media.owner.project !== test.parent.project().name ||
          media.owner.case !== titles.indexOf(test.title)
        )
          throw new Error("Media owner differs.");
      } catch {
        media = null;
        mediaRejected = true;
      }
    }
    let failure = null;
    if (!["passed", "skipped"].includes(result.status)) {
      const state = this.candidates.get(test.id) ?? {
        rows: [],
        overflow: false,
      };
      const primary = result.errors[0];
      const key = errorKey(primary);
      const errorSite = normalizeSite(primary?.location, this.sources);
      const matching = state.rows.filter(
        (candidate) =>
          candidate.key === key &&
          (errorSite.source === "unavailable" ||
            JSON.stringify(candidate.site) === JSON.stringify(errorSite)),
      );
      let selected;
      if (matching.length === 1 && !state.overflow) selected = matching[0];
      let site = unavailableSite;
      let locationOrigin = "unavailable";
      if (selected?.site.source !== "unavailable" && selected) {
        site = selected.site;
        locationOrigin = "step";
      } else if (errorSite.source !== "unavailable") {
        site = errorSite;
        locationOrigin = "result-error";
      }
      failure = {
        stage: failureStage(safe),
        site,
        category: selected?.category ?? "unknown",
        operation: selected?.operation ?? "unknown",
        locationOrigin,
        candidateOverflow: state.overflow,
      };
    }
    this.candidates.delete(test.id);
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
      failure,
      media,
      mediaRejected,
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
