import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: process.env.VITE_BASE || "/",
  define: {
    __APP_BASE_PATH__: JSON.stringify(process.env.VITE_APP_BASE_PATH || "/"),
    __PIANOMOTION_BUILD_ID__: JSON.stringify(process.env.VITE_RELEASE_BUILD_ID || "development"),
  },
  resolve: {
    alias: {
      "@handthesia/engine-ts": fileURLToPath(new URL("../../packages/engine-ts/src/index.ts", import.meta.url)),
    },
  },
  plugins: [react()],
});
