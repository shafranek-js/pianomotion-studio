import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { browserChannel, browserLaunch, expectTimeout, failureArtifacts } from "../../playwright.shared";

const root = fileURLToPath(new URL("../..", import.meta.url));
const viteCli = fileURLToPath(new URL("../../node_modules/vite/bin/vite.js", import.meta.url));
const viteConfig = fileURLToPath(new URL("./anatomical-improved.vite.config.ts", import.meta.url));
const draftLod1 = process.env.PIANOMOTION_DRAFT_LOD1 === "1";
const evidenceDir = process.env.PIANOMOTION_EVIDENCE_DIR ??
  (draftLod1 ? `${root}/scratch/draftmanifestlog` : `${root}/scratch/improved-qa`);

export default defineConfig({
  testDir: ".",
  testMatch: "anatomical-improved.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  outputDir: `${evidenceDir}/playwright-results`,
  reporter: [
    ["list"],
    ["json", { outputFile: `${evidenceDir}/playwright-report.json` }],
  ],
  expect: { timeout: expectTimeout },
  use: {
    baseURL: "http://127.0.0.1:4217",
    browserName: "chromium",
    channel: browserChannel || "chrome",
    headless: true,
    ...browserLaunch,
    ...failureArtifacts,
  },
  webServer: {
    command: `node "${viteCli}" --config "${viteConfig}" --host 127.0.0.1 --port 4217 --strictPort`,
    url: "http://127.0.0.1:4217",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
