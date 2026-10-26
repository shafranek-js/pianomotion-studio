import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { MotionPose } from "@handthesia/contracts";
import { DEFAULT_SKIN_SETTINGS } from "../render/skins";
import {
  buildImprovedHandGlbRig,
  Hand3DMeshGroup,
  KEYBOARD_WIDTH_IN,
  posePointToWorld,
  type HandModelRuntimeDependencies,
} from "./handRigBuilder";
import {
  IMPROVED_HAND_JOINT_NAMES,
  type ImprovedHandAsset,
  type ImprovedHandBoneFrame,
  type ImprovedHandLodManifest,
  type ImprovedHandManifest,
  type ImprovedHandTextureLease,
} from "./improvedHandAssets";
import { IMPROVED_HAND_MODEL_ID } from "./improvedHandRuntime";

const baseTextureSet = {
  baseColor: "textures/base.png",
  normal: "textures/normal.png",
  roughness: "textures/roughness.png",
  flipY: false as const,
  baseColorColorSpace: "srgb" as const,
  normalColorSpace: "linear" as const,
  roughnessColorSpace: "linear" as const,
};

const positionsByJoint = new Map<string, [number, number, number]>();
positionsByJoint.set("wrist", [0, 0, 0]);
for (const [prefix, x] of [
  ["pinky-finger", -0.04],
  ["ring-finger", -0.02],
  ["middle-finger", 0],
  ["index-finger", 0.02],
  ["thumb", 0.05],
] as const) {
  const names = prefix === "thumb"
    ? ["metacarpal", "phalanx-proximal", "phalanx-distal", "tip"]
    : ["metacarpal", "phalanx-proximal", "phalanx-intermediate", "phalanx-distal", "tip"];
  names.forEach((part, index) => {
    const name = part === "metacarpal" ? `${prefix}-metacarpal`
      : part === "tip" ? `${prefix}-tip`
        : `${prefix}-${part}`;
    positionsByJoint.set(name, [x, 0, -0.03 - index * 0.025]);
  });
}

function getFixturePositions(hand: "left" | "right"): Map<string, [number, number, number]> {
  return new Map([...positionsByJoint].map(([name, [x, y, z]]) => [
    name,
    hand === "right" ? [-x, y, z] : [x, y, z],
  ]));
}

interface GlbFixtureOptions {
  hand?: "left" | "right";
  wristQuaternion?: THREE.Quaternion;
  jointQuaternions?: ReadonlyMap<string, THREE.Quaternion>;
  nativePositions?: Map<string, [number, number, number]>;
  staleWristInverseBind?: boolean;
}

