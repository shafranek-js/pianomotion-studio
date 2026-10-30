// @ts-expect-error Asset conformance runs in Node; browser compilation omits Node types.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { KEYBOARD_WIDTH_IN, Hand3DMeshGroup, reconstructHand3D } from "./handRigBuilder";
import { RiggedExperimentalHand } from "./riggedExperimentalHand";
import { HABANERA_49_RIGHT_SOURCE_POSE } from "./testingHandHabanera49Fixture";
import { DEFAULT_SKIN_SETTINGS } from "../render/skins";

function bufferFor(side: "left" | "right"): ArrayBuffer {
  const bytes = readFileSync(new URL(`../../public/models/hands/rigged-experimental/${side}.glb`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function fixture(side: "left" | "right") {
  const source = structuredClone(HABANERA_49_RIGHT_SOURCE_POSE);
  if (side === "right") return source;
  const mirror = (point: [number, number, number]): [number, number, number] => [KEYBOARD_WIDTH_IN - point[0], point[1], point[2]];
  return {
    ...source, hand: "left" as const,
    joints: source.joints.map((joint) => ({ ...joint, point: mirror(joint.point) })),
    bones: source.bones.map((bone) => ({ ...bone, a: mirror(bone.a), b: mirror(bone.b) })),
  };
}

describe("real experimental rig assets", () => {
  for (const side of ["left", "right"] as const) {
    it(`loads and poses the ${side} hand with fixed bone lengths and inward thumb`, async () => {
      const hand = await RiggedExperimentalHand.fromBuffer(side, bufferFor(side));
      const bones = new Map<string, THREE.Bone>();
      hand.group.traverse((node) => { if (node instanceof THREE.Bone) bones.set(node.name, node); });
      const before = new Map([...bones].map(([name, bone]) => [name, { position: bone.position.clone(), scale: bone.scale.clone() }]));
      const pose = reconstructHand3D(fixture(side));
      hand.update(pose);
      expect(hand.triangleCount).toBe(34864);
      expect(hand.sourceAssetSha256).toMatch(/^[0-9a-f]{64}$/);
      const initialDiagnosticFrame = hand.sampleLiveDiagnostics();
      expect(initialDiagnosticFrame.boneWorldTransformRows).toHaveLength(22);
      expect(initialDiagnosticFrame.fixedDistalSkinSampleRows).toHaveLength(15);
      expect(initialDiagnosticFrame.unavailableFingerSamples).toEqual([]);
      expect(initialDiagnosticFrame.boneWorldTransformRows.every(row => row.length === 8 && row.every(Number.isFinite))).toBe(true);
      expect(initialDiagnosticFrame.fixedDistalSkinSampleRows.every(row => row.length === 7 && row.every(Number.isFinite))).toBe(true);
      for (const [boneId, suffix] of [[20, "forearm"], [21, "palm"]] as const) {
        const bone = bones.get(`${side}_${suffix}`)!;
        const position = bone.getWorldPosition(new THREE.Vector3());
        const quaternion = bone.getWorldQuaternion(new THREE.Quaternion());
        const round = (value: number) => Math.round(value * 1000) / 1000;
        expect(initialDiagnosticFrame.boneWorldTransformRows[boneId]).toEqual([
          boneId,
          round(position.x), round(position.y), round(position.z),
          round(quaternion.x), round(quaternion.y), round(quaternion.z), round(quaternion.w),
        ]);
      }
      const wrist = bones.get(`${side}_palm`)!.getWorldPosition(new THREE.Vector3());
      const thumb = bones.get(`${side}_thumb_segment0_cmc-to-mcp`)!.getWorldPosition(new THREE.Vector3());
      expect(wrist.distanceTo(pose.wristCenter)).toBeLessThan(0.0001);
      expect(side === "left" ? thumb.x > wrist.x : thumb.x < wrist.x).toBe(true);
      for (const [name, bone] of bones) {
        expect(bone.position.distanceTo(before.get(name)!.position)).toBeLessThan(1e-8);
        expect(bone.scale.distanceTo(before.get(name)!.scale)).toBeLessThan(1e-8);
        expect(bone.quaternion.toArray().every(Number.isFinite)).toBe(true);
      }
      const index = bones.get(`${side}_index_intermediate`)!;
      const first = index.quaternion.clone();
      const altered = reconstructHand3D(fixture(side));
      const chain = altered.chains[2]!;
      chain[3] = chain[2]!.clone().add(new THREE.Vector3(0, -0.75, 0));
      hand.update(altered);
      expect(index.quaternion.angleTo(first)).toBeGreaterThan(0.01);
      const alteredDiagnosticFrame = hand.sampleLiveDiagnostics();
      expect(alteredDiagnosticFrame.fixedDistalSkinSampleRows.map(row => row.slice(0, 4))).toEqual(
        initialDiagnosticFrame.fixedDistalSkinSampleRows.map(row => row.slice(0, 4)),
      );
      expect(alteredDiagnosticFrame.fixedDistalSkinSampleRows).not.toEqual(initialDiagnosticFrame.fixedDistalSkinSampleRows);
      expect(alteredDiagnosticFrame.boneWorldTransformRows).not.toEqual(initialDiagnosticFrame.boneWorldTransformRows);
      hand.dispose();
    });
  }

  it("installs the candidate for live poses and restores the legacy model on switch", async () => {
    const load = vi.spyOn(RiggedExperimentalHand, "load").mockImplementation(async (side) => RiggedExperimentalHand.fromBuffer(side, bufferFor(side)));
    const group = new Hand3DMeshGroup("right");
    try {
      group.setHandModel("rigged-experimental");
      await group.waitForHandModelReady();
      expect(group.getHandModelDiagnostics()).toMatchObject({ requestedModel: "rigged-experimental", loadedModel: "rigged-experimental", state: "ready", triangles: 34864 });
      group.updateFromPose(fixture("right"), DEFAULT_SKIN_SETTINGS, false);
      expect(group.group.visible).toBe(true);
      expect(group.group.getObjectByName("experimental-rigged-right")).toBeDefined();
      group.setHandModel("webxr");
      expect(group.getHandModel()).toBe("webxr");
      expect(group.group.getObjectByName("experimental-rigged-right")).toBeUndefined();
    } finally {
      group.dispose();
      load.mockRestore();
    }
  });

  it("disposes a late load when the selection changes", async () => {
    const candidate = await RiggedExperimentalHand.fromBuffer("right", bufferFor("right"));
    const dispose = vi.spyOn(candidate, "dispose");
    let finish!: (value: RiggedExperimentalHand) => void;
    const load = vi.spyOn(RiggedExperimentalHand, "load").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const group = new Hand3DMeshGroup("right");
    try {
      group.setHandModel("rigged-experimental");
      group.setHandModel("webxr");
      finish(candidate);
      await Promise.resolve();
      expect(group.getHandModel()).toBe("webxr");
      expect(dispose).toHaveBeenCalledOnce();
      expect(group.group.getObjectByName("experimental-rigged-right")).toBeUndefined();
    } finally {
      group.dispose();
      load.mockRestore();
    }
  });
});
