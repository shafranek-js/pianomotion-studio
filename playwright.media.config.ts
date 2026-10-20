import { defineConfig } from "@playwright/test";

import {
  browserChannel,
  expectTimeout,
  failureArtifacts,
  reporters,
  retries,
} from "./playwright.shared";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: ["**/video-export-m7.spec.ts", "**/media-export.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries,
  timeout: 180_000,
  expect: { timeout: expectTimeout },
  outputDir: `test-results/media-${browserChannel || "chromium"}`,
  reporter: reporters("media"),
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: "chromium",
    channel: browserChannel,
    headless: true,
    ...failureArtifacts,
  },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
