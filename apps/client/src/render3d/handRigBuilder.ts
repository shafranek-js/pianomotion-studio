import type { MotionPose } from "@handthesia/contracts";
import * as THREE from "three";
import { getFingerTipsByFinger } from "../render/skins/geometry";
import { mixRgb, type SkinSettings } from "../render/skins/types";
import {
  decodeBase64ToArrayBuffer,
  LEFT_HAND_GLB_BASE64,
  RIGHT_HAND_GLB_BASE64,
} from "./handGlbData";
import { releaseAssetUrl } from "../pwa/urls";
import {
  improvedHandAssetLoader,
  improvedHandTextureCache,
  type ImprovedHandAssetLoader,
  type ImprovedHandAsset,
  type ImprovedHandBoneFrame,
  type ImprovedHandLodManifest,
  type ImprovedHandManifestExtras,
  type ImprovedHandTextureCache,
  type ImprovedHandTextureLease,
  IMPROVED_HAND_JOINT_NAMES,
} from "./improvedHandAssets";
import {
  errorMessage,
  HandModelRequestGate,
  IMPROVED_HAND_MODEL_ID,
  TESTING_HAND_MODEL_ID,
  isDetailedHandModel,
  type HandModelDiagnostics,
  type HandModelId,
  type ImprovedHandLod,
} from "./improvedHandRuntime";
import {
  computePenetrationOnlyCorrection,
  type ImprovedHandContactTarget,
} from "./improvedHandContact";
import { solveFixedLengthFingerChain } from "./anatomicalHandContact";
import { transferWebxrSkinToAnatomicalSurface } from "./testingHandSkin";

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
  chainDiagnostics: FingerChainDiagnostic[];
}

function dist3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

type MotionBone = MotionPose["bones"][number];
const DIGIT_ORDER = [2, 3, 4, 5, 1] as const;
const CHAIN_ENDPOINT_TOLERANCE_IN = 0.005;
const ENGINE_ORDERED_BONE_COUNT = 28;
const ENGINE_FINGER_BONE_INDICES: Readonly<Record<number, readonly number[]>> = {
  2: [9, 10, 11, 12],
  3: [13, 14, 15, 16],
  4: [17, 18, 19, 20],
  5: [21, 22, 23, 24],
  1: [25, 26, 27],
};
const ENGINE_FINGER_BONE_KINDS: Readonly<Record<number, readonly MotionBone["kind"][]>> = {
  2: ["metacarpal", "proximal", "middle", "distal"],
  3: ["metacarpal", "proximal", "middle", "distal"],
  4: ["metacarpal", "proximal", "middle", "distal"],
  5: ["metacarpal", "proximal", "middle", "distal"],
  1: ["metacarpal", "proximal", "distal"],
};

export interface FingerChainDiagnostic {
  finger: number;
  code: "missing-tip" | "missing-distal" | "disconnected-chain" | "ambiguous-chain" | "order-resolved-ambiguity";
  message: string;
}

interface BackwardBoneLink {
  index: number;
  previousPoint: [number, number, number];
  distance: number;
}

interface ReconstructedFingerPath {
  boneIndices: number[];
  pointsFromTip: [number, number, number][];
  totalEndpointError: number;
}

function getBackwardBoneLink(
  bone: MotionBone,
  index: number,
  point: readonly [number, number, number],
): BackwardBoneLink | null {
  const distanceToA = dist3(bone.a, point);
  const distanceToB = dist3(bone.b, point);
  if (distanceToA > CHAIN_ENDPOINT_TOLERANCE_IN && distanceToB > CHAIN_ENDPOINT_TOLERANCE_IN) {
    return null;
  }
  if (distanceToA <= CHAIN_ENDPOINT_TOLERANCE_IN && distanceToB <= CHAIN_ENDPOINT_TOLERANCE_IN) {
    return { index, previousPoint: bone.a, distance: 0 };
  }
  return distanceToB < distanceToA
    ? { index, previousPoint: bone.a, distance: distanceToB }
    : { index, previousPoint: bone.b, distance: distanceToA };
}

function enumerateBackwardFingerPaths(
  pose: MotionPose,
  startPoint: [number, number, number],
  precedingKinds: readonly MotionBone["kind"][],
  blockedBoneIndices: ReadonlySet<number>,
  maxPaths = 64,
): ReconstructedFingerPath[] {
  const walk = (
    point: [number, number, number],
    kindIndex: number,
    selectedIndices: number[],
    pointsFromTip: [number, number, number][],
    totalEndpointError: number,
  ): ReconstructedFingerPath[] => {
    if (kindIndex >= precedingKinds.length) {
      return [{ boneIndices: selectedIndices, pointsFromTip, totalEndpointError }];
    }
    const kind = precedingKinds[kindIndex]!;
    const results: ReconstructedFingerPath[] = [];
    for (let index = 0; index < pose.bones.length; index++) {
      if (blockedBoneIndices.has(index) || selectedIndices.includes(index)) continue;
      const bone = pose.bones[index]!;
      if (bone.kind !== kind) continue;
      const link = getBackwardBoneLink(bone, index, point);
      if (!link) continue;
      results.push(...walk(
        link.previousPoint,
        kindIndex + 1,
        [...selectedIndices, index],
        [...pointsFromTip, link.previousPoint],
        totalEndpointError + link.distance,
      ));
      if (results.length >= maxPaths) return results.slice(0, maxPaths);
    }
    return results;
  };
  return walk(startPoint, 0, [], [startPoint], 0);
}

function hasEngineBoneOrder(pose: MotionPose): boolean {
  if (pose.bones.length !== ENGINE_ORDERED_BONE_COUNT) return false;
  if (pose.bones[0]?.kind !== "forearm" || pose.bones[1]?.kind !== "forearm") return false;
  for (let index = 2; index <= 8; index++) {
    if (pose.bones[index]?.kind !== "carpal") return false;
  }
  for (const finger of DIGIT_ORDER) {
    const indices = ENGINE_FINGER_BONE_INDICES[finger]!;
    const kinds = ENGINE_FINGER_BONE_KINDS[finger]!;
    if (!indices.every((boneIndex, kindIndex) => pose.bones[boneIndex]?.kind === kinds[kindIndex])) {
      return false;
    }
  }
  return true;
}

function getOrderedFingerPath(
  pose: MotionPose,
  finger: number,
  tip: readonly [number, number, number],
): ReconstructedFingerPath | null {
  const indices = ENGINE_FINGER_BONE_INDICES[finger];
  const kinds = ENGINE_FINGER_BONE_KINDS[finger];
  if (!indices || !kinds || !hasEngineBoneOrder(pose)) return null;

  const backwardIndices = [...indices].reverse();
  const distalIndex = backwardIndices[0]!;
  const distal = pose.bones[distalIndex]!;
  if (distal.kind !== "distal" || dist3(distal.b, tip) > CHAIN_ENDPOINT_TOLERANCE_IN) return null;

  const pointsFromTip: [number, number, number][] = [distal.b, distal.a];
  let currentPoint = distal.a;
  let totalEndpointError = dist3(distal.b, tip);
  for (let pathIndex = 1; pathIndex < backwardIndices.length; pathIndex++) {
    const boneIndex = backwardIndices[pathIndex]!;
    const bone = pose.bones[boneIndex]!;
    const expectedKind = kinds[indices.length - 1 - pathIndex]!;
    if (bone.kind !== expectedKind) return null;
    const link = getBackwardBoneLink(bone, boneIndex, currentPoint);
    if (!link) return null;
    pointsFromTip.push(link.previousPoint);
    currentPoint = link.previousPoint;
    totalEndpointError += link.distance;
  }
  return { boneIndices: backwardIndices, pointsFromTip, totalEndpointError };
}

function resolveFingerPath(
  pose: MotionPose,
  finger: number,
  tip: readonly [number, number, number],
  blockedBoneIndices: ReadonlySet<number>,
): { path: ReconstructedFingerPath | null; diagnostic: FingerChainDiagnostic | null } {
  const orderedPath = getOrderedFingerPath(pose, finger, tip);
  if (orderedPath && orderedPath.boneIndices.every((index) => !blockedBoneIndices.has(index))) {
    return { path: orderedPath, diagnostic: null };
  }

  const distalCandidates = pose.bones
    .map((bone, index) => ({ bone, index, endpointError: dist3(bone.b, tip) }))
    .filter(({ bone, index, endpointError }) =>
      bone.kind === "distal" &&
      !blockedBoneIndices.has(index) &&
      endpointError <= CHAIN_ENDPOINT_TOLERANCE_IN,
    );
  const precedingKinds = finger === 1
    ? ["proximal", "metacarpal"] as const
    : ["middle", "proximal", "metacarpal"] as const;
  const paths: ReconstructedFingerPath[] = [];
  for (const distal of distalCandidates) {
    const tailPaths = enumerateBackwardFingerPaths(
      pose,
      distal.bone.a,
      precedingKinds,
      new Set([...blockedBoneIndices, distal.index]),
    );
    for (const tailPath of tailPaths) {
      paths.push({
        boneIndices: [distal.index, ...tailPath.boneIndices],
        pointsFromTip: [distal.bone.b, ...tailPath.pointsFromTip],
        totalEndpointError: distal.endpointError + tailPath.totalEndpointError,
      });
    }
  }

  if (paths.length === 0) {
    return {
      path: null,
      diagnostic: {
        finger,
        code: distalCandidates.length === 0 ? "missing-distal" : "disconnected-chain",
        message: distalCandidates.length === 0
          ? `Finger ${finger} has no distal bone whose endpoint matches its tip within ${CHAIN_ENDPOINT_TOLERANCE_IN} in.`
          : `Finger ${finger} has no complete connected phalanx and metacarpal path within ${CHAIN_ENDPOINT_TOLERANCE_IN} in.`,
      },
    };
  }

  paths.sort((a, b) => a.totalEndpointError - b.totalEndpointError);
  const bestError = paths[0]!.totalEndpointError;
  const bestPaths = paths.filter((path) => Math.abs(path.totalEndpointError - bestError) < 1e-9);
  const expected = hasEngineBoneOrder(pose) ? ENGINE_FINGER_BONE_INDICES[finger] : undefined;
  const expectedBackward = expected ? [...expected].reverse() : null;
  const orderMatched = expectedBackward
    ? bestPaths.filter((path) => path.boneIndices.every((index, pathIndex) => index === expectedBackward[pathIndex]))
    : [];
  if (orderMatched.length === 1) {
    return {
      path: orderMatched[0]!,
      diagnostic: {
        finger,
        code: "order-resolved-ambiguity",
        message: `Finger ${finger} required the verified MotionPose bone order to disambiguate an exact endpoint tie.`,
      },
    };
  }
  if (bestPaths.length === 1) return { path: bestPaths[0]!, diagnostic: null };

  return {
    path: null,
    diagnostic: {
      finger,
      code: "ambiguous-chain",
      message: `Finger ${finger} has ${bestPaths.length} equally close complete bone paths; no arbitrary path was selected.`,
    },
  };
}

/**
 * Reconstructs the full 3D anatomical hand chains in Three.js world space (inches)
 * directly from a `MotionPose`.
 */
