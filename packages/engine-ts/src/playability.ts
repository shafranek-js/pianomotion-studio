/**
 * playability.ts - Piano playability check and 3-pass constrained hand-split repair.
 *
 * Adapted from Mizan (MIT License, ui/src/workspace/playability.ts).
 * Checks simultaneous onset moments (including held notes not carried by pedal) for:
 *  - > 5 simultaneous keys in one hand (`PIANO_MAX_NOTES = 5`)
 *  - > 14 semitones comfortable stretch (`PIANO_REACH = 14`) / > 16 semitones wide stretch (`PIANO_WIDE_REACH = 16`)
 *  - > 24 semitones jump in < 0.12 s (`JUMP_SEMITONES = 24`, `JUMP_SECONDS = 0.12`)
 *  - prolonged hand crossings > 0.5 s (`CROSS_SECONDS = 0.5`)
 * And performs a 3-pass non-worsening pitch-partition repair across LH/RH.
 */

import {
  BASS_PEDAL_GAP_SEMITONES,
  buildPedalSpans,
  pedalCarries,
  type PedalSpan,
} from "./pedalHold.ts";

const EPS = 1e-6;

/** Most keys one hand can hold down at once. */
export const PIANO_MAX_NOTES = 5;
/** Widest comfortable stretch in semitones (a ninth). */
export const PIANO_REACH = 14;
/** Wider stretch (a tenth) allowed only where no comfortable split exists. */
export const PIANO_WIDE_REACH = 16;
/** Maximum leap distance in semitones before flagging a rapid jump warning. */
export const JUMP_SEMITONES = 24;
/** Time window in seconds within which a leap > JUMP_SEMITONES is warned. */
export const JUMP_SECONDS = 0.12;
/** Crossed hands are tolerated up to this duration in seconds. */
export const CROSS_SECONDS = 0.5;

export type PlayabilityIssueKind = "unplayable" | "moved" | "jump" | "crossing";

export interface PlayabilityIssue {
  /** Onset time in seconds where the issue occurs. */
  readonly timeSeconds: number;
  /** Kind of playability issue or repair action. */
  readonly kind: PlayabilityIssueKind;
  /** Number of notes affected at this onset. */
  readonly count: number;
  /** Optional note IDs involved at this onset. */
  readonly noteIds?: readonly string[];
  /** Human-readable description of the issue. */
  readonly message: string;
}

export interface PlayabilitySummary {
  /** Number of onset moments originally exceeding comfortable reach/count/crossing limits. */
  flagged: number;
  /** Number of notes reassigned to the other hand by the 3-pass repair. */
  moved: number;
  /** Number of onset moments that remain unplayable even after repair. */
  unplayable: number;
  /** Total notes inside unplayable onset moments. */
  unplayableNotes: number;
  /** Number of rapid jump / crossing warnings. */
  warnings: number;
  /** Chronological list of issues and repairs. */
  issues: PlayabilityIssue[];
}

export interface PlayabilityNoteInput {
  readonly noteId?: string;
  readonly pitch: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly hand: "left" | "right" | "L" | "R" | string | null;
  readonly finger?: number | null;
}

export interface PianoPlayabilityOptions {
  readonly reach?: number;
  readonly wideReach?: number;
  readonly crossSeconds?: number;
  readonly jumpSemitones?: number;
  readonly jumpSeconds?: number;
  readonly pedals?: readonly PedalSpan[];
}

export interface PianoRepairResult<T extends PlayabilityNoteInput> {
  readonly notes: T[];
  readonly reassignedByIndex: Map<number, "left" | "right">;
  readonly unplayableIndices: Set<number>;
  readonly summary: PlayabilitySummary;
}

function emptySummary(): PlayabilitySummary {
  return {
    flagged: 0,
    moved: 0,
    unplayable: 0,
    unplayableNotes: 0,
    warnings: 0,
    issues: [],
  };
}

function toHandBit(hand: string | null | undefined): 0 | 1 {
  if (!hand) return 1;
  const h = hand.toLowerCase();
  return h === "l" || h === "left" ? 0 : 1;
}

