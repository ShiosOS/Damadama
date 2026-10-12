import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";

export default defineConfig({
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
  cacheDir: "../.audit/vite-web",
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": { target: process.env.API_URL ?? "http://localhost:5050" },
    },
    fs: { deny: ["**/tests/**", "**/.env*", "**/.git/**"] },
  },
  build: { outDir: "../server/wwwroot", emptyOutDir: true },
});
