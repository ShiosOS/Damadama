import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  classify,
  errorCategory,
  observation,
  passiveAttachment,
  passiveFailure,
  complete,
  unverified,
} from "./quiet-save-schema.mjs";
import { receiptRow, titles } from "./quiet-save-receipt.mjs";
import { controls, mediaManifest, ownerSchema } from "./quiet-save-media.mjs";
import {
  digest,
  failedStep,
  failureStage,
  loadSources,
  normalizeSite,
  unavailableSite,
  admitPassiveOperation,
  loadPassiveSources,
  passiveRuntimeProof,
  publicPassiveSite,
} from "./quiet-save-source.mjs";

const phase = ownerSchema.shape.phase;
const project = ownerSchema.shape.project;
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
  passive = process.env.QUIET_PROFILE === "passive";
  sources = this.passive
    ? loadPassiveSources(process.env.QUIET_SELF_TEST === "1")
    : loadSources(process.env.QUIET_SELF_TEST === "1");
  ledgers = new Map();
  runtime = this.passive ? passiveRuntimeProof() : null;
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
  constructor() {
    if (this.control === "normal" && !this.passive)
      throw new Error("Normal execution requires passive profile.");
  }
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
  onTestBegin(test) {
    if (this.passive)
      this.ledgers.set(test.id, {
        rows: [],
        steps: new Map(),
        order: 0,
        refusal: null,
      });
  }
  onStepBegin(test, _result, step) {
    if (!this.passive) return;
    const state = this.ledgers.get(test.id);
    if (!state || state.refusal) return;
    const admitted = admitPassiveOperation(step, this.sources);
    if (admitted.kind === "excluded") return;
    if (admitted.kind === "unverified") {
      state.refusal = admitted.reason;
      return;
    }
    if (state.steps.has(step)) {
      state.refusal = "duplicate";
      return;
    }
    if (state.rows.length >= 512) {
      state.refusal = "overflow";
      return;
    }
    const row = {
      sequence: state.rows.length + 1,
      site: admitted.value,
      startWall: step.startTime.getTime(),
      receiptOrder: ++state.order,
      end: { kind: "not-observed" },
      key: null,
    };
    state.rows.push(row);
    state.steps.set(step, row);
  }
  onStepEnd(test, _result, step) {
    if (this.passive) {
      const state = this.ledgers.get(test.id);
      if (!state || state.refusal) return;
      const admitted = admitPassiveOperation(step, this.sources);
      if (admitted.kind === "excluded") return;
      if (admitted.kind === "unverified") {
        state.refusal = admitted.reason;
        return;
      }
      const row = state.steps.get(step);
      if (!row) {
        state.refusal = "lifecycle-incomplete";
        return;
      }
      if (row.end.kind !== "not-observed") {
        state.refusal = "duplicate";
        return;
      }
      row.end = {
        kind: step.error ? "error" : "success",
        wall: step.startTime.getTime() + step.duration,
        duration: step.duration,
        receiptOrder: ++state.order,
      };
      row.key = errorKey(step.error);
      return;
    }
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
        if (
          (safe.font === null) !==
          ["passed", "skipped"].includes(result.status)
        )
          throw new Error("Font observation status differs.");
      } catch {
        safe = null;
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
    if (!this.passive && !["passed", "skipped"].includes(result.status)) {
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
    let passive = null;
    if (this.passive && !["passed", "skipped"].includes(result.status))
      passive = this.passiveDetail(test, result);
    this.ledgers.delete(test.id);
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
      ...(this.passive ? { passive } : {}),
    });
  }
  passiveDetail(test, result) {
    const owner = {
      control: this.control,
      iteration: this.iteration,
      phase: this.phase,
      project: test.parent.project().name,
      case: titles.indexOf(test.title),
    };
    const state = this.ledgers.get(test.id);
    const origin = result.startTime.getTime();
    const validTime = (value) =>
      Number.isFinite(value) && value >= 0 && value <= 300000;
    const stepSamples = (state?.rows ?? [])
      .flatMap((row) => {
        const samples = [{ order: row.receiptOrder, wall: row.startWall }];
        if (row.end.kind !== "not-observed")
          samples.push({ order: row.end.receiptOrder, wall: row.end.wall });
        return samples;
      })
      .sort((left, right) => left.order - right.order);
    let wallUsable =
      this.runtime !== null &&
      Number.isFinite(origin) &&
      state?.rows.every(
        (row) =>
          validTime(row.startWall - origin) &&
          (row.end.kind === "not-observed" ||
            (row.end.duration >= 0 && validTime(row.end.wall - origin))),
      ) &&
      stepSamples.every(
        (sample, index) =>
          sample.wall >= (stepSamples[index - 1]?.wall ?? origin),
      );
    const offset = (value) =>
      wallUsable && validTime(value - origin)
        ? complete(value - origin)
        : unverified("clock-unusable");
    let network = unverified("missing");
    const attachments = result.attachments.filter(
      (item) => item.name === "quiet-save-passive",
    );
    if (attachments.length > 1) network = unverified("duplicate");
    if (attachments.length === 1) {
      try {
        const body = attachments[0].body;
        if (!body || body.length > 8192)
          throw new Error("Attachment size refused.");
        const value = passiveAttachment.parse(
          JSON.parse(body.toString("utf8")),
        );
        if (
          JSON.stringify(value.owner) !== JSON.stringify(owner) ||
          value.workerIndex !== result.workerIndex
        )
          network = unverified("owner-mismatch");
        else if (value.journal.kind === "unverified") network = value.journal;
        else {
          const journal = value.journal.value;
          let prior = 0;
          const requests = new Map();
          let valid = true;
          for (const [index, event] of journal.events.entries()) {
            if (
              event.sequence !== index + 1 ||
              event.at < prior ||
              event.at > journal.end.at
            )
              valid = false;
            prior = event.at;
            if (event.event.kind === "request") {
              if (
                requests.has(event.requestOrdinal) ||
                event.requestOrdinal !== requests.size + 1
              )
                valid = false;
              requests.set(event.requestOrdinal, false);
            } else {
              if (requests.get(event.requestOrdinal) !== false) valid = false;
              requests.set(event.requestOrdinal, true);
            }
          }
          const samples = [...journal.events, journal.end];
          const consistent = samples.every(
            (sample, index) =>
              sample.wall >=
                (samples[index - 1]?.wall ?? journal.installationWall) &&
              validTime(sample.wall - journal.installationWall) &&
              Math.abs(sample.wall - journal.installationWall - sample.at) <=
                10,
          );
          if (
            !consistent ||
            !validTime(journal.installationWall - origin) ||
            samples.some((sample) => !validTime(sample.wall - origin))
          )
            wallUsable = false;
          if (!valid) network = unverified("lifecycle-incomplete");
          else
            network = complete({
              owner,
              workerIndex: value.workerIndex,
              installationWall: offset(journal.installationWall),
              end: {
                provenance: "afterEach-start",
                at: journal.end.at,
                wall: offset(journal.end.wall),
              },
              events: journal.events.map((event) => ({
                ...event,
                wall: offset(event.wall),
              })),
            });
        }
      } catch {
        network = unverified("malformed");
      }
    }
    let operations = unverified(state?.refusal ?? "missing");
    if (state && !state.refusal)
      operations = complete(
        state.rows.map((row) => ({
          sequence: row.sequence,
          site: row.site,
          start: offset(row.startWall),
          receiptOrder: row.receiptOrder,
          end:
            row.end.kind === "not-observed"
              ? row.end
              : {
                  kind: row.end.kind,
                  at: offset(row.end.wall),
                  receiptOrder: row.end.receiptOrder,
                },
        })),
      );
    let errors = unverified("overflow");
    if (result.errors.length <= 8)
      errors = complete(
        result.errors.map((error, errorIndex) => {
          const source = this.sources.find(
            (item) =>
              typeof error.location?.file === "string" &&
              item.path === resolve(error.location.file),
          );
          const found = source?.sites.find(
            (site) =>
              site.line === error.location.line &&
              site.column === error.location.column,
          );
          let site;
          if (found) site = publicPassiveSite(found);
          const key = errorKey(error);
          const matches = state?.refusal
            ? []
            : (state?.rows.filter(
                (row) =>
                  key !== null &&
                  row.key === key &&
                  (!site || JSON.stringify(row.site) === JSON.stringify(site)),
              ) ?? []);
          let correlation = { kind: "unavailable", reason: "no-site" };
          if (matches.length > 1)
            correlation = { kind: "unavailable", reason: "ambiguous" };
          else if (matches.length === 1)
            correlation = {
              kind: "unique-step",
              occurrence: matches[0].sequence,
            };
          else if (site) correlation = { kind: "result-site", site };
          const plain =
            typeof error.message === "string"
              ? error.message.replace(/\u001b\[[0-9;]*m/g, "").trim()
              : "";
          let category = "other-error";
          if (
            /^(?:Error: )?page\.waitForResponse: Test timeout of \d+ms exceeded\./.test(
              plain,
            )
          )
            category = "pending-waiter-global-timeout";
          else if (/^Test timeout of \d+ms exceeded\.?$/.test(plain))
            category = "whole-test-timeout";
          return { errorIndex, category, correlation };
        }),
      );
    const detail = passiveFailure.parse({
      kind: "passive-save",
      owner,
      operations,
      network,
      errors,
      budget: {
        configuredWholeTestMs: test.timeout,
        resultDurationMs: result.duration,
        wallOffsetOrigin: "transported-worker-test-start",
        wallOffsets: wallUsable
          ? "estimates-from-transported-worker-wall-time"
          : "unavailable",
        exactBudgetOrigin: "not-observed",
        exactRemainingMs: "not-observed",
        deadlineInstant: "not-observed",
      },
      observationMeaning: "observed-events-through-afterEach-start",
      cause: "unknown",
    });
    if (Buffer.byteLength(JSON.stringify(detail)) > 60000) {
      detail.operations = unverified("overflow");
      detail.errors = unverified("overflow");
    }
    return detail;
  }
  onError(error) {
    this.record({ kind: "runner-error", category: errorCategory(error) });
  }
  onEnd(result) {
    this.record({ kind: "phase-end", status: result.status });
  }
}
