import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

export const config = {
  environment: "staging",
  projectId: "11111111-1111-4111-8111-111111111111",
  environmentId: "22222222-2222-4222-8222-222222222222",
  serviceId: "33333333-3333-4333-8333-333333333333",
  token: "private-reader-token-sentinel",
};
export const now = () => new Date("2026-10-18T12:00:00.000Z");
export const time = "2026-10-18T11:55:00.123456789Z";

export function consoleEvent(fields = {}) {
  const state = {
    Revision: "cb5888772b6150ceb083fdf84ac1572cba053336",
    Environment: "staging",
    Route: "/api/habits/{id:guid}/entries/{date}",
    Status: 500,
    TraceId: "request-ref_01:1",
    Classification: "unexpected",
    "{OriginalFormat}":
      "Request failure. Revision {Revision}, Environment {Environment}, Route {Route}, Status {Status}, TraceId {TraceId}, Classification {Classification}",
    ...fields,
  };
  return {
    EventId: 0,
    LogLevel: "Error",
    Category: "Damadama.RequestDiagnostics",
    Message: `Request failure. Revision ${state.Revision}, Environment ${state.Environment}, Route ${state.Route}, Status ${state.Status}, TraceId ${state.TraceId}, Classification ${state.Classification}`,
    State: state,
  };
}

export function record(event = consoleEvent()) {
  return { timestamp: time, message: JSON.stringify(event), attributes: [] };
}

export function providerBody(records = []) {
  return {
    data: {
      projectToken: {
        projectId: config.projectId,
        environmentId: config.environmentId,
      },
      environment: {
        id: config.environmentId,
        projectId: config.projectId,
        name: "staging",
      },
      serviceInstance: {
        environmentId: config.environmentId,
        serviceId: config.serviceId,
      },
      environmentLogs: records,
    },
  };
}

export function response(body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

export async function withProvider(handle, test) {
  const requests = [];
  const server = createServer(async (request, reply) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        method: request.method,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      handle(reply);
    } catch {
      reply.writeHead(500);
      reply.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const fetchProvider = (url, init) => {
    assert.equal(url, "https://backboard.railway.com/graphql/v2");
    assert.equal(init.redirect, "manual");
    return fetch(`http://127.0.0.1:${address.port}/graphql/v2`, init);
  };
  try {
    return await test(
      fetchProvider,
      requests,
      `http://127.0.0.1:${address.port}/graphql/v2`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function runReceiverCommand(command, root, environment, localUrl) {
  const preload = `
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Receiver conformance requires Node 24');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      process.send({ type: 'fetch-attempt' });
      if (url !== 'https://backboard.railway.com/graphql/v2' || init.redirect !== 'manual') throw new Error('Unexpected receiver transport');
      return originalFetch(${JSON.stringify(localUrl)}, init);
    };
  `;
  const child = spawn(
    "node",
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      ...command.split(" ").slice(1),
    ],
    {
      cwd: root,
      env: Object.fromEntries(
        Object.entries({
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ...environment,
        }).filter(([, value]) => value !== undefined),
      ),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      timeout: 15_000,
      shell: false,
    },
  );
  let stdout = "";
  let stderr = "";
  let attempts = 0;
  child.on("message", (message) => {
    assert.deepEqual(
      message,
      { type: "fetch-attempt" },
      "child transport counter protocol",
    );
    attempts++;
  });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const [exit, signal] = await once(child, "close");
  assert.equal(signal, null, "receiver child must terminate normally");
  assert.equal(stderr, "", "receiver stderr must be empty");
  assertPrivate(stdout);
  return { exit, stdout, attempts };
}

export function assertPrivate(value) {
  const rendered = JSON.stringify(value);
  for (const forbidden of [
    "private-",
    "29ca9d81-d50d-45a8-a04b-976ca30f8fc4",
    "2026-01-04",
    "InvalidOperationException",
    "DbUpdateException",
    config.projectId,
    config.environmentId,
    config.serviceId,
    "backboard.railway.com",
  ]) {
    assert.equal(
      rendered.includes(forbidden),
      false,
      "Observation must not expose private input or provider details.",
    );
  }
}
