// @ts-expect-error Vitest runs this fixture test in Node; browser source compilation omits Node types.
import { readFileSync } from "node:fs";
import type { M1AnalyzeMidiResult, MotionPose } from "@handthesia/contracts";
import { analyze_midi, sample_motion_window, _engine_version } from "@handthesia/engine-ts";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../profiles/defaultProfiles";
import { MotionBuffer, describeMotionPoseSample, lerpPose } from "./motionBuffer";

const HN_RELEASE = "habanera-from-carmen/instrument-0/note-000195";
const HN_NEXT_RELEASE = "habanera-from-carmen/instrument-0/note-000196";
const RELEASE_TIME = 80.94912664;
const LEGACY_BEFORE_TIME = 80.933333;
const LEGACY_AFTER_TIME = 80.966667;
const COMPARE_TIME = 80.95;
const KEYBOARD_RECT: [number, number, number, number] = [0, 0, 1400, 150];

function maxPoseCoordinateDelta(a: MotionPose, b: MotionPose): number {
  let maximum = 0;
  for (let index = 0; index < a.bones.length; index += 1) {
    for (const endpoint of ["a", "b"] as const) {
      for (let axis = 0; axis < 3; axis += 1) {
        maximum = Math.max(maximum, Math.abs(a.bones[index]![endpoint][axis]! - b.bones[index]![endpoint][axis]!));
      }
    }
  }
  for (let index = 0; index < a.joints.length; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      maximum = Math.max(maximum, Math.abs(a.joints[index]!.point[axis]! - b.joints[index]!.point[axis]!));
    }
  }
  return maximum;
}

