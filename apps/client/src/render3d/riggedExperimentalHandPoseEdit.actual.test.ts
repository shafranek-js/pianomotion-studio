// @ts-expect-error This actual-asset test reads the checked-in GLBs with Node fs.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { KEYBOARD_WIDTH_IN, posePointToWorld, reconstructHand3D } from "./handRigBuilder";
import {
  RIGGED_EXPERIMENTAL_POSE_BONE_SUFFIXES,
  RiggedExperimentalHand,
  riggedHandStartPoseLiveAlpha,
  type RiggedExperimentalHandPose,
} from "./riggedExperimentalHand";
import { importRiggedHandPosePresetJson } from "./riggedHandPosePreset";
import { HABANERA_49_RIGHT_SOURCE_POSE } from "./testingHandHabanera49Fixture";

type Side = "left" | "right";
type EditablePose = {
  schemaVersion: 1;
  side: Side;
  group: { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number] };
  bones: Array<{ name: string; position: [number, number, number]; quaternion: [number, number, number, number] }>;
};

function bufferFor(side: Side): ArrayBuffer {
  const bytes = readFileSync(new URL(`../../public/models/hands/rigged-experimental/${side}.glb`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function bundledStartingPose() {
  return importRiggedHandPosePresetJson(
    readFileSync(new URL("../../public/models/hands/rigged-experimental/right_hand_starting_pose.rigged-hand-pose.json", import.meta.url), "utf8"),
  );
}

function offsetMotionPose(pose: ReturnType<typeof sourcePose>, offset: readonly [number, number, number]) {
  const move = (point: [number, number, number]): [number, number, number] => {
    const world = posePointToWorld(point).add(new THREE.Vector3(...offset));
    return [world.x + KEYBOARD_WIDTH_IN * 0.5, -world.z, world.y];
  };
  return {
    ...pose,
    joints: pose.joints.map(joint => ({ ...joint, point: move(joint.point) })),
    bones: pose.bones.map(bone => ({ ...bone, a: move(bone.a), b: move(bone.b) })),
  };
}

function relativeBoneMatrices(hand: RiggedExperimentalHand): Map<string, THREE.Matrix4> {
  hand.group.updateMatrixWorld(true);
  const bones = new Map<string, THREE.Bone>();
  hand.group.traverse(node => { if (node instanceof THREE.Bone) bones.set(node.name, node); });
  const palmInverse = bones.get(`${hand.exportPose().side}_palm`)!.matrixWorld.clone().invert();
  return new Map(RIGGED_EXPERIMENTAL_POSE_BONE_SUFFIXES.map(suffix => {
    const bone = bones.get(`${hand.exportPose().side}_${suffix}`)!;
    return [suffix, palmInverse.clone().multiply(bone.matrixWorld)];
  }));
}

function matrixFromGroup(group: RiggedExperimentalHandPose["group"]): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...group.position),
    new THREE.Quaternion(...group.quaternion),
    new THREE.Vector3(...group.scale),
  );
}

function transformMotionPose(pose: ReturnType<typeof sourcePose>, transform: THREE.Matrix4) {
  const move = (point: [number, number, number]): [number, number, number] => {
    const world = posePointToWorld(point).applyMatrix4(transform);
    return [world.x + KEYBOARD_WIDTH_IN * 0.5, -world.z, world.y];
  };
  return {
    ...pose,
    joints: pose.joints.map(joint => ({ ...joint, point: move(joint.point) })),
    bones: pose.bones.map(bone => ({ ...bone, a: move(bone.a), b: move(bone.b) })),
  };
}

function sourcePose(side: Side) {
  const source = structuredClone(HABANERA_49_RIGHT_SOURCE_POSE);
  if (side === "right") return source;
  const mirror = (point: [number, number, number]): [number, number, number] => [KEYBOARD_WIDTH_IN - point[0], point[1], point[2]];
  return {
    ...source,
    hand: "left" as const,
    joints: source.joints.map((joint) => ({ ...joint, point: mirror(joint.point) })),
    bones: source.bones.map((bone) => ({ ...bone, a: mirror(bone.a), b: mirror(bone.b) })),
  };
}

