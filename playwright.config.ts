import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testIgnore: ["**/offline-pwa.spec.ts", "**/pwa-deployment-m8.spec.ts", "**/media-export.spec.ts", "**/video-export-m7.spec.ts", "**/parity-m1.spec.ts", "**/native-engine.spec.ts", "**/native-parity.spec.ts", "**/motion-streaming.spec.ts", "**/motion-playback.spec.ts", "**/audio-dsp.spec.ts", "**/audio-output.spec.ts", "**/soundfont-stereo.spec.ts", "**/soundfont-sf3.spec.ts", "**/builtin-soundfont-offline.spec.ts", "**/soundfont-storage.spec.ts", "**/soundfont-large.spec.ts", "**/soundfont-user-banks.spec.ts", "**/soundfont-offline.spec.ts", "**/builtin-melodies-offline.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  outputDir: `test-results/ui-${process.env.PIANOMOTION_BROWSER_CHANNEL || "chromium"}`,
  reporter: [["list"], ["json", { outputFile: `test-results/reports/ui-${process.env.PIANOMOTION_BROWSER_CHANNEL || "chromium"}.json` }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    channel: process.env.PIANOMOTION_BROWSER_CHANNEL,
    headless: true,
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
