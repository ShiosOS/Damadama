import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  consumeFontEvidence,
  runCompatibilityChild,
} from "./font-evidence-consumer";
import { sourceRoot } from "./font-evidence-admission";
import {
  contextSchema,
  frameSchema,
  prefix,
  subset,
  type Frame,
} from "./font-evidence-schema";

const context = contextSchema.parse({
  run: "a".repeat(64),
  phase: { mode: "verify", invocation: 1, control: "none" },
  admission: {
    kind: "admitted",
    binding: {
      manifest: "b".repeat(64),
      source: "c".repeat(64),
      build: "d".repeat(64),
      html: "e".repeat(64),
      css: "f".repeat(64),
      assets: subset.options.map((kind) => ({
        subset: kind,
        file: `assets/nunito-${kind}-wght-normal-12345678.woff2`,
        sha256: "1".repeat(64),
        bytes: 10,
      })),
      playwright: "1.64.1",
      nunito: "5.3.0",
      runtimeFixture: "excluded-unread",
    },
  },
});
function frame(): Frame {
  const data = [
    { kind: "navigation" },
    { kind: "request", request: 1, subset: "latin" },
    { kind: "response", request: 1, status: 200 },
    { kind: "finished", request: 1 },
    { kind: "entered", guard: 1, checkpoint: "desktop-creation" },
    { kind: "ready-fulfilled", guard: 1 },
    {
      kind: "decision",
      guard: 1,
      dispatchMs: 6,
      decision: {
        fontLoaded: false,
        sample: {
          kind: "available",
          sampledAt: "guard-decision",
          clock: "browser-performance",
          browserMs: 100000,
          setStatus: "loaded",
          counts: { unloaded: 4, loading: 0, loaded: 0, error: 1 },
        },
      },
    },
    { kind: "guard-refusal", guard: 1, category: "bundled-nunito-not-loaded" },
  ];
  return frameSchema.parse({
    version: 1,
    kind: "case-final",
    context,
    receipt: {
      identity: {
        scenario: "desktop",
        project: "chromium-desktop",
        retry: 0,
        ordinal: 0,
        calibration: null,
      },
      admission: context.admission,
      timeout: 30000,
      startMs: 0,
      stopMs: 10,
      loss: "none",
      failureCategory: "bundled-nunito-not-loaded",
      lifecycle: { kind: "disposed", detached: true, status: "failed" },
      legacyStream: "referenced-not-owned",
      events: data.map((event, index) => ({
        sequence: index + 1,
        nodeMs: index + 1,
        clock: "node-performance",
        document: 1,
        data: event,
      })),
    },
  });
}
function line(value: unknown): string {
  return prefix + JSON.stringify(value) + "\n";
}
function consume(stdout: string): ReturnType<typeof consumeFontEvidence> {
  return consumeFontEvidence({
    stdout,
    stderr: "",
    context,
    outputComplete: true,
  });
}

test("strict failed-child consumer preserves stdout and status while refusing an unbound child", async () => {
  const original = "original child failure";
  const result = await runCompatibilityChild({
    args: [
      "-e",
      `console.log(${JSON.stringify(line(frame()))}); console.error(${JSON.stringify(original)}); process.exit(7);`,
    ],
    cwd: sourceRoot,
    env: process.env,
    context,
  });
  expect(result.exitCode).toBe(7);
  expect(result.output).toContain(original);
  expect(result.output).toContain(line(frame()));
  expect(result.consumption.kind).toBe("refused");
  expect(consume("  " + line(frame())).kind).toBe("complete");
  expect(
    consumeFontEvidence({
      stdout: line(frame()),
      stderr: "",
      outputComplete: true,
      context: {
        run: context.run,
        admission: context.admission,
        phase: context.phase,
      },
    }).kind,
  ).toBe("complete");
});

test("missing, truncated, foreign, conflicting and incomplete output cannot become complete evidence", () => {
  const final = frame();
  const failure = frame();
  failure.kind = "guard-failure";
  failure.receipt.lifecycle = { kind: "active" };
  expect(consume("").kind).toBe("absent");
  expect(consume(line(failure))).toMatchObject({
    kind: "partial",
    reason: "missing-final",
  });
  expect(consume(line(failure) + line(final)).kind).toBe("complete");
  const laterStop = structuredClone(failure);
  laterStop.receipt.stopMs = frameSchema.shape.receipt.shape.stopMs.parse(11);
  expect(consume(line(laterStop) + line(final)).kind).toBe("refused");
  const earlyDispatch = frame();
  for (const event of earlyDispatch.receipt.events) {
    if (event.data.kind === "decision")
      event.data.dispatchMs = frameSchema.shape.receipt.shape.startMs.parse(0);
  }
  expect(consume(line(earlyDispatch)).kind).toBe("refused");
  expect(consume(line(final) + line(final)).kind).toBe("refused");
  expect(consume(line(final).slice(0, -10)).kind).toBe("refused");
  expect(
    consume(line({ ...final, context: { ...context, run: "0".repeat(64) } }))
      .kind,
  ).toBe("refused");
  expect(
    consume(
      line({
        ...final,
        context: { ...context, phase: { ...context.phase, invocation: 2 } },
      }),
    ).kind,
  ).toBe("refused");
  expect(
    consumeFontEvidence({
      stdout: line(final),
      stderr: "",
      context,
      outputComplete: false,
    }),
  ).toMatchObject({ kind: "partial", reason: "output-incomplete" });
  final.receipt.events[0] =
    frameSchema.shape.receipt.shape.events.element.parse({
      ...final.receipt.events[0],
      nodeMs: 2,
    });
  expect(consume(line(failure) + line(final)).kind).toBe("refused");
});

