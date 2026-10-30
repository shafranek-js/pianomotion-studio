// @ts-expect-error This actual-asset test reads the checked-in GLBs with Node fs.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { KEYBOARD_WIDTH_IN, reconstructHand3D } from "./handRigBuilder";
import { RiggedExperimentalHand } from "./riggedExperimentalHand";
import { HABANERA_49_RIGHT_SOURCE_POSE } from "./testingHandHabanera49Fixture";

type Side = "left" | "right";
type FingerCase = { finger: 2 | 3 | 4 | 5; name: "index" | "middle" | "ring" | "little" };
const FINGERS: readonly FingerCase[] = [
  { finger: 2, name: "index" },
  { finger: 3, name: "middle" },
  { finger: 4, name: "ring" },
  { finger: 5, name: "little" },
];
const MAX_MCP_SIDE_ANGLE_DEG = 15;
const THUMB_JOINTS = ["thumb_segment0_cmc-to-mcp", "thumb_segment1_mcp-to-ip", "thumb_distal-segment-a", "thumb_distal-segment-b"] as const;
const LOCAL_X = new THREE.Vector3(1, 0, 0);
const INDEX_PROXIMAL_FLEX_AXIS: Readonly<Record<Side, THREE.Vector3>> = {
  left: new THREE.Vector3(0.9155928434597187, -0.1948982392134811, 0.35171639335810295).normalize(),
  right: new THREE.Vector3(0.915583559, 0.194897975, -0.351740709).normalize(),
};