export function reconstructHand3D(pose: MotionPose, hoverLift = 0): ReconstructedHand3D {
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

  const chains: Record<number, THREE.Vector3[]> = {};
  const chainDiagnostics: FingerChainDiagnostic[] = [];
  const usedBoneIndices = new Set<number>();
  const tips = pose.joints.filter((joint) => joint.kind === "tip");

  for (const [tipIndex, finger] of DIGIT_ORDER.entries()) {
    const tip = tips[tipIndex];
    if (!tip) {
      chainDiagnostics.push({
        finger,
        code: "missing-tip",
        message: `MotionPose has no ordered tip joint for finger ${finger}.`,
      });
      continue;
    }

    const resolved = resolveFingerPath(pose, finger, tip.point, usedBoneIndices);
    if (resolved.diagnostic) chainDiagnostics.push(resolved.diagnostic);
    if (!resolved.path) continue;

    for (const index of resolved.path.boneIndices) usedBoneIndices.add(index);
    chains[finger] = [...resolved.path.pointsFromTip]
      .reverse()
      .map((point) => posePointToWorld(point));
  }

  const clampedHover = Math.min(1.0, Math.max(0.0, hoverLift));
  if (clampedHover > 0) {
    const wristLift = 0.22 * clampedHover;
    wristR.y += wristLift;
    wristU.y += wristLift;
    wristCenter.y += wristLift;
    armEnd.y += wristLift;

    for (let f = 1; f <= 5; f++) {
      const chain = chains[f];
      if (!chain || chain.length < 4) continue;
      const tip = chain[chain.length - 1]!;
      const dip = chain[chain.length - 2]!;
      const targetHoverY = f === 1 ? 0.38 : 0.32;
      const tipDelta = targetHoverY - tip.y;
      tip.y += tipDelta > 0 ? tipDelta * clampedHover : 0.08 * clampedHover;

      const targetDipY = 0.44;
      const dipDelta = targetDipY - dip.y;
      dip.y += dipDelta > 0 ? dipDelta * 0.8 * clampedHover : 0.12 * clampedHover;

      if (chain.length >= 5) {
        const pip = chain[chain.length - 3]!;
        const targetPipY = 0.58;
        const pipDelta = targetPipY - pip.y;
        pip.y += pipDelta > 0 ? pipDelta * 0.6 * clampedHover : 0.15 * clampedHover;
      }
      const mcp = chain[1]!;
      mcp.y += 0.18 * clampedHover;
      const base = chain[0]!;
      base.y += 0.20 * clampedHover;
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
    chainDiagnostics,
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
  /** Native joint origin expressed in the source wrist's bind-local frame (inches). */
  bindRootInWrist: THREE.Vector3;
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

export interface ParsedHandGlbRig {
  skinnedMesh: THREE.SkinnedMesh;
  bonesByName: Map<string, GlbBoneMetadata>;
  vertexAnatomy: VertexAnatomyInfo[];
  wristBoundaryVertexIndices: number[];
  /** Bounded palmar support samples, grouped by MotionPose finger number (1..5). */
  contactSupportVertexIndicesByFinger?: number[][];
}

function selectImprovedContactSupportVertices(
  geometry: THREE.BufferGeometry,
  bones: readonly THREE.Bone[],
  bonesByName: ReadonlyMap<string, GlbBoneMetadata>,
  hand: "left" | "right",
  canonicalRestDorsalAxis: readonly [number, number, number],
): number[][] {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  const dorsalAxis = new THREE.Vector3(
    hand === "right" ? -canonicalRestDorsalAxis[0] : canonicalRestDorsalAxis[0],
    canonicalRestDorsalAxis[1],
    canonicalRestDorsalAxis[2],
  ).normalize();
  const out: number[][] = Array.from({ length: 6 }, () => []);
  const names = ["thumb", "index-finger", "middle-finger", "ring-finger", "pinky-finger"];
  const vector = new THREE.Vector3();
  const candidatePositions: Array<{ index: number; distanceSq: number; palmar: boolean }> = [];

  for (let finger = 1; finger <= 5; finger++) {
    const prefix = names[finger - 1]!;
    const distalName = finger === 1 ? "thumb-phalanx-distal" : `${prefix}-phalanx-distal`;
    const tipName = `${prefix}-tip`;
    const distalBone = bonesByName.get(distalName)?.bone;
    const tipMeta = bonesByName.get(tipName);
    const distalIndex = distalBone ? bones.indexOf(distalBone) : -1;
    if (!position || !normal || !skinIndex || !skinWeight || distalIndex < 0 || !tipMeta) continue;

    const tipPosition = tipMeta.bindPositionM.clone().multiplyScalar(METERS_TO_INCHES);
    candidatePositions.length = 0;
    for (let vertex = 0; vertex < position.count; vertex++) {
      let distalWeight = 0;
      for (let influence = 0; influence < 4; influence++) {
        if (skinIndex.getComponent(vertex, influence) === distalIndex) {
          distalWeight += skinWeight.getComponent(vertex, influence);
        }
      }
      if (distalWeight < 0.2) continue;

      vector.set(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
      const isPalmar = vector.dot(dorsalAxis) < -0.15;
      const pointDistanceSq = tipPosition.distanceToSquared(
        vector.set(position.getX(vertex), position.getY(vertex), position.getZ(vertex)),
      );
      candidatePositions.push({ index: vertex, distanceSq: pointDistanceSq, palmar: isPalmar });
    }

    const palmarCandidates = candidatePositions.filter((candidate) => candidate.palmar);
    const selectedFrom = palmarCandidates.length >= 8 ? palmarCandidates : candidatePositions;
    selectedFrom.sort((a, b) => a.distanceSq - b.distanceSq);
    if (selectedFrom.length <= 24) {
      out[finger] = selectedFrom.map((candidate) => candidate.index);
      continue;
    }

    // First stay near the terminal phalanx cap, then spread samples across its
    // palmar surface so the runtime tests a small, stable support set.
    const nearby = selectedFrom.slice(0, Math.min(96, selectedFrom.length));
    out[finger] = Array.from({ length: 24 }, (_, sample) => {
      const candidateIndex = Math.round(sample * (nearby.length - 1) / 23);
      return nearby[candidateIndex]!.index;
    });
  }
  return out;
}

function selectAnatomicalContactSupportVertices(
  geometry: THREE.BufferGeometry,
  bones: readonly THREE.Bone[],
  bonesByName: ReadonlyMap<string, GlbBoneMetadata>,
  vertexAnatomy: readonly VertexAnatomyInfo[],
): number[][] {
  const position = geometry.getAttribute("position");
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  const out: number[][] = Array.from({ length: 6 }, () => []);
  const names = ["thumb", "index-finger", "middle-finger", "ring-finger", "pinky-finger"];
  const point = new THREE.Vector3();

  for (let finger = 1; finger <= 5; finger++) {
    const prefix = names[finger - 1]!;
    const distalName = finger === 1 ? "thumb-phalanx-distal" : `${prefix}-phalanx-distal`;
    const distalBone = bonesByName.get(distalName)?.bone;
    const tipMeta = bonesByName.get(`${prefix}-tip`);
    const distalIndex = distalBone ? bones.indexOf(distalBone) : -1;
    if (!position || !skinIndex || !skinWeight || distalIndex < 0 || !tipMeta) continue;

    const tipPosition = tipMeta.bindPositionM.clone().multiplyScalar(METERS_TO_INCHES);
    const candidates: Array<{ index: number; distanceSq: number; palmar: boolean }> = [];
    for (let vertex = 0; vertex < position.count; vertex++) {
      let distalWeight = 0;
      for (let influence = 0; influence < 4; influence++) {
        if (skinIndex.getComponent(vertex, influence) === distalIndex) {
          distalWeight += skinWeight.getComponent(vertex, influence);
        }
      }
      if (distalWeight < 0.2) continue;

      point.fromBufferAttribute(position, vertex);
      candidates.push({
        index: vertex,
        distanceSq: tipPosition.distanceToSquared(point),
        palmar: (vertexAnatomy[vertex]?.dorsalFactor ?? 0) < -0.15,
      });
    }

    const palmarCandidates = candidates.filter((candidate) => candidate.palmar);
    const selectedFrom = palmarCandidates.length >= 8 ? palmarCandidates : candidates;
    selectedFrom.sort((a, b) => a.distanceSq - b.distanceSq || a.index - b.index);
    if (selectedFrom.length <= 24) {
      out[finger] = selectedFrom.map((candidate) => candidate.index);
      continue;
    }

    const nearby = selectedFrom.slice(0, Math.min(96, selectedFrom.length));
    out[finger] = Array.from({ length: 24 }, (_, sample) => {
      const candidateIndex = Math.round(sample * (nearby.length - 1) / 23);
      return nearby[candidateIndex]!.index;
    });
  }
  return out;
}

interface ImprovedDistalContactFrame {
  boneName: string;
  prefix: string;
  finger: number;
  mcp: THREE.Vector3;
  pip: THREE.Vector3;
  dip: THREE.Vector3;
  tip: THREE.Vector3;
  start: THREE.Vector3;
  end: THREE.Vector3;
  hinge: THREE.Vector3;
  tipPoint: THREE.Vector3;
  thicknessScale: number;
  active: boolean;
}

export interface HandModelRuntimeDependencies {
  assetLoader: Pick<ImprovedHandAssetLoader, "load" | "getCacheStats">;
  textureCache: Pick<ImprovedHandTextureCache, "acquire" | "getCacheStats">;
}

interface GlbJsonHeader {
  nodes: Array<{
    name: string;
    mesh?: number;
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
    matrix?: number[];
    children?: number[];
  }>;
  meshes: Array<{
    primitives: Array<{
      attributes: {
        POSITION: number;
        NORMAL: number;
        TEXCOORD_0: number;
        TANGENT?: number;
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
  scene?: number;
  scenes?: Array<{ nodes: number[] }>;
  accessors: Array<{
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
  }>;
  bufferViews: Array<{
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
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
const NEXT_BONE_NAMES = Object.keys(NEXT_BONE_BY_NAME);
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

let cachedAnatomicalLeftGlbBuffer: ArrayBuffer | null = null;
let cachedAnatomicalRightGlbBuffer: ArrayBuffer | null = null;
let preloadPromise: Promise<void> | null = null;

interface NodeFsModule {
  existsSync(path: string): boolean;
  readFileSync(path: string): { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
}

interface NodePathModule {
  resolve(...paths: string[]): string;
}

interface NodeGlobalEnvironment {
  require?: {
    (moduleName: "fs"): NodeFsModule;
    (moduleName: "path"): NodePathModule;
    (moduleName: string): unknown;
  };
  module?: {
    require?: {
      (moduleName: "fs"): NodeFsModule;
      (moduleName: "path"): NodePathModule;
      (moduleName: string): unknown;
    };
  };
  process?: {
    cwd?: () => string;
    getBuiltinModule?: (moduleName: string) => unknown;
  };
}

function loadGlbBufferFromNodeSync(filename: string): ArrayBuffer | null {
  try {
    const globalObj = globalThis as unknown as NodeGlobalEnvironment;
    const req = (globalObj.require ||
      (typeof globalObj.module !== "undefined" && globalObj.module.require) ||
      (globalObj.process?.getBuiltinModule
        ? (mod: string) => globalObj.process?.getBuiltinModule?.(mod)
        : undefined)) as NodeGlobalEnvironment["require"];
    if (!req) return null;
    const fs = req("fs");
    const path = req("path");
    const cwd = typeof globalObj.process !== "undefined" && globalObj.process.cwd ? globalObj.process.cwd() : ".";
    const candidates = [
      path.resolve(cwd, "apps/client/public/models/hands", filename),
      path.resolve(cwd, "public/models/hands", filename),
      path.resolve(cwd, "models/hands", filename),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        const ab = new ArrayBuffer(buf.byteLength);
        new Uint8Array(ab).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        return ab;
      }
    }
  } catch {
    // Ignore in browser
  }
  return null;
}

export async function preloadAnatomicalHandModels(): Promise<void> {
  if (cachedAnatomicalLeftGlbBuffer && cachedAnatomicalRightGlbBuffer) {
    return;
  }
  if (preloadPromise) {
    return preloadPromise;
  }
  preloadPromise = (async () => {
    if (!cachedAnatomicalLeftGlbBuffer) {
      cachedAnatomicalLeftGlbBuffer = loadGlbBufferFromNodeSync("anatomical_left.glb");
    }
    if (!cachedAnatomicalRightGlbBuffer) {
      cachedAnatomicalRightGlbBuffer = loadGlbBufferFromNodeSync("anatomical_right.glb");
    }
    if (
      typeof fetch !== "undefined" &&
      (!cachedAnatomicalLeftGlbBuffer || !cachedAnatomicalRightGlbBuffer)
    ) {
      try {
        const [leftRes, rightRes] = await Promise.all([
          !cachedAnatomicalLeftGlbBuffer
            ? fetch(releaseAssetUrl("models/hands/anatomical_left.glb").href)
            : null,
          !cachedAnatomicalRightGlbBuffer
            ? fetch(releaseAssetUrl("models/hands/anatomical_right.glb").href)
            : null,
        ]);
        if (leftRes && leftRes.ok) {
          cachedAnatomicalLeftGlbBuffer = await leftRes.arrayBuffer();
        }
        if (rightRes && rightRes.ok) {
          cachedAnatomicalRightGlbBuffer = await rightRes.arrayBuffer();
        }
      } catch {
        // Fall back gracefully if fetch fails
      }
    }
  })();
  return preloadPromise;
}

export function getAnatomicalHandGlbArrayBuffer(hand: "left" | "right"): ArrayBuffer | null {
  if (hand === "left") {
    if (cachedAnatomicalLeftGlbBuffer) return cachedAnatomicalLeftGlbBuffer;
    cachedAnatomicalLeftGlbBuffer = loadGlbBufferFromNodeSync("anatomical_left.glb");
    return cachedAnatomicalLeftGlbBuffer;
  }
  if (cachedAnatomicalRightGlbBuffer) return cachedAnatomicalRightGlbBuffer;
  cachedAnatomicalRightGlbBuffer = loadGlbBufferFromNodeSync("anatomical_right.glb");
  return cachedAnatomicalRightGlbBuffer;
}

/** Finds the closed, open-edge loop nearest the GLB wrist joint. */
function findWristBoundaryVertexIndices(
  geometry: THREE.BufferGeometry,
  wristBindPosition: THREE.Vector3,
): number[] {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  if (!index || !position) throw new Error("Hand GLB is missing indexed position geometry");

  const buildLoops = (useSpatial: boolean): number[][] => {
    const spatialKeyToId = new Map<string, number>();
    const spatialIdToFirstVertex: number[] = [];
    const vertexToSpatialId: number[] = new Array(position.count);

    if (useSpatial) {
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        const y = position.getY(i);
        const z = position.getZ(i);
        const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
        let sId = spatialKeyToId.get(key);
        if (sId === undefined) {
          sId = spatialIdToFirstVertex.length;
          spatialKeyToId.set(key, sId);
          spatialIdToFirstVertex.push(i);
        }
        vertexToSpatialId[i] = sId;
      }
    }

    const edgeUses = new Map<string, { a: number; b: number; count: number }>();
    const recordEdge = (a: number, b: number) => {
      if (a === b) return;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = `${lo}_${hi}`;
      const edge = edgeUses.get(key);
      if (edge) edge.count++;
      else edgeUses.set(key, { a: lo, b: hi, count: 1 });
    };

    for (let i = 0; i < index.count; i += 3) {
      const idxA = index.getX(i);
      const idxB = index.getX(i + 1);
      const idxC = index.getX(i + 2);
      const a = useSpatial ? vertexToSpatialId[idxA]! : idxA;
      const b = useSpatial ? vertexToSpatialId[idxB]! : idxB;
      const c = useSpatial ? vertexToSpatialId[idxC]! : idxC;
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
      if (loop.length === component.length) {
        loops.push(useSpatial ? loop.map((sId) => spatialIdToFirstVertex[sId]!) : loop);
      }
    }
    return loops;
  };

  let loops = buildLoops(true);
  if (loops.length === 0) {
    loops = buildLoops(false);
  }

  let nearest: number[] | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const center = new THREE.Vector3();
  const tempPos = new THREE.Vector3();
  for (const loop of loops) {
    center.set(0, 0, 0);
    for (const vIdx of loop) {
      tempPos.fromBufferAttribute(position, vIdx);
      center.add(tempPos);
    }
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

interface ParsedGlbSkeleton {
  bones: THREE.Bone[];
  boneInverses: THREE.Matrix4[];
  bonesByName: Map<string, GlbBoneMetadata>;
  boneMetaBySkinIdx: GlbBoneMetadata[];
  wristBindPosition: THREE.Vector3;
  wristBindQuat: THREE.Quaternion;
  wristBindQuatInv: THREE.Quaternion;
  json: GlbJsonHeader;
  getTypedArray: (accIdx: number) => Float32Array | Uint16Array | Uint8Array | Uint32Array;
}

export function parseGlbSkeletonFromBuffer(
  hand: "left" | "right",
  parentGroup: THREE.Group,
  buffer: ArrayBuffer,
  useNativeBindLengths = false,
): ParsedGlbSkeleton {
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
    if (acc.componentType === 5125) {
      return new Uint32Array(buffer.slice(byteOffset, byteOffset + len * 4));
    }
    return new Uint8Array(buffer.slice(byteOffset, byteOffset + len));
  };

  const skinDef = json.skins[0]!;
  const ibmRaw = getTypedArray(skinDef.inverseBindMatrices) as Float32Array;

  const nodeByName = new Map(json.nodes.map((n) => [n.name, n]));
  const wristNode = nodeByName.get("wrist")!;
  const wristBindPositionM = new THREE.Vector3(...(wristNode.translation ?? [0, 0, 0]));
  const wristBindPosition = wristBindPositionM.clone().multiplyScalar(METERS_TO_INCHES);
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
    const nativeBindLengthIn = nextNode?.translation
      ? bindPosM.distanceTo(new THREE.Vector3(...nextNode.translation)) * METERS_TO_INCHES
      : 0.5;
    const bindLengthIn = useNativeBindLengths
      ? Math.max(1e-6, nativeBindLengthIn)
      : Math.max(0.25, nativeBindLengthIn);

    const meta: GlbBoneMetadata = {
      bone,
      name: node.name,
      bindPositionM: bindPosM,
      bindQuaternion: bindQuat,
      bindRootInWrist: bindPosM.clone()
        .sub(wristBindPositionM)
        .multiplyScalar(METERS_TO_INCHES)
        .applyQuaternion(wristBindQuatInv),
      localUpInWrist,
      localLateralInWrist,
      bindLengthIn,
    };
    bonesByName.set(node.name, meta);
    boneMetaBySkinIdx.push(meta);
  });

  return {
    bones,
    boneInverses,
    bonesByName,
    boneMetaBySkinIdx,
    wristBindPosition,
    wristBindQuat,
    wristBindQuatInv,
    json,
    getTypedArray,
  };
}

function parseGlbSkeleton(
  hand: "left" | "right",
  parentGroup: THREE.Group,
): ParsedGlbSkeleton {
  return parseGlbSkeletonFromBuffer(hand, parentGroup, getHandGlbArrayBuffer(hand));
}

export function parseHandGlbRig(
  hand: "left" | "right",
  skinMaterial: THREE.MeshPhysicalMaterial,
  parentGroup: THREE.Group,
): ParsedHandGlbRig {
  const {
    bones,
    boneInverses,
    bonesByName,
    boneMetaBySkinIdx,
    wristBindPosition,
    json,
    getTypedArray,
  } = parseGlbSkeleton(hand, parentGroup);

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

  // Precompute per-vertex anatomical classification for Subsurface Scattering (SSS) vertex colors & sculpting
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

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeights, 4));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  const skinnedMesh = new THREE.SkinnedMesh(geometry, skinMaterial);
  skinnedMesh.castShadow = true;
  skinnedMesh.receiveShadow = true;
  skinnedMesh.frustumCulled = false;

  const skeleton = new THREE.Skeleton(bones, boneInverses);
  skinnedMesh.bind(skeleton, new THREE.Matrix4());
  parentGroup.add(skinnedMesh);

  const wristBoundaryVertexIndices = findWristBoundaryVertexIndices(geometry, wristBindPosition);
  geometry.userData.wristBoundaryVertexIndices = wristBoundaryVertexIndices;
  const contactSupportVertexIndicesByFinger = selectImprovedContactSupportVertices(
    geometry,
    bones,
    bonesByName,
    hand,
    [0, 1, 0],
  );

  return {
    skinnedMesh,
    bonesByName,
    vertexAnatomy,
    wristBoundaryVertexIndices,
    contactSupportVertexIndicesByFinger,
  };
}

export interface SubdividedHandGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  skinIndices: Uint16Array;
  skinWeights: Float32Array;
  indices: Uint16Array;
}

/**
 * Organic 1-to-4 triangular subdivision engine for high-poly anatomical hand mesh.
 * Takes the watertight base hand mesh (1360 vertices, 2314 triangles) and generates
 * a smooth, organic high-poly mesh (~5,200+ vertices, 9,256 triangles) with continuous
 * cylindrical rounding, blended skin weights, and 100% 25-bone skeletal compatibility.
 */
export function subdivideHandMesh(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  skinIndices: ArrayLike<number>,
  skinWeights: Float32Array,
  indices: ArrayLike<number>,
): SubdividedHandGeometry {
  const baseVertexCount = positions.length / 3;
  const baseTriCount = indices.length / 3;
  const newTriCount = baseTriCount * 4;

  const maxVertices = baseVertexCount + baseTriCount * 3;
  const outPositions = new Float32Array(maxVertices * 3);
  const outNormals = new Float32Array(maxVertices * 3);
  const outUvs = new Float32Array(maxVertices * 2);
  const outSkinIndices = new Uint16Array(maxVertices * 4);
  const outSkinWeights = new Float32Array(maxVertices * 4);
  const outIndices = new Uint16Array(newTriCount * 3);

  outPositions.set(positions);
  outNormals.set(normals);
  outUvs.set(uvs);
  for (let i = 0; i < baseVertexCount * 4; i++) {
    outSkinIndices[i] = skinIndices[i]!;
    outSkinWeights[i] = skinWeights[i]!;
  }

  let nextVertexIdx = baseVertexCount;
  const edgeCache = new Map<number, number>();

  function getEdgeMidpoint(i: number, j: number): number {
    const min = i < j ? i : j;
    const max = i < j ? j : i;
    const key = min * 65536 + max;
    const cached = edgeCache.get(key);
    if (cached !== undefined) return cached;

    const newIdx = nextVertexIdx++;

    const pAx = outPositions[i * 3]!;
    const pAy = outPositions[i * 3 + 1]!;
    const pAz = outPositions[i * 3 + 2]!;

    const pBx = outPositions[j * 3]!;
    const pBy = outPositions[j * 3 + 1]!;
    const pBz = outPositions[j * 3 + 2]!;

    const nAx = outNormals[i * 3]!;
    const nAy = outNormals[i * 3 + 1]!;
    const nAz = outNormals[i * 3 + 2]!;

    const nBx = outNormals[j * 3]!;
    const nBy = outNormals[j * 3 + 1]!;
    const nBz = outNormals[j * 3 + 2]!;

    let avgNx = nAx + nBx;
    let avgNy = nAy + nBy;
    let avgNz = nAz + nBz;
    const avgNLen = Math.hypot(avgNx, avgNy, avgNz);
    if (avgNLen > 1e-5) {
      avgNx /= avgNLen;
      avgNy /= avgNLen;
      avgNz /= avgNLen;
    } else {
      avgNx = 0;
      avgNy = 1;
      avgNz = 0;
    }

    // Organic cylindrical rounding displacement based on vertex normals:
    // Transforms faceted tubular fingers into smooth organic cylinders without polygon stepping.
    const evX = pBx - pAx;
    const evY = pBy - pAy;
    const evZ = pBz - pAz;
    const dotDiff = evX * (nBx - nAx) + evY * (nBy - nAy) + evZ * (nBz - nAz);
    let disp = 0.125 * dotDiff;
    disp = Math.max(-0.015, Math.min(0.035, disp));

    outPositions[newIdx * 3] = 0.5 * (pAx + pBx) + disp * avgNx;
    outPositions[newIdx * 3 + 1] = 0.5 * (pAy + pBy) + disp * avgNy;
    outPositions[newIdx * 3 + 2] = 0.5 * (pAz + pBz) + disp * avgNz;

    outNormals[newIdx * 3] = avgNx;
    outNormals[newIdx * 3 + 1] = avgNy;
    outNormals[newIdx * 3 + 2] = avgNz;

    outUvs[newIdx * 2] = 0.5 * (outUvs[i * 2]! + outUvs[j * 2]!);
    outUvs[newIdx * 2 + 1] = 0.5 * (outUvs[i * 2 + 1]! + outUvs[j * 2 + 1]!);

    // Blend skin weights & skin indices from endpoints A and B
    const boneWeights = new Map<number, number>();
    for (let k = 0; k < 4; k++) {
      const wA = outSkinWeights[i * 4 + k]!;
      if (wA > 0) {
        const bA = outSkinIndices[i * 4 + k]!;
        boneWeights.set(bA, (boneWeights.get(bA) ?? 0) + 0.5 * wA);
      }
      const wB = outSkinWeights[j * 4 + k]!;
      if (wB > 0) {
        const bB = outSkinIndices[j * 4 + k]!;
        boneWeights.set(bB, (boneWeights.get(bB) ?? 0) + 0.5 * wB);
      }
    }

    const sortedBones = Array.from(boneWeights.entries()).sort((a, b) => b[1] - a[1]);
    let totalWeight = 0;
    const count = Math.min(4, sortedBones.length);
    for (let k = 0; k < count; k++) {
      totalWeight += sortedBones[k]![1];
    }

    if (totalWeight < 1e-6) {
      outSkinIndices[newIdx * 4] = outSkinIndices[i * 4]!;
      outSkinWeights[newIdx * 4] = 1.0;
      for (let k = 1; k < 4; k++) {
        outSkinIndices[newIdx * 4 + k] = 0;
        outSkinWeights[newIdx * 4 + k] = 0;
      }
    } else {
      for (let k = 0; k < 4; k++) {
        if (k < count) {
          outSkinIndices[newIdx * 4 + k] = sortedBones[k]![0];
          outSkinWeights[newIdx * 4 + k] = sortedBones[k]![1] / totalWeight;
        } else {
          outSkinIndices[newIdx * 4 + k] = 0;
          outSkinWeights[newIdx * 4 + k] = 0;
        }
      }
    }

    edgeCache.set(key, newIdx);
    return newIdx;
  }

  let outIdx = 0;
  for (let t = 0; t < baseTriCount; t++) {
    const iA = indices[t * 3]!;
    const iB = indices[t * 3 + 1]!;
    const iC = indices[t * 3 + 2]!;

    const midAB = getEdgeMidpoint(iA, iB);
    const midBC = getEdgeMidpoint(iB, iC);
    const midCA = getEdgeMidpoint(iC, iA);

    // 1: (A, midAB, midCA)
    outIndices[outIdx++] = iA;
    outIndices[outIdx++] = midAB;
    outIndices[outIdx++] = midCA;

    // 2: (midAB, B, midBC)
    outIndices[outIdx++] = midAB;
    outIndices[outIdx++] = iB;
    outIndices[outIdx++] = midBC;

    // 3: (midCA, midBC, C)
    outIndices[outIdx++] = midCA;
    outIndices[outIdx++] = midBC;
    outIndices[outIdx++] = iC;

    // 4: (midAB, midBC, midCA)
    outIndices[outIdx++] = midAB;
    outIndices[outIdx++] = midBC;
    outIndices[outIdx++] = midCA;
  }

  return {
    positions: outPositions.slice(0, nextVertexIdx * 3),
    normals: outNormals.slice(0, nextVertexIdx * 3),
    uvs: outUvs.slice(0, nextVertexIdx * 2),
    skinIndices: outSkinIndices.slice(0, nextVertexIdx * 4),
    skinWeights: outSkinWeights.slice(0, nextVertexIdx * 4),
    indices: outIndices,
  };
}

function buildProceduralSubdividedHandRig(
  hand: "left" | "right",
  skinMaterial: THREE.MeshPhysicalMaterial,
  parentGroup: THREE.Group,
): ParsedHandGlbRig {
  const {
    bones,
    boneInverses,
    bonesByName,
    boneMetaBySkinIdx,
    wristBindPosition,
    json,
    getTypedArray,
  } = parseGlbSkeleton(hand, parentGroup);

  const prim = json.meshes[0]!.primitives[0]!;
  const rawPositions = getTypedArray(prim.attributes.POSITION) as Float32Array;
  const basePositions = new Float32Array(rawPositions.length);
  for (let i = 0; i < rawPositions.length; i++) {
    basePositions[i] = rawPositions[i]! * METERS_TO_INCHES;
  }
  const baseNormals = getTypedArray(prim.attributes.NORMAL) as Float32Array;
  const baseUvs = getTypedArray(prim.attributes.TEXCOORD_0) as Float32Array;
  const baseSkinIndices = getTypedArray(prim.attributes.JOINTS_0);
  const baseSkinWeights = getTypedArray(prim.attributes.WEIGHTS_0) as Float32Array;
  const baseIndices = getTypedArray(prim.indices) as Uint16Array;

  // 1. High-Poly Organic Triangular Subdivision (1 to 4)
  const sub = subdivideHandMesh(
    basePositions,
    baseNormals,
    baseUvs,
    baseSkinIndices,
    baseSkinWeights,
    baseIndices,
  );

  const positions = sub.positions;
  const normals = sub.normals;
  const uvs = sub.uvs;
  const skinIndices = sub.skinIndices;
  const skinWeights = sub.skinWeights;
  const indices = sub.indices;

  const vCount = positions.length / 3;
  const colors = new Float32Array(vCount * 3);
  colors.fill(0.45);

  // Initial geometry used to detect boundary edge loop on high-poly subdivided mesh
  const tempGeometry = new THREE.BufferGeometry();
  tempGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  tempGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
  const wristBoundaryVertexIndices = findWristBoundaryVertexIndices(tempGeometry, wristBindPosition);

  // 2. Wrist Straightening & Notch Removal
  const isBoundaryVertex = new Uint8Array(vCount);
  for (let i = 0; i < vCount; i++) {
    const px = positions[i * 3]!;
    const py = positions[i * 3 + 1]!;
    const pz = positions[i * 3 + 2]!;
    for (const bIdx of wristBoundaryVertexIndices) {
      if (
        Math.abs(positions[bIdx * 3]! - px) < 1e-4 &&
        Math.abs(positions[bIdx * 3 + 1]! - py) < 1e-4 &&
        Math.abs(positions[bIdx * 3 + 2]! - pz) < 1e-4
      ) {
        isBoundaryVertex[i] = 1;
        break;
      }
    }
  }

  let maxBoundaryY = -Infinity;
  for (const bIdx of wristBoundaryVertexIndices) {
    const y = positions[bIdx * 3 + 1]!;
    if (y > maxBoundaryY) maxBoundaryY = y;
  }
  const targetWristY = Math.max(3.10, maxBoundaryY + 0.024);

  for (let i = 0; i < vCount; i++) {
    const px = positions[i * 3]!;
    const py = positions[i * 3 + 1]!;
    const pz = positions[i * 3 + 2]!;

    if (isBoundaryVertex[i]) {
      positions[i * 3 + 1] = targetWristY;
    } else if (py > 2.15) {
      let weightSum = 0;
      let weightedDeltaY = 0;
      for (const bIdx of wristBoundaryVertexIndices) {
        const dx = positions[bIdx * 3]! - px;
        const dz = positions[bIdx * 3 + 2]! - pz;
        const distSq = dx * dx + dz * dz + 1e-4;
        const w = 1 / distSq;
        weightSum += w;
        weightedDeltaY += w * (targetWristY - positions[bIdx * 3 + 1]!);
      }
      const deltaY = weightedDeltaY / weightSum;
      const t = Math.max(0, Math.min(1, (py - 2.15) / (targetWristY - 2.15)));
      const smoothT = t * t * (3 - 2 * t);
      positions[i * 3 + 1] += deltaY * smoothT;
    }
  }

  // 3. High-Resolution Anatomical Sculpting
  const vertexAnatomy: VertexAnatomyInfo[] = new Array(vCount);
  const nTmp = new THREE.Vector3();
  const posTmp = new THREE.Vector3();

  for (let i = 0; i < vCount; i++) {
    nTmp.set(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
    posTmp.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);

    let dominantSkinIdx = 0;
    let maxW = -1;
    let tipWeight = 0;
    let pipDipWeight = 0;
    let mcpWeight = 0;
    let metacarpalWeight = 0;
    let thumbMetaWeight = 0;
    let pinkyMetaWeight = 0;

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
      if (bName.endsWith("-metacarpal")) {
        metacarpalWeight += w;
      }
      if (bName === "thumb-metacarpal" || bName === "thumb-phalanx-proximal") {
        thumbMetaWeight += w;
      }
      if (bName === "pinky-finger-metacarpal") {
        pinkyMetaWeight += w;
      }
    }

    const domMeta = boneMetaBySkinIdx[dominantSkinIdx]!;
    const localNormal = nTmp.clone().applyQuaternion(domMeta.bindQuaternion.clone().invert());
    const dorsalFactor = Math.max(-1, Math.min(1, localNormal.y));
    const lateralFactor = Math.max(0, Math.min(1, Math.abs(localNormal.x)));

    if (!isBoundaryVertex[i]) {
      // a) MCP Knuckle Joint Domes (Classical Pianist Arched Knuckles)
      // Prominent rounded knuckle domes (+0.075 to +0.090 in)
      const mcpInfluence = mcpWeight * 0.8 + metacarpalWeight * 0.5;
      if (mcpInfluence > 0.15 && dorsalFactor > 0.20) {
        const dorsalT = Math.min(1.0, (dorsalFactor - 0.20) / 0.65);
        const mcpT = Math.min(1.0, (mcpInfluence - 0.15) / 0.50);
        const knuckleDisp = (0.075 + 0.015 * dorsalT) * mcpT * dorsalT;
        posTmp.addScaledVector(nTmp, knuckleDisp);
      }

      // b) Dorsal Extensor Tendons (Extensor digitorum & pollicis) & Intermetacarpal Valleys
      // Tendon ridges (+0.025 to +0.030 in) along metacarpals 2..5 toward knuckles
      if (metacarpalWeight > 0.15 && thumbMetaWeight < 0.25 && dorsalFactor > 0.20) {
        const dFactor = Math.min(1.0, (dorsalFactor - 0.20) / 0.65);
        const metaT = Math.min(1.0, (metacarpalWeight - 0.15) / 0.50);
        if (lateralFactor < 0.42) {
          // Central tendon crest
          const crestT = Math.cos((lateralFactor / 0.42) * Math.PI * 0.5);
          const tendonDisp = 0.028 * metaT * dFactor * crestT;
          posTmp.addScaledVector(nTmp, tendonDisp);
        } else if (lateralFactor > 0.55 && posTmp.y > 0.2 && posTmp.y < 2.0) {
          // Intermetacarpal valley between tendon cords
          const valleyT = Math.min(1.0, (lateralFactor - 0.55) / 0.35);
          posTmp.addScaledVector(nTmp, -0.015 * metaT * dFactor * valleyT);
        }
      }

      // Thumb extensor pollicis tendon ridge
      if (thumbMetaWeight > 0.25 && dorsalFactor > 0.25 && lateralFactor < 0.45) {
        const dFactor = Math.min(1.0, (dorsalFactor - 0.25) / 0.65);
        const thumbT = Math.min(1.0, (thumbMetaWeight - 0.25) / 0.50);
        const crestT = Math.cos((lateralFactor / 0.45) * Math.PI * 0.5);
        posTmp.addScaledVector(nTmp, 0.022 * thumbT * dFactor * crestT);
      }

      // c) Wrist Ulnar Styloid Process (Distinct anatomical lateral bone bump on pinky/ulnar side)
      // Located at the wrist margin: posTmp.y around 2.2 to 2.8, on ulnar side (posTmp.z > 0.45)
      if (posTmp.y >= 2.15 && posTmp.y <= 2.95 && posTmp.z > 0.45) {
        const styloidY = Math.sin(((posTmp.y - 2.15) / 0.80) * Math.PI);
        const styloidZ = Math.min(1.0, (posTmp.z - 0.45) / 0.55);
        const ulnarFactor = Math.max(0, (dorsalFactor + 0.3) / 1.1) * Math.max(0, (lateralFactor - 0.15) / 0.7);
        if (ulnarFactor > 0) {
          posTmp.addScaledVector(nTmp, 0.048 * styloidY * styloidZ * Math.min(1.0, ulnarFactor));
        }
      }

      // d) Interphalangeal Joints (PIP & DIP Articulation)
      // Knuckle pads and lateral condylar widenings (+0.035 in)
      if (pipDipWeight > 0.25) {
        const pipDipT = Math.min(1.0, (pipDipWeight - 0.25) / 0.55);
        if (dorsalFactor > 0.15) {
          const dFactor = Math.min(1.0, (dorsalFactor - 0.15) / 0.70);
          posTmp.addScaledVector(nTmp, 0.035 * pipDipT * dFactor);
        }
        if (lateralFactor > 0.20) {
          const latT = Math.min(1.0, (lateralFactor - 0.20) / 0.65);
          posTmp.addScaledVector(nTmp, 0.035 * pipDipT * latT);
        }
      }

      // e) Volar Pulp Pads (Fleshy Touchpads striking keys)
      // Fleshy, rounded palmar pulp pads on digits 1-5 (+0.055 in)
      if (tipWeight > 0.25 && dorsalFactor < -0.10) {
        const tipT = Math.min(1.0, (tipWeight - 0.25) / 0.55);
        const palmarT = Math.min(1.0, (-dorsalFactor - 0.10) / 0.70);
        posTmp.addScaledVector(nTmp, 0.055 * tipT * palmarT);
      }

      // f) Recessed Nail Beds & Cuticle Folds (Eponychium & Paronychium)
      // Depress nail bed by -0.028 in and elevate cuticle & lateral folds by +0.024 in
      if (tipWeight > 0.32 && dorsalFactor > 0.20) {
        const tipT = Math.min(1.0, (tipWeight - 0.32) / 0.48);
        const dorsalT = Math.min(1.0, (dorsalFactor - 0.20) / 0.60);

        if (lateralFactor < 0.40) {
          // Central recessed nail bed
          const centerT = Math.cos((lateralFactor / 0.40) * Math.PI * 0.5);
          posTmp.addScaledVector(nTmp, -0.028 * tipT * dorsalT * centerT);
        } else if (lateralFactor >= 0.35 && lateralFactor <= 0.75) {
          // Lateral nail fold (paronychium) perimeter wall
          const foldT = Math.sin(((lateralFactor - 0.35) / 0.40) * Math.PI);
          posTmp.addScaledVector(nTmp, 0.024 * tipT * dorsalT * foldT);
        }
      }

      // Proximal cuticle wall (eponychium fold)
      if (tipWeight >= 0.28 && tipWeight <= 0.46 && dorsalFactor > 0.28 && lateralFactor < 0.45) {
        const cuticleT = Math.sin(((tipWeight - 0.28) / 0.18) * Math.PI);
        const dorsalT = Math.min(1.0, (dorsalFactor - 0.28) / 0.55);
        posTmp.addScaledVector(nTmp, 0.024 * cuticleT * dorsalT);
      }

      // g) Thenar & Hypothenar Muscular Eminences & Central Palmar Hollow
      if (dorsalFactor < -0.10 && posTmp.y > -0.5 && posTmp.y < 2.0) {
        const palmYFactor = Math.sin(Math.max(0, Math.min(1, (posTmp.y - (-0.5)) / 2.5)) * Math.PI);
        const palmarT = Math.min(1.0, (-dorsalFactor - 0.10) / 0.60);

        // Thenar (radial / thumb side): +0.085 in
        const thenarInfluence = Math.max(thumbMetaWeight, posTmp.z < 0.20 ? Math.min(1.0, (0.20 - posTmp.z) / 0.8) : 0);
        if (thenarInfluence > 0.1) {
          const thenarDisp = 0.085 * palmYFactor * palmarT * Math.min(1.0, thenarInfluence);
          posTmp.addScaledVector(nTmp, thenarDisp);
        }

        // Hypothenar (ulnar / pinky side): +0.050 in
        const hypoInfluence = Math.max(pinkyMetaWeight, posTmp.z > 0.45 ? Math.min(1.0, (posTmp.z - 0.45) / 0.8) : 0);
        if (hypoInfluence > 0.1) {
          const hypoDisp = 0.050 * palmYFactor * palmarT * Math.min(1.0, hypoInfluence);
          posTmp.addScaledVector(nTmp, hypoDisp);
        }

        // Central palmar hollow: -0.022 in
        if (thenarInfluence <= 0.25 && hypoInfluence <= 0.25 && posTmp.z >= 0.15 && posTmp.z <= 0.50) {
          const hollowZ = Math.sin(((posTmp.z - 0.15) / 0.35) * Math.PI);
          const hollowDisp = -0.022 * palmYFactor * palmarT * hollowZ;
          posTmp.addScaledVector(nTmp, hollowDisp);
        }
      }

      positions[i * 3] = posTmp.x;
      positions[i * 3 + 1] = posTmp.y;
      positions[i * 3 + 2] = posTmp.z;
    }

    vertexAnatomy[i] = {
      dorsalFactor,
      lateralFactor,
      tipWeight: Math.min(1, tipWeight),
      pipDipWeight: Math.min(1, pipDipWeight),
      mcpWeight: Math.min(1, mcpWeight),
    };
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeights, 4));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // Update vertexAnatomy dorsalFactor/lateralFactor with freshly computed normals
  const computedNormals = geometry.getAttribute("normal") as THREE.BufferAttribute;
  for (let i = 0; i < vCount; i++) {
    nTmp.set(computedNormals.getX(i), computedNormals.getY(i), computedNormals.getZ(i));
    let dominantSkinIdx = 0;
    let maxW = -1;
    for (let k = 0; k < 4; k++) {
      const w = skinWeights[i * 4 + k]!;
      if (w > maxW) {
        maxW = w;
        dominantSkinIdx = skinIndices[i * 4 + k]!;
      }
    }
    const domMeta = boneMetaBySkinIdx[dominantSkinIdx]!;
    const localNormal = nTmp.clone().applyQuaternion(domMeta.bindQuaternion.clone().invert());
    vertexAnatomy[i]!.dorsalFactor = Math.max(-1, Math.min(1, localNormal.y));
    vertexAnatomy[i]!.lateralFactor = Math.max(0, Math.min(1, Math.abs(localNormal.x)));
  }

  const skinnedMesh = new THREE.SkinnedMesh(geometry, skinMaterial);
  skinnedMesh.castShadow = true;
  skinnedMesh.receiveShadow = true;
  skinnedMesh.frustumCulled = false;

  const skeleton = new THREE.Skeleton(bones, boneInverses);
  skinnedMesh.bind(skeleton, new THREE.Matrix4());
  parentGroup.add(skinnedMesh);

  geometry.userData.wristBoundaryVertexIndices = wristBoundaryVertexIndices;

  return {
    skinnedMesh,
    bonesByName,
    vertexAnatomy,
    wristBoundaryVertexIndices,
  };
}

function buildAnatomicalGlbHandRig(
  hand: "left" | "right",
  skinMaterial: THREE.MeshPhysicalMaterial,
  parentGroup: THREE.Group,
  buffer: ArrayBuffer,
): ParsedHandGlbRig {
  const {
    bones,
    boneInverses,
    bonesByName,
    boneMetaBySkinIdx,
    wristBindPosition,
    json,
    getTypedArray,
  } = parseGlbSkeletonFromBuffer(hand, parentGroup, buffer);

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
  const indices = getTypedArray(prim.indices) as Uint16Array | Uint32Array;

  const vCount = positions.length / 3;
  const colors = new Float32Array(vCount * 3);
  colors.fill(0.45);

  // Initial geometry used to detect boundary edge loop (yields 58 vertices)
  const tempGeometry = new THREE.BufferGeometry();
  tempGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  tempGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
  const wristBoundaryVertexIndices = findWristBoundaryVertexIndices(tempGeometry, wristBindPosition);

  // Compute vertex anatomy (dorsalFactor, lateralFactor, tipWeight, pipDipWeight, mcpWeight)
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

    const domMeta = boneMetaBySkinIdx[dominantSkinIdx] ?? boneMetaBySkinIdx[0]!;
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

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeights, 4));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const skinnedMesh = new THREE.SkinnedMesh(geometry, skinMaterial);
  skinnedMesh.castShadow = true;
  skinnedMesh.receiveShadow = true;
  skinnedMesh.frustumCulled = false;

  const skeleton = new THREE.Skeleton(bones, boneInverses);
  skinnedMesh.bind(skeleton, new THREE.Matrix4());
  parentGroup.add(skinnedMesh);

  geometry.userData.wristBoundaryVertexIndices = wristBoundaryVertexIndices;
  const contactSupportVertexIndicesByFinger = selectAnatomicalContactSupportVertices(
    geometry,
    bones,
    bonesByName,
    vertexAnatomy,
  );
  geometry.userData.handContactSupportVertexIndicesByFinger = contactSupportVertexIndicesByFinger;

  return {
    skinnedMesh,
    bonesByName,
    vertexAnatomy,
    wristBoundaryVertexIndices,
    contactSupportVertexIndicesByFinger,
  };
}

