import type {
  FingeringAssignment,
  FingeringPlan,
} from "@handthesia/contracts";
import type { EditorAction, Hand } from "./types";

/**
 * Creates an EditorAction that assigns the specified hand ("left" | "right")
 * to the specified note IDs.
 *
 * All matching notes have their hand set; other notes remain untouched.
 * The FingeringPlan inputRevision is incremented.
 */
export function createAssignHandCommand(
  noteIds: string[],
  hand: Hand,
): EditorAction {
  const targetIdSet = new Set(noteIds);
  return {
    type: "ASSIGN_HAND",
    description: `Assign hand ${hand} to ${noteIds.length} note(s)`,
    apply(plan: FingeringPlan): FingeringPlan {
      const assignments: FingeringAssignment[] = plan.assignments.map(
        (assignment) => {
          if (targetIdSet.has(assignment.noteId)) {
            return {
              ...assignment,
              hand,
            };
          }
          return assignment;
        },
      );

      return {
        ...plan,
        inputRevision: plan.inputRevision + 1,
        assignments,
      };
    },
  };
}

/**
 * Creates an EditorAction that assigns a finger (1..5 or null) to the specified note IDs.
 *
 * A numeric finger is a manual override. `null` clears that override and
 * returns the note to automatic planning; use the explicit unplayable command
 * when the note should be omitted from performance.
 * The FingeringPlan inputRevision is incremented.
 */
export function createAssignFingerCommand(
  noteIds: string[],
  finger: number | null,
): EditorAction {
  const targetIdSet = new Set(noteIds);
  return {
    type: "ASSIGN_FINGER",
    description: `Assign finger ${finger ?? "none"} to ${noteIds.length} note(s)`,
    fingerAssignment: { noteIds: [...noteIds], finger },
    apply(plan: FingeringPlan): FingeringPlan {
      const assignments: FingeringAssignment[] = plan.assignments.map(
        (assignment) => {
          if (targetIdSet.has(assignment.noteId)) {
            if (finger === null) {
              return {
                ...assignment,
                finger: assignment.disposition === "glissando" ? null : assignment.finger ?? 1,
                disposition: assignment.disposition === "glissando" ? "glissando" as const : "played" as const,
                fingerMode: "automatic" as const,
              };
            }
            return {
              ...assignment,
              finger,
              disposition: "played" as const,
              fingerMode: "manual" as const,
              glissMode: "manual" as const,
            };
          }
          return assignment;
        },
      );

      return {
        ...plan,
        inputRevision: plan.inputRevision + 1,
        assignments,
      };
    },
  };
}

/**
 * Creates an EditorAction that toggles glissando disposition on the specified note IDs.
 *
 * When turning glissando ON: finger is cleared to null and disposition is "glissando".
 * When turning glissando OFF: disposition becomes "played" and finger is restored/defaulted.
 * The FingeringPlan inputRevision is incremented.
 */
export function createToggleGlissandoCommand(
  noteIds: string[],
): EditorAction {
  const targetIdSet = new Set(noteIds);
  return {
    type: "TOGGLE_GLISSANDO",
    description: `Toggle glissando on ${noteIds.length} note(s)`,
    apply(plan: FingeringPlan): FingeringPlan {
      const assignments: FingeringAssignment[] = plan.assignments.map(
        (assignment) => {
          if (targetIdSet.has(assignment.noteId)) {
            const isGliss = assignment.disposition === "glissando";
            if (isGliss) {
              return {
                ...assignment,
                finger: assignment.finger ?? 1,
                disposition: "played" as const,
                fingerMode: "automatic" as const,
                glissMode: "manual" as const,
              };
            }
            return {
              ...assignment,
              finger: null,
              disposition: "glissando" as const,
              fingerMode: "automatic" as const,
              glissMode: "manual" as const,
            };
          }
          return assignment;
        },
      );

      return {
        ...plan,
        inputRevision: plan.inputRevision + 1,
        assignments,
      };
    },
  };
}

