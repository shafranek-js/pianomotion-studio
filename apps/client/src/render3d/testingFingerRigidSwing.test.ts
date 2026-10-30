import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { checkTestingFingerChainCorrection } from "./testingFingerKinematics";
import {
  createTestingFingerRigidSwingCandidates,
  TESTING_FINGER_RIGID_SWING_MAX_ANGLE_RADIANS,
} from "./testingFingerRigidSwing";

const vector = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function directions(points: readonly THREE.Vector3[]): THREE.Vector3[] {
  return points.slice(1).map((point, index) =>
    point.clone().sub(points[index]!).normalize(),
  );
}

describe("Testing finger rigid swing fallback candidates", () => {
  it("preserves MCP anchor, segment lengths, and joint angles for a long finger", () => {
    const source = [
      vector(0, 0, 0),
      vector(0, 1, 0),
      vector(0, 1.8, 0.6),
      vector(0, 2.5, 0.6),
    ];
    const desired = source.at(-1)!.clone()
      .applyAxisAngle(vector(1, 0, 0), 20 * Math.PI / 180);
    const sourceDirections = directions(source);
    const candidates = createTestingFingerRigidSwingCandidates(source, desired);

    expect(candidates.map(candidate => candidate.fraction)).toEqual([1, 0.5, 0.25, 0.125]);
    for (const candidate of candidates) {
      expect(candidate.points[0]!.distanceTo(source[0]!)).toBeLessThan(1e-10);
      expect(candidate.angleRadians).toBeLessThanOrEqual(
        TESTING_FINGER_RIGID_SWING_MAX_ANGLE_RADIANS + 1e-10,
      );
      const candidateDirections = directions(candidate.points);
      for (let index = 0; index < source.length - 1; index++) {
        expect(candidate.points[index + 1]!.distanceTo(candidate.points[index]!))
          .toBeCloseTo(source[index + 1]!.distanceTo(source[index]!), 10);
      }
      for (let index = 1; index < sourceDirections.length; index++) {
        expect(candidateDirections[index - 1]!.dot(candidateDirections[index]!))
          .toBeCloseTo(sourceDirections[index - 1]!.dot(sourceDirections[index]!), 10);
      }
      expect(checkTestingFingerChainCorrection(source, candidate.points, {
        hingeAxis: vector(1, 0, 0),
      })).toEqual({ safe: true });
    }
    expect(candidates[0]!.angleRadians).toBeCloseTo(8 * Math.PI / 180, 10);
  });

  it("supports the three-point thumb chain and projects an unreachable target to its reach radius", () => {
    const source = [vector(1, 0, 0), vector(2, 0, 0), vector(2.8, 0.6, 0)];
    const target = vector(1, 8, 0);
    const [candidate] = createTestingFingerRigidSwingCandidates(source, target);

    expect(candidate).toBeDefined();
    expect(candidate!.points[0]!.distanceTo(source[0]!)).toBeLessThan(1e-10);
    expect(candidate!.points.at(-1)!.distanceTo(source[0]!))
      .toBeCloseTo(source.at(-1)!.distanceTo(source[0]!), 10);
    expect(checkTestingFingerChainCorrection(source, candidate!.points, {
      hingeAxis: vector(0, 0, 1),
      thumb: true,
    })).toEqual({ safe: true });
  });

  it("keeps the captured Habanera 49s ring-finger bend while moving the tip toward the key", () => {
    // Rounded MCP-to-tip points from the 49s IK-off capture. The final-stage
    // log has a 0.072in pad penetration, while the accepted FABRIK pose reduces
    // the ring DIP bend from about 14.96 to 1.57 degrees.
    const source = [
      vector(1.232, 1.373, 1.231),
      vector(1.315, 0.939, -0.482),
      vector(1.357, 0.248, -1.331),
      vector(1.380, -0.270, -1.800),
    ];
    const desiredTip = source.at(-1)!.clone().add(vector(0, 0.084, 0));
    const candidates = createTestingFingerRigidSwingCandidates(source, desiredTip);
    const candidate = candidates[0]!;

    expect(candidate.points.at(-1)!.y).toBeGreaterThan(source.at(-1)!.y);
    expect(candidate.angleRadians).toBeLessThan(2 * Math.PI / 180);
    expect(checkTestingFingerChainCorrection(source, candidate.points, {
      hingeAxis: vector(0.9503, -0.2880, 0.1182),
    })).toEqual({ safe: true });
    for (let index = 0; index < source.length - 1; index++) {
      expect(candidate.points[index + 1]!.distanceTo(candidate.points[index]!))
        .toBeCloseTo(source[index + 1]!.distanceTo(source[index]!), 10);
    }
  });

  it("fails closed for degenerate and antiparallel targets", () => {
    expect(createTestingFingerRigidSwingCandidates(
      [vector(0, 0, 0), vector(1, 0, 0), vector(2, 0, 0)],
      vector(-2, 0, 0),
    )).toEqual([]);
    expect(createTestingFingerRigidSwingCandidates(
      [vector(0, 0, 0), vector(0, 0, 0), vector(0, 1, 0)],
      vector(0, 0, 1),
    )).toEqual([]);
    expect(createTestingFingerRigidSwingCandidates(
      [vector(0, 0, 0), vector(0, 1, 0), vector(0, 2, 0)],
      vector(Number.NaN, 0, 0),
    )).toEqual([]);
  });
});
