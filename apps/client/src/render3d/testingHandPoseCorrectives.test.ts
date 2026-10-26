import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ReconstructedHand3D } from "./handRigBuilder";
import {
  correctiveWeightsForAngle,
  evaluateTestingCorrectiveMorphs,
  pianistCorrectiveJointAngles,
} from "./testingHandPoseCorrectives";

function handFixture(): ReconstructedHand3D {
  const chains: ReconstructedHand3D["chains"] = {};
  chains[1] = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(1.4, 0, 0.5),
    new THREE.Vector3(1.6, 0, 1.1), new THREE.Vector3(1.9, 0, 1.6),
  ];
  for (let finger = 2; finger <= 5; finger++) {
    chains[finger] = Array.from({ length: 5 }, (_, i) => new THREE.Vector3(finger, 0, i));
  }
  return {
    hand: "right",
    wristCenter: new THREE.Vector3(0, 0, 0),
    wristR: new THREE.Vector3(0.5, 0, 0),
    wristU: new THREE.Vector3(-0.5, 0, 0),
    wristWidthIn: 1,
    armEnd: new THREE.Vector3(0, 0, -2),
    palmNormal: new THREE.Vector3(0, 1, 0),
    chains, chainDiagnostics: [],
  };
}

describe("Testing Blender morph driver contract", () => {
  it("linearly blends calibrated 30/60/90 shape targets without discontinuities", () => {
    expect(correctiveWeightsForAngle(0)).toEqual([0, 0, 0]);
    expect(correctiveWeightsForAngle(15)).toEqual([0.5, 0, 0]);
    expect(correctiveWeightsForAngle(30)).toEqual([1, 0, 0]);
    expect(correctiveWeightsForAngle(45)).toEqual([0.5, 0.5, 0]);
    expect(correctiveWeightsForAngle(60)).toEqual([0, 1, 0]);
    expect(correctiveWeightsForAngle(75)).toEqual([0, 0.5, 0.5]);
    expect(correctiveWeightsForAngle(90)).toEqual([0, 0, 1]);
    expect(correctiveWeightsForAngle(130)).toEqual([0, 0, 1]);
    expect(() => correctiveWeightsForAngle(Number.NaN)).toThrow("nonnegative");
    expect(() => correctiveWeightsForAngle(-10)).toThrow("nonnegative");
  });

  it("reads reconstructed WebXR finger chains without modifying them", () => {
    const h = handFixture();
    const before = h.chains[1]!.map(point => point.toArray());
    const result = pianistCorrectiveJointAngles(h);
    expect(result.size).toBe(15); // 4 × MCP/PIP/DIP + thumb CMC/MCP/IP
    expect(result.get("index_mcp")).toBeCloseTo(0, 6);
    expect(result.get("thumb_cmc")).toBeGreaterThan(0);
    expect(h.chains[1]!.map(point => point.toArray())).toEqual(before);
    delete h.chains[3];
    expect(() => pianistCorrectiveJointAngles(h)).toThrow("middle");
  });

  it("updates only matching face/hand morph targets and leaves neutral wrist in place", () => {
    const shape = {
      morphTargetDictionary: {
        pmcorr_index_mcp_030: 0, pmcorr_index_mcp_060: 1, pmcorr_index_mcp_090: 2,
        pmcorr_thumb_ip_030: 3, pmcorr_wrist_flex_030: 4, eye_blink: 5,
      },
      morphTargetInfluences: [0, 0, 0, 0, 0.7, 0.25],
    } as unknown as THREE.SkinnedMesh;
    const r = evaluateTestingCorrectiveMorphs(shape, new Map([
      ["index_mcp", 45], ["thumb_ip", 15],
    ]));
    expect(shape.morphTargetInfluences).toEqual([0.5, 0.5, 0, 0.5, 0, 0.25]);
    expect(r.supportedTargets).toBe(4);
    expect(r.drivenTargets).toBe(3);
    expect(r.ignoredWristTargets).toBe(1);
    expect(r.missingTargets).toEqual(["pmcorr_thumb_ip_060", "pmcorr_thumb_ip_090"]);
  });

  it("is inert for current production GLBs without morph targets", () => {
    const shape = { morphTargetDictionary: undefined, morphTargetInfluences: undefined }
      as unknown as THREE.SkinnedMesh;
    const r = evaluateTestingCorrectiveMorphs(shape, new Map([["index_mcp", 60]]));
    expect(r.supportedTargets).toBe(0);
    expect(r.drivenTargets).toBe(0);
  });
});
