import { describe, expect, it } from "vitest";
import { is_piano_track } from "../src/midiLoader.ts";

describe("MIDI piano track classification", () => {
  it("uses clear instrument names before a default piano program", () => {
    for (const name of [
      "Singstimme", "Gesang", "Chant", "Voce", "Voix", "Canto", "Cantante",
      "Soprano", "Mezzo", "Alto", "Tenor", "Bariton", "Basso", "Contralto",
      "Solo Violin", "Flute", "Strings", "Saxophone", "Brass", "Synth Pad",
    ]) {
      expect(is_piano_track({ name, program: 0 }), name).toBe(false);
    }

    expect(is_piano_track({ name: "Piano", program: 40 })).toBe(true);
  });

  it("keeps generic solo, lead, and melody labels ambiguous and program-based", () => {
    for (const name of ["Solo", "Lead", "Melody"]) {
      expect(is_piano_track({ name, program: 0 }), name).toBe(true);
      expect(is_piano_track({ name, program: 40 }), name).toBe(false);
    }

    expect(is_piano_track({ name: "Solo Piano", program: 40 })).toBe(true);
  });
});
