import { describe, expect, it } from "vitest";
import type { SongDocument } from "@handthesia/contracts";
import { assertSameSourceIdentities } from "./controller";

function sourceDocument(): SongDocument {
  return {
    schemaVersion: 1,
    projectId: "source-test-project",
    revision: 1,
    title: "Source identity check",
    durationSeconds: 2,
    tracks: [{
      trackId: "track-0",
      instrumentIndex: 0,
      sourceMidiTrackIndex: 0,
      channel: 0,
      name: "Piano",
      program: 0,
      hand: "right",
    }],
    notes: [
      {
        noteId: "note-a",
        sourceNoteIds: ["fixture/instrument-0/note-000000"],
        sourceEvent: { midiTrackIndex: 0, channel: 0, noteOnOrdinal: 2, noteOffOrdinal: 3 },
        trackId: "track-0", pitch: 60, velocity: 90, startSeconds: 0, endSeconds: 0.5,
        hand: "right", finger: 1, glissando: false,
      },
      {
        noteId: "note-b",
        sourceNoteIds: ["fixture/instrument-0/note-000001"],
        sourceEvent: { midiTrackIndex: 0, channel: 0, noteOnOrdinal: 4, noteOffOrdinal: 5 },
        trackId: "track-0", pitch: 64, velocity: 90, startSeconds: 0.5, endSeconds: 1,
        hand: "right", finger: 3, glissando: false,
      },
    ],
    tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500000, eventOrdinal: 0 }],
    pedalControls: [],
  };
}

describe("saved-project source identity verification", () => {
  it("rejects source IDs swapped between otherwise matching notes", () => {
    const saved = sourceDocument();
    const reanalyzed = sourceDocument();
    reanalyzed.notes[0]!.sourceNoteIds = [...saved.notes[1]!.sourceNoteIds!];
    reanalyzed.notes[1]!.sourceNoteIds = [...saved.notes[0]!.sourceNoteIds!];

    expect(() => assertSameSourceIdentities(saved, reanalyzed))
      .toThrow(/source-note IDs for note-a do not match/i);
  });

  it("allows saved hand and finger intent while requiring immutable source fields", () => {
    const saved = sourceDocument();
    const reanalyzed = sourceDocument();
    saved.notes[0]!.hand = "left";
    saved.notes[0]!.finger = 5;
    saved.notes[0]!.glissando = true;

    expect(() => assertSameSourceIdentities(saved, reanalyzed)).not.toThrow();
    reanalyzed.notes[0]!.sourceEvent!.noteOnOrdinal += 1;
    expect(() => assertSameSourceIdentities(saved, reanalyzed))
      .toThrow(/source attributes for note-a do not match/i);
  });
});
