import * as THREE from "three";
import { IMPROVED_HAND_JOINT_NAMES } from "./improvedHandAssets";

/**
 * Testing2 edits use the named bind/rest centers from the improved hand GLB.
 * The source positions are estimates in meters, not verified anatomical truth.
 */
export const TESTING2_RIG_JOINT_NAMES = IMPROVED_HAND_JOINT_NAMES;
export type Testing2RigJointName = typeof TESTING2_RIG_JOINT_NAMES[number];
export type Testing2RigJointPoint = readonly [number, number, number];
export type Testing2RigJointCenters = Readonly<Record<Testing2RigJointName, Testing2RigJointPoint>>;

export const TESTING2_DEFAULT_MIN_CHAIN_LENGTH_METERS = 0.001;
export const TESTING2_DEFAULT_MAX_CHAIN_LENGTH_METERS = 0.15;
export const TESTING2_DEFAULT_MIRROR_TOLERANCE_METERS = 0.005;
export const TESTING2_DEFAULT_ROOT_UNITS_PER_METER = 1;
export const TESTING2_INCHES_PER_METER = 39.37007874015748;

export interface Testing2RigJointValidationOptions {
  /** Lower bound for each wrist-to-metacarpal and digit-chain edge. */
  minChainLengthMeters?: number;
  /** Upper bound for each wrist-to-metacarpal and digit-chain edge. */
  maxChainLengthMeters?: number;
}

export interface Testing2RigEditTransferOptions extends Testing2RigJointValidationOptions {
  /** Number of coordinateRoot-local units in one source meter (e.g. inches: 39.37007874). */
  rootUnitsPerMeter?: number;
}

export interface Testing2RigChainMeasurement {
  start: Testing2RigJointName;
  end: Testing2RigJointName;
  lengthMeters: number;
}

export interface Testing2RigMirrorDeviation {
  name: Testing2RigJointName;
  deviationMeters: number;
}

export interface Testing2RigMirrorComparison {
  consistent: boolean;
  toleranceMeters: number;
  maxDeviationMeters: number;
  deviations: Testing2RigMirrorDeviation[];
}

export interface Testing2AppliedRigEdit {
  readonly before: Testing2RigJointCenters;
  readonly after: Testing2RigJointCenters;
  readonly isApplied: boolean;
  undo(): void;
  redo(): void;
}

export type Testing2RigChainEdge = readonly [start: Testing2RigJointName, end: Testing2RigJointName];

function chainEdge(start: string, end: string): Testing2RigChainEdge {
  return [start as Testing2RigJointName, end as Testing2RigJointName];
}

const FINGER_CHAIN_EDGES: readonly Testing2RigChainEdge[] = [
  ["thumb-metacarpal", "thumb-phalanx-proximal"],
  ["thumb-phalanx-proximal", "thumb-phalanx-distal"],
  ["thumb-phalanx-distal", "thumb-tip"],
  ...(["index", "middle", "ring", "pinky"] as const).flatMap((finger) => {
    const prefix = `${finger}-finger` as const;
    return [
      chainEdge(`${prefix}-metacarpal`, `${prefix}-phalanx-proximal`),
      chainEdge(`${prefix}-phalanx-proximal`, `${prefix}-phalanx-intermediate`),
      chainEdge(`${prefix}-phalanx-intermediate`, `${prefix}-phalanx-distal`),
      chainEdge(`${prefix}-phalanx-distal`, `${prefix}-tip`),
    ] as const;
  }),
];

/**
 * The 25 points form five digit chains rooted at the palm. Wrist-to-metacarpal
 * spans are validated as well, so a malformed wrist cannot silently detach a
 * digit root from the edited hand frame.
 */
export const TESTING2_RIG_CHAIN_EDGES: readonly Testing2RigChainEdge[] = [
  ...(["thumb", "index-finger", "middle-finger", "ring-finger", "pinky-finger"] as const)
    .map((finger) => ["wrist", `${finger}-metacarpal`] as const),
  ...FINGER_CHAIN_EDGES,
];

