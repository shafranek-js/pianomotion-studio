import { defineConfig } from "@playwright/test";

process.env.PLAYWRIGHT_PWA_PRODUCTION = "1";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: ["**/offline-pwa.spec.ts", "**/pwa-deployment-m8.spec.ts", "**/soundfont-offline.spec.ts", "**/builtin-melodies-offline.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  outputDir: `test-results/pwa-${process.env.PIANOMOTION_BROWSER_CHANNEL || "chromium"}`,
  reporter: [["list"], ["json", { outputFile: `test-results/reports/pwa-${process.env.PIANOMOTION_BROWSER_CHANNEL || "chromium"}.json` }]],
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    channel: process.env.PIANOMOTION_BROWSER_CHANNEL,
    headless: true,
  },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4174 --strictPort",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
