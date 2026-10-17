import type { MotionPose } from "@handthesia/contracts";
import * as THREE from "three";
import { getFingerTipsByFinger } from "../render/skins/geometry";
import { mixRgb, type SkinSettings } from "../render/skins/types";
import {
  decodeBase64ToArrayBuffer,
  LEFT_HAND_GLB_BASE64,
  RIGHT_HAND_GLB_BASE64,
} from "./handGlbData";

export const WHITE_KEY_WIDTH_IN = 6.5 / 7.0;
export const KEYBOARD_WHITE_KEYS = 52;
export const KEYBOARD_WIDTH_IN = KEYBOARD_WHITE_KEYS * WHITE_KEY_WIDTH_IN; // ~48.2857 in
const METERS_TO_INCHES = 39.37007874;

/**
 * Converts a 3D point from MotionPose inch-space:
 *   pt[0] = X along keyboard from A0 left edge (inches)
 *   pt[1] = Y depth from white-key front lip toward fallboard (inches)
 *   pt[2] = Z height above white-key top surface (inches)
 * into right-handed Three.js world space (centered at keyboard midpoint):
 *   world.x = pt[0] - KEYBOARD_WIDTH_IN / 2
 *   world.y = pt[2] (up)
 *   world.z = -pt[1] (toward pianist)
 */
export function posePointToWorld(
  pt: readonly [number, number, number],
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return target.set(pt[0] - KEYBOARD_WIDTH_IN * 0.5, pt[2], -pt[1]);
}

export interface ReconstructedHand3D {
  hand: "left" | "right";
  wristR: THREE.Vector3;
  wristU: THREE.Vector3;
  wristCenter: THREE.Vector3;
  wristWidthIn: number;
  armEnd: THREE.Vector3;
  palmNormal: THREE.Vector3;
  /**
   * Finger chains in 3D world space:
   * - Finger 1 (thumb): [cmc, mcp, ip, tip] (4 points)
   * - Fingers 2..5: [base, mcp, pip, dip, tip] (5 points)
   */
  chains: Record<number, THREE.Vector3[]>;
}

function dist3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

type MotionBone = MotionPose["bones"][number];
const DIGIT_ORDER = [2, 3, 4, 5, 1] as const;

function getDistalBonesByFinger(pose: MotionPose): Map<number, MotionBone> {
  const tips = pose.joints.filter((joint) => joint.kind === "tip");
  const distals = pose.bones.filter((bone) => bone.kind === "distal");
  if (tips.length !== DIGIT_ORDER.length || distals.length !== DIGIT_ORDER.length) return new Map();

  const result = new Map<number, MotionBone>();
  for (const [index, finger] of DIGIT_ORDER.entries()) {
    const distal = distals[index]!;
    if (dist3(distal.b, tips[index]!.point) >= 0.05) return new Map();
    result.set(finger, distal);
  }
  return result;
}

