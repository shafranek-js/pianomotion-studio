import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { reporters } from "./playwright.shared";

export default defineConfig({
  ...base,
  outputDir: `test-results/audio-${process.env.PIANOMOTION_BROWSER_CHANNEL || "chromium"}`,
  reporter: reporters("audio"),
  testIgnore: [],
  testMatch: ["**/audio-dsp.spec.ts", "**/audio-output.spec.ts", "**/soundfont-stereo.spec.ts", "**/soundfont-sf3.spec.ts", "**/soundfont-storage.spec.ts"],
  timeout: 180_000,
});
