import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import {
  begin,
  finish,
  mark,
  preserveBeforeReload,
} from "./quiet-save-observer.mjs";
import {
  classify,
  fontFailureCategory,
  fontKinds,
} from "./quiet-save-schema.mjs";
import { readInstalledNunitoFile } from "./quiet-save-files.mjs";

test(
  "real font observer preserves ownership, privacy, refusal and listener cleanup",
  { timeout: 60000 },
  async () => {
    const root = resolve(".audit/quiet-save-font-tests/assets");
    await mkdir(root, { recursive: true });
    const paths = fontKinds.map(
      (kind) => `/assets/nunito-${kind}-wght-normal-00000000.woff2`,
    );
    for (const [index, kind] of fontKinds.entries())
      await writeFile(
        resolve(root, paths[index].split("/").at(-1)),
        await readInstalledNunitoFile(kind),
      );
    const latin = await readInstalledNunitoFile("latin");
    let requested = 0;
    const server = createServer((request, response) => {
      if (request.url.startsWith("/assets/")) {
        requested++;
        response.writeHead(200, {
          "content-type": "font/woff2",
          "access-control-allow-origin": "*",
          "x-canary": "privacy-canary-header",
        });
        response.end(latin);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<p>Fixed text</p><input aria-label='Name' value='privacy-canary-value'>",
      );
    });
    const remote = createServer((_request, response) => {
      requested++;
      response.writeHead(200, {
        "content-type": "font/woff2",
        "access-control-allow-origin": "*",
      });
      response.end(latin);
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    await new Promise((done) => remote.listen(0, "127.0.0.1", done));
    const oldPort = process.env.DAMADAMA_BROWSER_PORT;
    const oldSelfTest = process.env.QUIET_SELF_TEST;
    process.env.DAMADAMA_BROWSER_PORT = String(server.address().port);
    process.env.QUIET_SELF_TEST = "1";
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch();
    const capture = async (page, status = "failed") => {
      let value = null;
      await finish(page, {
        status,
        attach: async (name, data) => {
          if (name === "quiet-save-observation") value = JSON.parse(data.body);
        },
      });
      if (value)
        assert.equal(JSON.stringify(value).includes("privacy-canary"), false);
      return value;
    };
    const load = async (page, url) =>
      page.evaluate(async (url) => {
        const face = new FontFace("privacy-canary-family", `url("${url}")`);
        document.fonts.add(face);
        await face.load().catch(() => {});
      }, url);
    try {
      for (const value of [
        "net::ERR_ABORTED https://privacy-canary",
        "privacy-canary",
        " net::ERR_ABORTED",
        "net::ERR_CONNECTION_RESET\n",
      ])
        assert.equal(fontFailureCategory(value), "other");
      assert.equal(fontFailureCategory(undefined), "unknown");
      assert.equal(
        fontFailureCategory("net::ERR_CONNECTION_RESET"),
        "connection-reset",
      );
      const page = await browser.newPage();
      await begin(page);
      await page.goto(origin);
      assert.equal(
        (await page.evaluate(() => window.__quietSaveSnapshot())).font,
        null,
      );
      await load(page, origin + paths[0] + "?privacy-canary-query");
      await load(page, origin + "/assets/unrelated.woff2");
      await load(page, `http://127.0.0.1:${remote.address().port}` + paths[0]);
      await page.evaluate((url) => {
        const frame = document.createElement("iframe");
        frame.src = url;
        document.body.append(frame);
      }, origin);
      const frame = await page.waitForEvent(
        "framenavigated",
        (frame) => frame !== page.mainFrame(),
      );
      await load(frame, origin + paths[0]);
      assert.ok(requested >= 4);
      const privateReport = await capture(page);
      assert.equal(privateReport.font.transport.events.length, 0);
      assert.equal(privateReport.font.sample.snapshot.family.state, "missing");
      await page.close();

      const fragment = await browser.newPage();
      await begin(fragment);
      await fragment.goto(origin);
      await load(fragment, origin + paths[0] + "#privacy-canary-fragment");
      const normalized = await capture(fragment);
      assert.deepEqual(
        normalized.font.transport.events.map((event) => event.event),
        ["font-request", "font-response", "font-request-finished"],
      );
      assert.ok(
        normalized.font.transport.events.every(
          (event) => event.kind === "latin",
        ),
      );
      await fragment.close();

      for (const reason of [
        "net::ERR_ABORTED https://privacy-canary",
        undefined,
      ]) {
        const failedPage = await browser.newPage();
        failedPage.on("requestfailed", (request) => {
          request.failure = () => ({ errorText: reason });
        });
        await begin(failedPage);
        await failedPage.route("**/assets/*.woff2", (route) =>
          route.abort("aborted"),
        );
        await failedPage.goto(origin);
        await load(failedPage, origin + paths[0]);
        const value = await capture(failedPage);
        assert.equal(
          value.font.transport.events.at(-1).category,
          reason === undefined ? "unknown" : "other",
        );
        await failedPage.close();
      }

      const bounded = await browser.newPage();
      await begin(bounded);
      await bounded.goto(origin);
      await bounded.evaluate(() => {
        for (let index = 0; index < 33; index++)
          document.fonts.add(
            new FontFace(`privacy-canary-${index}`, 'url("/unused.woff2")'),
          );
      });
      for (const event of ["waiter-armed", "enter-sent", "enter-returned"])
        mark(bounded, event);
      mark(bounded, "response", { status: 201 });
      const overflow = await capture(bounded);
      assert.equal(overflow.font.sample.state, "face-bound-exceeded");
      assert.equal(classify(overflow), "response-observed");
      await bounded.close();

      const unreadable = await browser.newPage();
      await begin(unreadable);
      await unreadable.goto(origin);
      await unreadable.evaluate(() =>
        Object.defineProperty(document, "fonts", {
          get() {
            throw new Error("privacy-canary");
          },
        }),
      );
      const readFailure = await capture(unreadable);
      assert.equal(readFailure.refusal, "none");
      assert.equal(readFailure.font.sample.state, "read-failed");
      await unreadable.close();

      const closed = await browser.newPage();
      await begin(closed);
      await closed.goto(origin);
      await load(closed, origin + paths[0]);
      await closed.close();
      const missing = await capture(closed);
      assert.equal(missing.font.sample.state, "missing-page");
      assert.ok(
        missing.font.transport.events.some(
          (event) => event.event === "font-request-finished",
        ),
      );

      const changing = await browser.newPage();
      await begin(changing);
      await changing.goto(origin);
      const evaluate = changing.evaluate.bind(changing);
      changing.evaluate = async (...args) => {
        await changing.goto(origin);
        return evaluate(...args);
      };
      const changed = await capture(changing);
      assert.equal(changed.font.sample.state, "document-changed");
      await changing.close();

      const documents = await browser.newPage();
      await begin(documents);
      for (let index = 0; index < 5; index++) await documents.goto(origin);
      const manyDocuments = await capture(documents);
      assert.equal(manyDocuments.font.sample.state, "document-bound-exceeded");
      assert.equal(manyDocuments.font.transport.refusal, "overflow");
      await documents.close();

      const requests = await browser.newPage();
      await requests.route("**/*", (route) => route.continue());
      await begin(requests);
      for (let document = 0; document < 2; document++) {
        await requests.goto(origin);
        for (const path of paths) await load(requests, origin + path);
        await preserveBeforeReload(requests);
      }
      const manyRequests = await capture(requests);
      assert.equal(manyRequests.font.transport.refusal, "overflow");
      assert.ok(manyRequests.font.transport.events.length <= 32);
      assert.ok(Buffer.byteLength(JSON.stringify(manyRequests.font)) <= 4096);
      await requests.close();

      for (const status of ["passed", "skipped"]) {
        const passed = await browser.newPage();
        const before = passed.listenerCount("requestfinished");
        await begin(passed);
        await passed.goto(origin);
        for (let index = 0; index < 65; index++) mark(passed, "test-start");
        const result = await capture(passed, status);
        assert.equal(result.font, null);
        assert.equal(passed.listenerCount("requestfinished"), before);
        await passed.close();
      }
    } finally {
      await browser.close();
      for (const value of [server, remote]) {
        value.closeAllConnections();
        await new Promise((done) => value.close(done));
      }
      if (oldPort === undefined) delete process.env.DAMADAMA_BROWSER_PORT;
      else process.env.DAMADAMA_BROWSER_PORT = oldPort;
      if (oldSelfTest === undefined) delete process.env.QUIET_SELF_TEST;
      else process.env.QUIET_SELF_TEST = oldSelfTest;
    }
  },
);