function findUniqueConnectedBone(
  pose: MotionPose,
  kind: MotionBone["kind"],
  point: readonly [number, number, number],
): MotionBone | null {
  const matches = pose.bones.filter(
    (bone) => bone.kind === kind && (dist3(bone.a, point) < 0.05 || dist3(bone.b, point) < 0.05),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function otherEnd(
  bone: MotionBone | null,
  point: readonly [number, number, number],
): [number, number, number] | null {
  if (!bone) return null;
  if (dist3(bone.b, point) < 0.05) return bone.a;
  if (dist3(bone.a, point) < 0.05) return bone.b;
  return null;
}

/**
 * Reconstructs the full 3D anatomical hand chains in Three.js world space (inches)
 * directly from a `MotionPose`.
 */
export function reconstructHand3D(pose: MotionPose): ReconstructedHand3D {
  const isLeft = pose.hand === "left";
  const wristJoints = pose.joints.filter((j) => j.kind === "wrist");

  let wrLocal: [number, number, number];
  let wuLocal: [number, number, number];

  if (wristJoints.length >= 2) {
    const w0 = wristJoints[0]!.point;
    const w1 = wristJoints[1]!.point;
    if (isLeft) {
      if (w0[0] >= w1[0]) {
        wrLocal = w0;
        wuLocal = w1;
      } else {
        wrLocal = w1;
        wuLocal = w0;
      }
    } else {
      if (w0[0] <= w1[0]) {
        wrLocal = w0;
        wuLocal = w1;
      } else {
        wrLocal = w1;
        wuLocal = w0;
      }
    }
  } else if (pose.bones.length > 0) {
    wrLocal = pose.bones[0]!.a;
    wuLocal = [wrLocal[0] + (isLeft ? -1.8 : 1.8), wrLocal[1], wrLocal[2]];
  } else {
    wrLocal = [isLeft ? 16 : 30, -1.2, 0.9];
    wuLocal = [wrLocal[0] + (isLeft ? -1.8 : 1.8), -1.2, 0.9];
  }

  const wristCenterLocal: [number, number, number] = [
    (wrLocal[0] + wuLocal[0]) * 0.5,
    (wrLocal[1] + wuLocal[1]) * 0.5,
    (wrLocal[2] + wuLocal[2]) * 0.5,
  ];

  const wristR = posePointToWorld(wrLocal);
  const wristU = posePointToWorld(wuLocal);
  const wristCenter = posePointToWorld(wristCenterLocal);
  const wristWidthIn = Math.max(1.4, wristR.distanceTo(wristU));

  const forearmBones = pose.bones.filter((b) => b.kind === "forearm");
  const armEnd = new THREE.Vector3();
  if (forearmBones.length > 0) {
    for (const fb of forearmBones) {
      armEnd.add(posePointToWorld(fb.b));
    }
    armEnd.divideScalar(forearmBones.length);
  } else {
    armEnd.set(wristCenter.x, wristCenter.y + 0.45, wristCenter.z + 6.5);
  }

  const distalByFinger = getDistalBonesByFinger(pose);
  const chains: Record<number, THREE.Vector3[]> = {};

  for (let f = 1; f <= 5; f++) {
    const distalBone = distalByFinger.get(f);
    if (!distalBone) continue;
    const bTip = distalBone.b;
    const aDip = distalBone.a;

    if (f === 1) {
      const aMcp =
        otherEnd(findUniqueConnectedBone(pose, "proximal", aDip), aDip) ?? [
          (aDip[0] + wristCenterLocal[0]) * 0.5,
          (aDip[1] + wristCenterLocal[1]) * 0.5,
          (aDip[2] + wristCenterLocal[2]) * 0.5,
        ];
      const aCmc =
        otherEnd(findUniqueConnectedBone(pose, "metacarpal", aMcp), aMcp) ?? [
          (aMcp[0] + wristCenterLocal[0]) * 0.5,
          (aMcp[1] + wristCenterLocal[1]) * 0.5,
          (aMcp[2] + wristCenterLocal[2]) * 0.5,
        ];
      chains[1] = [
        posePointToWorld(aCmc),
        posePointToWorld(aMcp),
        posePointToWorld(aDip),
        posePointToWorld(bTip),
      ];
    } else {
      const aPip =
        otherEnd(findUniqueConnectedBone(pose, "middle", aDip), aDip) ?? [
          (aDip[0] + wristCenterLocal[0]) * 0.5,
          (aDip[1] + wristCenterLocal[1]) * 0.5,
          (aDip[2] + wristCenterLocal[2]) * 0.5,
        ];
      const aMcp =
        otherEnd(findUniqueConnectedBone(pose, "proximal", aPip), aPip) ?? [
          (aPip[0] + wristCenterLocal[0]) * 0.5,
          (aPip[1] + wristCenterLocal[1]) * 0.5,
          (aPip[2] + wristCenterLocal[2]) * 0.5,
        ];
      const aBase =
        otherEnd(findUniqueConnectedBone(pose, "metacarpal", aMcp), aMcp) ?? [
          (aMcp[0] + wristCenterLocal[0]) * 0.5,
          (aMcp[1] + wristCenterLocal[1]) * 0.5,
          (aMcp[2] + wristCenterLocal[2]) * 0.5,
        ];
      chains[f] = [
        posePointToWorld(aBase),
        posePointToWorld(aMcp),
        posePointToWorld(aPip),
        posePointToWorld(aDip),
        posePointToWorld(bTip),
      ];
    }
  }

  // Compute dorsal palm normal in Three.js world space (+Y is up)
  const mcp2 = chains[2]?.[1] ?? new THREE.Vector3(wristCenter.x - 0.8, wristCenter.y, wristCenter.z - 2.2);
  const mcp5 = chains[5]?.[1] ?? new THREE.Vector3(wristCenter.x + 0.8, wristCenter.y, wristCenter.z - 2.2);
  const v2 = new THREE.Vector3().subVectors(mcp2, wristCenter);
  const v5 = new THREE.Vector3().subVectors(mcp5, wristCenter);
  const palmNormal = new THREE.Vector3();
  if (isLeft) {
    palmNormal.crossVectors(v2, v5);
  } else {
    palmNormal.crossVectors(v5, v2);
  }
  if (palmNormal.lengthSq() < 1e-5) {
    palmNormal.set(0, 1, 0);
  } else {
    palmNormal.normalize();
    if (palmNormal.y < 0) palmNormal.negate();
  }

  return {
    hand: pose.hand,
    wristR,
    wristU,
    wristCenter,
    wristWidthIn,
    armEnd,
    palmNormal,
    chains,
  };
}

// ---------------------------------------------------------------------------
// Rigged 25-Bone GLB Hand Parser & Anatomical Vertex Classifier
// ---------------------------------------------------------------------------

interface GlbBoneMetadata {
  bone: THREE.Bone;
  name: string;
  bindPositionM: THREE.Vector3;
  bindQuaternion: THREE.Quaternion;
  localUpInWrist: THREE.Vector3;
  localLateralInWrist: THREE.Vector3;
  bindLengthIn: number;
}

interface VertexAnatomyInfo {
  dorsalFactor: number; // +1 dorsal, -1 palmar
  lateralFactor: number; // +1 on left/right sides of finger/hand, 0 on top/bottom
  tipWeight: number;
  pipDipWeight: number;
  mcpWeight: number;
}

function srgbToLinear(byteVal: number): number {
  const c = Math.max(0, Math.min(1, byteVal / 255));
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

interface ParsedHandGlbRig {
  skinnedMesh: THREE.SkinnedMesh;
  bonesByName: Map<string, GlbBoneMetadata>;
  vertexAnatomy: VertexAnatomyInfo[];
  wristBoundaryVertexIndices: number[];
}

interface GlbJsonHeader {
  nodes: Array<{
    name: string;
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
  }>;
  meshes: Array<{
    primitives: Array<{
      attributes: {
        POSITION: number;
        NORMAL: number;
        TEXCOORD_0: number;
        JOINTS_0: number;
        WEIGHTS_0: number;
      };
      indices: number;
    }>;
  }>;
  skins: Array<{
    joints: number[];
    inverseBindMatrices: number;
  }>;
  accessors: Array<{
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }>;
  bufferViews: Array<{
    byteOffset?: number;
    byteLength: number;
  }>;
}

const NEXT_BONE_BY_NAME: Record<string, string> = {
  "wrist": "middle-finger-metacarpal",
  "thumb-metacarpal": "thumb-phalanx-proximal",
  "thumb-phalanx-proximal": "thumb-phalanx-distal",
  "thumb-phalanx-distal": "thumb-tip",
  "index-finger-metacarpal": "index-finger-phalanx-proximal",
  "index-finger-phalanx-proximal": "index-finger-phalanx-intermediate",
  "index-finger-phalanx-intermediate": "index-finger-phalanx-distal",
  "index-finger-phalanx-distal": "index-finger-tip",
  "middle-finger-metacarpal": "middle-finger-phalanx-proximal",
  "middle-finger-phalanx-proximal": "middle-finger-phalanx-intermediate",
  "middle-finger-phalanx-intermediate": "middle-finger-phalanx-distal",
  "middle-finger-phalanx-distal": "middle-finger-tip",
  "ring-finger-metacarpal": "ring-finger-phalanx-proximal",
  "ring-finger-phalanx-proximal": "ring-finger-phalanx-intermediate",
  "ring-finger-phalanx-intermediate": "ring-finger-phalanx-distal",
  "ring-finger-phalanx-distal": "ring-finger-tip",
  "pinky-finger-metacarpal": "pinky-finger-phalanx-proximal",
  "pinky-finger-phalanx-proximal": "pinky-finger-phalanx-intermediate",
  "pinky-finger-phalanx-intermediate": "pinky-finger-phalanx-distal",
  "pinky-finger-phalanx-distal": "pinky-finger-tip",
};

let cachedLeftGlbBuffer: ArrayBuffer | null = null;
let cachedRightGlbBuffer: ArrayBuffer | null = null;

function getHandGlbArrayBuffer(hand: "left" | "right"): ArrayBuffer {
  if (hand === "left") {
    if (!cachedLeftGlbBuffer) {
      cachedLeftGlbBuffer = decodeBase64ToArrayBuffer(LEFT_HAND_GLB_BASE64);
    }
    return cachedLeftGlbBuffer;
  }
  if (!cachedRightGlbBuffer) {
    cachedRightGlbBuffer = decodeBase64ToArrayBuffer(RIGHT_HAND_GLB_BASE64);
  }
  return cachedRightGlbBuffer;
}

/** Finds the closed, open-edge loop nearest the GLB wrist joint. */
function findWristBoundaryVertexIndices(
  geometry: THREE.BufferGeometry,
  wristBindPosition: THREE.Vector3,
): number[] {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  if (!index || !position) throw new Error("Hand GLB is missing indexed position geometry");

  const edgeUses = new Map<number, { a: number; b: number; count: number }>();
  const vertexCount = position.count;
  const recordEdge = (a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * vertexCount + hi;
    const edge = edgeUses.get(key);
    if (edge) edge.count++;
    else edgeUses.set(key, { a, b, count: 1 });
  };

  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    recordEdge(a, b);
    recordEdge(b, c);
    recordEdge(c, a);
  }

  const neighbors = new Map<number, number[]>();
  const addNeighbor = (a: number, b: number) => {
    let adjacent = neighbors.get(a);
    if (!adjacent) {
      adjacent = [];
      neighbors.set(a, adjacent);
    }
    adjacent.push(b);
  };
  for (const { a, b, count } of edgeUses.values()) {
    if (count !== 1) continue;
    addNeighbor(a, b);
    addNeighbor(b, a);
  }

  const loops: number[][] = [];
  const visited = new Set<number>();
  for (const start of neighbors.keys()) {
    if (visited.has(start)) continue;
    const component: number[] = [];
    const pending = [start];
    visited.add(start);
    while (pending.length > 0) {
      const vertex = pending.pop()!;
      component.push(vertex);
      for (const neighbor of neighbors.get(vertex) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }

    if (component.length < 3 || component.some((vertex) => neighbors.get(vertex)?.length !== 2)) {
      continue;
    }

    const loop: number[] = [];
    let previous = -1;
    let current = component[0]!;
    for (let step = 0; step <= component.length; step++) {
      loop.push(current);
      const adjacent = neighbors.get(current)!;
      const next = adjacent[0] === previous ? adjacent[1]! : adjacent[0]!;
      if (next === loop[0]) break;
      if (loop.includes(next)) {
        loop.length = 0;
        break;
      }
      previous = current;
      current = next;
    }
    if (loop.length === component.length) loops.push(loop);
  }

  let nearest: number[] | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const center = new THREE.Vector3();
  for (const loop of loops) {
    center.set(0, 0, 0);
    for (const vertex of loop) center.add(new THREE.Vector3().fromBufferAttribute(position, vertex));
    center.divideScalar(loop.length);
    const distance = center.distanceTo(wristBindPosition);
    if (distance < nearestDistance) {
      nearest = loop;
      nearestDistance = distance;
    }
  }

  if (!nearest) throw new Error("Hand GLB has no closed wrist boundary loop");
  return nearest;
}

function parseHandGlbRig(
  hand: "left" | "right",
  skinMaterial: THREE.MeshPhysicalMaterial,
  parentGroup: THREE.Group,
): ParsedHandGlbRig {
  const buffer = getHandGlbArrayBuffer(hand);
  const view = new DataView(buffer);
  const jsonLen = view.getUint32(12, true);
  const jsonBytes = new Uint8Array(buffer, 20, jsonLen);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes)) as GlbJsonHeader;
  const binOffset = 20 + jsonLen + 8;

  const getTypedArray = (accIdx: number) => {
    const acc = json.accessors[accIdx]!;
    const bv = json.bufferViews[acc.bufferView]!;
    const byteOffset = binOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const comps =
      acc.type === "SCALAR"
        ? 1
        : acc.type === "VEC2"
          ? 2
          : acc.type === "VEC3"
            ? 3
            : acc.type === "VEC4"
              ? 4
              : 16;
    const len = acc.count * comps;
    if (acc.componentType === 5126) {
      return new Float32Array(buffer.slice(byteOffset, byteOffset + len * 4));
    }
    if (acc.componentType === 5123) {
      return new Uint16Array(buffer.slice(byteOffset, byteOffset + len * 2));
    }
    return new Uint8Array(buffer.slice(byteOffset, byteOffset + len));
  };

  const prim = json.meshes[0]!.primitives[0]!;
  const rawPositions = getTypedArray(prim.attributes.POSITION) as Float32Array;
  const positions = new Float32Array(rawPositions.length);
  for (let i = 0; i < rawPositions.length; i++) {
    positions[i] = rawPositions[i]! * METERS_TO_INCHES;
  }
  const normals = getTypedArray(prim.attributes.NORMAL) as Float32Array;
  const uvs = getTypedArray(prim.attributes.TEXCOORD_0) as Float32Array;
  const skinIndices = getTypedArray(prim.attributes.JOINTS_0);
  const skinWeights = getTypedArray(prim.attributes.WEIGHTS_0) as Float32Array;
  const indices = getTypedArray(prim.indices) as Uint16Array;

  const vCount = positions.length / 3;
  const colors = new Float32Array(vCount * 3);
  colors.fill(0.45);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeights, 4));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  const skinDef = json.skins[0]!;
  const ibmRaw = getTypedArray(skinDef.inverseBindMatrices) as Float32Array;

  const nodeByName = new Map(json.nodes.map((n) => [n.name, n]));
  const wristNode = nodeByName.get("wrist")!;
  const wristBindQuat = new THREE.Quaternion(...(wristNode.rotation ?? [0, 0, 0, 1]));
  const wristBindQuatInv = wristBindQuat.clone().invert();

  const bones: THREE.Bone[] = [];
  const boneInverses: THREE.Matrix4[] = [];
  const bonesByName = new Map<string, GlbBoneMetadata>();
  const boneMetaBySkinIdx: GlbBoneMetadata[] = [];

  skinDef.joints.forEach((nodeIdx, skinIdx) => {
    const node = json.nodes[nodeIdx]!;
    const bone = new THREE.Bone();
    bone.name = node.name;
    const bindPosM = new THREE.Vector3(...(node.translation ?? [0, 0, 0]));
    const bindQuat = new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1]));
    bone.position.copy(bindPosM).multiplyScalar(METERS_TO_INCHES);
    bone.quaternion.copy(bindQuat);
    bone.scale.setScalar(1.0);
    parentGroup.add(bone);
    bones.push(bone);

    const ibm = new THREE.Matrix4().fromArray(ibmRaw, skinIdx * 16);
    ibm.elements[12]! *= METERS_TO_INCHES;
    ibm.elements[13]! *= METERS_TO_INCHES;
    ibm.elements[14]! *= METERS_TO_INCHES;
    boneInverses.push(ibm);

    const localUpInWrist = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(bindQuat)
      .applyQuaternion(wristBindQuatInv)
      .normalize();

    const localLateralInWrist = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(bindQuat)
      .applyQuaternion(wristBindQuatInv)
      .normalize();

    const nextName = NEXT_BONE_BY_NAME[node.name];
    const nextNode = nextName ? nodeByName.get(nextName) : undefined;
    const bindLengthIn = nextNode?.translation
      ? Math.max(
          0.25,
          bindPosM.distanceTo(new THREE.Vector3(...nextNode.translation)) * METERS_TO_INCHES,
        )
      : 0.5;

    const meta: GlbBoneMetadata = {
      bone,
      name: node.name,
      bindPositionM: bindPosM,
      bindQuaternion: bindQuat,
      localUpInWrist,
      localLateralInWrist,
      bindLengthIn,
    };
    bonesByName.set(node.name, meta);
    boneMetaBySkinIdx.push(meta);
  });

  // Precompute per-vertex anatomical classification for Subsurface Scattering (SSS) vertex colors
  const vertexAnatomy: VertexAnatomyInfo[] = new Array(vCount);
  const nTmp = new THREE.Vector3();

  for (let i = 0; i < vCount; i++) {
    nTmp.set(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);

    let dominantSkinIdx = 0;
    let maxW = -1;
    let tipWeight = 0;
    let pipDipWeight = 0;
    let mcpWeight = 0;

    for (let k = 0; k < 4; k++) {
      const sIdx = skinIndices[i * 4 + k]!;
      const w = skinWeights[i * 4 + k]!;
      if (w <= 0) continue;
      if (w > maxW) {
        maxW = w;
        dominantSkinIdx = sIdx;
      }
      const bName = boneMetaBySkinIdx[sIdx]?.name ?? "";
      if (bName.endsWith("-distal") || bName.endsWith("-tip")) {
        tipWeight += w;
      }
      if (bName.endsWith("-intermediate") || bName.endsWith("-distal")) {
        pipDipWeight += w;
      }
      if (bName.endsWith("-proximal")) {
        mcpWeight += w;
      }
    }

    const domMeta = boneMetaBySkinIdx[dominantSkinIdx]!;
    const localNormal = nTmp.clone().applyQuaternion(domMeta.bindQuaternion.clone().invert());
    const dorsalFactor = Math.max(-1, Math.min(1, localNormal.y));
    const lateralFactor = Math.max(0, Math.min(1, Math.abs(localNormal.x)));

    vertexAnatomy[i] = {
      dorsalFactor,
      lateralFactor,
      tipWeight: Math.min(1, tipWeight),
      pipDipWeight: Math.min(1, pipDipWeight),
      mcpWeight: Math.min(1, mcpWeight),
    };
  }

  const skinnedMesh = new THREE.SkinnedMesh(geometry, skinMaterial);
  skinnedMesh.castShadow = true;
  skinnedMesh.receiveShadow = true;
  skinnedMesh.frustumCulled = false;

  const skeleton = new THREE.Skeleton(bones, boneInverses);
  skinnedMesh.bind(skeleton, new THREE.Matrix4());
  parentGroup.add(skinnedMesh);

  const wristBindPosition = new THREE.Vector3(...(wristNode.translation ?? [0, 0, 0]))
    .multiplyScalar(METERS_TO_INCHES);
  const wristBoundaryVertexIndices = findWristBoundaryVertexIndices(geometry, wristBindPosition);
  geometry.userData.wristBoundaryVertexIndices = wristBoundaryVertexIndices;

  return {
    skinnedMesh,
    bonesByName,
    vertexAnatomy,
    wristBoundaryVertexIndices,
  };
}

