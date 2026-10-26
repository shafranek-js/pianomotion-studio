import * as THREE from "three";
import type { ReconstructedHand3D } from "./handRigBuilder";

/**
 * Standard 21-landmark ordering shared by MediaPipe/FürElise:
 * 0 wrist, 1..4 thumb (CMC/MCP/IP/tip), 5..8 index (MCP/PIP/DIP/tip),
 * 9..12 middle, 13..16 ring, 17..20 little finger.
 *
 * This is an OFFLINE comparison adapter, not a piano motion controller.
 * Existing WebXR motion and hand/finger assignments remain untouched.
 */
export type HandLandmark3 = readonly [number, number, number];
export type PianistHandLandmarks = readonly HandLandmark3[];
export interface PianoJointFlexion {
  hand: "left" | "right";
  finger: number;
  joint: "CMC" | "MCP" | "PIP" | "DIP" | "IP";
  bendDegrees: number;
}

/** Coordinates remain world-inches, matching the current renderer. */
export function extractPianistHandLandmarks(
  hand: ReconstructedHand3D,
): PianistHandLandmarks {
  const vertices: THREE.Vector3[] = [hand.wristCenter];
  for (const finger of [1, 2, 3, 4, 5]) {
    const chain = hand.chains[finger];
    const expected = finger === 1 ? 4 : 5;
    if (!chain || chain.length !== expected ||
        chain.some(point => ![point.x, point.y, point.z].every(Number.isFinite))) {
      throw new Error(`Pianist landmark adapter missing a valid finger ${finger} chain.`);
    }
    vertices.push(...(finger === 1 ? chain : chain.slice(1)));
  }
  if (vertices.length !== 21) throw new Error("Pianist 21-landmark layout is incomplete.");
  return vertices.map(v => [v.x, v.y, v.z] as const);
}

/**
 * Measure the unsigned change in direction at a joint, independent of hand
 * mirroring and absolute size. 0 = straight, 90 = right-angle flexion.
 * This is *not* a joint-range pass/fail: extension vs flexion must be inferred
 * from a calibrated anatomical hinge orientation and human reference data.
 */
export function unsignedJointBendDegrees(
  before: HandLandmark3,
  joint: HandLandmark3,
  after: HandLandmark3,
): number {
  const a = new THREE.Vector3(joint[0] - before[0], joint[1] - before[1], joint[2] - before[2]);
  const b = new THREE.Vector3(after[0] - joint[0], after[1] - joint[1], after[2] - joint[2]);
  if (a.lengthSq() <= 1e-10 || b.lengthSq() <= 1e-10) {
    throw new Error("Pianist joint bend has a zero-length phalanx.");
  }
  return THREE.MathUtils.radToDeg(a.angleTo(b));
}

export function measurePianistJointBends(hand: ReconstructedHand3D): PianoJointFlexion[] {
  const result: PianoJointFlexion[] = [];
  for (let finger = 1; finger <= 5; finger++) {
    const chain = hand.chains[finger];
    const expected = finger === 1 ? 4 : 5;
    if (!chain || chain.length !== expected) throw new Error(`No valid pianist finger ${finger} chain.`);
    const names: PianoJointFlexion["joint"][] = finger === 1
      ? ["MCP", "IP"]
      : ["MCP", "PIP", "DIP"];
    for (let offset = 0; offset < names.length; offset++) {
      const i = offset + 1;
      const asTuple = (v: THREE.Vector3): HandLandmark3 => [v.x, v.y, v.z];
      result.push({
        hand: hand.hand,
        finger,
        joint: names[offset]!,
        bendDegrees: unsignedJointBendDegrees(
          asTuple(chain[i - 1]!), asTuple(chain[i]!), asTuple(chain[i + 1]!),
        ),
      });
    }
  }
  return result;
}

/**
 * Compare two recorded frames using wrist-width normalization so a pianist
 * with different hand size may serve as a motion reference.
 * The caller must align left/right, score timestamps, hand orientation and
 * keyboard calibration before interpreting the result.
 */
export function normalizedPianistLandmarkError(
  reference: PianistHandLandmarks,
  observed: PianistHandLandmarks,
): number {
  if (reference.length !== 21 || observed.length !== 21) {
    throw new Error("Pianist landmark comparison requires two complete 21-point hands.");
  }
  const width = (p: PianistHandLandmarks) => {
    const index = new THREE.Vector3(...p[5]!);
    const little = new THREE.Vector3(...p[17]!);
    return index.distanceTo(little);
  };
  const scaleRef = width(reference);
  const scaleObserved = width(observed);
  if (!(scaleRef > 1e-6) || !(scaleObserved > 1e-6)) {
    throw new Error("Pianist benchmark has degenerate MCP hand width.");
  }
  // Translate to wrist, normalize by index-to-little MCP span.
  let squared = 0;
  for (let i = 0; i < 21; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const r = (reference[i]![axis]! - reference[0]![axis]!) / scaleRef;
      const o = (observed[i]![axis]! - observed[0]![axis]!) / scaleObserved;
      if (!Number.isFinite(r) || !Number.isFinite(o)) {
        throw new Error("Pianist benchmark has non-finite coordinates.");
      }
      squared += (r - o) ** 2;
    }
  }
  return Math.sqrt(squared / 21);
}
