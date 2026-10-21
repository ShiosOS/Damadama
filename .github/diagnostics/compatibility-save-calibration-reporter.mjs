import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const observation = z
  .object({
    monotonicMs: z.number().int().nonnegative(),
    event: z.enum([
      "test-start",
      "initial-list-ready",
      "dialog-open",
      "creation-checkpoint-complete",
      "before-save-enter",
      "after-save-enter",
      "create-request",
      "create-response",
      "create-request-failed",
      "focusin",
      "input",
      "keydown",
      "invalid",
      "submit",
      "calibration-response-held",
    ]),
    status: z.number().int().min(100).max(599).optional(),
    saveFocused: z.boolean().optional(),
    saveEnabled: z.boolean().optional(),
    fields: z
      .array(
        z
          .object({
            label: z.enum([
              "Name",
              "Good",
              "Better",
              "Best",
              "Repeat every (weeks)",
            ]),
            present: z.boolean(),
            focused: z.boolean(),
            populated: z.boolean(),
            valid: z.boolean(),
          })
          .strict(),
      )
      .max(5)
      .optional(),
  })
  .strict();

export default class SaveCalibrationReporter {
  control = z
    .enum(["invalid", "held-response"])
    .parse(process.env.COMPAT_SAVE_CALIBRATION);
  file = resolve(`.audit/compatibility-save-calibration/${this.control}.jsonl`);
  pending = "";

  record(data) {
    const line = JSON.stringify({ control: this.control, ...data }) + "\n";
    appendFileSync(this.file, line);
    process.stdout.write(line);
  }

  onBegin(_config, suite) {
    writeFileSync(this.file, "");
    this.record({
      kind: "start",
      cases: suite.allTests().length,
      node: process.version,
      head: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .parse(process.env.COMPAT_CURRENT_SHA),
    });
  }

  onStdOut(chunk) {
    const prefix = "compatibility-diagnostic ";
    const lines = (this.pending + chunk.toString()).split("\n");
    const tail = lines.pop() ?? "";
    this.pending = "";
    if (tail.length > 4096) this.record({ kind: "rejected-observation" });
    else this.pending = tail;
    for (const line of lines) {
      if (!line.startsWith(prefix)) continue;
      if (line.length > 4096) {
        this.record({ kind: "rejected-observation" });
        continue;
      }
      let parsed;
      try {
        parsed = observation.safeParse(JSON.parse(line.slice(prefix.length)));
      } catch {
        this.record({ kind: "rejected-observation" });
        continue;
      }
      if (!parsed.success) {
        this.record({ kind: "rejected-observation" });
        continue;
      }
      this.record({ kind: "observation", ...parsed.data });
    }
  }

  onTestEnd(_test, result) {
    if (this.pending) this.record({ kind: "rejected-observation" });
    this.pending = "";
    const errors = result.errors.map((error) => error.message ?? "").join("\n");
    this.record({
      kind: "result",
      status: result.status,
      durationMs: result.duration,
      responseWait: errors.includes("page.waitForResponse"),
      focusAssertion: errors.includes("toBeFocused"),
      missingBaseline:
        /snapshot.*doesn.t exist|no snapshots|missing snapshot/i.test(errors),
    });
  }

  onEnd(result) {
    this.record({ kind: "end", status: result.status });
  }

  onError() {
    this.record({ kind: "runner-error" });
  }
}