function makeGlb(options: GlbFixtureOptions = {}): ArrayBuffer {
  const bytes: Uint8Array[] = [];
  const bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }> = [];
  const accessors: Array<Record<string, unknown>> = [];
  let byteLength = 0;
  const addAccessor = (
    typed: Float32Array | Int16Array | Uint16Array | Uint8Array,
    componentType: number,
    count: number,
    type: string,
    normalized = false,
    byteStride?: number,
  ): number => {
    const paddedOffset = (byteLength + 3) & ~3;
    if (paddedOffset !== byteLength) {
      bytes.push(new Uint8Array(paddedOffset - byteLength));
      byteLength = paddedOffset;
    }
    const data = new Uint8Array(typed.buffer.slice(typed.byteOffset, typed.byteOffset + typed.byteLength));
    bufferViews.push({
      buffer: 0,
      byteOffset: byteLength,
      byteLength: data.byteLength,
      ...(byteStride !== undefined ? { byteStride } : {}),
    });
    bytes.push(data);
    byteLength += data.byteLength;
    const accessorIndex = accessors.length;
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType,
      count,
      type,
      ...(normalized ? { normalized: true } : {}),
    });
    return accessorIndex;
  };

  const jointNames = [...IMPROVED_HAND_JOINT_NAMES];
  const positionAccessor = addAccessor(
    new Float32Array([0.006, 0, 0, -0.003, 0.0052, 0, -0.003, -0.0052, 0]),
    5126, 3, "VEC3",
  );
  const normalAccessor = addAccessor(
    new Int16Array([0, 0, 32767, 0, 0, 0, 32767, 0, 0, 0, 32767, 0]),
    5122, 3, "VEC3", true, 8,
  );
  const uvAccessor = addAccessor(new Uint16Array([0, 0, 65535, 0, 0, 65535]), 5123, 3, "VEC2", true);
  const tangentAccessor = addAccessor(
    new Int16Array([32767, 0, 0, 32767, 32767, 0, 0, 32767, 32767, 0, 0, 32767]),
    5122, 3, "VEC4", true,
  );
  const jointValues = new Uint8Array(3 * 4);
  for (let vertex = 0; vertex < 3; vertex++) jointValues[vertex * 4] = 24;
  const jointAccessor = addAccessor(jointValues, 5121, 3, "VEC4");
  const weightValues = new Uint8Array(3 * 4);
  for (let vertex = 0; vertex < 3; vertex++) weightValues[vertex * 4] = 255;
  const weightAccessor = addAccessor(weightValues, 5121, 3, "VEC4", true);
  const indexAccessor = addAccessor(new Uint8Array([0, 1, 2]), 5121, 3, "SCALAR");

  const nativePositions = options.nativePositions ?? getFixturePositions(options.hand ?? "left");
  const inverseBind = new Float32Array(jointNames.length * 16);
  const nodes: Array<{ name: string; translation?: number[]; rotation?: number[]; mesh?: number }> = jointNames.map((name, index) => {
    const [x, y, z] = nativePositions.get(name)!;
    const rotation = name === "wrist"
      ? options.wristQuaternion ?? new THREE.Quaternion()
      : options.jointQuaternions?.get(name) ?? new THREE.Quaternion();
    const inverseBindRotation = name === "wrist" && options.staleWristInverseBind
      ? new THREE.Quaternion()
      : rotation;
    const matrixOffset = index * 16;
    const inverse = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      inverseBindRotation,
      new THREE.Vector3(1, 1, 1),
    ).invert();
    inverse.toArray(inverseBind, matrixOffset);
    return { name, translation: [x, y, z], rotation: rotation.toArray() };
  });
  const inverseBindAccessor = addAccessor(inverseBind, 5126, jointNames.length, "MAT4");
  nodes.push({ name: "hand-mesh", mesh: 0, translation: [0, 0, 0] });

  const binaryLength = byteLength;
  const binaryPaddedLength = (binaryLength + 3) & ~3;
  const binary = new Uint8Array(binaryPaddedLength);
  let cursor = 0;
  for (const part of bytes) {
    binary.set(part, cursor);
    cursor += part.byteLength;
  }
  const json = {
    asset: { version: "2.0" },
    extensionsUsed: ["KHR_mesh_quantization"],
    extensionsRequired: ["KHR_mesh_quantization"],
    buffers: [{ byteLength: binaryLength }],
    bufferViews,
    accessors,
    meshes: [{ primitives: [{
      attributes: {
        POSITION: positionAccessor,
        NORMAL: normalAccessor,
        TEXCOORD_0: uvAccessor,
        TANGENT: tangentAccessor,
        JOINTS_0: jointAccessor,
        WEIGHTS_0: weightAccessor,
      },
      indices: indexAccessor,
    }] }],
    nodes,
    skins: [{ joints: jointNames.map((_, index) => index), inverseBindMatrices: inverseBindAccessor }],
    scenes: [{ nodes: nodes.map((_, index) => index) }],
    scene: 0,
  };
  const rawJson = new TextEncoder().encode(JSON.stringify(json));
  const jsonPaddedLength = (rawJson.byteLength + 3) & ~3;
  const totalLength = 12 + 8 + jsonPaddedLength + 8 + binaryPaddedLength;
  const glb = new ArrayBuffer(totalLength);
  const view = new DataView(glb);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonPaddedLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(glb, 20, jsonPaddedLength).fill(0x20);
  new Uint8Array(glb, 20, rawJson.byteLength).set(rawJson);
  const binaryHeader = 20 + jsonPaddedLength;
  view.setUint32(binaryHeader, binaryPaddedLength, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  new Uint8Array(glb, binaryHeader + 8).set(binary);
  return glb;
}

function makeLod(level: 0 | 1 | 2): ImprovedHandLodManifest {
  return {
    level,
    url: `left-lod${level}.glb`,
    triangles: 1,
    vertices: 3,
    textureSet: level === 2 ? "low" : "high",
    boundaryVertices: [0, 1, 2],
    boundaryLoops: [[0, 1, 2]],
  };
}

function makeAsset(buffer = makeGlb()): ImprovedHandAsset {
  const lods = [makeLod(0), makeLod(1), makeLod(2)];
  const manifest: ImprovedHandManifest = {
    schemaVersion: 1,
    modelId: "anatomical-improved",
    source: { uri: "hand_standard.glb", sha256: "b".repeat(64), vertices: 3, triangles: 1 },
    coordinateFrame: { unit: "meters", handedness: "right", boneForwardAxis: "-Z", normalTextureFlipY: false },
    jointNames: [...IMPROVED_HAND_JOINT_NAMES],
    extras: {
      restDorsalAxis: [0, 1, 0],
      boneFrames: {
        left: Object.fromEntries(IMPROVED_HAND_JOINT_NAMES.map((name) => [name, {
          forward: [0, 0, -1], dorsal: [0, 1, 0], hinge: [1, 0, 0],
        }])),
        right: Object.fromEntries(IMPROVED_HAND_JOINT_NAMES.map((name) => [name, {
          forward: [0, 0, -1], dorsal: [0, 1, 0], hinge: [1, 0, 0],
        }])),
      },
    },
    textures: { high: { ...baseTextureSet }, low: { ...baseTextureSet, baseColor: "textures/low.png" } },
    hands: { left: { lods }, right: { lods: lods.map((lod) => ({ ...lod, url: lod.url.replace("left", "right") })) } },
  };
  return {
    manifest,
    manifestUrl: new URL("https://assets.example.test/models/hands/improved/manifest.json"),
    hand: "left",
    lod: lods[0]!,
    buffer,
    textureSet: manifest.textures.high,
  };
}

