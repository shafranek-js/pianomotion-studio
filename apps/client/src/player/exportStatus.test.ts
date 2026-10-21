import { describe, expect, it } from "vitest";
import { fingeredMidiExportStatus } from "./exportStatus";

const diagnostic = (noteId: string) => ({
  code: "unmatched-document-note" as const,
  noteId,
  message: `Document note ${noteId} has no matching note-on in the source MIDI and was not marked.`,
});

describe("fingeredMidiExportStatus", () => {
  it("keeps a complete export as a success status", () => {
    expect(fingeredMidiExportStatus(22, [], false)).toEqual({
      kind: "saved",
      message: "Exported 22 fingered notes.",
    });
    expect(fingeredMidiExportStatus(22, [], true)).toEqual({
      kind: "modified",
      message: "Exported 22 fingered notes.",
    });
  });

  it("turns a partial export into a warning with the unmatched noteIds", () => {
    expect(fingeredMidiExportStatus(21, [diagnostic("note-17")], false)).toEqual({
      kind: "warning",
      message: "Exported 21 fingered notes with 1 warning: note-17.",
    });
    expect(fingeredMidiExportStatus(20, [diagnostic("note-17"), diagnostic("note-18")], true)).toEqual({
      kind: "warning",
      message: "Exported 20 fingered notes with 2 warnings: note-17, note-18.",
    });
  });
});
