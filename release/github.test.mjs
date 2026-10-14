import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { github } from "./github.mjs";

async function serve(t, handler, afterHeaders = () => {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    handler(request, response, requests.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).origin, "https://api.github.com");
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${new URL(url).pathname}`,
      options,
    );
    afterHeaders();
    return response;
  });
  return requests;
}

test("GET recovers when the first connection closes before a response", async (t) => {
  const requests = await serve(t, (request, response, attempt) => {
    if (attempt === 1) return request.socket.destroy();
    response.end('{"id":42,"state":"approved"}');
  });

  const record = await github("approval", { token: "test-only" }).catch(
    (error) => {
      t.diagnostic(
        `${error.name}: ${error.message}; cause ${error.cause?.code}: ${error.cause?.message}`,
      );
      throw error;
    },
  );
  assert.deepEqual(record, {
    id: 42,
    state: "approved",
  });
  assert.deepEqual(requests, [
    { method: "GET", url: "/approval" },
    { method: "GET", url: "/approval" },
  ]);
});

test("GET recovers when the JSON response body is interrupted", async (t) => {
  let interruptedResponse;
  const requests = await serve(
    t,
    (request, response, attempt) => {
      if (attempt === 1) {
        interruptedResponse = response;
        response.writeHead(200, { "Content-Length": "100" });
        response.write('{"id":');
        return;
      }
      response.end('{"id":42,"state":"approved"}');
    },
    () => interruptedResponse?.destroy(),
  );

  assert.deepEqual(await github("approval", { token: "test-only" }), {
    id: 42,
    state: "approved",
  });
  assert.equal(requests.length, 2);
});

test("GET refuses after three interrupted connections", async (t) => {
  const requests = await serve(t, (request) => request.socket.destroy());

  await assert.rejects(github("approval", { token: "test-only" }), (error) => {
    assert.equal(error.name, "TypeError");
    assert.equal(error.cause?.code, "UND_ERR_SOCKET");
    return true;
  });
  assert.equal(requests.length, 3);
});

test("POST refuses an interrupted connection without retrying", async (t) => {
  const requests = await serve(t, (request) => request.socket.destroy());

  await assert.rejects(
    github("approval", {
      method: "POST",
      body: { approved: true },
      token: "test-only",
    }),
    (error) => {
      assert.equal(error.name, "TypeError");
      assert.equal(error.cause?.code, "UND_ERR_SOCKET");
      return true;
    },
  );
  assert.deepEqual(requests, [{ method: "POST", url: "/approval" }]);
});

test("GET refuses HTTP 403 without retrying", async (t) => {
  const requests = await serve(t, (request, response) => {
    response.writeHead(403);
    response.end('{"message":"Forbidden"}');
  });

  await assert.rejects(github("approval", { token: "test-only" }), {
    message: "GitHub GET approval returned 403",
  });
  assert.equal(requests.length, 1);
});

test("GET refuses malformed JSON without retrying", async (t) => {
  const requests = await serve(t, (request, response) =>
    response.end('{"id":'),
  );

  await assert.rejects(github("approval", { token: "test-only" }), SyntaxError);
  assert.equal(requests.length, 1);
});
