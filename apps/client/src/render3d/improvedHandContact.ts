export const IMPROVED_HAND_CONTACT_RELEASE_SECONDS = 0.12;
export const KEY_ATTACK_DURATION_SECONDS = 0.032;
export const KEY_RELEASE_DURATION_SECONDS = 0.09;

export interface HandContactNoteLike {
  pitch: number;
  hand: "left" | "right" | null;
  finger: number | null;
  startSeconds: number;
  endSeconds: number;
}

export type KeySurfaceSampler = (pitch: number, worldX: number, worldZ: number) => number | null;

export interface ImprovedHandContactTarget {
  finger: number;
  pitch: number | null;
  sourceStartSeconds: number;
  sourceEndSeconds?: number;
  /** End time of an immediately preceding note on the same finger or pitch (gap <= 0.12 s). */
  prevEndSeconds?: number;
  /** Start time of an immediately following note on the same finger or pitch (gap <= 0.12 s). */
  nextStartSeconds?: number;
  sampleSurfaceYAt: KeySurfaceSampler;
  /** World-space center and top-face bounds for the assigned key, when available. */
  contactCenterX?: number;
  contactMinX?: number;
  contactMaxX?: number;
  contactMinZ?: number;
  contactMaxZ?: number;
}

/**
 * Computes a C1-continuous 0..1 engagement/depression weight for a note at `timeSeconds`.
 * - For isolated notes, returns 1 during [startSeconds, endSeconds] and smoothly decays to 0
 *   over the 120 ms release tail after `endSeconds`.
 * - When another note on the same finger or pitch immediately follows (`nextStartSeconds` within 120 ms
 *   of `endSeconds`), smoothly pre-lifts the finger/key to 0 before `endSeconds` and re-strikes
 *   back to 1 over the initial attack window of the next note (`prevEndSeconds` within 120 ms).
 */
export function computeNoteRearticulationWeight(
  timeSeconds: number,
  startSeconds: number,
  endSeconds: number | undefined,
  prevEndSeconds?: number,
  nextStartSeconds?: number,
): number {
  if (!Number.isFinite(timeSeconds) || !Number.isFinite(startSeconds)) {
    return 1;
  }
  const hasPrev =
    prevEndSeconds !== undefined &&
    Number.isFinite(prevEndSeconds) &&
    startSeconds - prevEndSeconds <= IMPROVED_HAND_CONTACT_RELEASE_SECONDS + 1e-4;
  const hasNext =
    endSeconds !== undefined &&
    Number.isFinite(endSeconds) &&
    nextStartSeconds !== undefined &&
    Number.isFinite(nextStartSeconds) &&
    nextStartSeconds - endSeconds <= IMPROVED_HAND_CONTACT_RELEASE_SECONDS + 1e-4;

  if (endSeconds !== undefined && Number.isFinite(endSeconds) && timeSeconds > endSeconds) {
    if (hasNext) {
      return 0;
    }
    const releaseProgress = Math.max(
      0,
      Math.min(1, (timeSeconds - endSeconds) / IMPROVED_HAND_CONTACT_RELEASE_SECONDS),
    );
    return 1 - releaseProgress * releaseProgress * (3 - 2 * releaseProgress);
  }

  const noteDuration =
    endSeconds !== undefined && Number.isFinite(endSeconds)
      ? Math.max(0.04, endSeconds - startSeconds)
      : 0.3;

  let weight = 1;

  if (hasPrev) {
    const attackDuration = Math.min(0.045, noteDuration * 0.25);
    if (timeSeconds < startSeconds + attackDuration) {
      const u = Math.max(0, Math.min(1, (timeSeconds - startSeconds) / Math.max(1e-4, attackDuration)));
      weight = Math.min(weight, u * u * (3 - 2 * u));
    }
  }

  if (hasNext && endSeconds !== undefined) {
    const gapAfter = Math.max(0, nextStartSeconds! - endSeconds);
    const preLiftLead = Math.min(noteDuration * 0.35, Math.max(0.025, 0.075 - gapAfter * 0.6));
    const liftStart = endSeconds - preLiftLead;
    if (timeSeconds > liftStart) {
      const u = Math.max(0, Math.min(1, (timeSeconds - liftStart) / Math.max(1e-4, preLiftLead)));
      const s = u * u * (3 - 2 * u);
      weight = Math.min(weight, 1 - s);
    }
  }

  return weight;
}