function doesFrameMatch(actual: ImprovedHandBoneFrame, expected: ImprovedHandBoneFrame): boolean {
  return new THREE.Vector3(...actual.forward).normalize().dot(new THREE.Vector3(...expected.forward).normalize()) >= 0.9999 &&
    new THREE.Vector3(...actual.dorsal).normalize().dot(new THREE.Vector3(...expected.dorsal).normalize()) >= 0.9999 &&
    new THREE.Vector3(...actual.hinge).normalize().dot(new THREE.Vector3(...expected.hinge).normalize()) >= 0.9999;
}

function derivePalmWristFrame(
  hand: "left" | "right",
  bonesByName: ReadonlyMap<string, GlbBoneMetadata>,
  canonicalRestDorsalAxis: readonly [number, number, number],
): ImprovedHandBoneFrame {
  const bindPosition = (name: string): THREE.Vector3 => {
    const meta = bonesByName.get(name);
    if (!meta) throw new Error(`Improved hand GLB is missing native palm landmark ${name}.`);
    return meta.bindPositionM.clone();
  };
  const wrist = bindPosition("wrist");
  const indexMcp = bindPosition("index-finger-phalanx-proximal");
  const pinkyMcp = bindPosition("pinky-finger-phalanx-proximal");
  const dorsal = new THREE.Vector3().crossVectors(
    indexMcp.sub(wrist),
    pinkyMcp.sub(wrist),
  );
  if (dorsal.lengthSq() < 1e-10) {
    throw new Error("Improved hand native MCP2/MCP5 landmarks cannot define a wrist palm normal.");
  }
  dorsal.normalize();
  const restDorsal = new THREE.Vector3(...canonicalRestDorsalAxis);
  if (hand === "right") restDorsal.x *= -1;
  restDorsal.normalize();
  if (dorsal.dot(restDorsal) < 0) dorsal.negate();

  const mcpNames = [
    "index-finger-phalanx-proximal",
    "middle-finger-phalanx-proximal",
    "ring-finger-phalanx-proximal",
    "pinky-finger-phalanx-proximal",
  ];
  const meanMcp = new THREE.Vector3();
  for (const name of mcpNames) meanMcp.add(bindPosition(name));
  meanMcp.multiplyScalar(1 / mcpNames.length);
  const forward = meanMcp.sub(wrist);
  forward.addScaledVector(dorsal, -forward.dot(dorsal));
  if (forward.lengthSq() < 1e-10) {
    throw new Error("Improved hand native MCP2..MCP5 landmarks cannot define wrist palm forward.");
  }
  forward.normalize();
  const wristZ = forward.clone().negate();
  const hinge = new THREE.Vector3().crossVectors(dorsal, wristZ);
  if (hinge.lengthSq() < 1e-10) {
    throw new Error("Improved hand native wrist palm basis is degenerate.");
  }
  hinge.normalize();
  const verifiedDorsal = new THREE.Vector3().crossVectors(wristZ, hinge).normalize();
  if (verifiedDorsal.dot(dorsal) < 0.9999) {
    throw new Error("Improved hand native wrist palm basis is not right-handed.");
  }
  return {
    forward: [forward.x, forward.y, forward.z],
    dorsal: [dorsal.x, dorsal.y, dorsal.z],
    hinge: [hinge.x, hinge.y, hinge.z],
  };
}

