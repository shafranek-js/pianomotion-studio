import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { solveFixedLengthFingerChain } from "./anatomicalHandContact";

describe("anatomical key contact chain solve", () => {
  it("moves a thumb endpoint to a sampled key surface without changing either phalanx length", () => {
    const source = [
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0.55, 0.8, -0.2),
      new THREE.Vector3(1.05, 0.35, -0.5),
    ];
    const target = new THREE.Vector3(1.2, 0.05, -0.6);
    const result = solveFixedLengthFingerChain(source, target);

    expect(result).not.toBeNull();
    expect(result!.points[0]!.distanceTo(source[0]!)).toBeLessThan(1e-8);
    expect(result!.points.at(-1)!.distanceTo(result!.targetReached)).toBeLessThan(1e-4);
    for (let index = 0; index < result!.segmentLengths.length; index++) {
      expect(result!.points[index]!.distanceTo(result!.points[index + 1]!))
        .toBeCloseTo(result!.segmentLengths[index]!, 6);
    }
  });

  it("keeps the original bend shape finite when the key point is beyond finger reach", () => {
    const source = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.4, 0.3, 0),
      new THREE.Vector3(0.8, 0.2, -0.1),
      new THREE.Vector3(1.1, 0, -0.2),
    ];
    const result = solveFixedLengthFingerChain(source, new THREE.Vector3(20, 10, 0));

    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.residual)).toBe(true);
    expect(result!.targetReached.distanceTo(source[0]!)).toBeCloseTo(
      result!.segmentLengths.reduce((sum, length) => sum + length, 0),
      6,
    );
    expect(result!.points.every((point) => point.toArray().every(Number.isFinite))).toBe(true);
  });
});
