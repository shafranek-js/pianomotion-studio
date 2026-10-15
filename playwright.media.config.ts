import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: ["**/video-export-m7.spec.ts", "**/media-export.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  outputDir: `test-results/media-${process.env.PIANOMOTION_BROWSER_CHANNEL || "chromium"}`,
  reporter: [["list"], ["json", { outputFile: `test-results/reports/media-${process.env.PIANOMOTION_BROWSER_CHANNEL || "chromium"}.json` }]],
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: "chromium",
    channel: process.env.PIANOMOTION_BROWSER_CHANNEL,
    headless: true,
  },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