/**
 * Creates an EditorAction that clears manual fingering and returns the notes
 * to automatic planning. The visible finger remains until the Worker responds.
 * The FingeringPlan inputRevision is incremented.
 */
export function createClearFingeringCommand(
  noteIds: string[],
): EditorAction {
  const targetIdSet = new Set(noteIds);
  return {
    type: "CLEAR_FINGERING",
    description: `Clear fingering on ${noteIds.length} note(s)`,
    apply(plan: FingeringPlan): FingeringPlan {
      const assignments: FingeringAssignment[] = plan.assignments.map(
        (assignment) => {
          if (targetIdSet.has(assignment.noteId)) {
            return {
              ...assignment,
              finger: assignment.disposition === "glissando" ? null : assignment.finger ?? 1,
              disposition: assignment.disposition === "glissando" ? "glissando" as const : "played" as const,
              fingerMode: "automatic" as const,
            };
          }
          return assignment;
        },
      );

      return {
        ...plan,
        inputRevision: plan.inputRevision + 1,
        assignments,
      };
    },
  };
}

/** Explicitly excludes selected notes from the generated performance. */
export function createMarkUnplayableCommand(noteIds: string[]): EditorAction {
  const targetIdSet = new Set(noteIds);
  return {
    type: "MARK_UNPLAYABLE",
    description: `Mark ${noteIds.length} note(s) unplayable`,
    apply(plan: FingeringPlan): FingeringPlan {
      return {
        ...plan,
        inputRevision: plan.inputRevision + 1,
        assignments: plan.assignments.map((assignment) => targetIdSet.has(assignment.noteId)
          ? { ...assignment, finger: null, fingerMode: "automatic" as const, glissMode: "manual" as const, disposition: "unplayable" as const }
          : assignment),
      };
    },
  };
}

/**
 * Creates an EditorAction that applies batch modifications to multiple notes.
 */
export function createBatchAssignCommand(
  updates: Array<{
    noteId: string;
    hand?: Hand;
    finger?: number | null;
    fingerMode?: FingeringAssignment["fingerMode"];
    glissMode?: FingeringAssignment["glissMode"];
    disposition?: FingeringAssignment["disposition"];
  }>,
): EditorAction {
  const updateMap = new Map(updates.map((u) => [u.noteId, u]));
  return {
    type: "BATCH_ASSIGN",
    description: `Batch update ${updates.length} note assignment(s)`,
    apply(plan: FingeringPlan): FingeringPlan {
      const assignments: FingeringAssignment[] = plan.assignments.map(
        (assignment) => {
          const update = updateMap.get(assignment.noteId);
          if (!update) return assignment;

          const hand = update.hand ?? assignment.hand;
          const requestedFinger =
            update.finger !== undefined ? update.finger : assignment.finger;
          const clearsToAutomatic = update.finger === null && update.disposition === undefined;
          const keepsGlissando = clearsToAutomatic && assignment.disposition === "glissando";
          const finger = clearsToAutomatic
            ? keepsGlissando ? null : assignment.finger ?? 1
            : requestedFinger;
          let disposition = update.disposition ?? (clearsToAutomatic && !keepsGlissando
            ? "played"
            : assignment.disposition);

          if (finger !== null && disposition !== "played") {
            disposition = "played";
          } else if (finger === null && disposition === "played") {
            disposition = "unplayable";
          }

          return {
            ...assignment,
            hand,
            finger,
            fingerMode: update.fingerMode ?? (update.finger !== undefined
              ? update.finger === null ? "automatic" as const : "manual" as const
              : assignment.fingerMode),
            glissMode: update.glissMode ?? (update.disposition !== undefined
              ? "manual" as const
              : update.finger !== undefined && update.finger !== null
              ? "manual" as const
              : assignment.glissMode),
            disposition,
          };
        },
      );

      return {
        ...plan,
        inputRevision: plan.inputRevision + 1,
        assignments,
      };
    },
  };
}
