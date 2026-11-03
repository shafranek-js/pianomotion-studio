import { describe, expect, it } from "vitest";
import {
  buildPedalSpans,
  computePhysicalReleaseTimes,
  inferBassPedalGap,
  pedalCarries,
} from "../src/pedalHold.ts";
import { Note } from "../src/midiLoader.ts";

describe("pedalHold", () => {
  it("converts CC64 and CC66 control triples into active pedal spans", () => {
    const spans = buildPedalSpans(
      [
        [0.0, 64, 127],
        [1.5, 64, 0],
        [2.0, 66, 90],
        [3.5, 66, 10],
        [4.0, 67, 100],
        [5.0, 67, 0],
      ],
      6.0,
    );
    expect(spans).toHaveLength(3);
    expect(spans[0]).toEqual({ controller: 64, startSeconds: 0.0, endSeconds: 1.5 });
    expect(spans[1]).toEqual({ controller: 66, startSeconds: 2.0, endSeconds: 3.5 });
    expect(spans[2]).toEqual({ controller: 67, startSeconds: 4.0, endSeconds: 5.0 });
  });

  it("checks sustain (CC64) and sostenuto (CC66) carry rules accurately", () => {
    const spans = buildPedalSpans([
      [0.2, 64, 127],
      [2.0, 64, 0],
      [3.0, 66, 127],
      [5.0, 66, 0],
    ]);

    // Sustain depressed at 0.2..2.0 carries a note [0.0, 1.8] at t=0.5
    expect(pedalCarries(spans, 0.0, 1.8, 0.5)).toBe(true);
    // Does not carry if note extends past pedal release (end=2.5 > 2.0)
    expect(pedalCarries(spans, 0.0, 2.5, 0.5)).toBe(false);

    // Sostenuto depressed at 3.0..5.0 carries a note struck BEFORE 3.0 ([2.8, 4.8]) at t=3.5
    expect(pedalCarries(spans, 2.8, 4.8, 3.5)).toBe(true);
    // Sostenuto does NOT carry a note struck AFTER 3.0 ([3.2, 4.8])
    expect(pedalCarries(spans, 3.2, 4.8, 3.5)).toBe(false);
  });

  it("infers bass pedal gap when an isolated low LH bass note leaps up >= 9 semitones without written pedals", () => {
    expect(inferBassPedalGap(36, 1, 48, false, true)).toBe(true);
    // Not inferred if written pedals exist
    expect(inferBassPedalGap(36, 1, 48, true, true)).toBe(false);
    // Not inferred for right hand
    expect(inferBassPedalGap(36, 1, 48, false, false)).toBe(false);
    // Not inferred if leap < 9 semitones
    expect(inferBassPedalGap(41, 1, 48, false, true)).toBe(false);
  });

  it("releases a pedal-carried note early when new notes arrive while preserving sounding end", () => {
    const bass = new Note(36, 0.0, 2.0, 80, 0, "L");
    const chord1 = new Note(52, 0.5, 1.5, 75, 0, "L");
    const chord2 = new Note(55, 0.5, 1.5, 75, 0, "L");
    const spans = buildPedalSpans([
      [0.0, 64, 127],
      [2.0, 64, 0],
    ]);

    const releases = computePhysicalReleaseTimes([bass, chord1, chord2], spans, {
      minShiftSemitones: 12,
    });
    expect(releases.get(bass)).toBeCloseTo(0.5, 5);
    expect(bass.end).toBe(2.0);
  });
});
