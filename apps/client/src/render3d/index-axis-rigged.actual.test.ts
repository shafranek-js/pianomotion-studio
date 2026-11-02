// @ts-expect-error This actual-asset test reads the checked-in MIDI/GLB files with Node fs.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { FingeringAssignment, MotionPose, PerformanceEvent, PianistProfile } from "@handthesia/contracts";
import { analyze_midi, _engine_version } from "@handthesia/engine-ts";
import { DEFAULT_PROFILE } from "../profiles/defaultProfiles";
import { RIGGED_HAND_PROFILE_PROVENANCE } from "../profiles/riggedHandProfile";
import { reconstructHand3D, type ReconstructedHand3D } from "./handRigBuilder";
import { RiggedExperimentalHand } from "./riggedExperimentalHand";

const SAMPLE_TIMES = [0, 0.15, 1.95, 5.55, 12.3, 24, 43.5, 53.1, 72, 87, 96.88, 97.2, 97.35, 97.48, 97.5] as const;
const LOCAL_X = new THREE.Vector3(1, 0, 0);
type Side = "left" | "right";
type IndexJoint = "proximal" | "intermediate" | "distal";
const FIXED_INDEX_AXES: Readonly<Record<Side, Readonly<Record<IndexJoint, THREE.Vector3>>>> = Object.freeze({
  left: Object.freeze({
    proximal: new THREE.Vector3(0.9155928434597187, -0.1948982392134811, 0.35171639335810295).normalize(),
    intermediate: new THREE.Vector3(0.9276011833672116, -0.0805432785661098, 0.3647859987630701).normalize(),
    distal: new THREE.Vector3(0.9096274932824899, -0.11587193885410042, 0.3989379867232567).normalize(),
  }),
  right: Object.freeze({
    proximal: new THREE.Vector3(0.915583559, 0.194897975, -0.351740709).normalize(),
    intermediate: new THREE.Vector3(0.927360697, 0.003857827, -0.374148706).normalize(),
    distal: new THREE.Vector3(0.913011081, 0.038516274, -0.406112377).normalize(),
  }),
});
const MAX_MCP_SIDE_ANGLE = THREE.MathUtils.degToRad(15);
type Hand = Awaited<ReturnType<typeof RiggedExperimentalHand.fromBuffer>>;
type BoneMap = Map<string, THREE.Bone>;
type QuaternionMap = Map<string, THREE.Quaternion>;
type PoseSet = { poses: Map<string, MotionPose>; activeIndexSamples: Set<string>; activeThumbSamples: Set<string> };
type ThumbSurfaceStats = { sampleCount: number; medianY: number; medianDistanceToTargetTip: number };

