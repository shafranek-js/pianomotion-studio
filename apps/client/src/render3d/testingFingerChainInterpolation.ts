import * as THREE from "three";

export type TestingFingerChainInterpolationFailure =
  | "point-count"
  | "non-finite"
  | "degenerate-segment"
  | "antiparallel-direction"
  | "invalid-fraction"
  | "non-finite-result";

export type TestingFingerChainInterpolationResult =
  | { ok: true; points: THREE.Vector3[] }
  | { ok: false; reason: TestingFingerChainInterpolationFailure };

const MIN_SEGMENT_LENGTH = 1e-6;
const ANTIPARALLEL_DOT_LIMIT = -0.999999;
const PARALLEL_DOT_LIMIT = 0.99999999;

interface SegmentData {
  direction: THREE.Vector3;
  length: number;
}

function isFinitePoint(point: THREE.Vector3): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function segmentData(points: readonly THREE.Vector3[]): SegmentData[] | TestingFingerChainInterpolationFailure {
  const segments: SegmentData[] = [];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const x = current.x - previous.x;
    const y = current.y - previous.y;
    const z = current.z - previous.z;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return "non-finite";

    const length = Math.hypot(x, y, z);
    if (!Number.isFinite(length)) return "non-finite";
    if (length <= MIN_SEGMENT_LENGTH) return "degenerate-segment";
    segments.push({ direction: new THREE.Vector3(x / length, y / length, z / length), length });
  }
  return segments;
}

function isFailure(
  value: SegmentData[] | TestingFingerChainInterpolationFailure,
): value is TestingFingerChainInterpolationFailure {
  return typeof value === "string";
}

function slerpDirection(
  from: THREE.Vector3,
  to: THREE.Vector3,
  fraction: number,
): THREE.Vector3 | TestingFingerChainInterpolationFailure {
  const cosine = THREE.MathUtils.clamp(from.dot(to), -1, 1);
  if (cosine <= ANTIPARALLEL_DOT_LIMIT) return "antiparallel-direction";
  if (fraction === 0) return from.clone();
  if (fraction === 1) return to.clone();

  // Linear interpolation avoids dividing by a very small sine for nearly
  // parallel directions, then normalization restores unit length.
  if (cosine >= PARALLEL_DOT_LIMIT) {
    const blended = from.clone().lerp(to, fraction);
    const length = Math.hypot(blended.x, blended.y, blended.z);
    if (!Number.isFinite(length) || length <= MIN_SEGMENT_LENGTH) return "non-finite-result";
    return blended.multiplyScalar(1 / length);
  }

  const angle = Math.acos(cosine);
  const denominator = Math.sin(angle);
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= 1e-12) {
    return "antiparallel-direction";
  }
  const fromWeight = Math.sin((1 - fraction) * angle) / denominator;
  const toWeight = Math.sin(fraction * angle) / denominator;
  const blended = from.clone().multiplyScalar(fromWeight).addScaledVector(to, toWeight);
  const length = Math.hypot(blended.x, blended.y, blended.z);
  if (!Number.isFinite(length) || length <= MIN_SEGMENT_LENGTH) return "non-finite-result";
  return blended.multiplyScalar(1 / length);
}

/**
 * Builds a fixed-length interpolation candidate between a source finger chain
 * and an IK solution. The source MCP and each source segment length are kept;
 * solution segment lengths are intentionally ignored. Thus fraction 1 matches
 * the solution when its MCP and segment lengths match the source. A failure
 * has no points, so callers must leave the current/source pose unchanged.
 */
export function interpolateTestingFingerChainFixedLength(
  sourcePoints: readonly THREE.Vector3[],
  solutionPoints: readonly THREE.Vector3[],
  fraction: number,
): TestingFingerChainInterpolationResult {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    return { ok: false, reason: "invalid-fraction" };
  }
  if (sourcePoints.length < 3 || sourcePoints.length !== solutionPoints.length) {
    return { ok: false, reason: "point-count" };
  }
  if (sourcePoints.some((point) => !isFinitePoint(point)) ||
      solutionPoints.some((point) => !isFinitePoint(point))) {
    return { ok: false, reason: "non-finite" };
  }

  const sourceSegments = segmentData(sourcePoints);
  if (isFailure(sourceSegments)) return { ok: false, reason: sourceSegments };
  const solutionSegments = segmentData(solutionPoints);
  if (isFailure(solutionSegments)) return { ok: false, reason: solutionSegments };

  const directions: THREE.Vector3[] = [];
  for (let index = 0; index < sourceSegments.length; index++) {
    const direction = slerpDirection(
      sourceSegments[index]!.direction,
      solutionSegments[index]!.direction,
      fraction,
    );
    if (typeof direction === "string") return { ok: false, reason: direction };
    directions.push(direction);
  }

  if (fraction === 0) {
    return { ok: true, points: sourcePoints.map((point) => point.clone()) };
  }
  if (fraction === 1 && sourcePoints[0]!.equals(solutionPoints[0]!) &&
      sourceSegments.every((segment, index) => segment.length === solutionSegments[index]!.length)) {
    return { ok: true, points: solutionPoints.map((point) => point.clone()) };
  }

  // The source MCP is fixed. Rebuild each point from the prior point using
  // the corresponding source segment length rather than linearly mixing XYZ.
  const points = [sourcePoints[0]!.clone()];
  for (let index = 0; index < directions.length; index++) {
    const next = points[index]!.clone().addScaledVector(
      directions[index]!,
      sourceSegments[index]!.length,
    );
    if (!isFinitePoint(next)) return { ok: false, reason: "non-finite-result" };
    points.push(next);
  }
  return { ok: true, points };
}
