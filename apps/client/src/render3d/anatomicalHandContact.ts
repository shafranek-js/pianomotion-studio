import * as THREE from "three";

export interface FixedLengthChainSolution {
  points: THREE.Vector3[];
  targetReached: THREE.Vector3;
  residual: number;
  segmentLengths: number[];
}

/** Moves a finger chain endpoint while preserving every measured segment length. */
export function solveFixedLengthFingerChain(
  sourcePoints: readonly THREE.Vector3[],
  target: THREE.Vector3,
  maxIterations = 16,
): FixedLengthChainSolution | null {
  if (sourcePoints.length < 2 || !target.toArray().every(Number.isFinite) ||
      sourcePoints.some((point) => !point.toArray().every(Number.isFinite))) {
    return null;
  }

  const points = sourcePoints.map((point) => point.clone());
  const start = points[0]!.clone();
  const segmentLengths = points.slice(1).map((point, index) => point.distanceTo(points[index]!));
  if (segmentLengths.some((length) => !Number.isFinite(length) || length <= 1e-5)) return null;

  const totalReach = segmentLengths.reduce((sum, length) => sum + length, 0);
  const targetDelta = target.clone().sub(start);
  const targetDistance = targetDelta.length();
  if (targetDistance >= totalReach) {
    const direction = targetDistance > 1e-6
      ? targetDelta.multiplyScalar(1 / targetDistance)
      : points[points.length - 1]!.clone().sub(start).normalize();
    const targetReached = start.clone().addScaledVector(direction, totalReach);
    let accumulatedLength = 0;
    for (let index = 1; index < points.length; index++) {
      accumulatedLength += segmentLengths[index - 1]!;
      points[index]!.copy(start).addScaledVector(direction, accumulatedLength);
    }
    return { points, targetReached, residual: 0, segmentLengths };
  }
  const targetReached = target.clone();

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    points[points.length - 1]!.copy(targetReached);
    for (let index = points.length - 2; index >= 0; index--) {
      const direction = points[index]!.clone().sub(points[index + 1]!);
      if (direction.lengthSq() < 1e-10) {
        direction.subVectors(sourcePoints[index]!, sourcePoints[index + 1]!);
      }
      direction.normalize();
      points[index]!.copy(points[index + 1]!).addScaledVector(direction, segmentLengths[index]!);
    }

    points[0]!.copy(start);
    for (let index = 1; index < points.length; index++) {
      const direction = points[index]!.clone().sub(points[index - 1]!);
      if (direction.lengthSq() < 1e-10) {
        direction.subVectors(sourcePoints[index]!, sourcePoints[index - 1]!);
      }
      direction.normalize();
      points[index]!.copy(points[index - 1]!).addScaledVector(direction, segmentLengths[index - 1]!);
    }
    if (points[points.length - 1]!.distanceTo(targetReached) < 1e-5) break;
  }

  return {
    points,
    targetReached,
    residual: points[points.length - 1]!.distanceTo(targetReached),
    segmentLengths,
  };
}
