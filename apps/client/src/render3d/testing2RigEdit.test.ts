// @ts-expect-error Vitest runs this checked-in asset test in Node; Node types are excluded from app source compilation.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  compareTesting2RigJointCentersMirror,
  createTesting2RigEditTransaction,
  readTesting2RigJointCenters,
  TESTING2_RIG_JOINT_NAMES,
  validateTesting2RigJointCenters,
  type Testing2RigJointCenters,
  type Testing2RigJointName,
} from "./testing2RigEdit";

const improvedModelsUrl = new URL("../../public/models/hands/improved/", import.meta.url);
const leftGlbUrl = new URL("left-lod0.glb", improvedModelsUrl);
const rightGlbUrl = new URL("right-lod0.glb", improvedModelsUrl);
const MIRROR_TOLERANCE_METERS = 0.005;

interface GlbNode {
  name?: string;
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  children?: number[];
}

interface GlbAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  normalized?: boolean;
  type: "SCALAR" | "VEC2" | "VEC3" | "VEC4" | "MAT4";
}

interface GlbJson {
  nodes: GlbNode[];
  skins: Array<{ joints: number[]; inverseBindMatrices: number }>;
  accessors: GlbAccessor[];
  bufferViews: Array<{ byteOffset?: number; byteStride?: number }>;
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
}

interface ParsedRealRig {
  scene: THREE.Group;
  coordinateRoot: THREE.Group;
  mesh: THREE.SkinnedMesh;
  centers: Testing2RigJointCenters;
}

function readGlbJson(buffer: ArrayBuffer): { json: GlbJson; binOffset: number } {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) {
    throw new Error("Test fixture is not a GLB 2 file.");
  }
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as GlbJson;
  return { json, binOffset: 20 + jsonLength + 8 };
}

function readArrayBuffer(url: URL): ArrayBuffer {
  const bytes = readFileSync(url);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function componentCount(type: GlbAccessor["type"]): number {
  switch (type) {
    case "SCALAR": return 1;
    case "VEC2": return 2;
    case "VEC3": return 3;
    case "VEC4": return 4;
    case "MAT4": return 16;
  }
}

function componentBytes(componentType: number): number {
  if (componentType === 5120 || componentType === 5121) return 1;
  if (componentType === 5122 || componentType === 5123) return 2;
  if (componentType === 5125 || componentType === 5126) return 4;
  throw new Error(`Unsupported GLB accessor component type ${componentType}.`);
}

function readComponent(view: DataView, offset: number, type: number): number {
  switch (type) {
    case 5120: return view.getInt8(offset);
    case 5121: return view.getUint8(offset);
    case 5122: return view.getInt16(offset, true);
    case 5123: return view.getUint16(offset, true);
    case 5125: return view.getUint32(offset, true);
    case 5126: return view.getFloat32(offset, true);
    default: throw new Error(`Unsupported GLB accessor component type ${type}.`);
  }
}

function readAccessor(buffer: ArrayBuffer, json: GlbJson, binOffset: number, index: number): number[] {
  const accessor = json.accessors[index]!;
  const bufferView = json.bufferViews[accessor.bufferView]!;
  const itemComponents = componentCount(accessor.type);
  const bytesPerComponent = componentBytes(accessor.componentType);
  const itemBytes = itemComponents * bytesPerComponent;
  const stride = bufferView.byteStride ?? itemBytes;
  const baseOffset = binOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const data = new DataView(buffer);
  const values = new Array<number>(accessor.count * itemComponents);
  let outputIndex = 0;
  for (let item = 0; item < accessor.count; item++) {
    for (let component = 0; component < itemComponents; component++) {
      let value = readComponent(data, baseOffset + item * stride + component * bytesPerComponent, accessor.componentType);
      if (accessor.normalized) {
        if (accessor.componentType === 5120) value = Math.max(value / 127, -1);
        else if (accessor.componentType === 5121) value /= 255;
        else if (accessor.componentType === 5122) value = Math.max(value / 32767, -1);
        else if (accessor.componentType === 5123) value /= 65535;
      }
      values[outputIndex++] = value;
    }
  }
  return values;
}

function readRealRig(url: URL): ParsedRealRig {
  const buffer = readArrayBuffer(url);
  const { json, binOffset } = readGlbJson(buffer);
  const skin = json.skins[0]!;
  const parentByNodeIndex = new Map<number, number>();
  json.nodes.forEach((node, parentIndex) => node.children?.forEach((childIndex) => parentByNodeIndex.set(childIndex, parentIndex)));
  const jointEntries = skin.joints.map((nodeIndex) => {
    const node = json.nodes[nodeIndex]!;
    return { nodeIndex, node };
  });
  const names = jointEntries.map(({ node }) => node.name);
  expect(names).toEqual(TESTING2_RIG_JOINT_NAMES);
  expect(jointEntries.every(({ node }) => !node.children?.length)).toBe(true);
  expect(jointEntries.every(({ nodeIndex }) => json.nodes[parentByNodeIndex.get(nodeIndex)!]?.name === "Armature")).toBe(true);

  const centersInput = Object.fromEntries(jointEntries.map(({ node }) => [node.name!, node.translation!])) as Record<string, unknown>;
  const centers = validateTesting2RigJointCenters(centersInput);
  const scene = new THREE.Group();
  const coordinateRoot = new THREE.Group();
  coordinateRoot.name = "Armature";
  scene.add(coordinateRoot);

  const bonesByName = new Map<string, THREE.Bone>();
  for (const { node } of jointEntries) {
    const bone = new THREE.Bone();
    bone.name = node.name!;
    bone.position.fromArray(node.translation ?? [0, 0, 0]);
    bone.quaternion.fromArray(node.rotation ?? [0, 0, 0, 1]);
    coordinateRoot.add(bone);
    bonesByName.set(bone.name, bone);
  }
  const bones = TESTING2_RIG_JOINT_NAMES.map((name) => bonesByName.get(name)!);
  scene.updateWorldMatrix(true, true);

  const inverseBindValues = readAccessor(buffer, json, binOffset, skin.inverseBindMatrices);
  const inverseBinds = bones.map((_, index) => new THREE.Matrix4().fromArray(inverseBindValues.slice(index * 16, (index + 1) * 16)));
  const primitive = json.meshes[0]!.primitives[0]!;
  const positionValues = readAccessor(buffer, json, binOffset, primitive.attributes.POSITION!);
  const jointValues = readAccessor(buffer, json, binOffset, primitive.attributes.JOINTS_0!);
  const weightValues = readAccessor(buffer, json, binOffset, primitive.attributes.WEIGHTS_0!);
  const vertexCount = json.accessors[primitive.attributes.POSITION!]!.count;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positionValues, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(jointValues, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weightValues, 4));
  expect(geometry.getAttribute("position").count).toBe(vertexCount);

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = "ImprovedHandMesh";
  scene.add(mesh);
  mesh.bind(new THREE.Skeleton(bones, inverseBinds), new THREE.Matrix4());
  scene.updateWorldMatrix(true, true);
  mesh.skeleton.update();
  return { scene, coordinateRoot, mesh, centers };
}