/**
 * Computes the physical 0..1 key depression weight for a 3D piano key at `timeSeconds`:
 * - Smooth downward attack stroke (0.15 -> 1.0) over the first ~32 ms of a note press.
 * - Full depression (1.0) during the note body.
 * - Pre-lift to rest (0.02) and re-strike when another note on the same pitch follows within 120 ms.
 * - Smooth upward return to rest (1.0 -> 0.0) over 90 ms after `endSeconds` when released.
 */
export function computeKeyDepressionWeight(
  timeSeconds: number,
  startSeconds: number,
  endSeconds: number | undefined,
  prevEndSeconds?: number,
  nextStartSeconds?: number,
): number {
  if (!Number.isFinite(timeSeconds) || !Number.isFinite(startSeconds)) {
    return 1;
  }
  const hasPrev =
    prevEndSeconds !== undefined &&
    Number.isFinite(prevEndSeconds) &&
    startSeconds - prevEndSeconds <= IMPROVED_HAND_CONTACT_RELEASE_SECONDS + 1e-4;
  const hasNext =
    endSeconds !== undefined &&
    Number.isFinite(endSeconds) &&
    nextStartSeconds !== undefined &&
    Number.isFinite(nextStartSeconds) &&
    nextStartSeconds - endSeconds <= IMPROVED_HAND_CONTACT_RELEASE_SECONDS + 1e-4;

  if (endSeconds !== undefined && Number.isFinite(endSeconds) && timeSeconds >= endSeconds) {
    if (hasNext) {
      return 0;
    }
    const releaseProgress = Math.max(
      0,
      Math.min(1, (timeSeconds - endSeconds) / KEY_RELEASE_DURATION_SECONDS),
    );
    const s = releaseProgress * releaseProgress * (3 - 2 * releaseProgress);
    return 1 - s;
  }

  const noteDuration =
    endSeconds !== undefined && Number.isFinite(endSeconds)
      ? Math.max(0.04, endSeconds - startSeconds)
      : 0.3;

  let weight = 1;

  if (hasPrev) {
    const attackDuration = Math.min(0.045, noteDuration * 0.25);
    if (timeSeconds < startSeconds + attackDuration) {
      const u = Math.max(0, Math.min(1, (timeSeconds - startSeconds) / Math.max(1e-4, attackDuration)));
      const s = u * u * (3 - 2 * u);
      weight = Math.min(weight, 0.02 + 0.98 * s);
    }
  } else {
    const attackDuration = Math.min(KEY_ATTACK_DURATION_SECONDS, noteDuration * 0.25);
    if (timeSeconds < startSeconds + attackDuration) {
      const u = Math.max(0, Math.min(1, (timeSeconds - startSeconds) / Math.max(1e-4, attackDuration)));
      const s = u * u * (3 - 2 * u);
      weight = Math.min(weight, 0.15 + 0.85 * s);
    }
  }

  if (hasNext && endSeconds !== undefined) {
    const gapAfter = Math.max(0, nextStartSeconds! - endSeconds);
    const preLiftLead = Math.min(noteDuration * 0.35, Math.max(0.025, 0.075 - gapAfter * 0.6));
    const liftStart = endSeconds - preLiftLead;
    if (timeSeconds > liftStart) {
      const u = Math.max(0, Math.min(1, (timeSeconds - liftStart) / Math.max(1e-4, preLiftLead)));
      const s = u * u * (3 - 2 * u);
      weight = Math.min(weight, 0.02 + 0.98 * (1 - s));
    }
  }

  return weight;
}