function editableCopy(pose: RiggedExperimentalHandPose): EditablePose {
  return {
    schemaVersion: pose.schemaVersion,
    side: pose.side,
    group: {
      position: [...pose.group.position] as [number, number, number],
      quaternion: [...pose.group.quaternion] as [number, number, number, number],
      scale: [...pose.group.scale] as [number, number, number],
    },
    bones: pose.bones.map(bone => ({
      name: bone.name,
      position: [...bone.position] as [number, number, number],
      quaternion: [...bone.quaternion] as [number, number, number, number],
    })),
  };
}

function expectPoseClose(actual: RiggedExperimentalHandPose, expected: RiggedExperimentalHandPose): void {
  expect(actual.schemaVersion).toBe(expected.schemaVersion);
  expect(actual.side).toBe(expected.side);
  for (let axis = 0; axis < 3; axis += 1) {
    expect(actual.group.position[axis]).toBeCloseTo(expected.group.position[axis]!, 10);
    expect(actual.group.scale[axis]).toBeCloseTo(expected.group.scale[axis]!, 10);
  }
  expect(new THREE.Quaternion(...actual.group.quaternion).angleTo(new THREE.Quaternion(...expected.group.quaternion))).toBeLessThan(1e-7);
  expect(actual.bones.map(bone => bone.name)).toEqual(expected.bones.map(bone => bone.name));
  for (let index = 0; index < actual.bones.length; index += 1) {
    const current = actual.bones[index]!;
    const target = expected.bones[index]!;
    expect(current.position[0]).toBeCloseTo(target.position[0], 10);
    expect(current.position[1]).toBeCloseTo(target.position[1], 10);
    expect(current.position[2]).toBeCloseTo(target.position[2], 10);
    expect(new THREE.Quaternion(...current.quaternion).angleTo(new THREE.Quaternion(...target.quaternion))).toBeLessThan(1e-7);
  }
}

