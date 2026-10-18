import { createServer } from "node:http";
import { expect, test } from "@playwright/test";

const legacyNavigationCacheWorker = `
self.addEventListener("install", event => event.waitUntil(
  caches.open("legacy-shell").then(cache => cache.add("/"))
));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (event.request.mode === "navigate") event.respondWith(caches.match("/"));
});
`;

test("staging worker retires a cached shell without changing open drafts or stored records", async ({
  browser,
  request,
}) => {
  let phase: "legacy" | "missing" | "retirement" = "legacy";
  let retirementBytes: Buffer = Buffer.alloc(0);
  const server = createServer((incoming, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (incoming.url === "/sw.js") {
      response.setHeader("Content-Type", "application/javascript");
      if (phase === "missing") {
        response.writeHead(404).end();
      } else if (phase === "legacy") {
        response.end(legacyNavigationCacheWorker);
      } else {
        response.end(retirementBytes);
      }
      return;
    }
    const title = phase === "legacy" ? "Legacy journal" : "Damadama rewrite";
    response.setHeader("Content-Type", "text/html");
    response.end(`<title>${title}</title><input aria-label="Unsaved draft">`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect(page).toHaveTitle("Legacy journal");
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
    ).toBe(`${origin}/sw.js`);
    const draft = await context.newPage();
    await draft.goto(`${origin}/draft`);
    await draft.getByRole("textbox").fill("Do not lose this draft");
    await draft.evaluate(async () => {
      localStorage.setItem("legacy-settings", "keep-settings");
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open("legacy-data", 1);
        open.onupgradeneeded = (): void => {
          open.result.createObjectStore("pending", { keyPath: "id" });
        };
        open.onsuccess = (): void => resolve(open.result);
        open.onerror = (): void =>
          reject(open.error ?? new Error("Could not open legacy data"));
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("pending", "readwrite");
        transaction
          .objectStore("pending")
          .put({ id: "one", owner: "account-one", draft: "first pending" });
        transaction
          .objectStore("pending")
          .put({ id: "two", owner: "account-two", draft: "second pending" });
        transaction.oncomplete = (): void => resolve();
        transaction.onerror = (): void =>
          reject(
            transaction.error ?? new Error("Could not store pending data"),
          );
      });
      database.close();
      await (
        await caches.open("unrelated-data")
      ).put("/sentinel", new Response("keep-cache"));
    });
    const readStorage: () => Promise<{
      settings: string | null;
      pending: unknown;
      caches: string[];
      shell: string | undefined;
      sentinel: string | undefined;
    }> = () =>
      draft.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open("legacy-data");
          open.onsuccess = (): void => resolve(open.result);
          open.onerror = (): void =>
            reject(open.error ?? new Error("Could not open legacy data"));
        });
        const pending = await new Promise<unknown>((resolve, reject) => {
          const read = database
            .transaction("pending")
            .objectStore("pending")
            .getAll();
          read.onsuccess = (): void => resolve(read.result);
          read.onerror = (): void =>
            reject(read.error ?? new Error("Could not read pending data"));
        });
        database.close();
        return {
          settings: localStorage.getItem("legacy-settings"),
          pending,
          caches: (await caches.keys()).sort(),
          shell: await (await caches.match("/"))?.text(),
          sentinel: await (await caches.match("/sentinel"))?.text(),
        };
      });
    const stored = await readStorage();
    expect(stored.settings).toBe("keep-settings");
    expect(stored.sentinel).toBe("keep-cache");
    expect(stored.pending).toEqual([
      { id: "one", owner: "account-one", draft: "first pending" },
      { id: "two", owner: "account-two", draft: "second pending" },
    ]);
    let draftNavigations = 0;
    draft.on("framenavigated", () => draftNavigations++);
    phase = "missing";
    expect(await (await request.get(origin)).text()).toContain(
      "Damadama rewrite",
    );
    const failedUpdate = await page.evaluate(async () => {
      try {
        await (await navigator.serviceWorker.getRegistration())?.update();
        return "unexpected success";
      } catch (error) {
        return String(error);
      }
    });
    expect(failedUpdate).toContain("404");
    await page.reload();
    await expect(page).toHaveTitle("Legacy journal");

    const endpoint = await request.get("http://localhost:5055/sw.js", {
      headers: { Host: "staging.damadama.app" },
    });
    expect(endpoint.status()).toBe(200);
    expect(endpoint.headers()["content-type"]).toContain(
      "application/javascript",
    );
    expect(endpoint.headers()["cache-control"]).toContain("no-store");
    retirementBytes = await endpoint.body();
    phase = "retirement";
    expect(await (await request.get(`${origin}/sw.js`)).body()).toEqual(
      retirementBytes,
    );
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error("Missing legacy registration");
      const activated = new Promise<void>((resolve) => {
        registration.addEventListener(
          "updatefound",
          () => {
            const worker = registration.installing;
            if (!worker) throw new Error("Missing replacement worker");
            worker.addEventListener("statechange", () => {
              if (worker.state === "activated") resolve();
            });
          },
          { once: true },
        );
      });
      await registration.update();
      await activated;
    });
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await navigator.serviceWorker.getRegistrations()).length,
        ),
      )
      .toBe(0);
    await expect(draft).toHaveTitle("Legacy journal");
    await expect(draft.getByRole("textbox")).toHaveValue(
      "Do not lose this draft",
    );
    expect(draftNavigations).toBe(0);
    await page.reload();
    await expect(page).toHaveTitle("Damadama rewrite");
    await page.goto(`${origin}/again`);
    await expect(page).toHaveTitle("Damadama rewrite");
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller),
    ).toBeNull();
    expect(await readStorage()).toEqual(stored);
    await expect(draft.getByRole("textbox")).toHaveValue(
      "Do not lose this draft",
    );
    expect(draftNavigations).toBe(0);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
