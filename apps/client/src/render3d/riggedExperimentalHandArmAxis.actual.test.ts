// @ts-expect-error Node-only GLB fixture loading; browser compilation omits Node types.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { KEYBOARD_WIDTH_IN, reconstructHand3D } from "./handRigBuilder";
import {
  RIGGED_EXPERIMENTAL_POSE_BONE_SUFFIXES,
  RiggedExperimentalHand,
  riggedHandStartPoseLiveAlpha,
  type RiggedExperimentalHandPose,
} from "./riggedExperimentalHand";
import { importRiggedHandPosePresetJson } from "./riggedHandPosePreset";
import { HABANERA_49_RIGHT_SOURCE_POSE } from "./testingHandHabanera49Fixture";

type Side = "left" | "right";

function bufferFor(side: Side): ArrayBuffer {
  const bytes = readFileSync(new URL(`../../public/models/hands/rigged-experimental/${side}.glb`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function startingPose(): RiggedExperimentalHandPose {
  const json = readFileSync(new URL("../../public/models/hands/rigged-experimental/right_hand_starting_pose.rigged-hand-pose.json", import.meta.url), "utf8");
  return importRiggedHandPosePresetJson(json).hands.right;
}

function motionPose(side: Side) {
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

function bonesFor(hand: RiggedExperimentalHand): Map<string, THREE.Bone> {
  const bones = new Map<string, THREE.Bone>();
  hand.group.traverse((node) => { if (node instanceof THREE.Bone) bones.set(node.name, node); });
  return bones;
}

function worldAxis(hand: RiggedExperimentalHand, side: Side): THREE.Vector3 {
  const bones = bonesFor(hand);
  hand.group.updateMatrixWorld(true);
  const forearm = bones.get(`${side}_forearm`)!.getWorldPosition(new THREE.Vector3());
  const wrist = bones.get(`${side}_palm`)!.getWorldPosition(new THREE.Vector3());
  return wrist.sub(forearm).normalize();
}

function targetAxis(pose: ReturnType<typeof reconstructHand3D>): THREE.Vector3 {
  return pose.wristCenter.clone().sub(pose.armEnd).normalize();
}

function worldBoneMatrices(hand: RiggedExperimentalHand, side: Side, suffixes: readonly string[]): THREE.Matrix4[] {
  const bones = bonesFor(hand);
  hand.group.updateMatrixWorld(true);
  return suffixes.map((suffix) => bones.get(`${side}_${suffix}`)!.matrixWorld.clone());
}

function expectSameBoneTransforms(
  actual: readonly THREE.Matrix4[],
  expected: readonly THREE.Matrix4[],
): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((matrix, index) => matrix.elements.forEach((value, element) => {
    expect(value).toBeCloseTo(expected[index]!.elements[element]!, 5);
  }));
}

function expectPoseSame(actual: RiggedExperimentalHandPose, expected: RiggedExperimentalHandPose, tolerance = 1e-7): void {
  expect(actual.side).toBe(expected.side);
  expect(actual.group.position.map((value, index) => Math.abs(value - expected.group.position[index]!)).every((delta) => delta < tolerance)).toBe(true);
  expect(new THREE.Quaternion(...actual.group.quaternion).angleTo(new THREE.Quaternion(...expected.group.quaternion))).toBeLessThan(tolerance);
  for (const [index, bone] of actual.bones.entries()) {
    const reference = expected.bones[index]!;
    expect(bone.name).toBe(reference.name);
    expect(bone.position.map((value, axis) => Math.abs(value - reference.position[axis]!)).every((delta) => delta < tolerance)).toBe(true);
    expect(new THREE.Quaternion(...bone.quaternion).angleTo(new THREE.Quaternion(...reference.quaternion))).toBeLessThan(tolerance);
  }
}

describe("experimental hand source-axis forearm alignment on actual GLBs", () => {
  for (const side of ["left", "right"] as const) {
    it(`${side}: aligns the root-to-wrist axis while preserving the palm anchor and finger bones`, async () => {
      const hand = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      try {
        const source = motionPose(side);
        const pose = reconstructHand3D(source);
        const baselinePose = { ...pose, armEnd: pose.wristCenter.clone() };
        hand.update(baselinePose);
        const baselineAxis = worldAxis(hand, side);
        const baselineError = baselineAxis.angleTo(targetAxis(pose));
        const bones = bonesFor(hand);
        const palm = bones.get(`${side}_palm`)!;
        const palmPosition = palm.getWorldPosition(new THREE.Vector3());
        const palmQuaternion = palm.getWorldQuaternion(new THREE.Quaternion());
        palm.updateWorldMatrix(true, false);
        const palmMatrix = palm.matrixWorld.clone();
        const fingerSuffixes = RIGGED_EXPERIMENTAL_POSE_BONE_SUFFIXES.filter((suffix) => suffix !== "forearm" && suffix !== "palm");
        const fingerTransforms = worldBoneMatrices(hand, side, fingerSuffixes);

        hand.update(pose);
        const correctedError = worldAxis(hand, side).angleTo(targetAxis(pose));
        expect(baselineError).toBeGreaterThan(THREE.MathUtils.degToRad(0.25));
        expect(correctedError).toBeLessThan(Math.min(1e-5, baselineError * 1e-4));
        expect(palm.getWorldPosition(new THREE.Vector3()).distanceTo(palmPosition)).toBeLessThan(1e-6);
        // Matrix decomposition of these imported GLB chains has a small residual;
        // check its reported world quaternion and the complete world matrix.
        expect(palm.getWorldQuaternion(new THREE.Quaternion()).angleTo(palmQuaternion)).toBeLessThan(1e-3);
        palm.updateWorldMatrix(true, false);
        palmMatrix.elements.forEach((value, index) => expect(palm.matrixWorld.elements[index]).toBeCloseTo(value, 5));
        expectSameBoneTransforms(worldBoneMatrices(hand, side, fingerSuffixes), fingerTransforms);
        expect(hand.sampleLiveDiagnostics().fixedDistalSkinSampleRows).toHaveLength(15);
      } finally {
        hand.dispose();
      }
    });

    it(`${side}: fades an ambiguous antiparallel swing before Three.js fallback and keeps ordinary poses unchanged`, async () => {
      const hand = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      const baseline = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      const sourceRig = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
      const baselineInternals = baseline as unknown as {
        alignForearmAxisToMotionPose: (pose: unknown, liveAlpha: number) => void;
      };
      baselineInternals.alignForearmAxisToMotionPose = () => {};
      try {
        const pose = reconstructHand3D(motionPose(side));
        const preset = startingPose();
        const baselineStart = sourceRig.retargetPoseToHand(preset, baseline, side === "left");
        const candidateStart = sourceRig.retargetPoseToHand(preset, hand, side === "left");
        // r = 1 + dot(currentAxis, targetAxis); values around +/-0.00015 rad
        // straddle Three.js's 1e-8 branch for setFromUnitVectors.
        const antipodeOffsetsRadians = [
          -1e-3, -2e-4, -1.5e-4, -1.4e-4, -1e-4, -1e-6,
          0,
          1e-6, 1e-4, 1.4e-4, 1.5e-4, 2e-4, 1e-3,
        ];

        for (const strength of [0.5, 1]) {
          const baselineBlend = strength < 1 ? { pose: baselineStart, liveAlpha: strength } : undefined;
          const candidateBlend = strength < 1 ? { pose: candidateStart, liveAlpha: strength } : undefined;
          baseline.update(pose, baselineBlend);
          const currentAxis = worldAxis(baseline, side);
          const referenceAxis = Math.abs(currentAxis.x) < 0.8
            ? new THREE.Vector3(1, 0, 0)
            : new THREE.Vector3(0, 0, 1);
          const perpendicular = new THREE.Vector3().crossVectors(currentAxis, referenceAxis).normalize();
          const rows: Array<{
            offset: number;
            r: number;
            belowFallback: boolean;
            target: THREE.Vector3;
            group: THREE.Quaternion;
            forearm: THREE.Vector3;
          }> = [];

          for (const offset of antipodeOffsetsRadians) {
            const theta = Math.PI - offset;
            const target = currentAxis.clone().multiplyScalar(Math.cos(theta))
              .addScaledVector(perpendicular, Math.sin(theta))
              .normalize();
            const syntheticPose = {
              ...pose,
              armEnd: pose.wristCenter.clone().sub(target),
            };
            baseline.update(syntheticPose, baselineBlend);
            hand.update(syntheticPose, candidateBlend);
            const baselineCurrent = worldAxis(baseline, side);
            const r = 1 + baselineCurrent.dot(targetAxis(syntheticPose));
            const candidatePose = hand.exportPose();
            const row = {
              offset,
              r,
              belowFallback: r < 1e-8,
              target,
              group: new THREE.Quaternion(...candidatePose.group.quaternion),
              forearm: worldAxis(hand, side),
            };
            rows.push(row);
            if (row.belowFallback) {
              // The damping reaches exactly zero before Three's arbitrary-axis
              // branch, so the result matches the no-correction baseline.
              expectPoseSame(candidatePose, baseline.exportPose());
            }
          }

          const aboveThreshold = rows.find((row) => row.offset === 1.5e-4)!;
          const belowThreshold = rows.find((row) => row.offset === 1.4e-4)!;
          expect(aboveThreshold.r).toBeGreaterThan(1e-8);
          expect(aboveThreshold.belowFallback).toBe(false);
          expect(belowThreshold.r).toBeLessThan(1e-8);
          expect(belowThreshold.belowFallback).toBe(true);

          const groupSteps: number[] = [];
          const forearmSteps: number[] = [];
          const thresholdCrossingSteps: Array<{ group: number; forearm: number }> = [];
          for (let index = 1; index < rows.length; index += 1) {
            const before = rows[index - 1]!;
            const current = rows[index]!;
            const group = THREE.MathUtils.radToDeg(before.group.angleTo(current.group));
            const forearm = THREE.MathUtils.radToDeg(before.forearm.angleTo(current.forearm));
            groupSteps.push(group);
            forearmSteps.push(forearm);
            if (before.belowFallback !== current.belowFallback) thresholdCrossingSteps.push({ group, forearm });
          }
          expect(Math.max(...groupSteps)).toBeLessThan(1.5);
          expect(Math.max(...forearmSteps)).toBeLessThan(1.5);
          expect(thresholdCrossingSteps).toHaveLength(2);
          for (const step of thresholdCrossingSteps) {
            expect(step.group).toBeLessThan(0.01);
            expect(step.forearm).toBeLessThan(0.01);
          }
          // This finite sweep checks these sampled steps only; it does not
          // establish temporal safety for arbitrary trajectories in the cone.
        }

        // Away from the antiparallel numerical ramp the original slerp strength
        // is unchanged: the measured correction fraction remains exactly 0.5/1.
        for (const strength of [0.5, 1]) {
          const baselineBlend = strength < 1 ? { pose: baselineStart, liveAlpha: strength } : undefined;
          const candidateBlend = strength < 1 ? { pose: candidateStart, liveAlpha: strength } : undefined;
          baseline.update(pose, baselineBlend);
          const baselineError = worldAxis(baseline, side).angleTo(targetAxis(pose));
          hand.update(pose, candidateBlend);
          const candidateError = worldAxis(hand, side).angleTo(targetAxis(pose));
          expect(baselineError).toBeGreaterThan(THREE.MathUtils.degToRad(0.25));
          expect(candidateError).toBeCloseTo(baselineError * (1 - strength), 5);
        }

        // Zero-length source direction stays at the uncorrected baseline, and
        // returning to an ordinary pose after a distant seek does not accumulate.
        const zeroTarget = { ...pose, armEnd: pose.wristCenter.clone() };
        baseline.update(zeroTarget);
        hand.update(zeroTarget);
        expectPoseSame(hand.exportPose(), baseline.exportPose());
        hand.update(pose);
        const expectedAfterSeek = hand.exportPose();
        const otherPose = { ...pose, armEnd: pose.armEnd.clone().add(new THREE.Vector3(2, -1, 0.5)) };
        hand.update(otherPose);
        hand.update(pose);
        expectPoseSame(hand.exportPose(), expectedAfterSeek);
      } finally {
        hand.dispose();
        baseline.dispose();
        sourceRig.dispose();
      }
    });

    it(`${side}: is continuous at the outer damping edge for two azimuths and restores full strength beyond it`, async () => {
      const hand = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      const baseline = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      const sourceRig = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
      const baselineInternals = baseline as unknown as {
        alignForearmAxisToMotionPose: (pose: unknown, liveAlpha: number) => void;
      };
      baselineInternals.alignForearmAxisToMotionPose = () => {};
      try {
        const pose = reconstructHand3D(motionPose(side));
        const preset = startingPose();
        const baselineStart = sourceRig.retargetPoseToHand(preset, baseline, side === "left");
        const candidateStart = sourceRig.retargetPoseToHand(preset, hand, side === "left");
        const rampEdge = 1e-5;
        const epsilon = 1e-8;
        const rSamples = [rampEdge - epsilon, rampEdge, rampEdge + epsilon];

        for (const strength of [0.5, 1]) {
          const baselineBlend = strength < 1 ? { pose: baselineStart, liveAlpha: strength } : undefined;
          const candidateBlend = strength < 1 ? { pose: candidateStart, liveAlpha: strength } : undefined;
          baseline.update(pose, baselineBlend);
          const currentAxis = worldAxis(baseline, side);
          const referenceAxis = Math.abs(currentAxis.x) < 0.8
            ? new THREE.Vector3(1, 0, 0)
            : new THREE.Vector3(0, 0, 1);
          const azimuthOne = new THREE.Vector3().crossVectors(currentAxis, referenceAxis).normalize();
          const azimuthTwo = new THREE.Vector3().crossVectors(currentAxis, azimuthOne).normalize();

          for (const azimuth of [azimuthOne, azimuthTwo]) {
            const rows: Array<{
              requestedR: number;
              actualR: number;
              group: THREE.Quaternion;
              forearm: THREE.Vector3;
              expectedFullStrengthGroup: THREE.Quaternion;
              target: THREE.Vector3;
            }> = [];
            for (const requestedR of rSamples) {
              // For r=1+dot, use dot=r-1 and sin(theta)=sqrt(2r-r^2).
              // The tangent vector selects an azimuth around the same antipode.
              const target = currentAxis.clone().multiplyScalar(requestedR - 1)
                .addScaledVector(azimuth, Math.sqrt(2 * requestedR - requestedR * requestedR))
                .normalize();
              const syntheticPose = {
                ...pose,
                armEnd: pose.wristCenter.clone().sub(target),
              };
              baseline.update(syntheticPose, baselineBlend);
              const baselineCurrent = worldAxis(baseline, side);
              const actualTarget = targetAxis(syntheticPose);
              const actualR = 1 + baselineCurrent.dot(actualTarget);

              // Reference the former implementation directly: outside the
              // ramp it slerps by the unmodified lead-in strength.
              const fullSwing = new THREE.Quaternion().setFromUnitVectors(baselineCurrent, actualTarget).normalize();
              const expectedSwing = new THREE.Quaternion().identity().slerp(fullSwing, strength).normalize();
              const expectedFullStrengthGroup = baseline.group.quaternion.clone()
                .premultiply(expectedSwing)
                .normalize();

              hand.update(syntheticPose, candidateBlend);
              rows.push({
                requestedR,
                actualR,
                group: new THREE.Quaternion(...hand.exportPose().group.quaternion),
                forearm: worldAxis(hand, side),
                expectedFullStrengthGroup,
                target: actualTarget,
              });
            }

            const below = rows[0]!;
            const at = rows[1]!;
            const above = rows[2]!;
            expect(below.actualR).toBeLessThan(rampEdge);
            expect(above.actualR).toBeGreaterThan(rampEdge);

            // The small r step produces a small output step on each side of
            // the edge, including with a different azimuth around the axis.
            for (const [before, after] of [[below, at], [at, above]] as const) {
              expect(THREE.MathUtils.radToDeg(before.group.angleTo(after.group))).toBeLessThan(0.01);
              expect(THREE.MathUtils.radToDeg(before.forearm.angleTo(after.forearm))).toBeLessThan(0.01);
            }

            // At and above the edge the smoothstep is exactly one; compare the
            // resulting group orientation with the pre-damping slerp result.
            expect(THREE.MathUtils.radToDeg(at.group.angleTo(at.expectedFullStrengthGroup))).toBeLessThan(1e-4);
            expect(THREE.MathUtils.radToDeg(above.group.angleTo(above.expectedFullStrengthGroup))).toBeLessThan(1e-4);
          }
        }
      } finally {
        hand.dispose();
        baseline.dispose();
        sourceRig.dispose();
      }
    });

    it(`${side}: preserves the stationary lead-in endpoint and follows the smoothstep alpha`, async () => {
      const hand = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      const sourceRig = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
      try {
        const pose = reconstructHand3D(motionPose(side));
        const preset = sourceRig.retargetPoseToHand(startingPose(), hand, side === "left");
        const baseline = { ...pose, armEnd: pose.wristCenter.clone() };

        hand.update(baseline, { pose: preset, liveAlpha: 0 });
        const noCorrectionAtStart = hand.exportPose();
        const startFingerBones = preset.bones.filter((bone) => !bone.name.endsWith("_forearm") && !bone.name.endsWith("_palm"));
        hand.update(pose, { pose: preset, liveAlpha: 0 });
        const correctedAtStart = hand.exportPose();
        expectPoseSame(correctedAtStart, noCorrectionAtStart);
        for (const startBone of startFingerBones) {
          const actual = correctedAtStart.bones.find((bone) => bone.name === startBone.name)!;
          expect(actual.position).toEqual(startBone.position);
          expect(new THREE.Quaternion(...actual.quaternion).angleTo(new THREE.Quaternion(...startBone.quaternion))).toBeLessThan(1e-7);
        }

        const alphaAtStart = riggedHandStartPoseLiveAlpha(-2, 2);
        const alphaJustAfterStart = riggedHandStartPoseLiveAlpha(-2 + 1e-3, 2);
        const alphaAtMidpoint = riggedHandStartPoseLiveAlpha(-1, 2);
        const alphaJustBeforeLive = riggedHandStartPoseLiveAlpha(-1e-3, 2);
        expect(alphaAtStart).toBe(0);
        expect(alphaJustAfterStart).toBeGreaterThan(0);
        expect(alphaJustAfterStart).toBeLessThan(1e-6);
        expect(alphaAtMidpoint).toBe(0.5);
        expect(alphaJustBeforeLive).toBeGreaterThan(0.999999);

        hand.update(baseline, { pose: preset, liveAlpha: 0 });
        const startGroupQuaternion = new THREE.Quaternion(...hand.exportPose().group.quaternion);
        hand.update(pose, { pose: preset, liveAlpha: alphaJustAfterStart });
        const justAfterStartQuaternion = new THREE.Quaternion(...hand.exportPose().group.quaternion);
        expect(justAfterStartQuaternion.angleTo(startGroupQuaternion)).toBeLessThan(1e-4);

        hand.update(pose);
        const full = new THREE.Quaternion(...hand.exportPose().group.quaternion);
        hand.update(pose, { pose: preset, liveAlpha: alphaJustBeforeLive });
        const justBefore = new THREE.Quaternion(...hand.exportPose().group.quaternion);
        expect(justBefore.angleTo(full)).toBeLessThan(1e-5);
        hand.update(pose, { pose: preset, liveAlpha: alphaAtMidpoint });
        const halfway = new THREE.Quaternion(...hand.exportPose().group.quaternion);
        hand.update(baseline, { pose: preset, liveAlpha: alphaAtMidpoint });
        const halfwayWithoutAxisCorrection = new THREE.Quaternion(...hand.exportPose().group.quaternion);
        const halfwayBaselineError = worldAxis(hand, side).angleTo(targetAxis(pose));
        expect(halfway.angleTo(halfwayWithoutAxisCorrection)).toBeCloseTo(halfwayBaselineError * 0.5, 4);
      } finally {
        hand.dispose();
        sourceRig.dispose();
      }
    });

    it(`${side}: malformed or zero target axes fall back, and seeking does not accumulate correction`, async () => {
      const hand = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      const clean = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      try {
        const poseA = reconstructHand3D(motionPose(side));
        const zeroTarget = { ...poseA, armEnd: poseA.wristCenter.clone() };
        const malformedTarget = { ...poseA, armEnd: new THREE.Vector3(Number.NaN, poseA.armEnd.y, poseA.armEnd.z) };
        hand.update(zeroTarget);
        const zeroPose = hand.exportPose();
        hand.update(malformedTarget);
        expectPoseSame(hand.exportPose(), zeroPose);

        hand.update(poseA);
        const expectedA = hand.exportPose();
        const expectedDiagnosticsA = hand.sampleLiveDiagnostics();
        const poseB = { ...poseA, armEnd: poseA.armEnd.clone().add(new THREE.Vector3(2, -1, 0.5)) };
        hand.update(poseB);
        hand.update(poseA);
        expectPoseSame(hand.exportPose(), expectedA);
        expect(hand.sampleLiveDiagnostics()).toEqual(expectedDiagnosticsA);
        clean.update(poseA);
        expectPoseSame(hand.exportPose(), clean.exportPose());
        expect(hand.sampleLiveDiagnostics()).toEqual(clean.sampleLiveDiagnostics());
        hand.update(poseA);
        expectPoseSame(hand.exportPose(), expectedA);
        expect(hand.sampleLiveDiagnostics()).toEqual(expectedDiagnosticsA);

        hand.setPoseEditMode(true);
        const frozen = hand.exportPose();
        hand.update(poseB);
        expectPoseSame(hand.exportPose(), frozen);
        hand.restoreAnimatedPose();
        hand.update(poseA);
        expectPoseSame(hand.exportPose(), expectedA);
      } finally {
        hand.dispose();
        clean.dispose();
      }
    });

    it(`${side}: refreshes ancestors and leaves transformed-parent frames unchanged by the world-axis correction`, async () => {
      const hand = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      const ancestor = new THREE.Group();
      ancestor.add(hand.group);
      try {
        const pose = reconstructHand3D(motionPose(side));
        hand.update({ ...pose, armEnd: pose.wristCenter.clone() });
        const beforeParentChange = bonesFor(hand).get(`${side}_palm`)!.getWorldPosition(new THREE.Vector3());

        // Change the ancestor after the previous world-matrix update; update()
        // refreshes it first. The existing world-coordinate placement contract
        // does not support transformed parents, so axis correction must be inert.
        ancestor.position.set(3.5, -1.25, 4.75);
        ancestor.quaternion.setFromEuler(new THREE.Euler(0.31, -0.47, 0.22));
        ancestor.scale.setScalar(1.7);
        const noCorrection = { ...pose, armEnd: pose.wristCenter.clone() };
        hand.update(noCorrection);
        const bones = bonesFor(hand);
        const palm = bones.get(`${side}_palm`)!;
        const baselinePose = hand.exportPose();
        const baselineMatrix = palm.matrixWorld.clone();
        const baselinePosition = palm.getWorldPosition(new THREE.Vector3());
        const baselineQuaternion = palm.getWorldQuaternion(new THREE.Quaternion());
        const baselineAxis = worldAxis(hand, side);
        expect(baselinePosition.distanceTo(beforeParentChange)).toBeGreaterThan(0.1);

        hand.update(pose);
        expectPoseSame(hand.exportPose(), baselinePose);
        const afterMatrix = palm.matrixWorld;
        expect(palm.getWorldPosition(new THREE.Vector3()).distanceTo(baselinePosition)).toBeLessThan(1e-6);
        expect(palm.getWorldQuaternion(new THREE.Quaternion()).angleTo(baselineQuaternion)).toBeLessThan(1e-3);
        baselineMatrix.elements.forEach((value, index) => expect(afterMatrix.elements[index]).toBeCloseTo(value, 7));
        expect(worldAxis(hand, side).angleTo(baselineAxis)).toBeLessThan(1e-8);
      } finally {
        hand.dispose();
        ancestor.removeFromParent();
      }
    });

    it(`${side}: disables axis correction under a nonuniformly scaled ancestor`, async () => {
      const hand = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      const ancestor = new THREE.Group();
      ancestor.add(hand.group);
      try {
        ancestor.quaternion.setFromEuler(new THREE.Euler(-0.2, 0.4, 0.1));
        ancestor.scale.set(1, 1.5, 1);
        const pose = reconstructHand3D(motionPose(side));
        hand.update({ ...pose, armEnd: pose.wristCenter.clone() });
        const before = hand.exportPose();
        const beforeMatrix = bonesFor(hand).get(`${side}_palm`)!.matrixWorld.clone();
        hand.update(pose);
        expectPoseSame(hand.exportPose(), before);
        const afterMatrix = bonesFor(hand).get(`${side}_palm`)!.matrixWorld;
        beforeMatrix.elements.forEach((value, index) => expect(afterMatrix.elements[index]).toBeCloseTo(value, 7));
      } finally {
        hand.dispose();
        ancestor.removeFromParent();
      }
    });
  }
});
