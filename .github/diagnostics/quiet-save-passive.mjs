import { test } from "@playwright/test";
import { performance } from "node:perf_hooks";
import {
  ownerSchema,
  caseNames,
  retainFailureMedia,
} from "./quiet-save-media.mjs";
import {
  complete,
  unverified,
  passiveAttachment,
} from "./quiet-save-schema.mjs";

const journals = new WeakMap();
let installed = false;

export function installPassiveSaveHooks() {
  if (installed) throw new Error("Passive save hooks already installed.");
  installed = true;
  test.beforeEach(async ({ page }, testInfo) => {
    const owner = ownerSchema.parse({
      control: process.env.QUIET_CONTROL,
      iteration: Number(process.env.QUIET_ITERATION),
      phase: process.env.QUIET_PHASE,
      project: testInfo.project.name,
      case: caseNames.indexOf(testInfo.title),
    });
    const base = new URL(testInfo.project.use.baseURL);
    const target = new URL("/api/habits", base).href;
    const start = performance.now();
    const installationWall = Date.now();
    const events = [];
    const requests = new Map();
    let refusal = null;
    let closed = false;
    const record = (request, event) => {
      if (closed || refusal) return;
      try {
        if (request.method() !== "POST" || request.url() !== target) return;
        if (request.frame() !== page.mainFrame()) return;
        let entry = requests.get(request);
        if (event.kind === "request") {
          if (entry) {
            refusal = "duplicate";
            return;
          }
          if (requests.size >= 4) {
            refusal = "overflow";
            return;
          }
          entry = { ordinal: requests.size + 1, terminal: false };
          requests.set(request, entry);
        } else {
          if (!entry) {
            refusal = "lifecycle-incomplete";
            return;
          }
          if (entry.terminal) {
            refusal = "duplicate";
            return;
          }
          entry.terminal = true;
        }
        if (events.length >= 12) {
          refusal = "overflow";
          return;
        }
        events.push({
          sequence: events.length + 1,
          requestOrdinal: entry.ordinal,
          at: performance.now() - start,
          wall: Date.now(),
          event,
        });
      } catch {
        refusal = "malformed";
      }
    };
    const listeners = {
      request: (request) => record(request, { kind: "request" }),
      response: (response) => {
        try {
          record(response.request(), {
            kind: "response",
            status: response.status(),
          });
        } catch {
          refusal = "malformed";
        }
      },
      requestfailed: (request) => record(request, { kind: "request-failed" }),
    };
    for (const [event, listener] of Object.entries(listeners))
      page.on(event, listener);
    journals.set(page, {
      started: installationWall,
      finish: () => {
        const end = { at: performance.now() - start, wall: Date.now() };
        closed = true;
        for (const [event, listener] of Object.entries(listeners))
          page.off(event, listener);
        return {
          schema: 1,
          owner,
          workerIndex: testInfo.workerIndex,
          journal: refusal
            ? unverified(refusal)
            : complete({ installationWall, end, events }),
        };
      },
    });
  });
  test.afterEach(async ({ page }, testInfo) => {
    const state = journals.get(page);
    journals.delete(page);
    const attachment = state?.finish();
    if (["passed", "skipped"].includes(testInfo.status)) return;
    if (!attachment) return;
    try {
      const bytes = Buffer.from(
        JSON.stringify(passiveAttachment.parse(attachment)),
      );
      if (bytes.length <= 8192)
        await testInfo.attach("quiet-save-passive", {
          body: bytes,
          contentType: "application/json",
        });
    } catch {
      return;
    }
    try {
      const manifest = await retainFailureMedia({
        owner: attachment.owner,
        outputDir: testInfo.outputDir,
        outputRoot: testInfo.project.outputDir,
        started: state.started,
        head: process.env.COMPAT_CURRENT_SHA,
        selfTest: process.env.QUIET_SELF_TEST === "1",
      });
      await testInfo.attach("quiet-save-media", {
        body: Buffer.from(JSON.stringify(manifest)),
        contentType: "application/json",
      });
    } catch {
      return;
    }
  });
}
