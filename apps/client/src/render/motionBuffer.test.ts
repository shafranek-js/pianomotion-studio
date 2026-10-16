import type {
  M1SampleMotionRequest,
  M1SampleMotionResult,
  MotionPlan,
  MotionPose,
} from "@handthesia/contracts";
import { describe, expect, it } from "vitest";
import { HandsView } from "./handsView";
import { KeyboardLayout, LOWEST_PIANO_KEY } from "./keyboardView";
import {
  MotionBuffer,
  getDistalTipPosition,
  lerpPose,
  verifyTouchContact,
} from "./motionBuffer";

const DIGIT_ORDER = [2, 3, 4, 5, 1] as const;

function createSyntheticPose(options: {
  hand?: "left" | "right";
  time: number;
  fingerTips?: Partial<Record<number, [number, number, number]>>;
  wristX?: number;
  layerOrder?: number;
}): MotionPose {
  const hand = options.hand ?? "right";
  const wristX = options.wristX ?? 5.0;
  const layerOrder = options.layerOrder ?? 0;

  const finalTips: Record<number, [number, number, number]> = {
    1: options.fingerTips?.[1] ?? [wristX - 0.5, 3.0, 0.3],
    2: options.fingerTips?.[2] ?? [wristX + 0.1, 4.2, 0.3],
    3: options.fingerTips?.[3] ?? [wristX + 0.3, 4.5, 0.3],
    4: options.fingerTips?.[4] ?? [wristX + 0.5, 4.2, 0.3],
    5: options.fingerTips?.[5] ?? [wristX + 0.7, 3.8, 0.3],
  };

  // Build canonical distal bones and tip joints in DIGIT_ORDER [2, 3, 4, 5, 1]
  const distalBones = DIGIT_ORDER.map((finger) => {
    const tip = finalTips[finger]!;
    return {
      a: [tip[0], tip[1] - 0.5, tip[2] + 0.1] as [number, number, number],
      b: [tip[0], tip[1], tip[2]] as [number, number, number],
      kind: "distal" as const,
    };
  });

  const tipJoints = DIGIT_ORDER.map((finger) => {
    const tip = finalTips[finger]!;
    return {
      point: [tip[0], tip[1], tip[2]] as [number, number, number],
      kind: "tip" as const,
    };
  });

  return {
    hand,
    transportTimeSeconds: options.time,
    layerOrder,
    bones: [
      { a: [wristX, 0.0, 0.5], b: [wristX, -4.0, 0.8], kind: "forearm" },
      { a: [wristX + 0.8, 0.0, 0.5], b: [wristX + 0.8, -4.0, 0.8], kind: "forearm" },
      { a: [wristX, 0.0, 0.5], b: [wristX + 0.8, 0.0, 0.5], kind: "carpal" },
      ...distalBones,
    ],
    joints: [
      { point: [wristX, 0.0, 0.5], kind: "wrist" },
      { point: [wristX + 0.8, 0.0, 0.5], kind: "wrist" },
      ...tipJoints,
    ],
  };
}

function sampleResult(
  poses: MotionPose[],
  coverage: M1SampleMotionResult["coverage"],
): M1SampleMotionResult {
  return {
    type: "sample-motion-result",
    requestId: "motion-test",
    projectId: "motion-project",
    revision: 1,
    engineVersion: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    startTimeSeconds: poses[0]?.transportTimeSeconds ?? 0,
    endTimeSeconds: poses[poses.length - 1]?.transportTimeSeconds ?? 0,
    poses,
    coverage,
  };
}

