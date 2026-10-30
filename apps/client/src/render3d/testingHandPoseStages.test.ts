import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ReconstructedHand3D } from "./handRigBuilder";
import { extractPianistHandLandmarks, measurePianistJointBends } from "./testingHandPianistBenchmark";
import {
  snapshotTestingHandPoseStages,
  type TestingHandPoseStageFrame,
} from "./testingHandPoseStages";

function vector(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

function makeHand(hand: "left" | "right"): ReconstructedHand3D {
  const chains: ReconstructedHand3D["chains"] = {
    1: [vector(1, 0, 0), vector(1.3, 0, 0.4), vector(1.6, 0, 0.8), vector(1.9, 0, 1.2)],
  };
  for (let finger = 2; finger <= 5; finger++) {
    chains[finger] = [
      vector(finger, 0, 0), vector(finger, 0, 1), vector(finger, 0.2, 2),
      vector(finger, 0.4, 3), vector(finger, 0.6, 4),
    ];
  }
  return {
    hand,
    wristR: vector(1, 0, 0),
    wristU: vector(-1, 0, 0),
    wristCenter: vector(0, 0, 0),
    wristWidthIn: 2,
    armEnd: vector(0, -1, 0),
    palmNormal: vector(0, 1, 0),
    chains,
    chainDiagnostics: [{ finger: 3, code: "missing-tip", message: "fixture" }],
  };
}

function frame(
  finger: number,
  points: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]],
  active = true,
): TestingHandPoseStageFrame {
  const [mcp, pip, dip, tip] = points;
  return {
    finger,
    active,
    mcp: { x: mcp[0], y: mcp[1], z: mcp[2] },
    pip: { x: pip[0], y: pip[1], z: pip[2] },
    dip: { x: dip[0], y: dip[1], z: dip[2] },
    tip: { x: tip[0], y: tip[1], z: tip[2] },
  };
}

function handValues(hand: ReconstructedHand3D): unknown {
  return {
    hand: hand.hand,
    wristR: hand.wristR.toArray(),
    wristU: hand.wristU.toArray(),
    wristCenter: hand.wristCenter.toArray(),
    wristWidthIn: hand.wristWidthIn,
    armEnd: hand.armEnd.toArray(),
    palmNormal: hand.palmNormal.toArray(),
    chains: Object.fromEntries(Object.entries(hand.chains).map(([finger, chain]) => [
      finger, chain.map(point => point.toArray()),
    ])),
    chainDiagnostics: hand.chainDiagnostics.map(diagnostic => ({ ...diagnostic })),
  };
}

describe("testing hand pose stage snapshots", () => {
  it.each(["left", "right"] as const)("keeps %s identity and applies thumb and long-finger contact frames", handSide => {
    const source = makeHand(handSide);
    const original = handValues(source);
    const thumb = frame(1, [[11, 12, 13], [14, 15, 16], [17, 18, 19], [20, 21, 22]]);
    const middle = frame(3, [[31, 32, 33], [34, 35, 36], [37, 38, 39], [40, 41, 42]]);
    const thumbValues = { ...thumb };
    const middleValues = { ...middle };

    const stages = snapshotTestingHandPoseStages(source, [thumb, middle]);

    expect(stages.beforeContact.hand).toBe(handSide);
    expect(stages.afterContact.hand).toBe(handSide);
    expect(handValues(stages.beforeContact)).toEqual(original);
    expect(stages.afterContact.chains[1]!.map(point => point.toArray())).toEqual([
      [1, 0, 0], [11, 12, 13], [17, 18, 19], [20, 21, 22],
    ]);
    expect(stages.afterContact.chains[3]!.map(point => point.toArray())).toEqual([
      [3, 0, 0], [31, 32, 33], [34, 35, 36], [37, 38, 39], [40, 41, 42],
    ]);
    expect(stages.afterContact.chains[2]!.map(point => point.toArray())).toEqual(
      source.chains[2]!.map(point => point.toArray()),
    );
    expect(stages.afterContact.wristCenter.toArray()).toEqual(source.wristCenter.toArray());
    expect(stages.afterContact.chainDiagnostics).toEqual(source.chainDiagnostics);

    expect(handValues(source)).toEqual(original);
    expect(thumb).toEqual(thumbValues);
    expect(middle).toEqual(middleValues);
    expect(stages.beforeContact.wristCenter).not.toBe(source.wristCenter);
    expect(stages.afterContact.wristCenter).not.toBe(stages.beforeContact.wristCenter);
    expect(stages.afterContact.chains[3]![0]).not.toBe(source.chains[3]![0]);
    expect(stages.afterContact.chainDiagnostics[0]).not.toBe(source.chainDiagnostics[0]);

    stages.beforeContact.wristCenter.x = 99;
    stages.beforeContact.chainDiagnostics[0]!.message = "changed snapshot";
    expect(source.wristCenter.x).toBe(0);
    expect(stages.afterContact.wristCenter.x).toBe(0);
    expect(source.chainDiagnostics[0]!.message).toBe("fixture");
    expect(stages.afterContact.chainDiagnostics[0]!.message).toBe("fixture");
  });

  it("leaves a chain unchanged when it has no active frame", () => {
    const source = makeHand("right");
    const inactive = frame(4, [[41, 42, 43], [44, 45, 46], [47, 48, 49], [50, 51, 52]], false);

    const stages = snapshotTestingHandPoseStages(source, [inactive]);

    expect(stages.afterContact.chains[4]!.map(point => point.toArray())).toEqual(
      source.chains[4]!.map(point => point.toArray()),
    );
    expect(stages.afterContact.chains[4]).not.toBe(source.chains[4]);
    expect(stages.afterContact.chains[4]![0]).not.toBe(source.chains[4]![0]);
    expect(handValues(source)).toEqual(handValues(stages.beforeContact));
  });

  it("produces finite landmarks and joint bends for both pose stages", () => {
    const source = makeHand("left");
    const stages = snapshotTestingHandPoseStages(source, [
      frame(1, [[11, 12, 13], [14, 15, 16], [17, 18, 19], [20, 21, 22]]),
      frame(2, [[21, 22, 23], [24, 25, 26], [27, 28, 29], [30, 31, 32]]),
    ]);

    for (const stage of [stages.beforeContact, stages.afterContact]) {
      const landmarks = extractPianistHandLandmarks(stage);
      const bends = measurePianistJointBends(stage);
      expect(landmarks).toHaveLength(21);
      expect(landmarks.flat().every(Number.isFinite)).toBe(true);
      expect(bends).toHaveLength(14);
      expect(bends.every(bend => Number.isFinite(bend.bendDegrees))).toBe(true);
    }
  });
});
