import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runReceiver } from "./receiver-cli.mjs";
import { observeRequestFailures } from "./receiver.mjs";
import {
  config,
  now,
  time,
  providerBody,
  runReceiverCommand,
  withProvider,
  assertPrivate,
} from "./receiver-fixtures.mjs";

test("the actual CLI process emits the formatter failures and exits nonzero", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../.audit/receiver-console-fixture.json", import.meta.url),
      "utf8",
    ),
  );
  const timestamp = new Date().toISOString();
  const records = fixture.lines.map((message) => ({
    timestamp,
    message,
    attributes: [],
  }));
  await withProvider(
    (reply) => {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify(providerBody(records)));
    },
    async (_fetchProvider, requests, localUrl) => {
      const { exit, stdout, attempts } = await runReceiverCommand(
        "node ops/diagnostics/receiver-cli.mjs",
        fileURLToPath(new URL("../../", import.meta.url)),
        {
          REQUEST_ERRORS_ENVIRONMENT: "staging",
          REQUEST_ERRORS_ENABLED_STAGING: "true",
          RAILWAY_PROJECT_ID: config.projectId,
          RAILWAY_ENVIRONMENT_ID: config.environmentId,
          RAILWAY_SERVICE_ID: config.serviceId,
          RAILWAY_LOG_READER_TOKEN_STAGING: config.token,
        },
        localUrl,
      );
      assert.equal(exit, 1);
      const lines = stdout.trim().split(/\r?\n/);
      assert.equal(lines.length, 4);
      for (const [index, event] of fixture.expected.entries()) {
        assert.equal(
          lines[index],
          `::error title=Staging request failure::revision=${event.revision} environment=staging route=${event.route} status=${event.status} trace=${event.traceId} classification=${event.classification} time=${timestamp}`,
        );
      }
      assert.equal(attempts, 1);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].headers["project-access-token"], config.token);
      assertPrivate(stdout);
    },
  );
});

test("actual ASP JSON console bytes reach safe annotations through real loopback HTTP", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../.audit/receiver-console-fixture.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    fixture.lines.length,
    3,
    "Generate the fixture with RequestReceiverFormatterTests first.",
  );
  for (const line of fixture.lines) {
    const event = JSON.parse(line);
    assert.deepEqual(Object.keys(event).sort(), [
      "Category",
      "EventId",
      "LogLevel",
      "Message",
      "State",
    ]);
    assert.deepEqual(Object.keys(event.State).sort(), [
      "Classification",
      "Environment",
      "Revision",
      "Route",
      "Status",
      "TraceId",
      "{OriginalFormat}",
    ]);
  }
  for (const representation of ["console-json", "string-attributes"]) {
    const records = fixture.lines.map((line) => {
      if (representation === "console-json")
        return {
          timestamp: time,
          message: line,
          attributes: [{ key: "level", value: "error" }],
        };
      const event = JSON.parse(line);
      return {
        timestamp: time,
        message: event.Message,
        attributes: Object.entries(event).map(([key, value]) => ({
          key,
          value: JSON.stringify(value),
        })),
      };
    });
    await withProvider(
      (reply) => {
        reply.writeHead(200, { "content-type": "application/json" });
        reply.end(JSON.stringify(providerBody(records)));
      },
      async (fetchProvider, requests) => {
        const observation = await observeRequestFailures(config, {
          now,
          fetch: fetchProvider,
        });
        assert.equal(observation.coverage.status, "observed");
        assert.deepEqual(
          observation.events,
          fixture.expected.map((event) => ({ timestamp: time, ...event })),
        );
        const lines = [];
        const exit = await runReceiver(
          config,
          { now, fetch: fetchProvider },
          (line) => lines.push(line),
        );
        assert.equal(exit, 1);
        for (const [index, event] of fixture.expected.entries()) {
          assert.equal(
            lines[index],
            `::error title=Staging request failure::revision=${event.revision} environment=staging route=${event.route} status=${event.status} trace=${event.traceId} classification=${event.classification} time=${time}`,
          );
        }
        assert.equal(lines.length, 4);
        assertPrivate(lines);
        assertPrivate(observation);
        assert.equal(requests.length, 2);
        for (const request of requests) {
          assert.equal(request.method, "POST");
          assert.equal(request.headers["project-access-token"], config.token);
          assert.equal(request.headers.authorization, undefined);
          assert.equal(request.headers["content-type"], "application/json");
          assert.deepEqual(request.body.variables, {
            projectId: config.projectId,
            environmentId: config.environmentId,
            serviceId: config.serviceId,
            filter: `@service:${config.serviceId}`,
            start: "2026-10-18T11:30:00.000Z",
            end: "2026-10-18T12:00:00.000Z",
          });
          assert.match(
            request.body.query,
            /projectToken\s*\{\s*projectId environmentId\s*\}/,
          );
          assert.match(
            request.body.query,
            /environment\(id: \$environmentId, projectId: \$projectId\)\s*\{ id projectId name \}/,
          );
          assert.match(
            request.body.query,
            /serviceInstance\(environmentId: \$environmentId, serviceId: \$serviceId\)\s*\{ environmentId serviceId \}/,
          );
          assert.match(
            request.body.query,
            /environmentLogs\(environmentId: \$environmentId, filter: \$filter, beforeDate: \$start, anchorDate: \$end, beforeLimit: 500, afterLimit: 0\)/,
          );
          assert.doesNotMatch(
            request.body.query,
            /mutation|deploymentLogs|afterDate|cursor/,
          );
          assert.equal(
            JSON.stringify(request.body).includes(config.token),
            false,
          );
        }
      },
    );
  }
});