function bufferFor(side: Side): ArrayBuffer {
  const bytes = readFileSync(new URL(`../../public/models/hands/rigged-experimental/${side}.glb`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function bonesFor(hand: Hand): { bones: BoneMap; mesh: THREE.SkinnedMesh } {
  const bones = new Map<string, THREE.Bone>();
  const meshes: THREE.SkinnedMesh[] = [];
  hand.group.traverse((node) => {
    if (node instanceof THREE.Bone) bones.set(node.name, node);
    if (node instanceof THREE.SkinnedMesh) meshes.push(node);
  });
  if (meshes.length !== 1) throw new Error(`Expected one real GLB skin, found ${meshes.length}.`);
  return { bones, mesh: meshes[0]! };
}

function capturedLocalRotations(bones: BoneMap): QuaternionMap {
  return new Map([...bones].map(([name, bone]) => [name, bone.quaternion.clone()]));
}

function quaternionComponentDrift(left: THREE.Quaternion, right: THREE.Quaternion): number {
  const sameSign = Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y), Math.abs(left.z - right.z), Math.abs(left.w - right.w));
  const oppositeSign = Math.max(Math.abs(left.x + right.x), Math.abs(left.y + right.y), Math.abs(left.z + right.z), Math.abs(left.w + right.w));
  return Math.min(sameSign, oppositeSign);
}

function requireBone(bones: BoneMap, name: string): THREE.Bone {
  const bone = bones.get(name);
  if (!bone) throw new Error(`Real rigged GLB is missing ${name}.`);
  return bone;
}

function targetIndexBones(side: Side): Set<string> {
  return new Set((Object.keys(FIXED_INDEX_AXES[side]) as IndexJoint[]).map((joint) => `${side}_index_${joint}`));
}

function isLongFingerMcp(side: Side, name: string): boolean {
  return name.startsWith(`${side}_`) && /_(index|middle|ring|little)_proximal$/.test(name);
}

function flexAngle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, up: THREE.Vector3, capDegrees: number): number {
  const before = b.clone().sub(a);
  const after = c.clone().sub(b);
  if (before.lengthSq() < 1e-10 || after.lengthSq() < 1e-10) return 0;
  before.normalize();
  after.normalize();
  const lateral = new THREE.Vector3().crossVectors(before, up).normalize();
  if (lateral.lengthSq() < 1e-10) return 0;
  const bend = Math.atan2(-new THREE.Vector3().crossVectors(before, after).dot(lateral), before.dot(after));
  return -THREE.MathUtils.clamp(bend, 0, THREE.MathUtils.degToRad(capDegrees));
}

/** Reconstructs the pre-change local +X rotations as a control reference. */
function expectedLegacyRotations(side: Side, pose: ReconstructedHand3D, bind: QuaternionMap): QuaternionMap {
  const expected = new Map([...bind].map(([name, quaternion]) => [name, quaternion.clone()]));
  const set = (jointName: string, angle: number) => {
    const boneName = `${side}_${jointName}`;
    const bindRotation = bind.get(boneName);
    if (!bindRotation) throw new Error(`Missing captured bind rotation ${boneName}.`);
    expected.set(boneName, bindRotation.clone().multiply(new THREE.Quaternion().setFromAxisAngle(LOCAL_X, angle)));
  };

  for (const { number, name } of [
    { number: 2, name: "index" },
    { number: 3, name: "middle" },
    { number: 4, name: "ring" },
    { number: 5, name: "little" },
  ]) {
    const points = pose.chains[number];
    if (!points || points.length < 5) continue;
    set(`${name}_metacarpal`, 0);
    set(`${name}_proximal`, flexAngle(points[0]!, points[1]!, points[2]!, pose.palmNormal, 45));
    set(`${name}_intermediate`, flexAngle(points[1]!, points[2]!, points[3]!, pose.palmNormal, 70));
    set(`${name}_distal`, flexAngle(points[2]!, points[3]!, points[4]!, pose.palmNormal, 50));
  }

  const thumb = pose.chains[1];
  if (thumb && thumb.length >= 4) {
    set("thumb_segment0_cmc-to-mcp", 0);
    set("thumb_segment1_mcp-to-ip", flexAngle(thumb[0]!, thumb[1]!, thumb[2]!, pose.palmNormal, 35));
    const tipBend = flexAngle(thumb[1]!, thumb[2]!, thumb[3]!, pose.palmNormal, 25);
    set("thumb_distal-segment-a", tipBend * 0.5);
    set("thumb_distal-segment-b", tipBend * 0.5);
  }
  return expected;
}

function expectedCorrectedRotations(side: Side, pose: ReconstructedHand3D, bind: QuaternionMap): QuaternionMap {
  const expected = expectedLegacyRotations(side, pose, bind);
  for (const joint of Object.keys(FIXED_INDEX_AXES[side]) as IndexJoint[]) {
    const cap = joint === "proximal" ? 45 : joint === "intermediate" ? 70 : 50;
    const chainOffset = joint === "proximal" ? 0 : joint === "intermediate" ? 1 : 2;
    const points = pose.chains[2]!;
    const angle = flexAngle(points[chainOffset]!, points[chainOffset + 1]!, points[chainOffset + 2]!, pose.palmNormal, cap);
    const name = `${side}_index_${joint}`;
    expected.set(name, bind.get(name)!.clone().multiply(new THREE.Quaternion().setFromAxisAngle(FIXED_INDEX_AXES[side][joint], angle)));
  }
  return expected;
}

