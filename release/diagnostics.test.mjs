import assert from "node:assert/strict";
import { test } from "node:test";
import { observePhase } from "./diagnostics.mjs";

function capture(t) {
  const lines = [];
  t.mock.method(console, "error", (...args) => {
    assert.equal(args.length, 1);
    assert.equal(typeof args[0], "string");
    lines.push(args[0]);
  });
  return {
    lines,
    markers: () =>
      lines.map((line) => {
        assert.ok(line.startsWith("release-phase "));
        const marker = JSON.parse(line.slice("release-phase ".length));
        assert.deepEqual(Object.keys(marker).sort(), [
          "elapsedMs",
          "event",
          "invocation",
          "phase",
        ]);
        assert.ok(Number.isSafeInteger(marker.invocation));
        assert.ok(Number.isFinite(marker.elapsedMs) && marker.elapsedMs >= 0);
        return marker;
      }),
  };
}

test("a pending phase exposes its start before calling the action and preserves the returned value", async (t) => {
  const log = capture(t);
  let wallClock = 10_000;
  t.mock.method(Date, "now", () => wallClock);
  const result = { secret: "private-result-content" };
  let finish;
  const pending = observePhase("stage.release.locate", () => {
    assert.equal(log.lines.length, 1);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const [start] = log.markers();
  assert.deepEqual(start, {
    phase: "stage.release.locate",
    invocation: start.invocation,
    event: "start",
    elapsedMs: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(log.lines.length, 1);
  wallClock = 1;
  finish(result);
  assert.equal(await pending, result);
  const markers = log.markers();
  assert.equal(markers.length, 2);
  assert.equal(markers[1].invocation, start.invocation);
  assert.equal(markers[1].event, "complete");
  assert.equal(markers[1].phase, start.phase);
  assert.doesNotMatch(log.lines.join("\n"), /private-result-content/);
});

test("failed phases never inspect thrown values and rethrow each exact value", async (t) => {
  const log = capture(t);
  const secret = "private-token-in-error-url-body-and-cause";
  const error = Object.assign(new Error(secret, { cause: { token: secret } }), {
    url: `https://example.invalid/${secret}`,
    response: { body: secret },
    toJSON() {
      throw new Error("thrown values must not be serialized");
    },
  });
  for (const value of [error, secret, null, undefined]) {
    let caught = false;
    try {
      await observePhase("supply.registry.compare", () => {
        throw value;
      });
    } catch (actual) {
      caught = true;
      assert.equal(actual, value);
    }
    assert.equal(caught, true);
  }
  const markers = log.markers();
  assert.equal(markers.length, 8);
  for (let index = 0; index < markers.length; index += 2) {
    assert.equal(markers[index].event, "start");
    assert.equal(markers[index + 1].event, "failed");
    assert.equal(markers[index + 1].invocation, markers[index].invocation);
    assert.equal(markers[index + 1].phase, "supply.registry.compare");
  }
  assert.equal(new Set(markers.map((marker) => marker.invocation)).size, 4);
  assert.doesNotMatch(log.lines.join("\n"), new RegExp(secret));
});

test("unknown phase data is refused without logging it or invoking the action", async (t) => {
  const log = capture(t);
  let called = false;
  for (const phase of [
    "private-dynamic-phase",
    { toString: () => "private-object-phase" },
  ])
    await assert.rejects(
      observePhase(phase, () => {
        called = true;
      }),
      /^Error: unknown release diagnostic phase$/,
    );
  assert.equal(called, false);
  assert.deepEqual(log.lines, []);
});

test("an unavailable diagnostic sink preserves successful values and original refusals", async (t) => {
  t.mock.method(console, "error", () => {
    throw new Error("diagnostic sink unavailable");
  });
  const result = {};
  assert.equal(
    await observePhase("stage.release.locate", () => result),
    result,
  );
  const failure = new Error("original admission refused");
  await assert.rejects(
    observePhase("stage.release.recheck", () => {
      throw failure;
    }),
    (actual) => actual === failure,
  );
});
