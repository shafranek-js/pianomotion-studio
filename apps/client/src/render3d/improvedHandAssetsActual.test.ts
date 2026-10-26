// @ts-expect-error Vitest runs this asset conformance test in Node; the app
// project intentionally excludes Node types from browser source compilation.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { MotionPose } from "@handthesia/contracts";
import { DEFAULT_SKIN_SETTINGS } from "../render/skins";
import {
  buildImprovedHandGlbRig,
  Hand3DMeshGroup,
  KEYBOARD_WIDTH_IN,
  posePointToWorld,
  reconstructHand3D,
  type HandModelRuntimeDependencies,
} from "./handRigBuilder";
import {
  type ImprovedHandAsset,
  type ImprovedHandTextureLease,
  IMPROVED_HAND_JOINT_NAMES,
  validateImprovedHandManifest,
} from "./improvedHandAssets";

const manifestUrl = new URL("../../public/models/hands/improved/manifest.json", import.meta.url);
const METERS_TO_INCHES_FOR_TEST = 39.37007874;

const NEXT_BONE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["wrist", "middle-finger-metacarpal"],
  ["thumb-metacarpal", "thumb-phalanx-proximal"],
  ["thumb-phalanx-proximal", "thumb-phalanx-distal"],
  ["thumb-phalanx-distal", "thumb-tip"],
  ["index-finger-metacarpal", "index-finger-phalanx-proximal"],
  ["index-finger-phalanx-proximal", "index-finger-phalanx-intermediate"],
  ["index-finger-phalanx-intermediate", "index-finger-phalanx-distal"],
  ["index-finger-phalanx-distal", "index-finger-tip"],
  ["middle-finger-metacarpal", "middle-finger-phalanx-proximal"],
  ["middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate"],
  ["middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal"],
  ["middle-finger-phalanx-distal", "middle-finger-tip"],
  ["ring-finger-metacarpal", "ring-finger-phalanx-proximal"],
  ["ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate"],
  ["ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal"],
  ["ring-finger-phalanx-distal", "ring-finger-tip"],
  ["pinky-finger-metacarpal", "pinky-finger-phalanx-proximal"],
  ["pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate"],
  ["pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal"],
  ["pinky-finger-phalanx-distal", "pinky-finger-tip"],
];

function readArrayBuffer(url: URL): ArrayBuffer {
  const bytes = readFileSync(url);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readGlbWristBindQuaternion(buffer: ArrayBuffer): THREE.Quaternion {
  const jsonLength = new DataView(buffer).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as {
    nodes: Array<{ name: string; rotation?: [number, number, number, number] }>;
  };
  const wrist = json.nodes.find((node) => node.name === "wrist");
  if (!wrist) throw new Error("Improved hand asset has no wrist node.");
  return new THREE.Quaternion(...(wrist.rotation ?? [0, 0, 0, 1]));
}

function nativeBindRootInWrist(
  landmarks: Readonly<Record<string, readonly [number, number, number]>>,
  wristBindQuaternion: THREE.Quaternion,
  boneName: string,
): THREE.Vector3 {
  const root = landmarks[boneName];
  const wrist = landmarks.wrist;
  if (!root || !wrist) throw new Error(`Improved hand asset has no bind landmark for ${boneName}.`);
  return new THREE.Vector3(...root)
    .sub(new THREE.Vector3(...wrist))
    .multiplyScalar(METERS_TO_INCHES_FOR_TEST)
    .applyQuaternion(wristBindQuaternion.clone().invert());
}

type MutableGlbJson = Record<string, unknown> & {
  nodes: Array<{ name?: string; translation?: number[] }>;
};

function rewriteGlbJson(buffer: ArrayBuffer, edit: (json: MutableGlbJson) => void): ArrayBuffer {
  const view = new DataView(buffer);
  const jsonLength = view.getUint32(12, true);
  const jsonStart = 20;
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, jsonStart, jsonLength))) as MutableGlbJson;
  edit(json);

  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const paddedJsonLength = Math.ceil(encoded.length / 4) * 4;
  const jsonChunk = new Uint8Array(paddedJsonLength);
  jsonChunk.fill(0x20);
  jsonChunk.set(encoded);
  const binHeaderStart = jsonStart + jsonLength;
  const binLength = view.getUint32(binHeaderStart, true);
  const binaryChunk = new Uint8Array(buffer, binHeaderStart + 8, binLength);
  const totalLength = 12 + 8 + paddedJsonLength + 8 + binLength;
  const result = new ArrayBuffer(totalLength);
  const resultView = new DataView(result);
  resultView.setUint32(0, 0x46546c67, true);
  resultView.setUint32(4, 2, true);
  resultView.setUint32(8, totalLength, true);
  resultView.setUint32(12, paddedJsonLength, true);
  resultView.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(result, 20, paddedJsonLength).set(jsonChunk);
  const outputBinStart = 20 + paddedJsonLength;
  resultView.setUint32(outputBinStart, binLength, true);
  resultView.setUint32(outputBinStart + 4, 0x004e4942, true);
  new Uint8Array(result, outputBinStart + 8, binLength).set(binaryChunk);
  return result;
}

