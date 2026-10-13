import type {
  FingeringPlan,
  SongDocument,
} from "@handthesia/contracts";
import type { DifficultyReport, Hand } from "./types";

const BLACK_KEY_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

function isBlackKey(pitch: number): boolean {
  return BLACK_KEY_PITCH_CLASSES.has(pitch % 12);
}

interface ResolvedNote {
  noteId: string;
  pitch: number;
  startSeconds: number;
  endSeconds: number;
  hand: Hand;
  finger: number | null;
  glissando: boolean;
  unplayable: boolean;
}

/**
 * Calculates difficulty and ergonomic scoring for a song document and its fingering plan.
 *
 * Evaluates:
 * - Max stretch in semitones (concurrent notes in the same hand)
 * - Speed (peak notes per second across 1.0s sliding window)
 * - Hand crossings (left hand pitch exceeding right hand pitch concurrently)
 * - Awkward transitions (thumb on black key crossing, 4-5 trills, inverted finger orders)
 * - Overall score (1.0 to 10.0) and Tier (Beginner, Intermediate, Advanced, Virtuoso)
 */
export function calculateDifficulty(
  document: SongDocument,
  fingeringPlan: FingeringPlan,
): DifficultyReport {
  if (!document.notes || document.notes.length === 0) {
    return {
      overallScore: 1.0,
      tier: "Beginner",
      maxStretchSemitones: 0,
      maxSpeedNotesPerSec: 0,
      handCrossingsCount: 0,
      awkwardFingeringCount: 0,
      summary: "Empty song document: no notes to evaluate.",
    };
  }

  // 1. Resolve effective note attributes merging document with fingeringPlan
  const assignmentMap = new Map(
    fingeringPlan.assignments.map((a) => [a.noteId, a]),
  );

  const resolvedNotes: ResolvedNote[] = document.notes.map((note) => {
    const assignment = assignmentMap.get(note.noteId);
    const hand: Hand = assignment?.hand ?? note.hand;
    const finger = assignment ? assignment.finger : note.finger;
    const disposition = assignment?.disposition;
    const glissando = disposition === "glissando" || (assignment ? false : note.glissando);
    const unplayable = disposition === "unplayable";

    return {
      noteId: note.noteId,
      pitch: note.pitch,
      startSeconds: note.startSeconds,
      endSeconds: note.endSeconds,
      hand,
      finger,
      glissando,
      unplayable,
    };
  });

  const playableNotes = resolvedNotes.filter((n) => !n.unplayable);
  if (playableNotes.length === 0) {
    return {
      overallScore: 1.0,
      tier: "Beginner",
      maxStretchSemitones: 0,
      maxSpeedNotesPerSec: 0,
      handCrossingsCount: 0,
      awkwardFingeringCount: 0,
      summary: "No playable notes in fingering plan.",
    };
  }

  // Sort chronologically
  playableNotes.sort(
    (a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch,
  );

  // 2. Max Hand Stretch (semitones)
  const leftNotes = playableNotes.filter((n) => n.hand === "left");
  const rightNotes = playableNotes.filter((n) => n.hand === "right");

  const computeHandMaxStretch = (notes: ResolvedNote[]): number => {
    let handMax = 0;
    for (let i = 0; i < notes.length; i += 1) {
      const a = notes[i]!;
      for (let j = i + 1; j < notes.length; j += 1) {
        const b = notes[j]!;
        // Check if notes overlap in time or are struck within 50ms (chord)
        const overlaps =
          b.startSeconds < a.endSeconds - 0.001 ||
          Math.abs(b.startSeconds - a.startSeconds) <= 0.05;
        if (!overlaps) {
          // Since sorted by startSeconds, if b starts significantly after a ends, we can break
          if (b.startSeconds >= a.endSeconds + 0.1) break;
          continue;
        }
        const interval = Math.abs(b.pitch - a.pitch);
        if (interval > handMax) {
          handMax = interval;
        }
      }
    }
    return handMax;
  };

  const maxStretchSemitones = Math.max(
    computeHandMaxStretch(leftNotes),
    computeHandMaxStretch(rightNotes),
  );

  // 3. Peak Speed (notes per second)
  let maxSpeedNotesPerSec = 0;
  const windowDuration = 1.0;
  for (let i = 0; i < playableNotes.length; i += 1) {
    const windowStart = playableNotes[i]!.startSeconds;
    const windowEnd = windowStart + windowDuration;
    let count = 0;
    for (let j = i; j < playableNotes.length; j += 1) {
      if (playableNotes[j]!.startSeconds < windowEnd) {
        count += 1;
      } else {
        break;
      }
    }
    if (count > maxSpeedNotesPerSec) {
      maxSpeedNotesPerSec = count;
    }
  }

  // 4. Hand Crossings Count
  // Distinct left hand notes where left hand pitch exceeds concurrent right hand pitch
  const crossingLeftNotes = new Set<string>();
  for (const leftNote of leftNotes) {
    for (const rightNote of rightNotes) {
      const overlaps =
        Math.max(leftNote.startSeconds, rightNote.startSeconds) <
        Math.min(leftNote.endSeconds, rightNote.endSeconds) ||
        Math.abs(leftNote.startSeconds - rightNote.startSeconds) <= 0.05;
      if (overlaps && leftNote.pitch > rightNote.pitch) {
        crossingLeftNotes.add(leftNote.noteId);
      }
    }
  }
  const handCrossingsCount = crossingLeftNotes.size;

  // 5. Awkward Transitions Count
  let awkwardFingeringCount = 0;

  const evaluateAwkwardTransitions = (handNotes: ResolvedNote[], hand: Hand) => {
    for (let i = 0; i < handNotes.length; i += 1) {
      const current = handNotes[i]!;

      // Check concurrent awkward fingerings (inverted fingers within a chord)
      for (let j = i + 1; j < handNotes.length; j += 1) {
        const next = handNotes[j]!;
        const concurrent =
          Math.abs(next.startSeconds - current.startSeconds) <= 0.05 ||
          next.startSeconds < current.endSeconds - 0.01;
        if (!concurrent) break;

        if (current.finger !== null && next.finger !== null) {
          // Right Hand: higher pitch normally has higher finger number
          if (hand === "right") {
            if (current.pitch < next.pitch && current.finger > next.finger) {
              awkwardFingeringCount += 1;
            }
            // Finger 4 and 5 wide stretch (> 4 semitones)
            if (
              ((current.finger === 4 && next.finger === 5) ||
                (current.finger === 5 && next.finger === 4)) &&
              Math.abs(next.pitch - current.pitch) > 4
            ) {
              awkwardFingeringCount += 1;
            }
          }
          // Left Hand: higher pitch normally has lower finger number (pinky 5 lowest pitch, thumb 1 highest pitch)
          if (hand === "left") {
            if (current.pitch < next.pitch && current.finger < next.finger) {
              awkwardFingeringCount += 1;
            }
            if (
              ((current.finger === 4 && next.finger === 5) ||
                (current.finger === 5 && next.finger === 4)) &&
              Math.abs(next.pitch - current.pitch) > 4
            ) {
              awkwardFingeringCount += 1;
            }
          }
        }
      }

      // Check melodic transitions within 0.35 seconds
      if (i + 1 < handNotes.length) {
        const next = handNotes[i + 1]!;
        const dt = next.startSeconds - current.startSeconds;
        if (dt >= 0 && dt <= 0.35) {
          // a) Thumb on black key followed by white key crossing
          if (
            current.finger === 1 &&
            isBlackKey(current.pitch) &&
            !isBlackKey(next.pitch) &&
            next.finger !== null &&
            next.finger >= 2
          ) {
            awkwardFingeringCount += 1;
          }

          // b) 4-5 rapid alternation / trill (dt <= 0.25s)
          if (
            dt <= 0.25 &&
            current.finger !== null &&
            next.finger !== null &&
            ((current.finger === 4 && next.finger === 5) ||
              (current.finger === 5 && next.finger === 4))
          ) {
            awkwardFingeringCount += 1;
          }
        }
      }
    }
  };

  evaluateAwkwardTransitions(leftNotes, "left");
  evaluateAwkwardTransitions(rightNotes, "right");

  // 6. Overall Score & Tier
  // Normalize factors:
  const speedContrib = Math.min(3.5, maxSpeedNotesPerSec * 0.3);
  const stretchContrib = Math.min(3.0, Math.max(0, (maxStretchSemitones - 5) * 0.25));
  const crossingContrib = Math.min(1.8, handCrossingsCount * 0.3);
  const awkwardContrib = Math.min(1.8, awkwardFingeringCount * 0.25);

  const rawScore = 1.0 + speedContrib + stretchContrib + crossingContrib + awkwardContrib;
  const overallScore = Math.max(1.0, Math.min(10.0, Math.round(rawScore * 10) / 10));

  let tier: DifficultyReport["tier"];
  if (overallScore >= 8.5) {
    tier = "Virtuoso";
  } else if (overallScore >= 6.1) {
    tier = "Advanced";
  } else if (overallScore >= 3.5) {
    tier = "Intermediate";
  } else {
    tier = "Beginner";
  }

  const summary = `${tier} piece (Score ${overallScore}/10). Max stretch: ${maxStretchSemitones} semitones, peak speed: ${maxSpeedNotesPerSec} notes/s, crossings: ${handCrossingsCount}, awkward transitions: ${awkwardFingeringCount}.`;

  return {
    overallScore,
    tier,
    maxStretchSemitones,
    maxSpeedNotesPerSec,
    handCrossingsCount,
    awkwardFingeringCount,
    summary,
  };
}