function vectorTuple(value: THREE.Vector3): [number, number, number] {
  return [value.x, value.y, value.z];
}

function frameFromQuaternion(quaternion: THREE.Quaternion): ImprovedHandBoneFrame {
  return {
    forward: vectorTuple(new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion).normalize()),
    dorsal: vectorTuple(new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize()),
    hinge: vectorTuple(new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).normalize()),
  };
}

function getPalmFixturePositions(hand: "left" | "right"): Map<string, [number, number, number]> {
  const positions = getFixturePositions(hand);
  // The metacarpal roots form a flat transverse line in this fixture. Put the
  // true MCP knuckles on a slightly oblique palm plane so using CMC roots by
  // mistake produces a visibly different wrist basis.
  for (const part of ["phalanx-proximal", "phalanx-intermediate", "phalanx-distal", "tip"]) {
    positions.get(`index-finger-${part}`)![1] = 0.015;
    positions.get(`pinky-finger-${part}`)![1] = -0.01;
  }
  return positions;
}

function getPalmFixtureMetacarpalQuaternions(
  positions: ReadonlyMap<string, [number, number, number]>,
): Map<string, THREE.Quaternion> {
  const result = new Map<string, THREE.Quaternion>();
  for (const name of ["index-finger-metacarpal", "pinky-finger-metacarpal"]) {
    const prefix = name.startsWith("index") ? "index-finger" : "pinky-finger";
    const start = new THREE.Vector3(...positions.get(name)!);
    const end = new THREE.Vector3(...positions.get(`${prefix}-phalanx-proximal`)!);
    const direction = end.sub(start).normalize();
    result.set(name, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction));
  }
  return result;
}

function deriveFixturePalmFrame(hand: "left" | "right"): {
  frame: ImprovedHandBoneFrame;
  quaternion: THREE.Quaternion;
} {
  const positions = getPalmFixturePositions(hand);
  const wrist = new THREE.Vector3(...positions.get("wrist")!);
  const index = new THREE.Vector3(...positions.get("index-finger-phalanx-proximal")!);
  const pinky = new THREE.Vector3(...positions.get("pinky-finger-phalanx-proximal")!);
  const dorsal = new THREE.Vector3().crossVectors(index.sub(wrist), pinky.sub(wrist)).normalize();
  const restDorsal = new THREE.Vector3(0, 1, 0);
  if (hand === "right") restDorsal.x *= -1;
  if (dorsal.dot(restDorsal) < 0) dorsal.negate();
  const meanMcp = new THREE.Vector3();
  for (const name of [
    "index-finger-phalanx-proximal",
    "middle-finger-phalanx-proximal",
    "ring-finger-phalanx-proximal",
    "pinky-finger-phalanx-proximal",
  ]) meanMcp.add(new THREE.Vector3(...positions.get(name)!));
  meanMcp.multiplyScalar(0.25);
  const forward = meanMcp.sub(wrist);
  forward.addScaledVector(dorsal, -forward.dot(dorsal)).normalize();
  const wristZ = forward.clone().negate();
  const hinge = new THREE.Vector3().crossVectors(dorsal, wristZ).normalize();
  const orientedDorsal = new THREE.Vector3().crossVectors(wristZ, hinge).normalize();
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(hinge, orientedDorsal, wristZ),
  ).normalize();
  return { frame: { forward: vectorTuple(forward), dorsal: vectorTuple(dorsal), hinge: vectorTuple(hinge) }, quaternion };
}

interface PalmFrameFixtureOptions {
  wristQuaternion?: THREE.Quaternion;
  manifestWristFrame?: ImprovedHandBoneFrame;
  fingerQuaternion?: THREE.Quaternion;
  staleWristInverseBind?: boolean;
}

