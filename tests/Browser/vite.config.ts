import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";
import { resolve } from "node:path";

const browserPort = Number(process.env["DAMADAMA_BROWSER_PORT"] ?? "5174");
const apiOrigin = `http://localhost:${process.env["DAMADAMA_API_PORT"] ?? "5055"}`;

export default defineConfig({
  root: "tests/Browser",
  publicDir: resolve("web/public"),
  plugins: [
    vue(),
    ui({
      router: false,
      dts: false,
      colorMode: false,
      ui: { colors: { primary: "rose", neutral: "stone" } },
    }),
  ],
  cacheDir: resolve(".audit/vite-browser"),
  build: {
    outDir: resolve(".audit/browser-build"),
    emptyOutDir: true,
  },
  preview: {
    host: "127.0.0.1",
    port: browserPort,
    strictPort: true,
    proxy: { "/api": apiOrigin },
  },
  server: {
    host: "127.0.0.1",
    port: browserPort,
    strictPort: true,
    proxy: { "/api": apiOrigin },
    fs: { allow: [resolve(".")] },
  },
});