let sharedSkinBumpTexture: THREE.CanvasTexture | null = null;

function getSkinMicroBumpTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (sharedSkinBumpTexture) return sharedSkinBumpTexture;

  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, 128, 128);
    // Deterministic fine skin pore & micro-crease grain
    for (let y = 0; y < 128; y += 2) {
      for (let x = 0; x < 128; x += 2) {
        const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        const frac = hash - Math.floor(hash);
        const v = Math.round(112 + frac * 32);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x, y, 2, 1);
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  sharedSkinBumpTexture = tex;
  return tex;
}

let sharedSoftShadowTexture: THREE.CanvasTexture | null = null;

function getSoftShadowDiscTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (sharedSoftShadowTexture) return sharedSoftShadowTexture;

  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, "rgba(8, 6, 10, 0.85)");
    grad.addColorStop(0.45, "rgba(10, 8, 14, 0.45)");
    grad.addColorStop(0.8, "rgba(12, 10, 16, 0.12)");
    grad.addColorStop(1, "rgba(12, 10, 16, 0.0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(canvas);
  sharedSoftShadowTexture = tex;
  return tex;
}

const FOREARM_RINGS = 8;

function createTubeBufferGeometry(rings: number, sectors: number): THREE.BufferGeometry {
  const vertexCount = rings * sectors;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  colors.fill(0.45);
  const indices: number[] = [];

  for (let r = 0; r < rings - 1; r++) {
    for (let c = 0; c < sectors; c++) {
      const nextC = (c + 1) % sectors;
      const a = r * sectors + c;
      const b = r * sectors + nextC;
      const d = (r + 1) * sectors + c;
      const e = (r + 1) * sectors + nextC;
      indices.push(a, d, b);
      indices.push(b, d, e);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}

const FINGER_PREFIX_BY_DIGIT: Record<number, string> = {
  1: "thumb",
  2: "index-finger",
  3: "middle-finger",
  4: "ring-finger",
  5: "pinky-finger",
};

/**
 * High-realism 3D Hand Mesh Group driven by the 25-bone sculpted `SkinnedMesh`
 * (`left.glb` & `right.glb`), with Subsurface Scattering vertex shading,
 * 3D glossy fingernails, key-surface contact shadows, and concert tuxedo sleeve.
 */
export class Hand3DMeshGroup {
  public readonly group = new THREE.Group();
  private readonly hand: "left" | "right";
  private readonly rig: ParsedHandGlbRig;

  private readonly skinMaterial: THREE.MeshPhysicalMaterial;
  private readonly cuffMaterial: THREE.MeshStandardMaterial;
  private readonly sleeveMaterial: THREE.MeshPhysicalMaterial;

  private readonly contactShadows: THREE.Mesh[] = [];
  private readonly contactShadowMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly contactShadowGeometry: THREE.PlaneGeometry;
  private readonly forearmGeometry: THREE.BufferGeometry;
  private readonly forearmMesh: THREE.Mesh;
  private readonly cuffGeometry: THREE.CylinderGeometry;
  private readonly sleeveGeometry: THREE.CylinderGeometry;
  private readonly cuffMesh: THREE.Mesh;
  private readonly sleeveMesh: THREE.Mesh;
  private readonly badgeSprites = new Map<number, THREE.Sprite>();
  private lastColorSignature = "";

  public constructor(hand: "left" | "right") {
    this.hand = hand;
    this.group.visible = false;

    const bumpMap = getSkinMicroBumpTexture();
    this.skinMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.01,
      clearcoat: 0.07,
      clearcoatRoughness: 0.68,
      sheen: 0.24,
      sheenRoughness: 0.72,
      sheenColor: new THREE.Color(0xd9826c),
      envMapIntensity: 0.22,
      ...(bumpMap ? { bumpMap, bumpScale: 0.026 } : {}),
    });

    this.cuffMaterial = new THREE.MeshStandardMaterial({
      color: 0xd8d5cc,
      roughness: 0.68,
      metalness: 0.02,
      envMapIntensity: 0.18,
      side: THREE.DoubleSide,
    });

    this.sleeveMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x12141c,
      roughness: 0.72,
      metalness: 0.04,
      sheen: 0.25,
      sheenRoughness: 0.78,
      sheenColor: new THREE.Color(0x222634),
      envMapIntensity: 0.18,
      side: THREE.DoubleSide,
    });

    // Build rigged 25-bone SkinnedMesh from GLB
    this.rig = parseHandGlbRig(hand, this.skinMaterial, this.group);

    // Soft 3D contact shadow discs projected onto the keytops under palm & fingers
    this.contactShadowGeometry = new THREE.PlaneGeometry(1, 1);
    this.contactShadowGeometry.rotateX(-Math.PI * 0.5);
    const shadowTex = getSoftShadowDiscTexture();
    for (let i = 0; i < 11; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x050408,
        ...(shadowTex ? { map: shadowTex } : {}),
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const sMesh = new THREE.Mesh(this.contactShadowGeometry, mat);
      sMesh.renderOrder = 2;
      this.contactShadowMaterials.push(mat);
      this.contactShadows.push(sMesh);
      this.group.add(sMesh);
    }

    // Forearm & Concert Sleeve bridging behind the wrist
    this.forearmGeometry = createTubeBufferGeometry(
      FOREARM_RINGS,
      this.rig.wristBoundaryVertexIndices.length,
    );
    this.forearmMesh = new THREE.Mesh(this.forearmGeometry, this.skinMaterial);
    this.forearmMesh.name = "hand-forearm-bridge";
    this.forearmMesh.castShadow = true;
    this.forearmMesh.receiveShadow = true;
    this.group.add(this.forearmMesh);

    this.cuffGeometry = new THREE.CylinderGeometry(1.0, 1.04, 1.0, 24, 1, false);
    this.cuffGeometry.rotateX(Math.PI * 0.5);
    this.cuffMesh = new THREE.Mesh(this.cuffGeometry, this.cuffMaterial);
    this.cuffMesh.castShadow = true;
    this.cuffMesh.receiveShadow = true;
    this.group.add(this.cuffMesh);

    this.sleeveGeometry = new THREE.CylinderGeometry(1.38, 1.0, 1.0, 24, 1, false);
    this.sleeveGeometry.rotateX(Math.PI * 0.5);
    this.sleeveMesh = new THREE.Mesh(this.sleeveGeometry, this.sleeveMaterial);
    this.sleeveMesh.castShadow = true;
    this.sleeveMesh.receiveShadow = true;
    this.group.add(this.sleeveMesh);
  }

  public clear(): void {
    this.group.visible = false;
  }

  public setSkinColor(rgb: [number, number, number]): void {
    this.updateVertexColors(
      rgb,
      mixRgb(rgb, [132, 74, 54], 0.45),
      mixRgb(rgb, [198, 96, 82], 0.38),
      mixRgb(rgb, [235, 195, 170], 0.18),
    );
  }

  public setOpacity(opacity: number): void {
    const isTransparent = opacity < 0.999;
    this.skinMaterial.transparent = isTransparent;
    this.skinMaterial.opacity = opacity;
  }

  private updateVertexColors(
    baseSkinRgb: [number, number, number],
    creaseRgb: [number, number, number],
    tipWarmRgb: [number, number, number],
    knuckleHighlightRgb: [number, number, number],
  ): void {
    const sig = `${baseSkinRgb.join(",")}|${creaseRgb.join(",")}|${tipWarmRgb.join(",")}`;
    if (sig === this.lastColorSignature) return;
    this.lastColorSignature = sig;

    const colAttr = this.rig.skinnedMesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const anatomy = this.rig.vertexAnatomy;
    const lateralShadeRgb = mixRgb(baseSkinRgb, [112, 62, 44], 0.52);
    const palmarShadeRgb = mixRgb(baseSkinRgb, [136, 76, 56], 0.44);

    for (let i = 0; i < anatomy.length; i++) {
      const info = anatomy[i]!;
      let rgb = baseSkinRgb;

      // 1. Cylindrical lateral shading along the left/right edges of fingers & hand
      // so adjacent fingers and white keys below have crisp dark 3D separation
      if (info.lateralFactor > 0.15) {
        const latMix = Math.min(0.68, Math.pow(info.lateralFactor, 1.2) * 0.62);
        rgb = mixRgb(rgb, lateralShadeRgb, latMix);
      }

      // 2. Palmar underside ambient occlusion shading
      if (info.dorsalFactor < 0) {
        rgb = mixRgb(rgb, palmarShadeRgb, Math.min(0.65, -info.dorsalFactor * 0.58));
      }

      // 3. Dorsal knuckle highlight over MCP
      if (info.dorsalFactor > 0.4 && info.mcpWeight > 0.25) {
        rgb = mixRgb(rgb, knuckleHighlightRgb, Math.min(0.32, info.dorsalFactor * info.mcpWeight * 0.35));
      }

      // 4. Dorsal joint crease shading over PIP/DIP
      if (info.dorsalFactor > 0.15 && info.pipDipWeight > 0.25) {
        rgb = mixRgb(rgb, creaseRgb, Math.min(0.45, info.dorsalFactor * info.pipDipWeight * 0.38));
      }

      // 5. Rosy capillary warmth on fingertips and fleshy palmar pads
      if (info.tipWeight > 0.25) {
        rgb = mixRgb(rgb, tipWarmRgb, Math.min(0.55, info.tipWeight * 0.48));
      }

      // Convert sRGB [0..255] to Linear-sRGB for Three.js vertex colors!
      colAttr.setXYZ(
        i,
        srgbToLinear(rgb[0]),
        srgbToLinear(rgb[1]),
        srgbToLinear(rgb[2]),
      );
    }
    colAttr.needsUpdate = true;
  }

  public updateFromPose(
    pose: MotionPose,
    skinSettings: SkinSettings,
    showFingerLabels: boolean,
  ): void {
    const h3d = reconstructHand3D(pose);
    this.group.visible = true;

    // Use rich warm natural human skin tone in 3D view so hands stand out clearly against ivory keys
    const warm3DSkinRgb: [number, number, number] = [206, 146, 114];
    const warm3DCreaseRgb: [number, number, number] = [138, 78, 58];

    const baseSkinRgb: [number, number, number] =
      skinSettings.style === "gloves"
        ? [218, 222, 230]
        : skinSettings.style === "robot"
          ? skinSettings.colors.robot.shell
          : warm3DSkinRgb;

    const creaseRgb: [number, number, number] =
      skinSettings.style === "gloves"
        ? [135, 142, 156]
        : skinSettings.style === "robot"
          ? skinSettings.colors.robot.joint
          : warm3DCreaseRgb;

    const tipWarmRgb: [number, number, number] =
      skinSettings.style === "gloves"
        ? [195, 200, 210]
        : skinSettings.style === "robot"
          ? skinSettings.colors.robot.tip
          : mixRgb(baseSkinRgb, [196, 88, 74], 0.42);

    const knuckleHighlightRgb = mixRgb(baseSkinRgb, [238, 192, 162], 0.22);

    this.updateVertexColors(baseSkinRgb, creaseRgb, tipWarmRgb, knuckleHighlightRgb);

    this.sleeveMaterial.color.setHex(0x12141c);
    this.skinMaterial.roughness = skinSettings.style === "robot" ? 0.28 : 0.62;
    this.skinMaterial.metalness = skinSettings.style === "robot" ? 0.45 : 0.01;

    const isLeft = h3d.hand === "left";
    const widthScale = Math.max(0.75, Math.min(1.28, skinSettings.finger_width / 0.75));

    // 1. Compute Wrist World Coordinate Frame
    // Local +X of wrist in both left.glb and right.glb points to the right when viewing the dorsum
    // (toward pinky for right hand, toward thumb for left hand)
    const mcpMid = new THREE.Vector3();
    let mcpCount = 0;
    for (let f = 2; f <= 5; f++) {
      const m = h3d.chains[f]?.[1];
      if (m) {
        mcpMid.add(m);
        mcpCount++;
      }
    }
    if (mcpCount > 0) {
      mcpMid.divideScalar(mcpCount);
    } else {
      mcpMid.set(h3d.wristCenter.x, h3d.wristCenter.y, h3d.wristCenter.z - 2.5);
    }

    const palmUp = h3d.palmNormal.clone().normalize();
    const palmForward = new THREE.Vector3().subVectors(mcpMid, h3d.wristCenter);
    palmForward.addScaledVector(palmUp, -palmForward.dot(palmUp));
    if (palmForward.lengthSq() < 1e-5) {
      palmForward.set(0, 0, -1);
    } else {
      palmForward.normalize();
    }

    const wristZ = palmForward.clone().negate(); // Local +Z points backward toward forearm
    const wristX = new THREE.Vector3().crossVectors(palmUp, wristZ).normalize();
    const wristY = new THREE.Vector3().crossVectors(wristZ, wristX).normalize();
    const wristBasis = new THREE.Matrix4().makeBasis(wristX, wristY, wristZ);
    const wristWorldQuat = new THREE.Quaternion().setFromRotationMatrix(wristBasis);

    const wristMeta = this.rig.bonesByName.get("wrist");
    const m3Base = h3d.chains[3]?.[0] ?? mcpMid;
    const wristToMetaIn = Math.max(0.65, h3d.wristCenter.distanceTo(m3Base));
    if (wristMeta) {
      // Elevate wrist bone slightly toward dorsal surface to match GLB bind-pose wrist height
      wristMeta.bone.position
        .copy(h3d.wristCenter)
        .addScaledVector(palmUp, 0.16);
      wristMeta.bone.quaternion.copy(wristWorldQuat);
      const lenRatio = Math.max(0.65, Math.min(1.35, wristToMetaIn / wristMeta.bindLengthIn));
      wristMeta.bone.scale.set(widthScale, widthScale, lenRatio);
    }

    // Helper to orient and scale a bone from startPt to endPt with continuous hinge axis
    const orientBone = (
      boneName: string,
      startPt: THREE.Vector3,
      endPt: THREE.Vector3,
      thicknessScale: number,
      parentHingeAxis?: THREE.Vector3,
    ): { quat: THREE.Quaternion; normalUp: THREE.Vector3; binormal: THREE.Vector3 } | null => {
      const meta = this.rig.bonesByName.get(boneName);
      if (!meta) return null;

      const segVec = new THREE.Vector3().subVectors(endPt, startPt);
      const segLen = Math.max(0.15, segVec.length());
      const forward = segVec.clone().divideScalar(segLen);
      const zAxis = forward.clone().negate(); // Local -Z points along bone toward fingertip

      // Determine lateral hinge reference:
      // For child phalanges, propagate the parent's lateral hinge axis to guarantee
      // zero axial twist across PIP/DIP joints. For root metacarpals, transform the
      // bone's anatomical lateral axis from wrist bind frame.
      const refLateral = parentHingeAxis
        ? parentHingeAxis
        : meta.localLateralInWrist.clone().applyQuaternion(wristWorldQuat).normalize();

      // Gram-Schmidt projection of refLateral perpendicular to zAxis
      let xAxis = new THREE.Vector3().subVectors(
        refLateral,
        zAxis.clone().multiplyScalar(refLateral.dot(zAxis)),
      );

      if (xAxis.lengthSq() < 1e-6) {
        xAxis = meta.localLateralInWrist.clone().applyQuaternion(wristWorldQuat);
        xAxis.sub(zAxis.clone().multiplyScalar(xAxis.dot(zAxis)));
        if (xAxis.lengthSq() < 1e-6) {
          xAxis.copy(wristX);
        }
      }
      xAxis.normalize();

      // Guarantee continuity: xAxis must never flip 180 degrees against refLateral
      if (xAxis.dot(refLateral) < 0) {
        xAxis.negate();
      }

      const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();

      const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
      const quat = new THREE.Quaternion().setFromRotationMatrix(basis);

      meta.bone.position.copy(startPt);
      meta.bone.quaternion.copy(quat);

      const lenRatio = Math.max(0.55, Math.min(1.55, segLen / meta.bindLengthIn));
      meta.bone.scale.set(thicknessScale, thicknessScale, lenRatio);

      return { quat, normalUp: yAxis, binormal: xAxis };
    };

    // 2. Update all 5 fingers in the 25-bone SkinnedMesh
    for (let f = 1; f <= 5; f++) {
      const chain = h3d.chains[f];
      const prefix = FINGER_PREFIX_BY_DIGIT[f]!;

      if (!chain || chain.length < 4) {
        continue;
      }

      // Lift fingertip slightly by +0.12 in so the fleshy palmar pad rests on the key surface at z=0
      const tipOriginal = chain[chain.length - 1]!;
      const dipPt = chain[chain.length - 2]!;
      const tipPadLift = Math.max(0, 0.13 - Math.max(0, tipOriginal.y) * 0.5);
      const tipPt = new THREE.Vector3(
        tipOriginal.x,
        tipOriginal.y + tipPadLift,
        tipOriginal.z,
      );

      let distalResult: { quat: THREE.Quaternion; normalUp: THREE.Vector3; binormal: THREE.Vector3 } | null;

      if (f === 1) {
        // Thumb has 4 points: [cmc, mcp, ip, tip]
        const cmc = chain[0]!;
        const mcp = chain[1]!;
        const ip = dipPt;

        const metaResult = orientBone("thumb-metacarpal", cmc, mcp, widthScale);
        const proxResult = orientBone(
          "thumb-phalanx-proximal",
          mcp,
          ip,
          widthScale,
          metaResult?.binormal,
        );
        distalResult = orientBone(
          "thumb-phalanx-distal",
          ip,
          tipPt,
          widthScale,
          proxResult?.binormal,
        );

        const tipMeta = this.rig.bonesByName.get("thumb-tip");
        if (tipMeta && distalResult) {
          tipMeta.bone.position.copy(tipPt);
          tipMeta.bone.quaternion.copy(distalResult.quat);
          tipMeta.bone.scale.setScalar(widthScale);
        }
      } else {
        // Fingers 2..5 have 5 points: [base, mcp, pip, dip, tip]
        const base = chain[0]!;
        const mcp = chain[1]!;
        const pip = chain[2]!;
        const dip = dipPt;

        // In GLB bind pose, pinky-finger-metacarpal sits slightly closer to MCP
        const metaStart =
          f === 5 ? new THREE.Vector3().lerpVectors(base, mcp, 0.22) : base;

        const metaResult = orientBone(`${prefix}-metacarpal`, metaStart, mcp, widthScale);
        const proxResult = orientBone(
          `${prefix}-phalanx-proximal`,
          mcp,
          pip,
          widthScale,
          metaResult?.binormal,
        );
        const interResult = orientBone(
          `${prefix}-phalanx-intermediate`,
          pip,
          dip,
          widthScale,
          proxResult?.binormal,
        );
        distalResult = orientBone(
          `${prefix}-phalanx-distal`,
          dip,
          tipPt,
          widthScale,
          interResult?.binormal,
        );

        const tipMeta = this.rig.bonesByName.get(`${prefix}-tip`);
        if (tipMeta && distalResult) {
          tipMeta.bone.position.copy(tipPt);
          tipMeta.bone.quaternion.copy(distalResult.quat);
          tipMeta.bone.scale.setScalar(widthScale);
        }
      }
    }

    // Update the pose matrices before deriving the forearm seam from deformed wrist vertices.
    this.group.updateMatrixWorld(true);
    this.rig.skinnedMesh.skeleton.update();

    // 3. Update 3D Contact Shadows projected onto key surface under palm & fingers
    this.updateContactShadows(h3d, mcpMid, skinSettings.shadow);

    // 4. Update Forearm & Concert Sleeve bridging behind the wrist
    this.updateForearmAndSleeve(h3d, skinSettings.sleeve, baseSkinRgb, isLeft);

    // Ensure bone world matrices are up-to-date before updating skeleton boneMatrices
    this.group.updateMatrixWorld(true);
    this.rig.skinnedMesh.skeleton.update();

    // 5. Update Finger Number Badges
    this.updateFingerBadges(pose, showFingerLabels);
  }

  private updateContactShadows(
    h3d: ReconstructedHand3D,
    mcpMid: THREE.Vector3,
    showShadow: boolean,
  ): void {
    if (!showShadow) {
      for (const sMesh of this.contactShadows) {
        sMesh.visible = false;
      }
      return;
    }

    // Slot 0: Palm shadow on keytops
    const palmShadow = this.contactShadows[0]!;
    const palmShadowMat = this.contactShadowMaterials[0]!;
    const palmCenter = new THREE.Vector3().lerpVectors(h3d.wristCenter, mcpMid, 0.68);
    const palmH = Math.max(0, palmCenter.y);
    palmShadow.visible = palmCenter.z < 0.8;
    palmShadow.position.set(
      palmCenter.x - palmH * 0.14,
      0.02,
      Math.min(-0.15, palmCenter.z - palmH * 0.1),
    );
    palmShadow.scale.set(3.4 + palmH * 0.4, 1, 2.8 + palmH * 0.35);
    palmShadowMat.opacity = Math.max(0.12, Math.min(0.52, 0.48 - palmH * 0.14));

    // Slots 1..10: 2 soft contact shadows per finger (proximal/PIP and fingertip)
    for (let f = 1; f <= 5; f++) {
      const chain = h3d.chains[f];
      const midShadow = this.contactShadows[f * 2 - 1]!;
      const midMat = this.contactShadowMaterials[f * 2 - 1]!;
      const tipShadow = this.contactShadows[f * 2]!;
      const tipMat = this.contactShadowMaterials[f * 2]!;

      if (!chain || chain.length < 4) {
        midShadow.visible = false;
        tipShadow.visible = false;
        continue;
      }

      const midPt = chain[Math.min(2, chain.length - 2)]!;
      const tipPt = chain[chain.length - 1]!;

      const midH = Math.max(0, midPt.y);
      const midOverBlackRegion = midPt.z < -2.1;
      const midKeySurfaceY = midOverBlackRegion && midPt.y > 0.38 ? 0.38 : 0.022;
      midShadow.visible = true;
      midShadow.position.set(
        midPt.x - midH * 0.12,
        midKeySurfaceY,
        Math.min(-0.08, midPt.z - midH * 0.08),
      );
      midShadow.scale.set(0.88 + midH * 0.22, 1, 1.45 + midH * 0.25);
      midMat.opacity = Math.max(0.15, Math.min(0.55, 0.52 - midH * 0.18));

      const tipH = Math.max(0, tipPt.y);
      const tipOverBlack = tipPt.z < -2.1 && tipPt.y > 0.32;
      const tipKeySurfaceY = tipOverBlack ? 0.4 : 0.024;
      tipShadow.visible = true;
      tipShadow.position.set(
        tipPt.x - tipH * 0.08,
        tipKeySurfaceY,
        Math.min(-0.06, tipPt.z - tipH * 0.06),
      );
      tipShadow.scale.set(0.76 + tipH * 0.18, 1, 0.95 + tipH * 0.2);
      tipMat.opacity = Math.max(0.22, Math.min(0.68, 0.65 - tipH * 0.24));
    }
  }

  private updateForearmAndSleeve(
    h3d: ReconstructedHand3D,
    showSleeve: boolean,
    baseSkinRgb: [number, number, number],
    isLeft: boolean,
  ): void {
    const sourcePositions = this.rig.skinnedMesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const openingIndices = this.rig.wristBoundaryVertexIndices;
    const openingPoints = openingIndices.map((vertex) => {
      const point = new THREE.Vector3().fromBufferAttribute(sourcePositions, vertex);
      return this.rig.skinnedMesh.applyBoneTransform(vertex, point);
    });
    const openingCenter = openingPoints.reduce(
      (center, point) => center.add(point),
      new THREE.Vector3(),
    ).divideScalar(openingPoints.length);

    const armVec = new THREE.Vector3().subVectors(h3d.armEnd, openingCenter);
    const armLen = Math.max(1.0, armVec.length());
    const armDir = armVec.clone().normalize();

    const latDir = new THREE.Vector3().subVectors(h3d.wristU, h3d.wristR).normalize();
    if (isLeft) latDir.negate();
    const upDir = new THREE.Vector3().crossVectors(armDir, latDir).normalize();
    if (upDir.y < 0) upDir.negate();
    const orthoLat = new THREE.Vector3().crossVectors(upDir, armDir).normalize();

    const skinEndDist = showSleeve ? Math.min(armLen * 0.46, 1.85) : armLen;
    const posAttr = this.forearmGeometry.getAttribute("position") as THREE.BufferAttribute;
    const colAttr = this.forearmGeometry.getAttribute("color") as THREE.BufferAttribute;

    let baseRx = 0;
    let baseRy = 0;
    for (const point of openingPoints) {
      const offset = point.clone().sub(openingCenter);
      baseRx = Math.max(baseRx, Math.abs(offset.dot(orthoLat)));
      baseRy = Math.max(baseRy, Math.abs(offset.dot(upDir)));
    }
    baseRx = Math.max(baseRx, h3d.wristWidthIn * 0.3);
    baseRy = Math.max(baseRy, h3d.wristWidthIn * 0.22);

    // The tube geometry's winding expects the opening vertices to run outward around the arm.
    const orderedOpening = [...openingPoints];
    const orderedOpeningIndices = [...openingIndices];
    const firstRadial = orderedOpening[0]!.clone().sub(openingCenter);
    const firstTangent = orderedOpening[1]!.clone().sub(orderedOpening[0]!);
    if (new THREE.Vector3().crossVectors(armDir, firstTangent).dot(firstRadial) < 0) {
      orderedOpening.reverse();
      orderedOpeningIndices.reverse();
    }
    this.forearmGeometry.userData.wristBoundaryVertexIndices = orderedOpeningIndices;

    const lateralArmShadeRgb = mixRgb(baseSkinRgb, [112, 62, 44], 0.48);
    const sectors = orderedOpening.length;

    for (let r = 0; r < FOREARM_RINGS; r++) {
      const t = r / (FOREARM_RINGS - 1);
      const d = t * skinEndDist;
      const center = openingCenter.clone().addScaledVector(armDir, d);
      const flare = 1.0 + 0.14 * (d / Math.max(1, armLen));
      const blendT = Math.max(0, Math.min(1, d / 0.8));
      const sectionBlend = blendT * blendT * (3 - 2 * blendT);

      for (let c = 0; c < sectors; c++) {
        const openingRadial = orderedOpening[c]!.clone().sub(openingCenter);
        const theta = Math.atan2(
          openingRadial.dot(upDir) / baseRy,
          openingRadial.dot(orthoLat) / baseRx,
        );
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const targetRadial = new THREE.Vector3()
          .addScaledVector(orthoLat, baseRx * cosT)
          .addScaledVector(upDir, baseRy * sinT);
        const radial = openingRadial.lerp(targetRadial, sectionBlend).multiplyScalar(flare);

        const vx = center.x + radial.x;
        const vy = center.y + radial.y;
        const vz = center.z + radial.z;

        const idx = r * sectors + c;
        posAttr.setXYZ(idx, vx, vy, vz);
        const sideShade = Math.max(0, Math.abs(cosT) * 0.45 + (sinT < 0 ? -sinT * 0.4 : 0));
        const vRgb = mixRgb(baseSkinRgb, lateralArmShadeRgb, Math.min(0.65, sideShade));
        colAttr.setXYZ(
          idx,
          srgbToLinear(vRgb[0]),
          srgbToLinear(vRgb[1]),
          srgbToLinear(vRgb[2]),
        );
      }
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.forearmGeometry.computeVertexNormals();

    if (showSleeve) {
      this.forearmMesh.visible = false;
      this.cuffMesh.visible = true;
      this.sleeveMesh.visible = true;

      // The shirt cuff wraps over the boundary vertices of the GLB wrist mesh (-0.35 in),
      // completely enclosing the opening loop so the hand emerges cleanly with zero visible cut.
      const cuffStart = -0.35;
      const cuffLen = 0.95;
      const cuffMid = new THREE.Vector3()
        .copy(openingCenter)
        .addScaledVector(armDir, cuffStart + cuffLen * 0.5);

      const basis = new THREE.Matrix4().makeBasis(orthoLat, upDir, armDir);
      const quat = new THREE.Quaternion().setFromRotationMatrix(basis);

      this.cuffMesh.position.copy(cuffMid);
      this.cuffMesh.quaternion.copy(quat);
      this.cuffMesh.scale.set(baseRx * 1.15, baseRy * 1.20, cuffLen);

      // The suit jacket sleeve starts behind the cuff (+0.30 in) so 0.65 in of white cuff peeks out,
      // and extends 22 inches along armDir so the arm exits past the viewport bottom in all presets.
      const sleeveStart = 0.30;
      const sleeveLen = 22.0;
      const sleeveMid = new THREE.Vector3()
        .copy(openingCenter)
        .addScaledVector(armDir, sleeveStart + sleeveLen * 0.5);

      this.sleeveMesh.position.copy(sleeveMid);
      this.sleeveMesh.quaternion.copy(quat);
      this.sleeveMesh.scale.set(baseRx * 1.26, baseRy * 1.32, sleeveLen);
    } else {
      this.forearmMesh.visible = true;
      this.cuffMesh.visible = false;
      this.sleeveMesh.visible = false;
    }
  }

  private updateFingerBadges(pose: MotionPose, showFingerLabels: boolean): void {
    if (!showFingerLabels) {
      for (const sprite of this.badgeSprites.values()) {
        sprite.visible = false;
      }
      return;
    }

    const tips = getFingerTipsByFinger(pose);
    for (let f = 1; f <= 5; f++) {
      const pt = tips.get(f);
      let sprite = this.badgeSprites.get(f);
      if (!pt) {
        if (sprite) sprite.visible = false;
        continue;
      }
      if (!sprite) {
        sprite = createFingerBadgeSprite(f, this.hand === "left" ? "#3b82f6" : "#10b981");
        this.badgeSprites.set(f, sprite);
        this.group.add(sprite);
      }
      const worldPt = posePointToWorld(pt);
      sprite.position.set(worldPt.x, worldPt.y + 0.45, worldPt.z + 0.15);
      sprite.scale.set(0.42, 0.42, 1);
      sprite.visible = true;
    }
  }

  public getBone(name: string): THREE.Bone | undefined {
    return this.rig.bonesByName.get(name)?.bone;
  }

  public dispose(): void {
    this.rig.skinnedMesh.geometry.dispose();
    this.forearmGeometry.dispose();
    this.contactShadowGeometry.dispose();
    this.cuffGeometry.dispose();
    this.sleeveGeometry.dispose();
    this.skinMaterial.dispose();
    this.cuffMaterial.dispose();
    this.sleeveMaterial.dispose();
    for (const material of this.contactShadowMaterials) material.dispose();
    for (const sprite of this.badgeSprites.values()) {
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
  }
}

function createFingerBadgeSprite(finger: number, accentHex: string): THREE.Sprite {
  if (typeof document === "undefined") {
    return new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff }));
  }
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, Math.PI * 2);
    ctx.fillStyle = "#18181c";
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = accentHex;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 32px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(finger), 32, 34);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 10;
  return sprite;
}
