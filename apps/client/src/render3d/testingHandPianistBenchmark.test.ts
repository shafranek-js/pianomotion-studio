import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ReconstructedHand3D } from "./handRigBuilder";
import {
  extractPianistHandLandmarks,
  measurePianistJointBends,
  normalizedPianistLandmarkError,
  unsignedJointBendDegrees,
} from "./testingHandPianistBenchmark";

function makeHand(): ReconstructedHand3D {
  const chains: ReconstructedHand3D["chains"] = {};
  chains[1] = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(1.2, 0, 1),
    new THREE.Vector3(1.4, 0, 2), new THREE.Vector3(1.6, 0, 3),
  ];
  for (let finger = 2; finger <= 5; finger++) {
    chains[finger] = [0, 1, 2, 3, 4].map(z => new THREE.Vector3(finger, 0, z));
  }
  return {
    hand: "right",
    wristCenter: new THREE.Vector3(0, 0, 0),
    wristR: new THREE.Vector3(-1, 0, 0),
    wristU: new THREE.Vector3(1, 0, 0),
    wristWidthIn: 2,
    armEnd: new THREE.Vector3(0, 0, -2),
    palmNormal: new THREE.Vector3(0, 1, 0),
    chains,
    chainDiagnostics: [],
  };
}

describe("Testing hand / real-pianist 21-landmark benchmark adapter", () => {
  it("exports both thumb and fingers in the conventional 0..20 landmark order", () => {
    const pose = makeHand();
    const result = extractPianistHandLandmarks(pose);
    expect(result).toHaveLength(21);
    expect(result[0]).toEqual([0, 0, 0]);
    expect(result[1]).toEqual([1, 0, 0]); // thumb CMC
    expect(result[4]).toEqual([1.6, 0, 3]); // thumb tip
    expect(result[5]).toEqual([2, 0, 1]); // index MCP, not index base
    expect(result[8]).toEqual([2, 0, 4]); // index tip
    expect(result[17]).toEqual([5, 0, 1]); // little finger MCP
    expect(result[20]).toEqual([5, 0, 4]); // little finger tip
    expect(measurePianistJointBends(pose)).toHaveLength(14);
    expect(measurePianistJointBends(pose).every(x => x.bendDegrees < 1e-4)).toBe(true);
  });

  it("normalizes translation and global scale, but never guesses missing fingers", () => {
    const reference = extractPianistHandLandmarks(makeHand());
    const translated = reference.map(p => [
      p[0] * 1.5 + 17, p[1] * 1.5 - 3, p[2] * 1.5 + 8,
    ] as const);
    expect(normalizedPianistLandmarkError(reference, translated)).toBeLessThan(1e-6);

    const invalid = makeHand();
    delete invalid.chains[3];
    expect(() => extractPianistHandLandmarks(invalid)).toThrow("finger 3");
    expect(() => normalizedPianistLandmarkError(reference, [])).toThrow("21-point");
  });

  it("recognizes a bent PIP/DIP, and rejects collapsed joint segments", () => {
    expect(unsignedJointBendDegrees([0, 0, 0], [0, 0, 1], [1, 0, 1]))
      .toBeCloseTo(90, 5);
    expect(unsignedJointBendDegrees([0, 0, 0], [0, 0, 1], [0, 0, 2]))
      .toBeCloseTo(0, 5);
    expect(() => unsignedJointBendDegrees([0, 0, 1], [0, 0, 1], [0, 0, 2]))
      .toThrow("zero-length");

    const hand = makeHand();
    hand.chains[2]![3]!.set(2.4, 0, 3);
    const bent = measurePianistJointBends(hand).filter(x => x.finger === 2);
    expect(bent.find(x => x.joint === "PIP")!.bendDegrees).toBeCloseTo(21.8014, 3);
    expect(bent.find(x => x.joint === "DIP")!.bendDegrees).toBeGreaterThan(20);
  });
});
