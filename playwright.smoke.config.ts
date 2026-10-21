import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { browserChannel, reporters } from "./playwright.shared";

/**
 * The deterministic subset that gates a push (`npm run ci:local`, profile pr).
 * Heavy acceptance suites (full UI, worker, audio, SoundFont, PWA, media, GPU)
 * run in the local `full` profile, where a real desktop session and audio
 * device are available; they are not part of the fast gate.
 */
const testPort = Number(process.env.PIANOMOTION_TEST_PORT ?? 4185);

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: [
    "**/bootstrap.spec.ts",
    "**/player-m2.spec.ts",
    "**/editor-commands.spec.ts",
    "**/play-along.spec.ts",
    "**/audit-session-recovery.spec.ts",
    "**/library-preferences.spec.ts",
  ],
  timeout: 180_000,
  outputDir: `test-results/smoke-${browserChannel || "chromium"}`,
  reporter: reporters("smoke"),
  use: {
    ...base.use,
    baseURL: `http://127.0.0.1:${testPort}`,
  },
  webServer: {
    command: `npm run dev:test -- --host 127.0.0.1 --port ${testPort} --strictPort`,
    url: `http://127.0.0.1:${testPort}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
