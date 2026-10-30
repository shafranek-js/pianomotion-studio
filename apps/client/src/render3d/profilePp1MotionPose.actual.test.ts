// @ts-expect-error Vitest uses Node fs to read checked-in MIDI and real GLB assets; browser tsconfig excludes Node types.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { MotionPose } from "@handthesia/contracts";
import { analyze_midi, _engine_version } from "@handthesia/engine-ts";
import { DEFAULT_PROFILE } from "../profiles/defaultProfiles";
import { BONE_SCALE_MAX, BONE_SCALE_MIN } from "../profiles/types";
import { DEFAULT_SKIN_SETTINGS } from "../render/skins";
import {
  Hand3DMeshGroup,
  type HandModelRuntimeDependencies,
} from "./handRigBuilder";
import {
  type ImprovedHandAsset,
  type ImprovedHandTextureLease,
  validateImprovedHandManifest,
} from "./improvedHandAssets";

const midiUrl = new URL("../../../../tests/fixtures/midi/tracked-right-hand.mid", import.meta.url);
const manifestUrl = new URL("../../public/models/hands/improved/manifest.json", import.meta.url);

function analyzeWithProfile(profile: typeof DEFAULT_PROFILE) {
  const midiBytes = new Uint8Array(readFileSync(midiUrl));
  return analyze_midi(midiBytes, {
    fixtureId: "tracked-right-hand",
    projectId: "profile-pp1-motion-pose-test",
    revision: profile.revision,
    requestId: `profile-pp1/${profile.revision}`,
    engineVersion: _engine_version(),
    keyStyle: "realistic",
    sampleTimes: [0],
    profile,
  });
}

function rightPose(result: ReturnType<typeof analyzeWithProfile>): MotionPose {
  const pose = result.motionPlan?.poses.find(
    (item: MotionPose) => item.hand === "right" && item.transportTimeSeconds === 0,
  );
  if (!pose) throw new Error("The real tracked-right-hand MIDI did not produce a right-hand pose at t=0.");
  return pose;
}

function maxMotionPoseCoordinateDelta(left: MotionPose, right: MotionPose): number {
  expect(right.bones).toHaveLength(left.bones.length);
  expect(right.joints).toHaveLength(left.joints.length);
  let maxDelta = 0;
  for (let index = 0; index < left.bones.length; index += 1) {
    const leftBone = left.bones[index]!;
    const rightBone = right.bones[index]!;
    expect(rightBone.kind).toBe(leftBone.kind);
    for (const axis of [0, 1, 2] as const) {
      maxDelta = Math.max(
        maxDelta,
        Math.abs(leftBone.a[axis] - rightBone.a[axis]),
        Math.abs(leftBone.b[axis] - rightBone.b[axis]),
      );
    }
  }
  for (let index = 0; index < left.joints.length; index += 1) {
    const leftJoint = left.joints[index]!;
    const rightJoint = right.joints[index]!;
    expect(rightJoint.kind).toBe(leftJoint.kind);
    for (const axis of [0, 1, 2] as const) {
      maxDelta = Math.max(maxDelta, Math.abs(leftJoint.point[axis] - rightJoint.point[axis]));
    }
  }
  return maxDelta;
}

function thumbProximalMotionLength(pose: MotionPose): number {
  // Engine order is shared with reconstructHand3D: thumb is the final finger,
  // with metacarpal/proximal/distal segments at indices 25/26/27.
  const proximal = pose.bones[26];
  if (!proximal || proximal.kind !== "proximal") {
    throw new Error("Expected the engine-ordered MotionPose thumb proximal segment at index 26.");
  }
  return Math.hypot(
    proximal.b[0] - proximal.a[0],
    proximal.b[1] - proximal.a[1],
    proximal.b[2] - proximal.a[2],
  );
}

function captureThumbWorldMatrices(model: Hand3DMeshGroup): Map<string, number[]> {
  model.group.updateMatrixWorld(true);
  const names = [
    "thumb-metacarpal",
    "thumb-phalanx-proximal",
    "thumb-phalanx-distal",
    "thumb-tip",
  ];
  return new Map(names.map((name) => {
    const bone = model.getBone(name);
    if (!bone) throw new Error(`The loaded Testing GLB is missing ${name}.`);
    return [name, bone.matrixWorld.toArray()];
  }));
}

