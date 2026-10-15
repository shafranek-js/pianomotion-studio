import { describe, expect, it } from "vitest";
import type { PerformancePlan } from "@handthesia/contracts";
import { derivePerformanceStateAt, extractPerformanceNotes } from "./performancePlan.ts";

function plan(events: PerformancePlan["events"]): PerformancePlan {
  return {
    schemaVersion: 1,
    projectId: "performance-state-test",
    inputRevision: 0,
    profileId: "default",
    profileRevision: 0,
    engineVersion: "0".repeat(64),
    planId: "plan",
    kind: "performance",
    fingeringPlanId: "fingering",
    events,
    diagnostics: [],
  };
}

describe("PerformancePlan playback reducer", () => {
  it("treats missing and empty plans as silence", () => {
    expect(derivePerformanceStateAt(undefined, 0)).toEqual({
      voices: [],
      pedals: { sustain: false, sostenuto: false, soft: false },
    });
    expect(extractPerformanceNotes(null, 10)).toEqual([]);
    expect(extractPerformanceNotes(plan([]), 10)).toEqual([]);
  });

  it("keeps a note until both sustain and captured sostenuto release", () => {
    const performancePlan = plan([
      { type: "press", timeSeconds: 0, noteId: "n1", pitch: 60, velocity: 90 },
      { type: "pedal", timeSeconds: 0.1, controller: 66, value: 127 },
      { type: "pedal", timeSeconds: 0.15, controller: 64, value: 127 },
      { type: "release", timeSeconds: 0.2, noteId: "n1" },
      { type: "pedal", timeSeconds: 0.3, controller: 64, value: 0 },
      { type: "pedal", timeSeconds: 0.4, controller: 66, value: 0 },
    ]);

    const held = derivePerformanceStateAt(performancePlan, 0.35);
    expect(held.voices).toMatchObject([{
      noteId: "n1",
      keyState: "up",
      heldBySostenuto: true,
      sustainedBySustain: false,
    }]);
    expect(held.pedals).toEqual({ sustain: false, sostenuto: true, soft: false });

    expect(derivePerformanceStateAt(performancePlan, 0.4).voices).toEqual([]);
    expect(extractPerformanceNotes(performancePlan, 1)).toEqual([{
      noteId: "n1",
      pitch: 60,
      velocity: 90,
      pressTimeSeconds: 0,
      releaseTimeSeconds: 0.4,
      softPedalAtPress: false,
    }]);
  });
});
