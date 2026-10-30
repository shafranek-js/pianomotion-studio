import * as THREE from "three";

export interface TestingFingerRigidSwingCandidate {
  /** A fraction of the bounded swing, ordered from largest to smallest. */
  fraction: number;
  /** Applied angle after the fraction and maximum-angle cap. */
  angleRadians: number;
  /** The original MCP/anchor followed by all rigidly rotated distal joints. */
  points: THREE.Vector3[];
}

export const TESTING_FINGER_RIGID_SWING_MAX_ANGLE_RADIANS = 8 * Math.PI / 180;

const SWING_FRACTIONS = [1, 0.5, 0.25, 0.125] as const;
const MIN_DIRECTION_LENGTH = 1e-5;
const MIN_SWING_ANGLE = 1e-6;
const ANTIPARALLEL_DOT_LIMIT = -0.999;

/**
 * Builds a small line search that rigidly swings a Testing finger's phalanges
 * about the MCP/first point toward an endpoint target. Segment lengths and all
 * internal joint angles stay unchanged; the renderer still has to validate the
 * resulting chain and the actual skinned pad before accepting a candidate.
 *
 * The endpoint target is projected onto the source MCP-to-tip radius, so this
 * fallback cannot stretch or shorten the finger. Near-antiparallel directions
 * are rejected because they do not provide a stable unique swing axis.
 */
export function createTestingFingerRigidSwingCandidates(
  sourcePoints: readonly THREE.Vector3[],
  target: THREE.Vector3,
  maxAngleRadians = TESTING_FINGER_RIGID_SWING_MAX_ANGLE_RADIANS,
): TestingFingerRigidSwingCandidate[] {
  if ((sourcePoints.length !== 3 && sourcePoints.length !== 4) ||
      !target.toArray().every(Number.isFinite) ||
      !Number.isFinite(maxAngleRadians) || maxAngleRadians <= 0 ||
      sourcePoints.some(point => !point.toArray().every(Number.isFinite))) {
    return [];
  }

  const anchor = sourcePoints[0]!;
  const sourceEndpoint = sourcePoints[sourcePoints.length - 1]!;
  const sourceVector = sourceEndpoint.clone().sub(anchor);
  const sourceRadius = sourceVector.length();
  const targetVector = target.clone().sub(anchor);
  const targetDistance = targetVector.length();
  if (sourceRadius <= MIN_DIRECTION_LENGTH || targetDistance <= MIN_DIRECTION_LENGTH ||
      sourcePoints.slice(1).some((point, index) =>
        point.distanceTo(sourcePoints[index]!) <= MIN_DIRECTION_LENGTH)) {
    return [];
  }

  sourceVector.multiplyScalar(1 / sourceRadius);
  targetVector.multiplyScalar(1 / targetDistance);
  const dot = THREE.MathUtils.clamp(sourceVector.dot(targetVector), -1, 1);
  if (dot <= ANTIPARALLEL_DOT_LIMIT) return [];

  const axis = new THREE.Vector3().crossVectors(sourceVector, targetVector);
  const angle = Math.acos(dot);
  if (axis.lengthSq() <= 1e-12 || angle <= MIN_SWING_ANGLE) return [];
  axis.normalize();

  const boundedAngle = Math.min(angle, maxAngleRadians);
  return SWING_FRACTIONS.map(fraction => {
    const angleRadians = boundedAngle * fraction;
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, angleRadians);
    const points = sourcePoints.map((point, index) => index === 0
      ? anchor.clone()
      : point.clone().sub(anchor).applyQuaternion(rotation).add(anchor));
    return { fraction, angleRadians, points };
  });
}
