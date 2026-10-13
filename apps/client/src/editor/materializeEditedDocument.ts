import {
  FingeringPlanSchema,
  SongDocumentSchema,
  type FingeringPlan,
  type SongDocument,
} from "@handthesia/contracts";

/**
 * Applies fingering-editor intents to the editable SongDocument while keeping
 * decoded note IDs and all source timing, pitch, track, and event aliases.
 */
export function materializeEditedDocument(
  document: SongDocument,
  draftPlan: FingeringPlan,
): SongDocument {
  SongDocumentSchema.parse(document);
  const source = document;
  const plan = FingeringPlanSchema.parse(draftPlan);
  if (plan.projectId !== source.projectId || plan.inputRevision !== source.revision) {
    throw new Error("The fingering draft and document must share projectId and revision.");
  }

  const noteIds = new Set(source.notes.map((note) => note.noteId));
  const assignmentByNoteId = new Map(plan.assignments.map((assignment) => [assignment.noteId, assignment]));
  if (assignmentByNoteId.size !== plan.assignments.length || assignmentByNoteId.size !== noteIds.size ||
      [...noteIds].some((noteId) => !assignmentByNoteId.has(noteId)) ||
      plan.assignments.some((assignment) => !noteIds.has(assignment.noteId))) {
    throw new Error("The fingering draft must assign every document note exactly once.");
  }

  const notes = source.notes.map((note) => {
    const assignment = assignmentByNoteId.get(note.noteId)!;
    if (assignment.fingerMode === "manual" &&
        (assignment.disposition !== "played" || assignment.finger === null)) {
      throw new Error(`Played note ${note.noteId} needs a concrete draft finger.`);
    }
    const finger = assignment.fingerMode === "manual"
      ? assignment.finger
      : assignment.fingerMode === "automatic" ? null : note.finger;
    return {
      ...note,
      hand: assignment.hand,
      finger,
      glissando: assignment.glissMode === "manual"
        ? assignment.disposition === "glissando"
        : note.glissando,
    };
  });

  const materialized = { ...source, notes };
  SongDocumentSchema.parse(materialized);
  return materialized;
}