/**
 * Builds the source-preserving third hand model. It uses the original bind
 * positions and inverse bind matrices directly; unlike the legacy anatomical
 * builder, this path never levels or stretches the wrist boundary.
 */
export function buildImprovedHandGlbRig(
  hand: "left" | "right",
  skinMaterial: THREE.MeshPhysicalMaterial,
  parentGroup: THREE.Group,
  buffer: ArrayBuffer,
  lod: ImprovedHandLodManifest,
  expectedJointNames: readonly string[],
  frameMetadata: ImprovedHandManifestExtras,
): ParsedHandGlbRig {
  const parsed = parseGlbSkeletonFromBuffer(hand, parentGroup, buffer, true);
  try {
    const { bones, boneInverses, bonesByName, boneMetaBySkinIdx, json } = parsed;
    const glbJsonLength = new DataView(buffer).getUint32(12, true);
    const binaryOffset = 20 + glbJsonLength + 8;
    const glbView = new DataView(buffer);
    const accessorComponents: Record<string, number> = {
      SCALAR: 1,
      VEC2: 2,
      VEC3: 3,
      VEC4: 4,
      MAT4: 16,
    };
    type ImprovedAccessorArray =
      | Float32Array
      | Int8Array
      | Uint8Array
      | Int16Array
      | Uint16Array
      | Uint32Array;
    const readAccessor = (accessorIndex: number, expectedComponents: number): {
      values: ImprovedAccessorArray;
      componentType: number;
      normalized: boolean;
      components: number;
    } => {
      const accessor = json.accessors[accessorIndex];
      if (!accessor) throw new Error("Improved hand GLB references a missing accessor.");
      const components = accessorComponents[accessor.type];
      const bufferView = json.bufferViews[accessor.bufferView];
      if (!bufferView || components !== expectedComponents || !Number.isInteger(accessor.count) || accessor.count < 1) {
        throw new Error("Improved hand GLB accessor has an unsupported shape.");
      }
      const componentBytes = accessor.componentType === 5120 || accessor.componentType === 5121
        ? 1
        : accessor.componentType === 5122 || accessor.componentType === 5123
          ? 2
          : accessor.componentType === 5125 || accessor.componentType === 5126
            ? 4
            : 0;
      if (!componentBytes) throw new Error("Improved hand GLB accessor has an unsupported component type.");
      const elementBytes = componentBytes * components;
      const stride = bufferView.byteStride ?? elementBytes;
      const start = binaryOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const lastByte = (accessor.count - 1) * stride + elementBytes;
      if (stride < elementBytes || start < binaryOffset || start + lastByte > buffer.byteLength ||
          (accessor.byteOffset ?? 0) + lastByte > bufferView.byteLength) {
        throw new Error("Improved hand GLB accessor data is truncated or out of range.");
      }
      const isInteger = accessor.componentType !== 5126;
      // Keep unnormalized integer vertex attributes in their source array type.
      // Three.js treats Uint32Array attributes as integer GPU inputs, which is
      // incompatible with the skinning shader's floating-point `vec4 skinIndex`.
      // JOINTS_0 is commonly Uint8 in glTF, and must use vertexAttribPointer.
      const valueCount = accessor.count * components;
      const values: ImprovedAccessorArray = accessor.normalized || !isInteger
        ? new Float32Array(valueCount)
        : accessor.componentType === 5120
          ? new Int8Array(valueCount)
          : accessor.componentType === 5121
            ? new Uint8Array(valueCount)
            : accessor.componentType === 5122
              ? new Int16Array(valueCount)
              : accessor.componentType === 5123
                ? new Uint16Array(valueCount)
                : new Uint32Array(valueCount);
      const maxUnsigned = accessor.componentType === 5121 ? 255
        : accessor.componentType === 5123 ? 65535
          : accessor.componentType === 5125 ? 4294967295 : 0;
      const maxSigned = accessor.componentType === 5120 ? 127
        : accessor.componentType === 5122 ? 32767 : 0;
      for (let element = 0; element < accessor.count; element++) {
        for (let component = 0; component < components; component++) {
          const offset = start + element * stride + component * componentBytes;
          let value: number;
          switch (accessor.componentType) {
            case 5120: value = glbView.getInt8(offset); break;
            case 5121: value = glbView.getUint8(offset); break;
            case 5122: value = glbView.getInt16(offset, true); break;
            case 5123: value = glbView.getUint16(offset, true); break;
            case 5125: value = glbView.getUint32(offset, true); break;
            case 5126: value = glbView.getFloat32(offset, true); break;
            default: throw new Error("Improved hand GLB accessor has an unsupported component type.");
          }
          if (accessor.normalized) {
            if (maxSigned) value = Math.max(value / maxSigned, -1);
            else if (maxUnsigned) value /= maxUnsigned;
            else throw new Error("Improved hand GLB marks a floating-point accessor as normalized.");
          }
          if (!Number.isFinite(value)) {
            throw new Error("Improved hand GLB accessor contains non-finite data.");
          }
          values[element * components + component] = value;
        }
      }
      return { values, componentType: accessor.componentType, normalized: accessor.normalized === true, components };
    };
    const jointNames = boneMetaBySkinIdx.map((meta) => meta.name);
    if (jointNames.length !== expectedJointNames.length ||
        jointNames.some((name, index) => name !== expectedJointNames[index])) {
      throw new Error("Improved hand GLB joint order does not match its manifest.");
    }
    const expectedFrames = frameMetadata.boneFrames[hand];
    if (!expectedFrames) throw new Error(`Improved hand manifest has no ${hand} bind-frame metadata.`);
    const restDorsal = new THREE.Vector3(...frameMetadata.restDorsalAxis);
    if (hand === "right") restDorsal.x *= -1;
    restDorsal.normalize();
    if (frameMetadata.wristFrameProfile !== undefined && frameMetadata.wristFrameProfile !== "palm-mcp-v1") {
      throw new Error("Improved hand manifest has an unsupported wrist frame profile.");
    }
    const palmWristFrame = frameMetadata.wristFrameProfile === "palm-mcp-v1"
      ? derivePalmWristFrame(hand, bonesByName, frameMetadata.restDorsalAxis)
      : null;
    if (palmWristFrame) {
      const expectedWrist = expectedFrames.wrist;
      if (!expectedWrist || !doesFrameMatch(expectedWrist, palmWristFrame)) {
        throw new Error(`Improved hand manifest ${hand} wrist frame does not match its native MCP palm frame.`);
      }
    }
    for (const meta of boneMetaBySkinIdx) {
      const expected = expectedFrames[meta.name];
      if (!expected) throw new Error(`Improved hand manifest has no ${hand} bind frame for ${meta.name}.`);
      const quaternionLength = meta.bindQuaternion.length();
      if (Math.abs(quaternionLength - 1) > 1e-5) {
        throw new Error(`Improved hand joint ${meta.name} has a non-unit bind quaternion.`);
      }
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(meta.bindQuaternion).normalize();
      const dorsal = new THREE.Vector3(0, 1, 0).applyQuaternion(meta.bindQuaternion).normalize();
      const hinge = new THREE.Vector3(1, 0, 0).applyQuaternion(meta.bindQuaternion).normalize();
      const expectedForward = new THREE.Vector3(...expected.forward).normalize();
      const expectedDorsal = new THREE.Vector3(...expected.dorsal).normalize();
      const expectedHinge = new THREE.Vector3(...expected.hinge).normalize();
      if (forward.dot(expectedForward) < 0.9999 || dorsal.dot(expectedDorsal) < 0.9999 ||
          hinge.dot(expectedHinge) < 0.9999 || dorsal.dot(restDorsal) < 0.65) {
        throw new Error(`Improved hand joint ${meta.name} bind frame does not match its dorsal anatomical frame.`);
      }
      if (meta.name === "wrist" && palmWristFrame &&
          (forward.dot(new THREE.Vector3(...palmWristFrame.forward)) < 0.9999 ||
           dorsal.dot(new THREE.Vector3(...palmWristFrame.dorsal)) < 0.9999 ||
           hinge.dot(new THREE.Vector3(...palmWristFrame.hinge)) < 0.9999)) {
        throw new Error(`Improved hand wrist bind frame does not match its native MCP palm frame.`);
      }
    }
    const skin = json.skins[0];
    const inverseBindAccessor = skin && json.accessors[skin.inverseBindMatrices];
    if (!inverseBindAccessor || inverseBindAccessor.type !== "MAT4" ||
        inverseBindAccessor.count !== expectedJointNames.length ||
        inverseBindAccessor.componentType !== 5126 || inverseBindAccessor.normalized) {
      throw new Error("Improved hand GLB inverse-bind matrices do not match its 25-joint skeleton.");
    }
    if (palmWristFrame) {
      const wristSkinIndex = boneMetaBySkinIdx.findIndex((meta) => meta.name === "wrist");
      const wristMeta = boneMetaBySkinIdx[wristSkinIndex];
      const wristInverse = boneInverses[wristSkinIndex];
      if (!wristMeta || !wristInverse) throw new Error("Improved hand GLB is missing the wrist inverse-bind matrix.");
      const expectedWristInverse = new THREE.Matrix4()
        .compose(
          wristMeta.bindPositionM.clone().multiplyScalar(METERS_TO_INCHES),
          wristMeta.bindQuaternion,
          new THREE.Vector3(1, 1, 1),
        )
        .invert();
      if (wristInverse.elements.some((component, index) =>
        Math.abs(component - expectedWristInverse.elements[index]!) > 1e-4)) {
        throw new Error("Improved hand wrist inverse-bind matrix does not match its palm-frame bind transform.");
      }
    }

    const selectedScene = json.scenes?.[json.scene ?? 0];
    const sceneRootNodes = new Set(selectedScene?.nodes ?? []);
    const jointNodeIndices = json.skins[0]!.joints;
    const jointNodeSet = new Set(jointNodeIndices);
    const parentByNode = new Map<number, number>();
    for (let parentIndex = 0; parentIndex < json.nodes.length; parentIndex++) {
      for (const childIndex of json.nodes[parentIndex]!.children ?? []) {
        if (parentByNode.has(childIndex)) {
          throw new Error("Improved hand GLB joints cannot have multiple parents.");
        }
        parentByNode.set(childIndex, parentIndex);
      }
    }
    const isIdentityAncestor = (node: GlbJsonHeader["nodes"][number]): boolean => {
      if (node.matrix) {
        const identity = new THREE.Matrix4().elements;
        return node.matrix.length === 16 && node.matrix.every((component, index) =>
          Math.abs(component - identity[index]!) <= 1e-6);
      }
      const translation = node.translation ?? [0, 0, 0];
      const rotation = node.rotation ?? [0, 0, 0, 1];
      const scale = node.scale ?? [1, 1, 1];
      return translation.every((component) => Math.abs(component) <= 1e-6) &&
        Math.abs(rotation[0]) <= 1e-6 && Math.abs(rotation[1]) <= 1e-6 &&
        Math.abs(rotation[2]) <= 1e-6 && Math.abs(Math.abs(rotation[3]) - 1) <= 1e-6 &&
        scale.every((component) => Math.abs(component - 1) <= 1e-6);
    };
    for (const nodeIndex of jointNodeIndices) {
      const node = json.nodes[nodeIndex];
      if (!node || node.matrix || node.children?.length ||
          (node.scale && node.scale.some((component) => Math.abs(component - 1) > 1e-5)) ||
          (!selectedScene && json.scenes?.length)) {
        throw new Error("Improved hand GLB joints must be flat world-space bones without parent transforms or scale.");
      }
      let current = nodeIndex;
      const visited = new Set<number>([current]);
      while (!sceneRootNodes.has(current)) {
        const parentIndex = parentByNode.get(current);
        if (parentIndex === undefined || visited.has(parentIndex)) {
          throw new Error("Improved hand GLB joint is not reachable from the selected scene.");
        }
        if (jointNodeSet.has(parentIndex) || !isIdentityAncestor(json.nodes[parentIndex]!)) {
          throw new Error("Improved hand GLB joints must have flat world-space binds beneath identity-only ancestors.");
        }
        visited.add(parentIndex);
        current = parentIndex;
      }
      if (!sceneRootNodes.has(current) || (current !== nodeIndex && !isIdentityAncestor(json.nodes[current]!))) {
        throw new Error("Improved hand GLB joint ancestors must have identity transforms.");
      }
    }
    const meshNodes = json.nodes.flatMap((node, index) => node.mesh === 0 ? [index] : []);
    if (meshNodes.length !== 1 || (selectedScene && !sceneRootNodes.has(meshNodes[0]!))) {
      throw new Error("Improved hand GLB must have one mesh node in its selected scene.");
    }
    const meshNode = json.nodes[meshNodes[0]!]!;
    const meshTranslation = meshNode.translation ?? [0, 0, 0];
    const meshRotation = meshNode.rotation ?? [0, 0, 0, 1];
    if (meshNode.matrix || meshTranslation.some((component) => Math.abs(component) > 1e-6) ||
        meshRotation.some((component, index) => Math.abs(component - [0, 0, 0, 1][index]!) > 1e-6) ||
        (meshNode.scale && meshNode.scale.some((component) => Math.abs(component - 1) > 1e-5))) {
      throw new Error("Improved hand GLB mesh transforms must be baked into its geometry.");
    }

    const prim = json.meshes[0]?.primitives[0];
    if (!prim) throw new Error("Improved hand GLB has no mesh primitive.");
    const positionAccessor = readAccessor(prim.attributes.POSITION, 3);
    const normalAccessor = readAccessor(prim.attributes.NORMAL, 3);
    const uvAccessor = readAccessor(prim.attributes.TEXCOORD_0, 2);
    if (prim.attributes.TANGENT === undefined) {
      throw new Error("Improved hand GLB must include tangents for its normal map.");
    }
    const tangentAccessor = readAccessor(prim.attributes.TANGENT, 4);
    const skinIndexAccessor = readAccessor(prim.attributes.JOINTS_0, 4);
    const skinWeightAccessor = readAccessor(prim.attributes.WEIGHTS_0, 4);
    const indexAccessor = readAccessor(prim.indices, 1);
    if (positionAccessor.componentType !== 5126 || positionAccessor.normalized ||
        normalAccessor.componentType === 5126 || !normalAccessor.normalized ||
        uvAccessor.componentType === 5126 || !uvAccessor.normalized ||
        tangentAccessor.componentType === 5126 || !tangentAccessor.normalized ||
        (skinIndexAccessor.componentType !== 5121 && skinIndexAccessor.componentType !== 5123) ||
        skinIndexAccessor.normalized ||
        (skinWeightAccessor.componentType !== 5121 && skinWeightAccessor.componentType !== 5123) ||
        !skinWeightAccessor.normalized ||
        (indexAccessor.componentType !== 5121 && indexAccessor.componentType !== 5123 &&
         indexAccessor.componentType !== 5125) || indexAccessor.normalized) {
      throw new Error("Improved hand GLB vertex attributes use an unsupported numeric encoding.");
    }
    const rawPositions = positionAccessor.values as Float32Array;
    const rawNormals = normalAccessor.values as Float32Array;
    const uvs = uvAccessor.values as Float32Array;
    const tangents = tangentAccessor.values as Float32Array;
    const skinIndices = skinIndexAccessor.values;
    const skinWeights = skinWeightAccessor.values as Float32Array;
    const rawIndices = indexAccessor.values;
    const vertexCount = rawPositions.length / 3;
    const triangleCount = rawIndices.length / 3;
    if (!Number.isInteger(vertexCount) || vertexCount !== lod.vertices ||
        triangleCount !== lod.triangles || rawNormals.length !== vertexCount * 3 ||
        uvs.length !== vertexCount * 2 || tangents.length !== vertexCount * 4 ||
        skinIndices.length !== vertexCount * 4 ||
        skinWeights.length !== vertexCount * 4 || rawIndices.length % 3 !== 0) {
      throw new Error("Improved hand GLB geometry does not match its manifest statistics.");
    }

    const positions = new Float32Array(rawPositions.length);
    for (let index = 0; index < rawPositions.length; index++) {
      const component = rawPositions[index]!;
      if (!Number.isFinite(component)) throw new Error("Improved hand GLB positions contain non-finite values.");
      positions[index] = component * METERS_TO_INCHES;
    }
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const normalOffset = vertex * 3;
      const tangentOffset = vertex * 4;
      const normalLength = Math.hypot(
        rawNormals[normalOffset]!,
        rawNormals[normalOffset + 1]!,
        rawNormals[normalOffset + 2]!,
      );
      const tangentLength = Math.hypot(
        tangents[tangentOffset]!,
        tangents[tangentOffset + 1]!,
        tangents[tangentOffset + 2]!,
      );
      const tangentDotNormal =
        rawNormals[normalOffset]! * tangents[tangentOffset]! +
        rawNormals[normalOffset + 1]! * tangents[tangentOffset + 1]! +
        rawNormals[normalOffset + 2]! * tangents[tangentOffset + 2]!;
      if (!Number.isFinite(normalLength) || Math.abs(normalLength - 1) > 0.001 ||
          !Number.isFinite(tangentLength) || Math.abs(tangentLength - 1) > 0.001 ||
          !Number.isFinite(tangentDotNormal) || Math.abs(tangentDotNormal) > 0.001 ||
          !Number.isFinite(tangents[tangentOffset + 3]!) ||
          Math.abs(Math.abs(tangents[tangentOffset + 3]!) - 1) > 0.001) {
        throw new Error("Improved hand GLB tangent basis is invalid for normal mapping.");
      }
      for (let component = 0; component < 3; component++) {
        if (!Number.isFinite(rawNormals[normalOffset + component]!) ||
            !Number.isFinite(uvs[vertex * 2 + (component % 2)]!)) {
          throw new Error("Improved hand GLB contains non-finite normals or UV coordinates.");
        }
      }
      let weightSum = 0;
      for (let influence = 0; influence < 4; influence++) {
        const slot = vertex * 4 + influence;
        const jointIndex = skinIndices[slot]!;
        const weight = skinWeights[slot]!;
        if (!Number.isInteger(jointIndex) || jointIndex < 0 || jointIndex >= bones.length ||
            !Number.isFinite(weight) || weight < 0) {
          throw new Error("Improved hand GLB contains an invalid skin joint or weight.");
        }
        weightSum += weight;
      }
      if (Math.abs(weightSum - 1) > 1e-5) {
        throw new Error("Improved hand GLB skin weights must be normalized for every vertex.");
      }
    }
    for (const index of rawIndices) {
      if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
        throw new Error("Improved hand GLB contains an out-of-range triangle index.");
      }
    }
    for (const name of NEXT_BONE_NAMES) {
      // The profiled wrist is a palm reference frame, not a segment frame.
      // Every finger joint still has to point its local -Z axis at NEXT_BONE.
      if (name === "wrist" && palmWristFrame) continue;
      const meta = bonesByName.get(name);
      const nextName = NEXT_BONE_BY_NAME[name];
      if (!meta || !nextName) continue;
      const next = bonesByName.get(nextName);
      if (!next) throw new Error(`Improved hand GLB is missing joint ${nextName}.`);
      const axis = new THREE.Vector3(0, 0, -1).applyQuaternion(meta.bindQuaternion).normalize();
      const segment = next.bindPositionM.clone().sub(meta.bindPositionM).normalize();
      if (axis.dot(segment) < 0.9999) {
        throw new Error(`Improved hand joint ${name} does not use the calibrated -Z bone axis.`);
      }
    }

    const boundary = lod.boundaryLoops[0];
    if (!boundary || boundary.length < 3 || new Set(boundary).size !== boundary.length ||
        boundary.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount)) {
      throw new Error("Improved hand GLB has an invalid ordered wrist boundary loop.");
    }
    const ringCenter = new THREE.Vector3();
    for (const vertex of boundary) {
      ringCenter.x += positions[vertex * 3]!;
      ringCenter.y += positions[vertex * 3 + 1]!;
      ringCenter.z += positions[vertex * 3 + 2]!;
    }
    ringCenter.multiplyScalar(1 / boundary.length);
    const wristMeta = bonesByName.get("wrist");
    const wristPosition = wristMeta?.bindPositionM.clone().multiplyScalar(METERS_TO_INCHES);
    if (!wristPosition || ringCenter.distanceTo(wristPosition) > 0.75) {
      throw new Error("Improved hand wrist boundary is not centered on the wrist bind joint.");
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(rawNormals, 3));
    geometry.setAttribute("tangent", new THREE.BufferAttribute(tangents, 4));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndices, 4));
    geometry.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeights, 4));
    geometry.setIndex(new THREE.BufferAttribute(rawIndices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.userData.wristBoundaryVertexIndices = [...boundary];
    geometry.userData.improvedHandModelId = "anatomical-improved";
    geometry.userData.improvedHandLod = lod.level;
    const contactSupportVertexIndicesByFinger = selectImprovedContactSupportVertices(
      geometry,
      bones,
      bonesByName,
      hand,
      frameMetadata.restDorsalAxis,
    );
    geometry.userData.improvedHandContactSupportVertexIndicesByFinger = contactSupportVertexIndicesByFinger;

    const skinnedMesh = new THREE.SkinnedMesh(geometry, skinMaterial);
    skinnedMesh.name = `hand-${hand}-anatomical-improved-lod-${lod.level}`;
    skinnedMesh.castShadow = true;
    skinnedMesh.receiveShadow = true;
    skinnedMesh.frustumCulled = false;
    const skeleton = new THREE.Skeleton(bones, boneInverses);
    skinnedMesh.bind(skeleton, new THREE.Matrix4());
    parentGroup.add(skinnedMesh);

    return {
      skinnedMesh,
      bonesByName,
      vertexAnatomy: [],
      wristBoundaryVertexIndices: [...boundary],
      contactSupportVertexIndicesByFinger,
    };
  } catch (error) {
    for (const meta of parsed.bonesByName.values()) meta.bone.removeFromParent();
    throw error;
  }
}

