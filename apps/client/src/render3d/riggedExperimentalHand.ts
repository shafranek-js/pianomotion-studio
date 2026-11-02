import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { ReconstructedHand3D } from "./handRigBuilder";
import { computeNoteRearticulationWeight, type ImprovedHandContactTarget } from "./improvedHandContact";

export type RiggedExperimentalHandSide = "left" | "right";
type Side = RiggedExperimentalHandSide;
type Vec3Tuple = readonly [number, number, number];
type QuaternionTuple = readonly [number, number, number, number];
type RiggedExperimentalBonePose = Readonly<{
  name: string;
  position: Vec3Tuple;
  quaternion: QuaternionTuple;
}>;
/** Versioned, immutable local-transform snapshot for the experimental 22-bone rig. */
export type RiggedExperimentalHandPose = Readonly<{
  schemaVersion: 1;
  side: RiggedExperimentalHandSide;
  group: Readonly<{
    position: Vec3Tuple;
    quaternion: QuaternionTuple;
    scale: Vec3Tuple;
  }>;
  bones: readonly RiggedExperimentalBonePose[];
}>;
export type RiggedExperimentalHandPoseBlend = Readonly<{
  pose: RiggedExperimentalHandPose;
  /** 0 shows the starting snapshot; 1 shows the live motion pose. */
  liveAlpha: number;
}>;
export type RiggedExperimentalContactContext = Readonly<{
  /** Authored starting pose used as the continuous reference base across all frames. */
  referencePose?: RiggedExperimentalHandPose | null;
  /** Per-finger keyboard contact targets for the current transport time. */
  contactTargets?: readonly ImprovedHandContactTarget[];
  /** Displayed transport time in seconds, used for smooth transitions around t = 0. */
  displayedTransportTimeSeconds?: number;
}>;

/** Pure displayed-time mapping: seeking to the same transport time gives the same blend. */
export function riggedHandStartPoseLiveAlpha(displayedTransportTimeSeconds: number, leadInDurationSeconds: number): number {
  if (!Number.isFinite(displayedTransportTimeSeconds) || !Number.isFinite(leadInDurationSeconds) ||
      displayedTransportTimeSeconds >= 0 || leadInDurationSeconds <= 0) return 1;
  const duration = Math.min(leadInDurationSeconds, 2);
  const startSeconds = -duration;
  const progress = THREE.MathUtils.clamp((displayedTransportTimeSeconds - startSeconds) / duration, 0, 1);
  // Smoothstep gives zero blend velocity at the authored pose and at the first gameplay frame.
  return progress * progress * (3 - 2 * progress);
}
type BaseMotionFrame = {
  parentWorldQuaternion: THREE.Quaternion;
  childDirectionInBone: THREE.Vector3;
};
const METERS_TO_INCHES = 1 / 0.0254;
function isFiniteVector3(value: THREE.Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}
// Conservative rendering guard for the experimental side-motion channel;
// this is not a validated anatomical range-of-motion claim.
const MAX_MCP_SIDE_ANGLE = THREE.MathUtils.degToRad(15);
// One source-derived scale, calibrated against phalanx lengths in the research
// fixture; deliberately fixed across frames instead of scaling individual bones.
const SOURCE_SCALE: Record<Side, number> = { left: 0.219315506, right: 0.219315291 };
type IndexJoint = "proximal" | "intermediate" | "distal";
const LOCAL_X_FLEX_AXIS = new THREE.Vector3(1, 0, 0);
const DIAGNOSTIC_FINGER_BONE_ORDER = [
  "thumb_segment0_cmc-to-mcp", "thumb_segment1_mcp-to-ip", "thumb_distal-segment-a", "thumb_distal-segment-b",
  "index_metacarpal", "index_proximal", "index_intermediate", "index_distal",
  "middle_metacarpal", "middle_proximal", "middle_intermediate", "middle_distal",
  "ring_metacarpal", "ring_proximal", "ring_intermediate", "ring_distal",
  "little_metacarpal", "little_proximal", "little_intermediate", "little_distal",
  // Schema v2 appends non-finger bones without changing IDs 0-19.
  "forearm", "palm",
] as const;
/** Stable suffix order for the exact 22 joints in the checked-in experimental GLBs. */
export const RIGGED_EXPERIMENTAL_POSE_BONE_SUFFIXES = DIAGNOSTIC_FINGER_BONE_ORDER;
export type RiggedExperimentalHandBoneName = `${RiggedExperimentalHandSide}_${typeof RIGGED_EXPERIMENTAL_POSE_BONE_SUFFIXES[number]}`;
const POSE_EDIT_BONE_COUNT = 22;
const QUATERNION_UNIT_TOLERANCE = 1e-3;
const DIAGNOSTIC_DISTAL_BONES = [
  { finger: 1, name: "thumb_distal-segment-b" },
  { finger: 2, name: "index_distal" },
  { finger: 3, name: "middle_distal" },
  { finger: 4, name: "ring_distal" },
  { finger: 5, name: "little_distal" },
] as const;
const DIAGNOSTIC_SAMPLE_COUNT_PER_FINGER = 3;
const MIN_DISTAL_BONE_INFLUENCE = 0.25;
// Three.js 0.186's Quaternion.setFromUnitVectors switches to an arbitrary
// perpendicular swing axis when 1 + dot(from, to) < 1e-8. Ramp correction to
// zero at that boundary and back to full strength by 1e-5. The ramp's outer
// edge is about 0.256 degrees from exact antiparallel; this is a numerical
// conditioning guard, not an anatomical range.
const FOREARM_AXIS_OPPOSITION_RAMP_START = 1e-8;
const FOREARM_AXIS_OPPOSITION_RAMP_END = 1e-5;
/**
 * Source-asset-specific calibration for the checked-in left rigged-experimental
 * GLB (SHA-256
 * `7ce76e5d5f6279d0ac63fe07da062e040ad018670ba827381735b7c18f832dfe`). These fixed
 * unit axes were derived from the Habanera measured-profile first covered pose
 * (source t=0). Each target hinge plane was transformed through the
 * parent-coupled GLB joint frame into that joint's local bind frame. They
 * remain fixed across profiles and frames, without per-frame recalibration.
 * This is experimental, not validated anatomy.
 * Evidence: `scratch/hand-candidate-index-fix-20261029-fixed/` (16 Habanera
 * comparisons) and `scratch/hand-candidate-index-fix-portability-20261029/`
 * (28 Fur Elise/Megalovania comparisons across Default/measured profiles).
 * Offline A/B showed a visibly straighter left index at app idle and preserved
 * its form at 43.5 s. One Fur Elise inactive tail sample regressed by ~4.7°,
 * so broader pose/contact acceptance remains open.
 */
const LEFT_INDEX_SOURCE_LOCAL_FLEX_AXES: Readonly<Record<IndexJoint, THREE.Vector3>> = Object.freeze({
  proximal: new THREE.Vector3(0.9155928434597187, -0.1948982392134811, 0.35171639335810295).normalize(),
  intermediate: new THREE.Vector3(0.9276011833672116, -0.0805432785661098, 0.3647859987630701).normalize(),
  distal: new THREE.Vector3(0.9096274932824899, -0.11587193885410042, 0.3989379867232567).normalize(),
});
/** Measured independently from the right GLB; deliberately not reflected from the left table. */
const RIGHT_INDEX_SOURCE_LOCAL_FLEX_AXES: Readonly<Record<IndexJoint, THREE.Vector3>> = Object.freeze({
  proximal: new THREE.Vector3(0.915583559, 0.194897975, -0.351740709).normalize(),
  intermediate: new THREE.Vector3(0.927360697, 0.003857827, -0.374148706).normalize(),
  distal: new THREE.Vector3(0.913011081, 0.038516274, -0.406112377).normalize(),
});
const DIGITS = [
  { number: 2, name: "index" },
  { number: 3, name: "middle" },
  { number: 4, name: "ring" },
  { number: 5, name: "little" },
] as const;

function freezeVector3Tuple(value: THREE.Vector3): Vec3Tuple {
  return Object.freeze([value.x, value.y, value.z]) as Vec3Tuple;
}

function freezeQuaternionTuple(value: THREE.Quaternion): QuaternionTuple {
  const normalized = value.clone();
  if (!Number.isFinite(normalized.lengthSq()) || normalized.lengthSq() < 1e-16) {
    throw new Error("Experimental hand pose contains an invalid local quaternion.");
  }
  normalized.normalize();
  return Object.freeze([normalized.x, normalized.y, normalized.z, normalized.w]) as QuaternionTuple;
}

function boneDepth(bone: THREE.Bone): number {
  let depth = 0;
  let parent = bone.parent;
  while (parent) {
    if (parent instanceof THREE.Bone) depth += 1;
    parent = parent.parent;
  }
  return depth;
}