const JOINT_NAME_SET = new Set<string>(TESTING2_RIG_JOINT_NAMES);
const BIND_NEUTRAL_TOLERANCE = 2e-5;
const MIN_MATRIX_DETERMINANT = 1e-12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveValidationBounds(options: Testing2RigJointValidationOptions = {}): {
  min: number;
  max: number;
} {
  const min = options.minChainLengthMeters ?? TESTING2_DEFAULT_MIN_CHAIN_LENGTH_METERS;
  const max = options.maxChainLengthMeters ?? TESTING2_DEFAULT_MAX_CHAIN_LENGTH_METERS;
  if (!Number.isFinite(min) || min <= 0 || !Number.isFinite(max) || max <= min) {
    throw new Error("Testing2 chain length bounds must be finite, positive, and ordered.");
  }
  return { min, max };
}

function validatePoint(value: unknown, name: string): Testing2RigJointPoint {
  if (!Array.isArray(value) || value.length !== 3 ||
      value.some((component) => typeof component !== "number" || !Number.isFinite(component))) {
    throw new Error(`Testing2 joint '${name}' must be a finite [x, y, z] coordinate in meters.`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function distanceMeters(a: Testing2RigJointPoint, b: Testing2RigJointPoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Validates all names, coordinates, and chain lengths, then returns a deep,
 * immutable copy. Values are never clamped or silently filled in.
 */
export function validateTesting2RigJointCenters(
  input: unknown,
  options: Testing2RigJointValidationOptions = {},
): Testing2RigJointCenters {
  const { min, max } = resolveValidationBounds(options);
  if (!isRecord(input)) {
    throw new Error("Testing2 joint centers must be a named object containing all 25 coordinates in meters.");
  }

  const inputNames = Reflect.ownKeys(input);
  const unexpected = inputNames.filter((name) => typeof name !== "string" || !JOINT_NAME_SET.has(name)).map(String);
  if (unexpected.length > 0) {
    throw new Error(`Testing2 joint centers contain unknown name(s): ${unexpected.join(", ")}.`);
  }
  const missing = TESTING2_RIG_JOINT_NAMES.filter((name) => !Object.hasOwn(input, name));
  if (missing.length > 0) {
    throw new Error(`Testing2 joint centers are missing required name(s): ${missing.join(", ")}.`);
  }

  const result = {} as Record<Testing2RigJointName, Testing2RigJointPoint>;
  for (const name of TESTING2_RIG_JOINT_NAMES) {
    result[name] = Object.freeze(validatePoint(input[name], name));
  }

  for (const [start, end] of TESTING2_RIG_CHAIN_EDGES) {
    const length = distanceMeters(result[start], result[end]);
    if (!Number.isFinite(length) || length < min || length > max) {
      throw new Error(
        `Testing2 chain '${start}' -> '${end}' is ${length} m; expected ${min}–${max} m.`,
      );
    }
  }
  return Object.freeze(result);
}

export function measureTesting2RigChains(
  input: unknown,
  options: Testing2RigJointValidationOptions = {},
): Testing2RigChainMeasurement[] {
  const centers = validateTesting2RigJointCenters(input, options);
  return TESTING2_RIG_CHAIN_EDGES.map(([start, end]) => ({
    start,
    end,
    lengthMeters: distanceMeters(centers[start], centers[end]),
  }));
}

/**
 * Checks the paired source assets' apparent mirror about X after centering each
 * hand on its wrist. It reports differences and never rewrites either hand.
 */
export function compareTesting2RigJointCentersMirror(
  leftInput: unknown,
  rightInput: unknown,
  toleranceMeters = TESTING2_DEFAULT_MIRROR_TOLERANCE_METERS,
): Testing2RigMirrorComparison {
  if (!Number.isFinite(toleranceMeters) || toleranceMeters < 0) {
    throw new Error("Testing2 mirror tolerance must be a finite non-negative number of meters.");
  }
  const left = validateTesting2RigJointCenters(leftInput);
  const right = validateTesting2RigJointCenters(rightInput);
  const leftWrist = left.wrist;
  const rightWrist = right.wrist;
  const deviations = TESTING2_RIG_JOINT_NAMES.map((name) => {
    const lx = left[name][0] - leftWrist[0];
    const ly = left[name][1] - leftWrist[1];
    const lz = left[name][2] - leftWrist[2];
    const rx = right[name][0] - rightWrist[0];
    const ry = right[name][1] - rightWrist[1];
    const rz = right[name][2] - rightWrist[2];
    return {
      name,
      deviationMeters: Math.hypot(lx + rx, ly - ry, lz - rz),
    };
  });
  const maxDeviationMeters = Math.max(...deviations.map(({ deviationMeters }) => deviationMeters));
  return {
    consistent: maxDeviationMeters <= toleranceMeters,
    toleranceMeters,
    maxDeviationMeters,
    deviations,
  };
}

function assertPositiveScale(rootUnitsPerMeter: number): void {
  if (!Number.isFinite(rootUnitsPerMeter) || rootUnitsPerMeter <= 0) {
    throw new Error("Testing2 rootUnitsPerMeter must be a positive finite number.");
  }
}

function getRigBones(mesh: THREE.SkinnedMesh, coordinateRoot: THREE.Object3D): THREE.Bone[] {
  if (!mesh.skeleton) throw new Error("Testing2 edit target has no THREE.Skeleton.");
  const bones = mesh.skeleton.bones;
  if (bones.length !== TESTING2_RIG_JOINT_NAMES.length || mesh.skeleton.boneInverses.length !== bones.length) {
    throw new Error("Testing2 edit target must have exactly 25 bones and 25 inverse bind matrices.");
  }
  const byName = new Map<string, THREE.Bone>();
  for (const candidate of bones) {
    if (!(candidate instanceof THREE.Bone) || !candidate.name || byName.has(candidate.name)) {
      throw new Error("Testing2 edit target has a missing, duplicate, or non-bone skeleton entry.");
    }
    if (!isDescendantOf(candidate, coordinateRoot)) {
      throw new Error(`Testing2 joint '${candidate.name}' is outside the coordinate root.`);
    }
    byName.set(candidate.name, candidate);
  }
  const missing = TESTING2_RIG_JOINT_NAMES.filter((name) => !byName.has(name));
  const extra = [...byName.keys()].filter((name) => !JOINT_NAME_SET.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Testing2 skeleton names do not match the 25-joint contract (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`);
  }
  return TESTING2_RIG_JOINT_NAMES.map((name) => byName.get(name)!);
}

function isDescendantOf(object: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function updateRigWorldMatrices(mesh: THREE.SkinnedMesh, coordinateRoot: THREE.Object3D): void {
  coordinateRoot.updateWorldMatrix(true, true);
  mesh.updateWorldMatrix(true, false);
  mesh.skeleton.update();
}

function assertFiniteInvertibleMatrix(matrix: THREE.Matrix4, description: string): void {
  const determinant = matrix.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) < MIN_MATRIX_DETERMINANT ||
      matrix.elements.some((component) => !Number.isFinite(component))) {
    throw new Error(`${description} must be finite and invertible.`);
  }
}

function readCenters(
  mesh: THREE.SkinnedMesh,
  coordinateRoot: THREE.Object3D,
  bones: readonly THREE.Bone[],
  rootUnitsPerMeter: number,
): Testing2RigJointCenters {
  updateRigWorldMatrices(mesh, coordinateRoot);
  assertFiniteInvertibleMatrix(coordinateRoot.matrixWorld, "Testing2 coordinate root transform");
  const rootInverse = new THREE.Matrix4().copy(coordinateRoot.matrixWorld).invert();
  const result = {} as Record<Testing2RigJointName, Testing2RigJointPoint>;
  for (const bone of bones) {
    const name = bone.name as Testing2RigJointName;
    const point = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld)
      .applyMatrix4(rootInverse)
      .multiplyScalar(1 / rootUnitsPerMeter);
    result[name] = [point.x, point.y, point.z];
  }
  return validateTesting2RigJointCenters(result);
}

/** Reads the current named bind/rest centers in meters from a flat or hierarchical THREE rig. */
export function readTesting2RigJointCenters(
  mesh: THREE.SkinnedMesh,
  coordinateRoot: THREE.Object3D,
  rootUnitsPerMeter = TESTING2_DEFAULT_ROOT_UNITS_PER_METER,
): Testing2RigJointCenters {
  assertPositiveScale(rootUnitsPerMeter);
  const bones = getRigBones(mesh, coordinateRoot);
  return readCenters(mesh, coordinateRoot, bones, rootUnitsPerMeter);
}

interface BoneState {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  matrix: THREE.Matrix4;
  matrixAutoUpdate: boolean;
}

interface RigState {
  bones: BoneState[];
  inverseBinds: THREE.Matrix4[];
}

function captureRigState(mesh: THREE.SkinnedMesh, bones: readonly THREE.Bone[]): RigState {
  return {
    bones: bones.map((bone) => ({
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
      scale: bone.scale.clone(),
      matrix: bone.matrix.clone(),
      matrixAutoUpdate: bone.matrixAutoUpdate,
    })),
    inverseBinds: mesh.skeleton.boneInverses.map((matrix) => matrix.clone()),
  };
}

function restoreRigState(
  mesh: THREE.SkinnedMesh,
  coordinateRoot: THREE.Object3D,
  bones: readonly THREE.Bone[],
  state: RigState,
): void {
  for (let index = 0; index < bones.length; index++) {
    const bone = bones[index]!;
    const saved = state.bones[index]!;
    bone.position.copy(saved.position);
    bone.quaternion.copy(saved.quaternion);
    bone.scale.copy(saved.scale);
    bone.matrixAutoUpdate = saved.matrixAutoUpdate;
    bone.matrix.copy(saved.matrix);
    bone.matrixWorldNeedsUpdate = true;
    mesh.skeleton.boneInverses[index]!.copy(state.inverseBinds[index]!);
  }
  updateRigWorldMatrices(mesh, coordinateRoot);
}

function rigStateMatches(mesh: THREE.SkinnedMesh, bones: readonly THREE.Bone[], state: RigState): boolean {
  return bones.every((bone, index) => {
    const saved = state.bones[index]!;
    return bone.position.equals(saved.position) && bone.quaternion.equals(saved.quaternion) &&
      bone.scale.equals(saved.scale) && bone.matrix.equals(saved.matrix) &&
      bone.matrixAutoUpdate === saved.matrixAutoUpdate &&
      mesh.skeleton.boneInverses[index]!.equals(state.inverseBinds[index]!);
  });
}

function assertNeutralBind(mesh: THREE.SkinnedMesh, bones: readonly THREE.Bone[]): void {
  for (let index = 0; index < bones.length; index++) {
    const composite = new THREE.Matrix4().multiplyMatrices(
      bones[index]!.matrixWorld,
      mesh.skeleton.boneInverses[index]!,
    );
    const expected = new THREE.Matrix4();
    if (composite.elements.some((value, element) =>
      !Number.isFinite(value) || Math.abs(value - expected.elements[element]!) > BIND_NEUTRAL_TOLERANCE,
    )) {
      throw new Error(`Testing2 neutral bind invariant failed for joint '${bones[index]!.name}'.`);
    }
  }
}

function applyCentersAndRebind(
  mesh: THREE.SkinnedMesh,
  coordinateRoot: THREE.Object3D,
  bones: readonly THREE.Bone[],
  centers: Testing2RigJointCenters,
  rootUnitsPerMeter: number,
): void {
  updateRigWorldMatrices(mesh, coordinateRoot);
  assertFiniteInvertibleMatrix(coordinateRoot.matrixWorld, "Testing2 coordinate root transform");
  const rootMatrix = coordinateRoot.matrixWorld.clone();
  const targetWorldByName = new Map<Testing2RigJointName, THREE.Vector3>();
  for (const name of TESTING2_RIG_JOINT_NAMES) {
    const [x, y, z] = centers[name];
    targetWorldByName.set(name, new THREE.Vector3(x, y, z).multiplyScalar(rootUnitsPerMeter).applyMatrix4(rootMatrix));
  }

  // Parents are moved first so a hierarchical rig still lands every center at
  // the requested root-local location. GLB joints are flat siblings today.
  const byDepth = [...bones].sort((a, b) => objectDepth(a) - objectDepth(b));
  for (const bone of byDepth) {
    const parent = bone.parent;
    if (!parent) throw new Error(`Testing2 joint '${bone.name}' has no parent.`);
    parent.updateWorldMatrix(true, false);
    assertFiniteInvertibleMatrix(parent.matrixWorld, `Parent transform for Testing2 joint '${bone.name}'`);
    const targetWorld = targetWorldByName.get(bone.name as Testing2RigJointName);
    if (!targetWorld) throw new Error(`Testing2 joint '${bone.name}' has no target center.`);
    const targetLocal = targetWorld.clone().applyMatrix4(new THREE.Matrix4().copy(parent.matrixWorld).invert());
    if (![targetLocal.x, targetLocal.y, targetLocal.z].every(Number.isFinite)) {
      throw new Error(`Testing2 joint '${bone.name}' target cannot be represented in its parent frame.`);
    }
    bone.position.copy(targetLocal);
    bone.updateMatrix();
    bone.matrixWorldNeedsUpdate = true;
    coordinateRoot.updateWorldMatrix(true, true);
  }

  updateRigWorldMatrices(mesh, coordinateRoot);
  const nextInverseBinds = bones.map((bone) => {
    assertFiniteInvertibleMatrix(bone.matrixWorld, `World transform for Testing2 joint '${bone.name}'`);
    const inverse = bone.matrixWorld.clone().invert();
    if (inverse.elements.some((component) => !Number.isFinite(component))) {
      throw new Error(`Testing2 joint '${bone.name}' has a non-finite inverse bind matrix.`);
    }
    return inverse;
  });
  nextInverseBinds.forEach((inverse, index) => mesh.skeleton.boneInverses[index]!.copy(inverse));
  updateRigWorldMatrices(mesh, coordinateRoot);
  assertNeutralBind(mesh, bones);
}

function objectDepth(object: THREE.Object3D): number {
  let depth = 0;
  for (let current = object.parent; current; current = current.parent) depth++;
  return depth;
}

function withRollback<T>(
  mesh: THREE.SkinnedMesh,
  coordinateRoot: THREE.Object3D,
  bones: readonly THREE.Bone[],
  rollbackState: RigState,
  action: () => T,
): T {
  try {
    return action();
  } catch (error) {
    try {
      restoreRigState(mesh, coordinateRoot, bones, rollbackState);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Testing2 rig edit failed and rollback could not restore the rig.",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

/**
 * Applies edited centers to a neutral SkinnedMesh rig as one reversible
 * transaction. It changes only bone positions and inverse-bind matrices;
 * geometry and weights stay untouched. This creates a neutral-bind preview,
 * not a complete handRigBuilder runtime calibration: that runtime also reads
 * bindPositionM, bindLengthIn, bindRootInWrist, localLateralInWrist, and
 * bindQuaternion metadata. Rebinding cannot repair incorrect skin weights.
 */
export function createTesting2RigEditTransaction(
  mesh: THREE.SkinnedMesh,
  coordinateRoot: THREE.Object3D,
  afterInput: unknown,
  options: Testing2RigEditTransferOptions = {},
): Testing2AppliedRigEdit {
  const rootUnitsPerMeter = options.rootUnitsPerMeter ?? TESTING2_DEFAULT_ROOT_UNITS_PER_METER;
  assertPositiveScale(rootUnitsPerMeter);
  const bones = getRigBones(mesh, coordinateRoot);
  const before = readCenters(mesh, coordinateRoot, bones, rootUnitsPerMeter);
  const after = validateTesting2RigJointCenters(afterInput, options);
  const beforeState = captureRigState(mesh, bones);
  assertNeutralBind(mesh, bones);

  const afterState = withRollback(mesh, coordinateRoot, bones, beforeState, () => {
    applyCentersAndRebind(mesh, coordinateRoot, bones, after, rootUnitsPerMeter);
    return captureRigState(mesh, bones);
  });

  let applied = true;
  const moveTo = (expected: RigState, destination: RigState): void => {
    if (!rigStateMatches(mesh, bones, expected)) {
      throw new Error("Testing2 rig changed outside this edit transaction; refusing to overwrite the concurrent pose.");
    }
    withRollback(mesh, coordinateRoot, bones, expected, () => {
      restoreRigState(mesh, coordinateRoot, bones, destination);
      assertNeutralBind(mesh, bones);
    });
  };

  return {
    before,
    after,
    get isApplied() { return applied; },
    undo() {
      if (!applied) return;
      moveTo(afterState, beforeState);
      applied = false;
    },
    redo() {
      if (applied) return;
      moveTo(beforeState, afterState);
      applied = true;
    },
  };
}
