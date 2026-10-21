import type { M1ExportMidiDiagnostic } from "@handthesia/contracts";
import type { StudioStatus } from "../studio/types";

/**
 * Status shown after a fingered-MIDI export. A partial export is a warning, not
 * a success: the UI must name the document notes that had no source note-on.
 */
export function fingeredMidiExportStatus(
  markedCount: number,
  diagnostics: readonly M1ExportMidiDiagnostic[],
  dirty: boolean,
): StudioStatus {
  if (diagnostics.length > 0) {
    const noteIds = diagnostics.map((diagnostic) => diagnostic.noteId).join(", ");
    return {
      kind: "warning",
      message: `Exported ${markedCount} fingered notes with ${diagnostics.length} warning${diagnostics.length === 1 ? "" : "s"}: ${noteIds}.`,
    };
  }
  return {
    kind: dirty ? "modified" : "saved",
    message: `Exported ${markedCount} fingered notes.`,
  };
}
