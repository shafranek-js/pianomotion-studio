// @ts-expect-error Vitest runs this asset conformance test in Node; browser source compilation omits Node types.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { MotionPose } from "@handthesia/contracts";
import { DEFAULT_SKIN_SETTINGS } from "../render/skins";
import {
  Hand3DMeshGroup,
  KEYBOARD_WIDTH_IN,
  posePointToWorld,
  reconstructHand3D,
} from "./handRigBuilder";

const METERS_TO_INCHES = 39.37007874;
const anatomicalAssets = new URL("../../public/models/hands/", import.meta.url);
const fingerSegments: Readonly<Record<number, readonly [string, number][]>> = {
  1: [["thumb-metacarpal", 0], ["thumb-phalanx-proximal", 1], ["thumb-phalanx-distal", 2]],
  2: [["index-finger-metacarpal", 0], ["index-finger-phalanx-proximal", 1], ["index-finger-phalanx-intermediate", 2], ["index-finger-phalanx-distal", 3]],
  3: [["middle-finger-metacarpal", 0], ["middle-finger-phalanx-proximal", 1], ["middle-finger-phalanx-intermediate", 2], ["middle-finger-phalanx-distal", 3]],
  4: [["ring-finger-metacarpal", 0], ["ring-finger-phalanx-proximal", 1], ["ring-finger-phalanx-intermediate", 2], ["ring-finger-phalanx-distal", 3]],
  5: [["pinky-finger-metacarpal", 0], ["pinky-finger-phalanx-proximal", 1], ["pinky-finger-phalanx-intermediate", 2], ["pinky-finger-phalanx-distal", 3]],
};

function makePose(hand: "left" | "right", separation = 0.8): MotionPose {
  const wristX = hand === "left" ? 18 : 30;
  const bones: MotionPose["bones"] = [
    { a: [wristX - 1, -1, 0.9], b: [wristX - 1, 0, 0.9], kind: "forearm" },
    { a: [wristX + 1, -1, 0.9], b: [wristX + 1, 0, 0.9], kind: "forearm" },
    ...Array.from({ length: 7 }, (_, index) => ({
      a: [wristX - 1 + index * 0.2, 0, 0.9] as [number, number, number],
      b: [wristX - 0.8 + index * 0.2, 0.2, 0.9] as [number, number, number],
      kind: "carpal" as const,
    })),
  ];
  const joints: MotionPose["joints"] = [];

  for (const finger of [2, 3, 4, 5] as const) {
    const x = wristX + (finger - 3.5) * separation;
    const points: [number, number, number][] = [
      [x - 0.2, 0.2, 0.8],
      [x, 1.0, 0.8],
      [x + 0.06, 2.0, 0.56],
      [x + 0.1, 3.0, 0.16],
      [x + 0.12, 4.0, 0.04],
    ];
    bones.push(
      { a: points[0]!, b: points[1]!, kind: "metacarpal" },
      { a: points[1]!, b: points[2]!, kind: "proximal" },
      { a: points[2]!, b: points[3]!, kind: "middle" },
      { a: points[3]!, b: points[4]!, kind: "distal" },
    );
    joints.push(
      { point: points[2]!, kind: "knuckle" },
      { point: points[3]!, kind: "knuckle" },
      { point: points[4]!, kind: "tip" },
    );
  }

  const thumb = [
    [wristX + (hand === "left" ? 1.4 : -1.4), 0.6, 0.8],
    [wristX + (hand === "left" ? 0.8 : -0.8), 1.2, 0.7],
    [wristX + (hand === "left" ? 0.3 : -0.3), 1.8, 0.36],
    [wristX, 2.5, 0.04],
  ] as [number, number, number][];
  bones.push(
    { a: thumb[0]!, b: thumb[1]!, kind: "metacarpal" },
    { a: thumb[1]!, b: thumb[2]!, kind: "proximal" },
    { a: thumb[2]!, b: thumb[3]!, kind: "distal" },
  );
  joints.push(
    { point: thumb[2]!, kind: "knuckle" },
    { point: thumb[3]!, kind: "tip" },
    { point: [wristX - 1, 0, 0.9], kind: "wrist" },
    { point: [wristX + 1, 0, 0.9], kind: "wrist" },
  );

  return { hand, transportTimeSeconds: 0, layerOrder: 0, bones, joints };
}

function rotatePose(
  pose: MotionPose,
  rotation: THREE.Quaternion,
  translation: THREE.Vector3,
): MotionPose {
  const transform = (point: readonly [number, number, number]): [number, number, number] => {
    const world = posePointToWorld(point).applyQuaternion(rotation).add(translation);
    return [world.x + KEYBOARD_WIDTH_IN * 0.5, -world.z, world.y];
  };
  return {
    ...pose,
    bones: pose.bones.map((bone) => ({ ...bone, a: transform(bone.a), b: transform(bone.b) })),
    joints: pose.joints.map((joint) => ({ ...joint, point: transform(joint.point) })),
  };
}

