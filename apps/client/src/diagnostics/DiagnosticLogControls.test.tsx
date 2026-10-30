import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiagnosticLogControls } from "./DiagnosticLogControls";
import { startTestingHandCapture, stopTestingHandCapture, testingHandCapture } from "./testingHandCapture";
import { getSettings, updateSettings } from "../settings";

const originalSettings = getSettings();

afterEach(() => {
  if (testingHandCapture.status().active) stopTestingHandCapture();
  updateSettings(originalSettings);
  vi.useRealTimers();
});

describe("Rigged Experimental diagnostic capture UI", () => {
  it("shows the skipped identical paused-frame count while capture is active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
    updateSettings({ handModel: "rigged-experimental" });
    startTestingHandCapture({ handModel: "rigged-experimental", riggedExperimentalFrameSchemaVersion: 2 });
    const sample = {
      displayedTransportTimeSeconds: -2,
      sourcePoseTimeSeconds: 0,
      profileIdentity: { profileId: "profile-a", profileRevision: 2 },
      riggedExperimental: {
        frameSchemaVersion: 2,
        sourceAssetSha256: "a".repeat(64),
        boneWorldTransformRows: [[20, 0, 0, 0, 0, 0, 0, 1], [21, 0, 0, 0, 0, 0, 0, 1]],
        fixedDistalSkinSampleRows: [],
        targets: [],
        collisionStatus: "not-computed",
      },
    };
    expect(testingHandCapture.record("left", sample)).toBe(true);
    vi.advanceTimersByTime(250);
    expect(testingHandCapture.record("left", sample)).toBe(false);

    const markup = renderToStaticMarkup(createElement(DiagnosticLogControls));
    expect(markup).toContain("Identical paused frames are skipped and summarized with their elapsed hold interval");
    expect(markup).toContain("1 identical Rigged frames skipped");
    expect(markup).toContain("Stop and save Rigged Experimental capture");
    expect(markup).not.toContain("Testing");
  });
});