function makePalmFrameAsset(
  hand: "left" | "right",
  level: 0 | 1 | 2,
  options: PalmFrameFixtureOptions = {},
): ImprovedHandAsset {
  const derived = deriveFixturePalmFrame(hand);
  const wristQuaternion = options.wristQuaternion ?? derived.quaternion;
  const indexMcpQuaternion = options.fingerQuaternion;
  const palmPositions = getPalmFixturePositions(hand);
  const jointQuaternions = getPalmFixtureMetacarpalQuaternions(palmPositions);
  if (indexMcpQuaternion) jointQuaternions.set("index-finger-metacarpal", indexMcpQuaternion);
  const asset = makeAsset(makeGlb({
    hand,
    wristQuaternion,
    jointQuaternions,
    nativePositions: palmPositions,
    staleWristInverseBind: options.staleWristInverseBind,
  }));
  asset.manifest.extras.wristFrameProfile = "palm-mcp-v1";
  for (const side of ["left", "right"] as const) {
    const sideFrame = deriveFixturePalmFrame(side).frame;
    asset.manifest.extras.boneFrames[side].wrist = side === hand
      ? options.manifestWristFrame ?? frameFromQuaternion(wristQuaternion)
      : sideFrame;
    for (const name of ["index-finger-metacarpal", "pinky-finger-metacarpal"]) {
      const sidePositions = getPalmFixturePositions(side);
      const sideQuaternions = getPalmFixtureMetacarpalQuaternions(sidePositions);
      const quaternion = side === hand && name === "index-finger-metacarpal" && indexMcpQuaternion
        ? indexMcpQuaternion
        : sideQuaternions.get(name)!;
      asset.manifest.extras.boneFrames[side][name] = frameFromQuaternion(quaternion);
    }
  }
  if (indexMcpQuaternion) {
    asset.manifest.extras.boneFrames[hand]["index-finger-metacarpal"] = frameFromQuaternion(indexMcpQuaternion);
  }
  asset.hand = hand;
  asset.lod = asset.manifest.hands[hand].lods[level]!;
  asset.textureSet = asset.manifest.textures[asset.lod.textureSet];
  return asset;
}

function makeDependencies(
  load: () => Promise<ImprovedHandAsset>,
  released: () => void = () => undefined,
): HandModelRuntimeDependencies {
  const lease: ImprovedHandTextureLease = {
    baseColor: new THREE.Texture(),
    normal: new THREE.Texture(),
    roughness: new THREE.Texture(),
    release: () => released(),
  };
  return {
    assetLoader: {
      load: load as HandModelRuntimeDependencies["assetLoader"]["load"],
      getCacheStats: () => ({ count: 1, retainedGlbBytes: 256 }),
    },
    textureCache: {
      acquire: async () => lease,
      getCacheStats: () => ({ count: 3, estimatedBaseBytes: 32 * 32 * 4 * 3 }),
    },
  };
}

function createMotionPose(bendIndexProximal = false): MotionPose {
  const bones: MotionPose["bones"] = [
    { a: [25.5, 0, 0.9], b: [25.5, -5, 1.2], kind: "forearm" },
    { a: [27, 0, 0.9], b: [27, -5, 1.2], kind: "forearm" },
  ];
  const joints: MotionPose["joints"] = [
    { point: [24, 0, 0.9], kind: "wrist" },
    { point: [27, 0, 0.9], kind: "wrist" },
  ];
  const points: Record<number, Array<[number, number, number]>> = {
    2: [[25.5, 1, 0.9], [25.5, 2, 0.8], [25.5, 3, 0.6], [25.5, 3.8, 0.3], [25.5, 4.4, 0.05]],
    3: [[26, 1, 0.9], [26, 2, 0.8], [26, 3, 0.6], [26, 3.8, 0.3], [26, 4.4, 0.05]],
    4: [[26.5, 1, 0.9], [26.5, 2, 0.8], [26.5, 3, 0.6], [26.5, 3.8, 0.3], [26.5, 4.4, 0.05]],
    5: [[27, 1, 0.9], [27, 2, 0.8], [27, 3, 0.6], [27, 3.8, 0.3], [27, 4.4, 0.05]],
    1: [[25, 0.8, 0.8], [24.7, 1.3, 0.65], [24.5, 1.8, 0.35], [24.3, 2.1, 0.05]],
  };
  if (bendIndexProximal) {
    const index = points[2]!;
    const oldPip = index[2]!;
    const mcp = index[1]!;
    const radians = Math.PI / 3;
    const rotatedY = Math.cos(radians) + 0.2 * Math.sin(radians);
    const rotatedZ = Math.sin(radians) - 0.2 * Math.cos(radians);
    const delta: [number, number, number] = [0, rotatedY - 1, rotatedZ + 0.2];
    index[2] = [mcp[0] + delta[0], mcp[1] + rotatedY, mcp[2] + rotatedZ];
    index[3] = [index[3]![0] + delta[0], index[3]![1] + delta[1], index[3]![2] + delta[2]];
    index[4] = [index[4]![0] + delta[0], index[4]![1] + delta[1], index[4]![2] + delta[2]];
    void oldPip;
  }
  for (const finger of [2, 3, 4, 5, 1]) {
    const chain = points[finger]!;
    if (finger === 1) {
      bones.push(
        { a: chain[0]!, b: chain[1]!, kind: "metacarpal" },
        { a: chain[1]!, b: chain[2]!, kind: "proximal" },
        { a: chain[2]!, b: chain[3]!, kind: "distal" },
      );
    } else {
      bones.push(
        { a: chain[0]!, b: chain[1]!, kind: "metacarpal" },
        { a: chain[1]!, b: chain[2]!, kind: "proximal" },
        { a: chain[2]!, b: chain[3]!, kind: "middle" },
        { a: chain[3]!, b: chain[4]!, kind: "distal" },
      );
    }
    joints.push({ point: chain[chain.length - 1]!, kind: "tip" });
  }
  return { hand: "right", transportTimeSeconds: 0, layerOrder: 0, bones, joints };
}

