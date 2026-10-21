import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { reporters } from "./playwright.shared";

/** Explicit large-file acceptance; kept sequential and separate from ordinary UI. */
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ["**/soundfont-large.spec.ts", "**/soundfont-user-banks.spec.ts"],
  timeout: 300_000,
  outputDir: `test-results/soundfont-${process.env.PIANOMOTION_BROWSER_CHANNEL || "chromium"}`,
  reporter: reporters("soundfont"),
});
