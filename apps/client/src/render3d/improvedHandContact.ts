export const IMPROVED_HAND_CONTACT_RELEASE_SECONDS = 0.12;

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
  sampleSurfaceYAt: KeySurfaceSampler;
  /** World-space center and top-face bounds for the assigned key, when available. */
  contactCenterX?: number;
  contactMinX?: number;
  contactMaxX?: number;
  contactMinZ?: number;
  contactMaxZ?: number;
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
    }
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