function createPoseWithMeasuredThumbChain(
  hand: "left" | "right",
  worldChain: readonly (readonly [number, number, number])[],
): MotionPose {
  const pose = createMotionPose();
  const toPosePoint = (point: readonly [number, number, number]): [number, number, number] => [
    point[0] + KEYBOARD_WIDTH_IN * 0.5,
    -point[2],
    point[1],
  ];
  const thumbPoints = worldChain.map(toPosePoint);
  let metacarpalIndex = 0;
  let proximalIndex = 0;
  let distalIndex = 0;
  const bones = pose.bones.map((bone) => {
    if (bone.kind === "metacarpal" && metacarpalIndex++ === 4) {
      return { ...bone, a: thumbPoints[0]!, b: thumbPoints[1]! };
    }
    if (bone.kind === "proximal" && proximalIndex++ === 4) {
      return { ...bone, a: thumbPoints[1]!, b: thumbPoints[2]! };
    }
    if (bone.kind === "distal" && distalIndex++ === 4) {
      return { ...bone, a: thumbPoints[2]!, b: thumbPoints[3]! };
    }
    return bone;
  });
  let tipIndex = 0;
  const tips = pose.joints.map((joint) =>
    joint.kind === "tip" && tipIndex++ === 4 ? { ...joint, point: thumbPoints[3]! } : joint);
  return { ...pose, hand, bones, joints: tips };
}

function getFixtureNativeRootInWrist(boneName: string): THREE.Vector3 {
  return new THREE.Vector3(...positionsByJoint.get(boneName)!)
    .sub(new THREE.Vector3(...positionsByJoint.get("wrist")!))
    .multiplyScalar(39.37007874);
}

function getFixtureNativeRootWorld(group: Hand3DMeshGroup, boneName: string): THREE.Vector3 {
  group.group.updateMatrixWorld(true);
  const wrist = group.getBone("wrist")!;
  return wrist.localToWorld(getFixtureNativeRootInWrist(boneName));
}