export function buildAnatomicalHandRig(
  hand: "left" | "right",
  skinMaterial: THREE.MeshPhysicalMaterial,
  parentGroup: THREE.Group,
): ParsedHandGlbRig {
  const buffer = getAnatomicalHandGlbArrayBuffer(hand);
  if (buffer) {
    return buildAnatomicalGlbHandRig(hand, skinMaterial, parentGroup, buffer);
  }

  // Fall back to the procedural subdivided 5,031-vertex rig
  void preloadAnatomicalHandModels();
  return buildProceduralSubdividedHandRig(hand, skinMaterial, parentGroup);
}

function createProceduralTexture(
  width: number,
  height: number,
  painter: (data: Uint8ClampedArray, width: number, height: number) => void,
): THREE.CanvasTexture {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const imgData = ctx.createImageData(width, height);
      painter(imgData.data, width, height);
      ctx.putImageData(imgData, 0, 0);
    }
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
  }
  // Headless / Node.js test environment mock canvas
  const mockData = new Uint8ClampedArray(width * height * 4);
  painter(mockData, width, height);
  const mockCanvas = {
    width,
    height,
    getContext: () => null,
  } as unknown as HTMLCanvasElement;
  const tex = new THREE.CanvasTexture(mockCanvas);
  return tex;
}

let sharedSkinNormalMap: THREE.CanvasTexture | null = null;

export function getSkinNormalMap(): THREE.CanvasTexture {
  if (sharedSkinNormalMap) return sharedSkinNormalMap;

  const tex = createProceduralTexture(512, 512, (data, width, height) => {
    for (let y = 0; y < height; y++) {
      const vy = y / height;
      // Transverse joint crease wave bands
      const creaseFreq1 = Math.sin(y * 0.16) * 0.020;
      const creaseFreq2 = Math.sin(y * 0.42 + Math.sin(vy * 12.0) * 0.8) * 0.014;
      const dermalLines = creaseFreq1 + creaseFreq2;

      for (let x = 0; x < width; x++) {
        // High-frequency dermal micro-relief and epidermal pore texture
        const h0 = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        const frac0 = h0 - Math.floor(h0);
        const h1 = Math.sin(x * 93.9898 + y * 67.345) * 24634.6345;
        const frac1 = h1 - Math.floor(h1);
        const h2 = Math.sin(x * 37.123 + y * 19.876) * 18472.193;
        const frac2 = h2 - Math.floor(h2);

        // Fine cellular pores with transverse skin wrinkle flow
        const pore = (frac0 - 0.5) * 0.032 + (frac1 - 0.5) * 0.016 + (frac2 - 0.5) * 0.010;

        let nx = -pore * 1.35;
        let ny = -((frac1 - 0.5) * 0.028 + dermalLines) * 1.35;
        let nz = 1.0;
        const len = Math.hypot(nx, ny, nz);
        nx /= len;
        ny /= len;
        nz /= len;

        const idx = (y * width + x) * 4;
        data[idx] = Math.round(128 + 127 * nx);
        data[idx + 1] = Math.round(128 + 127 * ny);
        data[idx + 2] = Math.round(128 + 127 * nz);
        data[idx + 3] = 255;
      }
    }
  });

  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  sharedSkinNormalMap = tex;
  return tex;
}

let sharedSkinRoughnessMap: THREE.CanvasTexture | null = null;

export function getSkinRoughnessMap(): THREE.CanvasTexture {
  if (sharedSkinRoughnessMap) return sharedSkinRoughnessMap;

  const tex = createProceduralTexture(512, 512, (data, width, height) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Smooth velvety skin base roughness (~0.58) with fine cellular variation
        const h = Math.sin(x * 23.17 + y * 89.41) * 37482.19;
        const noise = (h - Math.floor(h) - 0.5) * 0.03;
        const roughness = Math.max(0.48, Math.min(0.68, 0.58 + noise));

        const byteVal = Math.round(roughness * 255);
        const idx = (y * width + x) * 4;
        data[idx] = byteVal;
        data[idx + 1] = byteVal;
        data[idx + 2] = byteVal;
        data[idx + 3] = 255;
      }
    }
  });

  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  sharedSkinRoughnessMap = tex;
  return tex;
}

let cachedAnatomicalBaseColorTexture: THREE.Texture | null = null;
let cachedAnatomicalNormalTexture: THREE.Texture | null = null;

export function getAnatomicalBaseColorTexture(): THREE.Texture {
  if (cachedAnatomicalBaseColorTexture) return cachedAnatomicalBaseColorTexture;

  let tex: THREE.Texture;
  if (typeof document !== "undefined") {
    tex = new THREE.TextureLoader().load(
      releaseAssetUrl("models/hands/textures/anatomical_base_color.jpg").href,
    );
  } else {
    tex = new THREE.Texture();
  }
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  cachedAnatomicalBaseColorTexture = tex;
  return tex;
}

export function getAnatomicalNormalMap(): THREE.Texture {
  if (cachedAnatomicalNormalTexture) return cachedAnatomicalNormalTexture;

  let tex: THREE.Texture;
  if (typeof document !== "undefined") {
    tex = new THREE.TextureLoader().load(
      releaseAssetUrl("models/hands/textures/anatomical_normal.png").href,
    );
  } else {
    tex = new THREE.Texture();
  }
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  cachedAnatomicalNormalTexture = tex;
  return tex;
}

let cachedFingernailTexture: THREE.CanvasTexture | null = null;

export function getFingernailTexture(): THREE.CanvasTexture {
  if (cachedFingernailTexture) return cachedFingernailTexture;

  const tex = createProceduralTexture(256, 256, (data, width, height) => {
    for (let y = 0; y < height; y++) {
      const v = y / (height - 1); // 0 at proximal cuticle, 1 at distal free edge
      for (let x = 0; x < width; x++) {
        const u = x / (width - 1); // 0 at left fold, 1 at right fold
        const nx = (u - 0.5) * 2; // -1 to +1

        // 1. Rosy, translucent vascular nail bed base color in the middle
        const midFlush = Math.sin(v * Math.PI);
        let r = 224 + midFlush * 14;
        let g = 138 + midFlush * 8;
        let b = 130 + midFlush * 6;

        // 2. Fine micro-longitudinal striations (keratin ridges running vertically)
        const striation = Math.sin(x * 2.1) * 0.6 + Math.sin(x * 4.8) * 0.4;
        r += striation * 3.5;
        g += striation * 2.5;
        b += striation * 2.0;

        // 3. Pale translucent white/ivory crescent lunula at the base (proximal end)
        const lunulaDist = Math.hypot(nx * 0.95, v / 0.22);
        if (lunulaDist < 1.0) {
          const lunulaAlpha = Math.max(0, Math.min(1.0, (1.0 - lunulaDist) * 3.8)) * 0.72;
          r = r * (1 - lunulaAlpha) + 242 * lunulaAlpha;
          g = g * (1 - lunulaAlpha) + 238 * lunulaAlpha;
          b = b * (1 - lunulaAlpha) + 230 * lunulaAlpha;
        }

        // 4. Opaque/semi-translucent ivory-white free edge at the tip
        const smileLineStart = 0.76 - 0.03 * (1.0 - nx * nx);
        if (v > smileLineStart) {
          const freeEdgeT = Math.max(0, Math.min(1.0, (v - smileLineStart) / 0.10));
          const edgeR = 236 + (v - smileLineStart) * 50;
          const edgeG = 232 + (v - smileLineStart) * 52;
          const edgeB = 222 + (v - smileLineStart) * 55;
          r = r * (1 - freeEdgeT) + edgeR * freeEdgeT;
          g = g * (1 - freeEdgeT) + edgeG * freeEdgeT;
          b = b * (1 - freeEdgeT) + edgeB * freeEdgeT;
        }

        // 5. Subtle dark cuticle border shadow along the proximal edge
        if (v < 0.08) {
          const shadowT = (0.08 - v) / 0.08;
          const shadowAlpha = shadowT * shadowT * 0.45;
          r = r * (1 - shadowAlpha) + 120 * shadowAlpha;
          g = g * (1 - shadowAlpha) + 65 * shadowAlpha;
          b = b * (1 - shadowAlpha) + 50 * shadowAlpha;
        }

        // 6. Subtle lateral nail groove depth shading
        const lateralDist = Math.abs(nx);
        if (lateralDist > 0.82) {
          const latT = (lateralDist - 0.82) / 0.18;
          const latAlpha = latT * 0.30;
          r = r * (1 - latAlpha) + 155 * latAlpha;
          g = g * (1 - latAlpha) + 85 * latAlpha;
          b = b * (1 - latAlpha) + 75 * latAlpha;
        }

        const idx = (y * width + x) * 4;
        data[idx] = Math.round(Math.max(0, Math.min(255, r)));
        data[idx + 1] = Math.round(Math.max(0, Math.min(255, g)));
        data[idx + 2] = Math.round(Math.max(0, Math.min(255, b)));
        data[idx + 3] = 255;
      }
    }
  });

  tex.flipY = false;
  cachedFingernailTexture = tex;
  return tex;
}

