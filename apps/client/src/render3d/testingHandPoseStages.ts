import * as THREE from "three";
import type { ReconstructedHand3D } from "./handRigBuilder";

/** Minimal point shape used by the temporary distal contact frames. */
export interface TestingHandPoseStagePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Structural subset of the contact frame; no private rig type is required. */
export interface TestingHandPoseStageFrame {
  readonly finger: number;
  readonly active: boolean;
  readonly mcp: TestingHandPoseStagePoint;
  readonly pip: TestingHandPoseStagePoint;
  readonly dip: TestingHandPoseStagePoint;
  readonly tip: TestingHandPoseStagePoint;
}

export interface TestingHandPoseStages {
  /** Independent deep copy of the reconstructed chains before key contact. */
  beforeContact: ReconstructedHand3D;
  /** Deep copy with active contact-frame joints applied to the matching chains. */
  afterContact: ReconstructedHand3D;
}

function cloneVector(point: TestingHandPoseStagePoint): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y, point.z);
}

function cloneHand(hand: ReconstructedHand3D): ReconstructedHand3D {
  return {
    hand: hand.hand,
    wristR: hand.wristR.clone(),
    wristU: hand.wristU.clone(),
    wristCenter: hand.wristCenter.clone(),
    wristWidthIn: hand.wristWidthIn,
    armEnd: hand.armEnd.clone(),
    palmNormal: hand.palmNormal.clone(),
    chains: Object.fromEntries(
      Object.entries(hand.chains).map(([finger, chain]) => [
        finger,
        chain.map(point => point.clone()),
      ]),
    ),
    chainDiagnostics: hand.chainDiagnostics.map(diagnostic => ({ ...diagnostic })),
  };
}

function copyFramePoint(
  point: TestingHandPoseStagePoint,
  finger: number,
  joint: string,
): THREE.Vector3 {
  if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) {
    throw new Error(`Testing hand contact frame has a non-finite ${joint} point for finger ${finger}.`);
  }
  return cloneVector(point);
}

/**
 * Capture independent before/after contact snapshots for offline pose-stage
 * diagnostics. Active frames replace only the joints represented by their
 * distal contact solution; all source and frame objects remain untouched.
 */
export function snapshotTestingHandPoseStages(
  hand: ReconstructedHand3D,
  frames: readonly TestingHandPoseStageFrame[],
): TestingHandPoseStages {
  const beforeContact = cloneHand(hand);
  const afterContact = cloneHand(beforeContact);
  const seenFingers = new Set<number>();

  for (const frame of frames) {
    if (!frame.active) continue;
    const finger = frame.finger;
    if (!Number.isInteger(finger) || finger < 1 || finger > 5) {
      throw new Error(`Testing hand contact frame has an invalid finger: ${finger}.`);
    }
    if (seenFingers.has(finger)) {
      throw new Error(`Testing hand contact frame is duplicated for finger ${finger}.`);
    }
    seenFingers.add(finger);

    const chain = afterContact.chains[finger];
    const expectedLength = finger === 1 ? 4 : 5;
    if (!chain || chain.length !== expectedLength) {
      throw new Error(`Testing hand snapshot requires a valid ${finger === 1 ? "thumb" : "finger"} ${finger} chain.`);
    }

    const mcp = copyFramePoint(frame.mcp, finger, "MCP");
    const pip = copyFramePoint(frame.pip, finger, "PIP");
    const dip = copyFramePoint(frame.dip, finger, finger === 1 ? "IP" : "DIP");
    const tip = copyFramePoint(frame.tip, finger, "tip");
    if (finger === 1) {
      // Thumb chain order is [CMC, MCP, IP, tip]. Its legacy contact frame's
      // PIP aliases MCP, while DIP carries the solved thumb IP position.
      chain[1] = mcp;
      chain[2] = dip;
      chain[3] = tip;
    } else {
      // Long-finger chain order is [base, MCP, PIP, DIP, tip].
      chain[1] = mcp;
      chain[2] = pip;
      chain[3] = dip;
      chain[4] = tip;
    }
  }

  return { beforeContact, afterContact };
}