describe("rigged experimental hand pose edit runtime on actual GLBs", () => {
  for (const side of ["left", "right"] as const) {
    it(`exports the exact immutable 22-bone local pose for ${side}`, async () => {
      const hand = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      try {
        hand.update(reconstructHand3D(sourcePose(side)));
        const snapshot = hand.exportPose();
        expect(snapshot).toMatchObject({ schemaVersion: 1, side });
        expect(snapshot.bones.map(bone => bone.name)).toEqual(RIGGED_EXPERIMENTAL_POSE_BONE_SUFFIXES.map(suffix => `${side}_${suffix}`));
        expect(snapshot.bones).toHaveLength(22);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.group)).toBe(true);
        expect(Object.isFrozen(snapshot.group.position)).toBe(true);
        expect(Object.isFrozen(snapshot.bones)).toBe(true);
        expect(snapshot.bones.every(bone => Object.isFrozen(bone) && Object.isFrozen(bone.position) && Object.isFrozen(bone.quaternion))).toBe(true);
        expect(snapshot.group.quaternion).toHaveLength(4);
        for (const bone of snapshot.bones) {
          expect(bone.position).toHaveLength(3);
          expect(bone.quaternion).toHaveLength(4);
          expect([...bone.position, ...bone.quaternion].every(Number.isFinite)).toBe(true);
        }
      } finally {
        hand.dispose();
      }
    });
  }

  it("retargets the bundled right pose in actual bind-palm frames, mirrors every joint for left, and preserves each live anchor", async () => {
    const preset = bundledStartingPose();
    const right = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
    const left = await RiggedExperimentalHand.fromBuffer("left", bufferFor("left"));
    try {
      expect({ left: left.sourceAssetSha256, right: right.sourceAssetSha256 }).toEqual(preset.sourceGlbSha256);
      const rightStart = right.retargetPoseToHand(preset.hands.right, right, false);
      const leftStart = right.retargetPoseToHand(preset.hands.right, left, true);

      const shiftedRight = offsetMotionPose(sourcePose("right"), [5.25, 0.4, -0.3]);
      const shiftedLeft = offsetMotionPose(sourcePose("left"), [-4.5, -0.2, 0.25]);
      const rightFrame = reconstructHand3D(shiftedRight);
      const leftFrame = reconstructHand3D(shiftedLeft);
      right.update(rightFrame, { pose: rightStart, liveAlpha: 0 });
      left.update(leftFrame, { pose: leftStart, liveAlpha: 0 });

      const source = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
      try {
        source.applyPose(preset.hands.right);
        const sourceRelative = relativeBoneMatrices(source);
        const actualRightRelative = relativeBoneMatrices(right);
        const actualLeftRelative = relativeBoneMatrices(left);
        const reflect = new THREE.Matrix4().makeScale(-1, 1, 1);
        for (const suffix of RIGGED_EXPERIMENTAL_POSE_BONE_SUFFIXES) {
          const expectedRight = sourceRelative.get(suffix)!;
          const expectedLeft = reflect.clone().multiply(expectedRight).multiply(reflect);
          const rightElements = actualRightRelative.get(suffix)!.elements;
          const leftElements = actualLeftRelative.get(suffix)!.elements;
          for (let element = 0; element < 16; element += 1) {
            expect(rightElements[element], `right ${suffix} matrix element ${element}`).toBeCloseTo(expectedRight.elements[element]!, 4);
            expect(leftElements[element], `left ${suffix} mirrored matrix element ${element}`).toBeCloseTo(expectedLeft.elements[element]!, 4);
          }
        }
      } finally {
        source.dispose();
      }

      const rightPalm = right.group.getObjectByName("right_palm")!;
      const leftPalm = left.group.getObjectByName("left_palm")!;
      expect(rightPalm.getWorldPosition(new THREE.Vector3()).distanceTo(rightFrame.wristCenter)).toBeLessThan(1e-4);
      expect(leftPalm.getWorldPosition(new THREE.Vector3()).distanceTo(leftFrame.wristCenter)).toBeLessThan(1e-4);
      const sampleRightAt = (displayedTimeSeconds: number) => {
        right.update(rightFrame, {
          pose: rightStart,
          liveAlpha: riggedHandStartPoseLiveAlpha(displayedTimeSeconds, 2),
        });
        return right.exportPose();
      };
      const beforeSeek = sampleRightAt(-0.3);
      sampleRightAt(-1.4);
      const afterSeek = sampleRightAt(-0.3);
      expectPoseClose(afterSeek, beforeSeek);

      right.setPoseEditMode(true);
      const frozen = right.exportPose();
      right.update(reconstructHand3D(sourcePose("right")), { pose: rightStart, liveAlpha: 0 });
      expectPoseClose(right.exportPose(), frozen);
      right.restoreAnimatedPose();
    } finally {
      right.dispose();
      left.dispose();
    }
  });

  it("matches the edit preset's actual right-hand bones and skinned samples at its Habanera group anchor", async () => {
    const preset = bundledStartingPose();
    const runtime = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
    const edited = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
    try {
      const sourceMotionPose = sourcePose("right");
      runtime.update(reconstructHand3D(sourceMotionPose));
      const dynamicBaseGroup = runtime.exportPose().group;
      const rotationDelta = new THREE.Quaternion(...preset.hands.right.group.quaternion)
        .multiply(new THREE.Quaternion(...dynamicBaseGroup.quaternion).invert());
      const rotatedMotionPose = transformMotionPose(
        sourceMotionPose,
        new THREE.Matrix4().makeRotationFromQuaternion(rotationDelta),
      );
      runtime.update(reconstructHand3D(rotatedMotionPose));
      const rotatedGroup = runtime.exportPose().group;
      const positionDelta = preset.hands.right.group.position.map((value, axis) => value - rotatedGroup.position[axis]!) as [number, number, number];
      const anchoredMotionPose = offsetMotionPose(rotatedMotionPose, positionDelta);
      const startPose = runtime.retargetPoseToHand(preset.hands.right, runtime, false);
      runtime.update(reconstructHand3D(anchoredMotionPose), { pose: startPose, liveAlpha: 0 });
      edited.applyPose(preset.hands.right);

      const runtimeGroup = runtime.exportPose().group;
      for (let axis = 0; axis < 3; axis += 1) {
        expect(runtimeGroup.position[axis]).toBeCloseTo(preset.hands.right.group.position[axis]!, 8);
        expect(runtimeGroup.scale[axis]).toBeCloseTo(preset.hands.right.group.scale[axis]!, 8);
      }
      expect(new THREE.Quaternion(...runtimeGroup.quaternion).angleTo(new THREE.Quaternion(...preset.hands.right.group.quaternion))).toBeLessThan(1e-7);
      const runtimeSample = runtime.sampleLiveDiagnostics();
      const editSample = edited.sampleLiveDiagnostics();
      expect(runtimeSample.unavailableFingerSamples).toEqual([]);
      expect(runtimeSample.boneWorldTransformRows).toEqual(editSample.boneWorldTransformRows);
      expect(runtimeSample.fixedDistalSkinSampleRows).toEqual(editSample.fixedDistalSkinSampleRows);
    } finally {
      runtime.dispose();
      edited.dispose();
    }
  });

  it("maps lead-in blend deterministically from displayed time, including zero lead-in and seeks", () => {
    expect(riggedHandStartPoseLiveAlpha(-2, 2)).toBe(0);
    expect(riggedHandStartPoseLiveAlpha(-1, 2)).toBe(0.5);
    expect(riggedHandStartPoseLiveAlpha(-0.25, 2)).toBeGreaterThan(0.9);
    expect(riggedHandStartPoseLiveAlpha(-2 + 1e-4, 2)).toBeLessThan(1e-7);
    expect(riggedHandStartPoseLiveAlpha(-1e-4, 2)).toBeGreaterThan(0.999999);
    expect(riggedHandStartPoseLiveAlpha(0, 2)).toBe(1);
    expect(riggedHandStartPoseLiveAlpha(-1, 0)).toBe(1);
    expect(riggedHandStartPoseLiveAlpha(-3, 1)).toBe(0);
    expect(riggedHandStartPoseLiveAlpha(-0.5, 1)).toBe(riggedHandStartPoseLiveAlpha(-0.5, 1));
  });

  it("freezes sequential animation updates, edits/reapplies a saved pose, and restores the captured animated frame", async () => {
    const hand = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
    const reloaded = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
    try {
      const animationA = reconstructHand3D(sourcePose("right"));
      const animationB = reconstructHand3D(sourcePose("right"));
      animationB.chains[2]![3]!.add(new THREE.Vector3(0, -0.7, 0));

      hand.update(animationA);
      const animationFrame = hand.exportPose();
      hand.setPoseEditMode(true);
      expect(hand.isPoseEditMode).toBe(true);
      hand.update(animationB);
      expectPoseClose(hand.exportPose(), animationFrame);

      const edited = editableCopy(animationFrame);
      edited.group.position = [edited.group.position[0] + 0.3, edited.group.position[1] - 0.2, edited.group.position[2] + 0.1];
      const indexJoint = edited.bones.find(bone => bone.name === "right_index_intermediate")!;
      indexJoint.position = [indexJoint.position[0] + 0.025, indexJoint.position[1], indexJoint.position[2]];
      const indexRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.31);
      indexJoint.quaternion = [indexRotation.x, indexRotation.y, indexRotation.z, indexRotation.w];
      hand.applyPose(edited);
      const savedPreset = hand.exportPose();
      expect(hand.isPoseEditMode).toBe(true);
      hand.update(animationB);
      expectPoseClose(hand.exportPose(), savedPreset);

      hand.restoreAnimatedPose();
      expect(hand.isPoseEditMode).toBe(false);
      expectPoseClose(hand.exportPose(), animationFrame);
      hand.update(animationB);
      expect(hand.exportPose().bones.find(bone => bone.name === "right_index_intermediate")!.quaternion)
        .not.toEqual(animationFrame.bones.find(bone => bone.name === "right_index_intermediate")!.quaternion);

      reloaded.applyPose(savedPreset);
      expectPoseClose(reloaded.exportPose(), savedPreset);
      expect(reloaded.isPoseEditMode).toBe(true);
    } finally {
      hand.dispose();
      reloaded.dispose();
    }
  });

  it("keeps two real hand instances isolated and gates direct gizmo access to edit mode", async () => {
    const left = await RiggedExperimentalHand.fromBuffer("left", bufferFor("left"));
    const right = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
    try {
      left.update(reconstructHand3D(sourcePose("left")));
      right.update(reconstructHand3D(sourcePose("right")));
      const rightBefore = right.exportPose();
      expect(() => left.getEditableBone("left_index_proximal")).toThrow(/only in pose edit mode/);

      const leftPose = editableCopy(left.exportPose());
      leftPose.group.position = [leftPose.group.position[0] + 0.5, leftPose.group.position[1], leftPose.group.position[2]];
      left.applyPose(leftPose);
      const bone = left.getEditableBone("left_index_proximal");
      bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.2));
      left.refreshPoseEdit();
      expect(left.exportPose().group.position[0]).toBeCloseTo(leftPose.group.position[0], 10);
      expectPoseClose(right.exportPose(), rightBefore);
      const diagnosticPose = left.sampleLiveDiagnostics();
      expect(diagnosticPose.boneWorldTransformRows).toHaveLength(22);
      expect(diagnosticPose.boneWorldTransformRows.every(row => row.every(Number.isFinite))).toBe(true);
      expect(() => left.getEditableBone("right_index_proximal")).toThrow(/unknown left bone name/);
      expect(() => left.refreshPoseEdit()).not.toThrow();
    } finally {
      left.dispose();
      right.dispose();
    }
  });

  it("restores the imported GLB base pose when pose editing starts before animation", async () => {
    const hand = await RiggedExperimentalHand.fromBuffer("left", bufferFor("left"));
    try {
      const importedBase = hand.exportPose();
      hand.setPoseEditMode(true);
      const edited = editableCopy(importedBase);
      edited.group.position = [edited.group.position[0] + 0.25, edited.group.position[1], edited.group.position[2]];
      edited.bones.find(bone => bone.name === "left_thumb_segment1_mcp-to-ip")!.position[1] += 0.02;
      hand.applyPose(edited);
      hand.restoreAnimatedPose();
      expect(hand.isPoseEditMode).toBe(false);
      expectPoseClose(hand.exportPose(), importedBase);
    } finally {
      hand.dispose();
    }
  });

  it("rejects malformed, non-finite, non-unit, unknown, duplicate, incomplete, and opposite-side snapshots atomically", async () => {
    const hand = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
    try {
      hand.update(reconstructHand3D(sourcePose("right")));
      const before = hand.exportPose();
      const invalid: Array<[string, (pose: EditablePose) => void]> = [
        ["non-finite group translation", pose => { pose.group.position = [Number.NaN, 0, 0]; }],
        ["sparse group translation", pose => { pose.group.position = new Array(3) as [number, number, number]; }],
        ["non-unit group quaternion", pose => { pose.group.quaternion = [0, 0, 0, 0]; }],
        ["unknown bone name", pose => { pose.bones[0]!.name = "right_unrecognized"; }],
        ["duplicate bone name", pose => { pose.bones[1]!.name = pose.bones[0]!.name; }],
        ["non-finite bone translation", pose => { pose.bones[0]!.position = [0, Infinity, 0]; }],
        ["missing bone", pose => { pose.bones.pop(); }],
        ["other hand side", pose => { pose.side = "left"; }],
      ];
      for (const [label, mutate] of invalid) {
        const malformed = editableCopy(before);
        mutate(malformed);
        expect(() => hand.applyPose(malformed), label).toThrow();
        expect(hand.isPoseEditMode, `${label} does not enter manual mode`).toBe(false);
        expectPoseClose(hand.exportPose(), before);
      }
    } finally {
      hand.dispose();
    }
  });
});
