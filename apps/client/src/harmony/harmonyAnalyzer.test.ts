import { describe, expect, it } from "vitest";
import {
  analyzePieceHarmony,
  chordRomanNumeral,
  detectKeyFromChroma,
  invertChordTones,
  smoothChordInversions,
} from "./harmonyAnalyzer";

describe("harmonyAnalyzer", () => {
  it("detects C major and A minor keys from pitch-class profiles", () => {
    const cMajorChroma = [10, 0, 5, 0, 8, 5, 0, 9, 0, 5, 0, 4];
    const detectedC = detectKeyFromChroma(cMajorChroma);
    expect(detectedC?.tonic).toBe("C");
    expect(detectedC?.mode).toBe("major");

    const aMinorChroma = [8, 0, 5, 0, 8, 5, 0, 4, 4, 12, 0, 4];
    const detectedAm = detectKeyFromChroma(aMinorChroma);
    expect(detectedAm?.tonic).toBe("A");
    expect(detectedAm?.mode).toBe("minor");
  });

  it("assigns Roman numerals and secondary dominants accurately", () => {
    const cMajor = { rootPc: 0, mode: "major" as const };
    expect(chordRomanNumeral(0, "", cMajor)).toEqual({ numeral: "I", role: "tonic" });
    expect(chordRomanNumeral(9, "m", cMajor)).toEqual({ numeral: "vi", role: "tonic" });
    expect(chordRomanNumeral(5, "", cMajor)).toEqual({ numeral: "IV", role: "predominant" });
    expect(chordRomanNumeral(7, "7", cMajor)).toEqual({ numeral: "V7", role: "dominant" });
    expect(chordRomanNumeral(4, "7", cMajor)).toEqual({ numeral: "V7/vi", role: "dominant" });
  });

  it("computes smooth voice-leading inversions minimizing hand movement", () => {
    // C major [60, 64, 67] -> F major [65, 69, 72] -> G major [55, 59, 62]
    const chords = [
      { tones: [60, 64, 67] }, // C
      { tones: [65, 69, 72] }, // F (2nd inversion [60, 65, 69] shares C4=60!)
      { tones: [55, 59, 62] }, // G (1st inversion [59, 62, 67] shares G4=67!)
    ];
    const inversions = smoothChordInversions(chords);
    expect(inversions[0]).toBe(0);
    expect(inversions[1]).toBe(2); // C-F-A
    const fVoiced = invertChordTones(chords[1].tones, inversions[1]);
    expect(fVoiced).toEqual([60, 65, 69]);
  });

  it("analyzes a I - vi - IV - V progression into chord timeline events with Roman numerals", () => {
    // 120 BPM => 1 bar (4 beats) = 2.0s
    const notes = [
      // Bar 1 (0..2s): C major (C3, C4, E4, G4)
      { pitch: 48, startSeconds: 0, endSeconds: 2, velocity: 90 },
      { pitch: 60, startSeconds: 0, endSeconds: 2, velocity: 85 },
      { pitch: 64, startSeconds: 0, endSeconds: 2, velocity: 85 },
      { pitch: 67, startSeconds: 0, endSeconds: 2, velocity: 85 },
      // Bar 2 (2..4s): A minor (A2, A3, C4, E4)
      { pitch: 45, startSeconds: 2, endSeconds: 4, velocity: 90 },
      { pitch: 57, startSeconds: 2, endSeconds: 4, velocity: 85 },
      { pitch: 60, startSeconds: 2, endSeconds: 4, velocity: 85 },
      { pitch: 64, startSeconds: 2, endSeconds: 4, velocity: 85 },
      // Bar 3 (4..6s): F major (F2, F3, A3, C4)
      { pitch: 41, startSeconds: 4, endSeconds: 6, velocity: 90 },
      { pitch: 53, startSeconds: 4, endSeconds: 6, velocity: 85 },
      { pitch: 57, startSeconds: 4, endSeconds: 6, velocity: 85 },
      { pitch: 60, startSeconds: 4, endSeconds: 6, velocity: 85 },
      // Bar 4 (6..8s): G major (G2, G3, B3, D4)
      { pitch: 43, startSeconds: 6, endSeconds: 8, velocity: 90 },
      { pitch: 55, startSeconds: 6, endSeconds: 8, velocity: 85 },
      { pitch: 59, startSeconds: 6, endSeconds: 8, velocity: 85 },
      { pitch: 62, startSeconds: 6, endSeconds: 8, velocity: 85 },
    ];
    const analysis = analyzePieceHarmony(notes, { bpm: 120, beatsPerBar: 4 });
    expect(analysis.key?.tonic).toBe("C");
    expect(analysis.key?.mode).toBe("major");
    expect(analysis.chords.map((c) => c.symbol)).toEqual(["C", "Am", "F", "G"]);
    expect(analysis.chords.map((c) => c.numeral)).toEqual(["I", "vi", "IV", "V"]);
  });
});
