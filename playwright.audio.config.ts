import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  outputDir: `test-results/audio-${process.env.PIANOMOTION_BROWSER_CHANNEL || "chromium"}`,
  reporter: [["list"], ["json", { outputFile: `test-results/reports/audio-${process.env.PIANOMOTION_BROWSER_CHANNEL || "chromium"}.json` }]],
  testIgnore: [],
  testMatch: ["**/audio-dsp.spec.ts", "**/audio-output.spec.ts", "**/soundfont-stereo.spec.ts", "**/soundfont-storage.spec.ts"],
  timeout: 180_000,
});