function getNeutralSurface(mesh: THREE.SkinnedMesh): Float64Array {
  mesh.skeleton.update();
  const position = mesh.geometry.getAttribute("position");
  const result = new Float64Array(position.count * 3);
  const point = new THREE.Vector3();
  for (let index = 0; index < position.count; index++) {
    point.fromBufferAttribute(position, index);
    mesh.applyBoneTransform(index, point);
    result[index * 3] = point.x;
    result[index * 3 + 1] = point.y;
    result[index * 3 + 2] = point.z;
  }
  return result;
}

function snapshotGeometry(mesh: THREE.SkinnedMesh): Record<string, Float32Array | Uint16Array> {
  return {
    position: Float32Array.from(mesh.geometry.getAttribute("position").array),
    skinIndex: Uint16Array.from(mesh.geometry.getAttribute("skinIndex").array),
    skinWeight: Float32Array.from(mesh.geometry.getAttribute("skinWeight").array),
  };
}

function expectSurfaceEqual(actual: Float64Array, expected: Float64Array, precision = 6): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < actual.length; index++) {
    expect(actual[index]).toBeCloseTo(expected[index]!, precision);
  }
}

function expectCentersClose(actual: Testing2RigJointCenters, expected: Testing2RigJointCenters, precision = 8): void {
  for (const name of TESTING2_RIG_JOINT_NAMES) {
    for (let axis = 0; axis < 3; axis++) {
      expect(actual[name][axis]).toBeCloseTo(expected[name][axis]!, precision);
    }
  }
}

function cloneCenters(centers: Testing2RigJointCenters): Record<Testing2RigJointName, [number, number, number]> {
  return Object.fromEntries(TESTING2_RIG_JOINT_NAMES.map((name) => [name, [...centers[name]]])) as Record<Testing2RigJointName, [number, number, number]>;
}

