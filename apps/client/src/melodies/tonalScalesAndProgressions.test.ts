import { describe, expect, it } from "vitest";
import {
  generateProgressionExercise,
  generateScaleExercise,
  HAND_VARIANTS,
  PROGRESSION_PATTERNS,
  SCALE_FAMILIES,
} from "./tonalScalesAndProgressions";
import { buildTonalExerciseMidi } from "./tonalMidiBuilder";
import { midiLoader } from "@handthesia/engine-ts";

describe("tonalScalesAndProgressions & tonalMidiBuilder", () => {
  it("generates all 15 scale families across all 12 tonics and 3 hand modes with valid fingerings 1..5", () => {
    expect(SCALE_FAMILIES).toHaveLength(15);
    for (const family of SCALE_FAMILIES) {
      for (let pitch = 0; pitch < 12; pitch++) {
        for (const variant of HAND_VARIANTS) {
          const ex = generateScaleExercise(pitch, family.id, variant.slug);
          expect(ex.notes.length).toBeGreaterThan(0);
          for (const note of ex.notes) {
            expect(note.finger).toBeGreaterThanOrEqual(1);
            expect(note.finger).toBeLessThanOrEqual(5);
            expect(note.midi).toBeGreaterThanOrEqual(21);
            expect(note.midi).toBeLessThanOrEqual(108);
          }
        }
      }
    }
  });

  it("generates all 18 classical chord progressions across all 12 tonics", () => {
    const totalPatterns =
      PROGRESSION_PATTERNS.major.length + PROGRESSION_PATTERNS.minor.length;
    expect(totalPatterns).toBe(18);
    for (const mode of ["major", "minor"] as const) {
      for (const pattern of PROGRESSION_PATTERNS[mode]) {
        for (let pitch = 0; pitch < 12; pitch++) {
          const ex = generateProgressionExercise(pitch, mode, pattern.slug);
          expect(ex.notes.length).toBeGreaterThan(0);
          expect(ex.chords.length).toBe(ex.bars);
          expect(ex.numerals.length).toBe(ex.bars);
        }
      }
    }
  });

  it("builds a Standard MIDI File with preserved hand and finger markers when loaded by engine-ts", () => {
    const scaleEx = generateScaleExercise(0, "major", "hands-together", 120);
    const midiBuffer = buildTonalExerciseMidi(scaleEx);
    const bytes = new Uint8Array(midiBuffer);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)).toBe("MThd");

    const song = midiLoader.load_midi(bytes, { fixture_id: scaleEx.id });
    expect(song.notes.length).toBe(scaleEx.notes.length);
    const rightCount = song.notes.filter((n) => n.hand === "R").length;
    const leftCount = song.notes.filter((n) => n.hand === "L").length;
    expect(rightCount).toBe(scaleEx.notes.length / 2);
    expect(leftCount).toBe(scaleEx.notes.length / 2);
    expect(song.notes.every((n) => typeof n.finger === "number" && n.finger >= 1 && n.finger <= 5)).toBe(true);
  });
});
