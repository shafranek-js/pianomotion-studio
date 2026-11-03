/**
 * pedalHold.ts - Physical key-release timing under sustain/sostenuto pedals
 * and unwritten bass pedal-gap heuristics.
 *
 * Adapted from Mizan (MIT License, ui/src/workspace/fingers.ts).
 * Separates the physical finger release time (`fingerEnd`) from the acoustic
 * sounding note duration (`end`), so fingers are freed to travel to subsequent
 * chords when a pedal carries the sound.
 */

export const SUSTAIN_CC = 64;
export const SOSTENUTO_CC = 66;
export const SOFT_CC = 67;

/** Minimum downward leap (in semitones) from subsequent LH notes to infer an unwritten bass pedal hold. */
export const BASS_PEDAL_GAP_SEMITONES = 9;
/** Comfortable single-hand span (in semitones) before a pedal-carried note is released early. */
export const PEDAL_EARLY_RELEASE_SPAN = 12;

const EPS = 1e-6;

export interface PedalSpan {
  /** MIDI CC number (64 = sustain, 66 = sostenuto, 67 = soft). */
  readonly controller: number;
  /** Start time in seconds when pedal was depressed (value >= 64). */
  readonly startSeconds: number;
  /** End time in seconds when pedal was released (value < 64). */
  readonly endSeconds: number;
}

export interface PedalHoldNoteLike {
  readonly pitch: number;
  readonly start: number;
  readonly end: number;
  readonly hand: string | null;
}

export interface ComputeReleaseOptions {
  /**
   * Whether to infer unwritten sustain pedal holds on isolated low left-hand bass notes
   * when the MIDI contains no explicit pedal events. Defaults to true.
   */
  readonly inferBassPedalGap?: boolean;
  /**
   * Minimum span (in semitones) between a held note and newly arriving notes in the same hand
   * that triggers early physical finger release when carried by a pedal. Defaults to 0
   * (any pedal-carried note may be released when new notes arrive in that hand, or set to 12
   * to only release when the hand shifts beyond an octave).
   */
  readonly minShiftSemitones?: number;
}

/**
 * Convert raw `[timeSeconds, controller, value]` control triples (or `{ timeSeconds, controller, value }` objects)
 * into closed `[startSeconds, endSeconds]` active pedal intervals where `value >= 64`.
 */
export function buildPedalSpans(
  controls: ReadonlyArray<
    | readonly [number, number, number]
    | { readonly timeSeconds: number; readonly controller: number; readonly value: number }
  >,
  songDurationSeconds = Infinity,
): PedalSpan[] {
  if (!controls || controls.length === 0) {
    return [];
  }

  const normalized = controls
    .map((item) =>
      Array.isArray(item)
        ? { timeSeconds: item[0], controller: item[1], value: item[2] }
        : {
            timeSeconds: (item as { timeSeconds: number }).timeSeconds,
            controller: (item as { controller: number }).controller,
            value: (item as { value: number }).value,
          },
    )
    .sort((a, b) => a.timeSeconds - b.timeSeconds || a.controller - b.controller);

  const activeStart = new Map<number, number>();
  const spans: PedalSpan[] = [];

  for (const ev of normalized) {
    if (ev.controller !== SUSTAIN_CC && ev.controller !== SOSTENUTO_CC && ev.controller !== SOFT_CC) {
      continue;
    }
    const isDown = ev.value >= 64;
    const prevStart = activeStart.get(ev.controller);
    if (isDown && prevStart === undefined) {
      activeStart.set(ev.controller, ev.timeSeconds);
    } else if (!isDown && prevStart !== undefined) {
      if (ev.timeSeconds > prevStart + EPS) {
        spans.push({
          controller: ev.controller,
          startSeconds: prevStart,
          endSeconds: ev.timeSeconds,
        });
      }
      activeStart.delete(ev.controller);
    }
  }

  for (const [controller, startSeconds] of activeStart.entries()) {
    const endSeconds = Number.isFinite(songDurationSeconds)
      ? Math.max(startSeconds + 0.05, songDurationSeconds)
      : startSeconds + 60;
    spans.push({ controller, startSeconds, endSeconds });
  }

  return spans;
}

/**
 * Whether a pedal carries a held note from `at` until `end`, so the finger that struck it is free at `at`.
 * - Sustain (CC64): the pedal is down by `at` and stays down through `end`, so the key may be released early.
 * - Sostenuto (CC66): the note was already down when the pedal went down (`start <= pedal.startSeconds`),
 *   and the pedal stays down through `end`.
 * - Soft pedal (CC67): never carries notes.
 */
