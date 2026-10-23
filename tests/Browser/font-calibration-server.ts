import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { sourceRoot } from "./font-evidence-admission";
import { calibrationMode } from "./font-evidence-schema";

export type Mode = z.infer<typeof calibrationMode>;
export type Toy = {
  origin: string;
  port: number;
  partial: () => boolean;
  posts: () => number;
  release: () => Promise<void>;
  released: () => boolean;
  close: () => Promise<void>;
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Owned server has no port.");
  return address.port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}

export async function startToy(mode: Mode): Promise<Toy> {
  const assets = join(sourceRoot, ".audit/browser-build/assets");
  const files = new Map<string, Buffer>();
  for (const file of await readdir(assets)) {
    if (file.endsWith(".woff2") || file.endsWith(".css"))
      files.set(`/assets/${file}`, await readFile(join(assets, file)));
  }
  const cssPath = [...files.keys()].find((path) => path.endsWith(".css"));
  const latin = [...files.entries()].find(([path]) =>
    /nunito-latin-wght/.test(path),
  );
  if (!cssPath || !latin) throw new Error("Built fixture font inputs missing.");
  const remote = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "font/woff2",
      "access-control-allow-origin": "*",
    });
    response.end(latin[1]);
  });
  const remotePort = await listen(remote);
  const held = new Set<ServerResponse>();
  let partial = false;
  let posts = 0;
  let released = false;
  let pendingRelease: (() => void) | null = null;
  let arrived: () => void = () => {};
  const requestArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    if (path === "/api/habits" && request.method === "POST") {
      posts++;
      if (mode === "held-response") {
        held.add(response);
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end('{"saved":true}');
      return;
    }
    const bytes = files.get(path);
    if (bytes) {
      if (path.endsWith(".css")) {
        response.writeHead(200, { "content-type": "text/css" });
        response.end(bytes);
        return;
      }
      if (mode === "redirect") {
        response.writeHead(302, {
          location: `http://127.0.0.1:${remotePort}/privacy-canary-destination?secret=privacy-canary-query`,
        });
        response.end();
        return;
      }
      const body = mode === "corrupt" ? Buffer.alloc(24, 7) : bytes;
      response.writeHead(200, {
        "content-type": "font/woff2",
        "content-length": body.length,
        "x-canary": "privacy-canary-header",
      });
      if (mode === "hold") {
        response.flushHeaders();
        response.write(body.subarray(0, 20000), () => {
          partial = true;
        });
        held.add(response);
        return;
      }
      if (mode === "delayed") {
        held.add(response);
        pendingRelease = (): void => {
          released = true;
          response.end(body);
          held.delete(response);
        };
        arrived();
        return;
      }
      response.end(body);
      return;
    }
    let css = `<link rel="stylesheet" href="${cssPath}">`;
    if (mode === "missing" || mode === "later-font-failure") css = "";
    let family = "'Nunito Variable'";
    if (mode === "unused") family = "serif";
    let extra = "";
    if (mode === "overflow") {
      extra = `<style>${Array.from({ length: 33 }, (_, index) => `@font-face{font-family:'Nunito Variable';font-weight:${index + 1};src:url('/privacy-canary-unused-${index}.woff2');unicode-range:U+10FFFF;}`).join("")}</style>`;
      css = extra + css;
    }
    const text = mode === "mixed" ? "Walking Прогулка" : "Walking";
    const value = mode === "invalid-form" ? "" : "privacy-canary-input";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><meta charset="utf-8">${css}<style>body{font-family:${family}!important;font-weight:400}</style></head><body>
      <p>${text}</p><form class="habit-form"><input aria-label="Name" required value="${value}"><button type="submit">Save habit</button></form>
      <div id="saved"></div><script>
        console.info('privacy-canary-console');
        document.querySelector('form').addEventListener('submit', async event => {
          event.preventDefault(); const response = await fetch('/api/habits', {method:'POST'});
          const saved = await response.json(); if(saved.saved) document.querySelector('#saved').textContent='Saved';
        });
      </script></body></html>`);
  });
  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    partial: () => partial,
    posts: () => posts,
    release: async (): Promise<void> => {
      await requestArrived;
      released = true;
      pendingRelease?.();
    },
    released: () => released,
    close: async (): Promise<void> => {
      for (const response of held) response.destroy();
      await Promise.all([close(server), close(remote)]);
    },
  };
}
