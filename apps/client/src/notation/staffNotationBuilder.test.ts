import { describe, expect, it } from "vitest";
import {
  buildStaffNotation,
  resolveKeySignatureFifths,
  serializeStaffMusicXml,
  spellMidiPitch,
} from "./staffNotationBuilder";

describe("staffNotationBuilder", () => {
  it("resolves key signature fifths and spells pitches on treble and bass staves", () => {
    expect(resolveKeySignatureFifths({ tonic: "G", mode: "major" })).toBe(1);
    expect(resolveKeySignatureFifths({ tonic: "F", mode: "major" })).toBe(-1);
    expect(resolveKeySignatureFifths({ tonic: "Eb", mode: "major" })).toBe(-3);

    const middleCTreble = spellMidiPitch(60, 0, "treble");
    expect(middleCTreble.step).toBe("C");
    expect(middleCTreble.octave).toBe(4);
    expect(middleCTreble.staffStepOffset).toBe(-2); // 1 ledger line below E4

    const middleCBass = spellMidiPitch(60, 0, "bass");
    expect(middleCBass.staffStepOffset).toBe(10); // 1 ledger line above A3
  });

  it("splits notes across barlines with ties and applies fingering overrides", () => {
    // 120 BPM => 1 quarter = 0.5s, 4/4 bar = 2.0s (96 units)
    const model = buildStaffNotation(
      [
        {
          noteId: "rh-long",
          pitch: 64, // E4
          startSeconds: 1.5, // beat 4 of bar 1
          endSeconds: 2.5, // beat 2 of bar 2
          hand: "right",
          finger: 1,
        },
        {
          noteId: "lh-bass",
          pitch: 48, // C3
          startSeconds: 0,
          endSeconds: 1.0,
          hand: "left",
          finger: 5,
        },
      ],
      {
        bpm: 120,
        beatsPerBar: 4,
        key: { tonic: "C", mode: "major" },
        fingeringAssignments: [{ noteId: "rh-long", hand: "right", finger: 3 }],
      },
    );

    expect(model.measures.length).toBe(2);
    const bar1TrebleNotes = model.measures[0].trebleEvents.filter((e) => !e.isRest);
    const bar2TrebleNotes = model.measures[1].trebleEvents.filter((e) => !e.isRest);
    expect(bar1TrebleNotes.length).toBe(1);
    expect(bar1TrebleNotes[0].tieStart).toBe(true);
    expect(bar1TrebleNotes[0].notes[0].finger).toBe(3);
    expect(bar2TrebleNotes.length).toBe(1);
    expect(bar2TrebleNotes[0].tieStop).toBe(true);
  });

  it("tracks accidentals within a measure and emits natural sign when cancelling a sharp", () => {
    // Key of C major: F#4 followed by F4 in the same bar
    const model = buildStaffNotation(
      [
        { noteId: "n1", pitch: 66, startSeconds: 0.0, endSeconds: 0.5, hand: "right", finger: 2 },
        { noteId: "n2", pitch: 65, startSeconds: 0.5, endSeconds: 1.0, hand: "right", finger: 1 },
      ],
      { bpm: 120, beatsPerBar: 4, key: { tonic: "C", mode: "major" } },
    );

    const played = model.measures[0].trebleEvents.filter((e) => !e.isRest);
    expect(played.length).toBe(2);
    expect(played[0].notes[0].accidental).toBe("sharp");
    expect(played[1].notes[0].accidental).toBe("natural");
  });

  it("selects triplet quantization in auto mode when input notes are spaced in triplets", () => {
    // 120 BPM => 1 beat = 0.5s; eighth-note triplets = 0.5 / 3 = 0.16667s each
    const dt = 0.5 / 3;
    const model = buildStaffNotation(
      [
        { noteId: "t1", pitch: 60, startSeconds: 0, endSeconds: dt, hand: "right", finger: 1 },
        { noteId: "t2", pitch: 62, startSeconds: dt, endSeconds: 2 * dt, hand: "right", finger: 2 },
        { noteId: "t3", pitch: 64, startSeconds: 2 * dt, endSeconds: 3 * dt, hand: "right", finger: 3 },
      ],
      { bpm: 120, beatsPerBar: 4, quantizationMode: "auto" },
    );

    expect(model.resolvedQuantization).toBe("triplets");
    const played = model.measures[0].trebleEvents.filter((e) => !e.isRest);
    expect(played.every((e) => e.isTriplet)).toBe(true);

    const xml = serializeStaffMusicXml(model, { showFingers: true, showNoteNames: true });
    expect(xml).toContain("<staves>2</staves>");
    expect(xml).toContain('<clef number="1">');
    expect(xml).toContain('<clef number="2">');
    expect(xml).toContain("<fingering>1·C4</fingering>");
  });
});
