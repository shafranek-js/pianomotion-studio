import * as THREE from "three";

export interface TestingFingerKinematicsOptions {
  /** A local hinge axis from the posed metacarpal, used only when the source chain is nearly straight. */
  hingeAxis?: THREE.Vector3;
  /** The thumb uses an MCP-to-IP-to-tip chain and is checked independently from the four-point fingers. */
  thumb?: boolean;
}

export type TestingFingerKinematicsRejection =
  | "point-count"
  | "non-finite"
  | "degenerate-segment"
  | "length-change"
  | "unknown-plane"
  | "unstable-plane"
  | "added-lateral-bend"
  | "reversed-flexion";

export type TestingFingerKinematicsResult =
  | { safe: true }
  | { safe: false; reason: TestingFingerKinematicsRejection };

const MIN_SEGMENT_LENGTH = 1e-5;
const MIN_BASE_DIRECTION_DOT = -0.95;
const MIN_SOURCE_BEND_SIN = Math.sin(4 * Math.PI / 180);
const MIN_SOURCE_FLEXION_ANGLE = 3 * Math.PI / 180;
const FLEXION_SIGN_NOISE_TOLERANCE = 0.5 * Math.PI / 180;
const LATERAL_ANGLE_ALLOWANCE = 2.5 * Math.PI / 180;
const MAX_RELATIVE_SEGMENT_LENGTH_CHANGE = 0.05;
const MIN_ABSOLUTE_SEGMENT_LENGTH_ALLOWANCE = 0.005;

function directionsOf(points: readonly THREE.Vector3[]): THREE.Vector3[] | null {
  const directions: THREE.Vector3[] = [];
  for (let index = 1; index < points.length; index++) {
    const direction = points[index]!.clone().sub(points[index - 1]!);
    const length = direction.length();
    if (!Number.isFinite(length) || length <= MIN_SEGMENT_LENGTH) return null;
    directions.push(direction.multiplyScalar(1 / length));
  }
  return directions;
}

function stablePlaneNormal(
  sourceDirections: readonly THREE.Vector3[],
  hingeAxis?: THREE.Vector3,
): { normal: THREE.Vector3 } | { rejection: "unknown-plane" | "unstable-plane" } {
  const bends = sourceDirections.slice(1).map((direction, index) =>
    new THREE.Vector3().crossVectors(sourceDirections[index]!, direction),
  );
  let strongest = -1;
  for (let index = 0; index < bends.length; index++) {
    if (bends[index]!.length() > (strongest < 0 ? 0 : bends[strongest]!.length())) strongest = index;
  }

  if (strongest >= 0 && bends[strongest]!.length() >= MIN_SOURCE_BEND_SIN) {
    const normal = bends[strongest]!.clone().normalize();
    // A finger whose joints curve in substantially different planes does not
    // provide a reliable reference for this conservative correction.
    for (const bend of bends) {
      if (bend.length() < MIN_SOURCE_BEND_SIN) continue;
      if (Math.abs(normal.dot(bend.clone().normalize())) < 0.75) {
        return { rejection: "unstable-plane" };
      }
    }
    return { normal };
  }

  if (!hingeAxis || !hingeAxis.toArray().every(Number.isFinite)) {
    return { rejection: "unknown-plane" };
  }
  const baseDirection = sourceDirections[0]!;
  const normal = hingeAxis.clone().addScaledVector(baseDirection, -hingeAxis.dot(baseDirection));
  if (normal.lengthSq() <= 1e-8) return { rejection: "unknown-plane" };
  return { normal: normal.normalize() };
}

function signedJointAngles(
  directions: readonly THREE.Vector3[],
  planeNormal: THREE.Vector3,
): number[] {
  return directions.slice(1).map((direction, index) => {
    const previous = directions[index]!;
    const sine = planeNormal.dot(new THREE.Vector3().crossVectors(previous, direction));
    return Math.atan2(sine, THREE.MathUtils.clamp(previous.dot(direction), -1, 1));
  });
}