function readGlbNormals(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as {
    meshes: Array<{ primitives: Array<{ attributes: { NORMAL: number } }> }>;
    accessors: Array<{ bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }>;
    bufferViews: Array<{ byteOffset?: number }>;
  };
  const accessor = json.accessors[json.meshes[0]!.primitives[0]!.attributes.NORMAL]!;
  const bufferView = json.bufferViews[accessor.bufferView]!;
  const byteOffset = 20 + jsonLength + 8 + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return new Float32Array(buffer.slice(byteOffset, byteOffset + accessor.count * 3 * 4));
}

function readNativeBindLengthIn(buffer: ArrayBuffer, boneName: string, nextBoneName: string): number {
  const jsonLength = new DataView(buffer).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as {
    nodes: Array<{ name: string; translation?: [number, number, number] }>;
  };
  const start = json.nodes.find((node) => node.name === boneName)?.translation;
  const end = json.nodes.find((node) => node.name === nextBoneName)?.translation;
  if (!start || !end) throw new Error(`Missing actual anatomical bind joint ${boneName} or ${nextBoneName}.`);
  return new THREE.Vector3(...start).distanceTo(new THREE.Vector3(...end)) * METERS_TO_INCHES;
}

describe("actual anatomical hand rig", () => {
  it("maps close crossing fingers by their complete source chain and reports disconnected input", () => {
    const pose = makePose("right", 0.035);
    const sourceJson = JSON.stringify(pose);
    const reconstructed = reconstructHand3D(pose);
    expect(reconstructed.chainDiagnostics).toEqual([]);

    for (const finger of [2, 3, 4, 5, 1]) {
      const indices = finger === 1 ? [25, 26, 27] : [9 + (finger - 2) * 4, 10 + (finger - 2) * 4, 11 + (finger - 2) * 4, 12 + (finger - 2) * 4];
      const sourceChain = finger === 1
        ? [pose.bones[indices[0]!]!.a, pose.bones[indices[0]!]!.b, pose.bones[indices[1]!]!.b, pose.bones[indices[2]!]!.b]
        : [pose.bones[indices[0]!]!.a, pose.bones[indices[0]!]!.b, pose.bones[indices[1]!]!.b, pose.bones[indices[2]!]!.b, pose.bones[indices[3]!]!.b];
      expect(reconstructed.chains[finger]).toHaveLength(sourceChain.length);
      for (let index = 0; index < sourceChain.length; index++) {
        expect(reconstructed.chains[finger]![index]!.distanceTo(posePointToWorld(sourceChain[index]!)))
          .toBeLessThan(1e-8);
      }
    }
    expect(JSON.stringify(pose)).toBe(sourceJson);

    const shuffled = { ...pose, bones: [...pose.bones].reverse() };
    expect(Object.keys(reconstructHand3D(shuffled).chains).map(Number).sort()).toEqual([1, 2, 3, 4, 5]);

    const disconnected = structuredClone(pose);
    disconnected.bones[11]!.a = [disconnected.bones[11]!.a[0] + 0.3, disconnected.bones[11]!.a[1], disconnected.bones[11]!.a[2]];
    const failed = reconstructHand3D(disconnected);
    expect(failed.chains[2]).toBeUndefined();
    expect(failed.chainDiagnostics).toContainEqual(expect.objectContaining({ finger: 2, code: "disconnected-chain" }));
  });

  it("keeps imported GLB normals and reaches each posed phalanx endpoint for both hands", () => {
    for (const hand of ["left", "right"] as const) {
      const bufferBytes = readFileSync(new URL(`anatomical_${hand}.glb`, anatomicalAssets));
      const buffer = bufferBytes.buffer.slice(
        bufferBytes.byteOffset,
        bufferBytes.byteOffset + bufferBytes.byteLength,
      ) as ArrayBuffer;
      const expectedNormals = readGlbNormals(buffer);
      const group = new Hand3DMeshGroup(hand, "anatomical");
      try {
        const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.16, -0.11, 0.13));
        const pose = rotatePose(makePose(hand), rotation, new THREE.Vector3(0.2, -0.1, 0.15));
        const poseJson = JSON.stringify(pose);
        const reconstructed = reconstructHand3D(pose);
        expect(reconstructed.chainDiagnostics).toEqual([]);
        group.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false, 0);
        group.group.updateMatrixWorld(true);

        let actualMesh: THREE.SkinnedMesh | null = null;
        group.group.traverse((object) => {
          if (object instanceof THREE.SkinnedMesh) actualMesh = object;
        });
        expect(actualMesh).not.toBeNull();
        const actualNormals = actualMesh!.geometry.getAttribute("normal").array as Float32Array;
        expect(actualNormals).toEqual(expectedNormals);

        for (let finger = 1; finger <= 5; finger++) {
          const chain = reconstructed.chains[finger]!;
          const segments = fingerSegments[finger]!;
          for (const [boneName, chainIndex] of segments.slice(1)) {
            const bone = group.getBone(boneName)!;
            const segmentIndex = segments.findIndex(([name]) => name === boneName);
            const nextBoneName = segments[segmentIndex + 1]?.[0] ?? `${boneName.split("-").slice(0, -2).join("-")}-tip`;
            const next = group.getBone(nextBoneName)!;
            const actualStart = bone.getWorldPosition(new THREE.Vector3());
            const expectedStart = chain[chainIndex]!;
            expect(actualStart.distanceTo(expectedStart), `${hand} ${boneName} start`).toBeLessThan(1e-4);

            const bindLength = readNativeBindLengthIn(buffer, boneName, nextBoneName);
            const segmentLength = bone.scale.z * bindLength;
            const actualEnd = actualStart.clone().addScaledVector(
              new THREE.Vector3(0, 0, -1).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())),
              segmentLength,
            );
            expect(actualEnd.distanceTo(chain[chainIndex + 1]!), `${hand} ${boneName} endpoint`)
              .toBeLessThan(1e-3);
            expect(next.getWorldPosition(new THREE.Vector3()).distanceTo(chain[chainIndex + 1]!))
              .toBeLessThan(1e-4);
          }
        }
        expect(JSON.stringify(pose)).toBe(poseJson);
      } finally {
        group.dispose();
      }
    }
  });

  it("places each anatomical palmar pad on its assigned sampled white or black key surface", () => {
    const hand = "right" as const;
    const pose = makePose(hand);
    const sourcePose = JSON.stringify(pose);
    const reconstructed = reconstructHand3D(pose);
    const targets = [1, 2, 3, 4, 5].map((finger) => {
      const tip = reconstructed.chains[finger]!.at(-1)!;
      const pitch = 59 + finger;
      const height = pitch % 2 === 0 ? 0 : 0.38;
      const keyHalfWidth = pitch % 2 === 0 ? 0.42 : 0.23;
      return {
        finger,
        pitch,
        sourceStartSeconds: 0,
        contactCenterX: tip.x,
        contactMinX: tip.x - keyHalfWidth,
        contactMaxX: tip.x + keyHalfWidth,
        contactMinZ: tip.z - 1.2,
        contactMaxZ: tip.z + 1.2,
        sampleSurfaceYAt: (samplePitch: number, x: number, z: number): number | null =>
          samplePitch === pitch && Math.abs(x - tip.x) <= keyHalfWidth &&
          Math.abs(z - tip.z) <= 1.2 ? height : null,
      };
    });
    const group = new Hand3DMeshGroup(hand, "anatomical");
    try {
      group.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false, 0, targets);
      group.group.updateMatrixWorld(true);

      let actualMesh: THREE.SkinnedMesh | null = null;
      group.group.traverse((object) => {
        if (object instanceof THREE.SkinnedMesh) actualMesh = object;
      });
      expect(actualMesh).not.toBeNull();
      actualMesh!.skeleton.update();
      const supportByFinger = actualMesh!.geometry.userData
        .handContactSupportVertexIndicesByFinger as number[][];
      expect(supportByFinger).toHaveLength(6);

      for (const target of targets) {
        expect(supportByFinger[target.finger]!.length).toBeGreaterThanOrEqual(8);
        let minimumClearance = Number.POSITIVE_INFINITY;
        let sampledCount = 0;
        for (const vertex of supportByFinger[target.finger]!) {
          const point = new THREE.Vector3().fromBufferAttribute(actualMesh!.geometry.getAttribute("position"), vertex);
          actualMesh!.applyBoneTransform(vertex, point);
          point.applyMatrix4(actualMesh!.matrixWorld);
          const surfaceY = target.sampleSurfaceYAt(target.pitch, point.x, point.z);
          if (surfaceY === null) continue;
          sampledCount++;
          minimumClearance = Math.min(minimumClearance, point.y - surfaceY);
        }
        expect(sampledCount, `finger ${target.finger} sampled on its assigned key`).toBeGreaterThan(0);
        expect(minimumClearance, `finger ${target.finger} avoids interpenetration`).toBeGreaterThanOrEqual(-0.04);
        expect(minimumClearance, `finger ${target.finger} reaches its key surface`).toBeLessThan(0.08);
      }
      expect(JSON.stringify(pose)).toBe(sourcePose);
    } finally {
      group.dispose();
    }
  });
});
