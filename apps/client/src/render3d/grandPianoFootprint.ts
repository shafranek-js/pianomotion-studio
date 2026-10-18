import * as THREE from "three";
import { KEYBOARD_WIDTH_IN, WHITE_KEY_WIDTH_IN } from "./handRigBuilder";

export const GRAND_PIANO_KEY_LENGTH_FACTOR = 5.6;
export const GRAND_PIANO_STRIKE_DEPTH_IN =
  GRAND_PIANO_KEY_LENGTH_FACTOR * WHITE_KEY_WIDTH_IN;
export const GRAND_PIANO_FRONT_DEPTH_IN = GRAND_PIANO_STRIKE_DEPTH_IN + 0.4;
export const GRAND_PIANO_TAIL_DEPTH_IN = 44.0;
export const GRAND_PIANO_HALF_WIDTH_IN = KEYBOARD_WIDTH_IN * 0.5 + 1.18;
export const GRAND_PIANO_WALL_THICKNESS_IN = 1.2;
export const GRAND_PIANO_FRONT_LANE_HALF_WIDTH_IN = KEYBOARD_WIDTH_IN * 0.5 + 0.1;

export interface GrandPianoFootprintPoint {
  readonly x: number;
  /** Positive depth in Shape coordinates; world Z is its negative. */
  readonly depth: number;
}

export interface GrandPianoLaneBounds {
  /** Furthest-back world Z allowed for the whole note bar width. */
  readonly rearZ: number;
  /** Front strike plane shared by all key lanes. */
  readonly strikeZ: number;
}

const CURVE_SEGMENTS = 64;
const EDGE_EPSILON = 1e-5;
const STRIKE_Z = -GRAND_PIANO_STRIKE_DEPTH_IN;
const INNER_LEFT_X =
  -GRAND_PIANO_HALF_WIDTH_IN + GRAND_PIANO_WALL_THICKNESS_IN;
const INNER_RIGHT_X =
  GRAND_PIANO_HALF_WIDTH_IN - GRAND_PIANO_WALL_THICKNESS_IN;
const LEFT_TAIL_DEPTH = GRAND_PIANO_TAIL_DEPTH_IN - 9.0;
const RIGHT_BENTSIDE_DEPTH = GRAND_PIANO_FRONT_DEPTH_IN + 9.2;

function sampleCubicBezier(
  p0: GrandPianoFootprintPoint,
  p1: GrandPianoFootprintPoint,
  p2: GrandPianoFootprintPoint,
  p3: GrandPianoFootprintPoint,
): GrandPianoFootprintPoint[] {
  const points: GrandPianoFootprintPoint[] = [];
  for (let i = 1; i <= CURVE_SEGMENTS; i += 1) {
    const t = i / CURVE_SEGMENTS;
    const u = 1 - t;
    const u2 = u * u;
    const t2 = t * t;
    points.push({
      x:
        u2 * u * p0.x +
        3 * u2 * t * p1.x +
        3 * u * t2 * p2.x +
        t2 * t * p3.x,
      depth:
        u2 * u * p0.depth +
        3 * u2 * t * p1.depth +
        3 * u * t2 * p2.depth +
        t2 * t * p3.depth,
    });
  }
  return points;
}

const leftTailStart: GrandPianoFootprintPoint = {
  x: INNER_LEFT_X,
  depth: LEFT_TAIL_DEPTH,
};
const tailCrown: GrandPianoFootprintPoint = {
  x: 1.8,
  depth: GRAND_PIANO_TAIL_DEPTH_IN - 3.0,
};
const rightBentsideEnd: GrandPianoFootprintPoint = {
  x: INNER_RIGHT_X,
  depth: RIGHT_BENTSIDE_DEPTH,
};

const tailCurve = sampleCubicBezier(
  leftTailStart,
  {
    x: INNER_LEFT_X,
    depth: GRAND_PIANO_TAIL_DEPTH_IN + 1.0,
  },
  { x: -3.5, depth: GRAND_PIANO_TAIL_DEPTH_IN + 1.4 },
  tailCrown,
);
const bentsideCurve = sampleCubicBezier(
  tailCrown,
  { x: 7.0, depth: GRAND_PIANO_TAIL_DEPTH_IN - 8.2 },
  { x: 10.4, depth: GRAND_PIANO_FRONT_DEPTH_IN + 17.2 },
  rightBentsideEnd,
);

/**
 * Shared interior contour in Shape coordinates. It follows the piano's inner
 * bass spine, tail, and treble bentside and includes a short open-front mouth
 * reaching the key strike plane.
 */
export const GRAND_PIANO_INTERIOR_CONTOUR: readonly GrandPianoFootprintPoint[] =
  Object.freeze([
    { x: -GRAND_PIANO_FRONT_LANE_HALF_WIDTH_IN, depth: GRAND_PIANO_STRIKE_DEPTH_IN },
    { x: INNER_LEFT_X, depth: GRAND_PIANO_FRONT_DEPTH_IN },
    { x: INNER_LEFT_X, depth: LEFT_TAIL_DEPTH },
    ...tailCurve,
    ...bentsideCurve,
    { x: INNER_RIGHT_X, depth: GRAND_PIANO_FRONT_DEPTH_IN },
    { x: GRAND_PIANO_FRONT_LANE_HALF_WIDTH_IN, depth: GRAND_PIANO_STRIKE_DEPTH_IN },
  ]);

export const GRAND_PIANO_HIGHWAY_LENGTH_IN =
  Math.max(...GRAND_PIANO_INTERIOR_CONTOUR.map((point) => point.depth)) -
  GRAND_PIANO_STRIKE_DEPTH_IN;

