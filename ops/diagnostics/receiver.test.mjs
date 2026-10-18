import assert from "node:assert/strict";
import test from "node:test";
import { observeRequestFailures } from "./receiver.mjs";
import { runReceiver } from "./receiver-cli.mjs";
import {
  config,
  now,
  time,
  consoleEvent,
  record,
  providerBody,
  response,
  withProvider,
  assertPrivate,
} from "./receiver-fixtures.mjs";

async function observe(body) {
  return observeRequestFailures(config, {
    now,
    fetch: async () => response(body),
  });
}

async function output(body, overrides = {}) {
  const lines = [];
  const exit = await runReceiver(
    config,
    { now, fetch: async () => response(body), ...overrides },
    (line) => lines.push(line),
  );
  assertPrivate(lines);
  return { exit, lines };
}

test("explicit library observations ignore ambient CLI activation", async () => {
  const original = process.env.REQUEST_ERRORS_ENABLED_STAGING;
  try {
    for (const raw of ["", "false", "true", "private-invalid-activation"]) {
      process.env.REQUEST_ERRORS_ENABLED_STAGING = raw;
      let requests = 0;
      const dependencies = {
        now,
        fetch: async () => {
          requests++;
          return response(providerBody([record()]));
        },
      };
      const observation = await observeRequestFailures(config, dependencies);
      assert.equal(observation.coverage.status, "observed");
      assert.equal(observation.events.length, 1);
      const lines = [];
      assert.equal(
        await runReceiver(config, dependencies, (line) => lines.push(line)),
        1,
      );
      assert.equal(requests, 2);
      assert.equal(lines.length, 2);
      assertPrivate(lines);
    }
  } finally {
    if (original === undefined)
      delete process.env.REQUEST_ERRORS_ENABLED_STAGING;
    else process.env.REQUEST_ERRORS_ENABLED_STAGING = original;
  }
});

test("empty observed interval reports only the accepted window and does not assert health", async () => {
  const result = await output(providerBody());
  assert.equal(result.exit, 0);
  assert.deepEqual(result.lines, [
    "Observed window 2026-10-18T11:30:00.000Z through 2026-10-18T12:00:00.000Z; accepted failures=0. This observation does not establish application health.",
  ]);
});

test("unexpected, storage, readiness and deployment transitions survive the same environment query", async () => {
  const result = await observe(
    providerBody([
      record(),
      record(
        consoleEvent({
          Revision: "b".repeat(40),
          Status: 503,
          Classification: "storage-unavailable",
          TraceId: "next-deployment",
          Route: "/api/habits",
        }),
      ),
      record(
        consoleEvent({
          Revision: "unavailable",
          Status: 503,
          Classification: "readiness-unavailable",
          TraceId: "readiness",
          Route: "/health/ready",
        }),
      ),
    ]),
  );
  assert.equal(result.coverage.status, "observed");
  assert.deepEqual(
    result.events.map((event) => [
      event.revision,
      event.status,
      event.classification,
    ]),
    [
      ["cb5888772b6150ceb083fdf84ac1572cba053336", 500, "unexpected"],
      ["b".repeat(40), 503, "storage-unavailable"],
      ["unavailable", 503, "readiness-unavailable"],
    ],
  );
  assertPrivate(result);
});

test("fresh safe events are deduplicated within the window", async () => {
  const item = record();
  const body = providerBody([
    item,
    structuredClone(item),
    { ...item, timestamp: "2026-10-18T11:55:01Z" },
  ]);
  const result = await observe(body);
  assert.equal(result.events.length, 1);
  assert.deepEqual(Object.keys(result.events[0]), [
    "timestamp",
    "revision",
    "environment",
    "route",
    "status",
    "traceId",
    "classification",
  ]);
  const cli = await output(body);
  assert.equal(cli.exit, 1);
  assert.equal(
    cli.lines.filter((line) =>
      line.startsWith("::error title=Staging request failure::"),
    ).length,
    1,
  );
});

test("string attributes use the pinned CLI coercion and the exact formatter root", async () => {
  const event = consoleEvent();
  const attributes = Object.entries(event).map(([key, value]) => ({
    key,
    value: JSON.stringify(value),
  }));
  attributes.push({ key: "level", value: '"error"' });
  const actual = await observe(
    providerBody([{ timestamp: time, message: event.Message, attributes }]),
  );
  assert.equal(actual.coverage.status, "observed");
  assert.equal(actual.events[0].traceId, "request-ref_01:1");
  const original = await observe(providerBody([record()]));
  assert.deepEqual(actual.events, original.events);
});