/**
 * Checks one already-mixed IK candidate before it is applied to Testing IK.
 * The source pose establishes the bend plane and the sign of any existing
 * joint flexion; no fixed anatomical axis or preferred angle is imposed.
 */
export function checkTestingFingerChainCorrection(
  sourcePoints: readonly THREE.Vector3[],
  candidatePoints: readonly THREE.Vector3[],
  options: TestingFingerKinematicsOptions = {},
): TestingFingerKinematicsResult {
  const minimumPointCount = options.thumb ? 3 : 4;
  if (sourcePoints.length < minimumPointCount || sourcePoints.length !== candidatePoints.length) {
    return { safe: false, reason: "point-count" };
  }
  if (sourcePoints.some((point) => !point.toArray().every(Number.isFinite)) ||
      candidatePoints.some((point) => !point.toArray().every(Number.isFinite))) {
    return { safe: false, reason: "non-finite" };
  }

  const sourceDirections = directionsOf(sourcePoints);
  const candidateDirections = directionsOf(candidatePoints);
  if (!sourceDirections || !candidateDirections) return { safe: false, reason: "degenerate-segment" };

  for (let index = 0; index < sourceDirections.length; index++) {
    const sourceLength = sourcePoints[index + 1]!.distanceTo(sourcePoints[index]!);
    const candidateLength = candidatePoints[index + 1]!.distanceTo(candidatePoints[index]!);
    const allowedChange = Math.max(
      MIN_ABSOLUTE_SEGMENT_LENGTH_ALLOWANCE,
      sourceLength * MAX_RELATIVE_SEGMENT_LENGTH_CHANGE,
    );
    if (Math.abs(candidateLength - sourceLength) > allowedChange) {
      return { safe: false, reason: "length-change" };
    }
  }

  const plane = stablePlaneNormal(sourceDirections, options.hingeAxis);
  if ("rejection" in plane) return { safe: false, reason: plane.rejection };
  const baseDirectionDot = THREE.MathUtils.clamp(sourceDirections[0]!.dot(candidateDirections[0]!), -1, 1);
  // A near-antiparallel proximal segment has no stable minimal-rotation plane.
  if (baseDirectionDot < MIN_BASE_DIRECTION_DOT) return { safe: false, reason: "unstable-plane" };
  const planeTransport = new THREE.Quaternion().setFromUnitVectors(
    sourceDirections[0]!,
    candidateDirections[0]!,
  );
  const candidatePlaneNormal = plane.normal.clone().applyQuaternion(planeTransport).normalize();

  // Side bending is measured as each segment's angle out of the source pose's
  // plane after transporting that plane with the MCP-to-PIP segment. This
  // leaves proximal/MCP motion free while checking the PIP/DIP segments against
  // the source pose. Existing out-of-plane shape is tolerated within a small
  // allowance, so the guard does not try to repair unrelated source defects.
  for (let index = 1; index < sourceDirections.length; index++) {
    const sourceLateralAngle = Math.asin(Math.min(1, Math.abs(sourceDirections[index]!.dot(plane.normal))));
    const candidateLateralAngle = Math.asin(
      Math.min(1, Math.abs(candidateDirections[index]!.dot(candidatePlaneNormal))),
    );
    if (candidateLateralAngle > sourceLateralAngle + LATERAL_ANGLE_ALLOWANCE) {
      return { safe: false, reason: "added-lateral-bend" };
    }
  }

  const sourceAngles = signedJointAngles(sourceDirections, plane.normal);
  const candidateAngles = signedJointAngles(candidateDirections, candidatePlaneNormal);
  for (let index = 0; index < sourceAngles.length; index++) {
    const sourceAngle = sourceAngles[index]!;
    const candidateAngle = candidateAngles[index]!;
    if (Math.abs(sourceAngle) < MIN_SOURCE_FLEXION_ANGLE) continue;
    if (Math.sign(sourceAngle) !== Math.sign(candidateAngle) &&
        Math.abs(candidateAngle) > FLEXION_SIGN_NOISE_TOLERANCE) {
      return { safe: false, reason: "reversed-flexion" };
    }
  }

  return { safe: true };
}
