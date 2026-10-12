import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "tests/Browser",
  plugins: [
    vue(),
    ui({
      router: false,
      dts: false,
      colorMode: false,
      ui: { colors: { primary: "rose", neutral: "stone" } },
    }),
  ],
  optimizeDeps: { include: ["reka-ui"] },
  cacheDir: resolve(".audit/vite-browser"),
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: { "/api": "http://localhost:5055" },
    fs: { allow: [resolve(".")] },
  },
});
