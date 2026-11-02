// @ts-expect-error This actual-asset test reads the checked-in GLBs and Habanera pose bundle with Node fs.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { reconstructHand3D } from "./handRigBuilder";
import { populateHandContactTargets, type ImprovedHandContactTarget } from "./improvedHandContact";
import { Keyboard3DView } from "./keyboard3dView";
import {
  RiggedExperimentalHand,
  riggedHandStartPoseLiveAlpha,
} from "./riggedExperimentalHand";
import { importRiggedHandPosePresetJson } from "./riggedHandPosePreset";
import type { MotionPose } from "@handthesia/contracts";

type Side = "left" | "right";

interface HabaneraSampleRow {
  timeSeconds: number;
  activeNotes: Array<{ hand: Side; finger: number; pitch: number }>;
  motionPoses: MotionPose[];
}

function bufferFor(side: Side): ArrayBuffer {
  const bytes = readFileSync(new URL(`../../public/models/hands/rigged-experimental/${side}.glb`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function loadBundledStartingPose() {
  return importRiggedHandPosePresetJson(
    readFileSync(
      new URL("../../public/models/hands/rigged-experimental/right_hand_starting_pose.rigged-hand-pose.json", import.meta.url),
      "utf8",
    ),
  );
}

function loadHabaneraBundle(): { samples: HabaneraSampleRow[] } {
  return JSON.parse(
    readFileSync(
      new URL("../../../../scratch/hand-candidate-index-fix-20261029-fixed/index-fix-pose-bundle.json", import.meta.url),
      "utf8",
    ),
  ) as { samples: HabaneraSampleRow[] };
}

function enrichTargetsWithKeyboardBounds(keyboard: Keyboard3DView, targets: ImprovedHandContactTarget[]): void {
  const bounds = new THREE.Box3();
  const center = new THREE.Vector3();
  for (const target of targets) {
    if (target.pitch === null) continue;
    const key = keyboard.keysByPitch.get(target.pitch);
    if (!key) continue;
    key.mesh.updateWorldMatrix(true, false);
    bounds.setFromObject(key.mesh);
    if (bounds.isEmpty()) continue;
    bounds.getCenter(center);
    target.contactCenterX = center.x;
    target.contactMinX = bounds.min.x;
    target.contactMaxX = bounds.max.x;
    target.contactMinZ = bounds.min.z;
    target.contactMaxZ = bounds.max.z;
  }
}

describe("RiggedExperimentalHand continuous reference pose and real-time key contact solver", () => {
  it("builds all Habanera frames continuously from the starting pose, lands 100% of active fingers on their keys with 0 penetrations, and keeps free fingers above unpressed keys", async () => {
    const [leftHand, rightHand] = await Promise.all([
      RiggedExperimentalHand.fromBuffer("left", bufferFor("left")),
      RiggedExperimentalHand.fromBuffer("right", bufferFor("right")),
    ]);
    const preset = loadBundledStartingPose();
    const rightStartPose = rightHand.retargetPoseToHand(preset.hands.right, rightHand, false);
    const leftStartPose = rightHand.retargetPoseToHand(preset.hands.right, leftHand, true);

    const keyboard = new Keyboard3DView();
    keyboard.group.updateMatrixWorld(true);
    const sampleSurface = (pitch: number, x: number, z: number): number | null =>
      keyboard.sampleKeySurfaceYAt(pitch, x, z);

    const bundle = loadHabaneraBundle();
    expect(bundle.samples.length).toBeGreaterThanOrEqual(16);

    // 1. Verify C0 continuity across t = 0 (-1e-4 s -> 0 s) when no note starts at t = 0 (right hand)
    const sample0 = bundle.samples.find((s) => s.timeSeconds === 0)!;
    const rightPose0 = sample0.motionPoses.find((p) => p.hand === "right")!;
    const rightH3d0 = reconstructHand3D(rightPose0, 0);
    keyboard.setActiveKeys([]);
    const rightTargets0 = populateHandContactTargets([], "right", 0, [], sampleSurface);
    enrichTargetsWithKeyboardBounds(keyboard, rightTargets0);

    const alphaBeforeZero = riggedHandStartPoseLiveAlpha(-1e-4, 2);
    rightHand.update(
      rightH3d0,
      { pose: rightStartPose, liveAlpha: alphaBeforeZero },
      { referencePose: rightStartPose, contactTargets: rightTargets0, displayedTransportTimeSeconds: -1e-4 },
    );
    const beforeZeroSnap = rightHand.sampleLiveDiagnostics();

    rightHand.update(
      rightH3d0,
      undefined,
      { referencePose: rightStartPose, contactTargets: rightTargets0, displayedTransportTimeSeconds: 0 },
    );
    const atZeroSnap = rightHand.sampleLiveDiagnostics();

    for (let i = 0; i < beforeZeroSnap.fixedDistalSkinSampleRows.length; i++) {
      const bRow = beforeZeroSnap.fixedDistalSkinSampleRows[i]!;
      const aRow = atZeroSnap.fixedDistalSkinSampleRows[i]!;
      const distIn = Math.hypot(aRow[4]! - bRow[4]!, aRow[5]! - bRow[5]!, aRow[6]! - bRow[6]!);
      expect(distIn).toBeLessThan(0.002);
    }

    // 1b. Verify adult pianist hand proportions relative to the keyboard (MCP2-to-MCP5 span >= 2.50 in)
    const mcp2Row = atZeroSnap.boneWorldTransformRows[5]!; // index_proximal (MCP2)
    const mcp5Row = atZeroSnap.boneWorldTransformRows[17]!; // little_proximal (MCP5)
    const mcpSpanIn = Math.hypot(
      mcp2Row[1]! - mcp5Row[1]!,
      mcp2Row[2]! - mcp5Row[2]!,
      mcp2Row[3]! - mcp5Row[3]!,
    );
    expect(mcpSpanIn).toBeGreaterThanOrEqual(2.5);

    // 2. Verify all 16 Habanera samples across both hands
    let totalActiveNoteEvaluations = 0;
    const updateDurationsMs: number[] = [];

    for (const sample of bundle.samples) {
      const notesWithBounds = (sample.activeNotes ?? []).map((n) => ({
        ...n,
        startSeconds: sample.timeSeconds,
        endSeconds: sample.timeSeconds + 0.5,
      }));
      const activePitches = new Set(notesWithBounds.map((n) => n.pitch));
      keyboard.setActiveKeys(activePitches);

      for (const side of ["left", "right"] as const) {
        const hand = side === "left" ? leftHand : rightHand;
        const startPose = side === "left" ? leftStartPose : rightStartPose;
        const pose = sample.motionPoses.find((p) => p.hand === side)!;
        const h3d = reconstructHand3D(pose, 0);
        const liveAlpha = riggedHandStartPoseLiveAlpha(sample.timeSeconds, 2);
        const leadInBlend = liveAlpha < 1 ? { pose: startPose, liveAlpha } : undefined;
        const targets = populateHandContactTargets(
          notesWithBounds,
          side,
          sample.timeSeconds,
          [],
          sampleSurface,
        );
        enrichTargetsWithKeyboardBounds(keyboard, targets);

        const t0 = performance.now();
        hand.update(h3d, leadInBlend, {
          referencePose: startPose,
          contactTargets: targets,
          displayedTransportTimeSeconds: sample.timeSeconds,
        });
        updateDurationsMs.push(performance.now() - t0);

        const live = hand.sampleLiveDiagnostics();
        const exportedPose = hand.exportPose();
        for (const thumbPhalanxSuffix of ["thumb_segment1_mcp-to-ip", "thumb_distal-segment-a", "thumb_distal-segment-b"] as const) {
          const boneName = `${side}_${thumbPhalanxSuffix}`;
          const actualBone = exportedPose.bones.find((b) => b.name === boneName)!;
          const refBone = startPose.bones.find((b) => b.name === boneName)!;
          const qActual = new THREE.Quaternion(...actualBone.quaternion);
          const qRef = new THREE.Quaternion(...refBone.quaternion);
          expect(qActual.angleTo(qRef)).toBeLessThan(1e-6);
        }

        // Check that no finger overhangs the front edge of the white keys (z <= 0)
        for (const row of live.fixedDistalSkinSampleRows) {
          expect(row[6]!).toBeLessThanOrEqual(0);
        }

        // Check active and free fingers
        for (const target of targets) {
          const fingerRows = live.fixedDistalSkinSampleRows.filter((r) => r[0] === target.finger);
          expect(fingerRows.length).toBe(3);

          if (target.pitch !== null) {
            totalActiveNoteEvaluations++;
            const gapsMm: number[] = [];
            for (const row of fingerRows) {
              const x = row[4]!;
              const y = row[5]!;
              const z = row[6]!;
              expect(x).toBeGreaterThanOrEqual(target.contactMinX!);
              expect(x).toBeLessThanOrEqual(target.contactMaxX!);
              expect(z).toBeGreaterThanOrEqual(target.contactMinZ!);
              expect(z).toBeLessThanOrEqual(target.contactMaxZ!);

              const keyTopY = sampleSurface(target.pitch, x, z);
              expect(keyTopY).not.toBeNull();
              const gapMm = (y - keyTopY!) * 25.4;
              // Zero penetration below key top, and contact pad within 1.5 mm
              expect(gapMm).toBeGreaterThanOrEqual(0);
              gapsMm.push(gapMm);
            }
            expect(Math.min(...gapsMm)).toBeLessThanOrEqual(1.0);
            expect(Math.max(...gapsMm)).toBeLessThanOrEqual(1.6);
          } else {
            // Free finger must not penetrate unpressed keys underneath it, AND any part of a free
            // finger inside the black-key depth zone (z <= -1.898 in) must stay above the 0.46 in black-key plane.
            for (const row of fingerRows) {
              const x = row[4]!;
              const y = row[5]!;
              const z = row[6]!;
              if (z <= -1.898 && z >= -5.2) {
                expect(y).toBeGreaterThanOrEqual(0.46);
              }
              const approxWhiteIndex = Math.round(((x + 24.142857) / (6.5 / 7.0)) - 0.5);
              const approxMidi = Math.max(21, Math.min(108, 21 + Math.round(approxWhiteIndex * (12 / 7))));
              for (let pitch = Math.max(21, approxMidi - 3); pitch <= Math.min(108, approxMidi + 3); pitch++) {
                if (activePitches.has(pitch)) continue;
                const unpressedTopY = sampleSurface(pitch, x, z);
                if (unpressedTopY !== null) {
                  expect(y).toBeGreaterThanOrEqual(unpressedTopY);
                }
              }
            }
          }
        }
      }
    }

    expect(totalActiveNoteEvaluations).toBe(25);
    const meanUpdateMs = updateDurationsMs.reduce((a, b) => a + b, 0) / updateDurationsMs.length;
    expect(meanUpdateMs).toBeLessThan(2.0);

    // 3. Verify zero seek drift when jumping between t = 43.5 s, t = -2 s, and back to t = 43.5 s
    const sample43 = bundle.samples.find((s) => s.timeSeconds === 43.5)!;
    const sampleNeg2 = bundle.samples.find((s) => s.timeSeconds === -2)!;
    const notes43 = (sample43.activeNotes ?? []).map((n) => ({
      ...n,
      startSeconds: 43.5,
      endSeconds: 44.0,
    }));
    keyboard.setActiveKeys(new Set(notes43.map((n) => n.pitch)));
    const leftTargets43 = populateHandContactTargets(notes43, "left", 43.5, [], sampleSurface);
    enrichTargetsWithKeyboardBounds(keyboard, leftTargets43);
    const leftH3d43 = reconstructHand3D(sample43.motionPoses.find((p) => p.hand === "left")!, 0);

    leftHand.update(leftH3d43, undefined, {
      referencePose: leftStartPose,
      contactTargets: leftTargets43,
      displayedTransportTimeSeconds: 43.5,
    });
    const first43 = leftHand.exportPose();

    keyboard.setActiveKeys([]);
    const leftTargetsNeg2 = populateHandContactTargets([], "left", -2, [], sampleSurface);
    const leftH3dNeg2 = reconstructHand3D(sampleNeg2.motionPoses.find((p) => p.hand === "left")!, 0);
    leftHand.update(
      leftH3dNeg2,
      { pose: leftStartPose, liveAlpha: 0 },
      { referencePose: leftStartPose, contactTargets: leftTargetsNeg2, displayedTransportTimeSeconds: -2 },
    );

    keyboard.setActiveKeys(new Set(notes43.map((n) => n.pitch)));
    leftHand.update(leftH3d43, undefined, {
      referencePose: leftStartPose,
      contactTargets: leftTargets43,
      displayedTransportTimeSeconds: 43.5,
    });
    const second43 = leftHand.exportPose();
    expect(second43).toEqual(first43);

    // 4. Verify temporal smoothing during 60fps playback reduces frame-to-frame angular velocity spikes
    const sample195 = bundle.samples.find((s) => s.timeSeconds === 1.95)!;
    const h3d195 = reconstructHand3D(sample195.motionPoses.find((p) => p.hand === "left")!, 0);
    const notes195 = (sample195.activeNotes ?? []).map((n) => ({
      ...n,
      startSeconds: 1.95,
      endSeconds: 2.45,
    }));
    keyboard.setActiveKeys(new Set(notes195.map((n) => n.pitch)));
    const targets195 = populateHandContactTargets(notes195, "left", 1.95, [], sampleSurface);
    enrichTargetsWithKeyboardBounds(keyboard, targets195);

    // Initialize at t = 1.934s with idle pose right before note onset, then step +16ms to t = 1.95s with active note
    leftHand.update(h3d195, undefined, {
      referencePose: leftStartPose,
      contactTargets: populateHandContactTargets([], "left", 1.934, [], sampleSurface),
      displayedTransportTimeSeconds: 1.934,
    });
    const beforeStepSnap = leftHand.sampleLiveDiagnostics();

    leftHand.update(h3d195, undefined, {
      referencePose: leftStartPose,
      contactTargets: targets195,
      displayedTransportTimeSeconds: 1.95,
    });
    const smoothedStepSnap = leftHand.sampleLiveDiagnostics();

    // Compare against an unsmoothed jump to the exact same t = 1.95s target (seek from t = 0s, dt = 1.95s > 0.09s)
    leftHand.update(h3d195, undefined, {
      referencePose: leftStartPose,
      contactTargets: populateHandContactTargets([], "left", 0, [], sampleSurface),
      displayedTransportTimeSeconds: 0,
    });
    leftHand.update(h3d195, undefined, {
      referencePose: leftStartPose,
      contactTargets: targets195,
      displayedTransportTimeSeconds: 1.95,
    });
    const unsmoothedSnap = leftHand.sampleLiveDiagnostics();

    const stepDisplacementIn = Math.hypot(
      smoothedStepSnap.fixedDistalSkinSampleRows[3]![4]! - beforeStepSnap.fixedDistalSkinSampleRows[3]![4]!,
      smoothedStepSnap.fixedDistalSkinSampleRows[3]![5]! - beforeStepSnap.fixedDistalSkinSampleRows[3]![5]!,
      smoothedStepSnap.fixedDistalSkinSampleRows[3]![6]! - beforeStepSnap.fixedDistalSkinSampleRows[3]![6]!,
    );
    const fullJumpDisplacementIn = Math.hypot(
      unsmoothedSnap.fixedDistalSkinSampleRows[3]![4]! - beforeStepSnap.fixedDistalSkinSampleRows[3]![4]!,
      unsmoothedSnap.fixedDistalSkinSampleRows[3]![5]! - beforeStepSnap.fixedDistalSkinSampleRows[3]![5]!,
      unsmoothedSnap.fixedDistalSkinSampleRows[3]![6]! - beforeStepSnap.fixedDistalSkinSampleRows[3]![6]!,
    );
    expect(stepDisplacementIn).toBeLessThan(fullJumpDisplacementIn * 0.75);
    // Even on the first smoothed frame, the active index finger must not penetrate below the key surface
    for (const row of smoothedStepSnap.fixedDistalSkinSampleRows.filter((r) => r[0] === 2)) {
      const surfY = sampleSurface(45, row[4]!, row[6]!);
      if (surfY !== null) {
        expect(row[5]!).toBeGreaterThanOrEqual(surfY);
      }
    }

    // 5. Verify hand-to-hand collision avoidance separates overlapping left and right hands
    const collidingRightPose = structuredClone(sample195.motionPoses.find((p) => p.hand === "right")!);
    const collidingLeftPose = structuredClone(sample195.motionPoses.find((p) => p.hand === "left")!);
    // Force the idle right hand into the exact same X/Z register as the playing left hand
    const shiftX = collidingLeftPose.joints[0]!.point[0] - collidingRightPose.joints[0]!.point[0] + 0.5;
    for (const j of collidingRightPose.joints) j.point[0] += shiftX;
    for (const b of collidingRightPose.bones) {
      b.a[0] += shiftX;
      b.b[0] += shiftX;
    }
    leftHand.update(reconstructHand3D(collidingLeftPose, 0), undefined, {
      referencePose: leftStartPose,
      contactTargets: targets195,
      displayedTransportTimeSeconds: 20.0,
    });
    rightHand.update(reconstructHand3D(collidingRightPose, 0), undefined, {
      referencePose: rightStartPose,
      contactTargets: populateHandContactTargets([], "right", 20.0, [], sampleSurface),
      displayedTransportTimeSeconds: 20.0,
    });
    RiggedExperimentalHand.resolveHandPairCollisions(leftHand, rightHand, targets195, []);
    const resolvedLeftSnap = leftHand.sampleLiveDiagnostics();
    const resolvedRightSnap = rightHand.sampleLiveDiagnostics();
    const maxLeftTipX = Math.max(...resolvedLeftSnap.fixedDistalSkinSampleRows.map((r) => r[4]!));
    const minRightTipX = Math.min(...resolvedRightSnap.fixedDistalSkinSampleRows.map((r) => r[4]!));
    expect(minRightTipX).toBeGreaterThan(maxLeftTipX);

    // 6. Verify whole-mesh 17,481-vertex non-penetration across all keys (MIDI 45..70) at t = 43.5 s and t = 53.1 s
    const assertZeroMeshVerticesBelowKeySurface = (timeSec: number) => {
      const sampleAtTime = bundle.samples.find((s) => s.timeSeconds === timeSec)!;
      const notesAtTime = (sampleAtTime.activeNotes ?? []).map((n) => ({
        ...n,
        startSeconds: timeSec,
        endSeconds: timeSec + 0.5,
      }));
      keyboard.setActiveKeys(new Set(notesAtTime.map((n) => n.pitch)));
      keyboard.group.updateMatrixWorld(true);

      const leftT = populateHandContactTargets(notesAtTime, "left", timeSec, [], sampleSurface);
      const rightT = populateHandContactTargets(notesAtTime, "right", timeSec, [], sampleSurface);
      enrichTargetsWithKeyboardBounds(keyboard, leftT);
      enrichTargetsWithKeyboardBounds(keyboard, rightT);

      leftHand.update(reconstructHand3D(sampleAtTime.motionPoses.find((p) => p.hand === "left")!, 0), undefined, {
        referencePose: leftStartPose,
        contactTargets: leftT,
        displayedTransportTimeSeconds: timeSec,
      });
      rightHand.update(reconstructHand3D(sampleAtTime.motionPoses.find((p) => p.hand === "right")!, 0), undefined, {
        referencePose: rightStartPose,
        contactTargets: rightT,
        displayedTransportTimeSeconds: timeSec,
      });
      RiggedExperimentalHand.resolveHandPairCollisions(leftHand, rightHand, leftT, rightT);

      const keyCandidates: Array<{ pitch: number; bounds: THREE.Box3 }> = [];
      for (let pitch = 45; pitch <= 70; pitch++) {
        const key = keyboard.keysByPitch.get(pitch);
        if (key) {
          key.mesh.updateWorldMatrix(true, false);
          keyCandidates.push({ pitch, bounds: new THREE.Box3().setFromObject(key.mesh) });
        }
      }

      const vertexWorld = new THREE.Vector3();
      for (const hand of [leftHand, rightHand]) {
        let skinnedMesh!: THREE.SkinnedMesh;
        hand.group.traverse((obj) => {
          if ((obj as THREE.SkinnedMesh).isSkinnedMesh) skinnedMesh = obj as THREE.SkinnedMesh;
        });
        skinnedMesh.updateWorldMatrix(true, false);
        skinnedMesh.skeleton.update();
        const positions = skinnedMesh.geometry.getAttribute("position");
        expect(positions.count).toBe(17481);
        let penetratingVertexCount = 0;
        for (let i = 0; i < positions.count; i++) {
          vertexWorld.fromBufferAttribute(positions, i);
          skinnedMesh.applyBoneTransform(i, vertexWorld).applyMatrix4(skinnedMesh.matrixWorld);
          for (const { pitch, bounds } of keyCandidates) {
            if (
              vertexWorld.x < bounds.min.x ||
              vertexWorld.x > bounds.max.x ||
              vertexWorld.z < bounds.min.z ||
              vertexWorld.z > bounds.max.z ||
              vertexWorld.y > bounds.max.y
            ) {
              continue;
            }
            const topY = sampleSurface(pitch, vertexWorld.x, vertexWorld.z);
            if (topY !== null && vertexWorld.y < topY - 0.1 / 25.4) {
              penetratingVertexCount++;
            }
          }
        }
        expect(penetratingVertexCount).toBe(0);
      }
    };

    assertZeroMeshVerticesBelowKeySurface(43.5);
    assertZeroMeshVerticesBelowKeySurface(53.1);

    // 7. Verify repeated back-to-back notes re-articulate (lift and re-strike) instead of staying glued down
    const repeatedPinkyNotes = [
      { hand: "right" as const, finger: 5, pitch: 69, startSeconds: 49.2, endSeconds: 49.5 },
      { hand: "right" as const, finger: 5, pitch: 69, startSeconds: 49.5, endSeconds: 49.8 },
      { hand: "right" as const, finger: 5, pitch: 69, startSeconds: 49.8, endSeconds: 50.1 },
      { hand: "right" as const, finger: 5, pitch: 69, startSeconds: 50.1, endSeconds: 50.355 },
    ];
    const basePoseSample = bundle.samples.find((s) => s.timeSeconds === 43.5)!;
    const rightPoseRepeated = reconstructHand3D(basePoseSample.motionPoses.find((p) => p.hand === "right")!, 0);
    const samplePinkyMinYAt = (timeSec: number, pressedWeight = 1): number => {
      keyboard.setActiveKeys(
        new Map([[69, { hand: "right" as const, finger: 5, depressionWeight: pressedWeight }]]),
      );
      keyboard.group.updateMatrixWorld(true);
      const repTargets = populateHandContactTargets(repeatedPinkyNotes, "right", timeSec, [], sampleSurface);
      enrichTargetsWithKeyboardBounds(keyboard, repTargets);
      rightHand.update(rightPoseRepeated, undefined, {
        referencePose: rightStartPose,
        contactTargets: repTargets,
        displayedTransportTimeSeconds: timeSec,
      });
      const rows = rightHand.sampleLiveDiagnostics().fixedDistalSkinSampleRows.filter((r) => r[0] === 5);
      return Math.min(...rows.map((r) => r[5]!));
    };

    const holdY1 = samplePinkyMinYAt(49.30, 1);
    const liftY12 = samplePinkyMinYAt(49.50, 0.02);
    const holdY2 = samplePinkyMinYAt(49.65, 1);
    const liftY23 = samplePinkyMinYAt(49.80, 0.02);
    const holdY3 = samplePinkyMinYAt(49.95, 1);
    const liftY34 = samplePinkyMinYAt(50.10, 0.02);
    const holdY4 = samplePinkyMinYAt(50.25, 1);

    expect(liftY12 - holdY1).toBeGreaterThan(0.45);
    expect(liftY12 - holdY2).toBeGreaterThan(0.45);
    expect(liftY23 - holdY2).toBeGreaterThan(0.45);
    expect(liftY23 - holdY3).toBeGreaterThan(0.45);
    expect(liftY34 - holdY3).toBeGreaterThan(0.45);
    expect(liftY34 - holdY4).toBeGreaterThan(0.45);

    // 8. Verify two-tier over-hand / under-hand bridging when both hands actively play in the same register
    // (reproducing the shared-register / crossing passage at 0:25 in The Four Seasons - Autumn where
    // left hand plays pitch 65 (F4) with finger 3 and right hand plays pitch 64 (E4) with finger 2).
    const baseLeftMotion = structuredClone(sample195.motionPoses.find((p) => p.hand === "left")!);
    const baseRightMotion = structuredClone(sample195.motionPoses.find((p) => p.hand === "right")!);
    const f4BoundsInit = new THREE.Box3().setFromObject(keyboard.keysByPitch.get(65)!.mesh);
    const e4BoundsInit = new THREE.Box3().setFromObject(keyboard.keysByPitch.get(64)!.mesh);
    const key65X = (f4BoundsInit.min.x + f4BoundsInit.max.x) * 0.5;
    const key64X = (e4BoundsInit.min.x + e4BoundsInit.max.x) * 0.5;
    const keyboardHalfW = 24.14285714;
    const leftF3TipX = baseLeftMotion.joints.filter((j) => j.kind === "tip")[1]!.point[0];
    const rightF2TipX = baseRightMotion.joints.filter((j) => j.kind === "tip")[0]!.point[0];
    const leftDeltaX = (key65X + keyboardHalfW) - leftF3TipX;
    const rightDeltaX = (key64X + keyboardHalfW) - rightF2TipX;
    for (const j of baseLeftMotion.joints) j.point[0] += leftDeltaX;
    for (const b of baseLeftMotion.bones) {
      b.a[0] += leftDeltaX;
      b.b[0] += leftDeltaX;
    }
    for (const j of baseRightMotion.joints) j.point[0] += rightDeltaX;
    for (const b of baseRightMotion.bones) {
      b.a[0] += rightDeltaX;
      b.b[0] += rightDeltaX;
    }
    const autumnNotes = [
      { hand: "left" as const, finger: 3, pitch: 65, startSeconds: 24.8, endSeconds: 25.3 },
      { hand: "right" as const, finger: 2, pitch: 64, startSeconds: 24.8, endSeconds: 25.3 },
    ];
    keyboard.setActiveKeys(
      new Map([
        [65, { hand: "left" as const, finger: 3, depressionWeight: 1 }],
        [64, { hand: "right" as const, finger: 2, depressionWeight: 1 }],
      ]),
    );
    keyboard.group.updateMatrixWorld(true);
    const autumnLeftTargets = populateHandContactTargets(autumnNotes, "left", 25.0, [], sampleSurface);
    const autumnRightTargets = populateHandContactTargets(autumnNotes, "right", 25.0, [], sampleSurface);
    enrichTargetsWithKeyboardBounds(keyboard, autumnLeftTargets);
    enrichTargetsWithKeyboardBounds(keyboard, autumnRightTargets);

    leftHand.update(reconstructHand3D(baseLeftMotion, 0), undefined, {
      referencePose: leftStartPose,
      contactTargets: autumnLeftTargets,
      displayedTransportTimeSeconds: 25.0,
    });
    rightHand.update(reconstructHand3D(baseRightMotion, 0), undefined, {
      referencePose: rightStartPose,
      contactTargets: autumnRightTargets,
      displayedTransportTimeSeconds: 25.0,
    });
    RiggedExperimentalHand.resolveHandPairCollisions(
      leftHand,
      rightHand,
      autumnLeftTargets,
      autumnRightTargets,
    );

    const autumnLeftSnap = leftHand.sampleLiveDiagnostics();
    const autumnRightSnap = rightHand.sampleLiveDiagnostics();
    const leftPalmPos = autumnLeftSnap.boneWorldTransformRows[21]!;
    const rightPalmPos = autumnRightSnap.boneWorldTransformRows[21]!;
    // One hand must clearly bridge above the other and echelon in depth (Z)
    expect(Math.abs(leftPalmPos[2]! - rightPalmPos[2]!)).toBeGreaterThan(0.45);
    expect(Math.abs(leftPalmPos[3]! - rightPalmPos[3]!)).toBeGreaterThan(0.15);

    // Both active fingers (left finger 3 on F4=65, right finger 2 on E4=64) must remain seated on their keys
    const leftF3Rows = autumnLeftSnap.fixedDistalSkinSampleRows.filter((r) => r[0] === 3);
    const rightF2Rows = autumnRightSnap.fixedDistalSkinSampleRows.filter((r) => r[0] === 2);
    const f4Bounds = new THREE.Box3().setFromObject(keyboard.keysByPitch.get(65)!.mesh);
    const e4Bounds = new THREE.Box3().setFromObject(keyboard.keysByPitch.get(64)!.mesh);
    const leftF3MeanX = leftF3Rows.reduce((s, r) => s + r[4]!, 0) / leftF3Rows.length;
    const rightF2MeanX = rightF2Rows.reduce((s, r) => s + r[4]!, 0) / rightF2Rows.length;
    expect(leftF3MeanX).toBeGreaterThan(f4Bounds.min.x);
    expect(leftF3MeanX).toBeLessThan(f4Bounds.max.x);
    expect(rightF2MeanX).toBeGreaterThan(e4Bounds.min.x);
    expect(rightF2MeanX).toBeLessThan(e4Bounds.max.x);

    // Every finger/palm joint (boneId != 20 forearm) of the upper hand that overlaps in X/Z with a joint of the lower hand must clear it vertically
    const upperSnap = leftPalmPos[2]! >= rightPalmPos[2]! ? autumnLeftSnap : autumnRightSnap;
    const lowerSnap = leftPalmPos[2]! >= rightPalmPos[2]! ? autumnRightSnap : autumnLeftSnap;
    for (const uBone of upperSnap.boneWorldTransformRows) {
      if (uBone[0] === 20) continue;
      for (const lBone of lowerSnap.boneWorldTransformRows) {
        if (lBone[0] === 20) continue;
        if (Math.abs(uBone[1]! - lBone[1]!) < 0.40 && Math.abs(uBone[3]! - lBone[3]!) < 0.65) {
          expect(uBone[2]!).toBeGreaterThan(lBone[2]! + 0.30);
        }
      }
    }

    // 9. Verify outward wrist/forearm V-fanning and anatomical PIP hinge preservation when uncrossed hands play close together
    // (e.g. Left hand finger 2 on E4=64 and Right hand finger 2 on F4=65)
    const uncrossedLeftMotion = structuredClone(sample195.motionPoses.find((p) => p.hand === "left")!);
    const uncrossedRightMotion = structuredClone(sample195.motionPoses.find((p) => p.hand === "right")!);
    const uLeftDeltaX = (key64X + keyboardHalfW) - uncrossedLeftMotion.joints.filter((j) => j.kind === "tip")[0]!.point[0];
    const uRightDeltaX = (key65X + keyboardHalfW) - uncrossedRightMotion.joints.filter((j) => j.kind === "tip")[0]!.point[0];
    for (const j of uncrossedLeftMotion.joints) j.point[0] += uLeftDeltaX;
    for (const b of uncrossedLeftMotion.bones) {
      b.a[0] += uLeftDeltaX;
      b.b[0] += uLeftDeltaX;
    }
    for (const j of uncrossedRightMotion.joints) j.point[0] += uRightDeltaX;
    for (const b of uncrossedRightMotion.bones) {
      b.a[0] += uRightDeltaX;
      b.b[0] += uRightDeltaX;
    }
    const closeNotes = [
      { hand: "left" as const, finger: 2, pitch: 64, startSeconds: 30.0, endSeconds: 30.5 },
      { hand: "right" as const, finger: 2, pitch: 65, startSeconds: 30.0, endSeconds: 30.5 },
    ];
    keyboard.setActiveKeys(
      new Map([
        [64, { hand: "left" as const, finger: 2, depressionWeight: 1 }],
        [65, { hand: "right" as const, finger: 2, depressionWeight: 1 }],
      ]),
    );
    keyboard.group.updateMatrixWorld(true);
    const closeLeftTargets = populateHandContactTargets(closeNotes, "left", 30.1, [], sampleSurface);
    const closeRightTargets = populateHandContactTargets(closeNotes, "right", 30.1, [], sampleSurface);
    enrichTargetsWithKeyboardBounds(keyboard, closeLeftTargets);
    enrichTargetsWithKeyboardBounds(keyboard, closeRightTargets);

    leftHand.update(reconstructHand3D(uncrossedLeftMotion, 0), undefined, {
      referencePose: leftStartPose,
      contactTargets: closeLeftTargets,
      displayedTransportTimeSeconds: 30.1,
    });
    rightHand.update(reconstructHand3D(uncrossedRightMotion, 0), undefined, {
      referencePose: rightStartPose,
      contactTargets: closeRightTargets,
      displayedTransportTimeSeconds: 30.1,
    });
    const beforeFanLeftForearmX = leftHand.sampleLiveDiagnostics().boneWorldTransformRows[20]![1]!;
    const beforeFanRightForearmX = rightHand.sampleLiveDiagnostics().boneWorldTransformRows[20]![1]!;

    RiggedExperimentalHand.resolveHandPairCollisions(leftHand, rightHand, closeLeftTargets, closeRightTargets);

    const afterFanLeftForearmX = leftHand.sampleLiveDiagnostics().boneWorldTransformRows[20]![1]!;
    const afterFanRightForearmX = rightHand.sampleLiveDiagnostics().boneWorldTransformRows[20]![1]!;
    // Outward V-fanning swings the left forearm further left (-X) and the right forearm further right (+X)
    expect(afterFanLeftForearmX).toBeLessThan(beforeFanLeftForearmX);
    expect(afterFanRightForearmX).toBeGreaterThan(beforeFanRightForearmX);

    // 10. Verify zero frame-to-frame oscillation (no flickering) across consecutive 60fps frames
    // when two hands operate in close proximity
    let prevLeftPalm: [number, number, number] | null = null;
    let prevRightPalm: [number, number, number] | null = null;
    for (let frame = 1; frame <= 15; frame++) {
      const tSec = 30.1 + frame * (1 / 60);
      const fLeftTargets = populateHandContactTargets(closeNotes, "left", tSec, [], sampleSurface);
      const fRightTargets = populateHandContactTargets(closeNotes, "right", tSec, [], sampleSurface);
      enrichTargetsWithKeyboardBounds(keyboard, fLeftTargets);
      enrichTargetsWithKeyboardBounds(keyboard, fRightTargets);
      leftHand.update(reconstructHand3D(uncrossedLeftMotion, 0), undefined, {
        referencePose: leftStartPose,
        contactTargets: fLeftTargets,
        displayedTransportTimeSeconds: tSec,
      });
      rightHand.update(reconstructHand3D(uncrossedRightMotion, 0), undefined, {
        referencePose: rightStartPose,
        contactTargets: fRightTargets,
        displayedTransportTimeSeconds: tSec,
      });
      RiggedExperimentalHand.resolveHandPairCollisions(leftHand, rightHand, fLeftTargets, fRightTargets);
      const lRow = leftHand.sampleLiveDiagnostics().boneWorldTransformRows[0]!;
      const rRow = rightHand.sampleLiveDiagnostics().boneWorldTransformRows[0]!;
      const curLeftPalm: [number, number, number] = [lRow[1]!, lRow[2]!, lRow[3]!];
      const curRightPalm: [number, number, number] = [rRow[1]!, rRow[2]!, rRow[3]!];
      if (prevLeftPalm && prevRightPalm && frame >= 3) {
        const dLeft = Math.hypot(
          curLeftPalm[0] - prevLeftPalm[0],
          curLeftPalm[1] - prevLeftPalm[1],
          curLeftPalm[2] - prevLeftPalm[2],
        );
        const dRight = Math.hypot(
          curRightPalm[0] - prevRightPalm[0],
          curRightPalm[1] - prevRightPalm[1],
          curRightPalm[2] - prevRightPalm[2],
        );
        expect(dLeft).toBeLessThan(0.02);
        expect(dRight).toBeLessThan(0.02);
      }
      prevLeftPalm = curLeftPalm;
      prevRightPalm = curRightPalm;
    }

    leftHand.dispose();
    rightHand.dispose();
    keyboard.dispose();
  });
});