function bufferFor(side: Side): ArrayBuffer {
  const bytes = readFileSync(new URL(`../../public/models/hands/rigged-experimental/${side}.glb`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
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

function withLateralBaseMotion(pose: ReturnType<typeof reconstructHand3D>, finger: FingerCase["finger"], angleDegrees: number): ReturnType<typeof reconstructHand3D> {
  const chains = Object.fromEntries(
    Object.entries(pose.chains).map(([key, points]) => [key, points.map((point) => point.clone())]),
  ) as Record<number, THREE.Vector3[]>;
  const chain = chains[finger];
  if (!chain || chain.length < 5) throw new Error(`Missing reconstructed ${finger} chain.`);

  const pivotIndex = 1;
  const pivot = chain[pivotIndex]!.clone();
  const sideRotation = new THREE.Quaternion().setFromAxisAngle(
    pose.palmNormal.clone().normalize(),
    THREE.MathUtils.degToRad(angleDegrees),
  );
  for (let index = pivotIndex + 1; index < chain.length; index += 1) {
    chain[index]!.sub(pivot).applyQuaternion(sideRotation).add(pivot);
  }
  return { ...pose, chains };
}

function boneMap(hand: RiggedExperimentalHand): Map<string, THREE.Bone> {
  const bones = new Map<string, THREE.Bone>();
  hand.group.traverse((object) => {
    if (object instanceof THREE.Bone) bones.set(object.name, object);
  });
  return bones;
}

function requireBone(bones: Map<string, THREE.Bone>, name: string): THREE.Bone {
  const bone = bones.get(name);
  if (!bone) throw new Error(`Actual rigged GLB is missing ${name}.`);
  return bone;
}

function linkLengthSnapshot(hand: RiggedExperimentalHand): Map<string, number> {
  hand.group.updateMatrixWorld(true);
  const links = new Map<string, number>();
  hand.group.traverse((object) => {
    if (!(object instanceof THREE.Bone)) return;
    const start = object.getWorldPosition(new THREE.Vector3());
    for (const child of object.children) {
      if (!(child instanceof THREE.Bone)) continue;
      links.set(`${object.name}->${child.name}`, start.distanceTo(child.getWorldPosition(new THREE.Vector3())));
    }
  });
  return links;
}

function worldDirection(root: THREE.Bone, child: THREE.Bone): THREE.Vector3 {
  return child.getWorldPosition(new THREE.Vector3()).sub(root.getWorldPosition(new THREE.Vector3()));
}

function projectedAngleDegrees(from: THREE.Vector3, to: THREE.Vector3, normal: THREE.Vector3): number {
  const up = normal.clone().normalize();
  const fromPlanar = from.clone().addScaledVector(up, -from.dot(up));
  const toPlanar = to.clone().addScaledVector(up, -to.dot(up));
  if (fromPlanar.lengthSq() < 1e-10 || toPlanar.lengthSq() < 1e-10) {
    throw new Error("The base segment has no measurable component in the palm plane.");
  }
  fromPlanar.normalize();
  toPlanar.normalize();
  return THREE.MathUtils.radToDeg(Math.atan2(
    up.dot(new THREE.Vector3().crossVectors(fromPlanar, toPlanar)),
    fromPlanar.dot(toPlanar),
  ));
}

function quaternionComponentDrift(left: THREE.Quaternion, right: THREE.Quaternion): number {
  const sameSign = Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y), Math.abs(left.z - right.z), Math.abs(left.w - right.w));
  const oppositeSign = Math.max(Math.abs(left.x + right.x), Math.abs(left.y + right.y), Math.abs(left.z + right.z), Math.abs(left.w + right.w));
  return Math.min(sameSign, oppositeSign);
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

function localFingerHinges(bones: Map<string, THREE.Bone>, side: Side, finger: FingerCase["name"]): Map<string, THREE.Quaternion> {
  const names = [`${side}_${finger}_intermediate`, `${side}_${finger}_distal`];
  return new Map(names.map((name) => [name, requireBone(bones, name).quaternion.clone()]));
}

describe("lateral MotionPose retargeting on the actual experimental hand GLBs", () => {
  for (const side of ["left", "right"] as const) {
    for (const fingerCase of FINGERS) {
      for (const requestedDegrees of [12, 28] as const) {
      it(`moves the ${side} ${fingerCase.name} from its MCP by ${requestedDegrees} degrees, clamped at the side-angle limit`, async () => {
        const hand = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
        try {
          const bones = boneMap(hand);
          const root = requireBone(bones, `${side}_${fingerCase.name}_proximal`);
          const child = requireBone(bones, `${side}_${fingerCase.name}_intermediate`);
          expect(root.parent?.name).toBe(`${side}_${fingerCase.name}_metacarpal`);
          expect(child.parent?.name).toBe(root.name);
          const basePose = reconstructHand3D(sourcePose(side));
          const bindRootRotation = root.quaternion.clone();
          hand.update(basePose);
          const baseLengths = linkLengthSnapshot(hand);
          const baseHinges = localFingerHinges(bones, side, fingerCase.name);
          const baseThumbRotations = new Map(THUMB_JOINTS.map((name) => [
            `${side}_${name}`, requireBone(bones, `${side}_${name}`).quaternion.clone(),
          ]));
          const baseDirection = worldDirection(root, child);
          const baseRootRotation = root.quaternion.clone();
          const basePivot = root.getWorldPosition(new THREE.Vector3());
          const baseTargetDirection = basePose.chains[fingerCase.finger]![2]!
            .clone()
            .sub(basePose.chains[fingerCase.finger]![1]!);

          const requestedSideMotion = (side === "right" ? 1 : -1) * requestedDegrees;
          const targetPose = withLateralBaseMotion(basePose, fingerCase.finger, requestedSideMotion);
          hand.update(targetPose);
          hand.group.updateMatrixWorld(true);
          const candidateRootRotation = root.quaternion.clone();
          const targetDirection = targetPose.chains[fingerCase.finger]![2]!
            .clone()
            .sub(targetPose.chains[fingerCase.finger]![1]!);
          const requestedTargetDelta = projectedAngleDegrees(baseTargetDirection, targetDirection, targetPose.palmNormal);
          const chain = targetPose.chains[fingerCase.finger]!;
          const flexAxis = fingerCase.name === "index" ? INDEX_PROXIMAL_FLEX_AXIS[side] : LOCAL_X;
          const flexOnlyRotation = bindRootRotation.clone().multiply(new THREE.Quaternion().setFromAxisAngle(
            flexAxis,
            flexAngle(chain[0]!, chain[1]!, chain[2]!, targetPose.palmNormal, 45),
          ));
          root.quaternion.copy(flexOnlyRotation);
          hand.group.updateMatrixWorld(true);
          const flexOnlyDirection = worldDirection(root, child);
          const requestedAlignmentAngle = projectedAngleDegrees(flexOnlyDirection, targetDirection, targetPose.palmNormal);
          root.quaternion.copy(candidateRootRotation);
          hand.group.updateMatrixWorld(true);
          const posedDirection = worldDirection(root, child);
          const expectedAppliedAngle = THREE.MathUtils.clamp(requestedAlignmentAngle, -MAX_MCP_SIDE_ANGLE_DEG, MAX_MCP_SIDE_ANGLE_DEG);
          const actualAppliedAngle = projectedAngleDegrees(flexOnlyDirection, posedDirection, targetPose.palmNormal);
          const rootMotionFromBaseAngle = projectedAngleDegrees(baseDirection, posedDirection, targetPose.palmNormal);
          const posedTargetError = projectedAngleDegrees(posedDirection, targetDirection, targetPose.palmNormal);
          expect(Math.abs(requestedTargetDelta)).toBeGreaterThan(5);
          expect(Math.abs(requestedAlignmentAngle)).toBeGreaterThan(1);
          expect(Math.abs(actualAppliedAngle - expectedAppliedAngle)).toBeLessThan(0.75);
          expect(Math.abs(posedTargetError - (requestedAlignmentAngle - expectedAppliedAngle))).toBeLessThan(0.75);
          if (requestedDegrees === 12) expect(Math.abs(rootMotionFromBaseAngle - requestedTargetDelta)).toBeLessThan(0.5);
          expect(root.getWorldPosition(new THREE.Vector3()).distanceTo(basePivot), `${root.name} keeps its pivot fixed`).toBeLessThan(1e-6);

          const posedHinges = localFingerHinges(bones, side, fingerCase.name);
          for (const [name, rotation] of baseHinges) {
            expect(quaternionComponentDrift(requireBone(bones, name).quaternion, rotation), `${name} remains hinge-only under lateral input`).toBeLessThan(1e-12);
          }
          const posedLengths = linkLengthSnapshot(hand);
          expect(posedLengths.size).toBe(baseLengths.size);
          for (const [name, length] of baseLengths) {
            expect(Math.abs(posedLengths.get(name)! - length), `${name} keeps its source length`).toBeLessThan(1e-6);
          }
          expect(candidateRootRotation.angleTo(baseRootRotation)).toBeGreaterThan(1e-3);
          expect([...posedHinges.values()].every((rotation) => rotation.toArray().every(Number.isFinite))).toBe(true);
          for (const [name, rotation] of baseThumbRotations) {
            expect(quaternionComponentDrift(requireBone(bones, name).quaternion, rotation), `${name} stays unchanged; thumb side motion is excluded pending reach evidence`).toBeLessThan(1e-12);
          }
          console.info("[experimental MCP lateral-motion actual GLB]", JSON.stringify({
            side, finger: fingerCase.name, requestedSideAngleDeg: requestedSideMotion,
            requestedTargetDeltaDeg: requestedTargetDelta,
            appliedMcpAlignmentDeg: actualAppliedAngle,
            rootMotionFromBaseDeg: rootMotionFromBaseAngle,
            pivotOriginDeltaIn: root.getWorldPosition(new THREE.Vector3()).distanceTo(basePivot),
            childWorldDisplacementIn: child.getWorldPosition(new THREE.Vector3()).distanceTo(baseDirection.clone().add(root.getWorldPosition(new THREE.Vector3()))),
            maximumBoneLengthDeltaIn: Math.max(...[...baseLengths].map(([name, length]) => Math.abs(posedLengths.get(name)! - length))),
          }));
        } finally {
          hand.dispose();
        }
      });
      }
    }
  }
});