describe("improved anatomical hand integration", () => {
  it("decodes packed attributes, preserves the normal-map tangent basis, and validates bind matrices", () => {
    const parent = new THREE.Group();
    const material = new THREE.MeshPhysicalMaterial();
    const rig = buildImprovedHandGlbRig(
      "left", material, parent, makeGlb(), makeLod(0), IMPROVED_HAND_JOINT_NAMES, makeAsset().manifest.extras,
    );
    parent.updateMatrixWorld(true);
    rig.skinnedMesh.skeleton.update();

    expect(rig.skinnedMesh.skeleton.bones.map((bone) => bone.name)).toEqual([...IMPROVED_HAND_JOINT_NAMES]);
    expect(rig.skinnedMesh.geometry.getAttribute("tangent").count).toBe(3);
    expect(rig.skinnedMesh.geometry.getAttribute("tangent").getX(0)).toBeCloseTo(1, 4);
    expect(rig.skinnedMesh.geometry.getAttribute("uv").getX(1)).toBeCloseTo(1, 4);
    expect(rig.skinnedMesh.geometry.getAttribute("skinWeight").getX(0)).toBeCloseTo(1, 4);
    expect(rig.skinnedMesh.geometry.getAttribute("color")).toBeUndefined();
    rig.skinnedMesh.skeleton.bones.forEach((bone, index) => {
      const actual = new THREE.Matrix4().multiplyMatrices(
        bone.matrixWorld,
        rig.skinnedMesh.skeleton.boneInverses[index]!,
      );
      const identity = new THREE.Matrix4();
      actual.elements.forEach((component, element) => expect(component).toBeCloseTo(identity.elements[element]!, 4));
    });
    const rest = new THREE.Vector3().fromBufferAttribute(rig.skinnedMesh.geometry.getAttribute("position"), 0);
    const deformedRest = rig.skinnedMesh.applyBoneTransform(0, rest.clone());
    expect(deformedRest.distanceTo(rest)).toBeLessThan(1e-4);

    rig.skinnedMesh.geometry.dispose();
    rig.skinnedMesh.skeleton.dispose();
    material.dispose();
  });

  it("validates the MCP-derived wrist palm basis and inverse bind for both hands at every LOD", () => {
    for (const hand of ["left", "right"] as const) {
      for (const level of [0, 1, 2] as const) {
        const asset = makePalmFrameAsset(hand, level);
        const parent = new THREE.Group();
        const material = new THREE.MeshPhysicalMaterial();
        const rig = buildImprovedHandGlbRig(
          hand,
          material,
          parent,
          asset.buffer,
          asset.lod,
          IMPROVED_HAND_JOINT_NAMES,
          asset.manifest.extras,
        );
        parent.updateMatrixWorld(true);
        rig.skinnedMesh.skeleton.update();

        const wristIndex = rig.skinnedMesh.skeleton.bones.findIndex((bone) => bone.name === "wrist");
        const wristInverse = new THREE.Matrix4().multiplyMatrices(
          rig.skinnedMesh.skeleton.bones[wristIndex]!.matrixWorld,
          rig.skinnedMesh.skeleton.boneInverses[wristIndex]!,
        );
        const identity = new THREE.Matrix4();
        wristInverse.elements.forEach((component, index) =>
          expect(Math.abs(component - identity.elements[index]!)).toBeLessThan(1e-4));

        const actualFrame = frameFromQuaternion(rig.bonesByName.get("wrist")!.bindQuaternion);
        const expectedFrame = deriveFixturePalmFrame(hand).frame;
        for (const axis of ["forward", "dorsal", "hinge"] as const) {
          expect(new THREE.Vector3(...actualFrame[axis]).dot(new THREE.Vector3(...expectedFrame[axis])))
            .toBeGreaterThan(0.9999);
        }

        rig.skinnedMesh.geometry.dispose();
        rig.skinnedMesh.skeleton.dispose();
        material.dispose();
      }
    }
  });

  it("rejects rotated, stale-manifest, stale-IBM, and unprofiled palm wrist frames without weakening finger axes", () => {
    const cases: Array<{ asset: ImprovedHandAsset; error: RegExp }> = [];
    const arbitraryWrist = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 5);
    cases.push({ asset: makePalmFrameAsset("left", 0, { wristQuaternion: arbitraryWrist }), error: /native MCP palm frame/i });
    cases.push({
      asset: makePalmFrameAsset("right", 1, {
        manifestWristFrame: { forward: [0, 0, -1], dorsal: [0, 1, 0], hinge: [1, 0, 0] },
      }),
      error: /bind frame|native MCP palm frame/i,
    });
    cases.push({ asset: makePalmFrameAsset("left", 2, { staleWristInverseBind: true }), error: /wrist inverse-bind matrix/i });

    const unprofiled = makePalmFrameAsset("left", 0);
    delete unprofiled.manifest.extras.wristFrameProfile;
    cases.push({ asset: unprofiled, error: /calibrated -Z bone axis/i });

    const bentFinger = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 4);
    cases.push({ asset: makePalmFrameAsset("right", 2, { fingerQuaternion: bentFinger }), error: /calibrated -Z bone axis/i });

    for (const { asset, error } of cases) {
      const parent = new THREE.Group();
      const material = new THREE.MeshPhysicalMaterial();
      expect(() => buildImprovedHandGlbRig(
        asset.hand,
        material,
        parent,
        asset.buffer,
        asset.lod,
        IMPROVED_HAND_JOINT_NAMES,
        asset.manifest.extras,
      )).toThrow(error);
      expect(parent.children).toHaveLength(0);
      material.dispose();
    }
  });

  it("rejects GLB joint frames that disagree with independently derived dorsal metadata", () => {
    const parent = new THREE.Group();
    const material = new THREE.MeshPhysicalMaterial();
    const asset = makeAsset();
    const badFrames = structuredClone(asset.manifest.extras);
    badFrames.boneFrames.left["middle-finger-phalanx-proximal"]!.dorsal = [0, 0, 1];

    expect(() => buildImprovedHandGlbRig(
      "left", material, parent, asset.buffer, asset.lod, IMPROVED_HAND_JOINT_NAMES, badFrames,
    )).toThrow(/bind frame|dorsal anatomical frame/i);
    expect(parent.children).toHaveLength(0);
    material.dispose();
  });

  it("loads only after a current async request, reports actual model/LOD, hides duplicate nails, and keeps bone axes stable under bend and hover", async () => {
    const leaseRelease = vi.fn();
    const group = new Hand3DMeshGroup("right", "anatomical", makeDependencies(async () => makeAsset(), () => leaseRelease()));
    group.setHandModel(IMPROVED_HAND_MODEL_ID, 0);
    await group.waitForHandModelReady();

    const ready = group.getHandModelDiagnostics();
    expect(ready).toMatchObject({ requestedModel: IMPROVED_HAND_MODEL_ID, loadedModel: IMPROVED_HAND_MODEL_ID, requestedLod: 0, loadedLod: 0, state: "ready", error: null, triangles: 1 });
    expect(group.wristBoundaryVertexCount).toBe(3);
    expect(group.fingernails.every((nail) => !nail.visible)).toBe(true);

    const pose = createMotionPose();
    group.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false, 0);
    const proximal = group.getBone("index-finger-phalanx-proximal")!;
    const originalScale = proximal.scale.z;
    const originalQuaternion = proximal.quaternion.clone();
    const originalPosition = proximal.position.clone();
    const bentPose = createMotionPose(true);
    group.updateFromPose(bentPose, DEFAULT_SKIN_SETTINGS, false, 0);
    const bent = group.getBone("index-finger-phalanx-proximal")!;
    expect(Math.abs(originalQuaternion.dot(bent.quaternion))).toBeLessThan(0.99);
    expect(bent.scale.z).toBeCloseTo(originalScale, 3);
    expect(bent.position.distanceTo(originalPosition)).toBeLessThan(1e-4);

    const expectedStart = posePointToWorld([25.5, 2, 0.8]);
    const expectedEnd = posePointToWorld([25.5, 2.673205, 1.566025]);
    const expectedLength = expectedStart.distanceTo(expectedEnd);
    const expectedAxis = expectedEnd.sub(expectedStart).normalize();
    const actualAxis = new THREE.Vector3(0, 0, -1).applyQuaternion(bent.getWorldQuaternion(new THREE.Quaternion()));
    expect(actualAxis.dot(expectedAxis)).toBeGreaterThan(0.995);
    const expectedMidpoint = posePointToWorld([25.5, 2, 0.8])
      .lerp(posePointToWorld([25.5, 2.673205, 1.566025]), 0.5);
    const actualMidpoint = bent.getWorldPosition(new THREE.Vector3())
      .addScaledVector(actualAxis, expectedLength * 0.5);
    expect(actualMidpoint.distanceTo(expectedMidpoint)).toBeLessThan(1e-4);

    group.updateFromPose(bentPose, DEFAULT_SKIN_SETTINGS, false, 1);
    expect(group.getBone("index-finger-phalanx-proximal")!.scale.z).toBeCloseTo(originalScale, 3);
    expect(group.getHandModelDiagnostics().loadedModel).toBe(IMPROVED_HAND_MODEL_ID);
    group.dispose();
    expect(leaseRelease).toHaveBeenCalledTimes(1);
  });

  it("reaches the measured .75-second thumb anchors without clamping or pose-history calibration", async () => {
    const group = new Hand3DMeshGroup("right", "anatomical", makeDependencies(async () => makeAsset()));
    group.setHandModel(IMPROVED_HAND_MODEL_ID, 0);
    await group.waitForHandModelReady();

    const measuredChains: Record<"left" | "right", readonly (readonly [number, number, number])[]> = {
      left: [
        [-4.224711712857143, 0.7998464, 3.92897725],
        [-3.214798922857142, 0.81270316, 2.22622829],
        [-2.695695392857143, 0.66821625, 0.94487162],
        [-2.4045112428571436, 0.4380742, -0.17463843],
      ],
      right: [
        [3.594878497142858, 0.7998464, 3.96087122],
        [2.7024690371428584, 0.81957025, 2.19376638],
        [2.369820147142857, 0.63293438, 0.85707958],
        [2.315896457142859, 0.33828214, -0.28367834],
      ],
    };
    const bindLengthIn = 0.025 * 39.37007874;

    for (const hand of ["left", "right"] as const) {
      const chain = measuredChains[hand];
      const pose = createPoseWithMeasuredThumbChain(hand, chain);
      const assertThumbEndpoints = (hoverLift: number): void => {
        group.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false, hoverLift);
        group.group.updateMatrixWorld(true);
        for (let segment = 0; segment < 3; segment++) {
          const boneName = [
            "thumb-metacarpal",
            "thumb-phalanx-proximal",
            "thumb-phalanx-distal",
          ][segment]!;
          const bone = group.getBone(boneName)!;
          const start = segment === 0
            ? getFixtureNativeRootWorld(group, "thumb-metacarpal")
            : new THREE.Vector3(...chain[segment]!);
          const end = new THREE.Vector3(...chain[segment + 1]!);
          const hoverOffset = hoverLift > 0 ? 0.22 * Math.min(1, hoverLift) : 0;
          if (segment > 0) start.y += hoverOffset;
          end.y += hoverOffset;
          const targetLength = start.distanceTo(end);
          const actualStart = bone.getWorldPosition(new THREE.Vector3());
          const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
            bone.getWorldQuaternion(new THREE.Quaternion()),
          );
          const actualEnd = actualStart.clone().addScaledVector(forward, bone.scale.z * bindLengthIn);

          expect(actualStart.distanceTo(start), `${hand} thumb segment ${segment} start ${actualStart.toArray()} != ${start.toArray()}`).toBeLessThan(1e-4);
          expect(actualEnd.distanceTo(end)).toBeLessThan(1e-4);
          expect(bone.scale.z).toBeCloseTo(targetLength / bindLengthIn, 5);
        }
      };

      assertThumbEndpoints(0);
      assertThumbEndpoints(1);
      assertThumbEndpoints(0);

      const longerChain = chain.map((point, index) => index === 3
        ? [point[0], point[1], point[2] - 0.4] as const
        : point);
      const longerPose = createPoseWithMeasuredThumbChain(hand, longerChain);
      group.updateFromPose(longerPose, DEFAULT_SKIN_SETTINGS, false, 0);
      const distal = group.getBone("thumb-phalanx-distal")!;
      const longerTargetLength = new THREE.Vector3(...longerChain[2]!).distanceTo(new THREE.Vector3(...longerChain[3]!));
      expect(distal.scale.z * bindLengthIn).toBeCloseTo(longerTargetLength, 4);
      assertThumbEndpoints(0);

      const shortChain = chain.map((point, index) => index === 2
        ? [chain[1]![0] + 0.05, chain[1]![1], chain[1]![2]] as const
        : point);
      group.updateFromPose(createPoseWithMeasuredThumbChain(hand, shortChain), DEFAULT_SKIN_SETTINGS, false, 0);
      group.group.updateMatrixWorld(true);
      const shortProximal = group.getBone("thumb-phalanx-proximal")!;
      const shortStart = new THREE.Vector3(...shortChain[1]!);
      const shortEnd = new THREE.Vector3(...shortChain[2]!);
      const shortForward = new THREE.Vector3(0, 0, -1).applyQuaternion(
        shortProximal.getWorldQuaternion(new THREE.Quaternion()),
      );
      expect(shortProximal.scale.z * bindLengthIn).toBeCloseTo(0.05, 5);
      expect(shortForward.dot(shortEnd.clone().sub(shortStart).normalize())).toBeGreaterThan(0.9999);
      expect(shortProximal.quaternion.toArray().every(Number.isFinite)).toBe(true);

      const zeroChain = shortChain.map((point, index) => index === 2 ? shortChain[1]! : point);
      group.updateFromPose(createPoseWithMeasuredThumbChain(hand, zeroChain), DEFAULT_SKIN_SETTINGS, false, 0);
      const zeroProximal = group.getBone("thumb-phalanx-proximal")!;
      expect(zeroProximal.scale.z).toBe(0);
      expect(zeroProximal.quaternion.toArray().every(Number.isFinite)).toBe(true);
    }

    group.dispose();
  });

  it("rejects readiness on asset failure and keeps the current fallback explicitly reported", async () => {
    let attempt = 0;
    const load = vi.fn(async () => {
      attempt++;
      throw new Error(`fixture asset missing ${attempt}`);
    });
    const group = new Hand3DMeshGroup("left", "anatomical", makeDependencies(load));
    group.setHandModel(IMPROVED_HAND_MODEL_ID, 0);

    await expect(group.waitForHandModelReady()).rejects.toThrow("fixture asset missing 1");
    expect(group.getHandModelDiagnostics()).toMatchObject({
      requestedModel: IMPROVED_HAND_MODEL_ID,
      loadedModel: "anatomical",
      state: "error",
      error: "fixture asset missing 1",
    });
    await expect(group.waitForHandModelReady()).rejects.toThrow("fixture asset missing 1");
    group.setHandModel(IMPROVED_HAND_MODEL_ID, 2);
    group.setHandModel(IMPROVED_HAND_MODEL_ID, 0);
    expect(load).toHaveBeenCalledTimes(1);

    group.setHandModel("anatomical");
    group.setHandModel(IMPROVED_HAND_MODEL_ID, 0);
    await expect(group.waitForHandModelReady()).rejects.toThrow("fixture asset missing 2");
    expect(load).toHaveBeenCalledTimes(2);
    group.retryHandModelLoad();
    await expect(group.waitForHandModelReady()).rejects.toThrow("fixture asset missing 3");
    expect(load).toHaveBeenCalledTimes(3);
    group.dispose();
  });

  it("rejects waiters and ignores late completions after model switch or disposal", async () => {
    let finish: ((asset: ImprovedHandAsset) => void) | undefined;
    const delayedAsset = new Promise<ImprovedHandAsset>((resolve) => { finish = resolve; });
    const group = new Hand3DMeshGroup("left", "anatomical", makeDependencies(() => delayedAsset));
    group.setHandModel(IMPROVED_HAND_MODEL_ID, 0);
    const ready = group.waitForHandModelReady();
    const rejected = expect(ready).rejects.toThrow(/superseded/i);
    group.setHandModel("anatomical");
    await rejected;
    finish!(makeAsset());
    await vi.waitFor(() => expect(group.getHandModelDiagnostics().loadedModel).toBe("anatomical"));
    expect(group.getHandModelDiagnostics().state).toBe("ready");
    group.dispose();

    let finishDisposed: ((asset: ImprovedHandAsset) => void) | undefined;
    const disposedAsset = new Promise<ImprovedHandAsset>((resolve) => { finishDisposed = resolve; });
    const disposed = new Hand3DMeshGroup("right", "anatomical", makeDependencies(() => disposedAsset));
    disposed.setHandModel(IMPROVED_HAND_MODEL_ID, 0);
    const disposedReady = disposed.waitForHandModelReady();
    const disposedRejected = expect(disposedReady).rejects.toThrow(/disposed/i);
    disposed.dispose();
    await disposedRejected;
    finishDisposed!(makeAsset());
    await Promise.resolve();
    expect(disposed.getHandModelDiagnostics().loadedModel).toBe("anatomical");
  });
});
