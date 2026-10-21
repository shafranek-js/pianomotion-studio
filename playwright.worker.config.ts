import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { reporters } from "./playwright.shared";

export default defineConfig({
  ...base,
  outputDir: `test-results/worker-${process.env.PIANOMOTION_BROWSER_CHANNEL || "chromium"}`,
  reporter: reporters("worker"),
  testIgnore: [],
  testMatch: ["**/parity-m1.spec.ts", "**/native-engine.spec.ts", "**/native-parity.spec.ts", "**/motion-streaming.spec.ts", "**/motion-playback.spec.ts"],
  timeout: 300_000,
});