test("valid failure survives malformed neighboring event and still gets an annotation", async () => {
  const body = providerBody([
    record(),
    record({ ...consoleEvent(), Exception: "private-exception-sentinel" }),
  ]);
  const actual = await observe(body);
  assert.equal(actual.events.length, 1);
  assert.deepEqual(actual.coverage, {
    status: "unavailable",
    reason: "invalid-event",
  });
  const cli = await output(body);
  assert.equal(cli.exit, 2);
  assert.match(
    cli.lines[0],
    /status=500 trace=request-ref_01:1 classification=unexpected/,
  );
  assert.equal(
    cli.lines[1],
    "::error title=Request error visibility::status=unavailable reason=invalid-event",
  );
});

const invalidStates = [
  ["environment", { Environment: "production" }],
  ["unknown environment", { Environment: "unavailable" }],
  ["status pair", { Status: 503 }],
  ["string status", { Status: "500" }],
  ["classification", { Classification: "private-classification" }],
  ["revision", { Revision: "B".repeat(40) }],
  ["short revision", { Revision: "abc" }],
  ["nonhex revision", { Revision: "g".repeat(40) }],
  ["trace newline", { TraceId: "private-trace\n::error::injection" }],
  ["trace path", { TraceId: "private/trace" }],
  ["trace unicode", { TraceId: "é" }],
  ["trace empty", { TraceId: "" }],
  ["trace long", { TraceId: "a".repeat(129) }],
  [
    "concrete route",
    {
      Route:
        "/api/habits/29ca9d81-d50d-45a8-a04b-976ca30f8fc4/entries/2026-01-04",
    },
  ],
  ["unregistered template", { Route: "/api/private/{id}" }],
  ["query route", { Route: "/api/habits?private-query=1" }],
  ["extra state", { Owner: "private-account-sentinel" }],
  ["formatter state message drift", { Message: "private-message" }],
  ["template", { "{OriginalFormat}": "private-template" }],
];
for (const [name, fields] of invalidStates) {
  test(`rejects ${name} without printing input`, async () => {
    const result = await output(providerBody([record(consoleEvent(fields))]));
    assert.equal(result.exit, 2);
    assert.deepEqual(result.lines, [
      "::error title=Request error visibility::status=unavailable reason=invalid-event",
    ]);
  });
}

for (const [name, change] of [
  [
    "private root",
    (event) => {
      event.Exception = "private-exception";
    },
  ],
  [
    "event id",
    (event) => {
      event.EventId = 9;
    },
  ],
  [
    "level",
    (event) => {
      event.LogLevel = "Information";
    },
  ],
  [
    "unknown diagnostic category",
    (event) => {
      event.Category += ".Unsafe";
    },
  ],
  [
    "expanded message",
    (event) => {
      event.Message = "private-message";
    },
  ],
  [
    "missing state",
    (event) => {
      delete event.State;
    },
  ],
]) {
  test(`rejects ${name}`, async () => {
    const event = consoleEvent();
    change(event);
    const result = await output(providerBody([record(event)]));
    assert.equal(result.exit, 2);
    assert.match(result.lines[0], /reason=invalid-event$/);
  });
}

test("accepts explicit unavailable route and trace length boundaries", async () => {
  const actual = await observe(
    providerBody([
      record(consoleEvent({ Route: "unavailable", TraceId: "a" })),
      record(consoleEvent({ TraceId: "b".repeat(128) })),
    ]),
  );
  assert.equal(actual.coverage.status, "observed");
  assert.equal(actual.events.length, 2);
});

test("malformed diagnostic JSON and conflicting attribute representations fail visibility", async () => {
  for (const item of [
    {
      ...record(),
      message: '{"Category":"Damadama.RequestDiagnostics",private-',
    },
    {
      ...record(),
      attributes: [
        { key: "State", value: JSON.stringify(consoleEvent().State) },
      ],
    },
    { ...record(), attributes: [{ key: "level", value: "info" }] },
  ]) {
    const actual = await output(providerBody([item]));
    assert.equal(actual.exit, 2);
    assert.match(
      actual.lines[0],
      /reason=(?:invalid-event|conflicting-event)$/,
    );
  }
});

test("unrelated private log text is ignored without copying it", async () => {
  const actual = await output(
    providerBody([
      {
        timestamp: time,
        message: "private-body-token-account-habit",
        attributes: [],
      },
    ]),
  );
  assert.equal(actual.exit, 0);
});