function straightened(pose: ReconstructedHand3D): ReconstructedHand3D {
  const chains: Record<number, THREE.Vector3[]> = {};
  for (const [index, chain] of Object.entries(pose.chains)) {
    if (chain.length < 2) continue;
    // Axis-aligned integer coordinates avoid floating point curvature that
    // would otherwise create tiny nonzero diagnostic flex angles.
    const finger = Number(index);
    chains[finger] = Array.from({ length: chain.length }, (_, segment) => new THREE.Vector3((finger - 3) * 0.5, segment, 0));
  }
  return { ...pose, chains };
}

function linkLengths(bones: BoneMap, side: Side): Map<string, number> {
  const lengths = new Map<string, number>();
  for (const finger of ["index", "middle", "ring", "little"]) {
    const names = ["metacarpal", "proximal", "intermediate", "distal"].map((joint) => `${side}_${finger}_${joint}`);
    for (let index = 1; index < names.length; index += 1) {
      lengths.set(`${finger}:${index - 1}`, requireBone(bones, names[index - 1]!).getWorldPosition(new THREE.Vector3()).distanceTo(requireBone(bones, names[index]!).getWorldPosition(new THREE.Vector3())));
    }
  }
  return lengths;
}

function attributeComponent(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, vertex: number, component: number): number {
  if (component === 0) return attribute.getX(vertex);
  if (component === 1) return attribute.getY(vertex);
  if (component === 2) return attribute.getZ(vertex);
  return attribute.getW(vertex);
}

function dominantBoneIndex(mesh: THREE.SkinnedMesh, vertex: number): number {
  const skinIndex = mesh.geometry.getAttribute("skinIndex");
  const skinWeight = mesh.geometry.getAttribute("skinWeight");
  let dominantWeight = -Infinity;
  let dominantIndex = -1;
  for (let component = 0; component < 4; component += 1) {
    const weight = attributeComponent(skinWeight, vertex, component);
    if (weight > dominantWeight) {
      dominantWeight = weight;
      dominantIndex = attributeComponent(skinIndex, vertex, component);
    }
  }
  return dominantIndex;
}

/** Terminal skin vertices are selected from actual GLB weights, not scratch patches. */
function terminalSkinVertexIds(mesh: THREE.SkinnedMesh, side: Side, finger: "index" | "middle"): number[] {
  const targetName = `${side}_${finger}_distal`;
  const targetBone = mesh.skeleton.bones.findIndex((bone) => bone.name === targetName);
  if (targetBone < 0) throw new Error(`Real GLB is missing terminal bone ${targetName}.`);
  const vertexCount = mesh.geometry.getAttribute("position").count;
  const vertices = Array.from({ length: vertexCount }, (_, vertex) => vertex).filter((vertex) => dominantBoneIndex(mesh, vertex) === targetBone);
  if (vertices.length === 0) throw new Error(`No distal-weighted GLB skin vertices found for ${targetName}.`);
  return vertices;
}

function skinnedWorldVertex(mesh: THREE.SkinnedMesh, vertex: number): THREE.Vector3 {
  const point = new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute("position"), vertex);
  mesh.applyBoneTransform(vertex, point);
  return point.applyMatrix4(mesh.matrixWorld);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const center = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[center]! : (sorted[center - 1]! + sorted[center]!) * 0.5;
}

