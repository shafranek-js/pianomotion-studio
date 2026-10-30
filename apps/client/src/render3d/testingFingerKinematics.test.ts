import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { checkTestingFingerChainCorrection } from "./testingFingerKinematics";

const vector = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const degrees = (angle: number) => angle * Math.PI / 180;

function chainFromAngles(flexion: readonly number[], lateral: readonly number[] = []): THREE.Vector3[] {
  const points = [vector(0, 0, 0)];
  for (let index = 0; index < flexion.length; index++) {
    const sideAngle = lateral[index] ?? 0;
    const direction = vector(
      Math.sin(sideAngle),
      Math.cos(sideAngle) * Math.sin(flexion[index]!),
      Math.cos(sideAngle) * Math.cos(flexion[index]!),
    );
    points.push(points[index]!.clone().add(direction));
  }
  return points;
}

function mirrorAcrossHandSide(points: readonly THREE.Vector3[]): THREE.Vector3[] {
  return points.map((point) => vector(-point.x, point.y, point.z));
}

describe("Testing IK finger kinematics guard", () => {
  it("allows an in-plane flexion from a straight source for either mirrored hand", () => {
    const source = chainFromAngles([0, 0, 0]);
    const candidate = chainFromAngles([0, degrees(12), degrees(20)]);

    expect(checkTestingFingerChainCorrection(source, candidate, { hingeAxis: vector(1, 0, 0) })).toEqual({ safe: true });
    expect(checkTestingFingerChainCorrection(
      mirrorAcrossHandSide(source),
      mirrorAcrossHandSide(candidate),
      { hingeAxis: vector(-1, 0, 0) },
    )).toEqual({ safe: true });
  });

  it("allows rigid lateral MCP motion when the downstream joint angles stay unchanged", () => {
    const source = chainFromAngles([0, degrees(12), degrees(21)]);
    const lateralMcpRotation = new THREE.Quaternion().setFromAxisAngle(vector(0, 1, 0), degrees(27));
    const candidate = source.map((point) => point.clone().applyQuaternion(lateralMcpRotation));

    expect(checkTestingFingerChainCorrection(source, candidate, { hingeAxis: vector(1, 0, 0) })).toEqual({ safe: true });
  });

  it("rejects a long ring-finger candidate that reverses DIP flexion in the 49-second capture", () => {
    // Capture pair from scratch/testing-hand-habanera49-ik-off.json and
    // scratch/testing-hand-habanera49.json. The rounded points retain segment
    // lengths while the approximate signed DIP bend changes from -8.3 to +8.1°.
    const source = [
      vector(1.232, 1.373, 1.231),
      vector(1.315, 0.939, -0.482),
      vector(1.357, 0.248, -1.331),
      vector(1.380, -0.270, -1.800),
    ];
    const candidate = [
      vector(1.232, 1.373, 1.231),
      vector(1.319, 1.091, -0.514),
      vector(1.342, 0.291, -1.261),
      vector(1.396, -0.151, -1.800),
    ];
    const proximalLocalX = vector(0.9503, -0.2880, 0.1182);

    const result = checkTestingFingerChainCorrection(source, candidate, { hingeAxis: proximalLocalX });
    expect(result).toEqual({ safe: false, reason: "reversed-flexion" });
  });

  it("rejects a substantial side bend while allowing the source shape to remain unchanged", () => {
    const source = chainFromAngles([0, degrees(10), degrees(18)], [degrees(2), degrees(3), degrees(4)]);
    const lateralCandidate = chainFromAngles([0, degrees(10), degrees(18)], [degrees(2), degrees(28), degrees(32)]);
    const hingeAxis = vector(1, 0, 0);

    expect(checkTestingFingerChainCorrection(source, source, { hingeAxis })).toEqual({ safe: true });
    expect(checkTestingFingerChainCorrection(source, lateralCandidate, { hingeAxis })).toEqual({
      safe: false,
      reason: "added-lateral-bend",
    });
  });

  it("keeps every repeated candidate relative to the same pre-IK source plane", () => {
    const preIk = chainFromAngles([0, 0, 0]);
    const firstSmallStep = chainFromAngles([0, 0, 0], [0, degrees(2), 0]);
    const cumulativeStep = chainFromAngles([0, 0, 0], [0, degrees(4), 0]);
    const hingeAxis = vector(1, 0, 0);

    // Each incremental step looks small when measured from the last candidate,
    // but the accumulated 4° side bend exceeds the original 2.5° allowance.
    expect(checkTestingFingerChainCorrection(preIk, firstSmallStep, { hingeAxis })).toEqual({ safe: true });
    expect(checkTestingFingerChainCorrection(firstSmallStep, cumulativeStep, { hingeAxis })).toEqual({ safe: true });
    expect(checkTestingFingerChainCorrection(preIk, cumulativeStep, { hingeAxis })).toEqual({
      safe: false,
      reason: "added-lateral-bend",
    });
  });

  it("rejects a candidate that reverses an existing flexion direction", () => {
    const source = chainFromAngles([0, degrees(-22), degrees(-34)]);
    const reversed = chainFromAngles([0, degrees(22), degrees(34)]);

    expect(checkTestingFingerChainCorrection(source, reversed, { hingeAxis: vector(1, 0, 0) })).toEqual({
      safe: false,
      reason: "reversed-flexion",
    });
  });

  it("rejects the 49-second DIP sign flip even when the reverse bend is only 2.83 degrees", () => {
    // Relative joint bends match the browser A/B: source PIP/DIP are about
    // 23.9°/8.32° in one direction; the candidate PIP deepens to 36.7° while
    // DIP crosses zero to -2.83°. The absolute sign is source-plane-relative.
    const source = chainFromAngles([0, degrees(23.9), degrees(32.22)]);
    const candidate = chainFromAngles([0, degrees(36.7), degrees(33.87)]);

    expect(checkTestingFingerChainCorrection(source, candidate, { hingeAxis: vector(1, 0, 0) })).toEqual({
      safe: false,
      reason: "reversed-flexion",
    });
  });

  it("tolerates only a sub-0.5-degree sign crossing as geometric noise", () => {
    const source = chainFromAngles([0, degrees(23.9), degrees(32.22)]);
    const candidate = chainFromAngles([0, degrees(36.7), degrees(36.4)]);

    expect(checkTestingFingerChainCorrection(source, candidate, { hingeAxis: vector(1, 0, 0) })).toEqual({ safe: true });
  });

  it("allows additional flexion when each existing joint keeps its bend direction", () => {
    const source = chainFromAngles([0, degrees(8), degrees(16)]);
    const moreFlexion = chainFromAngles([0, degrees(25), degrees(39)]);

    expect(checkTestingFingerChainCorrection(source, moreFlexion, { hingeAxis: vector(1, 0, 0) })).toEqual({ safe: true });
  });

  it("checks the thumb's three-point MCP-to-IP chain separately", () => {
    const source = chainFromAngles([0, degrees(5)]);
    const candidate = chainFromAngles([0, degrees(22)]);

    expect(checkTestingFingerChainCorrection(source, candidate, {
      hingeAxis: vector(1, 0, 0),
      thumb: true,
    })).toEqual({ safe: true });
    expect(checkTestingFingerChainCorrection(source, candidate, { hingeAxis: vector(1, 0, 0) })).toEqual({
      safe: false,
      reason: "point-count",
    });
  });

  it("rejects degenerate chains and straight chains with no known plane", () => {
    const degenerate = [vector(0, 0, 0), vector(0, 0, 1), vector(0, 0, 1), vector(0, 0, 2)];
    const straight = chainFromAngles([0, 0, 0]);
    const flexed = chainFromAngles([0, degrees(12), degrees(20)]);

    expect(checkTestingFingerChainCorrection(degenerate, degenerate, { hingeAxis: vector(1, 0, 0) })).toEqual({
      safe: false,
      reason: "degenerate-segment",
    });
    expect(checkTestingFingerChainCorrection(straight, flexed)).toEqual({
      safe: false,
      reason: "unknown-plane",
    });
  });

  it("rejects an antiparallel proximal segment because its transported plane is ambiguous", () => {
    const source = chainFromAngles([0, 0, 0]);
    const antiparallel = chainFromAngles([Math.PI, Math.PI, Math.PI]);

    expect(checkTestingFingerChainCorrection(source, antiparallel, { hingeAxis: vector(1, 0, 0) })).toEqual({
      safe: false,
      reason: "unstable-plane",
    });
  });

  it("rejects linearly mixed candidates with noticeable segment-length changes", () => {
    const source = chainFromAngles([0, degrees(8), degrees(16)]);
    const target = chainFromAngles([0, degrees(85), degrees(120)]);
    const halfway = source.map((point, index) => point.clone().lerp(target[index]!, 0.5));

    expect(checkTestingFingerChainCorrection(source, halfway, { hingeAxis: vector(1, 0, 0) })).toEqual({
      safe: false,
      reason: "length-change",
    });
  });
});
