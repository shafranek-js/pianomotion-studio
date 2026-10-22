import { describe, expect, it } from "vitest";
import { _map_desktop_notes } from "../src/api.ts";

function sourceNote(noteId: string, pitch: number, sourceInstrument: number) {
  return { noteId, pitch, start: 1, end: 5, velocity: 80, sourceInstrument, sourceOrdinal: 0 };
}

function songNote(track: number, pitch: number) {
  return {
    track,
    pitch,
    start: 1,
    end: 2,
    velocity: 80,
    hand: "right",
    finger: 1,
    gliss: false,
    source_ids: [] as string[],
  };
}

describe("ENG-14a timestamp fallback", () => {
  it("does not attach a source note with a different pitch", () => {
    const [mapped] = _map_desktop_notes(
      [sourceNote("wrong-pitch", 62, 99)],
      [songNote(99, 60)],
      "fixture",
    );

    expect(mapped[0]!.noteId).toBeNull();
    expect(mapped[0]!.sourceNoteIds).toEqual([]);
  });

  it("still finds an instrument-mismatched note when pitch and start match", () => {
    const [mapped] = _map_desktop_notes(
      [sourceNote("same-pitch", 60, 7)],
      [songNote(99, 60)],
      "fixture",
    );

    expect(mapped[0]!.noteId).toBe("same-pitch");
    expect(mapped[0]!.sourceNoteIds).toEqual(["same-pitch"]);
  });
});