function thumbSurfaceStats(side: Side, mesh: THREE.SkinnedMesh, targetTip: THREE.Vector3): ThumbSurfaceStats {
  const thumbBoneIndices = new Set(mesh.skeleton.bones
    .map((bone, index) => ({ bone, index }))
    .filter(({ bone }) => bone.name === `${side}_thumb_distal-segment-a` || bone.name === `${side}_thumb_distal-segment-b`)
    .map(({ index }) => index));
  const skinIndex = mesh.geometry.getAttribute("skinIndex");
  const skinWeight = mesh.geometry.getAttribute("skinWeight");
  const samples: THREE.Vector3[] = [];
  for (let vertex = 0; vertex < mesh.geometry.getAttribute("position").count; vertex += 1) {
    let thumbWeight = 0;
    for (let component = 0; component < 4; component += 1) {
      if (thumbBoneIndices.has(attributeComponent(skinIndex, vertex, component))) thumbWeight += attributeComponent(skinWeight, vertex, component);
    }
    if (thumbWeight < 0.35) continue;
    samples.push(skinnedWorldVertex(mesh, vertex));
  }
  if (samples.length === 0) throw new Error(`Real ${side} GLB has no thumb distal surface samples.`);
  return {
    sampleCount: samples.length,
    medianY: median(samples.map((point) => point.y)),
    medianDistanceToTargetTip: median(samples.map((point) => point.distanceTo(targetTip))),
  };
}

function terminalSurfaceGap(mesh: THREE.SkinnedMesh): {
  minimumTerminalVertexGapInches: number;
  medianIndexVertexToMiddleVertexInches: number;
  indexVertices: Map<number, THREE.Vector3>;
  middleVertices: Map<number, THREE.Vector3>;
} {
  const indexIds = terminalSkinVertexIds(mesh, "left", "index");
  const middleIds = terminalSkinVertexIds(mesh, "left", "middle");
  const indexVertices = new Map(indexIds.map((vertex) => [vertex, skinnedWorldVertex(mesh, vertex)]));
  const middleVertices = new Map(middleIds.map((vertex) => [vertex, skinnedWorldVertex(mesh, vertex)]));
  let minimumGapSq = Infinity;
  const distances = [...indexVertices.values()].map((point) => {
    let nearestSq = Infinity;
    for (const middlePoint of middleVertices.values()) {
      const distanceSq = point.distanceToSquared(middlePoint);
      nearestSq = Math.min(nearestSq, distanceSq);
      minimumGapSq = Math.min(minimumGapSq, distanceSq);
    }
    return Math.sqrt(nearestSq);
  });
  return {
    minimumTerminalVertexGapInches: Math.sqrt(minimumGapSq),
    medianIndexVertexToMiddleVertexInches: median(distances),
    indexVertices,
    middleVertices,
  };
}

function indexDirectionError(side: Side, bones: BoneMap, mesh: THREE.SkinnedMesh, pose: ReconstructedHand3D, terminalVertexIds: number[]): number {
  const actual = ["metacarpal", "proximal", "intermediate", "distal"].map((joint) => requireBone(bones, `${side}_index_${joint}`).getWorldPosition(new THREE.Vector3()));
  const tip = terminalVertexIds.map((vertex) => skinnedWorldVertex(mesh, vertex)).reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / terminalVertexIds.length);
  actual.push(tip);
  const target = pose.chains[2]!;
  const errors = actual.slice(1).map((point, segment) => {
    const actualDirection = point.clone().sub(actual[segment]!);
    const targetDirection = target[segment + 1]!.clone().sub(target[segment]!);
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(actualDirection.normalize().dot(targetDirection.normalize()), -1, 1)));
  });
  return errors.reduce((sum, value) => sum + value, 0) / errors.length;
}

function worldMatrices(hand: Hand, mesh: THREE.SkinnedMesh): Map<string, number[]> {
  hand.group.updateMatrixWorld(true);
  mesh.skeleton.update();
  const result = new Map<string, number[]>();
  for (const bone of mesh.skeleton.bones) result.set(bone.name, bone.matrixWorld.toArray());
  return result;
}

