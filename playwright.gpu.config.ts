import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { browserChannel, failureArtifacts, reporters } from "./playwright.shared";

/**
 * WebGL/GPU-heavy specs. They load the dev-only `/@fs/` harness and compare
 * rendered pixels, so software rendering on CI needs a much larger budget than
 * the ordinary UI group. Keeping them separate stops one slow shader compile
 * from timing out unrelated tests.
 */
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ["**/stage-environment.spec.ts", "**/grand-highway.spec.ts"],
  timeout: 240_000,
  expect: { timeout: 20_000 },
  outputDir: `test-results/gpu-${browserChannel || "chromium"}`,
  reporter: reporters("gpu"),
  use: {
    baseURL: "http://127.0.0.1:4176",
    browserName: "chromium",
    channel: browserChannel,
    headless: true,
    ...failureArtifacts,
  },
  webServer: {
    command: "npm run dev:test -- --host 127.0.0.1 --port 4176 --strictPort",
    url: "http://127.0.0.1:4176",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
