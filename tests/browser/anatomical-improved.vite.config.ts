import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import clientConfig from "../../apps/client/vite.config.ts";

const cachePath = process.env.PIANOMOTION_DRAFT_LOD1 === "1"
  ? "../../scratch/draftmanifestlog/vite-cache"
  : "../../scratch/improved-qa/vite-cache";
const serverOptions = { hmr: false as const };

export default defineConfig(mergeConfig(clientConfig, {
  cacheDir: fileURLToPath(new URL(cachePath, import.meta.url)),
  server: serverOptions,
}));
