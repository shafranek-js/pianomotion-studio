import type { FingeringPlan, SongDocument } from "@handthesia/contracts";

/** Adds frozen fingering intent to an export-only scene document without editing the source DTO. */
export function materializeImprovedHandExportDocument(
  document: SongDocument,
  fingeringPlan: FingeringPlan,
): SongDocument {
  const assignments = new Map(fingeringPlan.assignments.map(assignment => [assignment.noteId, assignment]));
  return {
    ...document,
    notes: document.notes.map(note => {
      const assignment = assignments.get(note.noteId);
      return assignment ? { ...note, hand: assignment.hand, finger: assignment.finger } : note;
    }),
  };
}