function analyzeHabanera(profile: PianistProfile, profileId: string, revision: number): PoseSet {
  const midi = new Uint8Array(readFileSync(new URL("../../../../builtin_melodies/midi/Habanera from Carmen.mid", import.meta.url)));
  const result = analyze_midi(midi, {
    fixtureId: "habanera-from-carmen",
    projectId: "index-axis-rigged-actual-test",
    revision,
    requestId: `index-axis-rigged/${profileId}/${revision}`,
    engineVersion: _engine_version(),
    keyStyle: "realistic",
    sampleTimes: [...SAMPLE_TIMES],
    profile,
  });
  if (result.status !== "loaded" || !result.motionPlan) throw new Error(`Production Habanera analysis failed for ${profileId}.`);
  expect(result.performancePlan?.profileId).toBe(profileId);
  expect(result.performancePlan?.profileRevision).toBe(revision);
  const poses = new Map<string, MotionPose>();
  const activeIndexSamples = new Set<string>();
  const activeThumbSamples = new Set<string>();
  const assignments = (result.fingeringPlan?.assignments ?? []) as FingeringAssignment[];
  const events = result.performancePlan!.events as PerformanceEvent[];
  const assignmentByNoteId = new Map(assignments.map((assignment) => [assignment.noteId, assignment]));
  const fingeredIndexNotes = new Set(assignments
    .filter((assignment) => assignment.disposition === "played" && assignment.finger === 2)
    .map((assignment) => assignment.noteId));
  const fingeredThumbNotes = new Set(assignments
    .filter((assignment) => assignment.disposition === "played" && assignment.finger === 1)
    .map((assignment) => assignment.noteId));
  const pressTimes = new Map<string, number>();
  const releaseTimes = new Map<string, number>();
  for (const event of events) {
    if (event.type === "press") pressTimes.set(event.noteId, event.timeSeconds);
    if (event.type === "release") releaseTimes.set(event.noteId, event.timeSeconds);
  }
  for (const timeSeconds of SAMPLE_TIMES) {
    for (const side of ["left", "right"] as const) {
      const pose = result.motionPlan.poses.find((row: MotionPose) => row.hand === side && row.transportTimeSeconds === timeSeconds);
      if (!pose) throw new Error(`Habanera ${side} MotionPose missing at ${timeSeconds}s for ${profileId}.`);
      poses.set(`${side}:${timeSeconds}`, pose);
      const indexIsActive = [...fingeredIndexNotes].some((noteId) => {
        const assignment = assignmentByNoteId.get(noteId);
        if (assignment?.hand !== side) return false;
        const press = pressTimes.get(noteId);
        const release = releaseTimes.get(noteId);
        return press !== undefined && release !== undefined && press <= timeSeconds && timeSeconds < release;
      });
      if (indexIsActive) activeIndexSamples.add(`${side}:${timeSeconds}`);
      const thumbIsActive = [...fingeredThumbNotes].some((noteId) => {
        const assignment = assignmentByNoteId.get(noteId);
        if (assignment?.hand !== side) return false;
        const press = pressTimes.get(noteId);
        const release = releaseTimes.get(noteId);
        return press !== undefined && release !== undefined && press <= timeSeconds && timeSeconds < release;
      });
      if (thumbIsActive) activeThumbSamples.add(`${side}:${timeSeconds}`);
    }
  }
  return { poses, activeIndexSamples, activeThumbSamples };
}

function measuredProfile(): PianistProfile {
  const profile = structuredClone(DEFAULT_PROFILE);
  profile.profileId = "b0815bae-02a6-4457-895a-fcd2096ce214";
  profile.name = "Rigged hands — measured baseline";
  profile.revision = 1;
  for (const measurement of RIGGED_HAND_PROFILE_PROVENANCE.measurements) {
    if (measurement.appliedToProfile) profile.anatomy[measurement.anatomyKey] = measurement.meanProfileUnits;
  }
  return profile;
}

