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
  testIgnore: [
    "**/offline-pwa.spec.ts",
    "**/pwa-deployment-m8.spec.ts",
    "**/media-export.spec.ts",
    "**/video-export-m7.spec.ts",
    "**/parity-m1.spec.ts",
    "**/native-engine.spec.ts",
    "**/native-parity.spec.ts",
    "**/motion-streaming.spec.ts",
    "**/motion-playback.spec.ts",
    "**/audio-dsp.spec.ts",
    "**/audio-output.spec.ts",
    "**/soundfont-stereo.spec.ts",
    "**/soundfont-sf3.spec.ts",
    "**/builtin-soundfont-offline.spec.ts",
    "**/soundfont-storage.spec.ts",
    "**/soundfont-large.spec.ts",
    "**/soundfont-user-banks.spec.ts",
    "**/soundfont-offline.spec.ts",
    "**/builtin-melodies-offline.spec.ts",
    // GPU/WebGL harness specs live in playwright.gpu.config.ts with a longer budget.
    "**/stage-environment.spec.ts",
    "**/grand-highway.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  retries,
  timeout: 90_000,
  expect: { timeout: expectTimeout },
  outputDir: `test-results/ui-${browserChannel || "chromium"}`,
  reporter: reporters("ui"),
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    channel: browserChannel,
    headless: true,
    ...failureArtifacts,
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    // `npm run dev` first stages Pyodide (21 MiB), the melody catalogue and the
    // SoundFont; 60 s was tight on a cold CI runner.
    timeout: 180_000,
  },
});