function makeSyntheticRig(centers: Testing2RigJointCenters, rootUnitsPerMeter = 1): ParsedRealRig {
  const scene = new THREE.Group();
  const coordinateRoot = new THREE.Group();
  coordinateRoot.position.set(0.7, -0.3, 0.2);
  coordinateRoot.rotation.set(0.1, -0.2, 0.05);
  coordinateRoot.scale.setScalar(1.4);
  scene.add(coordinateRoot);
  const bones = TESTING2_RIG_JOINT_NAMES.map((name) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(...centers[name].map((component) => component * rootUnitsPerMeter) as [number, number, number]);
    coordinateRoot.add(bone);
    return bone;
  });
  scene.updateWorldMatrix(true, true);
  const inverses = bones.map((bone) => bone.matrixWorld.clone().invert());
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.01, 0.02, 0.03,
    0.03, -0.02, 0.01,
    0.08, 0.04, -0.03,
  ], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([
    23, 19, 11, 3,
    18, 10, 8, 6,
    2, 15, 20, 24,
  ], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
    0.4, 0.3, 0.2, 0.1,
    0.25, 0.25, 0.25, 0.25,
    0.55, 0.2, 0.15, 0.1,
  ], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  scene.add(mesh);
  mesh.bind(new THREE.Skeleton(bones, inverses), new THREE.Matrix4());
  scene.updateWorldMatrix(true, true);
  mesh.skeleton.update();
  return { scene, coordinateRoot, mesh, centers };
}