export function createFingernailGeometry(): THREE.BufferGeometry {
  const cols = 12;
  const rows = 14;
  const numPlateVertices = (cols + 1) * (rows + 1);
  const numRimVertices = cols + 1;
  const totalVertices = numPlateVertices + numRimVertices;

  const positions = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  const indices: number[] = [];

  // 1. Top nail plate curved grid
  for (let r = 0; r <= rows; r++) {
    const v = r / rows; // 0 (proximal cuticle) to 1 (distal free edge)
    for (let c = 0; c <= cols; c++) {
      const u = c / cols; // 0 to 1 across transverse width
      const nx = (u - 0.5) * 2; // -1 to +1

      // Tapered proximal margin (cuticle contour)
      const widthFactor = 0.88 + 0.12 * Math.sin(v * Math.PI * 0.5);
      const x = (u - 0.5) * widthFactor;

      // Transverse convex curvature (C-curve)
      const cCurve = (1.0 - nx * nx) * 0.22;

      // Longitudinal convex curvature from proximal cuticle to distal free edge
      const longitudinalCurve = Math.sin(v * Math.PI * 0.85 + 0.15) * 0.06;
      const y = cCurve * (0.85 + 0.15 * Math.sin(v * Math.PI)) + longitudinalCurve;

      // Cuticle contour arch & rounded distal free edge
      const cuticleTaper = (1.0 - v) * (nx * nx) * 0.14;
      const freeEdgeTaper = v * (1.0 - nx * nx) * 0.04;
      const z = (0.5 - v) - cuticleTaper + freeEdgeTaper;

      const idx = r * (cols + 1) + c;
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;

      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v;
    }
  }

  // Plate surface quad indices
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = r * (cols + 1) + (c + 1);
      const d = (r + 1) * (cols + 1) + c;
      const e = (r + 1) * (cols + 1) + (c + 1);
      indices.push(a, b, d);
      indices.push(b, e, d);
    }
  }

  // 2. Distal free edge rim with physical thickness/rim
  const lastRowStart = rows * (cols + 1);
  const rimRowStart = numPlateVertices;

  for (let c = 0; c <= cols; c++) {
    const topIdx = lastRowStart + c;
    const rimIdx = rimRowStart + c;

    const topX = positions[topIdx * 3]!;
    const topY = positions[topIdx * 3 + 1]!;
    const topZ = positions[topIdx * 3 + 2]!;

    positions[rimIdx * 3] = topX;
    positions[rimIdx * 3 + 1] = topY - 0.045; // Subtle downward rim thickness
    positions[rimIdx * 3 + 2] = topZ + 0.015; // Tuck slightly under

    uvs[rimIdx * 2] = uvs[topIdx * 2]!;
    uvs[rimIdx * 2 + 1] = 1.0;
  }

  for (let c = 0; c < cols; c++) {
    const topA = lastRowStart + c;
    const topB = lastRowStart + (c + 1);
    const rimA = rimRowStart + c;
    const rimB = rimRowStart + (c + 1);
    indices.push(topA, topB, rimA);
    indices.push(topB, rimB, rimA);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
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
/**
 * Testing retains the anatomical surface and PBR textures but drives it with
 * WebXR bind bones and smoothly resampled WebXR skin weights. The original
 * anatomical/improved and WebXR rigs are never modified.
 */
function buildTestingHandRig(
  hand: "left" | "right",
  material: THREE.MeshPhysicalMaterial,
  group: THREE.Group,
  buffer: ArrayBuffer,
  lod: ImprovedHandLodManifest,
  expectedNames: readonly string[],
  frames: ImprovedHandManifestExtras,
): ParsedHandGlbRig {
  const driver = parseHandGlbRig(hand, material, group);
  let anatomical: ParsedHandGlbRig | null = null;
  try {
    anatomical = buildImprovedHandGlbRig(hand, material, group, buffer, lod, expectedNames, frames);
    const surface = transferWebxrSkinToAnatomicalSurface(
      anatomical.skinnedMesh.geometry,
      driver.skinnedMesh.geometry,
      driver.skinnedMesh.skeleton.bones.length,
    );
    const mesh = new THREE.SkinnedMesh(surface, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.bind(driver.skinnedMesh.skeleton, new THREE.Matrix4());

    // The WebXR bone frames, inverse bind matrices, and runtime pose algorithm
    // are the *only* articulation source. High detail is only the shell.
    driver.skinnedMesh.removeFromParent();
    driver.skinnedMesh.geometry.dispose();
    anatomical.skinnedMesh.removeFromParent();
    anatomical.skinnedMesh.geometry.dispose();
    anatomical.skinnedMesh.skeleton.dispose();
    for (const meta of anatomical.bonesByName.values()) meta.bone.removeFromParent();
    surface.userData.wristBoundaryVertexIndices = anatomical.wristBoundaryVertexIndices;
    group.add(mesh);

    return {
      ...driver,
      skinnedMesh: mesh,
      vertexAnatomy: anatomical.vertexAnatomy,
      wristBoundaryVertexIndices: anatomical.wristBoundaryVertexIndices,
      // Improved contact-floor correction deliberately does NOT run in Testing:
      // it bends phalanges independently of the proven WebXR motion.
      contactSupportVertexIndicesByFinger: undefined,
    };
  } catch (error) {
    driver.skinnedMesh.removeFromParent();
    driver.skinnedMesh.geometry.dispose();
    driver.skinnedMesh.skeleton.dispose();
    for (const meta of driver.bonesByName.values()) meta.bone.removeFromParent();
    if (anatomical) {
      anatomical.skinnedMesh.removeFromParent();
      anatomical.skinnedMesh.geometry.dispose();
      anatomical.skinnedMesh.skeleton.dispose();
      for (const meta of anatomical.bonesByName.values()) meta.bone.removeFromParent();
    }
    throw error;
  }
}

export class Hand3DMeshGroup {
  public readonly group = new THREE.Group();
  public readonly fingernails: THREE.Mesh[] = [];
  private readonly hand: "left" | "right";
  private currentHandModel: HandModelId;
  private requestedHandModel: HandModelId;
  private rig: ParsedHandGlbRig;
  private readonly requestGate = new HandModelRequestGate();
  private readonly assetLoader: HandModelRuntimeDependencies["assetLoader"];
  private readonly textureCache: HandModelRuntimeDependencies["textureCache"];
  private loadState: HandModelDiagnostics["state"] = "ready";
  private loadError: string | null = null;
  private requestedLod: ImprovedHandLod | null = null;
  private loadedLod: ImprovedHandLod | null = null;
  private textureLease: ImprovedHandTextureLease | null = null;
  private readonly readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private readonly forearmOpeningPointScratch: THREE.Vector3[] = [];
  private readonly improvedContactPointScratch = Array.from({ length: 24 }, () => new THREE.Vector3());
  private readonly improvedDistalContactFrames: ImprovedDistalContactFrame[] = Array.from(
    { length: 6 },
    () => ({
      boneName: "",
      prefix: "",
      finger: 0,
      mcp: new THREE.Vector3(),
      pip: new THREE.Vector3(),
      dip: new THREE.Vector3(),
      tip: new THREE.Vector3(),
      start: new THREE.Vector3(),
      end: new THREE.Vector3(),
      hinge: new THREE.Vector3(),
      tipPoint: new THREE.Vector3(),
      thicknessScale: 1,
      active: false,
    }),
  );
  private isDisposed = false;
  private lastPose: MotionPose | null = null;
  private lastSkinSettings: SkinSettings | null = null;
  private lastShowFingerLabels = false;
  private lastHoverLift = 0;
  private lastContactTargets: readonly ImprovedHandContactTarget[] = [];
  private readonly improvedForearmMaterial: THREE.MeshPhysicalMaterial;
  private improvedTriangleCount = 0;

  public readonly skinMaterial: THREE.MeshPhysicalMaterial;
  public readonly nailMaterial: THREE.MeshPhysicalMaterial;
  private readonly nailGeometry: THREE.BufferGeometry;
  private readonly cuffMaterial: THREE.MeshStandardMaterial;
  private readonly sleeveMaterial: THREE.MeshPhysicalMaterial;

  private readonly contactShadows: THREE.Mesh[] = [];
  private readonly contactShadowMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly contactShadowGeometry: THREE.PlaneGeometry;
  private forearmGeometry: THREE.BufferGeometry;
  private readonly forearmMesh: THREE.Mesh;
  private readonly cuffGeometry: THREE.CylinderGeometry;
  private readonly sleeveGeometry: THREE.CylinderGeometry;
  private readonly cuffMesh: THREE.Mesh;
  private readonly sleeveMesh: THREE.Mesh;
  private readonly badgeSprites = new Map<number, THREE.Sprite>();
  private lastColorSignature = "";

  public constructor(
    hand: "left" | "right",
    handModel: Exclude<HandModelId, typeof IMPROVED_HAND_MODEL_ID> = "anatomical",
    dependencies?: HandModelRuntimeDependencies,
  ) {
    this.hand = hand;
    this.assetLoader = dependencies?.assetLoader ?? improvedHandAssetLoader;
    this.textureCache = dependencies?.textureCache ?? improvedHandTextureCache;
    this.currentHandModel = handModel;
    this.requestedHandModel = handModel;
    this.group.visible = false;

    this.skinMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.52,
      metalness: 0.0,
      transmission: 0.04,
      thickness: 0.18,
      attenuationColor: new THREE.Color(0xd94436),
      attenuationDistance: 0.75,
      sheen: 0.25,
      sheenRoughness: 0.60,
      sheenColor: new THREE.Color(0xe29382),
      clearcoat: 0.08,
      clearcoatRoughness: 0.40,
      envMapIntensity: 0.20,
    });
    this.configureMaterialForModel(handModel);
    this.improvedForearmMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.58,
      metalness: 0,
      side: THREE.DoubleSide,
    });

    this.nailGeometry = createFingernailGeometry();
    const nailTexture = getFingernailTexture();
    this.nailMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: nailTexture,
      roughness: 0.22,
      metalness: 0.0,
      clearcoat: 0.45,
      clearcoatRoughness: 0.14,
      transmission: 0.0,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
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

    // Build rigged 25-bone SkinnedMesh
    this.rig = handModel === "anatomical"
      ? buildAnatomicalHandRig(hand, this.skinMaterial, this.group)
      : parseHandGlbRig(hand, this.skinMaterial, this.group);

    if (handModel === "anatomical" && this.rig.wristBoundaryVertexIndices.length !== 40) {
      void preloadAnatomicalHandModels().then(() => {
        this.upgradeToAnatomicalGlbIfReady();
      });
    }

    const NAIL_SPECS: Record<
      number,
      { bone: string; x: number; y: number; z: number; width: number; thickness: number; length: number }
    > = {
      1: { bone: "thumb-phalanx-distal", x: 0, y: 0.17, z: -0.40, width: 0.46, thickness: 0.35, length: 0.32 },
      2: { bone: "index-finger-phalanx-distal", x: 0, y: 0.17, z: -0.32, width: 0.34, thickness: 0.30, length: 0.25 },
      3: { bone: "middle-finger-phalanx-distal", x: 0, y: 0.18, z: -0.34, width: 0.36, thickness: 0.30, length: 0.26 },
      4: { bone: "ring-finger-phalanx-distal", x: 0, y: 0.17, z: -0.33, width: 0.34, thickness: 0.30, length: 0.25 },
      5: { bone: "pinky-finger-phalanx-distal", x: 0, y: 0.15, z: -0.33, width: 0.28, thickness: 0.26, length: 0.23 },
    };

    for (let f = 1; f <= 5; f++) {
      const spec = NAIL_SPECS[f]!;
      const nailMesh = new THREE.Mesh(this.nailGeometry, this.nailMaterial);
      nailMesh.name = `hand-fingernail-${f}`;
      nailMesh.castShadow = true;
      nailMesh.receiveShadow = true;
      nailMesh.visible = false;
      nailMesh.position.set(spec.x, spec.y, spec.z);
      nailMesh.rotation.set(0, 0, 0);
      nailMesh.scale.set(spec.width, spec.thickness, spec.length);
      this.fingernails.push(nailMesh);

      const boneMeta = this.rig.bonesByName.get(spec.bone);
      if (boneMeta) {
        boneMeta.bone.add(nailMesh);
      } else {
        this.group.add(nailMesh);
      }
    }

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
    this.cuffMesh.name = "hand-cuff";
    this.cuffMesh.castShadow = true;
    this.cuffMesh.receiveShadow = true;
    this.group.add(this.cuffMesh);

    this.sleeveGeometry = new THREE.CylinderGeometry(1.38, 1.0, 1.0, 24, 1, false);
    this.sleeveGeometry.rotateX(Math.PI * 0.5);
    this.sleeveMesh = new THREE.Mesh(this.sleeveGeometry, this.sleeveMaterial);
    this.sleeveMesh.name = "hand-sleeve";
    this.sleeveMesh.castShadow = true;
    this.sleeveMesh.receiveShadow = true;
    this.group.add(this.sleeveMesh);
    this.publishHandModelDiagnostics();
  }

  public clear(): void {
    this.group.visible = false;
    this.lastContactTargets = [];
    for (const nail of this.fingernails) {
      nail.visible = false;
    }
  }

  public setSkinColor(rgb: [number, number, number]): void {
    this.updateVertexColors(
      rgb,
      mixRgb(rgb, [205, 165, 145], 0.20),
      mixRgb(rgb, [232, 180, 168], 0.15),
      mixRgb(rgb, [238, 206, 188], 0.10),
    );
  }

  public setOpacity(opacity: number): void {
    const isTransparent = opacity < 0.999;
    this.skinMaterial.transparent = isTransparent;
    this.skinMaterial.opacity = opacity;
    this.nailMaterial.transparent = isTransparent;
    this.nailMaterial.opacity = opacity;
  }

  private updateVertexColors(
    baseSkinRgb: [number, number, number],
    creaseRgb: [number, number, number],
    tipWarmRgb: [number, number, number],
    knuckleHighlightRgb: [number, number, number],
  ): void {
    const sig = `${baseSkinRgb.join(",")}|${creaseRgb.join(",")}|${tipWarmRgb.join(",")}|${knuckleHighlightRgb.join(",")}`;
    if (sig === this.lastColorSignature) return;
    this.lastColorSignature = sig;

    const colAttr = this.rig.skinnedMesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const anatomy = this.rig.vertexAnatomy;
    const palmarShadeRgb = mixRgb(baseSkinRgb, [210, 170, 150], 0.20);

    for (let i = 0; i < anatomy.length; i++) {
      const info = anatomy[i]!;
      let rgb = baseSkinRgb;

      // 1. Subtle palmar underside ambient occlusion
      if (info.dorsalFactor < 0) {
        rgb = mixRgb(rgb, palmarShadeRgb, Math.min(0.22, -info.dorsalFactor * 0.20));
      }

      // 2. Subtle dorsal knuckle highlight over MCP
      if (info.dorsalFactor > 0.4 && info.mcpWeight > 0.25) {
        rgb = mixRgb(rgb, knuckleHighlightRgb, Math.min(0.12, info.dorsalFactor * info.mcpWeight * 0.15));
      }

      // 3. Subtle dorsal joint crease shading over PIP/DIP
      if (info.dorsalFactor > 0.15 && info.pipDipWeight > 0.25) {
        rgb = mixRgb(rgb, creaseRgb, Math.min(0.14, info.dorsalFactor * info.pipDipWeight * 0.16));
      }

      // 4. Subtle healthy capillary warmth on fingertips and fleshy palmar pads
      if (info.tipWeight > 0.25) {
        rgb = mixRgb(rgb, tipWarmRgb, Math.min(0.10, info.tipWeight * 0.12));
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
    hoverLift = 0,
    contactTargets: readonly ImprovedHandContactTarget[] = [],
  ): void {
    if (this.isDisposed) return;
    this.lastPose = pose;
    this.lastSkinSettings = skinSettings;
    this.lastShowFingerLabels = showFingerLabels;
    this.lastHoverLift = hoverLift;
    this.lastContactTargets = contactTargets;
    const isImproved = this.currentHandModel === IMPROVED_HAND_MODEL_ID;
    const isTesting = this.currentHandModel === TESTING_HAND_MODEL_ID;
    const isPhotoSurface = isImproved || isTesting;
    const isAnatomical = this.currentHandModel === "anatomical";
    const isAnatomicalOrImproved = isImproved || isAnatomical;
    for (let finger = 1; finger <= 5; finger++) {
      this.improvedDistalContactFrames[finger]!.active = false;
    }
    const h3d = reconstructHand3D(pose, isImproved ? 0 : hoverLift);
    if (isImproved && hoverLift > 0) {
      // Keep the improved mesh rigid under hover instead of changing axial bone
      // scales as the legacy pose reconstruction lifts individual finger points.
      const rigidLift = 0.22 * Math.min(1, hoverLift);
      h3d.wristR.y += rigidLift;
      h3d.wristU.y += rigidLift;
      h3d.wristCenter.y += rigidLift;
      h3d.armEnd.y += rigidLift;
      for (let finger = 1; finger <= 5; finger++) {
        const chain = h3d.chains[finger];
        if (!chain) continue;
        for (const point of chain) point.y += rigidLift;
      }
    }
    this.group.visible = true;

    // Natural, harmonious concert pianist skin tone
    const naturalSkinRgb: [number, number, number] = [228, 192, 172];
    const naturalCreaseRgb: [number, number, number] = [205, 165, 145];
    const naturalTipWarmRgb: [number, number, number] = [232, 180, 168];
    const naturalKnuckleRgb: [number, number, number] = [238, 206, 188];

    const baseSkinRgb: [number, number, number] =
      skinSettings.style === "gloves"
        ? [218, 222, 230]
        : skinSettings.style === "robot"
          ? skinSettings.colors.robot.shell
          : naturalSkinRgb;

    const creaseRgb: [number, number, number] =
      skinSettings.style === "gloves"
        ? [135, 142, 156]
        : skinSettings.style === "robot"
          ? skinSettings.colors.robot.joint
          : naturalCreaseRgb;

    const tipWarmRgb: [number, number, number] =
      skinSettings.style === "gloves"
        ? [195, 200, 210]
        : skinSettings.style === "robot"
          ? skinSettings.colors.robot.tip
          : naturalTipWarmRgb;

    const knuckleHighlightRgb: [number, number, number] =
      skinSettings.style === "gloves"
        ? [235, 238, 245]
        : skinSettings.style === "robot"
          ? skinSettings.colors.robot.shell
          : naturalKnuckleRgb;

    if (!isPhotoSurface) this.updateVertexColors(baseSkinRgb, creaseRgb, tipWarmRgb, knuckleHighlightRgb);

    this.sleeveMaterial.color.setHex(0x12141c);
    if (!isPhotoSurface) {
      this.skinMaterial.roughness = skinSettings.style === "robot" ? 0.28 : (this.currentHandModel === "anatomical" ? 0.52 : 0.62);
      this.skinMaterial.metalness = skinSettings.style === "robot" ? 0.45 : 0.01;
    }

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
        .addScaledVector(palmUp, isImproved ? 0 : 0.16);
      wristMeta.bone.quaternion.copy(wristWorldQuat);
      const lenRatio = isImproved
        ? 1
        : Math.max(0.65, Math.min(1.35, wristToMetaIn / wristMeta.bindLengthIn));
      wristMeta.bone.scale.set(widthScale, widthScale, lenRatio);
    }

    if (isImproved && wristMeta) {
      const wristPosition = wristMeta.bone.position;
      const wristQuaternion = wristMeta.bone.quaternion;
      const wristScale = wristMeta.bone.scale;
      for (let finger = 1; finger <= 5; finger++) {
        const chain = h3d.chains[finger];
        if (!chain?.length) continue;
        const prefix = FINGER_PREFIX_BY_DIGIT[finger]!;
        const metacarpal = this.rig.bonesByName.get(`${prefix}-metacarpal`);
        if (!metacarpal) continue;

        // MotionPose's first chain point is a virtual palm anchor, not the
        // native carpal origin. Attach only the metacarpal root to the posed
        // wrist; every following target remains driven by MotionPose.
        chain[0]!.copy(metacarpal.bindRootInWrist)
          .multiply(wristScale)
          .applyQuaternion(wristQuaternion)
          .add(wristPosition);
      }
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
      const measuredSegLen = segVec.length();
      const isAnatomical = this.currentHandModel === "anatomical";
      const usesMeasuredSegmentLength = isImproved || isAnatomical;
      const segLen = usesMeasuredSegmentLength ? measuredSegLen : Math.max(0.15, measuredSegLen);
      const forward = measuredSegLen > 1e-6
        ? segVec.clone().divideScalar(measuredSegLen)
        : new THREE.Vector3(0, 0, 1).applyQuaternion(wristWorldQuat).normalize();
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

      const lenRatio = usesMeasuredSegmentLength
        ? segLen / meta.bindLengthIn
        : Math.max(0.55, Math.min(1.55, segLen / meta.bindLengthIn));
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

      // Apply the same palmar-pad correction for every hover coefficient. The
      // reconstructed chain already carries the continuous hover lift.
      const tipOriginal = chain[chain.length - 1]!;
      const dipPt = chain[chain.length - 2]!;
      const isAnatomical = this.currentHandModel === "anatomical";
      const tipPadLift = (isImproved || isAnatomical) ? 0 : Math.max(0, 0.13 - Math.max(0, tipOriginal.y) * 0.5);
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
          tipMeta.bone.scale.set(widthScale, widthScale, isImproved ? 1 : widthScale);
        }
      } else {
        // Fingers 2..5 have 5 points: [base, mcp, pip, dip, tip]
        const base = chain[0]!;
        const mcp = chain[1]!;
        const pip = chain[2]!;
        const dip = dipPt;

        // In GLB bind pose, pinky-finger-metacarpal sits slightly closer to MCP
        const metaStart =
          !isImproved && f === 5 ? new THREE.Vector3().lerpVectors(base, mcp, 0.22) : base;

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
          tipMeta.bone.scale.set(widthScale, widthScale, isImproved ? 1 : widthScale);
        }
      }

      if (isAnatomicalOrImproved && distalResult) {
        const contactFrame = this.improvedDistalContactFrames[f]!;
        contactFrame.boneName = f === 1 ? "thumb-phalanx-distal" : `${prefix}-phalanx-distal`;
        contactFrame.prefix = prefix;
        contactFrame.finger = f;
        contactFrame.mcp.copy(chain[1]!);
        contactFrame.pip.copy(f === 1 ? chain[1]! : chain[2]!);
        contactFrame.dip.copy(dipPt);
        contactFrame.tip.copy(tipPt);
        contactFrame.start.copy(dipPt);
        contactFrame.end.copy(tipPt);
        contactFrame.hinge.copy(distalResult.binormal);
        contactFrame.tipPoint = tipOriginal;
        contactFrame.thicknessScale = widthScale;
        contactFrame.active = true;
      }
    }

    if (isAnatomical && contactTargets.length > 0) {
      this.applyAnatomicalKeyContact(contactTargets, orientBone);
    } else if (isImproved && contactTargets.length > 0) {
      this.applyImprovedContactFloor(contactTargets, orientBone);
    }

    // Update visibility of procedural fingernails (only visible for webxr hand model; anatomical has photorealistic modeled nails)
    const showNails = this.currentHandModel === "webxr" && skinSettings.style !== "gloves";
    for (const nailMesh of this.fingernails) {
      nailMesh.visible = showNails;
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

  private applyAnatomicalKeyContact(
    targets: readonly ImprovedHandContactTarget[],
    orientBone: (
      boneName: string,
      startPt: THREE.Vector3,
      endPt: THREE.Vector3,
      thicknessScale: number,
      parentHingeAxis?: THREE.Vector3,
    ) => { quat: THREE.Quaternion; normalUp: THREE.Vector3; binormal: THREE.Vector3 } | null,
  ): void {
    const supportByFinger = this.rig.contactSupportVertexIndicesByFinger;
    if (!supportByFinger?.length || targets.length === 0) return;

    const geometry = this.rig.skinnedMesh.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const minZMargin = 0.035;
    this.group.updateMatrixWorld(true);
    this.rig.skinnedMesh.skeleton.update();

    for (const target of targets) {
      if (target.pitch === null || target.finger < 1 || target.finger > 5) continue;
      const frame = this.improvedDistalContactFrames[target.finger];
      const supportIndices = supportByFinger[target.finger];
      if (!frame?.active || !supportIndices?.length) continue;
      const sampleCount = Math.min(supportIndices.length, this.improvedContactPointScratch.length);
      if (sampleCount === 0) continue;

      const prefix = FINGER_PREFIX_BY_DIGIT[target.finger]!;
      const tipMeta = this.rig.bonesByName.get(`${prefix}-tip`);
      if (!tipMeta) continue;

      for (let iteration = 0; iteration < 4; iteration++) {
        this.group.updateMatrixWorld(true);
        this.rig.skinnedMesh.skeleton.update();
        for (let sample = 0; sample < sampleCount; sample++) {
          const vertex = supportIndices[sample]!;
          const point = this.improvedContactPointScratch[sample]!
            .fromBufferAttribute(position, vertex);
          this.rig.skinnedMesh.applyBoneTransform(vertex, point);
          point.applyMatrix4(this.rig.skinnedMesh.matrixWorld);
        }

        const zMin = Number.isFinite(target.contactMinZ) ? target.contactMinZ! + minZMargin : undefined;
        const zMax = Number.isFinite(target.contactMaxZ) ? target.contactMaxZ! - minZMargin : undefined;
        const desiredX = Number.isFinite(target.contactCenterX)
          ? THREE.MathUtils.clamp(
              target.contactCenterX!,
              Number.isFinite(target.contactMinX) ? target.contactMinX! + minZMargin : target.contactCenterX!,
              Number.isFinite(target.contactMaxX) ? target.contactMaxX! - minZMargin : target.contactCenterX!,
            )
          : frame.tip.x;

        let padSample = -1;
        let padSurfaceY = Number.NaN;
        let padDistance = Number.POSITIVE_INFINITY;
        for (let sample = 0; sample < sampleCount; sample++) {
          const point = this.improvedContactPointScratch[sample]!;
          const surfaceY = target.sampleSurfaceYAt(target.pitch, point.x, point.z);
          if (surfaceY === null || !Number.isFinite(surfaceY)) continue;
          const distance = point.distanceToSquared(frame.tip);
          if (padSample < 0 || point.y < this.improvedContactPointScratch[padSample]!.y - 1e-5) {
            padSample = sample;
            padSurfaceY = surfaceY;
            padDistance = distance;
          } else if (Math.abs(point.y - this.improvedContactPointScratch[padSample]!.y) < 1e-5 && distance < padDistance) {
            padSample = sample;
            padSurfaceY = surfaceY;
            padDistance = distance;
          }
        }

        let contactZ = padSample >= 0
          ? this.improvedContactPointScratch[padSample]!.z
          : frame.tip.z;
        if (zMin !== undefined && zMax !== undefined && zMin <= zMax) {
          contactZ = THREE.MathUtils.clamp(contactZ, zMin, zMax);
        }
        let targetSurfaceY = target.sampleSurfaceYAt(target.pitch, desiredX, contactZ);
        if (targetSurfaceY === null && zMin !== undefined && zMax !== undefined) {
          contactZ = (zMin + zMax) * 0.5;
          targetSurfaceY = target.sampleSurfaceYAt(target.pitch, desiredX, contactZ);
        }
        if (targetSurfaceY === null && padSample >= 0) {
          contactZ = this.improvedContactPointScratch[padSample]!.z;
          targetSurfaceY = padSurfaceY;
        }
        if (targetSurfaceY === null || !Number.isFinite(targetSurfaceY)) break;

        if (padSample < 0) {
          let closestDistance = Number.POSITIVE_INFINITY;
          for (let sample = 0; sample < sampleCount; sample++) {
            const point = this.improvedContactPointScratch[sample]!;
            const distance = Math.hypot(point.x - desiredX, point.z - contactZ);
            if (distance < closestDistance) {
              closestDistance = distance;
              padSample = sample;
            }
          }
        }
        if (padSample < 0) break;

        const padPoint = this.improvedContactPointScratch[padSample]!;
        const padOffset = padPoint.clone().sub(frame.tip);
        const targetPadPoint = new THREE.Vector3(desiredX, targetSurfaceY + 0.012, contactZ);
        const targetTipPoint = targetPadPoint.sub(padOffset);
        const chain = target.finger === 1
          ? [frame.mcp, frame.dip, frame.tip]
          : [frame.mcp, frame.pip, frame.dip, frame.tip];
        const solution = solveFixedLengthFingerChain(chain, targetTipPoint);
        if (!solution) break;

        if (target.finger !== 1) frame.pip.copy(solution.points[1]!);
        frame.dip.copy(solution.points[solution.points.length - 2]!);
        frame.tip.copy(solution.points[solution.points.length - 1]!);
        frame.end.copy(frame.tip);
        frame.start.copy(frame.dip);
        frame.tipPoint.copy(frame.tip);

        if (target.finger === 1) {
          const proximal = orientBone(
            "thumb-phalanx-proximal",
            frame.mcp,
            frame.dip,
            frame.thicknessScale,
            frame.hinge,
          );
          const distal = orientBone(
            "thumb-phalanx-distal",
            frame.dip,
            frame.tip,
            frame.thicknessScale,
            proximal?.binormal,
          );
          if (!distal) break;
          tipMeta.bone.position.copy(frame.tip);
          tipMeta.bone.quaternion.copy(distal.quat);
          tipMeta.bone.scale.set(frame.thicknessScale, frame.thicknessScale, frame.thicknessScale);
        } else {
          const proximal = orientBone(
            `${prefix}-phalanx-proximal`,
            frame.mcp,
            frame.pip,
            frame.thicknessScale,
            frame.hinge,
          );
          const intermediate = orientBone(
            `${prefix}-phalanx-intermediate`,
            frame.pip,
            frame.dip,
            frame.thicknessScale,
            proximal?.binormal,
          );
          const distal = orientBone(
            `${prefix}-phalanx-distal`,
            frame.dip,
            frame.tip,
            frame.thicknessScale,
            intermediate?.binormal,
          );
          if (!distal) break;
          tipMeta.bone.position.copy(frame.tip);
          tipMeta.bone.quaternion.copy(distal.quat);
          tipMeta.bone.scale.set(frame.thicknessScale, frame.thicknessScale, frame.thicknessScale);
        }

        this.group.updateMatrixWorld(true);
        this.rig.skinnedMesh.skeleton.update();
      }
    }
  }

  private applyImprovedContactFloor(
    targets: readonly ImprovedHandContactTarget[],
    orientBone: (
      boneName: string,
      startPt: THREE.Vector3,
      endPt: THREE.Vector3,
      thicknessScale: number,
      parentHingeAxis?: THREE.Vector3,
    ) => { quat: THREE.Quaternion; normalUp: THREE.Vector3; binormal: THREE.Vector3 } | null,
  ): void {
    const supportByFinger = this.rig.contactSupportVertexIndicesByFinger;
    if (!supportByFinger?.length || targets.length === 0) return;

    this.group.updateMatrixWorld(true);
    this.rig.skinnedMesh.skeleton.update();
    const position = this.rig.skinnedMesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (const target of targets) {
      if (!target.pitch || target.finger < 1 || target.finger > 5) continue;
      const frame = this.improvedDistalContactFrames[target.finger];
      const supportIndices = supportByFinger[target.finger];
      if (!frame?.active || !supportIndices?.length) continue;
      const sampleCount = Math.min(supportIndices.length, this.improvedContactPointScratch.length);
      if (sampleCount === 0) continue;

      const prefix = FINGER_PREFIX_BY_DIGIT[target.finger]!;
      const tipName = `${prefix}-tip`;
      const tipMeta = this.rig.bonesByName.get(tipName);
      if (!tipMeta) continue;

      // Re-evaluate after each small endpoint adjustment because LBS weights
      // can make the pad move slightly less than the distal endpoint itself.
      for (let iteration = 0; iteration < 3; iteration++) {
        for (let sample = 0; sample < sampleCount; sample++) {
          const vertex = supportIndices[sample]!;
          const point = this.improvedContactPointScratch[sample]!
            .fromBufferAttribute(position, vertex);
          this.rig.skinnedMesh.applyBoneTransform(vertex, point);
          point.applyMatrix4(this.rig.skinnedMesh.matrixWorld);
        }

        const correction = computePenetrationOnlyCorrection(
          target.pitch,
          this.improvedContactPointScratch,
          target.sampleSurfaceYAt,
          sampleCount,
        );
        if (!(correction > 0.0005) || !Number.isFinite(correction)) break;

        const h = frame.hinge.clone().normalize();
        const vTip = new THREE.Vector3().subVectors(frame.tip, frame.mcp);
        const Dh = Math.hypot(vTip.x, vTip.z);
        const sinTheta = Math.min(0.35, correction / Math.max(0.1, Dh));
        const deltaTheta = Math.asin(sinTheta);

        const testLift = new THREE.Vector3().subVectors(frame.tip, frame.mcp).applyAxisAngle(h, deltaTheta).y - vTip.y;
        const angle = testLift >= 0 ? deltaTheta : -deltaTheta;

        frame.pip.sub(frame.mcp).applyAxisAngle(h, angle).add(frame.mcp);
        frame.dip.sub(frame.mcp).applyAxisAngle(h, angle).add(frame.mcp);
        frame.tip.sub(frame.mcp).applyAxisAngle(h, angle).add(frame.mcp);
        frame.start.copy(frame.dip);
        frame.end.copy(frame.tip);
        frame.tipPoint.copy(frame.tip);

        const isImproved = this.currentHandModel === IMPROVED_HAND_MODEL_ID;
        if (target.finger === 1) {
          const proxResult = orientBone(
            "thumb-phalanx-proximal",
            frame.mcp,
            frame.dip,
            frame.thicknessScale,
            frame.hinge,
          );
          const distalResult = orientBone(
            "thumb-phalanx-distal",
            frame.dip,
            frame.tip,
            frame.thicknessScale,
            proxResult?.binormal,
          );
          if (!distalResult) break;
          tipMeta.bone.position.copy(frame.tip);
          tipMeta.bone.quaternion.copy(distalResult.quat);
          tipMeta.bone.scale.set(frame.thicknessScale, frame.thicknessScale, isImproved ? 1 : frame.thicknessScale);
        } else {
          const proxResult = orientBone(
            `${prefix}-phalanx-proximal`,
            frame.mcp,
            frame.pip,
            frame.thicknessScale,
            frame.hinge,
          );
          const interResult = orientBone(
            `${prefix}-phalanx-intermediate`,
            frame.pip,
            frame.dip,
            frame.thicknessScale,
            proxResult?.binormal,
          );
          const distalResult = orientBone(
            `${prefix}-phalanx-distal`,
            frame.dip,
            frame.tip,
            frame.thicknessScale,
            interResult?.binormal,
          );
          if (!distalResult) break;
          tipMeta.bone.position.copy(frame.tip);
          tipMeta.bone.quaternion.copy(distalResult.quat);
          tipMeta.bone.scale.set(frame.thicknessScale, frame.thicknessScale, isImproved ? 1 : frame.thicknessScale);
        }

        this.group.updateMatrixWorld(true);
        this.rig.skinnedMesh.skeleton.update();
      }
    }
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
    let openingPoints: THREE.Vector3[];
    if (isDetailedHandModel(this.currentHandModel)) {
      this.forearmOpeningPointScratch.length = Math.min(
        this.forearmOpeningPointScratch.length,
        openingIndices.length,
      );
      while (this.forearmOpeningPointScratch.length < openingIndices.length) {
        this.forearmOpeningPointScratch.push(new THREE.Vector3());
      }
      openingPoints = this.forearmOpeningPointScratch;
      for (let index = 0; index < openingIndices.length; index++) {
        const vertex = openingIndices[index]!;
        const point = openingPoints[index]!.fromBufferAttribute(sourcePositions, vertex);
        this.rig.skinnedMesh.applyBoneTransform(vertex, point);
      }
    } else {
      openingPoints = openingIndices.map((vertex) => {
        const point = new THREE.Vector3().fromBufferAttribute(sourcePositions, vertex);
        return this.rig.skinnedMesh.applyBoneTransform(vertex, point);
      });
    }
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

      // The shirt cuff wraps generously over the wrist interface (-0.80 in forward toward hand),
      // completely enclosing the opening seam so both WebXR and anatomical hands emerge cleanly with zero visible cut.
      const isImproved = this.currentHandModel === IMPROVED_HAND_MODEL_ID;
      const isAnatomical = this.currentHandModel === "anatomical";
      const cuffStart = isImproved ? -0.14 : (isAnatomical ? -0.14 : -0.80);
      const cuffLen = isImproved ? 0.92 : 1.40;
      const cuffMid = new THREE.Vector3()
        .copy(openingCenter)
        .addScaledVector(armDir, cuffStart + cuffLen * 0.5);

      const basis = new THREE.Matrix4().makeBasis(orthoLat, upDir, armDir);
      const quat = new THREE.Quaternion().setFromRotationMatrix(basis);

      this.cuffMesh.position.copy(cuffMid);
      this.cuffMesh.quaternion.copy(quat);
      this.cuffMesh.scale.set(baseRx * 1.25, baseRy * 1.28, cuffLen);

      // The suit jacket sleeve starts behind the cuff (+0.65 in) so 0.65 in of white cuff peeks out,
      // and extends 22 inches along armDir so the arm exits past the viewport bottom in all presets.
      const sleeveStart = cuffStart + 0.65;
      const sleeveLen = 22.0;
      const sleeveMid = new THREE.Vector3()
        .copy(openingCenter)
        .addScaledVector(armDir, sleeveStart + sleeveLen * 0.5);

      this.sleeveMesh.position.copy(sleeveMid);
      this.sleeveMesh.quaternion.copy(quat);
      this.sleeveMesh.scale.set(baseRx * 1.34, baseRy * 1.36, sleeveLen);
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

  /** Returns the model actually attached to the scene, which may be a fallback while loading. */
  public getHandModel(): HandModelId {
    return this.currentHandModel;
  }

  public getHandModelDiagnostics(): HandModelDiagnostics {
    const glbStats = this.assetLoader.getCacheStats();
    const textureStats = this.textureCache.getCacheStats();
    const triangles = isDetailedHandModel(this.currentHandModel)
      ? this.improvedTriangleCount
      : ((this.rig.skinnedMesh.geometry.index?.count ?? 0) / 3);
    const diagnostics: HandModelDiagnostics = {
      requestedModel: this.requestedHandModel,
      loadedModel: this.currentHandModel,
      requestedLod: this.requestedLod,
      loadedLod: this.loadedLod,
      state: this.loadState,
      error: this.loadError,
      triangles,
      cachedAssetCount: glbStats.count + textureStats.count,
      cachedGlbAssetCount: glbStats.count,
      cachedGlbBytes: glbStats.retainedGlbBytes,
      cachedTextureCount: textureStats.count,
      estimatedTextureBaseBytes: textureStats.estimatedBaseBytes,
      cachedAssetBytes: glbStats.retainedGlbBytes + textureStats.estimatedBaseBytes,
      activeContactTargets: isDetailedHandModel(this.currentHandModel)
        ? this.lastContactTargets.flatMap((target) =>
          target.pitch === null ? [] : [{ finger: target.finger, pitch: target.pitch }])
        : [],
    };
    return diagnostics;
  }

  public waitForHandModelReady(): Promise<void> {
    if (this.isDisposed) return Promise.reject(new Error("Hand model scene is disposed."));
    if (!isDetailedHandModel(this.requestedHandModel) ||
        (this.loadState === "ready" && this.currentHandModel === this.requestedHandModel &&
         this.loadedLod === this.requestedLod)) {
      return Promise.resolve();
    }
    if (this.loadState === "error") {
      return Promise.reject(new Error(this.loadError ?? "Improved hand model failed to load."));
    }
    return new Promise((resolve, reject) => this.readyWaiters.add({ resolve, reject }));
  }

  public get wristBoundaryVertexCount(): number {
    return this.rig.wristBoundaryVertexIndices.length;
  }

  public setHandModel(handModel: HandModelId, lod: ImprovedHandLod = 0): void {
    if (this.isDisposed) return;
    if (isDetailedHandModel(handModel)) {
      // Camera-driven LOD checks call this from each rendered frame. Keep a
      // failed selection sticky until the user switches away/back or retries.
      if (isDetailedHandModel(this.requestedHandModel) && this.loadState === "error") return;
      if (this.currentHandModel === handModel && this.loadedLod === lod && this.loadState === "ready") {
        this.requestedHandModel = handModel;
        this.requestedLod = lod;
        this.loadError = null;
        this.publishHandModelDiagnostics();
        return;
      }
      if (this.requestedHandModel === handModel && this.loadState === "loading" && this.requestedLod === lod) return;
      this.requestedHandModel = handModel;
      this.requestedLod = lod;
      this.requestImprovedHandLod(lod);
      this.publishHandModelDiagnostics();
      return;
    }
    this.setLegacyHandModel(handModel);
  }

  public retryHandModelLoad(): void {
    if (this.isDisposed || !isDetailedHandModel(this.requestedHandModel) || this.loadState !== "error") return;
    const lod = this.requestedLod ?? 0;
    this.loadState = "idle";
    this.loadError = null;
    this.requestImprovedHandLod(lod);
  }

  private setLegacyHandModel(handModel: "anatomical" | "webxr"): void {
    const wasWaitingForImproved = isDetailedHandModel(this.requestedHandModel) &&
      this.loadState === "loading";
    this.requestGate.invalidate();
    this.requestedHandModel = handModel;
    this.requestedLod = null;
    this.loadError = null;
    this.loadState = "ready";
    if (wasWaitingForImproved) {
      this.rejectReadyWaiters(new Error("Improved hand model request was superseded by a legacy model selection."));
    }
    if (handModel === this.currentHandModel) {
      this.publishHandModelDiagnostics();
      return;
    }
    const previousTextureLease = this.textureLease;
    this.textureLease = null;

    // 1. Detach fingernails from distal bones so they aren't removed/lost
    for (const nail of this.fingernails) {
      nail.removeFromParent();
    }

    // 2. Remove old SkinnedMesh and bones from group
    this.group.remove(this.rig.skinnedMesh);
    this.rig.skinnedMesh.geometry.dispose();
    this.rig.skinnedMesh.skeleton.dispose();
    for (const meta of this.rig.bonesByName.values()) {
      meta.bone.removeFromParent();
    }

    // 3. Configure skinMaterial textures, normalScale, roughness for the target model
    this.configureMaterialForModel(handModel);
    this.forearmMesh.material = this.skinMaterial;

    // 4. Build new rig
    this.currentHandModel = handModel;
    this.loadedLod = null;
    this.improvedTriangleCount = 0;
    if (handModel === "anatomical") {
      this.rig = buildAnatomicalHandRig(this.hand, this.skinMaterial, this.group);
      if (this.rig.wristBoundaryVertexIndices.length !== 40) {
        void preloadAnatomicalHandModels().then(() => {
          this.upgradeToAnatomicalGlbIfReady();
        });
      }
    } else {
      this.rig = parseHandGlbRig(this.hand, this.skinMaterial, this.group);
    }

    // 5. Re-attach fingernails to new distal bones
    const NAIL_SPECS: Record<
      number,
      { bone: string; x: number; y: number; z: number; width: number; thickness: number; length: number }
    > = {
      1: { bone: "thumb-phalanx-distal", x: 0, y: 0.17, z: -0.40, width: 0.46, thickness: 0.35, length: 0.32 },
      2: { bone: "index-finger-phalanx-distal", x: 0, y: 0.17, z: -0.32, width: 0.34, thickness: 0.30, length: 0.25 },
      3: { bone: "middle-finger-phalanx-distal", x: 0, y: 0.18, z: -0.34, width: 0.36, thickness: 0.30, length: 0.26 },
      4: { bone: "ring-finger-phalanx-distal", x: 0, y: 0.17, z: -0.33, width: 0.34, thickness: 0.30, length: 0.25 },
      5: { bone: "pinky-finger-phalanx-distal", x: 0, y: 0.15, z: -0.33, width: 0.28, thickness: 0.26, length: 0.23 },
    };

    for (let f = 1; f <= 5; f++) {
      const nailMesh = this.fingernails[f - 1]!;
      const spec = NAIL_SPECS[f]!;
      nailMesh.position.set(spec.x, spec.y, spec.z);
      nailMesh.rotation.set(0, 0, 0);
      const boneMeta = this.rig.bonesByName.get(spec.bone);
      if (boneMeta) {
        boneMeta.bone.add(nailMesh);
      } else {
        this.group.add(nailMesh);
      }
      if (handModel === "anatomical") {
        nailMesh.visible = false;
      }
    }

    // 6. Rebuild forearm geometry matching new wrist boundary loop length
    this.forearmGeometry.dispose();
    this.forearmGeometry = createTubeBufferGeometry(
      FOREARM_RINGS,
      this.rig.wristBoundaryVertexIndices.length,
    );
    this.forearmMesh.geometry = this.forearmGeometry;

    // 7. Invalidate color signature so vertex colors refresh
    this.lastColorSignature = "";

    this.group.updateMatrixWorld(true);
    this.rig.skinnedMesh.skeleton.update();
    previousTextureLease?.release();
    this.resolveReadyWaiters();
    this.publishHandModelDiagnostics();
  }

  private async requestImprovedHandLod(lod: ImprovedHandLod): Promise<void> {
    const requestedModel = this.requestedHandModel;
    if (!isDetailedHandModel(requestedModel)) return;
    const token = this.requestGate.begin();
    this.loadState = "loading";
    this.loadError = null;
    this.requestedLod = lod;
    this.publishHandModelDiagnostics();

    const stagingGroup = new THREE.Group();
    let lease: ImprovedHandTextureLease | null = null;
    let stagingMaterial: THREE.MeshPhysicalMaterial | null = null;
    let stagedRig: ParsedHandGlbRig | null = null;
    try {
      const asset: ImprovedHandAsset = await this.assetLoader.load(this.hand, lod);
      lease = await this.textureCache.acquire(asset);
      if (!this.requestGate.isCurrent(token)) {
        lease.release();
        return;
      }

      stagingMaterial = this.createImprovedHandMaterial(lease);
      const buildRig = requestedModel === TESTING_HAND_MODEL_ID
        ? buildTestingHandRig
        : buildImprovedHandGlbRig;
      stagedRig = buildRig(
        this.hand,
        stagingMaterial,
        stagingGroup,
        asset.buffer,
        asset.lod,
        IMPROVED_HAND_JOINT_NAMES,
        asset.manifest.extras,
      );
      stagingGroup.updateMatrixWorld(true);
      stagedRig.skinnedMesh.skeleton.update();
      this.assertImprovedRestPose(stagedRig);

      if (!this.requestGate.isCurrent(token)) {
        this.disposeRig(stagedRig);
        stagingMaterial.dispose();
        lease.release();
        return;
      }

      const previousLease = this.textureLease;
      for (const nail of this.fingernails) nail.removeFromParent();
      this.disposeRig(this.rig);
      for (const child of [...stagingGroup.children]) {
        stagingGroup.remove(child);
        this.group.add(child);
      }

      this.configureMaterialForImproved(lease);
      stagedRig.skinnedMesh.material = this.skinMaterial;
      this.rig = stagedRig;
      this.currentHandModel = requestedModel;
      this.loadedLod = lod;
      this.improvedTriangleCount = asset.lod.triangles;
      this.textureLease = lease;
      this.forearmMesh.material = this.improvedForearmMaterial;
      this.resetForearmGeometryForCurrentRig();
      for (const nail of this.fingernails) nail.visible = false;
      this.lastColorSignature = "";
      this.loadState = "ready";
      this.loadError = null;
      lease = null;
      stagingMaterial.dispose();
      stagingMaterial = null;
      stagedRig = null;
      previousLease?.release();
      this.group.updateMatrixWorld(true);
      this.rig.skinnedMesh.skeleton.update();
      if (this.lastPose && this.lastSkinSettings) {
        this.updateFromPose(
          this.lastPose,
          this.lastSkinSettings,
          this.lastShowFingerLabels,
          this.lastHoverLift,
          this.lastContactTargets,
        );
      }
      this.resolveReadyWaiters();
      this.publishHandModelDiagnostics();
    } catch (error) {
      if (stagedRig) this.disposeRig(stagedRig);
      stagingMaterial?.dispose();
      lease?.release();
      if (this.requestGate.isCurrent(token)) {
        this.loadState = "error";
        this.loadError = errorMessage(error);
        this.rejectReadyWaiters(new Error(this.loadError));
        this.publishHandModelDiagnostics();
      }
    }
  }

  private createImprovedHandMaterial(lease: ImprovedHandTextureLease): THREE.MeshPhysicalMaterial {
    const material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      vertexColors: false,
      map: lease.baseColor,
      normalMap: lease.normal,
      roughnessMap: lease.roughness,
      roughness: 0.52,
      metalness: 0,
      transmission: 0.04,
      thickness: 0.18,
      attenuationColor: new THREE.Color(0xd94436),
      attenuationDistance: 0.75,
      sheen: 0.25,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color(0xe29382),
      clearcoat: 0.05,
      clearcoatRoughness: 0.4,
      envMapIntensity: 0.2,
      side: THREE.FrontSide,
    });
    material.normalScale.set(0.28, 0.28);
    return material;
  }

  private configureMaterialForImproved(lease: ImprovedHandTextureLease): void {
    this.skinMaterial.vertexColors = false;
    this.skinMaterial.color.set(0xffffff);
    this.skinMaterial.map = lease.baseColor;
    this.skinMaterial.normalMap = lease.normal;
    this.skinMaterial.roughnessMap = lease.roughness;
    this.skinMaterial.normalScale.set(0.28, 0.28);
    this.skinMaterial.roughness = 0.52;
    this.skinMaterial.metalness = 0;
    this.skinMaterial.transmission = 0.04;
    this.skinMaterial.thickness = 0.18;
    this.skinMaterial.attenuationColor = new THREE.Color(0xd94436);
    this.skinMaterial.attenuationDistance = 0.75;
    this.skinMaterial.sheen = 0.25;
    this.skinMaterial.sheenColor = new THREE.Color(0xe29382);
    this.skinMaterial.needsUpdate = true;
  }

  private assertImprovedRestPose(rig: ParsedHandGlbRig): void {
    const identity = new THREE.Matrix4();
    const actual = new THREE.Matrix4();
    const bones = rig.skinnedMesh.skeleton.bones;
    const inverses = rig.skinnedMesh.skeleton.boneInverses;
    for (let index = 0; index < bones.length; index++) {
      actual.multiplyMatrices(bones[index]!.matrixWorld, inverses[index]!);
      for (let component = 0; component < 16; component++) {
        if (Math.abs(actual.elements[component]! - identity.elements[component]!) > 1e-4) {
          throw new Error(`Improved hand bind matrix for ${bones[index]!.name} does not reconstruct its rest pose.`);
        }
      }
    }
  }

  private disposeRig(rig: ParsedHandGlbRig): void {
    this.group.remove(rig.skinnedMesh);
    rig.skinnedMesh.parent?.remove(rig.skinnedMesh);
    rig.skinnedMesh.geometry.dispose();
    rig.skinnedMesh.skeleton.dispose();
    for (const meta of rig.bonesByName.values()) meta.bone.removeFromParent();
  }

  private resetForearmGeometryForCurrentRig(): void {
    this.forearmGeometry.dispose();
    this.forearmGeometry = createTubeBufferGeometry(FOREARM_RINGS, this.rig.wristBoundaryVertexIndices.length);
    this.forearmMesh.geometry = this.forearmGeometry;
  }

  private publishHandModelDiagnostics(): void {
    this.group.userData.handModelDiagnostics = this.getHandModelDiagnostics();
  }

  private resolveReadyWaiters(): void {
    for (const waiter of this.readyWaiters) waiter.resolve();
    this.readyWaiters.clear();
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) waiter.reject(error);
    this.readyWaiters.clear();
  }

  private configureMaterialForModel(model: "anatomical" | "webxr"): void {
    if (model === "anatomical") {
      this.skinMaterial.vertexColors = false;
      this.skinMaterial.color.setHex(0xffffff);
      this.skinMaterial.map = getAnatomicalBaseColorTexture();
      this.skinMaterial.normalMap = getAnatomicalNormalMap();
      this.skinMaterial.normalScale.set(0.22, 0.22);
      this.skinMaterial.roughnessMap = null;
      this.skinMaterial.roughness = 0.56;
      this.skinMaterial.metalness = 0.0;
      this.skinMaterial.transmission = 0.04;
      this.skinMaterial.thickness = 0.18;
      this.skinMaterial.attenuationColor = new THREE.Color(0xd94436);
      this.skinMaterial.attenuationDistance = 0.75;
      this.skinMaterial.sheen = 0.25;
      this.skinMaterial.sheenColor = new THREE.Color(0xe29382);
    } else {
      this.skinMaterial.vertexColors = true;
      this.skinMaterial.color.setHex(0xffffff);
      this.skinMaterial.map = null;
      this.skinMaterial.normalMap = getSkinNormalMap();
      this.skinMaterial.normalScale.set(0.12, 0.12);
      this.skinMaterial.roughnessMap = getSkinRoughnessMap();
      this.skinMaterial.roughness = 0.58;
      this.skinMaterial.metalness = 0.0;
      this.skinMaterial.transmission = 0.0;
      this.skinMaterial.thickness = 0.0;
    }
    this.skinMaterial.needsUpdate = true;
  }

  private upgradeToAnatomicalGlbIfReady(): void {
    if (this.isDisposed || this.currentHandModel !== "anatomical") return;
    if (this.rig.wristBoundaryVertexIndices.length === 40) return;
    const buf = getAnatomicalHandGlbArrayBuffer(this.hand);
    if (!buf) return;

    for (const nail of this.fingernails) {
      nail.removeFromParent();
    }
    this.group.remove(this.rig.skinnedMesh);
    this.rig.skinnedMesh.geometry.dispose();
    this.rig.skinnedMesh.skeleton.dispose();
    for (const meta of this.rig.bonesByName.values()) {
      meta.bone.removeFromParent();
    }

    this.configureMaterialForModel("anatomical");
    this.rig = buildAnatomicalHandRig(this.hand, this.skinMaterial, this.group);

    const NAIL_SPECS: Record<
      number,
      { bone: string; x: number; y: number; z: number; width: number; thickness: number; length: number }
    > = {
      1: { bone: "thumb-phalanx-distal", x: 0, y: 0.17, z: -0.40, width: 0.46, thickness: 0.35, length: 0.32 },
      2: { bone: "index-finger-phalanx-distal", x: 0, y: 0.17, z: -0.32, width: 0.34, thickness: 0.30, length: 0.25 },
      3: { bone: "middle-finger-phalanx-distal", x: 0, y: 0.18, z: -0.34, width: 0.36, thickness: 0.30, length: 0.26 },
      4: { bone: "ring-finger-phalanx-distal", x: 0, y: 0.17, z: -0.33, width: 0.34, thickness: 0.30, length: 0.25 },
      5: { bone: "pinky-finger-phalanx-distal", x: 0, y: 0.15, z: -0.33, width: 0.28, thickness: 0.26, length: 0.23 },
    };

    for (let f = 1; f <= 5; f++) {
      const nailMesh = this.fingernails[f - 1]!;
      const spec = NAIL_SPECS[f]!;
      nailMesh.position.set(spec.x, spec.y, spec.z);
      nailMesh.rotation.set(0, 0, 0);
      const boneMeta = this.rig.bonesByName.get(spec.bone);
      if (boneMeta) {
        boneMeta.bone.add(nailMesh);
      } else {
        this.group.add(nailMesh);
      }
      nailMesh.visible = false;
    }

    this.forearmGeometry.dispose();
    this.forearmGeometry = createTubeBufferGeometry(
      FOREARM_RINGS,
      this.rig.wristBoundaryVertexIndices.length,
    );
    this.forearmMesh.geometry = this.forearmGeometry;
    this.lastColorSignature = "";
    this.group.updateMatrixWorld(true);
    this.rig.skinnedMesh.skeleton.update();
  }

  public getBone(name: string): THREE.Bone | undefined {
    return this.rig.bonesByName.get(name)?.bone;
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.requestGate.dispose();
    this.rejectReadyWaiters(new Error("Hand model scene was disposed while loading."));
    this.textureLease?.release();
    this.textureLease = null;
    this.rig.skinnedMesh.geometry.dispose();
    this.rig.skinnedMesh.skeleton.dispose();
    this.forearmGeometry.dispose();
    this.contactShadowGeometry.dispose();
    this.cuffGeometry.dispose();
    this.sleeveGeometry.dispose();
    this.nailGeometry.dispose();
    this.skinMaterial.dispose();
    if (!isDetailedHandModel(this.currentHandModel) &&
      this.skinMaterial.normalMap &&
      this.skinMaterial.normalMap !== sharedSkinNormalMap &&
      this.skinMaterial.normalMap !== cachedAnatomicalNormalTexture
    ) {
      this.skinMaterial.normalMap.dispose();
    }
    if (!isDetailedHandModel(this.currentHandModel) &&
      this.skinMaterial.roughnessMap &&
      this.skinMaterial.roughnessMap !== sharedSkinRoughnessMap
    ) {
      this.skinMaterial.roughnessMap.dispose();
    }
    if (!isDetailedHandModel(this.currentHandModel) &&
      this.skinMaterial.map &&
      this.skinMaterial.map !== cachedAnatomicalBaseColorTexture
    ) {
      this.skinMaterial.map.dispose();
    }
    this.nailMaterial.dispose();
    if (this.nailMaterial.map && this.nailMaterial.map !== cachedFingernailTexture) {
      this.nailMaterial.map.dispose();
    }
    this.cuffMaterial.dispose();
    this.sleeveMaterial.dispose();
    this.improvedForearmMaterial.dispose();
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
