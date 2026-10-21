import { defineConfig } from "@playwright/test";

import {
  browserChannel,
  browserLaunch,
  expectTimeout,
  failureArtifacts,
  reporters,
  retries,
} from "./playwright.shared";

const testPort = Number(process.env.PIANOMOTION_TEST_PORT ?? 4175);

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
    baseURL: `http://127.0.0.1:${testPort}`,
    browserName: "chromium",
    channel: browserChannel,
    headless: true,
    ...browserLaunch,
    ...failureArtifacts,
  },
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${testPort} --strictPort`,
    url: `http://127.0.0.1:${testPort}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