/**
 * Reuses a five-slot finger buffer and selects the most recently started score
 * note per finger during its press and short release tail.
 */
export function populateHandContactTargets(
  notes: readonly HandContactNoteLike[],
  hand: "left" | "right",
  timeSeconds: number,
  out: ImprovedHandContactTarget[],
  sampleSurfaceYAt: KeySurfaceSampler,
): ImprovedHandContactTarget[] {
  for (let index = 0; index < 5; index++) {
    const existing = out[index];
    if (existing) {
      existing.pitch = null;
      existing.sourceStartSeconds = Number.NEGATIVE_INFINITY;
      existing.sourceEndSeconds = undefined;
      delete existing.prevEndSeconds;
      delete existing.nextStartSeconds;
      existing.sampleSurfaceYAt = sampleSurfaceYAt;
      existing.contactCenterX = undefined;
      existing.contactMinX = undefined;
      existing.contactMaxX = undefined;
      existing.contactMinZ = undefined;
      existing.contactMaxZ = undefined;
    } else {
      out.push({
        finger: index + 1,
        pitch: null,
        sourceStartSeconds: Number.NEGATIVE_INFINITY,
        sampleSurfaceYAt,
      });
    }
  }

  for (const note of notes) {
    if (note.hand !== hand || note.finger === null || !Number.isInteger(note.finger) ||
        note.finger < 1 || note.finger > 5 || note.startSeconds > timeSeconds ||
        note.endSeconds + IMPROVED_HAND_CONTACT_RELEASE_SECONDS <= timeSeconds) {
      continue;
    }
    const target = out[note.finger - 1]!;
    if (note.startSeconds >= target.sourceStartSeconds) {
      target.pitch = note.pitch;
      target.sourceStartSeconds = note.startSeconds;
      target.sourceEndSeconds = note.endSeconds;
    }
  }

  for (let index = 0; index < 5; index++) {
    const target = out[index]!;
    if (target.pitch === null || target.sourceEndSeconds === undefined) continue;
    let prevEnd = Number.NEGATIVE_INFINITY;
    let nextStart = Number.POSITIVE_INFINITY;
    for (const note of notes) {
      if (note.hand !== hand) continue;
      if (note.finger !== target.finger && note.pitch !== target.pitch) continue;
      if (
        note.startSeconds < target.sourceStartSeconds - 1e-5 &&
        note.endSeconds <= target.sourceStartSeconds + 1e-4 &&
        target.sourceStartSeconds - note.endSeconds <= IMPROVED_HAND_CONTACT_RELEASE_SECONDS + 1e-4
      ) {
        if (note.endSeconds > prevEnd) prevEnd = note.endSeconds;
      }
      if (
        note.startSeconds > target.sourceStartSeconds + 1e-5 &&
        note.startSeconds >= target.sourceEndSeconds - 1e-4 &&
        note.startSeconds - target.sourceEndSeconds <= IMPROVED_HAND_CONTACT_RELEASE_SECONDS + 1e-4
      ) {
        if (note.startSeconds < nextStart) nextStart = note.startSeconds;
      }
    }
    if (Number.isFinite(prevEnd)) target.prevEndSeconds = prevEnd;
    if (Number.isFinite(nextStart)) target.nextStartSeconds = nextStart;
  }

  return out;
}

/** Returns the largest positive gap under the sampled key top; hovering points never snap down. */
export function computePenetrationOnlyCorrection(
  pitch: number,
  supportPoints: readonly { x: number; y: number; z: number }[],
  sampleSurfaceYAt: KeySurfaceSampler,
  sampleCount = supportPoints.length,
): number {
  let correction = 0;
  for (let index = 0; index < Math.min(sampleCount, supportPoints.length); index++) {
    const point = supportPoints[index]!;
    const surfaceY = sampleSurfaceYAt(pitch, point.x, point.z);
    if (surfaceY === null || !Number.isFinite(surfaceY) || !Number.isFinite(point.y)) continue;
    correction = Math.max(correction, surfaceY - point.y);
  }
  return correction;
}