function maxMatrixDelta(left: number[], right: number[]): number {
  return Math.max(...left.map((value, index) => Math.abs(value - right[index]!)));
}

describe("Pianist profile anatomy.pp1 drives MotionPose and the real Testing GLB rig", () => {
  it("changes the engine pose and final thumb bone transforms when pp1 changes", async () => {
    const baseProfile = structuredClone(DEFAULT_PROFILE);
    const changedProfile = structuredClone(DEFAULT_PROFILE);
    changedProfile.profileId = "profile-pp1-expanded-test";
    changedProfile.name = "PP1 expanded test";
    changedProfile.revision = 1;
    changedProfile.anatomy.pp1 = 4.3;
    const maxProfile = structuredClone(DEFAULT_PROFILE);
    maxProfile.profileId = "profile-pp1-maximum-test";
    maxProfile.name = "PP1 maximum test";
    maxProfile.revision = 2;
    maxProfile.anatomy.pp1 = DEFAULT_PROFILE.anatomy.pp1 * BONE_SCALE_MAX;
    const minProfile = structuredClone(DEFAULT_PROFILE);
    minProfile.profileId = "profile-pp1-minimum-test";
    minProfile.name = "PP1 minimum test";
    minProfile.revision = 3;
    minProfile.anatomy.pp1 = DEFAULT_PROFILE.anatomy.pp1 * BONE_SCALE_MIN;

    const baseResult = analyzeWithProfile(baseProfile);
    const changedResult = analyzeWithProfile(changedProfile);
    const maxResult = analyzeWithProfile(maxProfile);
    const minResult = analyzeWithProfile(minProfile);
    expect(baseResult.status).toBe("loaded");
    expect(changedResult.status).toBe("loaded");
    expect(maxResult.status).toBe("loaded");
    expect(minResult.status).toBe("loaded");
    expect(baseResult.profile.anatomy.pp1).toBe(3.3);
    expect(changedResult.profile.anatomy.pp1).toBe(4.3);
    expect(maxResult.profile.anatomy.pp1).toBe(DEFAULT_PROFILE.anatomy.pp1 * BONE_SCALE_MAX);
    expect(minResult.profile.anatomy.pp1).toBe(DEFAULT_PROFILE.anatomy.pp1 * BONE_SCALE_MIN);

    const basePose = rightPose(baseResult);
    const changedPose = rightPose(changedResult);
    const maxPose = rightPose(maxResult);
    const minPose = rightPose(minResult);
    const motionPoseDelta = maxMotionPoseCoordinateDelta(basePose, changedPose);
    expect(motionPoseDelta).toBeGreaterThan(1e-4);
    const thumbProximalLengths = [
      thumbProximalMotionLength(minPose),
      thumbProximalMotionLength(basePose),
      thumbProximalMotionLength(changedPose),
      thumbProximalMotionLength(maxPose),
    ];
    expect(thumbProximalLengths[0]!).toBeLessThan(thumbProximalLengths[1]!);
    expect(thumbProximalLengths[2]!).toBeGreaterThan(thumbProximalLengths[1]!);
    expect(thumbProximalLengths[3]!).toBeGreaterThan(thumbProximalLengths[1]!);

    const manifest = validateImprovedHandManifest(JSON.parse(readFileSync(manifestUrl, "utf8")) as unknown);
    const directory = new URL(".", manifestUrl);
    const textureLease: ImprovedHandTextureLease = {
      baseColor: new THREE.Texture(),
      normal: new THREE.Texture(),
      roughness: new THREE.Texture(),
      release: () => undefined,
    };
    const dependencies: HandModelRuntimeDependencies = {
      assetLoader: {
        load: async (hand, level) => {
          const lod = manifest.hands[hand].lods[level]!;
          const bytes = readFileSync(new URL(lod.url, directory));
          return {
            manifest,
            manifestUrl,
            hand,
            lod,
            buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
            textureSet: manifest.textures[lod.textureSet],
          } satisfies ImprovedHandAsset;
        },
        getCacheStats: () => ({ count: 1, retainedGlbBytes: 0 }),
      },
      textureCache: {
        acquire: async () => textureLease,
        getCacheStats: () => ({ count: 3, estimatedBaseBytes: 0 }),
      },
    };
    const model = new Hand3DMeshGroup("right", "webxr", dependencies);
    try {
      model.setHandModel("testing", 2);
      await model.waitForHandModelReady();
      expect(model.getHandModelDiagnostics()).toMatchObject({
        requestedModel: "testing",
        loadedModel: "testing",
        loadedLod: 2,
        state: "ready",
      });
      model.setTestingKeyContact(false);

      model.updateFromPose(basePose, DEFAULT_SKIN_SETTINGS, false, 0);
      const baseThumbBones = captureThumbWorldMatrices(model);
      const proximalBone = model.getBone("thumb-phalanx-proximal");
      if (!proximalBone) throw new Error("The loaded Testing GLB is missing thumb-phalanx-proximal.");
      const baseProximalScaleZ = proximalBone.scale.z;
      model.updateFromPose(changedPose, DEFAULT_SKIN_SETTINGS, false, 0);
      const changedThumbBones = captureThumbWorldMatrices(model);
      const changedProximalScaleZ = proximalBone.scale.z;
      model.updateFromPose(maxPose, DEFAULT_SKIN_SETTINGS, false, 0);
      const maxThumbBones = captureThumbWorldMatrices(model);
      const maxProximalScaleZ = proximalBone.scale.z;
      model.updateFromPose(minPose, DEFAULT_SKIN_SETTINGS, false, 0);
      const minThumbBones = captureThumbWorldMatrices(model);
      const minProximalScaleZ = proximalBone.scale.z;
      const thumbBoneDeltas = [...baseThumbBones].map(([name, matrix]) => ({
        name,
        maxMatrixDelta: maxMatrixDelta(matrix, changedThumbBones.get(name)!),
      }));
      const maxThumbBoneDeltas = [...baseThumbBones].map(([name, matrix]) => ({
        name,
        maxMatrixDelta: maxMatrixDelta(matrix, maxThumbBones.get(name)!),
      }));
      const minThumbBoneDeltas = [...baseThumbBones].map(([name, matrix]) => ({
        name,
        maxMatrixDelta: maxMatrixDelta(matrix, minThumbBones.get(name)!),
      }));

      console.info("[profile pp1 -> MotionPose -> Testing GLB]", JSON.stringify({
        pp1: [minProfile.anatomy.pp1, baseProfile.anatomy.pp1, changedProfile.anatomy.pp1, maxProfile.anatomy.pp1],
        motionPoseMaxCoordinateDelta: motionPoseDelta,
        maxProfileMotionPoseMaxCoordinateDelta: maxMotionPoseCoordinateDelta(basePose, maxPose),
        minProfileMotionPoseMaxCoordinateDelta: maxMotionPoseCoordinateDelta(basePose, minPose),
        thumbProximalMotionLengths: thumbProximalLengths,
        thumbProximalScaleZ: [minProximalScaleZ, baseProximalScaleZ, changedProximalScaleZ, maxProximalScaleZ],
        thumbBoneMaxMatrixDeltas: thumbBoneDeltas,
        minProfileThumbBoneMaxMatrixDeltas: minThumbBoneDeltas,
        maxProfileThumbBoneMaxMatrixDeltas: maxThumbBoneDeltas,
      }));
      expect(minProximalScaleZ).toBeGreaterThanOrEqual(0.55);
      expect(minProximalScaleZ).toBeLessThanOrEqual(1.55);
      expect(baseProximalScaleZ).toBeGreaterThanOrEqual(0.55);
      expect(baseProximalScaleZ).toBeLessThanOrEqual(1.55);
      expect(changedProximalScaleZ).toBeGreaterThanOrEqual(0.55);
      expect(changedProximalScaleZ).toBeLessThanOrEqual(1.55);
      expect(maxProximalScaleZ).toBeGreaterThanOrEqual(0.55);
      expect(maxProximalScaleZ).toBeLessThanOrEqual(1.55);
      expect(thumbBoneDeltas.some(({ maxMatrixDelta: delta }) => delta > 1e-5)).toBe(true);
      expect(minThumbBoneDeltas.some(({ maxMatrixDelta: delta }) => delta > 1e-5)).toBe(true);
      expect(maxThumbBoneDeltas.some(({ maxMatrixDelta: delta }) => delta > 1e-5)).toBe(true);
      expect(maxProximalScaleZ).toBeCloseTo(1.55, 5);
    } finally {
      model.dispose();
      textureLease.baseColor.dispose();
      textureLease.normal.dispose();
      textureLease.roughness.dispose();
    }
  });
});