for (const [name, change] of [
  [
    "missing token metadata",
    (data) => {
      delete data.projectToken;
    },
  ],
  [
    "wrong token project",
    (data) => {
      data.projectToken.projectId = config.serviceId;
    },
  ],
  [
    "unscoped token",
    (data) => {
      data.projectToken.environmentId = null;
    },
  ],
  [
    "wrong token environment",
    (data) => {
      data.projectToken.environmentId = config.projectId;
    },
  ],
  [
    "missing environment",
    (data) => {
      data.environment = null;
    },
  ],
  [
    "wrong environment id",
    (data) => {
      data.environment.id = config.serviceId;
    },
  ],
  [
    "wrong environment project",
    (data) => {
      data.environment.projectId = config.serviceId;
    },
  ],
  [
    "wrong environment name",
    (data) => {
      data.environment.name = "production";
    },
  ],
  [
    "missing service instance",
    (data) => {
      data.serviceInstance = null;
    },
  ],
  [
    "wrong service",
    (data) => {
      data.serviceInstance.serviceId = config.projectId;
    },
  ],
  [
    "wrong service environment",
    (data) => {
      data.serviceInstance.environmentId = config.projectId;
    },
  ],
]) {
  test(`refuses ${name} before trusting either empty or failure records`, async () => {
    for (const records of [[], [record()]]) {
      const body = providerBody(records);
      change(body.data);
      const result = await observe(body);
      assert.deepEqual(result.events, []);
      assert.deepEqual(result.coverage, {
        status: "refused",
        reason: "scope-mismatch",
      });
      assertPrivate(result);
    }
  });
}

test("partial GraphQL errors preserve independently scoped failures and fail coverage", async () => {
  const body = providerBody([record()]);
  body.errors = [{ message: "private-provider-error-token" }];
  const actual = await output(body);
  assert.equal(actual.exit, 2);
  assert.equal(actual.lines.length, 2);
  assert.match(actual.lines[1], /reason=provider-errors$/);
});

test("missing logs and invalid response schema are not empty success", async () => {
  for (const body of [
    null,
    {},
    { data: null },
    {
      ...providerBody(),
      data: { ...providerBody().data, environmentLogs: null },
    },
  ]) {
    const result = await output(body);
    assert.equal(result.exit, 2);
    assert.equal(result.lines.length, 1);
  }
});

for (const invalid of [
  "2026-02-30T11:55:00Z",
  "2026-10-18T24:00:00Z",
  "2026-10-18T11:60:00Z",
  "2026-10-18T11:55:60Z",
  "2026-10-18T11:55:00-00:00",
  "2026-10-18T11:55:00+24:00",
  "2026-10-18T11:55:00.1234567890Z",
  "2026-10-18",
  "private-time",
  "2026-10-18T11:29:59.999999999Z",
  "2026-10-18T12:00:00.000000001Z",
]) {
  test(`rejects invalid or out-of-window timestamp ${invalid}`, async () => {
    const result = await output(
      providerBody([{ ...record(), timestamp: invalid }]),
    );
    assert.equal(result.exit, 2);
    assert.match(result.lines[0], /reason=invalid-timestamp$/);
  });
}

test("RFC3339 offsets, nanoseconds, and exact window endpoints are accepted", async () => {
  for (const value of [
    "2026-10-18T11:30:00Z",
    "2026-10-18T12:00:00.000000000Z",
    time,
    "2026-10-18T07:55:00.1234567-04:00",
  ]) {
    const result = await observe(
      providerBody([{ ...record(), timestamp: value }]),
    );
    assert.equal(result.coverage.status, "observed");
    assert.equal(result.events[0].timestamp, value);
  }
});

test("provider count cap fails at exactly 500 and keeps accepted events", async () => {
  const below = await observe(
    providerBody(Array.from({ length: 499 }, () => record())),
  );
  assert.equal(below.coverage.status, "observed");
  for (const count of [500, 501]) {
    const result = await observe(
      providerBody(Array.from({ length: count }, () => record())),
    );
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.coverage, {
      status: "unavailable",
      reason: "record-limit",
    });
  }
});

test("event and annotation counts are bounded with explicit visibility loss", async () => {
  for (const count of [100, 101]) {
    const body = providerBody(
      Array.from({ length: count }, (_, index) =>
        record(consoleEvent({ TraceId: `request-${index}` })),
      ),
    );
    const result = await output(body);
    assert.equal(result.lines.length, 101);
    assert.equal(result.exit, count === 100 ? 1 : 2);
    assert.ok(result.lines.every((line) => line.length < 600));
    if (count === 101) assert.match(result.lines.at(-1), /reason=event-limit$/);
  }
});

