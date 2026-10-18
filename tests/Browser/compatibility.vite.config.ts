import { resolve } from "node:path";
import { mergeConfig } from "vite";
import shared from "./vite.config";

export default mergeConfig(shared, {
  build: {
    rollupOptions: {
      input: resolve("tests/Browser/compatibility.html"),
    },
  },
});