function makeFlatContactPose(hand: "left" | "right"): MotionPose {
  const wristX = hand === "left" ? 18 : 30;
  const fingerXs = [wristX - 1.2, wristX - 0.4, wristX + 0.4, wristX + 1.2];
  const chains = new Map<number, Array<[number, number, number]>>();
  [2, 3, 4, 5].forEach((finger, index) => {
    const x = fingerXs[index]!;
    chains.set(finger, [
      [x - 0.2, 0.2, 0.8],
      [x, 1.0, 0.8],
      [x, 2.0, 0.56],
      [x, 3.0, 0.16],
      [x, 4.0, 0.04],
    ]);
  });
  chains.set(1, [
    [wristX + (hand === "left" ? 1.4 : -1.4), 0.6, 0.8],
    [wristX + (hand === "left" ? 0.8 : -0.8), 1.2, 0.7],
    [wristX + (hand === "left" ? 0.3 : -0.3), 1.8, 0.36],
    [wristX, 2.5, 0.04],
  ]);

  const bones: MotionPose["bones"] = [
    { a: [wristX - 1, -1.0, 0.9], b: [wristX - 1, 0, 0.9], kind: "forearm" },
    { a: [wristX + 1, -1.0, 0.9], b: [wristX + 1, 0, 0.9], kind: "forearm" },
  ];
  const joints: MotionPose["joints"] = [
    { point: [wristX - 1, 0, 0.9], kind: "wrist" },
    { point: [wristX + 1, 0, 0.9], kind: "wrist" },
  ];
  for (const finger of [2, 3, 4, 5, 1]) {
    const chain = chains.get(finger)!;
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
  return { hand, transportTimeSeconds: 0, layerOrder: 0, bones, joints };
}

function translatePoseY(pose: MotionPose, amount: number): MotionPose {
  const translated = structuredClone(pose);
  for (const bone of translated.bones) {
    bone.a[2] += amount;
    bone.b[2] += amount;
  }
  for (const joint of translated.joints) joint.point[2] += amount;
  return translated;
}

function rotatePoseInWorld(
  pose: MotionPose,
  rotation: THREE.Quaternion,
  translation: THREE.Vector3,
): MotionPose {
  const wristPoints = pose.joints.filter((joint) => joint.kind === "wrist");
  const pivot = new THREE.Vector3();
  for (const joint of wristPoints) pivot.add(posePointToWorld(joint.point));
  if (wristPoints.length > 0) pivot.divideScalar(wristPoints.length);

  const transform = (point: readonly [number, number, number]): [number, number, number] => {
    const world = posePointToWorld(point)
      .sub(pivot)
      .applyQuaternion(rotation)
      .add(pivot)
      .add(translation);
    return [world.x + KEYBOARD_WIDTH_IN * 0.5, -world.z, world.y];
  };
  return {
    ...pose,
    bones: pose.bones.map((bone) => ({ ...bone, a: transform(bone.a), b: transform(bone.b) })),
    joints: pose.joints.map((joint) => ({ ...joint, point: transform(joint.point) })),
  };
}

function getBoneWorldMatrices(group: Hand3DMeshGroup): Map<string, number[]> {
  group.group.updateMatrixWorld(true);
  const result = new Map<string, number[]>();
  for (const name of IMPROVED_HAND_JOINT_NAMES) {
    const bone = group.group.getObjectByName(name);
    if (bone) result.set(name, [...bone.matrixWorld.elements]);
  }
  return result;
}

describe("packaged improved anatomical hand assets", () => {
  it("rejects a right-hand frame mirrored with the left-hand dorsal axis", () => {
    const manifest = validateImprovedHandManifest(JSON.parse(readFileSync(manifestUrl, "utf8")) as unknown);
    const invalid = structuredClone(manifest);
    const frame = invalid.extras.boneFrames.right["pinky-finger-tip"]!;
    frame.dorsal = frame.dorsal.map((component) => -component) as [number, number, number];
    frame.hinge = frame.hinge.map((component) => -component) as [number, number, number];

    expect(() => validateImprovedHandManifest(invalid)).toThrow(/rolled/i);
  });

  it("validates all real LOD rigs, dorsal frames, bind reconstruction, wrist loops, and MCP spacing", () => {
    const manifest = validateImprovedHandManifest(JSON.parse(readFileSync(manifestUrl, "utf8")) as unknown);
    const modelDirectoryUrl = new URL(".", manifestUrl);

    for (const path of [
      manifest.textures.high.baseColor,
      manifest.textures.high.normal,
      manifest.textures.high.roughness,
      manifest.textures.low.baseColor,
      manifest.textures.low.normal,
      manifest.textures.low.roughness,
    ]) {
      expect(readFileSync(new URL(path, modelDirectoryUrl)).byteLength).toBeGreaterThan(0);
    }

    for (const hand of ["left", "right"] as const) {
      let referenceBonePositions: Map<string, THREE.Vector3> | null = null;
      let referenceBoneQuaternions: Map<string, THREE.Quaternion> | null = null;

      for (const lod of manifest.hands[hand].lods) {
        const parent = new THREE.Group();
        const material = new THREE.MeshPhysicalMaterial({ side: THREE.FrontSide, vertexColors: false });
        const rig = buildImprovedHandGlbRig(
          hand,
          material,
          parent,
          readArrayBuffer(new URL(lod.url, modelDirectoryUrl)),
          lod,
          IMPROVED_HAND_JOINT_NAMES,
          manifest.extras,
        );

        try {
          parent.updateMatrixWorld(true);
          rig.skinnedMesh.skeleton.update();
          expect(rig.skinnedMesh.geometry.index!.count / 3).toBe(lod.triangles);
          expect(rig.skinnedMesh.geometry.getAttribute("position").count).toBe(lod.vertices);
          expect(rig.skinnedMesh.geometry.getAttribute("tangent").count).toBe(lod.vertices);
          const skinIndexAttribute = rig.skinnedMesh.geometry.getAttribute("skinIndex") as THREE.BufferAttribute;
          expect(skinIndexAttribute.array).toBeInstanceOf(Uint8Array);
          expect(skinIndexAttribute.gpuType).toBe(THREE.FloatType);
          expect(rig.skinnedMesh.geometry.getAttribute("color")).toBeUndefined();
          expect(parent.children.filter((child) => child.name.startsWith("hand-fingernail-"))).toHaveLength(0);
          expect(parent.children.filter((child) => child instanceof THREE.SkinnedMesh)).toHaveLength(1);

          const positions = rig.skinnedMesh.geometry.getAttribute("position");
          const skinIndex = rig.skinnedMesh.geometry.getAttribute("skinIndex");
          const skinWeight = rig.skinnedMesh.geometry.getAttribute("skinWeight");
          const boneIndexByName = new Map(
            [...rig.bonesByName.values()].map((meta, index) => [meta.name, index]),
          );
          expect(rig.contactSupportVertexIndicesByFinger).toHaveLength(6);
          for (let finger = 1; finger <= 5; finger++) {
            const support = rig.contactSupportVertexIndicesByFinger![finger]!;
            expect(support.length).toBeGreaterThanOrEqual(8);
            expect(support.length).toBeLessThanOrEqual(24);
            expect(new Set(support).size).toBe(support.length);
            const prefix = ["thumb", "index-finger", "middle-finger", "ring-finger", "pinky-finger"][finger - 1]!;
            const distalName = finger === 1 ? "thumb-phalanx-distal" : `${prefix}-phalanx-distal`;
            const distalIndex = boneIndexByName.get(distalName)!;
            for (const vertex of support) {
              expect(vertex).toBeGreaterThanOrEqual(0);
              expect(vertex).toBeLessThan(positions.count);
              let distalWeight = 0;
              for (let influence = 0; influence < 4; influence++) {
                if (skinIndex.getComponent(vertex, influence) === distalIndex) {
                  distalWeight += skinWeight.getComponent(vertex, influence);
                }
              }
              expect(distalWeight).toBeGreaterThanOrEqual(0.2);
            }
          }

          const boundary = lod.boundaryLoops[0]!;
          expect(boundary.length).toBeGreaterThan(12);
          expect(new Set(boundary).size).toBe(boundary.length);
          const ringCenter = new THREE.Vector3();
          let minRingY = Number.POSITIVE_INFINITY;
          let maxRingY = Number.NEGATIVE_INFINITY;
          for (const vertex of boundary) {
            const point = new THREE.Vector3().fromBufferAttribute(positions, vertex);
            ringCenter.add(point);
            minRingY = Math.min(minRingY, point.y);
            maxRingY = Math.max(maxRingY, point.y);
          }
          ringCenter.multiplyScalar(1 / boundary.length);
          expect(ringCenter.distanceTo(rig.bonesByName.get("wrist")!.bone.position)).toBeLessThan(0.75);
          expect(maxRingY - minRingY).toBeGreaterThan(0.015);

          // A spread of vertices across the full mesh must be reconstructed by
          // the actual inverse-bind matrices, not merely accepted by types.
          const sampleCount = Math.min(257, lod.vertices);
          for (let sample = 0; sample < sampleCount; sample++) {
            const vertex = Math.floor(sample * (lod.vertices - 1) / Math.max(1, sampleCount - 1));
            const rest = new THREE.Vector3().fromBufferAttribute(positions, vertex);
            const reconstructed = rig.skinnedMesh.applyBoneTransform(vertex, rest.clone());
            expect(reconstructed.distanceTo(rest)).toBeLessThan(1e-4);
          }

          const bonePositions = new Map<string, THREE.Vector3>();
          const boneQuaternions = new Map<string, THREE.Quaternion>();
          for (const name of IMPROVED_HAND_JOINT_NAMES) {
            const bone = rig.bonesByName.get(name)!.bone;
            const identity = new THREE.Matrix4().multiplyMatrices(
              bone.matrixWorld,
              rig.skinnedMesh.skeleton.boneInverses[IMPROVED_HAND_JOINT_NAMES.indexOf(name)]!,
            );
            for (let component = 0; component < 16; component++) {
              expect(identity.elements[component]).toBeCloseTo(new THREE.Matrix4().elements[component]!, 4);
            }
            bonePositions.set(name, bone.position.clone());
            boneQuaternions.set(name, bone.quaternion.clone());
          }
          for (const [boneName, nextBoneName] of NEXT_BONE_PAIRS) {
            const boneMeta = rig.bonesByName.get(boneName)!;
            const bone = boneMeta.bone;
            const transformedBindEnd = new THREE.Vector3(0, 0, -boneMeta.bindLengthIn)
              .applyMatrix4(bone.matrixWorld);
            const nextPosition = rig.bonesByName.get(nextBoneName)!.bone.getWorldPosition(new THREE.Vector3());
            expect(transformedBindEnd.distanceTo(nextPosition)).toBeLessThan(1e-5);
          }
          if (!referenceBonePositions) {
            referenceBonePositions = bonePositions;
            referenceBoneQuaternions = boneQuaternions;
          } else {
            for (const name of IMPROVED_HAND_JOINT_NAMES) {
              expect(bonePositions.get(name)!.distanceTo(referenceBonePositions.get(name)!)).toBeLessThan(1e-5);
              expect(Math.abs(boneQuaternions.get(name)!.dot(referenceBoneQuaternions!.get(name)!))).toBeGreaterThan(0.99999);
            }
          }

          const fingerPrefixes = [
            "pinky-finger",
            "ring-finger",
            "middle-finger",
            "index-finger",
          ];
          const proximalMcps = fingerPrefixes.map((prefix) =>
            rig.bonesByName.get(`${prefix}-phalanx-proximal`)!.bone.position.clone());
          const tips = fingerPrefixes.map((prefix) =>
            rig.bonesByName.get(`${prefix}-tip`)!.bone.position.clone());
          const lateralAxis = proximalMcps[3]!.clone().sub(proximalMcps[0]!).normalize();
          for (let index = 1; index < fingerPrefixes.length; index++) {
            const proximalSeparation = proximalMcps[index]!.clone().sub(proximalMcps[index - 1]!);
            const tipSeparation = tips[index]!.clone().sub(tips[index - 1]!);
            expect(proximalSeparation.dot(lateralAxis)).toBeGreaterThan(0.2);
            expect(tipSeparation.dot(lateralAxis)).toBeGreaterThan(0.2);

            const previousDip = rig.bonesByName.get(`${fingerPrefixes[index - 1]}-phalanx-distal`)!.bone.position;
            const currentDip = rig.bonesByName.get(`${fingerPrefixes[index]}-phalanx-distal`)!.bone.position;
            expect(tips[index - 1]!.distanceTo(previousDip)).toBeGreaterThan(0.1);
            expect(tips[index - 1]!.distanceTo(previousDip)).toBeLessThan(1.2);
            expect(tips[index]!.distanceTo(currentDip)).toBeGreaterThan(0.1);
            expect(tips[index]!.distanceTo(currentDip)).toBeLessThan(1.2);
          }
        } finally {
          rig.skinnedMesh.geometry.dispose();
          rig.skinnedMesh.skeleton.dispose();
          for (const meta of rig.bonesByName.values()) meta.bone.removeFromParent();
          material.dispose();
          parent.clear();
        }
      }
    }
  });

  it("rejects a transformed Armature ancestor instead of treating local joint TRS as world binds", () => {
    const manifest = validateImprovedHandManifest(JSON.parse(readFileSync(manifestUrl, "utf8")) as unknown);
    const lod = manifest.hands.left.lods[0]!;
    const modelDirectoryUrl = new URL(".", manifestUrl);
    const transformed = rewriteGlbJson(readArrayBuffer(new URL(lod.url, modelDirectoryUrl)), (json) => {
      const armatureIndex = json.nodes.findIndex((node) => node.name === "Armature");
      expect(armatureIndex).toBeGreaterThanOrEqual(0);
      json.nodes[armatureIndex]!.translation = [0.01, 0, 0];
    });
    const parent = new THREE.Group();
    const material = new THREE.MeshPhysicalMaterial({ side: THREE.FrontSide, vertexColors: false });

    try {
      expect(() => buildImprovedHandGlbRig(
        "left",
        material,
        parent,
        transformed,
        lod,
        IMPROVED_HAND_JOINT_NAMES,
        manifest.extras,
      )).toThrow(/identity-only ancestors/i);
      expect(parent.children).toHaveLength(0);
    } finally {
      material.dispose();
      parent.clear();
    }
  });

  it("deforms both packaged hands into finite posed volumes", async () => {
    const manifest = validateImprovedHandManifest(JSON.parse(readFileSync(manifestUrl, "utf8")) as unknown);
    const modelDirectoryUrl = new URL(".", manifestUrl);
    for (const hand of ["left", "right"] as const) {
      const textureLease: ImprovedHandTextureLease = {
        baseColor: new THREE.Texture(),
        normal: new THREE.Texture(),
        roughness: new THREE.Texture(),
        release: () => undefined,
      };
      const dependencies: HandModelRuntimeDependencies = {
        assetLoader: {
          load: async (requestedHand, level) => {
            const lod = manifest.hands[requestedHand].lods[level]!;
            const asset: ImprovedHandAsset = {
              manifest,
              manifestUrl,
              hand: requestedHand,
              lod,
              buffer: readArrayBuffer(new URL(lod.url, modelDirectoryUrl)),
              textureSet: manifest.textures[lod.textureSet],
            };
            return asset;
          },
          getCacheStats: () => ({ count: 1, retainedGlbBytes: 1 }),
        },
        textureCache: {
          acquire: async () => textureLease,
          getCacheStats: () => ({ count: 3, estimatedBaseBytes: 12 }),
        },
      };
      const group = new Hand3DMeshGroup(hand, "anatomical", dependencies);
      try {
        group.setHandModel("anatomical-improved", 0);
        await group.waitForHandModelReady();
        const pose = makeFlatContactPose(hand);
        group.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false, 0);
        group.group.updateMatrixWorld(true);

        const sourceLod = manifest.hands[hand].lods[0]!;
        const sourceLandmarks = sourceLod.landmarks!;
        const sourceBuffer = readArrayBuffer(new URL(sourceLod.url, modelDirectoryUrl));
        const wristBindQuaternion = readGlbWristBindQuaternion(sourceBuffer);
        const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.22, -0.08, 0.19));
        const animatedPose = rotatePoseInWorld(
          pose,
          rotation,
          new THREE.Vector3(0.31, -0.12, 0.24),
        );
        const animatedPoseJson = JSON.stringify(animatedPose);
        const targetChains = reconstructHand3D(animatedPose).chains;
        const segmentNamesByFinger: Readonly<Record<number, readonly string[]>> = {
          1: ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal"],
          2: ["index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal"],
          3: ["middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal"],
          4: ["ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal"],
          5: ["pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal"],
        };
        const nextBoneByName = new Map(NEXT_BONE_PAIRS);
        const runtimeMatrixByName = new Map<string, number[]>();

        // Each real hand has its own bind frame. Rotate and translate the pose,
        // vary width, and apply rigid hover so the native carpal root is tested
        // through the actual posed wrist TRS while all MotionPose targets remain exact.
        for (const fingerWidth of [DEFAULT_SKIN_SETTINGS.finger_width, DEFAULT_SKIN_SETTINGS.finger_width * 1.2]) {
          const settings = { ...DEFAULT_SKIN_SETTINGS, finger_width: fingerWidth };
          const expectedWidthScale = Math.max(0.75, Math.min(1.28, fingerWidth / 0.75));
          for (const hoverLift of [0, 0.65]) {
            group.updateFromPose(animatedPose, settings, false, hoverLift);
            group.group.updateMatrixWorld(true);

            const wrist = group.getBone("wrist")!;
            const wristAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(wrist.getWorldQuaternion(new THREE.Quaternion()));
            expect(Math.abs(wristAxis.z)).toBeLessThan(0.995);
            expect(wrist.scale.x).toBeCloseTo(expectedWidthScale, 6);
            expect(wrist.scale.y).toBeCloseTo(expectedWidthScale, 6);
            const hoverOffset = 0.22 * hoverLift;

            for (let finger = 1; finger <= 5; finger++) {
              const segmentNames = segmentNamesByFinger[finger]!;
              const rawChain = targetChains[finger]!;
              const expectedTargets = rawChain.map((point) => point.clone().add(new THREE.Vector3(0, hoverOffset, 0)));
              const rootName = segmentNames[0]!;
              const expectedNativeRoot = wrist.localToWorld(
                nativeBindRootInWrist(sourceLandmarks, wristBindQuaternion, rootName),
              );

              for (let segment = 0; segment < segmentNames.length; segment++) {
                const boneName = segmentNames[segment]!;
                const bone = group.getBone(boneName)!;
                const expectedStart = segment === 0 ? expectedNativeRoot : expectedTargets[segment]!;
                const expectedEnd = expectedTargets[segment + 1]!;
                const actualStart = bone.getWorldPosition(new THREE.Vector3());
                const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
                  bone.getWorldQuaternion(new THREE.Quaternion()),
                );
                const nextBoneName = nextBoneByName.get(boneName)!;
                const bindLength = new THREE.Vector3(...sourceLandmarks[boneName]!)
                  .distanceTo(new THREE.Vector3(...sourceLandmarks[nextBoneName]!))
                  * METERS_TO_INCHES_FOR_TEST;
                const actualEnd = actualStart.clone().addScaledVector(forward, bone.scale.z * bindLength);

                expect(actualStart.distanceTo(expectedStart), `${hand} ${boneName} start`).toBeLessThan(1e-4);
                expect(actualEnd.distanceTo(expectedEnd), `${hand} ${boneName} end`).toBeLessThan(1e-4);
              }

              const prefix = segmentNames[0]!.replace(/-metacarpal$/, "");
              const tip = group.getBone(`${prefix}-tip`)!.getWorldPosition(new THREE.Vector3());
              expect(tip.distanceTo(expectedTargets.at(-1)!)).toBeLessThan(1e-4);
            }

            if (fingerWidth === DEFAULT_SKIN_SETTINGS.finger_width && hoverLift === 0) {
              for (const name of segmentNamesByFinger[1]!) {
                runtimeMatrixByName.set(name, [...group.getBone(name)!.matrixWorld.elements]);
              }
            }
          }
        }

        const repeatedPose = rotatePoseInWorld(
          pose,
          rotation,
          new THREE.Vector3(0.31, -0.12, 0.24),
        );
        group.updateFromPose(repeatedPose, DEFAULT_SKIN_SETTINGS, false, 0);
        group.group.updateMatrixWorld(true);
        for (const name of segmentNamesByFinger[1]!) {
          const expected = runtimeMatrixByName.get(name)!;
          const actual = group.getBone(name)!.matrixWorld.elements;
          for (let component = 0; component < 16; component++) {
            expect(actual[component]).toBeCloseTo(expected[component]!, 8);
          }
        }
        expect(JSON.stringify(animatedPose)).toBe(animatedPoseJson);

        group.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false, 0);
        group.group.updateMatrixWorld(true);

        let posedMesh: THREE.SkinnedMesh | undefined;
        group.group.traverse((child) => {
          if (child instanceof THREE.SkinnedMesh) posedMesh = child;
        });
        expect(posedMesh).toBeDefined();
        posedMesh!.skeleton.update();
        posedMesh!.computeBoundingBox();
        const bounds = posedMesh!.boundingBox!.clone().applyMatrix4(posedMesh!.matrixWorld);
        expect(bounds.max.y).toBeGreaterThan(0.5);
        expect(bounds.min.y).toBeLessThan(0.5);
        expect(bounds.getSize(new THREE.Vector3()).length()).toBeGreaterThan(3);

        const sourcePoseJson = JSON.stringify(pose);
        const contactSupport = posedMesh!.geometry.userData
          .improvedHandContactSupportVertexIndicesByFinger as number[][];
        const assignedTarget = {
          finger: 2,
          pitch: 57,
          sourceStartSeconds: 0,
          sampleSurfaceYAt: () => 0,
        };
        const minimumSupportY = (): number => {
          group.group.updateMatrixWorld(true);
          posedMesh!.skeleton.update();
          const position = posedMesh!.geometry.getAttribute("position");
          let minimumY = Number.POSITIVE_INFINITY;
          for (const vertex of contactSupport[2]!) {
            const point = new THREE.Vector3().fromBufferAttribute(position, vertex);
            posedMesh!.applyBoneTransform(vertex, point);
            point.applyMatrix4(posedMesh!.matrixWorld);
            minimumY = Math.min(minimumY, point.y);
          }
          return minimumY;
        };

        group.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false, 0, [assignedTarget]);
        const correctedMinimumY = minimumSupportY();
        expect(JSON.stringify(pose)).toBe(sourcePoseJson);
        expect(group.getHandModelDiagnostics().activeContactTargets).toEqual([
          { finger: 2, pitch: 57 },
        ]);
        // A 0.04-inch residual is just over 1 mm; contact should converge to
        // the sampled surface within that physical tolerance.
        expect(correctedMinimumY).toBeGreaterThanOrEqual(-0.04);

        const geometry = posedMesh!.geometry;
        const normal = geometry.getAttribute("normal");
        const skinIndex = geometry.getAttribute("skinIndex");
        const skinWeight = geometry.getAttribute("skinWeight");
        const distalNameForFinger2 = "index-finger-phalanx-distal";
        const distalBoneIndex = posedMesh!.skeleton.bones.findIndex((bone) => bone.name === distalNameForFinger2);
        const restDorsal = new THREE.Vector3(...manifest.extras.restDorsalAxis);
        if (hand === "right") restDorsal.x *= -1;
        const allPalmarDistalVertices: number[] = [];
        const physicalSelectedPoints = new Set<string>();
        for (const vertex of contactSupport[2]!) {
          physicalSelectedPoints.add([
            Math.round(geometry.getAttribute("position").getX(vertex) * 10_000),
            Math.round(geometry.getAttribute("position").getY(vertex) * 10_000),
            Math.round(geometry.getAttribute("position").getZ(vertex) * 10_000),
          ].join(","));
        }
        for (let vertex = 0; vertex < geometry.getAttribute("position").count; vertex++) {
          let distalWeight = 0;
          for (let influence = 0; influence < 4; influence++) {
            if (skinIndex.getComponent(vertex, influence) === distalBoneIndex) {
              distalWeight += skinWeight.getComponent(vertex, influence);
            }
          }
          const restNormal = new THREE.Vector3(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
          if (distalWeight >= 0.2 && restNormal.dot(restDorsal) < -0.15) {
            allPalmarDistalVertices.push(vertex);
          }
        }
        expect(physicalSelectedPoints.size).toBe(contactSupport[2]!.length);
        const tipPosition = new THREE.Vector3(...manifest.hands[hand].lods[0]!.landmarks!["index-finger-tip"]!)
          .multiplyScalar(METERS_TO_INCHES_FOR_TEST);
        const nearestPadNeighborhood = allPalmarDistalVertices
          .map((vertex) => ({
            vertex,
            distance: tipPosition.distanceToSquared(
              new THREE.Vector3().fromBufferAttribute(geometry.getAttribute("position"), vertex),
            ),
          }))
          .sort((left, right) => left.distance - right.distance)
          .slice(0, 96);
        expect(nearestPadNeighborhood.length).toBeGreaterThan(24);
        const nearestPadUnique = new Set(nearestPadNeighborhood.map(({ vertex }) => {
          const position = geometry.getAttribute("position");
          return [position.getX(vertex), position.getY(vertex), position.getZ(vertex)]
            .map((component) => Math.round(component * 10_000)).join(",");
        })).size;
        expect(nearestPadUnique).toBeGreaterThanOrEqual(90);
        let padNeighborhoodMinimumY = Number.POSITIVE_INFINITY;
        for (const { vertex } of nearestPadNeighborhood) {
          const point = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute("position"), vertex);
          posedMesh!.applyBoneTransform(vertex, point);
          point.applyMatrix4(posedMesh!.matrixWorld);
          padNeighborhoodMinimumY = Math.min(padNeighborhoodMinimumY, point.y);
        }
        expect(allPalmarDistalVertices.length).toBeGreaterThan(24);
        expect(padNeighborhoodMinimumY).toBeGreaterThanOrEqual(-0.04);
        const firstContactMatrices = getBoneWorldMatrices(group);

        group.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false, 0, [assignedTarget]);
        const repeatedContactMatrices = getBoneWorldMatrices(group);
        for (const name of IMPROVED_HAND_JOINT_NAMES) {
          const first = firstContactMatrices.get(name)!;
          const repeated = repeatedContactMatrices.get(name)!;
          for (let component = 0; component < 16; component++) {
            expect(repeated[component]).toBeCloseTo(first[component]!, 8);
          }
        }

        const landmarks = manifest.hands[hand].lods[0]!.landmarks!;
        for (const [boneName, nextBoneName] of NEXT_BONE_PAIRS) {
          if (boneName === "wrist") continue;
          const bone = group.group.getObjectByName(boneName) as THREE.Bone;
          const next = group.group.getObjectByName(nextBoneName) as THREE.Bone;
          const landmarkStart = new THREE.Vector3(...landmarks[boneName]!);
          const landmarkEnd = new THREE.Vector3(...landmarks[nextBoneName]!);
          const nativeLengthIn = landmarkStart.distanceTo(landmarkEnd) * METERS_TO_INCHES_FOR_TEST;
          const transformedEndpoint = new THREE.Vector3(0, 0, -nativeLengthIn)
            .applyMatrix4(bone.matrixWorld);
          const nextWorldPosition = next.getWorldPosition(new THREE.Vector3());
          expect(transformedEndpoint.distanceTo(nextWorldPosition)).toBeLessThan(1e-4);
        }

        const hoverPose = translatePoseY(pose, 2);
        group.updateFromPose(hoverPose, DEFAULT_SKIN_SETTINGS, false, 0);
        const hoveringMatrices = getBoneWorldMatrices(group);
        expect(group.getHandModelDiagnostics().activeContactTargets).toEqual([]);
        expect(minimumSupportY()).toBeGreaterThan(1);
        group.updateFromPose(hoverPose, DEFAULT_SKIN_SETTINGS, false, 0, [assignedTarget]);
        const targetWhileHoveringMatrices = getBoneWorldMatrices(group);
        expect(minimumSupportY()).toBeGreaterThan(1);
        for (const name of IMPROVED_HAND_JOINT_NAMES) {
          const hovering = hoveringMatrices.get(name)!;
          const targeted = targetWhileHoveringMatrices.get(name)!;
          for (let component = 0; component < 16; component++) {
            expect(targeted[component]).toBeCloseTo(hovering[component]!, 8);
          }
        }
        expect(JSON.stringify(pose)).toBe(sourcePoseJson);

      } finally {
        group.dispose();
      }
    }
  });
});