describe("Testing2 editable bind/rest joint centers", () => {
  it("accepts a complete named finite meter-space set and rejects missing, extra, and non-finite names", () => {
    const rig = readRealRig(leftGlbUrl);
    const copy = validateTesting2RigJointCenters(rig.centers);
    expect(Object.keys(copy)).toHaveLength(25);
    expect(copy.wrist).toEqual(rig.centers.wrist);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.wrist)).toBe(true);

    const missing = cloneCenters(rig.centers) as Record<string, unknown>;
    delete missing.wrist;
    expect(() => validateTesting2RigJointCenters(missing)).toThrow(/missing.*wrist/i);

    const extra = { ...cloneCenters(rig.centers), mystery: [0, 0, 0] };
    expect(() => validateTesting2RigJointCenters(extra)).toThrow(/unknown.*mystery/i);

    const nonFinite = cloneCenters(rig.centers);
    nonFinite["index-finger-phalanx-proximal"][0] = Number.NaN;
    expect(() => validateTesting2RigJointCenters(nonFinite)).toThrow(/finite/i);
  });

  it("rejects collapsed and out-of-range chains but allows small valid point edits", () => {
    const base = readRealRig(leftGlbUrl).centers;
    const collapsed = cloneCenters(base);
    collapsed["index-finger-phalanx-proximal"] = [...collapsed["index-finger-metacarpal"]];
    expect(() => validateTesting2RigJointCenters(collapsed)).toThrow(/index-finger-metacarpal.*index-finger-phalanx-proximal/i);

    const stretched = cloneCenters(base);
    stretched["thumb-tip"][1] += 0.3;
    expect(() => validateTesting2RigJointCenters(stretched)).toThrow(/thumb-phalanx-distal.*thumb-tip/i);

    const smallEdit = cloneCenters(base);
    smallEdit["index-finger-phalanx-proximal"][1] += 0.001;
    expect(() => validateTesting2RigJointCenters(smallEdit)).not.toThrow();
  });

  it("compares actual left/right GLB centers after wrist-relative X reflection", () => {
    const left = readRealRig(leftGlbUrl).centers;
    const right = readRealRig(rightGlbUrl).centers;
    const comparison = compareTesting2RigJointCentersMirror(left, right, MIRROR_TOLERANCE_METERS);
    expect(comparison.consistent).toBe(true);
    expect(comparison.maxDeviationMeters).toBeLessThanOrEqual(MIRROR_TOLERANCE_METERS);

    const asymmetric = cloneCenters(right);
    asymmetric["index-finger-tip"][2] += 0.02;
    expect(compareTesting2RigJointCentersMirror(left, asymmetric).consistent).toBe(false);
  });

  it("keeps the complete real GLB neutral skinned surface fixed through edit, undo, and redo", () => {
    for (const url of [leftGlbUrl, rightGlbUrl]) {
      const rig = readRealRig(url);
      const surfaceBefore = getNeutralSurface(rig.mesh);
      const geometryBefore = snapshotGeometry(rig.mesh);
      const edited = cloneCenters(rig.centers);
      edited["middle-finger-phalanx-proximal"][0] += 0.001;
      const transaction = createTesting2RigEditTransaction(
        rig.mesh,
        rig.coordinateRoot,
        edited,
      );

      expect(transaction.isApplied).toBe(true);
      expectSurfaceEqual(getNeutralSurface(rig.mesh), surfaceBefore);
      expect(snapshotGeometry(rig.mesh)).toEqual(geometryBefore);
      expect(readTesting2RigJointCenters(rig.mesh, rig.coordinateRoot)["middle-finger-phalanx-proximal"][0])
        .toBeCloseTo(edited["middle-finger-phalanx-proximal"][0], 6);

      transaction.undo();
      expect(transaction.isApplied).toBe(false);
      expectSurfaceEqual(getNeutralSurface(rig.mesh), surfaceBefore);
      expect(snapshotGeometry(rig.mesh)).toEqual(geometryBefore);
      expect(readTesting2RigJointCenters(rig.mesh, rig.coordinateRoot)).toEqual(rig.centers);

      transaction.redo();
      expect(transaction.isApplied).toBe(true);
      expectSurfaceEqual(getNeutralSurface(rig.mesh), surfaceBefore);
      expect(snapshotGeometry(rig.mesh)).toEqual(geometryBefore);
    }
  }, 15_000);

  it("round-trips meters through a transformed inches-space rig", () => {
    const metersToInches = 39.37007874;
    const source = readRealRig(rightGlbUrl).centers;
    const rig = makeSyntheticRig(source, metersToInches);
    expectCentersClose(readTesting2RigJointCenters(rig.mesh, rig.coordinateRoot, metersToInches), source);

    const edited = cloneCenters(source);
    edited["ring-finger-phalanx-intermediate"][2] += 0.001;
    const transaction = createTesting2RigEditTransaction(rig.mesh, rig.coordinateRoot, edited, {
      rootUnitsPerMeter: metersToInches,
    });
    expect(readTesting2RigJointCenters(rig.mesh, rig.coordinateRoot, metersToInches)["ring-finger-phalanx-intermediate"][2])
      .toBeCloseTo(edited["ring-finger-phalanx-intermediate"][2], 6);
    transaction.undo();
    expectCentersClose(readTesting2RigJointCenters(rig.mesh, rig.coordinateRoot, metersToInches), source);
  });

  it("rolls back the whole rig if a rebind fails after several joint positions move", () => {
    const source = readRealRig(leftGlbUrl).centers;
    const rig = makeSyntheticRig(source);
    const positionsBefore = rig.mesh.skeleton.bones.map((bone) => bone.position.clone());
    const inversesBefore = rig.mesh.skeleton.boneInverses.map((matrix) => matrix.clone());
    const geometryBefore = snapshotGeometry(rig.mesh);
    const surfaceBefore = getNeutralSurface(rig.mesh);
    const edited = cloneCenters(source);
    edited["middle-finger-phalanx-proximal"][2] += 0.001;
    let invertCount = 0;
    const originalInvert = THREE.Matrix4.prototype.invert;
    const spy = vi.spyOn(THREE.Matrix4.prototype, "invert").mockImplementation(function (this: THREE.Matrix4) {
      invertCount++;
      if (invertCount === 18) throw new Error("synthetic inverse-bind failure");
      return originalInvert.call(this);
    });
    try {
      expect(() => createTesting2RigEditTransaction(rig.mesh, rig.coordinateRoot, edited)).toThrow(
        "synthetic inverse-bind failure",
      );
    } finally {
      spy.mockRestore();
    }

    expect(invertCount).toBeGreaterThanOrEqual(18);
    expect(rig.mesh.skeleton.bones.map((bone) => bone.position)).toEqual(positionsBefore);
    expect(rig.mesh.skeleton.boneInverses).toEqual(inversesBefore);
    expect(snapshotGeometry(rig.mesh)).toEqual(geometryBefore);
    expectSurfaceEqual(getNeutralSurface(rig.mesh), surfaceBefore);
  });

  it("refuses to overwrite a rig changed outside its transaction", () => {
    const source = readRealRig(leftGlbUrl).centers;
    const rig = makeSyntheticRig(source);
    const edited = cloneCenters(source);
    edited["thumb-phalanx-proximal"][0] += 0.001;
    const transaction = createTesting2RigEditTransaction(rig.mesh, rig.coordinateRoot, edited);
    rig.mesh.skeleton.bones[0]!.position.x += 0.01;
    expect(() => transaction.undo()).toThrow(/changed outside/i);
  });
});
