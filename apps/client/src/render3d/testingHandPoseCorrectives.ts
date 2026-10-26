import type * as THREE from "three";
import type { ReconstructedHand3D } from "./handRigBuilder";
import { unsignedJointBendDegrees } from "./testingHandPianistBenchmark";

/**
 * Offline/opt-in pose-space-corrective driver contract.
 *
 * Blender creates native morph targets called pmcorr_{finger}_{joint}_{030|060|090}.
 * Weights are evaluated from the *unchanged* reconstructed WebXR hand motion.
 * No such morphs exist in the current production GLBs, and the driver MUST NOT
 * be attached to visible Testing until Blender-authored shapes and calibrated
 * anatomical flexion axes have passed visual QA.
 *
 * The current unsigned joint angles cannot distinguish flexion from extension:
 * using them to deform skin before axis calibration could make the hand worse.
 */
export interface TestingCorrectiveResult {
  supportedTargets: number;
  drivenTargets: number;
  missingTargets: string[];
  ignoredWristTargets: number;
}

type JointName = "cmc" | "mcp" | "pip" | "dip" | "ip";

type MorphMesh = Pick<THREE.SkinnedMesh, "morphTargetDictionary" | "morphTargetInfluences">;

function landmarkTuple(point: THREE.Vector3): readonly [number, number, number] {
  return [point.x, point.y, point.z];
}

/** Interpolates neighboring artist-authored 30/60/90 degree keys. */
export function correctiveWeightsForAngle(angle: number): readonly [number, number, number] {
  if (!Number.isFinite(angle) || angle < 0) throw new Error("Corrective angle must be nonnegative and finite.");
  const bend = Math.min(90, angle);
  if (bend <= 30) return [bend / 30, 0, 0];
  if (bend <= 60) return [(60 - bend) / 30, (bend - 30) / 30, 0];
  return [0, (90 - bend) / 30, (bend - 60) / 30];
}

export function pianistCorrectiveJointAngles(
  hand: ReconstructedHand3D,
): ReadonlyMap<string, number> {
  const angles = new Map<string, number>();
  for (const [fingerNumber, fingerName] of [
    [1, "thumb"], [2, "index"], [3, "middle"], [4, "ring"], [5, "pinky"],
  ] as const) {
    const points = hand.chains[fingerNumber];
    const length = fingerNumber === 1 ? 4 : 5;
    if (!points || points.length !== length) {
      throw new Error(`Missing reconstructed ${fingerName} chain for corrective driver.`);
    }
    const joints: readonly JointName[] = fingerNumber === 1
      ? ["mcp", "ip"]
      : ["mcp", "pip", "dip"];
    for (let joint = 0; joint < joints.length; joint++) {
      const before = points[joint]!;
      const pivot = points[joint + 1]!;
      const after = points[joint + 2]!;
      angles.set(
        `${fingerName}_${joints[joint]}`,
        unsignedJointBendDegrees(landmarkTuple(before), landmarkTuple(pivot),
          landmarkTuple(after)),
      );
    }
    // Thumb CMC: wrist->CMC->MCP. This is only an *unsigned* bend estimate.
    // A calibrated opposition/abduction decomposition will be needed later.
    if (fingerNumber === 1) {
      angles.set("thumb_cmc", unsignedJointBendDegrees(
        landmarkTuple(hand.wristCenter), landmarkTuple(points[0]!),
        landmarkTuple(points[1]!),
      ));
    }
  }
  return angles;
}

/**
 * Calculate mapping for actual imported morph names, without touching bones.
 * Returns only recognized morph names. Extra scene/object morphs are unaffected.
 * In particular wrist_flex_* remains zero until forearm flexion is calibrated.
 */
export function evaluateTestingCorrectiveMorphs(
  mesh: MorphMesh,
  angles: ReadonlyMap<string, number>,
): TestingCorrectiveResult {
  const dict = mesh.morphTargetDictionary;
  const weights = mesh.morphTargetInfluences;
  if (!dict || !weights) {
    return { supportedTargets: 0, drivenTargets: 0, missingTargets: [], ignoredWristTargets: 0 };
  }
  let supportedTargets = 0;
  let drivenTargets = 0;
  let ignoredWristTargets = 0;
  const missingTargets: string[] = [];
  for (const [joint, angle] of angles) {
    const triple = correctiveWeightsForAngle(angle);
    for (const [slot, degrees] of [30, 60, 90].entries()) {
      const targetName = `pmcorr_${joint}_${String(degrees).padStart(3, "0")}`;
      const index = dict[targetName];
      if (index === undefined) {
        missingTargets.push(targetName);
        continue;
      }
      if (index < 0 || index >= weights.length) {
        throw new Error(`Corrective morph index out of bounds: ${targetName}`);
      }
      supportedTargets++;
      weights[index] = triple[slot]!;
      if (triple[slot]! > 0) drivenTargets++;
    }
  }
  // New, incomplete assets must never apply unrelated wrist corrections
  // based on an arbitrary signless flexion heuristic.
  for (const degrees of [30, 60, 90]) {
    const index = dict[`pmcorr_wrist_flex_${String(degrees).padStart(3, "0")}`];
    if (index === undefined) continue;
    if (index < 0 || index >= weights.length) throw new Error("Invalid wrist corrective morph index.");
    weights[index] = 0;
    ignoredWristTargets++;
  }
  return { supportedTargets, drivenTargets, missingTargets, ignoredWristTargets };
}
