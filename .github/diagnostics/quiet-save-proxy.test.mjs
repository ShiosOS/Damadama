import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import playwrightPackage from "@playwright/test/package.json" with { type: "json" };
import { preview, version as viteVersion } from "vite";

const expected = {
  id: "e093f739-49ea-4354-93d8-5755fb3ff196",
  name: "Walking",
  good: "5 minutes",
  better: "15 minutes",
  best: "30 minutes",
};
const body = JSON.stringify(expected);

for (const control of [
  { name: "partial JSON exposes POST 201 before body completion", bytes: 64 },
  { name: "backend headers alone do not prove browser receipt", bytes: 0 },
]) {
  test(control.name, { timeout: 5000 }, async (t) => {
    const nodeEnv = process.env.NODE_ENV;
    const written = Promise.withResolvers();
    const backend = createServer((request, response) => {
      request.resume();
      if (request.method !== "POST" || request.url !== "/api/habits") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(201, {
        "content-type": "application/json; charset=utf-8",
      });
      response.flushHeaders();
      if (control.bytes) {
        response.write(body.slice(0, control.bytes), () =>
          written.resolve(response),
        );
      } else {
        written.resolve(response);
      }
    });
    let server;
    let browser;
    let pending;
    try {
      await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
      server = await preview({
        configFile: "tests/Browser/compatibility.vite.config.ts",
        envFile: false,
        logLevel: "error",
        preview: {
          host: "127.0.0.1",
          port: 0,
          proxy: { "/api": `http://127.0.0.1:${backend.address().port}` },
        },
      });
      browser = await chromium.launch({ timeout: 2000 });
      t.diagnostic(
        `Node ${process.version}; Vite ${viteVersion}; Playwright ${playwrightPackage.version}; Chromium ${browser.version()}`,
      );
      const page = await browser.newPage();
      page.setDefaultTimeout(2000);
      await page.route("**/compatibility.html", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Synthetic POST probe</title>",
        }),
      );
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/compatibility.html`,
      );
      let received = false;
      const waiter = page
        .waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith("/api/habits"),
          { timeout: 2000 },
        )
        .then((response) => {
          received = true;
          return response;
        });
      void waiter.catch(() => {});
      await page.evaluate(() => {
        window.postProbe = { headers: false, body: false, status: null };
        void fetch("/api/habits", { method: "POST", body: "{}" })
          .then((response) => {
            window.postProbe.headers = true;
            window.postProbe.status = response.status;
            return response.json();
          })
          .then((value) => {
            window.postProbe.body = true;
            window.postProbe.value = value;
          });
      });
      pending = await Promise.race([
        written.promise,
        delay(2000, undefined, { ref: false }).then(() => {
          throw new Error("Backend did not write POST response headers.");
        }),
      ]);
      assert.equal(pending.headersSent, true);
      assert.equal(pending.writableFinished, false);
      if (control.bytes) {
        assert.equal((await waiter).status(), 201);
        await page.waitForFunction(() => window.postProbe.headers);
      } else {
        await delay(250);
      }
      const before = await page.evaluate(() => window.postProbe);
      if (control.bytes) {
        assert.equal(before.headers, true);
      } else {
        const observation = received ? "response201" : "pending";
        if (received) assert.equal((await waiter).status(), 201);
        if (before.headers) assert.equal(before.status, 201);
        t.diagnostic(`headersOnlyBeforeRelease=${observation}`);
      }
      assert.equal(before.body, false);
      pending.end(body.slice(control.bytes));
      const response = await waiter;
      assert.equal(response.status(), 201);
      assert.equal(await response.finished(), null);
      assert.deepEqual(await response.json(), expected);
      await page.waitForFunction(() => window.postProbe.body);
      assert.deepEqual(
        await page.evaluate(() => window.postProbe.value),
        expected,
      );
    } finally {
      pending?.destroy();
      server?.httpServer.closeAllConnections();
      backend.closeAllConnections();
      const cleanup = await Promise.allSettled([
        browser?.close(),
        server?.close(),
        new Promise((resolve) => backend.close(resolve)),
      ]);
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      for (const result of cleanup) assert.equal(result.status, "fulfilled");
      assert.equal(browser?.isConnected() ?? false, false);
      assert.equal(server?.httpServer.listening ?? false, false);
      assert.equal(backend.listening, false);
      t.diagnostic("Owned Chromium, Vite preview and HTTP backend closed.");
    }
  });
}