export function pedalCarries(
  pedals: readonly PedalSpan[] | undefined,
  start: number,
  end: number,
  at: number,
): boolean {
  if (!pedals || pedals.length === 0) {
    return false;
  }
  for (const pedal of pedals) {
    const stop = pedal.endSeconds;
    if (pedal.startSeconds > at + EPS || stop < end - EPS || stop <= at + EPS) {
      continue;
    }
    if (pedal.controller === SUSTAIN_CC && stop >= start) {
      return true;
    }
    if (
      pedal.controller === SOSTENUTO_CC &&
      start <= pedal.startSeconds + EPS &&
      end > pedal.startSeconds + EPS
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether an unwritten sustain pedal hold should be inferred for a held left-hand bass note
 * when new left-hand notes arrive at least `BASS_PEDAL_GAP_SEMITONES` (9 semitones) above it.
 */
export function inferBassPedalGap(
  notePitch: number,
  onsetNoteCount: number,
  arrivingLowestPitch: number,
  hasWrittenPedals: boolean,
  isLeftHand: boolean,
): boolean {
  if (!isLeftHand || hasWrittenPedals || onsetNoteCount !== 1) {
    return false;
  }
  return Math.round(notePitch) <= Math.round(arrivingLowestPitch) - BASS_PEDAL_GAP_SEMITONES;
}

function normalizeHandSide(hand: string | null | undefined): "left" | "right" | null {
  if (!hand) return null;
  const h = hand.toLowerCase();
  if (h === "l" || h === "left") return "left";
  if (h === "r" || h === "right") return "right";
  return null;
}

/**
 * Compute early physical finger release times (`Map<Note, number>`) for notes carried by
 * sustain/sostenuto pedals or inferred left-hand bass pedal gaps.
 * Sounding durations (`note.end`) are never altered.
 */
export function computePhysicalReleaseTimes<T extends PedalHoldNoteLike>(
  notes: readonly T[],
  pedals?: readonly PedalSpan[],
  options: ComputeReleaseOptions = {},
): Map<T, number> {
  const releases = new Map<T, number>();
  const allowBassGap = options.inferBassPedalGap ?? true;
  const minShift = options.minShiftSemitones ?? 0;
  const hasWrittenPedals = Boolean(pedals && pedals.length > 0);

  for (const side of ["left", "right"] as const) {
    const mine = notes
      .filter((note) => normalizeHandSide(note.hand) === side && note.end > note.start + EPS)
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);

    if (mine.length === 0) continue;

    // Group onsets within EPS to count how many notes started together in this hand
    const onsetCounts = new Map<T, number>();
    for (let i = 0; i < mine.length; ) {
      let j = i + 1;
      while (j < mine.length && mine[j]!.start - mine[i]!.start < 1e-3) {
        j++;
      }
      const count = j - i;
      for (let k = i; k < j; k++) {
        onsetCounts.set(mine[k]!, count);
      }
      i = j;
    }

    let active: T[] = [];
    for (let first = 0; first < mine.length; ) {
      let last = first + 1;
      while (last < mine.length && mine[last]!.start - mine[first]!.start < 1e-3) {
        last++;
      }
      const arriving = mine.slice(first, last);
      const at = mine[first]!.start;
      const keys = new Set(arriving.map((n) => Math.round(n.pitch)));
      const low = Math.min(...keys);
      const high = Math.max(...keys);

      active = active.filter((note) => {
        const end = note.end;
        if (end <= at + EPS) {
          return false;
        }
        const pitch = Math.round(note.pitch);
        const spanToArriving = Math.max(Math.abs(high - pitch), Math.abs(pitch - low));
        const shiftExceedsMin = minShift <= 0 || spanToArriving > minShift || keys.has(pitch);
        const carriedByPedal =
          shiftExceedsMin && pedalCarries(pedals, note.start, end, at);
        const inferredBass =
          allowBassGap &&
          shiftExceedsMin &&
          inferBassPedalGap(
            pitch,
            onsetCounts.get(note) ?? 1,
            low,
            hasWrittenPedals,
            side === "left",
          );

        if (keys.has(pitch) || carriedByPedal || inferredBass) {
          releases.set(note, at);
          return false;
        }
        return true;
      });

      active.push(...arriving);
      first = last;
    }
  }

  return releases;
}