function requireObject(value: unknown, label: string, expectedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Experimental hand pose ${label} must be an object.`);
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== expectedKeys.length || expectedKeys.some(key => !Object.prototype.hasOwnProperty.call(object, key))) {
    throw new Error(`Experimental hand pose ${label} has an invalid shape.`);
  }
  return object;
}

function readVector3Tuple(value: unknown, label: string, allowZero = true): Vec3Tuple {
  if (!Array.isArray(value) || value.length !== 3 || [0, 1, 2].some(index => typeof value[index] !== "number" || !Number.isFinite(value[index]))) {
    throw new Error(`Experimental hand pose ${label} must contain three finite numbers.`);
  }
  const tuple = [value[0] as number, value[1] as number, value[2] as number] as const;
  if (!allowZero && tuple.some(component => component <= 0)) throw new Error(`Experimental hand pose ${label} must be positive.`);
  return tuple;
}

function readQuaternionTuple(value: unknown, label: string): QuaternionTuple {
  if (!Array.isArray(value) || value.length !== 4 || [0, 1, 2, 3].some(index => typeof value[index] !== "number" || !Number.isFinite(value[index]))) {
    throw new Error(`Experimental hand pose ${label} must contain four finite numbers.`);
  }
  const tuple = [value[0] as number, value[1] as number, value[2] as number, value[3] as number] as const;
  const length = Math.hypot(...tuple);
  if (length < 1e-8 || Math.abs(length - 1) > QUATERNION_UNIT_TOLERANCE) {
    throw new Error(`Experimental hand pose ${label} must be a unit quaternion.`);
  }
  return tuple;
}

function vectorFromTuple(value: Vec3Tuple): THREE.Vector3 {
  return new THREE.Vector3(value[0], value[1], value[2]);
}

function quaternionFromTuple(value: QuaternionTuple): THREE.Quaternion {
  return new THREE.Quaternion(value[0], value[1], value[2], value[3]).normalize();
}

function palmFrame(side: Side, wrist: THREE.Vector3, mcps: THREE.Vector3[]): THREE.Quaternion {
  const index = mcps[0]!.clone().sub(wrist);
  const little = mcps[3]!.clone().sub(wrist);
  const up = side === "left"
    ? new THREE.Vector3().crossVectors(index, little)
    : new THREE.Vector3().crossVectors(little, index);
  // Source and target use the reviewed palm-down convention. The GLBs have
  // no metadata identifying their dorsal surface, so this is model-specific.
  if (up.lengthSq() < 1e-10) return new THREE.Quaternion();
  up.normalize().negate();
  const middle = mcps.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(0.25);
  const forward = middle.sub(wrist);
  forward.addScaledVector(up, -forward.dot(up));
  if (forward.lengthSq() < 1e-10) return new THREE.Quaternion();
  forward.normalize();
  const z = forward.negate();
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** A bounded, diagnostic bend; it is not an anatomical ROM or a contact solver. */
function flexAngle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, up: THREE.Vector3, cap: number): number {
  const before = new THREE.Vector3().subVectors(b, a);
  const after = new THREE.Vector3().subVectors(c, b);
  if (before.lengthSq() < 1e-10 || after.lengthSq() < 1e-10) return 0;
  before.normalize();
  after.normalize();
  const lateral = new THREE.Vector3().crossVectors(before, up).normalize();
  if (lateral.lengthSq() < 1e-10) return 0;
  const bend = Math.atan2(-new THREE.Vector3().crossVectors(before, after).dot(lateral), before.dot(after));
  return -THREE.MathUtils.clamp(bend, 0, cap);
}

/** Experimental source rig. Retains its nested skeleton and bind lengths. */
export class RiggedExperimentalHand {
  public readonly group = new THREE.Group();
  public readonly triangleCount: number;
  public readonly sourceAssetSha256: string | null;
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly bindRotations = new Map<string, THREE.Quaternion>();
  private readonly baseMotionFrames = new Map<string, BaseMotionFrame>();
  private readonly sideMotionUp = new THREE.Vector3();
  private readonly sideMotionTarget = new THREE.Vector3();
  private readonly sideMotionCurrent = new THREE.Vector3();
  private readonly sideMotionCross = new THREE.Vector3();
  private readonly sideMotionParentWorld = new THREE.Quaternion();
  private readonly sideMotionWorldDelta = new THREE.Quaternion();
  private readonly sideMotionBoneWorld = new THREE.Quaternion();
  private readonly sideMotionTargetWorld = new THREE.Quaternion();
  private readonly forearmAxisCurrent = new THREE.Vector3();
  private readonly forearmAxisTarget = new THREE.Vector3();
  private readonly forearmAxisForearmRoot = new THREE.Vector3();
  private readonly forearmAxisPalmWorldPosition = new THREE.Vector3();
  private readonly forearmAxisPalmParentPosition = new THREE.Vector3();
  private readonly forearmAxisMovedPalmParentPosition = new THREE.Vector3();
  private readonly forearmAxisParentInverse = new THREE.Matrix4();
  private readonly forearmAxisPalmWorldQuaternion = new THREE.Quaternion();
  private readonly forearmAxisParentWorldQuaternion = new THREE.Quaternion();
  private readonly forearmAxisParentWorldInverse = new THREE.Quaternion();
  private readonly forearmAxisGroupWorldQuaternion = new THREE.Quaternion();
  private readonly forearmAxisFullSwing = new THREE.Quaternion();
  private readonly forearmAxisSwing = new THREE.Quaternion();
  private readonly forearmAxisPalmParentWorldQuaternion = new THREE.Quaternion();
  private readonly forearmAxisPalmParentWorldInverse = new THREE.Quaternion();
  private readonly sourceWrist: THREE.Vector3;
  private readonly sourceFrame: THREE.Quaternion;
  private readonly mesh: THREE.SkinnedMesh;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly fixedDistalSkinSamples: Array<{ finger: number; sample: number; vertexIndex: number; terminalBoneWeight: number }> = [];
  private readonly fingerDistalHullSamples = new Map<number, number[]>();
  private readonly fingerPhalanxHullSamples = new Map<number, number[]>();
  private readonly importedBasePose!: RiggedExperimentalHandPose;
  private poseBeforeEdit: RiggedExperimentalHandPose | null = null;
  private poseEditMode = false;
  private readonly solverWorldY = new THREE.Vector3(0, 1, 0);
  private readonly solverHingeAxis = new THREE.Vector3();
  private readonly solverPivotWorld = new THREE.Vector3();
  private readonly solverMidPivotWorld = new THREE.Vector3();
  private readonly solverMeanPoint = new THREE.Vector3();
  private readonly solverDirXZ = new THREE.Vector3();
  private readonly solverParentWorldQ = new THREE.Quaternion();
  private readonly solverParentWorldInv = new THREE.Quaternion();
  private readonly solverBoneWorldQ = new THREE.Quaternion();
  private readonly solverDeltaWorldQ = new THREE.Quaternion();
  private readonly solverSamplePoints = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly solverHullPoint = new THREE.Vector3();
  private readonly solverMinHullPoint = new THREE.Vector3();
  private readonly solverPipWorld = new THREE.Vector3();
  private readonly solverDipWorld = new THREE.Vector3();
  private readonly solverMidPhalanxWorld = new THREE.Vector3();
  private smoothedTransportTimeSeconds: number | null = null;
  private smoothedPalmWorldPosition = new THREE.Vector3();
  private readonly smoothedBoneQuaternions = new Map<string, THREE.Quaternion>();

  private constructor(private readonly side: Side, scene: THREE.Group, sourceAssetSha256: string | null) {
    this.sourceAssetSha256 = sourceAssetSha256;
    scene.updateMatrixWorld(true);
    let mesh: THREE.SkinnedMesh | undefined;
    scene.traverse((object) => {
      if (object instanceof THREE.SkinnedMesh) {
        if (mesh) throw new Error("Experimental hand asset contains multiple skins.");
        mesh = object;
      }
    });
    if (!mesh) throw new Error("Experimental hand asset contains no skin.");
    this.mesh = mesh;
    for (const bone of this.mesh.skeleton.bones) {
      if (this.bones.has(bone.name)) throw new Error(`Experimental hand asset contains duplicate bone ${bone.name}.`);
      this.bones.set(bone.name, bone);
      this.bindRotations.set(bone.name, bone.quaternion.clone());
    }
    if (this.mesh.skeleton.bones.length !== POSE_EDIT_BONE_COUNT || this.bones.size !== POSE_EDIT_BONE_COUNT) {
      throw new Error(`Experimental hand asset must contain exactly ${POSE_EDIT_BONE_COUNT} bones.`);
    }
    const expectedPoseNames = DIAGNOSTIC_FINGER_BONE_ORDER.map(name => `${side}_${name}`);
    if (expectedPoseNames.some(name => !this.bones.has(name)) || [...this.bones.keys()].some(name => !expectedPoseNames.includes(name))) {
      throw new Error(`Experimental ${side} hand bone names do not match the 22-bone pose contract.`);
    }
    const required = ["palm", "forearm", ...DIGITS.flatMap(({ name }) => [
      `${name}_metacarpal`, `${name}_proximal`, `${name}_intermediate`, `${name}_distal`,
    ]), "thumb_segment0_cmc-to-mcp", "thumb_segment1_mcp-to-ip", "thumb_distal-segment-a", "thumb_distal-segment-b"];
    for (const name of required) if (!this.bones.has(`${side}_${name}`)) throw new Error(`Experimental hand is missing ${side}_${name}.`);
    const baseMotionBones = DIGITS.map(({ name }) => `${name}_proximal`);
    for (const name of baseMotionBones) {
      const bone = this.bone(name);
      const child = this.firstBoneDescendant(bone);
      if (!child || !bone.parent) throw new Error(`Experimental hand lacks a child pivot for ${side}_${name}.`);
      const rootWorld = bone.getWorldPosition(new THREE.Vector3());
      const childWorld = child.getWorldPosition(new THREE.Vector3());
      const boneWorld = bone.getWorldQuaternion(new THREE.Quaternion());
      this.baseMotionFrames.set(name, {
        parentWorldQuaternion: bone.parent.getWorldQuaternion(new THREE.Quaternion()),
        childDirectionInBone: childWorld.sub(rootWorld).applyQuaternion(boneWorld.invert()),
      });
    }
    this.sourceWrist = this.bone("palm").getWorldPosition(new THREE.Vector3());
    this.sourceFrame = palmFrame(side, this.sourceWrist, DIGITS.map(({ name }) => this.bone(`${name}_proximal`).getWorldPosition(new THREE.Vector3())));
    this.selectFixedDistalSkinSamples();
    this.material = new THREE.MeshStandardMaterial({ color: 0xd5a38d, roughness: 0.72, metalness: 0, side: THREE.DoubleSide });
    const original = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
    this.mesh.material = this.material;
    for (const material of original) material.dispose();
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.triangleCount = (this.mesh.geometry.index?.count ?? this.mesh.geometry.getAttribute("position").count) / 3;
    this.group.name = `experimental-rigged-${side}`;
    this.group.add(scene);
    this.importedBasePose = this.capturePoseSnapshot();
  }

  public static async fromBuffer(side: Side, buffer: ArrayBuffer): Promise<RiggedExperimentalHand> {
    const gltf = await new GLTFLoader().parseAsync(buffer, "");
    let sourceAssetSha256: string | null = null;
    try {
      if (globalThis.crypto?.subtle) {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
        sourceAssetSha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      }
    } catch { /* Asset identity is unavailable when Web Crypto is unavailable. */ }
    return new RiggedExperimentalHand(side, gltf.scene, sourceAssetSha256);
  }

  public static async load(side: Side): Promise<RiggedExperimentalHand> {
    const url = `${import.meta.env.BASE_URL}models/hands/rigged-experimental/${side}.glb`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Experimental ${side} hand could not be loaded (${response.status}).`);
    return RiggedExperimentalHand.fromBuffer(side, await response.arrayBuffer());
  }

  private bone(name: string): THREE.Bone {
    const bone = this.bones.get(`${this.side}_${name}`);
    if (!bone) throw new Error(`Experimental hand is missing ${this.side}_${name}.`);
    return bone;
  }

  /** Captures all hand and bone transforms relative to their respective parents. */
  public exportPose(): RiggedExperimentalHandPose {
    return this.capturePoseSnapshot();
  }

  /**
   * Re-expresses a saved pose in this rig's real hierarchy, using each GLB's
   * bind-palm frame. The saved scene placement is removed before retargeting,
   * while authored palm rotation remains part of the pose.
   */
  public retargetPoseToHand(
    sourcePoseInput: RiggedExperimentalHandPose,
    target: RiggedExperimentalHand,
    reflectAcrossPalm: boolean,
  ): RiggedExperimentalHandPose {
    if (reflectAcrossPalm ? this.side === target.side : this.side !== target.side) {
      throw new Error("Pose retarget source and target sides do not match the requested reflection mode.");
    }
    const sourcePose = this.validatePose(sourcePoseInput);
    const sourceBefore = this.capturePoseSnapshot();
    const targetBefore = target === this ? sourceBefore : target.capturePoseSnapshot();
    try {
      this.applyValidatedPose(this.importedBasePose);
      this.group.updateMatrixWorld(true);
      const sourceBindPalmInverse = this.bone("palm").matrixWorld.clone().invert();
      this.applyValidatedPose(Object.freeze({ ...sourcePose, group: this.importedBasePose.group }));
      this.group.updateMatrixWorld(true);
      const sourceRelativeBySuffix = new Map<string, THREE.Matrix4>();
      for (const suffix of DIAGNOSTIC_FINGER_BONE_ORDER) {
        const bone = this.bone(suffix);
        sourceRelativeBySuffix.set(suffix, sourceBindPalmInverse.clone().multiply(bone.matrixWorld));
      }

      // Use the target GLB's actual root and bind frames. This matters because
      // the checked-in left and right scene roots are not direct tuple mirrors.
      target.applyValidatedPose(target.importedBasePose);
      target.group.updateMatrixWorld(true);
      const targetPalmWorld = target.bone("palm").matrixWorld.clone();
      const palmReflection = new THREE.Matrix4().makeScale(-1, 1, 1);
      const desiredWorldByName = new Map<string, THREE.Matrix4>();
      const convertedBySuffix = new Map<string, RiggedExperimentalBonePose>();
      const targetBones = [...target.bones.values()].sort((a, b) => boneDepth(a) - boneDepth(b));

      for (const targetBone of targetBones) {
        const suffix = targetBone.name.slice(`${target.side}_`.length);
        const sourceRelative = sourceRelativeBySuffix.get(suffix);
        if (!sourceRelative || !DIAGNOSTIC_FINGER_BONE_ORDER.includes(suffix as typeof DIAGNOSTIC_FINGER_BONE_ORDER[number])) {
          throw new Error(`Pose retarget is missing the matching ${suffix} bone matrix.`);
        }
        const desiredRelative = reflectAcrossPalm
          ? palmReflection.clone().multiply(sourceRelative).multiply(palmReflection)
          : sourceRelative;
        const desiredWorld = targetPalmWorld.clone().multiply(desiredRelative);
        const parent = targetBone.parent;
        if (!parent) throw new Error(`Pose retarget bone ${targetBone.name} has no parent.`);
        const parentWorld = parent instanceof THREE.Bone
          ? desiredWorldByName.get(parent.name)
          : parent.matrixWorld;
        if (!parentWorld) throw new Error(`Pose retarget parent frame for ${targetBone.name} is unavailable.`);
        const local = parentWorld.clone().invert().multiply(desiredWorld);
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        local.decompose(position, quaternion, scale);
        if (![...position.toArray(), ...quaternion.toArray(), ...scale.toArray()].every(Number.isFinite) || scale.distanceTo(targetBone.scale) > 2e-3) {
          throw new Error(`Pose retarget produced a non-rigid ${targetBone.name} local transform.`);
        }
        desiredWorldByName.set(targetBone.name, desiredWorld);
        convertedBySuffix.set(suffix, Object.freeze({
          name: targetBone.name,
          position: freezeVector3Tuple(position),
          quaternion: freezeQuaternionTuple(quaternion),
        }));
      }

      const bones = DIAGNOSTIC_FINGER_BONE_ORDER.map((suffix) => {
        const bone = convertedBySuffix.get(suffix);
        if (!bone) throw new Error(`Pose retarget did not produce ${target.side}_${suffix}.`);
        return bone;
      });
      return Object.freeze({
        schemaVersion: 1,
        side: target.side,
        group: target.importedBasePose.group,
        bones: Object.freeze(bones),
      });
    } finally {
      if (target !== this) target.applyValidatedPose(targetBefore);
      this.applyValidatedPose(sourceBefore);
    }
  }

  /** True while this instance is frozen for interactive pose editing. */
  public get isPoseEditMode(): boolean {
    return this.poseEditMode;
  }

  /** Freezes the displayed pose or restores it and resumes procedural updates. */
  public setPoseEditMode(enabled: boolean): void {
    if (enabled === this.poseEditMode) return;
    if (enabled) {
      this.poseBeforeEdit = this.capturePoseSnapshot();
      this.poseEditMode = true;
      return;
    }
    this.restoreAnimatedPose();
  }

  /** Leaves manual mode and restores the exact pose captured when it began. */
  public restoreAnimatedPose(): void {
    if (!this.poseEditMode) return;
    const restore = this.poseBeforeEdit ?? this.importedBasePose;
    this.poseEditMode = false;
    this.poseBeforeEdit = null;
    this.applyValidatedPose(restore);
  }

  /** Validates and applies an immutable local-transform snapshot, freezing animation. */
  public applyPose(pose: RiggedExperimentalHandPose): void {
    const validated = this.validatePose(pose);
    if (!this.poseEditMode) this.setPoseEditMode(true);
    this.applyValidatedPose(validated);
  }

  /** Returns a bone for a scene gizmo only while this hand is in manual edit mode. */
  public getEditableBone(name: string): THREE.Bone {
    if (!this.poseEditMode) throw new Error("Experimental hand bones are editable only in pose edit mode.");
    const bone = this.bones.get(name);
    if (!bone || !RIGGED_EXPERIMENTAL_POSE_BONE_SUFFIXES.some(suffix => name === `${this.side}_${suffix}`)) {
      throw new Error(`Experimental hand pose contains an unknown ${this.side} bone name: ${name}.`);
    }
    return bone;
  }

  /** Call from the gizmo's object-change callback after direct group/bone edits. */
  public refreshPoseEdit(): void {
    if (!this.poseEditMode) throw new Error("Experimental hand gizmos can be refreshed only in pose edit mode.");
    this.group.updateMatrixWorld(true);
    this.mesh.skeleton.update();
  }

  private capturePoseSnapshot(): RiggedExperimentalHandPose {
    const bones = DIAGNOSTIC_FINGER_BONE_ORDER.map((suffix) => {
      const bone = this.bone(suffix);
      return Object.freeze({
        name: bone.name,
        position: freezeVector3Tuple(bone.position),
        quaternion: freezeQuaternionTuple(bone.quaternion),
      });
    });
    return Object.freeze({
      schemaVersion: 1 as const,
      side: this.side,
      group: Object.freeze({
        position: freezeVector3Tuple(this.group.position),
        quaternion: freezeQuaternionTuple(this.group.quaternion),
        scale: freezeVector3Tuple(this.group.scale),
      }),
      bones: Object.freeze(bones),
    });
  }

  private validatePose(pose: unknown): RiggedExperimentalHandPose {
    const root = requireObject(pose, "snapshot", ["schemaVersion", "side", "group", "bones"]);
    if (root.schemaVersion !== 1) throw new Error("Experimental hand pose has an unsupported schema version.");
    if (root.side !== this.side) throw new Error(`Experimental hand pose side must be ${this.side}.`);
    const group = requireObject(root.group, "group transform", ["position", "quaternion", "scale"]);
    const groupPosition = readVector3Tuple(group.position, "group position");
    const groupQuaternion = readQuaternionTuple(group.quaternion, "group quaternion");
    const groupScale = readVector3Tuple(group.scale, "group scale", false);
    const scaleSpread = Math.max(...groupScale) - Math.min(...groupScale);
    if (scaleSpread > 1e-6 * Math.max(...groupScale)) throw new Error("Experimental hand pose group scale must be uniform.");
    if (!Array.isArray(root.bones) || root.bones.length !== POSE_EDIT_BONE_COUNT) {
      throw new Error(`Experimental hand pose must contain exactly ${POSE_EDIT_BONE_COUNT} bones.`);
    }
    const expected = new Set(DIAGNOSTIC_FINGER_BONE_ORDER.map(name => `${this.side}_${name}`));
    const seen = new Set<string>();
    const bones = root.bones.map((value, index) => {
      const entry = requireObject(value, `bone ${index}`, ["name", "position", "quaternion"]);
      if (typeof entry.name !== "string" || !expected.has(entry.name)) {
        throw new Error(`Experimental hand pose contains an unknown bone name at index ${index}.`);
      }
      if (seen.has(entry.name)) throw new Error(`Experimental hand pose contains duplicate bone ${entry.name}.`);
      seen.add(entry.name);
      const bone = this.bones.get(entry.name);
      if (!bone) throw new Error(`Experimental hand pose references missing bone ${entry.name}.`);
      return Object.freeze({
        name: entry.name,
        position: readVector3Tuple(entry.position, `${entry.name} position`),
        quaternion: readQuaternionTuple(entry.quaternion, `${entry.name} quaternion`),
      });
    });
    if (seen.size !== expected.size || [...expected].some(name => !seen.has(name))) {
      throw new Error("Experimental hand pose is missing one or more GLB bones.");
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      side: this.side,
      group: Object.freeze({
        position: Object.freeze(groupPosition) as Vec3Tuple,
        quaternion: Object.freeze(groupQuaternion) as QuaternionTuple,
        scale: Object.freeze(groupScale) as Vec3Tuple,
      }),
      bones: Object.freeze(bones),
    });
  }

  private applyValidatedPose(pose: RiggedExperimentalHandPose): void {
    this.group.position.copy(vectorFromTuple(pose.group.position));
    this.group.quaternion.copy(quaternionFromTuple(pose.group.quaternion));
    this.group.scale.copy(vectorFromTuple(pose.group.scale));
    for (const bonePose of pose.bones) {
      const bone = this.bones.get(bonePose.name)!;
      bone.position.copy(vectorFromTuple(bonePose.position));
      bone.quaternion.copy(quaternionFromTuple(bonePose.quaternion));
    }
    this.group.updateMatrixWorld(true);
    this.mesh.skeleton.update();
  }

  private bend(name: string, angle: number, localAxis = LOCAL_X_FLEX_AXIS): void {
    const bone = this.bone(name);
    const bind = this.bindRotations.get(bone.name)!;
    bone.quaternion.copy(bind).multiply(new THREE.Quaternion().setFromAxisAngle(localAxis, angle));
  }

  private firstBoneDescendant(bone: THREE.Bone): THREE.Bone | null {
    const pending = [...bone.children];
    while (pending.length > 0) {
      const candidate = pending.shift()!;
      if (candidate instanceof THREE.Bone) return candidate;
      pending.push(...candidate.children);
    }
    return null;
  }

  /**
   * Selects a tiny, fixed set of terminal-bone-weighted source vertices once
   * from the actual GLB bind pose. They remain stable across captured frames;
   * their palmar/anatomical-pad meaning is not established by this asset.
   */
  private selectFixedDistalSkinSamples(): void {
    const geometry = this.mesh.geometry;
    const position = geometry.getAttribute("position");
    const skinIndex = geometry.getAttribute("skinIndex");
    const skinWeight = geometry.getAttribute("skinWeight");
    if (!position || !skinIndex || !skinWeight) return;

    this.group.updateMatrixWorld(true);
    this.mesh.updateMatrixWorld(true);
    this.mesh.skeleton.update();

    const buildBoneHull = (boneName: string, slices: number, sectors: number, includeTipCap: boolean): number[] => {
      const bone = this.bone(boneName);
      const boneIndex = this.mesh.skeleton.bones.indexOf(bone);
      if (boneIndex < 0) return [];
      const origin = bone.getWorldPosition(new THREE.Vector3());
      const q = bone.getWorldQuaternion(new THREE.Quaternion());
      const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
      const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
      const axisZ = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
      const verts: Array<{ i: number; px: number; py: number; pz: number; r2: number; pt: THREE.Vector3 }> = [];
      let minP = Infinity;
      let maxP = -Infinity;
      for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex++) {
        let weight = 0;
        for (let slot = 0; slot < 4; slot++) {
          if (skinIndex.getComponent(vertexIndex, slot) === boneIndex) weight += skinWeight.getComponent(vertexIndex, slot);
        }
        if (weight < 0.20) continue;
        const pt = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
        this.mesh.applyBoneTransform(vertexIndex, pt);
        pt.applyMatrix4(this.mesh.matrixWorld);
        const rel = pt.clone().sub(origin);
        const px = rel.dot(axisX);
        const py = rel.dot(axisY);
        const pz = rel.dot(axisZ);
        if (py < minP) minP = py;
        if (py > maxP) maxP = py;
        verts.push({ i: vertexIndex, px, py, pz, r2: px * px + pz * pz, pt });
      }
      const selected = new Set<number>();
      const grid = new Map<number, { i: number; r2: number }>();
      const tipGrid = new Map<number, { i: number; score: number }>();
      const span = Math.max(1e-6, maxP - minP);
      for (const v of verts) {
        const sl = Math.min(slices - 1, Math.max(0, Math.floor(((v.py - minP) / span) * slices)));
        const ang = Math.atan2(v.pz, v.px);
        const sec = Math.min(sectors - 1, Math.max(0, Math.floor(((ang + Math.PI) / (2 * Math.PI)) * sectors)));
        const key = sl * sectors + sec;
        const prev = grid.get(key);
        if (!prev || v.r2 > prev.r2) grid.set(key, { i: v.i, r2: v.r2 });
        if (includeTipCap && v.py >= minP + 0.78 * span) {
          const tipSlice = Math.min(3, Math.max(0, Math.floor(((v.py - (minP + 0.78 * span)) / (0.22 * span)) * 4)));
          const tipKey = tipSlice * sectors + sec;
          const score = v.r2 + (v.py - minP) * 0.25;
          const prevTip = tipGrid.get(tipKey);
          if (!prevTip || score > prevTip.score) tipGrid.set(tipKey, { i: v.i, score });
        }
      }
      for (const cell of grid.values()) selected.add(cell.i);
      for (const cell of tipGrid.values()) selected.add(cell.i);
      return [...selected];
    };

    // Local bone-frame directions corresponding to world -Y (downward toward the key top surface)
    // when the hand is placed on the keyboard in the authored starting pose.
    const startPoseLocalPadDirs: Record<number, THREE.Vector3> = this.side === "left"
      ? {
          1: new THREE.Vector3(0.977282, 0.181076, -0.110140).normalize(),
          2: new THREE.Vector3(0.045348, 0.881809, -0.469422).normalize(),
          3: new THREE.Vector3(-0.143755, 0.850111, -0.506602).normalize(),
          4: new THREE.Vector3(0.176956, 0.899577, -0.399309).normalize(),
          5: new THREE.Vector3(0.003958, 0.952345, -0.304997).normalize(),
        }
      : {
          1: new THREE.Vector3(-0.977831, 0.177372, -0.111288).normalize(),
          2: new THREE.Vector3(-0.054713, 0.858654, -0.509627).normalize(),
          3: new THREE.Vector3(0.134741, 0.857666, -0.496240).normalize(),
          4: new THREE.Vector3(-0.185791, 0.895503, -0.404420).normalize(),
          5: new THREE.Vector3(-0.010513, 0.944407, -0.328609).normalize(),
        };

    for (const { finger, name } of DIAGNOSTIC_DISTAL_BONES) {
      const bone = this.bone(name);
      const boneIndex = this.mesh.skeleton.bones.indexOf(bone);
      if (boneIndex < 0) continue;
      const origin = bone.getWorldPosition(new THREE.Vector3());
      const localPadDir = startPoseLocalPadDirs[finger] ?? new THREE.Vector3(0, 1, 0);
      const distalAxis = localPadDir.clone()
        .applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
      const candidates: Array<{ vertexIndex: number; terminalBoneWeight: number; distalProjection: number; point: THREE.Vector3 }> = [];
      for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex++) {
        let terminalBoneWeight = 0;
        for (let slot = 0; slot < 4; slot++) {
          if (skinIndex.getComponent(vertexIndex, slot) === boneIndex) terminalBoneWeight += skinWeight.getComponent(vertexIndex, slot);
        }
        if (terminalBoneWeight < MIN_DISTAL_BONE_INFLUENCE) continue;
        const point = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
        this.mesh.applyBoneTransform(vertexIndex, point);
        point.applyMatrix4(this.mesh.matrixWorld);
        candidates.push({
          vertexIndex,
          terminalBoneWeight,
          distalProjection: point.clone().sub(origin).dot(distalAxis),
          point,
        });
      }
      candidates.sort((a, b) => b.distalProjection - a.distalProjection || b.terminalBoneWeight - a.terminalBoneWeight || a.vertexIndex - b.vertexIndex);
      const selected: typeof candidates = [];
      for (const candidate of candidates) {
        // Discard duplicate seam vertices that occupy the same bind-pose point.
        if (selected.some(existing => existing.point.distanceToSquared(candidate.point) < 1e-10)) continue;
        selected.push(candidate);
        if (selected.length >= DIAGNOSTIC_SAMPLE_COUNT_PER_FINGER) break;
      }
      selected.forEach((candidate, sample) => this.fixedDistalSkinSamples.push({
        finger,
        sample,
        vertexIndex: candidate.vertexIndex,
        terminalBoneWeight: candidate.terminalBoneWeight,
      }));

      // Build compact 3D cylindrical + tip-cap surface hull for the terminal segment and phalanges
      const distalSet = new Set<number>(buildBoneHull(name, 7, 10, true));
      for (const s of selected) distalSet.add(s.vertexIndex);
      this.fingerDistalHullSamples.set(finger, [...distalSet]);

      const phalanxBones = finger === 1
        ? ["thumb_distal-segment-a"]
        : [
            `${DIGITS.find(d => d.number === finger)?.name ?? "index"}_intermediate`,
            `${DIGITS.find(d => d.number === finger)?.name ?? "index"}_proximal`,
          ];
      const phalanxSet = new Set<number>();
      for (const pb of phalanxBones) {
        for (const idx of buildBoneHull(pb, 4, 6, false)) phalanxSet.add(idx);
      }
      this.fingerPhalanxHullSamples.set(finger, [...phalanxSet]);
    }
  }

  /** Reads compact world transforms and actual post-skin positions only when the caller opts in. */
  public sampleLiveDiagnostics(): {
    boneWorldTransformRows: number[][];
    fixedDistalSkinSampleRows: number[][];
    unavailableFingerSamples: number[];
  } {
    const round = (value: number) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
    const boneWorldTransformRows = DIAGNOSTIC_FINGER_BONE_ORDER.map((name, boneId) => {
      const bone = this.bone(name);
      const position = bone.getWorldPosition(new THREE.Vector3());
      const quaternion = bone.getWorldQuaternion(new THREE.Quaternion());
      return [boneId, position.x, position.y, position.z, quaternion.x, quaternion.y, quaternion.z, quaternion.w].map(round);
    });
    const positionAttribute = this.mesh.geometry.getAttribute("position");
    const fixedDistalSkinSampleRows: number[][] = [];
    const availableFingers = new Set<number>();
    if (positionAttribute) {
      for (const sample of this.fixedDistalSkinSamples) {
        const point = new THREE.Vector3().fromBufferAttribute(positionAttribute, sample.vertexIndex);
        this.mesh.applyBoneTransform(sample.vertexIndex, point);
        point.applyMatrix4(this.mesh.matrixWorld);
        if (![point.x, point.y, point.z].every(Number.isFinite)) continue;
        fixedDistalSkinSampleRows.push([
          sample.finger,
          sample.sample,
          sample.vertexIndex,
          round(sample.terminalBoneWeight),
          round(point.x),
          round(point.y),
          round(point.z),
        ]);
        availableFingers.add(sample.finger);
      }
    }
    return {
      boneWorldTransformRows,
      fixedDistalSkinSampleRows,
      unavailableFingerSamples: DIAGNOSTIC_DISTAL_BONES.map(item => item.finger).filter(finger => !availableFingers.has(finger)),
    };
  }

  /**
   * Applies only the bounded in-palm side rotation described by a MotionPose
   * segment at the named joint pivot. The target's component along the palm
   * normal is ignored, so distal hinges retain their existing flex-only pose.
   * Source directions are measured from this side's own GLB every frame;
   * no left-to-right axis reflection is assumed.
   */
  private alignBaseSideMotion(
    name: string,
    start: THREE.Vector3,
    end: THREE.Vector3,
    palmNormal: THREE.Vector3,
    maxAngle = MAX_MCP_SIDE_ANGLE,
  ): void {
    const bone = this.bone(name);
    const frame = this.baseMotionFrames.get(name);
    if (!frame) return;

    const up = this.sideMotionUp.copy(palmNormal);
    if (up.lengthSq() < 1e-10) return;
    up.normalize();

    const targetLateral = this.sideMotionTarget.subVectors(end, start);
    targetLateral.addScaledVector(up, -targetLateral.dot(up));
    if (targetLateral.lengthSq() < 1e-10) return;
    targetLateral.normalize();

    const parentWorld = this.sideMotionParentWorld.copy(frame.parentWorldQuaternion).premultiply(this.group.quaternion);
    const currentLateral = this.sideMotionCurrent.copy(frame.childDirectionInBone)
      .applyQuaternion(bone.quaternion)
      .applyQuaternion(parentWorld);
    currentLateral.addScaledVector(up, -currentLateral.dot(up));
    if (currentLateral.lengthSq() < 1e-10) return;
    currentLateral.normalize();

    const requestedAngle = Math.atan2(
      up.dot(this.sideMotionCross.crossVectors(currentLateral, targetLateral)),
      currentLateral.dot(targetLateral),
    );
    const angle = THREE.MathUtils.clamp(requestedAngle, -maxAngle, maxAngle);
    if (Math.abs(angle) < 1e-8) return;

    const boneWorld = this.sideMotionBoneWorld.copy(parentWorld).multiply(bone.quaternion);
    const sideRotation = this.sideMotionWorldDelta.setFromAxisAngle(up, angle);
    const targetBoneWorld = this.sideMotionTargetWorld.copy(boneWorld).premultiply(sideRotation);
    parentWorld.invert();
    bone.quaternion.copy(targetBoneWorld).premultiply(parentWorld);
  }

  public update(
    pose: ReconstructedHand3D,
    leadInBlend?: RiggedExperimentalHandPoseBlend,
    contactContext?: RiggedExperimentalContactContext,
  ): void {
    if (this.poseEditMode) return;
    const mcps = DIGITS.map(({ number }) => pose.chains[number]?.[1]);
    if (mcps.some((point) => !point)) return;
    // ReconstructedHand3D points are keyboard/world coordinates and the current
    // renderer attaches this rig below an identity scene node. Refresh ancestors
    // before world reads; the axis correction safely no-ops for transformed parents.
    this.group.parent?.updateWorldMatrix(true, false);
    // The starting-pose blend changes local positions and rotations, including
    // the palm and forearm. Reconstruct from the GLB bind pose every frame so
    // seeking or leaving lead-in cannot retain transforms from an earlier time.
    for (const base of this.importedBasePose.bones) {
      const bone = this.bones.get(base.name)!;
      bone.position.fromArray(base.position);
      bone.quaternion.copy(this.bindRotations.get(base.name)!);
    }
    const targetFrame = palmFrame(this.side, pose.wristCenter, mcps as THREE.Vector3[]);
    const rotation = targetFrame.multiply(this.sourceFrame.clone().invert());
    const scale = SOURCE_SCALE[this.side] * METERS_TO_INCHES;
    this.group.scale.setScalar(scale);
    this.group.quaternion.copy(rotation);
    this.group.position.copy(pose.wristCenter).sub(this.sourceWrist.clone().multiplyScalar(scale).applyQuaternion(rotation));

    for (const { number, name } of DIGITS) {
      const points = pose.chains[number];
      if (!points || points.length < 5) continue;
      const indexFlexAxes = name === "index"
        ? this.side === "left" ? LEFT_INDEX_SOURCE_LOCAL_FLEX_AXES : RIGHT_INDEX_SOURCE_LOCAL_FLEX_AXES
        : null;
      this.bend(`${name}_metacarpal`, 0);
      this.bend(`${name}_proximal`, flexAngle(points[0]!, points[1]!, points[2]!, pose.palmNormal, THREE.MathUtils.degToRad(45)), indexFlexAxes?.proximal);
      this.alignBaseSideMotion(`${name}_proximal`, points[1]!, points[2]!, pose.palmNormal);
      this.bend(`${name}_intermediate`, flexAngle(points[1]!, points[2]!, points[3]!, pose.palmNormal, THREE.MathUtils.degToRad(70)), indexFlexAxes?.intermediate);
      this.bend(`${name}_distal`, flexAngle(points[2]!, points[3]!, points[4]!, pose.palmNormal, THREE.MathUtils.degToRad(50)), indexFlexAxes?.distal);
    }
    const thumb = pose.chains[1];
    if (thumb && thumb.length >= 4) {
      this.bend("thumb_segment0_cmc-to-mcp", 0);
      this.bend("thumb_segment1_mcp-to-ip", flexAngle(thumb[0]!, thumb[1]!, thumb[2]!, pose.palmNormal, THREE.MathUtils.degToRad(35)));
      const tipBend = flexAngle(thumb[1]!, thumb[2]!, thumb[3]!, pose.palmNormal, THREE.MathUtils.degToRad(25));
      this.bend("thumb_distal-segment-a", tipBend * 0.5);
      this.bend("thumb_distal-segment-b", tipBend * 0.5);
    }
    this.group.updateMatrixWorld(true);
    this.mesh.skeleton.update();

    const referencePose = contactContext?.referencePose ?? null;
    if (referencePose) {
      this.applyReferencePoseAndContactSolver(
        pose,
        referencePose,
        leadInBlend?.liveAlpha ?? 1,
        contactContext?.contactTargets ?? [],
        contactContext?.displayedTransportTimeSeconds,
      );
      return;
    }

    this.smoothedTransportTimeSeconds = null;
    if (leadInBlend && leadInBlend.liveAlpha < 1) this.applyLeadInPoseBlend(leadInBlend);
    this.alignForearmAxisToMotionPose(pose, leadInBlend?.liveAlpha ?? 1);
  }

  private rotateBoneAroundWorldAxis(bone: THREE.Bone, worldAxis: THREE.Vector3, angleRad: number): void {
    if (Math.abs(angleRad) < 1e-6 || !bone.parent) return;
    bone.parent.getWorldQuaternion(this.solverParentWorldQ);
    this.solverParentWorldInv.copy(this.solverParentWorldQ).invert();
    bone.getWorldQuaternion(this.solverBoneWorldQ);
    this.solverDeltaWorldQ.setFromAxisAngle(worldAxis, angleRad);
    this.solverBoneWorldQ.premultiply(this.solverDeltaWorldQ);
    bone.quaternion.copy(this.solverParentWorldInv).multiply(this.solverBoneWorldQ).normalize();
    this.group.updateMatrixWorld(true);
  }

  private sampleFingerDistalPoints(finger: number): number {
    const positionAttribute = this.mesh.geometry.getAttribute("position");
    if (!positionAttribute) return 0;
    let count = 0;
    for (const sample of this.fixedDistalSkinSamples) {
      if (sample.finger !== finger) continue;
      const point = this.solverSamplePoints[count]!;
      point.fromBufferAttribute(positionAttribute, sample.vertexIndex);
      this.mesh.applyBoneTransform(sample.vertexIndex, point);
      point.applyMatrix4(this.mesh.matrixWorld);
      if (!isFiniteVector3(point)) continue;
      count++;
      if (count >= this.solverSamplePoints.length) break;
    }
    return count;
  }

  private applyReferencePoseAndContactSolver(
    pose: ReconstructedHand3D,
    referencePoseInput: RiggedExperimentalHandPose,
    liveAlphaInput: number,
    contactTargets: readonly ImprovedHandContactTarget[],
    displayedTransportTimeSeconds?: number,
  ): void {
    const referencePose = this.validatePose(referencePoseInput);
    const liveAlpha = THREE.MathUtils.clamp(Number.isFinite(liveAlphaInput) ? liveAlphaInput : 1, 0, 1);

    // 1. Anchor the authored reference pose to the current MotionPose wrist and palm frame
    // across all transport times (both t < 0 and t >= 0), eliminating the reset to bind at t = 0.
    this.applyLeadInPoseBlend({ pose: referencePose, liveAlpha: 0 });
    this.alignForearmAxisToMotionPose(pose, liveAlpha);

    // Scale from the shrunken 6.08 in (154 mm) baseline to normal adult pianist proportions
    // (1.23x -> 7.48 in / 190 mm hand length, 0.90 in / 22.8 mm MCP knuckle spacing matching
    // the 0.929 in / 23.6 mm concert grand white keys), while keeping the fingertip playing line
    // anchored over the front key apron.
    const adultPianistScaleFactor = 1.23;
    const palmBone = this.bone("palm");
    this.group.updateMatrixWorld(true);
    palmBone.getWorldPosition(this.solverPivotWorld);
    this.group.scale.multiplyScalar(adultPianistScaleFactor);
    this.group.updateMatrixWorld(true);
    palmBone.getWorldPosition(this.solverMidPivotWorld);
    this.group.position.x += this.solverPivotWorld.x - this.solverMidPivotWorld.x;
    this.group.position.y += (this.solverPivotWorld.y + (adultPianistScaleFactor - 1) * 0.65) - this.solverMidPivotWorld.y;
    this.group.position.z += (this.solverPivotWorld.z + (adultPianistScaleFactor - 1) * 3.85) - this.solverMidPivotWorld.z;
    this.group.updateMatrixWorld(true);
    this.mesh.skeleton.update();

    const activeTargets = new Map<number, ImprovedHandContactTarget>();
    for (const target of contactTargets) {
      if (
        target.pitch !== null &&
        target.finger >= 1 &&
        target.finger <= 5 &&
        Number.isFinite(target.contactCenterX) &&
        Number.isFinite(target.contactMinX) &&
        Number.isFinite(target.contactMaxX) &&
        Number.isFinite(target.contactMinZ) &&
        Number.isFinite(target.contactMaxZ)
      ) {
        activeTargets.set(target.finger, target);
      }
    }

    const computeEngagementWeight = (target: ImprovedHandContactTarget): number => {
      if (displayedTransportTimeSeconds === undefined || !Number.isFinite(displayedTransportTimeSeconds)) {
        return 1;
      }
      return computeNoteRearticulationWeight(
        displayedTransportTimeSeconds,
        target.sourceStartSeconds,
        target.sourceEndSeconds,
        target.prevEndSeconds,
        target.nextStartSeconds,
      );
    };

    const computeWristZWeight = (target: ImprovedHandContactTarget): number => {
      if (displayedTransportTimeSeconds === undefined || !Number.isFinite(displayedTransportTimeSeconds)) {
        return 1;
      }
      if (target.nextStartSeconds !== undefined) {
        return 1;
      }
      const endSec = target.sourceEndSeconds;
      if (endSec !== undefined && Number.isFinite(endSec) && displayedTransportTimeSeconds > endSec) {
        const releaseProgress = THREE.MathUtils.clamp((displayedTransportTimeSeconds - endSec) / 0.12, 0, 1);
        const s = releaseProgress * releaseProgress * (3 - 2 * releaseProgress);
        return 1 - s;
      }
      return 1;
    };

    const fingerBoneChain = (finger: number): { rootBone: THREE.Bone; midBone: THREE.Bone; distalBone: THREE.Bone } => {
      if (finger === 1) {
        return {
          rootBone: this.bone("thumb_segment0_cmc-to-mcp"),
          midBone: this.bone("thumb_segment1_mcp-to-ip"),
          distalBone: this.bone("thumb_distal-segment-a"),
        };
      }
      const digitName = DIGITS.find(d => d.number === finger)?.name ?? "index";
      return {
        rootBone: this.bone(`${digitName}_proximal`),
        midBone: this.bone(`${digitName}_intermediate`),
        distalBone: this.bone(`${digitName}_distal`),
      };
    };

    const resolveEffectiveCenterX = (target: ImprovedHandContactTarget, tipZ: number): number => {
      const fullCenterX = target.contactCenterX!;
      const isBlackTarget = (target.contactMaxZ! - target.contactMinZ!) < 4.5;
      if (isBlackTarget || tipZ > -1.70 || target.pitch === null) return fullCenterX;
      const mod12 = ((target.pitch % 12) + 12) % 12;
      let laneShiftX = 0;
      if (mod12 === 0 || mod12 === 5) {
        // C and F have a black key overhanging their right (+X) side in the back zone
        laneShiftX = -0.12;
      } else if (mod12 === 4 || mod12 === 11) {
        // E and B have a black key overhanging their left (-X) side in the back zone
        laneShiftX = 0.12;
      } else if (mod12 === 7) {
        // G sits between F# (-0.14) and G# (0.0)
        laneShiftX = -0.04;
      } else if (mod12 === 9) {
        // A sits between G# (0.0) and Bb (+0.14)
        laneShiftX = 0.04;
      }
      if (laneShiftX === 0) return fullCenterX;
      const t = THREE.MathUtils.clamp((-1.70 - tipZ) / 0.22, 0, 1);
      const blend = t * t * (3 - 2 * t);
      return THREE.MathUtils.clamp(
        fullCenterX + laneShiftX * blend,
        target.contactMinX! + 0.04,
        target.contactMaxX! - 0.04,
      );
    };

    // 2. Horizontal X alignment for active fingers toward their assigned key center.
    for (const [finger, target] of activeTargets.entries()) {
      const weight = computeEngagementWeight(target);
      const isRearticulating = target.nextStartSeconds !== undefined || target.prevEndSeconds !== undefined;
      if (weight <= 1e-4 && !isRearticulating) continue;
      // Keep X aligned to the key lane while lifting during release or re-articulation
      // so the finger rises clear of adjacent black keys without drifting sideways.
      const horizWeight = isRearticulating
        ? Math.max(0.65, THREE.MathUtils.clamp(weight * 1.45, 0, 1))
        : THREE.MathUtils.clamp(weight * 1.45, 0, 1);
      const { rootBone, midBone } = fingerBoneChain(finger);
      for (let iter = 0; iter < 2; iter++) {
        this.mesh.skeleton.update();
        const count = this.sampleFingerDistalPoints(finger);
        if (count === 0) break;
        this.solverMeanPoint.set(0, 0, 0);
        for (let i = 0; i < count; i++) this.solverMeanPoint.add(this.solverSamplePoints[i]!);
        this.solverMeanPoint.divideScalar(count);

        const centerX = resolveEffectiveCenterX(target, this.solverMeanPoint.z);
        rootBone.getWorldPosition(this.solverPivotWorld);
        const vx = this.solverMeanPoint.x - this.solverPivotWorld.x;
        const vz = this.solverMeanPoint.z - this.solverPivotWorld.z;
        const tx = (this.solverMeanPoint.x + (centerX - this.solverMeanPoint.x) * horizWeight) - this.solverPivotWorld.x;
        const rHoriz = Math.hypot(vx, vz);
        if (rHoriz > 0.2) {
          const curAngle = Math.atan2(-vx, -vz);
          const desAngle = Math.asin(THREE.MathUtils.clamp(-tx / rHoriz, -0.95, 0.95));
          const dYaw = THREE.MathUtils.clamp(desAngle - curAngle, -0.45, 0.45);
          this.rotateBoneAroundWorldAxis(rootBone, this.solverWorldY, dYaw);
        }

        this.mesh.skeleton.update();
        const countAfter = this.sampleFingerDistalPoints(finger);
        if (countAfter === 0) break;
        this.solverMeanPoint.set(0, 0, 0);
        for (let i = 0; i < countAfter; i++) this.solverMeanPoint.add(this.solverSamplePoints[i]!);
        this.solverMeanPoint.divideScalar(countAfter);

        const centerXAfter = resolveEffectiveCenterX(target, this.solverMeanPoint.z);
        const blendedCenterX = this.solverMeanPoint.x + (centerXAfter - this.solverMeanPoint.x) * horizWeight;
        if (finger !== 1 && Math.abs(blendedCenterX - this.solverMeanPoint.x) > 0.015) {
          midBone.getWorldPosition(this.solverMidPivotWorld);
          const mvx = this.solverMeanPoint.x - this.solverMidPivotWorld.x;
          const mvz = this.solverMeanPoint.z - this.solverMidPivotWorld.z;
          const mrH = Math.hypot(mvx, mvz);
          if (mrH > 0.15) {
            const mcA = Math.atan2(-mvx, -mvz);
            const mdA = Math.asin(THREE.MathUtils.clamp(-(blendedCenterX - this.solverMidPivotWorld.x) / mrH, -0.95, 0.95));
            this.rotateBoneAroundWorldAxis(midBone, this.solverWorldY, THREE.MathUtils.clamp(mdA - mcA, -0.35, 0.35));
          }
        }
      }
    }

    // 3. Wrist Z assist: keep all 5 fingers inside the keyboard front edge (z <= -0.06 in),
    // ensure active fingers reach inside their target key's playable [minZ, maxZ],
    // and pull the hand back onto the front white-key apron when playing white keys
    // so non-playing fingers are not pushed unnecessarily deep into the black-key zone.
    this.mesh.skeleton.update();
    let deltaZ = 0;
    let maxPullBackZ = Infinity;
    let hasBlackActiveTarget = false;
    for (const target of activeTargets.values()) {
      if ((target.contactMaxZ! - target.contactMinZ!) < 4.5 && computeWristZWeight(target) > 0.05) {
        hasBlackActiveTarget = true;
      }
    }
    for (let finger = 1; finger <= 5; finger++) {
      const count = this.sampleFingerDistalPoints(finger);
      if (count === 0) continue;
      let maxSampleZ = -Infinity;
      let minSampleZ = Infinity;
      for (let i = 0; i < count; i++) {
        const z = this.solverSamplePoints[i]!.z;
        if (z > maxSampleZ) maxSampleZ = z;
        if (z < minSampleZ) minSampleZ = z;
      }
      maxPullBackZ = Math.min(maxPullBackZ, -0.06 - maxSampleZ);
      if (maxSampleZ + deltaZ > -0.06) {
        deltaZ = Math.min(deltaZ, -0.06 - maxSampleZ);
      }
      const target = activeTargets.get(finger);
      if (target) {
        const weight = computeWristZWeight(target);
        const isBlackTarget = (target.contactMaxZ! - target.contactMinZ!) < 4.5;
        const safeMaxZ = isBlackTarget ? target.contactMaxZ! - 0.38 : target.contactMaxZ! - 0.12;
        const safeMinZ = target.contactMinZ! + 0.15;
        maxPullBackZ = Math.min(maxPullBackZ, safeMaxZ - maxSampleZ);
        if (maxSampleZ + deltaZ > safeMaxZ) {
          deltaZ = Math.min(deltaZ, (safeMaxZ - maxSampleZ) * weight);
        }
        if (minSampleZ + deltaZ < safeMinZ) {
          deltaZ = Math.max(deltaZ, (safeMinZ - minSampleZ) * weight);
        }
      }
    }
    // When all active targets on this hand are white keys, pull the hand toward the front
    // white-key apron (up to maxPullBackZ) whenever active white-key fingers sit deeper than -1.68 in.
    if (!hasBlackActiveTarget && activeTargets.size > 0 && maxPullBackZ > deltaZ) {
      let desiredFrontPullZ = deltaZ;
      for (const [finger, target] of activeTargets.entries()) {
        const weight = computeWristZWeight(target);
        if (weight <= 1e-4) continue;
        const count = this.sampleFingerDistalPoints(finger);
        if (count === 0) continue;
        let minSampleZ = Infinity;
        for (let i = 0; i < count; i++) {
          if (this.solverSamplePoints[i]!.z < minSampleZ) minSampleZ = this.solverSamplePoints[i]!.z;
        }
        const preferredWhiteMinZ = -1.68;
        if (minSampleZ + desiredFrontPullZ < preferredWhiteMinZ) {
          desiredFrontPullZ = Math.max(desiredFrontPullZ, (preferredWhiteMinZ - minSampleZ) * weight);
        }
      }
      deltaZ = Math.min(maxPullBackZ, desiredFrontPullZ);
    }
    if (deltaZ !== 0) {
      this.group.position.z += deltaZ;
      this.group.updateMatrixWorld(true);
      this.mesh.skeleton.update();
    }

    const sampleSurface = contactTargets[0]?.sampleSurfaceYAt;

    // 4. Coupled X/Y refinement and whole-hull pad leveling for active fingers onto the pressed key top surface.
    for (const [finger, target] of activeTargets.entries()) {
      const weight = computeEngagementWeight(target);
      const isRearticulating = target.nextStartSeconds !== undefined || target.prevEndSeconds !== undefined;
      if (weight <= 1e-4 && !isRearticulating) continue;
      this.levelAndSeatActiveFingerDistalHull(finger, target, weight, resolveEffectiveCenterX, sampleSurface, 3);
    }

    // 5. Whole-finger non-penetration clearance guard for all free fingers (target.pitch === null).
    // Evaluates PIP, mid-phalanx, DIP, all 3 distal tip samples, and the full 3D skin hull
    // against the white-key and black-key envelope.
    for (let finger = 1; finger <= 5; finger++) {
      if (activeTargets.has(finger)) continue;
      const motionChain = pose.chains[finger];
      const motionTipY = motionChain && motionChain.length > 0 ? motionChain[motionChain.length - 1]!.y : 0;
      const extraHover = liveAlpha * Math.max(0, (motionTipY - 0.542) * 0.22);
      this.liftFreeFingerAboveKeyboardEnvelope(finger, extraHover, sampleSurface, 4);
    }

    // 5b. Same-hand finger-to-finger collision avoidance across adjacent digits.
    this.resolveSameHandFingerCollisions(activeTargets, sampleSurface);

    // 6. Post-flexion/lift Z guard: flexing active fingers or lifting curved free fingers can swing
    // fingertips forward (+Z). Clamp Z and re-seat active fingers at the final wrist Z.
    this.mesh.skeleton.update();
    let postDeltaZ = 0;
    let maxPostPullZ = Infinity;
    for (let finger = 1; finger <= 5; finger++) {
      const count = this.sampleFingerDistalPoints(finger);
      if (count === 0) continue;
      let maxSampleZ = -Infinity;
      let minSampleZ = Infinity;
      for (let i = 0; i < count; i++) {
        const z = this.solverSamplePoints[i]!.z;
        if (z > maxSampleZ) maxSampleZ = z;
        if (z < minSampleZ) minSampleZ = z;
      }
      maxPostPullZ = Math.min(maxPostPullZ, -0.05 - maxSampleZ);
      if (maxSampleZ + postDeltaZ > -0.05) {
        postDeltaZ = Math.min(postDeltaZ, -0.05 - maxSampleZ);
      }
      const target = activeTargets.get(finger);
      if (target) {
        const weight = computeWristZWeight(target);
        const isBlackTarget = (target.contactMaxZ! - target.contactMinZ!) < 4.5;
        const safeMaxZ = isBlackTarget ? target.contactMaxZ! - 0.40 : target.contactMaxZ! - 0.08;
        const safeMinZ = target.contactMinZ! + 0.14;
        maxPostPullZ = Math.min(maxPostPullZ, safeMaxZ - maxSampleZ);
        if (maxSampleZ + postDeltaZ > safeMaxZ) {
          postDeltaZ = Math.min(postDeltaZ, (safeMaxZ - maxSampleZ) * weight);
        }
        if (minSampleZ + postDeltaZ < safeMinZ) {
          postDeltaZ = Math.max(postDeltaZ, (safeMinZ - minSampleZ) * weight);
        }
      }
    }
    postDeltaZ = Math.min(postDeltaZ, maxPostPullZ);
    if (postDeltaZ !== 0) {
      this.group.position.z += postDeltaZ;
      this.group.updateMatrixWorld(true);
      this.mesh.skeleton.update();
      for (const [finger, target] of activeTargets.entries()) {
        const weight = computeEngagementWeight(target);
        const isRearticulating = target.nextStartSeconds !== undefined || target.prevEndSeconds !== undefined;
        if (weight <= 1e-4 && !isRearticulating) continue;
        this.levelAndSeatActiveFingerDistalHull(finger, target, weight, resolveEffectiveCenterX, sampleSurface, 2);
      }
      for (let finger = 1; finger <= 5; finger++) {
        if (activeTargets.has(finger)) continue;
        this.liftFreeFingerAboveKeyboardEnvelope(finger, 0, sampleSurface, 1);
      }
    }

    // 7. Continuous temporal damping during forward playback (0.0001 s < dt <= 0.09 s),
    // while snapping deterministically on seeks or large jumps (dt <= 0 or dt > 0.09 s).
    this.applyPlaybackTemporalSmoothing(
      displayedTransportTimeSeconds,
      activeTargets,
      computeEngagementWeight,
      resolveEffectiveCenterX,
      sampleSurface,
    );

    this.group.updateMatrixWorld(true);
    this.mesh.skeleton.update();
  }

  private levelAndSeatActiveFingerDistalHull(
    finger: number,
    target: ImprovedHandContactTarget,
    weight: number,
    resolveEffectiveCenterX: (t: ImprovedHandContactTarget, tipZ: number) => number,
    sampleSurface: ImprovedHandContactTarget["sampleSurfaceYAt"] | undefined,
    iterations: number,
  ): void {
    const positionAttribute = this.mesh.geometry.getAttribute("position");
    const digitName = DIGITS.find(d => d.number === finger)?.name ?? "index";
    const rootBone = finger === 1
      ? this.bone("thumb_segment0_cmc-to-mcp")
      : this.bone(`${digitName}_proximal`);
    const midBone = finger === 1
      ? this.bone("thumb_segment1_mcp-to-ip")
      : this.bone(`${digitName}_intermediate`);

    const isBlackTarget = (target.contactMaxZ! - target.contactMinZ!) < 4.5;
    const safeMaxZ = isBlackTarget ? target.contactMaxZ! - 0.40 : target.contactMaxZ! - 0.08;
    const safeMinZ = target.contactMinZ! + 0.14;
    const isRearticulating = target.nextStartSeconds !== undefined || target.prevEndSeconds !== undefined;
    const horizWeight = isRearticulating
      ? Math.max(0.65, THREE.MathUtils.clamp(weight * 1.65, 0, 1))
      : THREE.MathUtils.clamp(weight * 1.65, 0, 1);
    const distalHull = this.fingerDistalHullSamples.get(finger) ?? [];

    // Sample the planar key top surface only twice along Z to avoid per-vertex raycasting in the hull loop.
    const zBack = Math.min(safeMaxZ, safeMinZ + 0.20);
    const zFront = Math.max(safeMinZ, safeMaxZ - 0.20);
    const zMid = (target.contactMinZ! + target.contactMaxZ!) * 0.5;
    const yMidFallback = target.sampleSurfaceYAt(target.pitch!, target.contactCenterX!, zMid);
    const yBack = target.sampleSurfaceYAt(target.pitch!, target.contactCenterX!, zBack) ?? yMidFallback;
    const yFront = target.sampleSurfaceYAt(target.pitch!, target.contactCenterX!, zFront) ?? yBack;
    if (yBack === null || yFront === null || !Number.isFinite(yBack) || !Number.isFinite(yFront)) return;
    const zSpan = Math.max(1e-5, zFront - zBack);
    const slopeZ = (yFront - yBack) / zSpan;

    const evaluateKeyTopYAt = (_x: number, z: number): number => {
      const clampedZ = THREE.MathUtils.clamp(z, safeMinZ, safeMaxZ);
      return yBack + (clampedZ - zBack) * slopeZ;
    };

    for (let iter = 0; iter < iterations; iter++) {
      this.mesh.skeleton.update();
      const count = this.sampleFingerDistalPoints(finger);
      if (count === 0) break;
      this.solverMeanPoint.set(0, 0, 0);
      let tipMinX = Infinity;
      let tipMaxX = -Infinity;
      for (let i = 0; i < count; i++) {
        const pt = this.solverSamplePoints[i]!;
        this.solverMeanPoint.add(pt);
        if (pt.x < tipMinX) tipMinX = pt.x;
        if (pt.x > tipMaxX) tipMaxX = pt.x;
      }
      this.solverMeanPoint.divideScalar(count);

      let centerX = resolveEffectiveCenterX(target, this.solverMeanPoint.z);
      if (isBlackTarget) {
        const halfTopDeckW = 0.135;
        const shiftX = centerX - this.solverMeanPoint.x;
        if (tipMinX + shiftX < target.contactCenterX! - halfTopDeckW) {
          centerX += (target.contactCenterX! - halfTopDeckW) - (tipMinX + shiftX);
        }
        if (tipMaxX + shiftX > target.contactCenterX! + halfTopDeckW) {
          centerX -= (tipMaxX + shiftX) - (target.contactCenterX! + halfTopDeckW);
        }
      } else if (iter === 0 && positionAttribute && distalHull.length > 0) {
        let hullMinX = Infinity;
        let hullMaxX = -Infinity;
        for (const vIdx of distalHull) {
          this.solverHullPoint.fromBufferAttribute(positionAttribute, vIdx);
          this.mesh.applyBoneTransform(vIdx, this.solverHullPoint);
          this.solverHullPoint.applyMatrix4(this.mesh.matrixWorld);
          if (this.solverHullPoint.x < hullMinX) hullMinX = this.solverHullPoint.x;
          if (this.solverHullPoint.x > hullMaxX) hullMaxX = this.solverHullPoint.x;
        }
        const shiftX = centerX - this.solverMeanPoint.x;
        const minSafeX = target.contactMinX! + 0.025;
        const maxSafeX = target.contactMaxX! - 0.025;
        if (hullMaxX - hullMinX < maxSafeX - minSafeX) {
          if (hullMinX + shiftX < minSafeX) centerX += minSafeX - (hullMinX + shiftX);
          if (hullMaxX + shiftX > maxSafeX) centerX -= (hullMaxX + shiftX) - maxSafeX;
        }
      }

      const errX = (centerX - this.solverMeanPoint.x) * horizWeight;
      if (Math.abs(errX) > 0.005) {
        rootBone.getWorldPosition(this.solverPivotWorld);
        const vx = this.solverMeanPoint.x - this.solverPivotWorld.x;
        const vz = this.solverMeanPoint.z - this.solverPivotWorld.z;
        const rH = Math.hypot(vx, vz);
        if (rH > 0.2) {
          const dYaw = THREE.MathUtils.clamp(-errX / rH, -0.32, 0.32);
          this.rotateBoneAroundWorldAxis(rootBone, this.solverWorldY, dYaw);
        }
      }

      // Vertically seat the distal hull onto the pressed key top surface without
      // bending or distorting the distal phalanx or thumb phalanges out of their starting-pose curve.
      this.mesh.skeleton.update();
      const countLevel = this.sampleFingerDistalPoints(finger);
      if (countLevel === 0) break;
      this.solverMeanPoint.set(0, 0, 0);
      let minTipGap = Infinity;
      for (let i = 0; i < countLevel; i++) {
        const pt = this.solverSamplePoints[i]!;
        this.solverMeanPoint.add(pt);
        const surfY = evaluateKeyTopYAt(pt.x, pt.z);
        const gap = pt.y - surfY;
        if (gap < minTipGap) minTipGap = gap;
      }
      this.solverMeanPoint.divideScalar(countLevel);

      let minHullGap = minTipGap;
      if (positionAttribute && distalHull.length > 0) {
        for (const vIdx of distalHull) {
          this.solverHullPoint.fromBufferAttribute(positionAttribute, vIdx);
          this.mesh.applyBoneTransform(vIdx, this.solverHullPoint);
          this.solverHullPoint.applyMatrix4(this.mesh.matrixWorld);
          const surfY = evaluateKeyTopYAt(this.solverHullPoint.x, this.solverHullPoint.z);
          const gap = this.solverHullPoint.y - surfY;
          if (gap < minHullGap) {
            minHullGap = gap;
          }
        }
      }

      if (!Number.isFinite(minHullGap) || !Number.isFinite(minTipGap)) break;
      const engagedHullGap = 0.006;
      const surfAtTip = evaluateKeyTopYAt(this.solverMeanPoint.x, this.solverMeanPoint.z) ?? 0;
      const freeFloorAtTip = weight < 1
        ? this.computeFreeFingerRequiredFloorY(this.solverMeanPoint.x, this.solverMeanPoint.z, 0, sampleSurface)
        : surfAtTip + engagedHullGap;
      const extraRearticulationLiftIn = isRearticulating ? 0.22 : 0;
      const releaseGap = Math.max(
        0.10 + extraRearticulationLiftIn,
        (freeFloorAtTip - surfAtTip) + 0.02 + extraRearticulationLiftIn,
      );
      const desiredHullGap = weight * engagedHullGap + (1 - weight) * releaseGap;
      const errY = desiredHullGap - minHullGap;

      if (Math.abs(errY) >= 0.0004) {
        rootBone.getWorldPosition(this.solverPivotWorld);
        this.solverDirXZ.set(
          this.solverMeanPoint.x - this.solverPivotWorld.x,
          0,
          this.solverMeanPoint.z - this.solverPivotWorld.z,
        );
        const rH = this.solverDirXZ.length();
        if (rH >= 0.1) {
          this.solverHingeAxis.copy(this.solverDirXZ).cross(this.solverWorldY).normalize();
          const dPitch = THREE.MathUtils.clamp(errY / rH, -0.45, 0.45);
          if (finger === 1) {
            // Preserve the thumb's internal phalanx alignment (first and second phalanges)
            // 100% from the authored starting pose by pivoting only at the base CMC joint.
            this.rotateBoneAroundWorldAxis(rootBone, this.solverHingeAxis, dPitch);
          } else {
            this.rotateBoneAroundWorldAxis(rootBone, this.solverHingeAxis, dPitch * 0.7);
            this.rotateBoneAroundWorldAxis(midBone, this.solverHingeAxis, dPitch * 0.3);
          }
        }
      }
    }
  }

  /**
   * Computes the required minimum bottom-skin height Y (in inches) for any station
   * along a free finger at world (x, z). Across the black-key depth zone (z <= -1.82 in,
   * including the front nose bevel at z = -1.898 in plus capsule margin), free fingers
   * stay above the 0.46 in black-key top plane (>= 0.515 in), smoothly ramping down
   * to white-key clearance (0.055 in) across z in [-1.82, -1.42].
   */
  private computeFreeFingerRequiredFloorY(
    worldX: number,
    worldZ: number,
    extraHoverIn: number,
    sampleSurface?: ImprovedHandContactTarget["sampleSurfaceYAt"],
  ): number {
    if (worldZ > 0.05 || worldZ < -6.0) return -Infinity;
    let floorY = 0.055 + extraHoverIn;
    if (worldZ <= -1.42) {
      const t = THREE.MathUtils.clamp((-1.42 - worldZ) / 0.40, 0, 1);
      const s = t * t * (3 - 2 * t);
      const blackPlaneClearanceY = 0.515; // BLACK_KEY_HEIGHT_IN (0.46) + 0.055 in clearance
      floorY = Math.max(floorY, 0.055 + s * (blackPlaneClearanceY - 0.055) + extraHoverIn * (1 - 0.4 * s));
      if (sampleSurface && worldZ <= -1.85) {
        const approxWhiteIndex = Math.round(((worldX + 24.142857) / (6.5 / 7.0)) - 0.5);
        const approxMidi = Math.max(21, Math.min(108, 21 + Math.round(approxWhiteIndex * (12 / 7))));
        for (let candidatePitch = Math.max(21, approxMidi - 1); candidatePitch <= Math.min(108, approxMidi + 1); candidatePitch++) {
          const mod12 = candidatePitch % 12;
          if (mod12 !== 1 && mod12 !== 3 && mod12 !== 6 && mod12 !== 8 && mod12 !== 10) continue;
          const keyY = sampleSurface(candidatePitch, worldX, worldZ);
          if (keyY !== null && Number.isFinite(keyY)) {
            floorY = Math.max(floorY, keyY + 0.055);
          }
        }
      }
    }
    return floorY;
  }

  /**
   * Lifts a free finger around its MCP and PIP hinge axes until all stations along
   * the finger (PIP bottom, mid-phalanx bottom, DIP bottom, all 3 distal tip samples,
   * and the full 3D distal/phalanx skin hull) clear the 3D keyboard obstacle envelope.
   */
  private liftFreeFingerAboveKeyboardEnvelope(
    finger: number,
    extraHoverIn: number,
    sampleSurface: ImprovedHandContactTarget["sampleSurfaceYAt"] | undefined,
    iterations: number,
  ): void {
    const positionAttribute = this.mesh.geometry.getAttribute("position");
    const digitName = DIGITS.find(d => d.number === finger)?.name ?? "index";
    const rootBone = finger === 1
      ? this.bone("thumb_segment0_cmc-to-mcp")
      : this.bone(`${digitName}_proximal`);
    const midBone = finger === 1
      ? this.bone("thumb_segment1_mcp-to-ip")
      : this.bone(`${digitName}_intermediate`);
    const distalBone = finger === 1
      ? this.bone("thumb_distal-segment-a")
      : this.bone(`${digitName}_distal`);
    const distalHull = this.fingerDistalHullSamples.get(finger) ?? [];
    const phalanxHull = this.fingerPhalanxHullSamples.get(finger) ?? [];
    let worstDistalVIdx = -1;
    let worstPhalanxVIdx = -1;

    for (let iter = 0; iter < iterations; iter++) {
      this.mesh.skeleton.update();
      const count = this.sampleFingerDistalPoints(finger);
      if (count === 0) break;
      this.solverMeanPoint.set(0, 0, 0);
      for (let i = 0; i < count; i++) {
        this.solverMeanPoint.add(this.solverSamplePoints[i]!);
      }
      this.solverMeanPoint.divideScalar(count);

      rootBone.getWorldPosition(this.solverPivotWorld);
      midBone.getWorldPosition(this.solverPipWorld);
      distalBone.getWorldPosition(this.solverDipWorld);
      this.solverMidPhalanxWorld.copy(this.solverPipWorld).add(this.solverDipWorld).multiplyScalar(0.5);

      this.solverDirXZ.set(
        this.solverMeanPoint.x - this.solverPivotWorld.x,
        0,
        this.solverMeanPoint.z - this.solverPivotWorld.z,
      );
      const tipRH = this.solverDirXZ.length();
      if (tipRH < 0.1) break;

      let maxRequiredPitch = 0;
      let maxDistalPitch = 0;

      // Check PIP, mid-phalanx, and DIP bottom skin stations (skip thumb MCP base web)
      if (finger !== 1) {
        const pipRH = Math.max(0.22, Math.hypot(this.solverPipWorld.x - this.solverPivotWorld.x, this.solverPipWorld.z - this.solverPivotWorld.z));
        const pipFloor = this.computeFreeFingerRequiredFloorY(this.solverPipWorld.x, this.solverPipWorld.z, extraHoverIn, sampleSurface);
        const pipDeficit = pipFloor - (this.solverPipWorld.y - 0.17);
        if (pipDeficit > 0) maxRequiredPitch = Math.max(maxRequiredPitch, pipDeficit / pipRH);

        const midRH = Math.max(0.25, Math.hypot(this.solverMidPhalanxWorld.x - this.solverPivotWorld.x, this.solverMidPhalanxWorld.z - this.solverPivotWorld.z));
        const midFloor = this.computeFreeFingerRequiredFloorY(this.solverMidPhalanxWorld.x, this.solverMidPhalanxWorld.z, extraHoverIn, sampleSurface);
        const midDeficit = midFloor - (this.solverMidPhalanxWorld.y - 0.16);
        if (midDeficit > 0) maxRequiredPitch = Math.max(maxRequiredPitch, midDeficit / midRH);
      }

      const dipRH = Math.max(0.30, Math.hypot(this.solverDipWorld.x - this.solverPivotWorld.x, this.solverDipWorld.z - this.solverPivotWorld.z));
      const dipFloor = finger === 1 && this.solverDipWorld.z > -1.85
        ? 0.045 + extraHoverIn
        : this.computeFreeFingerRequiredFloorY(this.solverDipWorld.x, this.solverDipWorld.z, extraHoverIn, sampleSurface);
      const dipDeficit = dipFloor - (this.solverDipWorld.y - 0.15);
      if (dipDeficit > 0) {
        maxRequiredPitch = Math.max(maxRequiredPitch, dipDeficit / dipRH);
        maxDistalPitch = Math.max(maxDistalPitch, dipDeficit / dipRH);
      }

      // Check all 3 distal tip skin samples
      for (let i = 0; i < count; i++) {
        const pt = this.solverSamplePoints[i]!;
        const sampleRH = Math.max(0.35, Math.hypot(pt.x - this.solverPivotWorld.x, pt.z - this.solverPivotWorld.z));
        const sampleFloor = this.computeFreeFingerRequiredFloorY(pt.x, pt.z, extraHoverIn, sampleSurface);
        const sampleDeficit = sampleFloor - pt.y;
        if (sampleDeficit > 0) {
          maxRequiredPitch = Math.max(maxRequiredPitch, sampleDeficit / sampleRH);
          maxDistalPitch = Math.max(maxDistalPitch, sampleDeficit / sampleRH);
        }
      }

      const evaluateHullFloor = (x: number, z: number): number => {
        if (finger === 1 && z > -1.85) return 0.045 + extraHoverIn;
        return this.computeFreeFingerRequiredFloorY(x, z, extraHoverIn, undefined);
      };

      // Check complete 3D distal and phalanx skin hulls using the analytical obstacle floor
      // so the lower/radial belly of a free thumb or finger can never dip into an unpressed key.
      if (positionAttribute) {
        if (iter === 0) {
          let worstDistalPitch = 0;
          for (const vIdx of distalHull) {
            this.solverHullPoint.fromBufferAttribute(positionAttribute, vIdx);
            this.mesh.applyBoneTransform(vIdx, this.solverHullPoint);
            this.solverHullPoint.applyMatrix4(this.mesh.matrixWorld);
            const sampleFloor = evaluateHullFloor(this.solverHullPoint.x, this.solverHullPoint.z);
            const sampleDeficit = sampleFloor - this.solverHullPoint.y;
            if (sampleDeficit > 0) {
              const sampleRH = Math.max(
                0.35,
                Math.hypot(this.solverHullPoint.x - this.solverPivotWorld.x, this.solverHullPoint.z - this.solverPivotWorld.z),
              );
              const reqPitch = sampleDeficit / sampleRH;
              maxRequiredPitch = Math.max(maxRequiredPitch, reqPitch);
              maxDistalPitch = Math.max(maxDistalPitch, reqPitch);
              if (reqPitch > worstDistalPitch) {
                worstDistalPitch = reqPitch;
                worstDistalVIdx = vIdx;
              }
            }
          }
          let worstPhalanxPitch = 0;
          for (const vIdx of phalanxHull) {
            this.solverHullPoint.fromBufferAttribute(positionAttribute, vIdx);
            this.mesh.applyBoneTransform(vIdx, this.solverHullPoint);
            this.solverHullPoint.applyMatrix4(this.mesh.matrixWorld);
            const sampleFloor = evaluateHullFloor(this.solverHullPoint.x, this.solverHullPoint.z);
            const sampleDeficit = sampleFloor - this.solverHullPoint.y;
            if (sampleDeficit > 0) {
              const sampleRH = Math.max(
                0.35,
                Math.hypot(this.solverHullPoint.x - this.solverPivotWorld.x, this.solverHullPoint.z - this.solverPivotWorld.z),
              );
              const reqPitch = sampleDeficit / sampleRH;
              maxRequiredPitch = Math.max(maxRequiredPitch, reqPitch);
              if (reqPitch > worstPhalanxPitch) {
                worstPhalanxPitch = reqPitch;
                worstPhalanxVIdx = vIdx;
              }
            }
          }
        } else {
          if (worstDistalVIdx >= 0) {
            this.solverHullPoint.fromBufferAttribute(positionAttribute, worstDistalVIdx);
            this.mesh.applyBoneTransform(worstDistalVIdx, this.solverHullPoint);
            this.solverHullPoint.applyMatrix4(this.mesh.matrixWorld);
            const sampleFloor = evaluateHullFloor(this.solverHullPoint.x, this.solverHullPoint.z);
            const sampleDeficit = sampleFloor - this.solverHullPoint.y;
            if (sampleDeficit > 0) {
              const sampleRH = Math.max(
                0.35,
                Math.hypot(this.solverHullPoint.x - this.solverPivotWorld.x, this.solverHullPoint.z - this.solverPivotWorld.z),
              );
              const reqPitch = sampleDeficit / sampleRH;
              maxRequiredPitch = Math.max(maxRequiredPitch, reqPitch);
              maxDistalPitch = Math.max(maxDistalPitch, reqPitch);
            }
          }
          if (worstPhalanxVIdx >= 0) {
            this.solverHullPoint.fromBufferAttribute(positionAttribute, worstPhalanxVIdx);
            this.mesh.applyBoneTransform(worstPhalanxVIdx, this.solverHullPoint);
            this.solverHullPoint.applyMatrix4(this.mesh.matrixWorld);
            const sampleFloor = evaluateHullFloor(this.solverHullPoint.x, this.solverHullPoint.z);
            const sampleDeficit = sampleFloor - this.solverHullPoint.y;
            if (sampleDeficit > 0) {
              const sampleRH = Math.max(
                0.35,
                Math.hypot(this.solverHullPoint.x - this.solverPivotWorld.x, this.solverHullPoint.z - this.solverPivotWorld.z),
              );
              maxRequiredPitch = Math.max(maxRequiredPitch, sampleDeficit / sampleRH);
            }
          }
        }
      }

      if (maxRequiredPitch <= 0.0005) break;

      this.solverHingeAxis.copy(this.solverDirXZ).cross(this.solverWorldY).normalize();
      if (finger === 1) {
        // Lift the free thumb as a single natural anatomical unit from its CMC base joint
        // without bending its first or second phalanges.
        const dPitch = THREE.MathUtils.clamp(maxRequiredPitch, 0, 0.35);
        this.rotateBoneAroundWorldAxis(rootBone, this.solverHingeAxis, dPitch);
      } else {
        const dPitch = THREE.MathUtils.clamp(maxRequiredPitch, 0, 0.55);
        const dMidPitch = THREE.MathUtils.clamp(maxDistalPitch * 0.42, 0, 0.35);
        this.rotateBoneAroundWorldAxis(rootBone, this.solverHingeAxis, dPitch * 0.78);
        this.rotateBoneAroundWorldAxis(midBone, this.solverHingeAxis, dMidPitch);
      }
    }
  }

  /**
   * Prevents adjacent fingers on the same hand from passing through or overlapping
   * each other laterally when at similar vertical and depth coordinates.
   * Active fingers remain anchored inside their key bounds while adjacent free fingers
   * sympathetically fan aside and lift clear.
   */
  private resolveSameHandFingerCollisions(
    activeTargets: ReadonlyMap<number, ImprovedHandContactTarget>,
    sampleSurface: ImprovedHandContactTarget["sampleSurfaceYAt"] | undefined,
  ): void {
    const orderedFingers = this.side === "left" ? [5, 4, 3, 2, 1] : [1, 2, 3, 4, 5];
    const tipMeans = new Map<number, THREE.Vector3>();
    const dipPositions = new Map<number, THREE.Vector3>();

    const measureFingers = (): void => {
      this.mesh.skeleton.update();
      for (let f = 1; f <= 5; f++) {
        const count = this.sampleFingerDistalPoints(f);
        let mean = tipMeans.get(f);
        if (!mean) {
          mean = new THREE.Vector3();
          tipMeans.set(f, mean);
        }
        mean.set(0, 0, 0);
        if (count > 0) {
          for (let i = 0; i < count; i++) mean.add(this.solverSamplePoints[i]!);
          mean.divideScalar(count);
        }
        const digitName = DIGITS.find(d => d.number === f)?.name ?? "index";
        const distalBone = f === 1 ? this.bone("thumb_distal-segment-a") : this.bone(`${digitName}_distal`);
        let dip = dipPositions.get(f);
        if (!dip) {
          dip = new THREE.Vector3();
          dipPositions.set(f, dip);
        }
        distalBone.getWorldPosition(dip);
      }
    };

    const shiftFingerHorizontally = (finger: number, deltaX: number, liftY: number): void => {
      const digitName = DIGITS.find(d => d.number === finger)?.name ?? "index";
      const rootBone = finger === 1
        ? this.bone("thumb_segment0_cmc-to-mcp")
        : this.bone(`${digitName}_proximal`);
      const tip = tipMeans.get(finger);
      if (!tip) return;
      rootBone.getWorldPosition(this.solverPivotWorld);
      const vx = tip.x - this.solverPivotWorld.x;
      const vz = tip.z - this.solverPivotWorld.z;
      const rH = Math.hypot(vx, vz);
      if (rH > 0.2 && Math.abs(deltaX) > 1e-4) {
        const dYaw = THREE.MathUtils.clamp(-deltaX / rH, -0.24, 0.24);
        this.rotateBoneAroundWorldAxis(rootBone, this.solverWorldY, dYaw);
      }
      if (liftY > 1e-4 && rH > 0.2) {
        this.solverDirXZ.set(vx, 0, vz);
        this.solverHingeAxis.copy(this.solverDirXZ).cross(this.solverWorldY).normalize();
        const dPitch = THREE.MathUtils.clamp(liftY / rH, 0, 0.25);
        this.rotateBoneAroundWorldAxis(rootBone, this.solverHingeAxis, dPitch);
      }
    };

    const minFingerSeparationX = 0.42;
    let adjustedFreeFinger = false;

    for (let pass = 0; pass < 2; pass++) {
      measureFingers();
      for (let k = 0; k < orderedFingers.length - 1; k++) {
        const leftF = orderedFingers[k]!;
        const rightF = orderedFingers[k + 1]!;
        const tipL = tipMeans.get(leftF)!;
        const tipR = tipMeans.get(rightF)!;
        const dipL = dipPositions.get(leftF)!;
        const dipR = dipPositions.get(rightF)!;

        const tipCloseYZ = Math.abs(tipR.y - tipL.y) < 0.36 && Math.abs(tipR.z - tipL.z) < 0.95;
        const dipCloseYZ = Math.abs(dipR.y - dipL.y) < 0.36 && Math.abs(dipR.z - dipL.z) < 0.95;
        if (!tipCloseYZ && !dipCloseYZ) continue;

        const tipOverlap = tipCloseYZ ? minFingerSeparationX - (tipR.x - tipL.x) : 0;
        const dipOverlap = dipCloseYZ ? minFingerSeparationX - (dipR.x - dipL.x) : 0;
        const overlapX = Math.max(tipOverlap, dipOverlap);
        if (overlapX <= 0.005) continue;

        const leftActive = activeTargets.has(leftF);
        const rightActive = activeTargets.has(rightF);

        if (!leftActive && rightActive) {
          shiftFingerHorizontally(leftF, -overlapX, overlapX * 0.28);
          adjustedFreeFinger = true;
        } else if (leftActive && !rightActive) {
          shiftFingerHorizontally(rightF, overlapX, overlapX * 0.28);
          adjustedFreeFinger = true;
        } else if (!leftActive && !rightActive) {
          shiftFingerHorizontally(leftF, -overlapX * 0.55, overlapX * 0.12);
          shiftFingerHorizontally(rightF, overlapX * 0.55, overlapX * 0.12);
          adjustedFreeFinger = true;
        }
      }
    }

    if (adjustedFreeFinger) {
      for (let finger = 1; finger <= 5; finger++) {
        if (activeTargets.has(finger)) continue;
        this.liftFreeFingerAboveKeyboardEnvelope(finger, 0, sampleSurface, 2);
      }
    }
  }

  /**
   * Coordinates a pair of Left and Right experimental rigged hands so that neither
   * fingers nor palms/wrists pass through each other when both hands operate in the
   * same keyboard register. Active fingers remain anchored to their assigned keys.
   */
  public static resolveHandPairCollisions(
    leftHand: RiggedExperimentalHand,
    rightHand: RiggedExperimentalHand,
    leftTargets: readonly ImprovedHandContactTarget[] = [],
    rightTargets: readonly ImprovedHandContactTarget[] = [],
  ): void {
    if (leftHand.poseEditMode || rightHand.poseEditMode) return;
    leftHand.group.updateMatrixWorld(true);
    leftHand.mesh.skeleton.update();
    rightHand.group.updateMatrixWorld(true);
    rightHand.mesh.skeleton.update();

    const leftActive = new Set<number>();
    for (const t of leftTargets) if (t.pitch !== null && t.finger >= 1 && t.finger <= 5) leftActive.add(t.finger);
    const rightActive = new Set<number>();
    for (const t of rightTargets) if (t.pitch !== null && t.finger >= 1 && t.finger <= 5) rightActive.add(t.finger);

    const collectHandStations = (hand: RiggedExperimentalHand): Array<{ finger: number; point: THREE.Vector3 }> => {
      const stations: Array<{ finger: number; point: THREE.Vector3 }> = [];
      for (let f = 1; f <= 5; f++) {
        const count = hand.sampleFingerDistalPoints(f);
        for (let i = 0; i < count; i++) {
          stations.push({ finger: f, point: hand.solverSamplePoints[i]!.clone() });
        }
        const digitName = DIGITS.find(d => d.number === f)?.name ?? "index";
        const pipBone = f === 1 ? hand.bone("thumb_segment1_mcp-to-ip") : hand.bone(`${digitName}_intermediate`);
        const dipBone = f === 1 ? hand.bone("thumb_distal-segment-a") : hand.bone(`${digitName}_distal`);
        stations.push({ finger: f, point: pipBone.getWorldPosition(new THREE.Vector3()) });
        stations.push({ finger: f, point: dipBone.getWorldPosition(new THREE.Vector3()) });
      }
      stations.push({ finger: 0, point: hand.bone("palm").getWorldPosition(new THREE.Vector3()) });
      return stations;
    };

    const minHandSeparationX = 0.48;
    let leftStations = collectHandStations(leftHand);
    let rightStations = collectHandStations(rightHand);

    let maxLeftX = -Infinity;
    for (const s of leftStations) if (s.point.x > maxLeftX) maxLeftX = s.point.x;
    let minRightX = Infinity;
    for (const s of rightStations) if (s.point.x < minRightX) minRightX = s.point.x;

    // Fast path when hands are well separated horizontally
    if (maxLeftX + minHandSeparationX <= minRightX) return;

    // Step A: Tuck and lift inner free fingers (thumb = 1, index = 2) if they encroach on the opposite hand
    const sampleSurface = leftTargets[0]?.sampleSurfaceYAt ?? rightTargets[0]?.sampleSurfaceYAt;
    let innerFingerAdjusted = false;
    for (const sL of leftStations) {
      if (sL.finger < 1 || sL.finger > 2 || leftActive.has(sL.finger)) continue;
      for (const sR of rightStations) {
        if (Math.abs(sL.point.z - sR.point.z) < 1.25 && Math.abs(sL.point.y - sR.point.y) < 0.55) {
          const overlap = (sL.point.x + minHandSeparationX) - sR.point.x;
          if (overlap > 0.01) {
            const rootBone = sL.finger === 1
              ? leftHand.bone("thumb_segment0_cmc-to-mcp")
              : leftHand.bone("index_proximal");
            leftHand.rotateBoneAroundWorldAxis(rootBone, leftHand.solverWorldY, THREE.MathUtils.clamp(overlap * 0.25, 0, 0.22));
            leftHand.liftFreeFingerAboveKeyboardEnvelope(sL.finger, overlap * 0.35, sampleSurface, 2);
            innerFingerAdjusted = true;
            break;
          }
        }
      }
    }
    for (const sR of rightStations) {
      if (sR.finger < 1 || sR.finger > 2 || rightActive.has(sR.finger)) continue;
      for (const sL of leftStations) {
        if (Math.abs(sL.point.z - sR.point.z) < 1.25 && Math.abs(sL.point.y - sR.point.y) < 0.55) {
          const overlap = (sL.point.x + minHandSeparationX) - sR.point.x;
          if (overlap > 0.01) {
            const rootBone = sR.finger === 1
              ? rightHand.bone("thumb_segment0_cmc-to-mcp")
              : rightHand.bone("index_proximal");
            rightHand.rotateBoneAroundWorldAxis(rootBone, rightHand.solverWorldY, THREE.MathUtils.clamp(-overlap * 0.25, -0.22, 0));
            rightHand.liftFreeFingerAboveKeyboardEnvelope(sR.finger, overlap * 0.35, sampleSurface, 2);
            innerFingerAdjusted = true;
            break;
          }
        }
      }
    }

    if (innerFingerAdjusted) {
      leftHand.group.updateMatrixWorld(true);
      leftHand.mesh.skeleton.update();
      rightHand.group.updateMatrixWorld(true);
      rightHand.mesh.skeleton.update();
      leftStations = collectHandStations(leftHand);
      rightStations = collectHandStations(rightHand);
    }

    // Step B: Check remaining whole-hand / active-finger capsule overlap
    let worstOverlapX = 0;
    let worstVerticalGap = 0;
    for (const sL of leftStations) {
      for (const sR of rightStations) {
        if (Math.abs(sL.point.z - sR.point.z) < 1.25 && Math.abs(sL.point.y - sR.point.y) < 0.52) {
          const overlap = (sL.point.x + minHandSeparationX) - sR.point.x;
          if (overlap > worstOverlapX) {
            worstOverlapX = overlap;
            worstVerticalGap = 0.55 - Math.abs(sL.point.y - sR.point.y);
          }
        }
      }
    }
    if (worstOverlapX <= 0.005) return;

    const leftHasActive = leftActive.size > 0;
    const rightHasActive = rightActive.size > 0;

    if (!leftHasActive && rightHasActive) {
      leftHand.group.position.x -= worstOverlapX;
      leftHand.group.position.y += Math.max(0, worstVerticalGap * 0.6);
      leftHand.smoothedPalmWorldPosition.x -= worstOverlapX;
      leftHand.smoothedPalmWorldPosition.y += Math.max(0, worstVerticalGap * 0.6);
      leftHand.group.updateMatrixWorld(true);
      leftHand.mesh.skeleton.update();
    } else if (leftHasActive && !rightHasActive) {
      rightHand.group.position.x += worstOverlapX;
      rightHand.group.position.y += Math.max(0, worstVerticalGap * 0.6);
      rightHand.smoothedPalmWorldPosition.x += worstOverlapX;
      rightHand.smoothedPalmWorldPosition.y += Math.max(0, worstVerticalGap * 0.6);
      rightHand.group.updateMatrixWorld(true);
      rightHand.mesh.skeleton.update();
    } else if (!leftHasActive && !rightHasActive) {
      leftHand.group.position.x -= worstOverlapX * 0.5;
      rightHand.group.position.x += worstOverlapX * 0.5;
      leftHand.smoothedPalmWorldPosition.x -= worstOverlapX * 0.5;
      rightHand.smoothedPalmWorldPosition.x += worstOverlapX * 0.5;
      leftHand.group.updateMatrixWorld(true);
      leftHand.mesh.skeleton.update();
      rightHand.group.updateMatrixWorld(true);
      rightHand.mesh.skeleton.update();
    } else if (worstVerticalGap > 0.01) {
      // Both hands are actively playing in the same register: bridge the higher-wrist hand
      // vertically above the lower-wrist hand while flexing its active fingers down to stay on their keys.
      const leftPalmY = leftHand.bone("palm").getWorldPosition(new THREE.Vector3()).y;
      const rightPalmY = rightHand.bone("palm").getWorldPosition(new THREE.Vector3()).y;
      const upperHand = leftPalmY >= rightPalmY ? leftHand : rightHand;
      const upperTargets = leftPalmY >= rightPalmY ? leftTargets : rightTargets;
      const liftY = Math.min(0.65, worstVerticalGap + 0.08);
      upperHand.group.position.y += liftY;
      upperHand.smoothedPalmWorldPosition.y += liftY;
      upperHand.group.updateMatrixWorld(true);
      upperHand.mesh.skeleton.update();
      for (const target of upperTargets) {
        if (target.pitch === null || target.finger < 1 || target.finger > 5) continue;
        upperHand.levelAndSeatActiveFingerDistalHull(
          target.finger,
          target,
          1,
          (t) => t.contactCenterX!,
          sampleSurface,
          2,
        );
      }
      for (let finger = 1; finger <= 5; finger++) {
        if (!leftActive.has(finger)) leftHand.liftFreeFingerAboveKeyboardEnvelope(finger, 0, sampleSurface, 2);
        if (!rightActive.has(finger)) rightHand.liftFreeFingerAboveKeyboardEnvelope(finger, 0, sampleSurface, 2);
      }
      leftHand.group.updateMatrixWorld(true);
      leftHand.mesh.skeleton.update();
      rightHand.group.updateMatrixWorld(true);
      rightHand.mesh.skeleton.update();
    }
  }

  private applyPlaybackTemporalSmoothing(
    displayedTransportTimeSeconds: number | undefined,
    activeTargets: ReadonlyMap<number, ImprovedHandContactTarget>,
    computeEngagementWeight: (t: ImprovedHandContactTarget) => number,
    resolveEffectiveCenterX: (t: ImprovedHandContactTarget, tipZ: number) => number,
    sampleSurface: ImprovedHandContactTarget["sampleSurfaceYAt"] | undefined,
  ): void {
    if (displayedTransportTimeSeconds === undefined || !Number.isFinite(displayedTransportTimeSeconds)) {
      this.smoothedTransportTimeSeconds = null;
      return;
    }
    const prevTime = this.smoothedTransportTimeSeconds;
    this.smoothedTransportTimeSeconds = displayedTransportTimeSeconds;
    const dt = prevTime === null ? Infinity : displayedTransportTimeSeconds - prevTime;

    const palm = this.bone("palm");
    this.group.updateMatrixWorld(true);
    palm.getWorldPosition(this.solverPivotWorld);

    if (!(dt > 1e-4 && dt <= 0.09)) {
      this.smoothedPalmWorldPosition.copy(this.solverPivotWorld);
      for (const suffix of DIAGNOSTIC_FINGER_BONE_ORDER) {
        if (suffix === "forearm" || suffix === "palm") continue;
        const bone = this.bone(suffix);
        let quat = this.smoothedBoneQuaternions.get(bone.name);
        if (!quat) {
          quat = new THREE.Quaternion();
          this.smoothedBoneQuaternions.set(bone.name, quat);
        }
        quat.copy(bone.quaternion);
      }
      return;
    }

    // Record unsmoothed active fingertip positions before blending so we can detect large
    // sudden onset jumps (> 0.85 in in a single frame) vs normal continuous tracking.
    this.mesh.skeleton.update();
    const unsmoothedActiveTipMeans = new Map<number, THREE.Vector3>();
    for (const [finger, target] of activeTargets.entries()) {
      if (target.pitch === null) continue;
      const count = this.sampleFingerDistalPoints(finger);
      if (count > 0) {
        const mean = new THREE.Vector3();
        for (let i = 0; i < count; i++) mean.add(this.solverSamplePoints[i]!);
        mean.divideScalar(count);
        unsmoothedActiveTipMeans.set(finger, mean);
      }
    }

    // Exponential smoothing factors (tau_wrist ≈ 36ms, tau_active ≈ 24ms, tau_free ≈ 36ms)
    const wristAlpha = 1 - Math.exp(-dt * 28);
    const activeFingerAlpha = 1 - Math.exp(-dt * 42);
    const freeFingerAlpha = 1 - Math.exp(-dt * 28);

    this.smoothedPalmWorldPosition.lerp(this.solverPivotWorld, wristAlpha);
    this.group.position.add(this.smoothedPalmWorldPosition).sub(this.solverPivotWorld);

    for (const suffix of DIAGNOSTIC_FINGER_BONE_ORDER) {
      if (suffix === "forearm" || suffix === "palm") continue;
      const bone = this.bone(suffix);
      let fingerNumber = 0;
      if (suffix.startsWith("thumb_")) fingerNumber = 1;
      else if (suffix.startsWith("index_")) fingerNumber = 2;
      else if (suffix.startsWith("middle_")) fingerNumber = 3;
      else if (suffix.startsWith("ring_")) fingerNumber = 4;
      else if (suffix.startsWith("little_")) fingerNumber = 5;

      const alpha = activeTargets.has(fingerNumber) ? activeFingerAlpha : freeFingerAlpha;

      const prevQuat = this.smoothedBoneQuaternions.get(bone.name);
      if (prevQuat) {
        prevQuat.slerp(bone.quaternion, alpha).normalize();
        bone.quaternion.copy(prevQuat);
      }
    }

    // Hard whole-hull non-penetration and top-deck seating after temporal blending
    // so smoothed motion never dips any mesh vertex below a key top or drifts off a black-key deck.
    this.group.updateMatrixWorld(true);
    this.mesh.skeleton.update();
    for (let finger = 1; finger <= 5; finger++) {
      const target = activeTargets.get(finger);
      if (!target || target.pitch === null) {
        this.liftFreeFingerAboveKeyboardEnvelope(finger, 0, sampleSurface, 3);
        continue;
      }
      const weight = computeEngagementWeight(target);
      const isRearticulating = target.nextStartSeconds !== undefined || target.prevEndSeconds !== undefined;
      if (weight <= 1e-4 && !isRearticulating) {
        this.liftFreeFingerAboveKeyboardEnvelope(finger, 0, sampleSurface, 3);
        continue;
      }
      const unsmoothedMean = unsmoothedActiveTipMeans.get(finger);
      let residualJumpIn = 0;
      if (unsmoothedMean) {
        const count = this.sampleFingerDistalPoints(finger);
        if (count > 0) {
          this.solverMeanPoint.set(0, 0, 0);
          for (let i = 0; i < count; i++) this.solverMeanPoint.add(this.solverSamplePoints[i]!);
          this.solverMeanPoint.divideScalar(count);
          residualJumpIn = this.solverMeanPoint.distanceTo(unsmoothedMean);
        }
      }
      if (residualJumpIn > 0.42 && weight >= 0.99) {
        // Large sudden onset jump (> 0.85 in before slerp): preserve the damped approach
        // trajectory while enforcing hard non-penetration above the key top surface.
        const surfY = target.sampleSurfaceYAt(target.pitch, this.solverMeanPoint.x, this.solverMeanPoint.z);
        if (surfY !== null && Number.isFinite(surfY)) {
          let minSampleY = Infinity;
          const count = this.sampleFingerDistalPoints(finger);
          for (let i = 0; i < count; i++) {
            if (this.solverSamplePoints[i]!.y < minSampleY) minSampleY = this.solverSamplePoints[i]!.y;
          }
          if (minSampleY < surfY + 0.005) {
            const digitName = DIGITS.find(d => d.number === finger)?.name ?? "index";
            const rootBone = finger === 1 ? this.bone("thumb_segment0_cmc-to-mcp") : this.bone(`${digitName}_proximal`);
            const midBone = finger === 1 ? this.bone("thumb_segment1_mcp-to-ip") : this.bone(`${digitName}_intermediate`);
            rootBone.getWorldPosition(this.solverPivotWorld);
            this.solverDirXZ.set(this.solverMeanPoint.x - this.solverPivotWorld.x, 0, this.solverMeanPoint.z - this.solverPivotWorld.z);
            const rH = this.solverDirXZ.length();
            if (rH > 0.1) {
              this.solverHingeAxis.copy(this.solverDirXZ).cross(this.solverWorldY).normalize();
              const dPitch = THREE.MathUtils.clamp(((surfY + 0.006) - minSampleY) / rH, 0, 0.45);
              if (finger === 1) {
                this.rotateBoneAroundWorldAxis(rootBone, this.solverHingeAxis, dPitch);
              } else {
                this.rotateBoneAroundWorldAxis(rootBone, this.solverHingeAxis, dPitch * 0.7);
                this.rotateBoneAroundWorldAxis(midBone, this.solverHingeAxis, dPitch * 0.3);
              }
            }
          }
        }
      } else {
        this.levelAndSeatActiveFingerDistalHull(
          finger,
          target,
          weight,
          resolveEffectiveCenterX,
          sampleSurface,
          2,
        );
      }
    }

    for (const suffix of DIAGNOSTIC_FINGER_BONE_ORDER) {
      if (suffix === "forearm" || suffix === "palm") continue;
      const bone = this.bone(suffix);
      this.smoothedBoneQuaternions.get(bone.name)?.copy(bone.quaternion);
    }
  }

  /**
   * Rotates the outer rig about its current palm anchor so the forearm-root to
   * wrist direction follows the reconstructed armEnd-to-wrist axis. The palm
   * world transform is restored after rotating the real rig-root/forearm/palm
   * hierarchy, leaving the distal joint pose fixed. Lead-in strength is purely
   * the displayed-time blend already supplied by the caller.
   */
  private alignForearmAxisToMotionPose(pose: ReconstructedHand3D, liveAlpha: number): void {
    if (this.poseEditMode || !Number.isFinite(liveAlpha)) return;
    const strength = THREE.MathUtils.clamp(liveAlpha, 0, 1);
    if (strength === 0) return;

    const parent = this.group.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      if (!this.hasIdentityParentTransform(parent.matrixWorld)) return;
      const determinant = parent.matrixWorld.determinant();
      if (!Number.isFinite(determinant) || determinant === 0) return;
      this.forearmAxisParentInverse.copy(parent.matrixWorld).invert();
      parent.getWorldQuaternion(this.forearmAxisParentWorldQuaternion);
    } else {
      this.forearmAxisParentInverse.identity();
      this.forearmAxisParentWorldQuaternion.identity();
    }

    const targetAxis = this.forearmAxisTarget.subVectors(pose.wristCenter, pose.armEnd);
    const targetLengthSq = targetAxis.lengthSq();
    if (!isFiniteVector3(pose.wristCenter) || !isFiniteVector3(pose.armEnd) ||
        !Number.isFinite(targetLengthSq) || targetLengthSq === 0) return;
    targetAxis.multiplyScalar(1 / Math.sqrt(targetLengthSq));

    const forearm = this.bone("forearm");
    const palm = this.bone("palm");
    if (!palm.parent) return;
    this.group.updateMatrixWorld(true);
    forearm.getWorldPosition(this.forearmAxisForearmRoot);
    palm.getWorldPosition(this.forearmAxisPalmWorldPosition);
    const currentAxis = this.forearmAxisCurrent.subVectors(this.forearmAxisPalmWorldPosition, this.forearmAxisForearmRoot);
    const currentLengthSq = currentAxis.lengthSq();
    if (!isFiniteVector3(currentAxis) || !Number.isFinite(currentLengthSq) || currentLengthSq === 0) return;
    currentAxis.multiplyScalar(1 / Math.sqrt(currentLengthSq));

    // There is no stable unique minimum swing axis at exact opposition. Fade
    // the correction smoothly to zero before Three.js enters its fallback
    // branch, then restore exactly the requested strength outside the narrow
    // numerical ramp. smoothstep has zero slope at both ends, so crossing the
    // fallback boundary cannot switch between two finite swing axes abruptly.
    const oppositionR = THREE.MathUtils.clamp(1 + currentAxis.dot(targetAxis), 0, 2);
    const stableSwingStrength = strength * THREE.MathUtils.smoothstep(
      oppositionR,
      FOREARM_AXIS_OPPOSITION_RAMP_START,
      FOREARM_AXIS_OPPOSITION_RAMP_END,
    );
    if (stableSwingStrength === 0) return;

    this.forearmAxisFullSwing.setFromUnitVectors(currentAxis, targetAxis).normalize();
    this.forearmAxisSwing.identity().slerp(this.forearmAxisFullSwing, stableSwingStrength).normalize();
    if (this.forearmAxisSwing.w >= 1 - Number.EPSILON) return;

    this.forearmAxisParentWorldInverse.copy(this.forearmAxisParentWorldQuaternion).invert();
    this.forearmAxisPalmParentPosition.copy(this.forearmAxisPalmWorldPosition).applyMatrix4(this.forearmAxisParentInverse);
    this.forearmAxisPalmWorldQuaternion.copy(palm.getWorldQuaternion(this.forearmAxisPalmWorldQuaternion));
    this.forearmAxisGroupWorldQuaternion.copy(this.group.getWorldQuaternion(this.forearmAxisGroupWorldQuaternion));
    this.forearmAxisGroupWorldQuaternion.premultiply(this.forearmAxisSwing);
    this.group.quaternion.copy(this.forearmAxisParentWorldInverse).multiply(this.forearmAxisGroupWorldQuaternion).normalize();
    this.group.updateMatrixWorld(true);

    // Keep the palm pivot fixed while changing the root-to-wrist direction.
    palm.getWorldPosition(this.forearmAxisPalmWorldPosition);
    this.forearmAxisMovedPalmParentPosition.copy(this.forearmAxisPalmWorldPosition).applyMatrix4(this.forearmAxisParentInverse);
    this.group.position.add(this.forearmAxisPalmParentPosition).sub(this.forearmAxisMovedPalmParentPosition);
    this.group.updateMatrixWorld(true);

    // The palm is a child of forearm in both checked-in GLBs. Counter-rotate it
    // in that actual hierarchy so the finger chain keeps its world orientation.
    palm.parent.getWorldQuaternion(this.forearmAxisPalmParentWorldQuaternion);
    this.forearmAxisPalmParentWorldInverse.copy(this.forearmAxisPalmParentWorldQuaternion).invert();
    palm.quaternion.copy(this.forearmAxisPalmParentWorldInverse).multiply(this.forearmAxisPalmWorldQuaternion).normalize();
    this.group.updateMatrixWorld(true);
    this.mesh.skeleton.update();
  }

  /** The current MotionPose placement contract requires an identity rig-root parent. */
  private hasIdentityParentTransform(matrix: THREE.Matrix4): boolean {
    const e = matrix.elements;
    // The position update consumes posePointToWorld output directly, so a
    // transformed ancestor is already outside this renderer's placement contract.
    // Keep the correction inert there instead of mixing local and world axes.
    return Math.abs(e[0]! - 1) <= 1e-6 && Math.abs(e[5]! - 1) <= 1e-6 &&
      Math.abs(e[10]! - 1) <= 1e-6 && Math.abs(e[15]! - 1) <= 1e-6 &&
      Math.abs(e[1]!) <= 1e-6 && Math.abs(e[2]!) <= 1e-6 && Math.abs(e[3]!) <= 1e-6 &&
      Math.abs(e[4]!) <= 1e-6 && Math.abs(e[6]!) <= 1e-6 && Math.abs(e[7]!) <= 1e-6 &&
      Math.abs(e[8]!) <= 1e-6 && Math.abs(e[9]!) <= 1e-6 && Math.abs(e[11]!) <= 1e-6 &&
      Math.abs(e[12]!) <= 1e-6 && Math.abs(e[13]!) <= 1e-6 && Math.abs(e[14]!) <= 1e-6;
  }

  private applyLeadInPoseBlend(blend: RiggedExperimentalHandPoseBlend): void {
    const pose = this.validatePose(blend.pose);
    const liveAlpha = THREE.MathUtils.clamp(blend.liveAlpha, 0, 1);
    if (liveAlpha >= 1) return;
    const startByName = new Map(pose.bones.map(bone => [bone.name, bone]));
    this.group.updateMatrixWorld(true);
    const anchoredPalmPosition = this.bone("palm").getWorldPosition(new THREE.Vector3());
    for (const suffix of DIAGNOSTIC_FINGER_BONE_ORDER) {
      const bone = this.bone(suffix);
      const start = startByName.get(bone.name);
      if (!start) throw new Error(`Lead-in pose is missing ${bone.name}.`);
      const livePosition = bone.position.clone();
      const liveQuaternion = bone.quaternion.clone();
      bone.position.copy(vectorFromTuple(start.position)).lerp(livePosition, liveAlpha);
      bone.quaternion.copy(quaternionFromTuple(start.quaternion)).slerp(liveQuaternion, liveAlpha).normalize();
    }

    // Finger and forearm interpolation must not pull the wrist off the current
    // MotionPose anchor while the hand moves from the snapshot to live motion.
    const palm = this.bone("palm");
    if (!palm.parent) throw new Error("Lead-in pose palm has no parent.");
    palm.parent.updateWorldMatrix(true, false);
    const parentInverse = palm.parent.matrixWorld.clone().invert();
    palm.position.copy(anchoredPalmPosition.applyMatrix4(parentInverse));
    this.group.updateMatrixWorld(true);
    this.mesh.skeleton.update();
  }

  public dispose(): void {
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.skeleton.dispose();
    this.material.dispose();
  }
}
