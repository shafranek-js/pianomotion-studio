import { describe, expect, it } from "vitest";
import {
  MAX_SONG_NOTES,
  MAX_SONG_TITLE_LENGTH,
  SongDocumentSchema,
} from "./index";

const document = {
  schemaVersion: 1 as const,
  projectId: "project-bounds",
  revision: 1,
  title: "Bounds",
  durationSeconds: 4,
  tracks: [],
  notes: [],
  tempoMap: [],
  pedalControls: [],
};

describe("SEC-6 document bounds", () => {
  it("rejects an overlong title and track name", () => {
    expect(SongDocumentSchema.safeParse({ ...document, title: "x".repeat(MAX_SONG_TITLE_LENGTH + 1) }).success).toBe(false);
    expect(SongDocumentSchema.safeParse({
      ...document,
      tracks: [{ trackId: "track-1", instrumentIndex: 0, name: "x".repeat(MAX_SONG_TITLE_LENGTH + 1), program: 0, hand: null }],
    }).success).toBe(false);
  });

  it("rejects a note list above the contract cap", () => {
    const note = {
      noteId: "note-1",
      trackId: "track-1",
      pitch: 60,
      velocity: 80,
      startSeconds: 0,
      endSeconds: 1,
      hand: "right" as const,
      finger: 1,
      glissando: false,
    };
    const notes = Array.from({ length: MAX_SONG_NOTES + 1 }, (_, index) => ({ ...note, noteId: `note-${index}` }));
    expect(SongDocumentSchema.safeParse({ ...document, notes }).success).toBe(false);
  });
});