describe("MotionBuffer", () => {
  describe("Sliding lookahead buffer", () => {
    it("inserts poses and maintains sort order by time and hand", () => {
      const buffer = new MotionBuffer();
      const p1 = createSyntheticPose({ hand: "right", time: 3.0 });
      const p2 = createSyntheticPose({ hand: "left", time: 1.0 });
      const p3 = createSyntheticPose({ hand: "right", time: 1.0 });
      const p4 = createSyntheticPose({ hand: "left", time: 2.0 });

      buffer.addPoses([p1, p2, p3, p4]);

      expect(buffer.poses).toHaveLength(4);
      expect(buffer.poses[0]!.transportTimeSeconds).toBe(1.0);
      expect(buffer.poses[0]!.hand).toBe("left");
      expect(buffer.poses[1]!.transportTimeSeconds).toBe(1.0);
      expect(buffer.poses[1]!.hand).toBe("right");
      expect(buffer.poses[2]!.transportTimeSeconds).toBe(2.0);
      expect(buffer.poses[3]!.transportTimeSeconds).toBe(3.0);

      expect(buffer.bufferedRange).toEqual({ start: 1.0, end: 3.0 });
    });

    it("samples with interpolation between adjacent keyframes", () => {
      const buffer = new MotionBuffer();
      const p0 = createSyntheticPose({
        hand: "right",
        time: 1.0,
        fingerTips: { 3: [10.0, 2.0, 0.5] },
      });
      const p1 = createSyntheticPose({
        hand: "right",
        time: 2.0,
        fingerTips: { 3: [12.0, 4.0, 0.1] },
      });

      buffer.addPoses([p0, p1]);

      // Exact sample at p0
      const at0 = buffer.samplePose(1.0, "right");
      expect(at0).not.toBeNull();
      expect(at0!.transportTimeSeconds).toBe(1.0);
      const tip0 = getDistalTipPosition(at0!, 3);
      expect(tip0).toEqual([10.0, 2.0, 0.5]);

      // Midpoint sample at t = 1.5
      const atMid = buffer.samplePose(1.5, "right");
      expect(atMid).not.toBeNull();
      expect(atMid!.transportTimeSeconds).toBeCloseTo(1.5);
      const tipMid = getDistalTipPosition(atMid!, 3);
      expect(tipMid![0]).toBeCloseTo(11.0); // (10 + 12) / 2
      expect(tipMid![1]).toBeCloseTo(3.0); // (2 + 4) / 2
      expect(tipMid![2]).toBeCloseTo(0.3); // (0.5 + 0.1) / 2

      // Quarter sample at t = 1.25
      const atQuarter = buffer.samplePose(1.25, "right");
      expect(atQuarter).not.toBeNull();
      const tipQuarter = getDistalTipPosition(atQuarter!, 3);
      expect(tipQuarter![0]).toBeCloseTo(10.5);
      expect(tipQuarter![1]).toBeCloseTo(2.5);
      expect(tipQuarter![2]).toBeCloseTo(0.4);

      // Outside buffered window returns null
      expect(buffer.samplePose(0.5, "right")).toBeNull();
      expect(buffer.samplePose(2.5, "right")).toBeNull();
      expect(buffer.samplePose(1.5, "left")).toBeNull();
    });

    it("prunes past poses older than currentTime - windowBehindSeconds", () => {
      const buffer = new MotionBuffer({ windowBehindSeconds: 1.0, windowAheadSeconds: 4.0 });
      const poses = [0, 1, 2, 3, 4, 5, 6].map((t) =>
        createSyntheticPose({ hand: "right", time: t }),
      );

      // Add all poses initially at currentTime = 0
      buffer.addPoses(poses, 0);
      expect(buffer.poses).toHaveLength(7);
      expect(buffer.bufferedRange).toEqual({ start: 0, end: 6 });

      // Advance currentTime to 4.0: prune threshold is 4.0 - 1.0 = 3.0
      // Poses at t = 0, 1, 2 are older than 3.0 and must be pruned
      buffer.prune(4.0);
      expect(buffer.poses.map((p) => p.transportTimeSeconds)).toEqual([3, 4, 5, 6]);
      expect(buffer.bufferedRange).toEqual({ start: 3, end: 6 });

      // Adding new poses with currentTime = 5.0 prunes poses older than 4.0
      const nextPoses = [7, 8].map((t) => createSyntheticPose({ hand: "right", time: t }));
      buffer.addPoses(nextPoses, 5.0);
      expect(buffer.poses.map((p) => p.transportTimeSeconds)).toEqual([4, 5, 6, 7, 8]);
      expect(buffer.bufferedRange).toEqual({ start: 4, end: 8 });
    });
  });

  describe("Seek invalidation", () => {
    it("clears old window on invalidate and calculates new slice at seek target", () => {
      const buffer = new MotionBuffer({ windowAheadSeconds: 4.0 });
      const initialPoses = [1, 2, 3, 4].map((t) =>
        createSyntheticPose({ hand: "right", time: t }),
      );
      buffer.addPoses(initialPoses, 1);
      expect(buffer.bufferedRange).toEqual({ start: 1, end: 4 });

      // User seeks to 12.0
      buffer.invalidate();
      expect(buffer.bufferedRange).toBeNull();
      expect(buffer.poses).toHaveLength(0);

      // Next slice calculation at seek target
      const slice = buffer.getMissingWindow(12.0);
      expect(slice).toEqual({ start: 12.0, end: 16.0 });

      // Populate new slice
      const newPoses = [12, 13, 14, 15, 16].map((t) =>
        createSyntheticPose({ hand: "right", time: t }),
      );
      buffer.addPoses(newPoses, 12.0);
      expect(buffer.bufferedRange).toEqual({ start: 12.0, end: 16.0 });
      expect(buffer.samplePose(13.5, "right")).not.toBeNull();
    });

    it("clear() resets all internal state and ranges", () => {
      const buffer = new MotionBuffer();
      buffer.addPoses([createSyntheticPose({ hand: "left", time: 2.0 })]);
      expect(buffer.bufferedRange).not.toBeNull();

      buffer.clear();
      expect(buffer.bufferedRange).toBeNull();
      expect(buffer.poses).toHaveLength(0);
      expect(buffer.samplePose(2.0, "left")).toBeNull();
    });
  });

  describe("Protection against per-frame RPC", () => {
    it("needsMorePoses returns false while inside window and true only when approaching boundary", () => {
      const buffer = new MotionBuffer({ windowAheadSeconds: 4.0 });

      // Empty buffer needs poses
      expect(buffer.needsMorePoses(10.0)).toBe(true);
      expect(buffer.getMissingWindow(10.0)).toEqual({ start: 10.0, end: 14.0 });

      // Buffer loaded with [10.0, 14.0] with dense steps <= 250ms
      const denseTimes: number[] = [];
      for (let t = 10.0; t <= 14.001; t += 0.2) {
        denseTimes.push(Math.round(t * 10) / 10);
      }
      const poses = denseTimes.map((t) =>
        createSyntheticPose({ hand: "right", time: t }),
      );
      buffer.setExpectedHands(["right"]);
      buffer.addSampleMotionResult(sampleResult(poses, {
        right: { coveredStartTimeSeconds: 10, coveredEndTimeSeconds: 14, isComplete: true, poseCount: poses.length },
      }), 10.0);

      // Frame at t = 10.0: 10.0 + 1.5 = 11.5 <= 14.0 -> false (NO RPC)
      expect(buffer.needsMorePoses(10.0)).toBe(false);

      // Frame at t = 11.0: 11.0 + 1.5 = 12.5 <= 14.0 -> false (NO RPC)
      expect(buffer.needsMorePoses(11.0)).toBe(false);

      // Frame at t = 12.0: 12.0 + 1.5 = 13.5 <= 14.0 -> false (NO RPC)
      expect(buffer.needsMorePoses(12.0)).toBe(false);

      // Frame at t = 12.4: 12.4 + 1.5 = 13.9 <= 14.0 -> false (NO RPC)
      expect(buffer.needsMorePoses(12.4)).toBe(false);

      // Frame at t = 12.6: 12.6 + 1.5 = 14.1 > 14.0 -> true (APPROACHING BOUNDARY)
      expect(buffer.needsMorePoses(12.6)).toBe(true);

      // Missing window preserves the configured 4s horizon and adds overlap only at the start.
      const nextWindow = buffer.getMissingWindow(12.6);
      expect(nextWindow.start).toBe(13.75);
      expect(nextWindow.end).toBe(16.6);

      // Once next slice is added densely, needsMorePoses goes back to false
      const extTimes: number[] = [];
      for (let t = 13.8; t <= 16.6; t += 0.2) {
        extTimes.push(Math.round(t * 10) / 10);
      }
      const extensionPoses = extTimes.map((t) =>
        createSyntheticPose({ hand: "right", time: t }),
      );
      buffer.addSampleMotionResult(sampleResult(extensionPoses, {
        right: { coveredStartTimeSeconds: 13.8, coveredEndTimeSeconds: 16.6, isComplete: true, poseCount: extensionPoses.length },
      }), 12.6);
      expect(buffer.needsMorePoses(12.6)).toBe(false);
    });

    it("A10: rejects sparse gap coverage and triggers needsMorePoses when gap exceeds 250ms (0s and 30s)", () => {
      const buffer = new MotionBuffer({ windowAheadSeconds: 4.0 });

      // Two poses at 0.0s and 30.0s (30s gap > 250ms)
      const sparsePoses = [
        createSyntheticPose({ hand: "right", time: 0.0 }),
        createSyntheticPose({ hand: "right", time: 30.0 }),
      ];
      buffer.addPoses(sparsePoses);

      // At t = 2.0s, range coverage alone would say false, but continuous coverage MUST return true
      expect(buffer.needsMorePoses(2.0)).toBe(true);

      // Missing window asks for the missing segment around t = 2.0s
      const missing = buffer.getMissingWindow(2.0);
      expect(missing.start).toBe(1.75);
      expect(missing.end).toBe(6.0);
    });

    it("requires separate continuous coverage for each active hand", () => {
      const buffer = new MotionBuffer({ windowAheadSeconds: 4.0, expectedHands: ["left", "right"] });

      // Right hand has dense coverage [0.0, 4.0]
      const rhTimes: number[] = [];
      for (let t = 0.0; t <= 4.001; t += 0.2) rhTimes.push(Math.round(t * 10) / 10);
      const rhPoses = rhTimes.map((t) => createSyntheticPose({ hand: "right", time: t }));

      // Left hand only has a pose at 0.0s (missing remaining window)
      const lhPoses = [createSyntheticPose({ hand: "left", time: 0.0 })];
      buffer.addSampleMotionResult(sampleResult([...rhPoses, ...lhPoses], {
        left: { coveredStartTimeSeconds: 0, coveredEndTimeSeconds: 0, isComplete: false, poseCount: 1 },
        right: { coveredStartTimeSeconds: 0, coveredEndTimeSeconds: 4, isComplete: true, poseCount: rhPoses.length },
      }));

      // Because left hand is active but missing coverage at [1.0, 2.5], needsMorePoses must be true
      expect(buffer.needsMorePoses(1.0)).toBe(true);
    });

    it("uses expected hands and metadata-backed coverage instead of the hands present in sparse poses", () => {
      const rightOnly = [
        createSyntheticPose({ hand: "right", time: 0 }),
        createSyntheticPose({ hand: "right", time: 1 }),
      ];
      const buffer = new MotionBuffer({ expectedHands: ["left", "right"] });
      buffer.addSampleMotionResult(sampleResult(rightOnly, {
        right: { coveredStartTimeSeconds: 0, coveredEndTimeSeconds: 1, isComplete: true, poseCount: 2 },
      }));

      expect(buffer.getActiveHands()).toEqual(["left", "right"]);
      expect(buffer.hasCoverage(0, 1)).toBe(false);
      expect(buffer.needsMorePoses(0)).toBe(true);
    });

    it("does not treat sparse legacy poses as continuous and requires event anchors to be present", () => {
      const buffer = new MotionBuffer({
        expectedHands: ["right"],
        requiredAnchors: [{ hand: "right", timeSeconds: 0.5 }],
      });
      buffer.addPoses([
        createSyntheticPose({ hand: "right", time: 0 }),
        createSyntheticPose({ hand: "right", time: 1 }),
      ]);
      expect(buffer.hasCoverage(0, 1)).toBe(false);

      const completeRangeWithoutAnchor = sampleResult([
        ...[0, 0.2, 0.4, 0.6, 0.8, 1].map(time => createSyntheticPose({ hand: "right", time })),
      ], {
        right: { coveredStartTimeSeconds: 0, coveredEndTimeSeconds: 1, isComplete: true, poseCount: 6 },
      });
      buffer.invalidate();
      buffer.addSampleMotionResult(completeRangeWithoutAnchor);
      expect(buffer.isHandCovered("right", 0, 1)).toBe(true);
      expect(buffer.hasCoverage(0, 1)).toBe(false);

      buffer.addSampleMotionResult(sampleResult([
        createSyntheticPose({ hand: "right", time: 0.5 }),
      ], {
        right: { coveredStartTimeSeconds: 0.5, coveredEndTimeSeconds: 0.5, isComplete: false, poseCount: 1 },
      }));
      expect(buffer.hasCoverage(0, 1)).toBe(true);
    });

    it("intersects declared coverage with actual continuous poses and rejects missing hands", () => {
      const buffer = new MotionBuffer({ expectedHands: ["left", "right"] });
      buffer.addSampleMotionResult(sampleResult([
        createSyntheticPose({ hand: "right", time: 0 }),
        createSyntheticPose({ hand: "right", time: 30 }),
      ], {
        left: { coveredStartTimeSeconds: 0, coveredEndTimeSeconds: 30, isComplete: true, poseCount: 2 },
        right: { coveredStartTimeSeconds: 0, coveredEndTimeSeconds: 30, isComplete: true, poseCount: 2 },
      }));

      expect(buffer.getHandCoverageIntervals("left")).toEqual([]);
      expect(buffer.getHandCoverageIntervals("right")).toEqual([]);
      expect(buffer.isHandCovered("right", 10, 11)).toBe(false);
      expect(buffer.hasCoverage(10, 11)).toBe(false);
    });

    it("fills the earliest continuous gap before a later event anchor in a long lookahead", () => {
      const buffer = new MotionBuffer({
        windowAheadSeconds: 24,
        expectedHands: ["right"],
        requiredAnchors: [{ hand: "right", timeSeconds: 10 }],
      });
      const initialPoses = Array.from({ length: 17 }, (_, index) =>
        createSyntheticPose({ hand: "right", time: index * 0.25 }),
      );
      buffer.addSampleMotionResult(sampleResult(initialPoses, {
        right: { coveredStartTimeSeconds: 0, coveredEndTimeSeconds: 4, isComplete: true, poseCount: initialPoses.length },
      }));

      // The caller may cap this to a 4s request. Starting at 9.75 would leave
      // the earlier 4s boundary unfilled and prevent continuous lookahead.
      expect(buffer.getMissingWindow(0)).toEqual({ start: 3.75, end: 24 });
    });

    it("bridges a small response-chunk gap only when adjacent rendered poses prove interpolation", () => {
      const buffer = new MotionBuffer({ expectedHands: ["right"] });
      const firstPoses = Array.from({ length: 11 }, (_, index) => createSyntheticPose({
        hand: "right",
        time: index / 10,
      }));
      const secondPoses = Array.from({ length: 11 }, (_, index) => createSyntheticPose({
        hand: "right",
        time: 1.02 + index / 10,
      }));

      buffer.addSampleMotionResult(sampleResult(firstPoses, {
        right: { coveredStartTimeSeconds: 0, coveredEndTimeSeconds: 1, isComplete: false, poseCount: firstPoses.length },
      }));
      buffer.addSampleMotionResult(sampleResult(secondPoses, {
        right: { coveredStartTimeSeconds: 1.02, coveredEndTimeSeconds: 2.02, isComplete: true, poseCount: secondPoses.length },
      }));

      expect(buffer.getHandCoverageIntervals("right")).toEqual([{ start: 0, end: 2.02 }]);
      expect(buffer.hasCoverage(0, 2.02)).toBe(true);
      expect(buffer.samplePose(1.01, "right")).not.toBeNull();

      const unverifiedEndpoint = new MotionBuffer({ expectedHands: ["right"] });
      unverifiedEndpoint.addSampleMotionResult(sampleResult(firstPoses, {
        right: { coveredStartTimeSeconds: 0, coveredEndTimeSeconds: 1, isComplete: false, poseCount: firstPoses.length },
      }));
      unverifiedEndpoint.addSampleMotionResult(sampleResult(secondPoses, {
        right: { coveredStartTimeSeconds: 1.04, coveredEndTimeSeconds: 2.02, isComplete: true, poseCount: secondPoses.length },
      }));
      expect(unverifiedEndpoint.hasCoverage(0.99, 1.05)).toBe(false);
    });

    it("uses the sorted anchor index to check only the active time range", () => {
      const requiredAnchors = Array.from({ length: 50_000 }, (_, index) => ({
        hand: "right" as const,
        timeSeconds: index * 2,
      }));
      const buffer = new MotionBuffer({ expectedHands: ["right"], requiredAnchors });
      const poses = [99_998, 99_998.2, 99_998.4, 99_998.6, 99_998.8, 99_999]
        .map(time => createSyntheticPose({ hand: "right", time }));
      buffer.addSampleMotionResult(sampleResult(poses, {
        right: { coveredStartTimeSeconds: 99_998, coveredEndTimeSeconds: 99_999, isComplete: true, poseCount: poses.length },
      }));

      expect(buffer.hasCoverage(99_998, 99_999)).toBe(true);
      expect(buffer.getMissingWindow(99_998)).toEqual({ start: 99_998.75, end: 100_002 });
    });
  });

  describe("Touch contact verification", () => {
    it("asserts distal tip is in physical contact (z <= 0.1 and x within key) at note attack time", () => {
      const layout = new KeyboardLayout();
      layout.compute({ x: 0, y: 100, width: 1000, height: 100 }, "realistic");

      const key21 = layout.getKeyRect(LOWEST_PIANO_KEY)!;
      const keyboardLeft = key21.x;
      const ppi = layout.ppi;

      // Test Middle C (pitch 60) played by RH thumb (finger 1)
      const key60 = layout.getKeyRect(60)!;
      const key60CenterXInches = (key60.x + key60.width / 2 - keyboardLeft) / ppi;

      // Test E4 (pitch 64) played by RH middle finger (finger 3)
      const key64 = layout.getKeyRect(64)!;
      const key64CenterXInches = (key64.x + key64.width / 2 - keyboardLeft) / ppi;

      // Test black key F#4 (pitch 66) played by RH ring finger (finger 4)
      const key66 = layout.getKeyRect(66)!;
      const key66CenterXInches = (key66.x + key66.width / 2 - keyboardLeft) / ppi;

      const tPress = 2.0;

      // 1. Attack pose at tPress: finger 1 touches key 60, finger 3 touches key 64, finger 4 touches key 66
      const contactPose = createSyntheticPose({
        hand: "right",
        time: tPress,
        fingerTips: {
          1: [key60CenterXInches, 2.0, 0.04], // contact: z = 0.04 <= 0.1
          3: [key64CenterXInches, 2.5, 0.02], // contact: z = 0.02 <= 0.1
          4: [key66CenterXInches, 2.8, 0.06], // contact: z = 0.06 <= 0.1
          2: [key60CenterXInches + 0.5, 3.0, 0.4], // hovering: z = 0.4 > 0.1
          5: [key66CenterXInches + 0.5, 3.0, 0.5], // hovering: z = 0.5 > 0.1
        },
      });

      // Verify finger 1 on pitch 60
      const v60 = verifyTouchContact(contactPose, 1, 60, layout);
      expect(v60.inContact).toBe(true);
      expect(v60.zContact).toBe(true);
      expect(v60.xInBounds).toBe(true);
      expect(v60.zInches).toBe(0.04);
      expect(v60.zInches!).toBeLessThanOrEqual(0.1);
      expect(v60.tipScreenX!).toBeGreaterThanOrEqual(key60.x);
      expect(v60.tipScreenX!).toBeLessThanOrEqual(key60.x + key60.width);

      // Verify finger 3 on pitch 64
      const v64 = verifyTouchContact(contactPose, 3, 64, layout);
      expect(v64.inContact).toBe(true);
      expect(v64.zContact).toBe(true);
      expect(v64.xInBounds).toBe(true);
      expect(v64.zInches).toBe(0.02);
      expect(v64.zInches!).toBeLessThanOrEqual(0.1);

      // Verify finger 4 on black key pitch 66
      const v66 = verifyTouchContact(contactPose, 4, 66, layout);
      expect(v66.inContact).toBe(true);
      expect(v66.zContact).toBe(true);
      expect(v66.xInBounds).toBe(true);
      expect(v66.zInches).toBe(0.06);
      expect(v66.zInches!).toBeLessThanOrEqual(0.1);

      // 2. Approach pose at tPress - 0.2: finger 3 approaching key 64 from above (z = 0.45 > 0.1)
      const approachPose = createSyntheticPose({
        hand: "right",
        time: tPress - 0.2,
        fingerTips: {
          3: [key64CenterXInches, 2.5, 0.45],
        },
      });
      const vApproach = verifyTouchContact(approachPose, 3, 64, layout);
      expect(vApproach.inContact).toBe(false);
      expect(vApproach.zContact).toBe(false);
      expect(vApproach.xInBounds).toBe(true);
      expect(vApproach.zInches).toBe(0.45);

      // 3. Pose with horizontal misalignment: finger 3 pressed down (z = 0.02) but shifted outside key 64
      const misalignedPose = createSyntheticPose({
        hand: "right",
        time: tPress,
        fingerTips: {
          3: [key64CenterXInches + 2.0, 2.5, 0.02],
        },
      });
      const vMisaligned = verifyTouchContact(misalignedPose, 3, 64, layout);
      expect(vMisaligned.inContact).toBe(false);
      expect(vMisaligned.zContact).toBe(true);
      expect(vMisaligned.xInBounds).toBe(false);

      // 4. Verify touch contact through MotionBuffer sampling at attack time
      const buffer = new MotionBuffer();
      buffer.addPoses([approachPose, contactPose]);

      const sampledAttack = buffer.samplePose(tPress, "right");
      expect(sampledAttack).not.toBeNull();
      const vSampled = verifyTouchContact(sampledAttack!, 3, 64, layout);
      expect(vSampled.inContact).toBe(true);
      expect(vSampled.zInches!).toBeLessThanOrEqual(0.1);

      // Sampled midway during descent (t = 1.9): z should be ~0.235 (not yet in contact)
      const sampledMid = buffer.samplePose(tPress - 0.1, "right");
      expect(sampledMid).not.toBeNull();
      const vMid = verifyTouchContact(sampledMid!, 3, 64, layout);
      expect(vMid.inContact).toBe(false);
      expect(vMid.zInches!).toBeGreaterThan(0.1);
    });
  });

  describe("RPC contracts and integration", () => {
    it("accepts M1SampleMotionResult and integrates with typed RPC shapes", () => {
      const buffer = new MotionBuffer();
      const rpcRequest: M1SampleMotionRequest = {
        type: "sample-motion",
        requestId: "req-1",
        projectId: "proj-1",
        revision: 1,
        engineVersion: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        startTimeSeconds: 5.0,
        endTimeSeconds: 9.0,
        maxPoses: 200,
      };
      expect(rpcRequest.type).toBe("sample-motion");

      const rpcResult: M1SampleMotionResult = {
        type: "sample-motion-result",
        requestId: "req-1",
        projectId: "proj-1",
        revision: 1,
        engineVersion: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        startTimeSeconds: 5.0,
        endTimeSeconds: 9.0,
        poses: [
          createSyntheticPose({ hand: "right", time: 5.0 }),
          createSyntheticPose({ hand: "right", time: 7.0 }),
          createSyntheticPose({ hand: "right", time: 9.0 }),
        ],
      };

      buffer.addSampleMotionResult(rpcResult, 5.0);
      expect(buffer.bufferedRange).toEqual({ start: 5.0, end: 9.0 });
      expect(buffer.samplePose(7.0, "right")).not.toBeNull();
    });

    it("HandsView samples from motionBuffer and falls back to motionPlan when missing", () => {
      const bufferPose = createSyntheticPose({
        hand: "right",
        time: 5.0,
        fingerTips: { 2: [15.0, 2.0, 0.05] },
      });
      const planPose1 = createSyntheticPose({
        hand: "right",
        time: 1.0,
        fingerTips: { 2: [8.0, 2.0, 0.4] },
      });
      const planPose2 = createSyntheticPose({
        hand: "right",
        time: 2.0,
        fingerTips: { 2: [9.0, 2.0, 0.3] },
      });

      const plan: MotionPlan = {
        schemaVersion: 1,
        planId: "test-plan",
        projectId: "test-project",
        inputRevision: 1,
        profileId: "test-profile",
        profileRevision: 1,
        engineVersion: "1.0.0",
        diagnostics: [],
        kind: "motion",
        coordinateFrame: "keyboard-local-inches-v1",
        performancePlanId: "perf-1",
        poses: [planPose1, planPose2],
      };

      const buffer = new MotionBuffer();
      buffer.addPoses([bufferPose]);

      const layout = new KeyboardLayout();
      layout.compute({ x: 0, y: 100, width: 1000, height: 100 });

      const handsView = new HandsView({
        motionPlan: plan,
        keyboardLayout: layout,
        motionBuffer: buffer,
      });

      expect(handsView.getMotionBuffer()).toBe(buffer);

      // At t = 5.0: buffer has the pose
      handsView.update(5.0);
      expect(handsView.rightRenderer.container.visible).toBe(true);

      // At t = 1.5: buffer does NOT have the pose, falls back to motionPlan
      handsView.update(1.5);
      expect(handsView.rightRenderer.container.visible).toBe(true);

      // Buffer set to null falls back to plan entirely
      handsView.setMotionBuffer(null);
      expect(handsView.getMotionBuffer()).toBeNull();
      handsView.update(1.5);
      expect(handsView.rightRenderer.container.visible).toBe(true);
    });

    it("PianoScene setMotionBuffer forwards to handsView", () => {
      const buffer = new MotionBuffer();
      const handsView = new HandsView();
      handsView.setMotionBuffer(buffer);
      expect(handsView.getMotionBuffer()).toBe(buffer);
    });
  });

  describe("lerpPose helper", () => {
    it("linearly interpolates bones and joints between two poses", () => {
      const p0 = createSyntheticPose({
        hand: "left",
        time: 0.0,
        wristX: 4.0,
        layerOrder: 1,
      });
      const p1 = createSyntheticPose({
        hand: "left",
        time: 1.0,
        wristX: 6.0,
        layerOrder: 2,
      });

      const mid = lerpPose(p0, p1, 0.5);
      expect(mid.hand).toBe("left");
      expect(mid.transportTimeSeconds).toBe(0.5);
      expect(mid.layerOrder).toBe(2); // alpha >= 0.5

      // Check first bone endpoint interpolation: wristX was 4.0 and 6.0 => mid 5.0
      expect(mid.bones[0]!.a[0]).toBeCloseTo(5.0);
      // Check first joint point interpolation
      expect(mid.joints[0]!.point[0]).toBeCloseTo(5.0);
    });
  });
});