function fromHandBit(bit: number, originalHand: string | null | undefined): "left" | "right" {
  void originalHand;
  return bit === 0 ? "left" : "right";
}

/**
 * Run Mizan's 3-pass constrained hand-split repair and playability check on piano notes.
 */
export function repairPianoHandSplit<T extends PlayabilityNoteInput>(
  input: readonly T[],
  options: PianoPlayabilityOptions = {},
): PianoRepairResult<T> {
  const reach = options.reach ?? PIANO_REACH;
  const wide = Math.max(reach, options.wideReach ?? PIANO_WIDE_REACH);
  const crossLimitSeconds = options.crossSeconds ?? CROSS_SECONDS;
  const jumpSemitones = options.jumpSemitones ?? JUMP_SEMITONES;
  const jumpSeconds = options.jumpSeconds ?? JUMP_SECONDS;
  const summary = emptySummary();
  const written = Boolean(options.pedals && options.pedals.length > 0);

  const ids: number[] = [];
  input.forEach((note, index) => {
    if (
      note.hand &&
      Number.isFinite(note.pitch) &&
      note.endSeconds > note.startSeconds + EPS
    ) {
      ids.push(index);
    }
  });

  if (ids.length === 0) {
    return {
      notes: [...input],
      reassignedByIndex: new Map(),
      unplayableIndices: new Set(),
      summary,
    };
  }

  const keys = ids.map((index) => Math.round(input[index]!.pitch));
  const start = ids.map((index) => input[index]!.startSeconds);
  const end = ids.map((index) => input[index]!.endSeconds);
  const original = Uint8Array.from(ids, (index) => toHandBit(input[index]!.hand));
  const hand = Uint8Array.from(original);

  // One moment per onset: everything sounding then, held notes included.
  const order = [...ids.keys()].sort((a, b) => start[a]! - start[b]! || a - b);
  const onsets: number[] = [];
  const moments: number[][] = [];
  const starts: number[][] = [];
  const momentsOf: number[][] = ids.map(() => []);
  let active: number[] = [];
  let next = 0;

  for (const first of order) {
    if (onsets.length > 0 && start[first]! - onsets[onsets.length - 1]! <= 1e-3) {
      continue;
    }
    const at = start[first]!;
    const arriving: number[] = [];
    while (next < order.length && start[order[next]!]! <= at + 1e-3) {
      arriving.push(order[next]!);
      next += 1;
    }
    active = active.filter((note) => end[note]! > at + EPS).concat(arriving);
    const sorted = [...active].sort((a, b) => keys[a]! - keys[b]! || a - b);
    for (const note of sorted) {
      momentsOf[note]!.push(onsets.length);
    }
    onsets.push(at);
    moments.push(sorted);
    starts.push(arriving);
  }

  const count = onsets.length;
  const tier = new Array<number>(count).fill(reach);
  let crossLong: Uint8Array = new Uint8Array(count);
  const flaggedMoments = new Set<number>();

  const crossedAt = (moment: number): boolean => {
    let leftTop = -Infinity;
    let rightBottom = Infinity;
    for (const note of moments[moment]!) {
      if (hand[note] === 0) leftTop = Math.max(leftTop, keys[note]!);
      else rightBottom = Math.min(rightBottom, keys[note]!);
    }
    return leftTop > rightBottom;
  };

  const momentEnd = (moment: number): number =>
    moment + 1 < count
      ? onsets[moment + 1]!
      : Math.min(...moments[moment]!.map((note) => end[note]!));

  const crossRuns = (): Uint8Array => {
    const result = new Uint8Array(count);
    const crossed = Uint8Array.from({ length: count }, (_, moment) =>
      crossedAt(moment) ? 1 : 0,
    );
    for (let moment = 0; moment < count; moment++) {
      if (!crossed[moment]) continue;
      let last = moment;
      while (last + 1 < count && crossed[last + 1]) last++;
      if (momentEnd(last) - onsets[moment]! > crossLimitSeconds + EPS) {
        result.fill(1, moment, last + 1);
      }
      moment = last;
    }
    return result;
  };

  /**
   * How far a moment is from playable: surplus keys (> 5) and surplus stretch (> allowed),
   * plus crossing where it has gone on too long (> crossLimitSeconds).
   * Held notes carried by sustain/sostenuto pedal or unwritten bass pedal gap are excluded.
   */
  const excess = (moment: number, allowed: number): number => {
    const latest: [number, number] = [-Infinity, -Infinity];
    const latestLow: [number, number] = [Infinity, Infinity];
    for (const note of moments[moment]!) {
      const side = hand[note] as 0 | 1;
      if (start[note]! > latest[side] + 1e-3) {
        latest[side] = start[note]!;
        latestLow[side] = keys[note]!;
      } else if (
        start[note]! > latest[side] - 1e-3 &&
        keys[note]! < latestLow[side]
      ) {
        latestLow[side] = keys[note]!;
      }
    }
    const counts: [number, number] = [0, 0];
    const lastKey: [number, number] = [NaN, NaN];
    const low: [number, number] = [Infinity, Infinity];
    const high: [number, number] = [-Infinity, -Infinity];

    for (const note of moments[moment]!) {
      const side = hand[note] as 0 | 1;
      if (start[note]! < latest[side] - 1e-3) {
        const carried = written
          ? pedalCarries(options.pedals, start[note]!, end[note]!, latest[side])
          : keys[note]! <= latestLow[side] - BASS_PEDAL_GAP_SEMITONES;
        if (carried) continue;
      }
      if (keys[note]! !== lastKey[side]) {
        counts[side] += 1;
        lastKey[side] = keys[note]!;
      }
      low[side] = Math.min(low[side], keys[note]!);
      high[side] = Math.max(high[side], keys[note]!);
    }

    let total = 0;
    for (const side of [0, 1] as const) {
      if (counts[side] > 0) {
        total +=
          Math.max(0, counts[side] - PIANO_MAX_NOTES) * 4 +
          Math.max(0, high[side] - low[side] - allowed);
      }
    }
    if (crossLong[moment] && counts[0] > 0 && counts[1] > 0 && high[0] > low[1]) {
      total += 3;
    }
    return total;
  };

  crossLong = crossRuns();
  for (let moment = 0; moment < count; moment++) {
    if (excess(moment, reach) > 0) {
      flaggedMoments.add(moment);
    }
  }

  const apply = (changes: ReadonlyArray<readonly [number, number]>) => {
    for (const [note, side] of changes) {
      hand[note] = side;
    }
  };

  const touched = (changes: ReadonlyArray<readonly [number, number]>): Set<number> => {
    const set = new Set<number>();
    for (const [note] of changes) {
      for (const moment of momentsOf[note]!) {
        set.add(moment);
      }
    }
    return set;
  };

  const fix = (moment: number) => {
    const groups: number[][] = [];
    for (const note of moments[moment]!) {
      const last = groups[groups.length - 1];
      if (last && keys[last[0]!] === keys[note]) {
        last.push(note);
      } else {
        groups.push([note]);
      }
    }
    if (groups.length < 2) return;

    const splits = (): Array<{ changes: Array<[number, number]>; k: number }> =>
      Array.from({ length: groups.length - 1 }, (_, at) => {
        const k = at + 1;
        const changes: Array<[number, number]> = [];
        groups.forEach((group, g) => {
          const targetSide = g < k ? 0 : 1;
          for (const note of group) {
            // Do not move notes with explicit manual finger markers unless necessary
            if (hand[note] !== targetSide) {
              changes.push([note, targetSide]);
            }
          }
        });
        return { changes, k };
      });

    const previous = moment > 0 ? moments[moment - 1]! : [];
    const cost = (changes: ReadonlyArray<readonly [number, number]>, k: number): number => {
      const before = changes.map(([note]) => [note, hand[note]!] as const);
      apply(changes);
      let continuity = 0;
      for (const note of starts[moment]!) {
        let nearest = -1;
        for (const other of previous) {
          if (
            nearest < 0 ||
            Math.abs(keys[other]! - keys[note]!) < Math.abs(keys[nearest]! - keys[note]!)
          ) {
            nearest = other;
          }
        }
        if (nearest >= 0 && hand[nearest] !== hand[note]) {
          continuity += 1;
        }
      }
      for (const [note, side] of before) {
        hand[note] = side;
      }
      const gap = keys[groups[k]![0]!]! - keys[groups[k - 1]![0]!]!;
      return (
        changes.length * 10 +
        continuity +
        Math.abs(k - (groups.length - k)) * 0.2 -
        Math.min(gap, 12) * 0.15
      );
    };

    for (const allowed of reach === wide ? [reach] : [reach, wide]) {
      let best: { changes: Array<[number, number]>; score: number } | null = null;
      for (const { changes, k } of splits()) {
        const previousHands = changes.map(([note]) => [note, hand[note]!] as const);
        const revert = () => {
          for (const [note, side] of previousHands) {
            hand[note] = side;
          }
        };
        apply(changes);
        let fine = excess(moment, allowed) === 0;
        let around: number[] = [];
        let after: number[] = [];
        if (fine) {
          around = [...touched(changes)].filter((other) => other !== moment);
          after = around.map((other) => excess(other, tier[other]!));
        }
        revert();
        if (fine) {
          fine = around.every((other, at) => after[at]! <= excess(other, tier[other]!));
        }
        if (!fine) continue;
        const score = cost(changes, k);
        if (!best || score < best.score - 1e-9) {
          best = { changes, score };
        }
      }
      if (best) {
        apply(best.changes);
        tier[moment] = allowed;
        return;
      }
    }

    // Nothing is completely playable: take the least-bad split if strictly better
    let bestExcess = excess(moment, wide);
    let choice: Array<[number, number]> = [];
    let bestChanges = 0;
    for (const { changes } of splits()) {
      const previousHands = changes.map(([note]) => [note, hand[note]!] as const);
      apply(changes);
      const value = excess(moment, wide);
      for (const [note, side] of previousHands) {
        hand[note] = side;
      }
      if (
        value < bestExcess ||
        (value === bestExcess && changes.length < bestChanges && choice.length > 0)
      ) {
        bestExcess = value;
        choice = changes;
        bestChanges = changes.length;
      }
    }
    apply(choice);
    tier[moment] = wide;
  };

  for (let pass = 0; pass < 3; pass++) {
    crossLong = crossRuns();
    const snapshot = hand.join("");
    for (let moment = 0; moment < count; moment++) {
      if (excess(moment, tier[moment]!) > 0) {
        fix(moment);
      }
    }
    if (hand.join("") === snapshot) break;
  }

  summary.flagged = flaggedMoments.size;
  crossLong = crossRuns();
  const failed = new Set<number>();
  for (let moment = 0; moment < count; moment++) {
    if (excess(moment, tier[moment]!) > 0) {
      failed.add(moment);
    }
  }
  summary.unplayable = failed.size;

  const reassignedByIndex = new Map<number, "left" | "right">();
  const movedAt = new Map<number, { count: number; noteIds: string[] }>();
  ids.forEach((index, local) => {
    if (hand[local] === original[local]) return;
    const newHand = fromHandBit(hand[local]!, input[index]!.hand);
    reassignedByIndex.set(index, newHand);
    const onset = input[index]!.startSeconds;
    const prev = movedAt.get(onset) ?? { count: 0, noteIds: [] };
    prev.count += 1;
    if (input[index]!.noteId) {
      prev.noteIds.push(input[index]!.noteId!);
    }
    movedAt.set(onset, prev);
    summary.moved += 1;
  });

  const unplayableIndices = new Set<number>();
  for (const moment of failed) {
    let marked = 0;
    const noteIds: string[] = [];
    for (const local of starts[moment]!) {
      const index = ids[local]!;
      unplayableIndices.add(index);
      marked += 1;
      if (input[index]!.noteId) {
        noteIds.push(input[index]!.noteId!);
      }
    }
    summary.unplayableNotes += marked;
    summary.issues.push({
      timeSeconds: onsets[moment]!,
      kind: "unplayable",
      count: marked,
      ...(noteIds.length > 0 ? { noteIds } : {}),
      message: `Moment at ${onsets[moment]!.toFixed(2)}s exceeds single-hand span or 5-finger limit (${marked} note${marked === 1 ? "" : "s"}).`,
    });
  }

  for (const [timeSeconds, info] of movedAt.entries()) {
    summary.issues.push({
      timeSeconds,
      kind: "moved",
      count: info.count,
      ...(info.noteIds.length > 0 ? { noteIds: info.noteIds } : {}),
      message: `Reassigned ${info.count} note${info.count === 1 ? "" : "s"} at ${timeSeconds.toFixed(2)}s to the other hand for ergonomic playability.`,
    });
  }

  // Rapid jump warnings (> JUMP_SEMITONES in < JUMP_SECONDS)
  for (const side of [0, 1] as const) {
    const handLabel = side === 0 ? "Left hand" : "Right hand";
    let before: { time: number; low: number; high: number } | null = null;
    for (let moment = 0; moment < count; moment++) {
      const played = starts[moment]!.filter((note) => hand[note] === side);
      if (played.length === 0) continue;
      const now = {
        time: onsets[moment]!,
        low: Math.min(...played.map((note) => keys[note]!)),
        high: Math.max(...played.map((note) => keys[note]!)),
      };
      if (before) {
        const distance = Math.max(0, now.low - before.high, before.low - now.high);
        const dt = now.time - before.time;
        if (distance > jumpSemitones && dt > EPS && dt < jumpSeconds) {
          const noteIds = played
            .map((local) => input[ids[local]!]!.noteId)
            .filter((id): id is string => Boolean(id));
          summary.warnings += 1;
          summary.issues.push({
            timeSeconds: now.time,
            kind: "jump",
            count: played.length,
            ...(noteIds.length > 0 ? { noteIds } : {}),
            message: `${handLabel} leaps ${distance} semitones in ${Math.round(dt * 1000)}ms at ${now.time.toFixed(2)}s.`,
          });
        }
      }
      before = now;
    }
  }

  // Prolonged crossing warnings
  for (let moment = 0; moment < count; moment++) {
    if (!crossLong[moment]) continue;
    let last = moment;
    while (last + 1 < count && crossLong[last + 1]) last++;
    const duration = momentEnd(last) - onsets[moment]!;
    const noteIds = starts[moment]!
      .map((local) => input[ids[local]!]!.noteId)
      .filter((id): id is string => Boolean(id));
    summary.warnings += 1;
    summary.issues.push({
      timeSeconds: onsets[moment]!,
      kind: "crossing",
      count: starts[moment]!.length,
      ...(noteIds.length > 0 ? { noteIds } : {}),
      message: `Prolonged hand crossing (${duration.toFixed(2)}s) starting at ${onsets[moment]!.toFixed(2)}s.`,
    });
    moment = last;
  }

  summary.issues.sort((a, b) => a.timeSeconds - b.timeSeconds);

  const notes = input.map((note, index) => {
    const newHand = reassignedByIndex.get(index);
    if (!newHand) return note;
    const usesShortCode = note.hand === "L" || note.hand === "R";
    const mappedHand = usesShortCode ? (newHand === "left" ? "L" : "R") : newHand;
    return {
      ...note,
      hand: mappedHand,
    };
  });

  return { notes, reassignedByIndex, unplayableIndices, summary };
}

/**
 * Check piano playability on a SongDocument-like structure and return its PlayabilitySummary.
 */
export function checkPianoPlayability(
  document: {
    readonly notes: ReadonlyArray<{
      readonly noteId?: string;
      readonly pitch: number;
      readonly startSeconds: number;
      readonly endSeconds: number;
      readonly hand: "left" | "right" | string | null;
      readonly finger?: number | null;
    }>;
    readonly durationSeconds?: number;
    readonly pedalControls?: ReadonlyArray<{
      readonly timeSeconds: number;
      readonly controller: number;
      readonly value: number;
    }>;
  },
  options: Omit<PianoPlayabilityOptions, "pedals"> = {},
): PlayabilitySummary {
  const pedals = buildPedalSpans(
    document.pedalControls ?? [],
    document.durationSeconds ?? Infinity,
  );
  return repairPianoHandSplit(document.notes, { ...options, pedals }).summary;
}