test("message, attribute count, key and value byte limits have enforced boundaries", async () => {
  const plain = {
    timestamp: time,
    message: "private-nondiagnostic",
    attributes: [],
  };
  for (const [accepted, rejected] of [
    [
      { ...plain, message: "x".repeat(8192) },
      { ...plain, message: "x".repeat(8193) },
    ],
    [
      {
        ...plain,
        attributes: Array.from({ length: 32 }, (_, i) => ({
          key: `key${i}`,
          value: "x",
        })),
      },
      {
        ...plain,
        attributes: Array.from({ length: 33 }, (_, i) => ({
          key: `key${i}`,
          value: "x",
        })),
      },
    ],
    [
      { ...plain, attributes: [{ key: "x".repeat(128), value: "x" }] },
      { ...plain, attributes: [{ key: "x".repeat(129), value: "x" }] },
    ],
    [
      { ...plain, attributes: [{ key: "key", value: "x".repeat(8192) }] },
      { ...plain, attributes: [{ key: "key", value: "x".repeat(8193) }] },
    ],
  ]) {
    assert.equal((await output(providerBody([accepted]))).exit, 0);
    const result = await output(providerBody([rejected]));
    assert.equal(result.exit, 2);
    assert.match(result.lines[0], /reason=invalid-record$/);
  }
});

test("malformed attributes and duplicate keys fail coverage", async () => {
  for (const attributes of [
    null,
    [{ key: "level", value: 1 }],
    [
      { key: "level", value: "error" },
      { key: "level", value: "error" },
    ],
  ]) {
    const result = await output(providerBody([{ ...record(), attributes }]));
    assert.equal(result.exit, 2);
    assert.match(result.lines[0], /reason=invalid-record$/);
  }
});

test("body cap applies to streamed bytes with and without Content-Length", async () => {
  const json = JSON.stringify(providerBody());
  for (const length of [1_048_576, 1_048_577]) {
    const bytes = json.padEnd(length, " ");
    const result = await output(null, {
      fetch: async () =>
        new Response(bytes, {
          headers: { "content-type": "application/json" },
        }),
    });
    assert.equal(result.exit, length === 1_048_576 ? 0 : 2);
    if (length > 1_048_576) assert.match(result.lines[0], /reason=body-limit$/);
  }
  const result = await output(null, {
    fetch: async () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "1048577",
        },
      }),
  });
  assert.match(result.lines[0], /reason=body-limit$/);
});

test("malformed UTF8, JSON and non-JSON content fail without raw error text", async () => {
  for (const body of [new Uint8Array([0xff, 0xfe]), "private-malformed-json"]) {
    const result = await output(null, {
      fetch: async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    });
    assert.equal(result.exit, 2);
    assert.match(result.lines[0], /reason=invalid-response$/);
  }
  const result = await output(null, {
    fetch: async () => new Response("private-html"),
  });
  assert.match(result.lines[0], /reason=invalid-response$/);
});

for (const [status, reason] of [
  [401, "provider-refused"],
  [403, "provider-refused"],
  [302, "redirect"],
  [500, "http-error"],
]) {
  test(`real HTTP ${status} is rejected without following redirects or echoing response`, async () => {
    await withProvider(
      (reply) => {
        reply.writeHead(status, {
          location: "http://private-host.invalid",
          "content-type": "application/json",
        });
        reply.end("private-provider-error");
      },
      async (fetchProvider, requests) => {
        const result = await output(null, { fetch: fetchProvider });
        assert.equal(result.exit, 2);
        assert.match(result.lines[0], new RegExp(`reason=${reason}$`));
        assert.equal(requests.length, 1);
      },
    );
  });
}

test("network faults never expose exception text", async () => {
  const result = await output(null, {
    fetch: async () => {
      throw new Error("private-network-token");
    },
  });
  assert.equal(result.exit, 2);
  assert.match(result.lines[0], /reason=network-failure$/);
});

test(
  "whole request deadline bounds a real HTTP body that never finishes",
  { timeout: 15_000 },
  async () => {
    await withProvider(
      (reply) => {
        reply.writeHead(200, { "content-type": "application/json" });
        reply.write('{"data":');
      },
      async (fetchProvider) => {
        const result = await output(null, { fetch: fetchProvider });
        assert.equal(result.exit, 2);
        assert.match(result.lines[0], /reason=deadline$/);
      },
    );
  },
);

test("deadline also bounds a fetch which ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = output(null, { fetch: () => new Promise(() => {}) });
  t.mock.timers.tick(10_000);
  const result = await running;
  assert.equal(result.exit, 2);
  assert.match(result.lines[0], /reason=deadline$/);
});

test("production and invalid configuration perform no network request", async () => {
  for (const configuration of [
    { ...config, environment: "production" },
    { ...config, token: "" },
    { ...config, serviceId: "private-service" },
    { ...config, environment: "unavailable" },
  ]) {
    let requests = 0;
    const lines = [];
    const exit = await runReceiver(
      configuration,
      {
        now,
        fetch: async () => {
          requests++;
          throw new Error("must not fetch");
        },
      },
      (line) => lines.push(line),
    );
    assert.equal(requests, 0);
    assert.equal(exit, 2);
    assert.match(lines[0], /reason=(?:production-disabled|invalid-config)$/);
    assertPrivate(lines);
  }
});