describe("MotionBuffer release-event interpolation", () => {
  it("uses streamed release samples across playback and seek windows instead of the 30 Hz cross-event bracket", async () => {
    const identity = {
      fixtureId: "habanera-from-carmen",
      projectId: "motion-buffer-release-regression",
      revision: 1,
      requestId: "motion-buffer-release-analysis",
      engineVersion: _engine_version(),
      keyStyle: "realistic" as const,
      keyboardRect: KEYBOARD_RECT,
      profile: structuredClone(DEFAULT_PROFILE),
    };
    const midi = new Uint8Array(readFileSync(new URL("../../../../builtin_melodies/midi/Habanera from Carmen.mid", import.meta.url)));
    const analysis = analyze_midi(midi, identity) as M1AnalyzeMidiResult;
    expect(analysis.status).toBe("loaded");
    expect(analysis.document).not.toBeNull();
    expect(analysis.fingeringPlan).not.toBeNull();
    expect(analysis.performancePlan).not.toBeNull();
    expect(analysis.motionPlan).not.toBeNull();

    const note = analysis.document!.notes.find((candidate) => candidate.noteId === HN_RELEASE)!;
    const assignment = analysis.fingeringPlan!.assignments.find((candidate) => candidate.noteId === HN_RELEASE)!;
    expect({ hand: note.hand, finger: assignment.finger }).toEqual({ hand: "right", finger: 5 });
    const release = analysis.performancePlan!.events.find(
      (event) => event.type === "release" && event.noteId === HN_RELEASE,
    )!;
    const nextRelease = analysis.performancePlan!.events.find(
      (event) => event.type === "release" && event.noteId === HN_NEXT_RELEASE,
    )!;
    expect(release.timeSeconds).toBe(RELEASE_TIME);
    expect(nextRelease.timeSeconds).toBe(80.95525893);

    const handByNote = new Map(analysis.fingeringPlan!.assignments.map((entry) => [entry.noteId, entry.hand]));
    const requiredAnchors = analysis.performancePlan!.events.flatMap((event) => {
      if (event.type === "pedal") return [];
      const hand = handByNote.get(event.noteId);
      return hand === "left" || hand === "right" ? [{ hand, timeSeconds: event.timeSeconds }] : [];
    });
    const expectedHands = [...new Set(requiredAnchors.map((anchor) => anchor.hand))];
    const makeBuffer = () => new MotionBuffer({
      windowAheadSeconds: 24,
      windowBehindSeconds: 15,
      expectedHands,
      requiredAnchors,
    });
    const makePlaybackWindow = (buffer: MotionBuffer, currentTime: number) => {
      const missing = buffer.getMissingWindow(currentTime);
      const startTimeSeconds = Math.max(0, missing.start);
      const endTimeSeconds = Math.min(
        analysis.document!.durationSeconds,
        missing.end,
        startTimeSeconds + 4,
      );
      const result = sample_motion_window(null, null, null, startTimeSeconds, endTimeSeconds, {
        ...identity,
        requestId: `motion-buffer-release-window-${currentTime}`,
        maxPoses: 200,
      });
      return { startTimeSeconds, endTimeSeconds, result };
    };
    const directPoseAt = (timeSeconds: number): MotionPose => {
      const result = sample_motion_window(null, null, null, timeSeconds, timeSeconds + 0.001, {
        ...identity,
        requestId: `motion-buffer-release-direct-${timeSeconds}`,
        maxPoses: 2,
      });
      const pose = result.poses.find((candidate: MotionPose) => candidate.hand === "right");
      if (!pose) throw new Error(`Missing direct right MotionPose at ${timeSeconds}s.`);
      return pose as MotionPose;
    };

    const playbackBuffer = makeBuffer();
    playbackBuffer.addPoses(analysis.motionPlan!.poses);
    expect(playbackBuffer.hasCoverage(78, 78.1)).toBe(false);
    const uncoveredFallback = playbackBuffer.samplePoseClamped(COMPARE_TIME, "right");
    expect(uncoveredFallback).not.toBeNull();

    const playback = makePlaybackWindow(playbackBuffer, 78);
    expect(playback.startTimeSeconds).toBe(77.75);
    expect(playback.endTimeSeconds).toBe(81.75);
    playbackBuffer.addSampleMotionResult(playback.result, 78);
    expect(playbackBuffer.hasCoverage(78, 81)).toBe(true);

    const streamedRightPoses: MotionPose[] = playback.result.poses.filter(
      (pose: MotionPose) => pose.hand === "right",
    );
    expect(streamedRightPoses.some((pose) => pose.transportTimeSeconds === RELEASE_TIME)).toBe(true);
    expect(streamedRightPoses.some((pose) => pose.transportTimeSeconds === 80.95525893)).toBe(true);
    expect(streamedRightPoses.some((pose) => pose.transportTimeSeconds === COMPARE_TIME)).toBe(false);
    expect(describeMotionPoseSample(streamedRightPoses, LEGACY_BEFORE_TIME)).toMatchObject({
      sampleMode: "interpolated",
      sourcePoseTimeStartSeconds: 80.75,
      sourcePoseTimeEndSeconds: RELEASE_TIME,
    });
    expect(describeMotionPoseSample(streamedRightPoses, RELEASE_TIME)).toMatchObject({
      sampleMode: "exact",
      sourcePoseTimeStartSeconds: RELEASE_TIME,
      sourcePoseTimeEndSeconds: RELEASE_TIME,
    });
    expect(describeMotionPoseSample(streamedRightPoses, COMPARE_TIME)).toMatchObject({
      sampleMode: "interpolated",
      sourcePoseTimeStartSeconds: RELEASE_TIME,
      sourcePoseTimeEndSeconds: 80.95525893,
    });
    expect(describeMotionPoseSample(streamedRightPoses, LEGACY_AFTER_TIME).sourcePoseTimeStartSeconds)
      .toBe(80.95525893);

    const legacyBefore = directPoseAt(LEGACY_BEFORE_TIME);
    const legacyAfter = directPoseAt(LEGACY_AFTER_TIME);
    const directAtComparison = directPoseAt(COMPARE_TIME);
    const directAtRelease = directPoseAt(RELEASE_TIME);
    const legacyLerp = lerpPose(
      legacyBefore,
      legacyAfter,
      (COMPARE_TIME - LEGACY_BEFORE_TIME) / (LEGACY_AFTER_TIME - LEGACY_BEFORE_TIME),
    );
    const streamedBefore = playbackBuffer.samplePose(LEGACY_BEFORE_TIME, "right");
    const streamedAtRelease = playbackBuffer.samplePose(RELEASE_TIME, "right");
    const streamedAtComparison = playbackBuffer.samplePose(COMPARE_TIME, "right");
    const streamedAfter = playbackBuffer.samplePose(LEGACY_AFTER_TIME, "right");
    expect(streamedBefore).not.toBeNull();
    expect(streamedAtRelease).not.toBeNull();
    expect(streamedAtComparison).not.toBeNull();
    expect(streamedAfter).not.toBeNull();
    const legacyError = maxPoseCoordinateDelta(legacyLerp, directAtComparison);
    const streamedError = maxPoseCoordinateDelta(streamedAtComparison!, directAtComparison);
    const streamedBeforeError = maxPoseCoordinateDelta(streamedBefore!, legacyBefore);
    const streamedReleaseError = maxPoseCoordinateDelta(streamedAtRelease!, directAtRelease);
    const streamedAfterError = maxPoseCoordinateDelta(streamedAfter!, legacyAfter);
    const uncoveredFallbackError = maxPoseCoordinateDelta(uncoveredFallback!, directAtComparison);
    expect(legacyError).toBeCloseTo(0.5934645, 6);
    expect(streamedError).toBeLessThan(legacyError);

    // Seek resets the runtime buffer; the first streaming request begins with
    // a 250 ms overlap, which places this event's 80.95 s timeline tick in the
    // same production engine request.
    const seekBuffer = makeBuffer();
    seekBuffer.addPoses(analysis.motionPlan!.poses);
    const seek = makePlaybackWindow(seekBuffer, COMPARE_TIME);
    expect(seek.startTimeSeconds).toBe(80.7);
    expect(seek.endTimeSeconds).toBe(84.7);
    seekBuffer.addSampleMotionResult(seek.result, COMPARE_TIME);
    const seekPose = seekBuffer.samplePose(COMPARE_TIME, "right");
    expect(seekPose).toEqual(directAtComparison);
    expect(describeMotionPoseSample(
      seek.result.poses.filter((pose: MotionPose) => pose.hand === "right"),
      COMPARE_TIME,
    )).toMatchObject({ sampleMode: "exact", sourcePoseTimeStartSeconds: COMPARE_TIME });

    // Sampling is transport-time based, so moving forward, then backward for
    // a seek/loop wrap, must return the same pose when the same window covers it.
    const forward = playbackBuffer.samplePose(LEGACY_AFTER_TIME, "right");
    const backward = playbackBuffer.samplePose(LEGACY_BEFORE_TIME, "right");
    const forwardAgain = playbackBuffer.samplePose(LEGACY_AFTER_TIME, "right");
    expect(backward).not.toBeNull();
    expect(forwardAgain).toEqual(forward);

    // @ts-expect-error This optional test diagnostic runs in Node; browser source compilation omits Node types.
    if (process.env.MOTION_BUFFER_RELEASE_DIAGNOSTICS === "1") {
      console.info("[MotionBuffer release evidence]", JSON.stringify({
        source: "Habanera engine-generated MotionPose with production sample_motion_window and MotionBuffer",
        targetNoteId: HN_RELEASE,
        performedReleaseSeconds: RELEASE_TIME,
        playbackRequest: {
          startTimeSeconds: playback.startTimeSeconds,
          endTimeSeconds: playback.endTimeSeconds,
          rightPoseTimesNearRelease: streamedRightPoses
            .map((pose) => pose.transportTimeSeconds)
            .filter((time) => time >= 80.7 && time <= 81.1),
          hasCoverageAtEvent: playbackBuffer.hasCoverage(78, 81),
          noCoverageFallbackPoseAvailable: uncoveredFallback !== null,
          noCoverageFallbackMaxDeltaInches: uncoveredFallbackError,
        },
        maxDeltaInchesAgainstDirectEngine: {
          legacy30HzCrossEventAt80_95: legacyError,
          streamedBeforeRelease: streamedBeforeError,
          streamedAtRelease: streamedReleaseError,
          streamedAt80_95: streamedError,
          streamedAfterRelease: streamedAfterError,
        },
        seekRequest: {
          startTimeSeconds: seek.startTimeSeconds,
          endTimeSeconds: seek.endTimeSeconds,
          directPoseAt80_95: seekPose?.transportTimeSeconds === COMPARE_TIME,
          coverageAt80_95: seekBuffer.hasCoverage(COMPARE_TIME, 81.05),
        },
        repeatedAfterBackwardSample: forwardAgain?.transportTimeSeconds === forward?.transportTimeSeconds,
      }));
    }
  }, 30_000);
});
