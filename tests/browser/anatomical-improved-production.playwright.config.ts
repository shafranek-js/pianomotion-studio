import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { browserChannel, browserLaunch, expectTimeout, failureArtifacts } from "../../playwright.shared";

const root = fileURLToPath(new URL("../..", import.meta.url));
const serverScript = fileURLToPath(new URL("./anatomical-improved-production-server.mjs", import.meta.url));
const evidenceDir = process.env.PIANOMOTION_PRODUCTION_EVIDENCE_DIR ??
  `${root}/scratch/improved-qa/evidence/chrome-production-ui-smoke`;

export default defineConfig({
  testDir: ".",
  testMatch: "anatomical-improved-production.spec.ts",
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
    baseURL: "http://127.0.0.1:4218/pianomotion-studio/",
    browserName: "chromium",
    channel: browserChannel || "chrome",
    headless: true,
    ...browserLaunch,
    ...failureArtifacts,
  },
  webServer: {
    command: `node "${serverScript}"`,
    url: "http://127.0.0.1:4218/pianomotion-studio/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