export function createGrandPianoInteriorShape(): THREE.Shape {
  const shape = new THREE.Shape();
  const first = GRAND_PIANO_INTERIOR_CONTOUR[0]!;
  shape.moveTo(first.x, first.depth);
  for (const point of GRAND_PIANO_INTERIOR_CONTOUR.slice(1)) {
    shape.lineTo(point.x, point.depth);
  }
  shape.closePath();
  return shape;
}

export function isInsideGrandPianoFootprint(x: number, worldZ: number): boolean {
  const depth = -worldZ;
  let inside = false;
  for (let i = 0, j = GRAND_PIANO_INTERIOR_CONTOUR.length - 1; i < GRAND_PIANO_INTERIOR_CONTOUR.length; j = i++) {
    const a = GRAND_PIANO_INTERIOR_CONTOUR[i]!;
    const b = GRAND_PIANO_INTERIOR_CONTOUR[j]!;
    const crossX =
      ((a.depth > depth) !== (b.depth > depth)) &&
      x < ((b.x - a.x) * (depth - a.depth)) / (b.depth - a.depth) + a.x;
    if (crossX) inside = !inside;

    const dx = b.x - a.x;
    const dy = b.depth - a.depth;
    const cross = (x - a.x) * dy - (depth - a.depth) * dx;
    const dot = (x - a.x) * dx + (depth - a.depth) * dy;
    if (
      Math.abs(cross) <= EDGE_EPSILON &&
      dot >= -EDGE_EPSILON &&
      dot <= dx * dx + dy * dy + EDGE_EPSILON
    ) {
      return true;
    }
  }
  return inside;
}

function intervalsAtX(x: number): Array<readonly [number, number]> {
  const intersections: number[] = [];
  for (let i = 0; i < GRAND_PIANO_INTERIOR_CONTOUR.length; i += 1) {
    const a = GRAND_PIANO_INTERIOR_CONTOUR[i]!;
    const b = GRAND_PIANO_INTERIOR_CONTOUR[(i + 1) % GRAND_PIANO_INTERIOR_CONTOUR.length]!;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    if (x < minX - EDGE_EPSILON || x > maxX + EDGE_EPSILON) continue;

    if (Math.abs(a.x - b.x) <= EDGE_EPSILON) {
      if (Math.abs(x - a.x) <= EDGE_EPSILON) {
        intersections.push(a.depth, b.depth);
      }
      continue;
    }

    const t = (x - a.x) / (b.x - a.x);
    if (t >= -EDGE_EPSILON && t <= 1 + EDGE_EPSILON) {
      intersections.push(a.depth + (b.depth - a.depth) * t);
    }
  }

  intersections.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const value of intersections) {
    if (unique.length === 0 || Math.abs(value - unique[unique.length - 1]!) > EDGE_EPSILON) {
      unique.push(value);
    }
  }

  const intervals: Array<readonly [number, number]> = [];
  for (let i = 0; i + 1 < unique.length; i += 2) {
    intervals.push([-unique[i + 1]!, -unique[i]!]);
  }
  return intervals;
}

/** Returns the common strike-to-tail interval shared by every X in a note lane. */
export function getGrandPianoLaneBounds(
  centerX: number,
  width: number,
): GrandPianoLaneBounds | null {
  if (!Number.isFinite(centerX) || !Number.isFinite(width) || width <= 0) return null;
  const halfWidth = width * 0.5;
  const minX = centerX - halfWidth;
  const maxX = centerX + halfWidth;
  if (
    minX < -GRAND_PIANO_FRONT_LANE_HALF_WIDTH_IN - EDGE_EPSILON ||
    maxX > GRAND_PIANO_FRONT_LANE_HALF_WIDTH_IN + EDGE_EPSILON
  ) {
    return null;
  }

  const candidateXs = new Set<number>([minX, maxX, centerX]);
  for (const point of GRAND_PIANO_INTERIOR_CONTOUR) {
    if (point.x > minX && point.x < maxX) candidateXs.add(point.x);
  }

  const interiorIntervals: Array<readonly [number, number]> = [];
  for (const candidateX of candidateXs) {
    for (const x of [candidateX - EDGE_EPSILON * 10, candidateX, candidateX + EDGE_EPSILON * 10]) {
      if (x < minX || x > maxX) continue;
      const interval = intervalsAtX(x).find(
        ([rearZ, frontZ]) => rearZ <= STRIKE_Z + EDGE_EPSILON && frontZ >= STRIKE_Z - EDGE_EPSILON,
      );
      if (!interval) return null;
      interiorIntervals.push(interval);
    }
  }

  const rearZ = Math.max(...interiorIntervals.map(([candidateRearZ]) => candidateRearZ));
  const frontZ = Math.min(...interiorIntervals.map(([, candidateFrontZ]) => candidateFrontZ));
  if (rearZ > STRIKE_Z + EDGE_EPSILON || frontZ < STRIKE_Z - EDGE_EPSILON) return null;
  return { rearZ, strikeZ: STRIKE_Z };
}

/** Clips only the note's rear end, preserving its strike edge and time-to-Z mapping. */
export function clipGrandPianoNoteDepth(
  frontZ: number,
  length: number,
  laneBounds: GrandPianoLaneBounds,
): { frontZ: number; rearZ: number; length: number } | null {
  if (!Number.isFinite(frontZ) || !Number.isFinite(length) || length <= 0) return null;
  if (frontZ > laneBounds.strikeZ + EDGE_EPSILON) return null;
  const clippedRearZ = Math.max(frontZ - length, laneBounds.rearZ);
  const clippedLength = frontZ - clippedRearZ;
  if (clippedLength <= EDGE_EPSILON) return null;
  return { frontZ, rearZ: clippedRearZ, length: clippedLength };
}
