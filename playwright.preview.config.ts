import { defineConfig } from "@playwright/test";

import {
  browserChannel,
  expectTimeout,
  failureArtifacts,
  reporters,
  retries,
} from "./playwright.shared";

process.env.PLAYWRIGHT_PWA_PRODUCTION = "1";

const testPort = Number(process.env.PIANOMOTION_TEST_PORT ?? 4174);

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: ["**/offline-pwa.spec.ts", "**/pwa-deployment-m8.spec.ts", "**/soundfont-offline.spec.ts", "**/builtin-soundfont-offline.spec.ts", "**/builtin-melodies-offline.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries,
  timeout: 120_000,
  expect: { timeout: expectTimeout },
  outputDir: `test-results/pwa-${browserChannel || "chromium"}`,
  reporter: reporters("pwa"),
  use: {
    baseURL: `http://127.0.0.1:${testPort}`,
    browserName: "chromium",
    channel: browserChannel,
    headless: true,
    ...failureArtifacts,
  },
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${testPort} --strictPort`,
    url: `http://127.0.0.1:${testPort}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
