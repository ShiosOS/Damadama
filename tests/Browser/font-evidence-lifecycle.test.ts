import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { sourceRoot } from "./font-evidence-admission";
import {
  contextSchema,
  frameSchema,
  prefix,
  subset,
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
test.each(["timedOut", "failed", "passed", "skipped", "closed"])(
  "pending admission cannot attach after %s",
  (status) => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
    import { EventEmitter } from 'node:events';
    import assert from 'node:assert/strict';
    import { mock } from 'bun:test';
    const context = JSON.parse(process.env.COMPAT_FONT_CONTEXT);
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    mock.module('./tests/Browser/font-evidence-admission', () => ({ prepareAdmission: () => pending, fontSelection: () => () => null }));
    const { beginFontEvidence, finishFontEvidence } = await import('./tests/Browser/font-evidence');
    const page = new EventEmitter();
    let closed = false;
    page.isClosed = () => closed;
    const unrelated = () => {};
    page.on('close', unrelated);
    const status = process.env.LIFECYCLE_STATUS;
    const info = { title: 'healthy', project: { name: 'chromium-desktop' }, retry: 0, repeatEachIndex: 0, status: status === 'closed' ? 'failed' : status };
    const frames = [];
    const output = console.info;
    console.info = line => { frames.push(line); output(line); };
    const beginning = beginFontEvidence(page, info);
    if (status !== 'closed') finishFontEvidence(page, info);
    const sealed = [...frames];
    closed = true;
    page.emit('close');
    release(context.admission);
    await beginning;
    assert.deepEqual(page.eventNames(), ['close']);
    assert.deepEqual(page.listeners('close'), [unrelated]);
    assert.deepEqual(frames, sealed);
    finishFontEvidence(page, info);
    finishFontEvidence(page, info);
    console.log('lifecycle-result ' + JSON.stringify({ listeners: page.eventNames().map(event => [event, page.listenerCount(event)]), unrelated: page.listeners('close').includes(unrelated) }));
  `,
      ],
      {
        cwd: sourceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          COMPAT_FONT_CONTEXT: JSON.stringify(context),
          LIFECYCLE_STATUS: status,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'lifecycle-result {"listeners":[["close",1]],"unrelated":true}',
    );
    const frames = result.stdout
      .split(/\r?\n/)
      .filter((text) => text.startsWith(prefix));
    if (status === "passed" || status === "skipped") {
      expect(frames).toHaveLength(0);
      return;
    }
    expect(frames).toHaveLength(1);
    const value: unknown = JSON.parse((frames[0] ?? "").slice(prefix.length));
    const final = frameSchema.parse(value);
    expect(final.receipt.admission).toEqual({
      kind: "refused",
      reason: "admission-incomplete",
    });
    expect(final.receipt.lifecycle).toEqual({
      kind: "disposed",
      detached: true,
      status: status === "closed" ? "failed" : status,
    });
  },
);