test("privacy, counts, clock domains, request ownership, guard ordering and lifecycle are strict boundaries", () => {
  const original = frame();
  const mutations: unknown[] = [
    { ...original, url: "privacy-canary-url" },
    {
      ...original,
      receipt: { ...original.receipt, rawError: "privacy-canary-error" },
    },
    { ...original, receipt: { ...original.receipt, timeout: 60000 } },
    { ...original, receipt: { ...original.receipt, stopMs: -1 } },
    {
      ...original,
      receipt: {
        ...original.receipt,
        events: original.receipt.events.slice(1),
      },
    },
    {
      ...original,
      receipt: {
        ...original.receipt,
        lifecycle: { kind: "disposed", detached: false, status: "failed" },
      },
    },
  ];
  for (const [index, event] of original.receipt.events.entries()) {
    for (const change of [
      { sequence: 1 },
      { nodeMs: 99999 },
      { clock: "browser-performance" },
      { document: 4 },
    ]) {
      if (index === 0 && "sequence" in change) continue;
      const events = [...original.receipt.events];
      mutations.push({
        ...original,
        receipt: {
          ...original.receipt,
          events: events.map((item, i) =>
            i === index ? { ...event, ...change } : item,
          ),
        },
      });
    }
  }
  for (const loaded of [-1, 0.5, 33, 1]) {
    const events = original.receipt.events.map((event) => {
      if (
        event.data.kind !== "decision" ||
        event.data.decision.sample.kind !== "available"
      )
        return event;
      return {
        ...event,
        data: {
          ...event.data,
          decision: {
            ...event.data.decision,
            sample: {
              ...event.data.decision.sample,
              counts: { ...event.data.decision.sample.counts, loaded },
            },
          },
        },
      };
    });
    mutations.push({ ...original, receipt: { ...original.receipt, events } });
  }
  for (const mutation of mutations) {
    const result = consume(line(mutation));
    expect(result.kind).toBe("refused");
    expect(JSON.stringify(result)).not.toContain("privacy-canary");
  }
  expect(consume(line(original)).kind).toBe("complete");
});

test("ready pending, face overflow and missing final remain explicit partial observations", () => {
  const uncategorized = frame();
  uncategorized.receipt.events.pop();
  uncategorized.receipt.failureCategory = "unclassified";
  expect(consume(line(uncategorized))).toMatchObject({
    kind: "partial",
    reason: "observation-incomplete",
  });
  const pending = frame();
  pending.receipt.events = pending.receipt.events.slice(0, 5);
  pending.receipt.failureCategory = "unclassified";
  expect(consume(line(pending))).toMatchObject({
    kind: "partial",
    reason: "observation-incomplete",
  });
  const overflow = frame();
  for (const event of overflow.receipt.events) {
    if (event.data.kind === "decision")
      event.data.decision.sample = {
        kind: "unavailable",
        reason: "face-bound-exceeded",
      };
  }
  expect(consume(line(overflow))).toMatchObject({
    kind: "partial",
    reason: "observation-incomplete",
  });
  overflow.receipt.admission = {
    kind: "refused",
    reason: "unsupported-source",
  };
  expect(consume(line(overflow))).toMatchObject({
    kind: "refused",
    reason: "admission-refused",
  });
});

test("calibration stays outside canonical discovery and existing log and upload policies stay intact", async () => {
  const compatibility = await readFile(
    join(sourceRoot, "tests/Browser/compatibility.config.ts"),
    "utf8",
  );
  const shared = await readFile(
    join(sourceRoot, "tests/Browser/playwright.config.ts"),
    "utf8",
  );
  expect(compatibility).toContain('testMatch: "*.pw.ts"');
  expect(shared).toContain('testMatch: "*.spec.ts"');
  for (const setting of [
    'reporter: [["list"]]',
    "retries: 0",
    "workers: 1",
    'updateSnapshots: "none"',
    'trace: "off"',
    'video: "off"',
    'screenshot: "off"',
  ])
    expect(compatibility).toContain(setting);
  const workflow = await readFile(
    join(sourceRoot, ".github/workflows/browser-compatibility.yml"),
    "utf8",
  );
  expect(workflow.match(/retention-days: 7/g)).toHaveLength(2);
  expect(workflow).not.toContain("font-evidence");
  const scenario = await readFile(
    join(sourceRoot, "tests/Browser/compatibility.pw.ts"),
    "utf8",
  );
  for (const name of [
    "test-start",
    "initial-list-ready",
    "dialog-open",
    "creation-checkpoint-complete",
    "before-save-enter",
    "after-save-enter",
    "create-request",
    "create-response",
    "create-request-failed",
    "create-waiter-armed",
    "create-response-await-start",
    "create-response-await-complete",
    "create-json-complete",
    "saved-assertions-complete",
  ])
    expect(scenario).toContain(`"${name}"`);
});
