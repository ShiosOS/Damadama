import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const observation = z.object({
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
  ]),
  status: z.number().int().min(100).max(599).optional(),
  saveFocused: z.boolean().optional(),
  saveEnabled: z.boolean().optional(),
  fields: z
    .array(
      z.object({
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
      }),
    )
    .max(5)
    .optional(),
});

export default class CpuProbeReporter {
  rate = z.enum(["1", "8"]).parse(process.env.COMPAT_STRESS_CPU_RATE);
  file = resolve(`.audit/compatibility-cpu-probe/rate-${this.rate}.jsonl`);
  pending = new Map();

  record(data) {
    const line = JSON.stringify({ rate: Number(this.rate), ...data }) + "\n";
    appendFileSync(this.file, line);
    process.stdout.write(line);
  }

  onBegin(_config, suite) {
    writeFileSync(this.file, "");
    this.record({ kind: "start", cases: suite.allTests().length });
  }

  onStdOut(chunk, test) {
    const prefix = "compatibility-diagnostic ";
    const repeat = test?.repeatEachIndex ?? -1;
    const lines = ((this.pending.get(repeat) ?? "") + chunk.toString()).split(
      "\n",
    );
    const tail = lines.pop() ?? "";
    this.pending.delete(repeat);
    if (tail.length > 4096) this.record({ kind: "rejected-observation" });
    else if (tail) this.pending.set(repeat, tail);
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
      this.record({
        kind: "observation",
        repeat: test?.repeatEachIndex,
        ...parsed.data,
      });
    }
  }

  onTestEnd(test, result) {
    if (this.pending.delete(test.repeatEachIndex))
      this.record({ kind: "rejected-observation" });
    const errors = result.errors.map((error) => error.message ?? "").join("\n");
    this.record({
      kind: "result",
      repeat: test.repeatEachIndex,
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
