import { describe, expect, it } from "vitest";
import { loadingStageLabel, measuredProgress, phaseFromWorkerProgress, virtualPianistLines } from "./loadingExperience";
import type { AppLanguage } from "../settings/types";

const languages: AppLanguage[] = ["en", "cs", "de", "es", "it", "uk"];

describe("musical loading experience", () => {
  it("keeps virtual pianist remarks in English in every locale", () => {
    for (const language of languages) {
      expect(loadingStageLabel("reading", language)).toBeTruthy();
      for (const remarks of Object.values(virtualPianistLines)) {
        expect(remarks.length).toBeGreaterThan(1);
        expect(remarks.every(line => /^[\x20-\x7e\u2018-\u2019\u2026]+$/.test(line))).toBe(true);
        expect(remarks.some(line => /piano|note|hand|finger|score|bar|wrist|music|bench/i.test(line))).toBe(true);
      }
    }
    expect(loadingStageLabel("reading", "cs")).not.toBe(loadingStageLabel("reading", "en"));
  });

  it("offers twenty distinct concise English jokes while audio is being prepared", () => {
    const remarks = virtualPianistLines.audio;
    expect(remarks).toHaveLength(20);
    expect(new Set(remarks).size).toBe(20);
    for (const line of remarks) {
      expect(line).toBe(line.trim());
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line).toMatch(/^[\\x20-\\x7e\\u2018-\\u2019\\u2026]+$/);
    }
  });

  it("classifies the reported Worker task without fabricating unseen stages", () => {
    expect(phaseFromWorkerProgress("Loading self-hosted Pyodide 314.0.7.", "reading")).toBe("runtime");
    expect(phaseFromWorkerProgress("Loaded 12 notes; planning fingering...", "runtime")).toBe("fingering");
    expect(phaseFromWorkerProgress("Calculating hand poses: 6/12", "fingering")).toBe("motion");
    expect(phaseFromWorkerProgress("Solving kinematics and scheduling rolled chords...", "analysis")).toBe("motion");
    expect(phaseFromWorkerProgress("an unknown opaque callback", "reading")).toBe("reading");
  });

  it("never turns missing or fabricated progress into a percentage", () => {
    for (const value of [undefined, null, NaN, Infinity, -0.1, 1.01, "0.5"]) {
      expect(measuredProgress(value)).toBeUndefined();
    }
    expect(measuredProgress(0)).toBe(0);
    expect(measuredProgress(0.5)).toBe(0.5);
    expect(measuredProgress(1)).toBe(1);
  });
});
