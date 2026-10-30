import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { ReconstructedHand3D } from "./handRigBuilder";

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
  private readonly sourceWrist: THREE.Vector3;
  private readonly sourceFrame: THREE.Quaternion;
  private readonly mesh: THREE.SkinnedMesh;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly fixedDistalSkinSamples: Array<{ finger: number; sample: number; vertexIndex: number; terminalBoneWeight: number }> = [];
  private readonly importedBasePose!: RiggedExperimentalHandPose;
  private poseBeforeEdit: RiggedExperimentalHandPose | null = null;
  private poseEditMode = false;

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
    for (const { finger, name } of DIAGNOSTIC_DISTAL_BONES) {
      const bone = this.bone(name);
      const boneIndex = this.mesh.skeleton.bones.indexOf(bone);
      if (boneIndex < 0) continue;
      const origin = bone.getWorldPosition(new THREE.Vector3());
      const distalAxis = new THREE.Vector3(0, 1, 0)
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

  public update(pose: ReconstructedHand3D, leadInBlend?: RiggedExperimentalHandPoseBlend): void {
    if (this.poseEditMode) return;
    const mcps = DIGITS.map(({ number }) => pose.chains[number]?.[1]);
    if (mcps.some((point) => !point)) return;
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
    if (leadInBlend && leadInBlend.liveAlpha < 1) this.applyLeadInPoseBlend(leadInBlend);
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
