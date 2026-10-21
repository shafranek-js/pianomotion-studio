import type { ReporterDescription } from "@playwright/test";

/**
 * Settings shared by every Playwright configuration.
 *
 * The suites load a 38 MiB SoundFont, start Pyodide/WebGL and wait for Worker
 * jobs, so Playwright's default 5 s expectation is far too short; two of the
 * CI failures in run 39161074876 were exactly that. CI also gets one retry and
 * failure artifacts, while local runs stay fast and fail immediately.
 */
export const isCI = Boolean(process.env.CI);
export const browserChannel = process.env.PIANOMOTION_BROWSER_CHANNEL;
export const artifactChannel = browserChannel || "chromium";

export const expectTimeout = 15_000;
export const retries = isCI ? 1 : 0;

/** Headless CI has no user gesture, so Chromium keeps AudioContext suspended and
 * playback readiness never resolves. The suites do not test the autoplay gate. */
export const browserLaunch = {
  launchOptions: {
    args: ["--autoplay-policy=no-user-gesture-required"],
  },
};

export const failureArtifacts: {
  trace: "on-first-retry" | "off";
  screenshot: "only-on-failure" | "off";
} = {
  trace: isCI ? "on-first-retry" : "off",
  screenshot: isCI ? "only-on-failure" : "off",
};

/** A list + JSON (machine-readable) + HTML (uploaded from CI) reporter set. */
export function reporters(group: string): ReporterDescription[] {
  return [
    ["list"],
    ["json", { outputFile: `test-results/reports/${group}-${artifactChannel}.json` }],
    ["html", { outputFolder: `playwright-report/${group}`, open: "never" }],
  ];
}