describe("fixed per-hand index axes on the actual rigged Experimental GLBs", () => {
  it("preserves non-MCP zero poses, improves Habanera index geometry on both hands, and stays deterministic across seeks", async () => {
    const profiles: Array<{ id: string; revision: number; profile: PianistProfile }> = [
      { id: DEFAULT_PROFILE.profileId, revision: DEFAULT_PROFILE.revision, profile: structuredClone(DEFAULT_PROFILE) },
      { id: "b0815bae-02a6-4457-895a-fcd2096ce214", revision: 1, profile: measuredProfile() },
    ];
    const hands = new Map<Side, Hand>();
    const bindRotations = new Map<Side, QuaternionMap>();
    try {
      for (const side of ["left", "right"] as const) {
        const hand = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
        hands.set(side, hand);
        bindRotations.set(side, capturedLocalRotations(bonesFor(hand).bones));
      }
      for (const profileCase of profiles) {
        const poseSet = analyzeHabanera(profileCase.profile, profileCase.id, profileCase.revision);
        if (profileCase.id === "b0815bae-02a6-4457-895a-fcd2096ce214") {
          for (const timeSeconds of [24, 43.5, 53.1, 97.2] as const) {
            expect(poseSet.activeThumbSamples.has(`right:${timeSeconds}`), `The measured Habanera right thumb is active at ${timeSeconds}s.`).toBe(true);
          }
        }
        for (const side of ["left", "right"] as const) {
          const hand = hands.get(side)!;
          const { bones, mesh } = bonesFor(hand);
          const bind = bindRotations.get(side)!;

          // A straight flex pose leaves PIP/DIP and unrelated joints at bind.
          // MCP side alignment is an independent bounded motion channel.
          const zeroPose = straightened(reconstructHand3D(poseSet.poses.get(`${side}:0`)!));
          const zeroIndex = zeroPose.chains[2]!;
          expect(Math.abs(flexAngle(zeroIndex[0]!, zeroIndex[1]!, zeroIndex[2]!, zeroPose.palmNormal, 45))).toBeLessThan(1e-12);
          expect(Math.abs(flexAngle(zeroIndex[1]!, zeroIndex[2]!, zeroIndex[3]!, zeroPose.palmNormal, 70))).toBeLessThan(1e-12);
          expect(Math.abs(flexAngle(zeroIndex[2]!, zeroIndex[3]!, zeroIndex[4]!, zeroPose.palmNormal, 50))).toBeLessThan(1e-12);
          hand.update(zeroPose);
          for (const [name, quaternion] of bind) {
            // Axis correction counter-rotates only the palm locally so the
            // world palm frame stays fixed; the dedicated arm-axis actual test
            // checks that world invariant. Other non-MCP joints remain at bind.
            if (name === `${side}_palm` || isLongFingerMcp(side, name)) continue;
            expect(quaternionComponentDrift(requireBone(bones, name).quaternion, quaternion), `${name} must retain its bind quaternion for a straight zero-flex pose.`).toBeLessThan(1e-12);
          }

          let referenceLengths: Map<string, number> | undefined;
          let correctedIndexJointCount = 0;
          const referenceSeekPose = poseSet.poses.get(`${side}:97.2`)!;
          let directSeekMatrices: Map<string, number[]> | undefined;
          const targetBones = targetIndexBones(side);

          for (const timeSeconds of SAMPLE_TIMES) {
            const pose = reconstructHand3D(poseSet.poses.get(`${side}:${timeSeconds}`)!);
            hand.update(pose);
            hand.group.updateMatrixWorld(true);
            mesh.skeleton.update();

            const expectedCandidate = expectedCorrectedRotations(side, pose, bind);
            const expectedLegacy = expectedLegacyRotations(side, pose, bind);
            for (const bone of mesh.skeleton.bones) {
              const actual = bone.quaternion;
              expect(actual.toArray().every(Number.isFinite), `${bone.name} quaternion must stay finite at ${timeSeconds}s.`).toBe(true);
              // The rig-root axis step preserves palm world pose via a local
              // palm counter-rotation; finger-local and forearm-local frames
              // still obey the unchanged bind/axis expectations below.
              if (bone.name === `${side}_palm`) continue;
              if (isLongFingerMcp(side, bone.name)) {
                const expectedMcpFlex = expectedCandidate.get(bone.name)!;
                expect(actual.angleTo(expectedMcpFlex), `${bone.name} MCP side alignment stays within its 15 degree bound.`).toBeLessThanOrEqual(MAX_MCP_SIDE_ANGLE + THREE.MathUtils.degToRad(0.01));
              } else {
                expect(quaternionComponentDrift(actual, expectedCandidate.get(bone.name)!)).toBeLessThan(1e-10);
              }
              if (targetBones.has(bone.name)) {
                if (bone.name.endsWith("_proximal")) continue;
                const angle = actual.angleTo(expectedLegacy.get(bone.name)!);
                if (angle > 1e-3) correctedIndexJointCount += 1;
              } else if (!isLongFingerMcp(side, bone.name)) {
                expect(quaternionComponentDrift(actual, expectedLegacy.get(bone.name)!)).toBeLessThan(1e-10);
              }
            }

            for (const key of targetBones) {
              expect(expectedCandidate.has(key)).toBe(true);
              expect(bind.has(key)).toBe(true);
            }

            if (profileCase.id === "b0815bae-02a6-4457-895a-fcd2096ce214") {
              const candidateIndexVertices = terminalSkinVertexIds(mesh, side, "index");
              const candidateIndexError = indexDirectionError(side, bones, mesh, pose, candidateIndexVertices);
              const candidateSurface = side === "left" && timeSeconds === 0 ? terminalSurfaceGap(mesh) : null;
              const checkThumbSurface = timeSeconds === 0 || poseSet.activeThumbSamples.has(`${side}:${timeSeconds}`);
              const candidateThumbSurface = checkThumbSurface
                ? thumbSurfaceStats(side, mesh, pose.chains[1]![3]!)
                : null;
              const candidateRotations = new Map([...targetBones].map((name) => [name, requireBone(bones, name).quaternion.clone()]));

              // Keep the same measured MCP side alignment in the local-X control;
              // only change the three index flex axes being evaluated.
              const proximalName = `${side}_index_proximal`;
              const sideDelta = candidateRotations.get(proximalName)!.clone().multiply(expectedCandidate.get(proximalName)!.clone().invert());
              requireBone(bones, proximalName).quaternion.copy(sideDelta.multiply(expectedLegacy.get(proximalName)!.clone()));
              for (const joint of ["intermediate", "distal"] as const) {
                requireBone(bones, `${side}_index_${joint}`).quaternion.copy(expectedLegacy.get(`${side}_index_${joint}`)!);
              }
              hand.group.updateMatrixWorld(true);
              mesh.skeleton.update();
              const legacyIndexError = indexDirectionError(side, bones, mesh, pose, candidateIndexVertices);
              const legacySurface = candidateSurface ? terminalSurfaceGap(mesh) : null;
              const legacyThumbSurface = candidateThumbSurface
                ? thumbSurfaceStats(side, mesh, pose.chains[1]![3]!)
                : null;

              expect(candidateIndexVertices.length).toBeGreaterThan(0);
              expect(candidateIndexError, `${side} measured Habanera ${timeSeconds}s index direction`).toBeLessThan(legacyIndexError);
              if (candidateSurface && legacySurface) {
                expect(candidateSurface.minimumTerminalVertexGapInches).toBeGreaterThan(legacySurface.minimumTerminalVertexGapInches);
                expect(candidateSurface.medianIndexVertexToMiddleVertexInches).toBeGreaterThan(legacySurface.medianIndexVertexToMiddleVertexInches);
                for (const [vertex, middlePoint] of candidateSurface.middleVertices) {
                  expect(middlePoint.distanceTo(legacySurface.middleVertices.get(vertex)!)).toBeLessThan(1e-9);
                }
              }
              if (candidateThumbSurface && legacyThumbSurface) {
                expect(candidateThumbSurface.sampleCount).toBe(legacyThumbSurface.sampleCount);
                expect(Math.abs(candidateThumbSurface.medianY - legacyThumbSurface.medianY), `${side} thumb pad median height stays unchanged at ${timeSeconds}s.`).toBeLessThan(1e-9);
                expect(Math.abs(candidateThumbSurface.medianDistanceToTargetTip - legacyThumbSurface.medianDistanceToTargetTip), `${side} thumb pad-to-tip distance stays unchanged at ${timeSeconds}s.`).toBeLessThan(1e-9);
              }
              console.info("[measured Habanera index geometry: fixed axes vs local-X with same MCP side alignment]", JSON.stringify({
                side, profile: profileCase.id, sourcePoseTimeSeconds: timeSeconds,
                indexNoteActive: poseSet.activeIndexSamples.has(`${side}:${timeSeconds}`),
                thumbNoteActive: poseSet.activeThumbSamples.has(`${side}:${timeSeconds}`),
                meanDirectionErrorDeg: [legacyIndexError, candidateIndexError],
                ...(candidateThumbSurface && legacyThumbSurface ? {
                  thumbPadMedianYIn: [legacyThumbSurface.medianY, candidateThumbSurface.medianY],
                  thumbPadMedianTipDistanceIn: [legacyThumbSurface.medianDistanceToTargetTip, candidateThumbSurface.medianDistanceToTargetTip],
                } : {}),
                ...(candidateSurface && legacySurface ? {
                  minimumIndexMiddleGapIn: [legacySurface.minimumTerminalVertexGapInches, candidateSurface.minimumTerminalVertexGapInches],
                  medianIndexToMiddleIn: [legacySurface.medianIndexVertexToMiddleVertexInches, candidateSurface.medianIndexVertexToMiddleVertexInches],
                } : {}),
              }));

              hand.update(pose);
              if (side === "left" && timeSeconds === 0) {
                const candidateIndexErrorAfterRestore = indexDirectionError(side, bones, mesh, pose, candidateIndexVertices);
                expect(candidateIndexErrorAfterRestore).toBeLessThan(legacyIndexError);
              }
            }

            const currentLengths = linkLengths(bones, side);
            if (!referenceLengths) referenceLengths = currentLengths;
            for (const [name, length] of currentLengths) {
              expect(Number.isFinite(length), `${side} ${name} link length must stay finite.`).toBe(true);
              expect(Math.abs(length - referenceLengths.get(name)!)).toBeLessThan(1e-5);
            }

            if (timeSeconds === 97.2) directSeekMatrices = worldMatrices(hand, mesh);
          }

          // Repeated seeks through unrelated poses must not accumulate joint
          // deltas or depend on the playback order.
          for (const seekTime of [0, 43.5, 5.55, 97.5] as const) {
            hand.update(reconstructHand3D(poseSet.poses.get(`${side}:${seekTime}`)!));
          }
          hand.update(reconstructHand3D(referenceSeekPose));
          const replayMatrices = worldMatrices(hand, mesh);
          for (const [name, matrix] of directSeekMatrices!) {
            const replay = replayMatrices.get(name)!;
            expect(Math.max(...matrix.map((value, index) => Math.abs(value - replay[index]!)))).toBeLessThan(1e-6);
          }

          expect(correctedIndexJointCount).toBeGreaterThan(0);
        }
      }
    } finally {
      for (const hand of hands.values()) hand.dispose();
    }
  });
});
