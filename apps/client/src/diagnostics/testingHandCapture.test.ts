import { afterEach, describe, expect, it, vi } from "vitest";
import { RIGGED_EXPERIMENTAL_HAND_CAPTURE_ENDPOINT, TESTING_HAND_CAPTURE_ENDPOINT, TestingHandCapture, saveFinalTestingHandSegment, saveTestingHandCapture, snapshotTestingPianistProfile, testingHandCapture, testingHandSegmentStatus } from "./testingHandCapture";
import { DEFAULT_PROFILE } from "../profiles/defaultProfiles";

function riggedSample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    displayedTransportTimeSeconds: -2,
    sourcePoseTimeSeconds: 0,
    sampleReason: "periodic",
    sampling: {
      samplingCounter: 1,
      coverage: { source: "verified-motion-buffer", intervals: [{ start: 0, end: 5 }], requestedTimeCovered: false },
      motionPlanIdentity: { planId: "plan-a", inputRevision: 4, profileId: "profile-a", profileRevision: 2, engineVersion: "engine-a" },
    },
    profileIdentity: { profileId: "profile-a", profileRevision: 2 },
    sourceMotionPose: { transportTimeSeconds: 0, layerOrder: [], joints: [["wrist", 0, 0, 0]], bones: [] },
    riggedExperimental: {
      frameSchemaVersion: 2,
      sourceAssetSha256: "a".repeat(64),
      boneWorldTransformRows: Array.from({ length: 22 }, (_, id) => [id, 0, 0, 0, 0, 0, 0, 1]),
      fixedDistalSkinSampleRows: Array.from({ length: 15 }, (_, id) => [Math.floor(id / 3) + 1, id % 3, id, 0.75, 0, 0, 0]),
      targets: [{ finger: 1, status: "no-active-note", pitch: null, noteStartSeconds: null, keyBounds: null, targetSurfaceSamples: [] }],
      targetStatus: "no-active-note",
      collisionStatus: "not-computed",
    },
  };
  return { ...base, ...overrides };
}

afterEach(() => vi.unstubAllGlobals());

describe("opt-in Testing hand capture", () => {
  it("preserves the start profile independently of later changes and records plan identity per frame", () => {
    const profile = structuredClone(DEFAULT_PROFILE);
    profile.anatomy.projectId = 7;
    profile.skin.projectName = "do not capture";
    const profileSnapshot = snapshotTestingPianistProfile(profile)!;
    const originalLength = profile.anatomy.pp1;
    profile.anatomy.pp1 = originalLength + 1;
    profile.revision++;
    expect(profileSnapshot.anatomy.pp1).toBe(originalLength);
    expect(profileSnapshot.revision).toBe(0);
    expect(profileSnapshot.anatomy).not.toHaveProperty("projectId");
    expect(profileSnapshot).not.toHaveProperty("skin");
    expect(profileSnapshot.profileSkinFingerWidth).toBe(0.75);
    expect(snapshotTestingPianistProfile(null)).toBeNull();

    const capture = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27), monotonic: 0 }), () => "profile", 20, 100_000, 0);
    capture.start({}, { pianistProfileAtCaptureStart: profileSnapshot });
    for (const revision of [0, 1]) {
      capture.record("left", { sampling: { motionPlanIdentity: { profileId: profile.profileId, profileRevision: revision } } });
    }
    const result = capture.stop()!;
    expect(result.provenanceAtStart).toMatchObject({ pianistProfileAtCaptureStart: { revision: 0, anatomy: { pp1: originalLength } } });
    expect(result.records.map(record => (record.sampling as { motionPlanIdentity: { profileRevision: number } }).motionPlanIdentity.profileRevision)).toEqual([0, 1]);
  });
  it("rotates independent ordered segments without losing frames", () => {
    const segments: ReturnType<TestingHandCapture["stop"]>[] = [];
    const capture = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27), monotonic: 0 }), () => "chunked", 4, 100_000, 0, "test", "test", part => segments.push(part));
    capture.start({ handModel: "testing" });
    for (let n = 0; n < 5; n++) capture.record("left", { n, rendererRig: { nodeLabels: ["wrist"], transforms: [[n]] } });
    segments.push(capture.stop());
    expect(segments.map(s => s?.segmentIndex)).toEqual([0, 1, 2]);
    expect(segments.map(s => s?.segmentFinal)).toEqual([false, false, true]);
    expect(segments.flatMap(s => s?.records.map(r => r.n) ?? [])).toEqual([0, 1, 2, 3, 4]);
    expect(segments.every(s => s?.captureId === "chunked")).toBe(true);
    expect(segments.every(s => s?.records[0]?.rendererRig && (s.records[0].rendererRig as { nodeLabels?: string[] }).nodeLabels)).toBe(true);
  });

  it("retains a failed segment for retry without saving it twice", async () => {
    const capture = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27), monotonic: 0 }), () => "retry", 4, 100_000, 0);
    capture.start();
    capture.record("left", { value: 1 });
    const payload = capture.stop()!;
    const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true, json: async () => ({ savedTo: "test.json", format: "compact", fileCount: 1, maxFiles: 20, totalBytes: 100, maxTotalBytes: 20_000_000 }) });
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:5173" } });
    vi.stubGlobal("fetch", request);
    await expect(saveFinalTestingHandSegment(payload)).rejects.toThrow("offline");
    expect(testingHandSegmentStatus().pending).toBe(1);
    await saveFinalTestingHandSegment(payload);
    expect(testingHandSegmentStatus().pending).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("captures short note boundaries between periodic samples and resets on seek", () => {
    let time = 0;
    const capture = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27), monotonic: time }), () => "events", 20, 100_000, 250);
    const notes = [{ hand: "left" as const, finger: 2, pitch: 60, startSeconds: 1.05, endSeconds: 1.08 }];
    capture.start();
    expect(capture.observeNoteBoundaries("left", notes, 1)).toEqual([]);
    expect(capture.record("left", { poseTime: 1 })).toBe(true);
    const events = capture.observeNoteBoundaries("left", notes, 1.1);
    expect(events).toMatchObject([{ kind: "note-start", scheduledTimeSeconds: 1.05, observedFrameTimeSeconds: 1.1 }, { kind: "note-end", scheduledTimeSeconds: 1.08 }]);
    time = 50;
    expect(capture.shouldRecord("left", true)).toBe(true);
    expect(capture.record("left", { events }, true)).toBe(true);
    expect(capture.observeNoteBoundaries("left", notes, 5)).toMatchObject([{ kind: "timeline-discontinuity", cause: "forward-gap-over-one-second" }]);
    expect(capture.observeNoteBoundaries("left", notes, 1)).toMatchObject([{ kind: "timeline-discontinuity", cause: "backward" }]);
    expect(capture.stop()?.records).toHaveLength(2);
  });

  it("writes bind alignment once per hand and LOD", () => {
    const capture = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27), monotonic: 0 }), () => "bind", 20, 100_000, 0);
    capture.start();
    for (const [hand, lod] of [["left", 0], ["left", 0], ["left", 1], ["right", 0]] as const) {
      capture.record(hand, { bindAlignment: { lod, report: { source: "native" } } });
    }
    const records = capture.stop()!.records;
    expect(records.map(r => Boolean(r.bindAlignment))).toEqual([true, false, true, true]);
  });
  it("samples hands independently at the bounded cadence and preserves readable session metadata", () => {
    let wall = Date.UTC(2026, 9, 27);
    let monotonic = 100;
    let id = 0;
    const capture = new TestingHandCapture(
      () => ({ wall: wall += 20, monotonic }),
      () => `capture-${++id}`,
      10,
      100_000,
      250,
      "0.1.0-dev",
      "local-build",
    );
    capture.start({ handModel: "testing", keyContact: true });
    expect(capture.record("left", { poseTime: 1 })).toBe(true);
    monotonic += 100;
    expect(capture.record("left", { poseTime: 1.1 })).toBe(false);
    expect(capture.record("right", { poseTime: 1.1 })).toBe(true);
    monotonic += 150;
    capture.updateConfiguration({ handModel: "testing", keyContact: false });
    expect(capture.record("left", { poseTime: 1.25 })).toBe(true);

    const payload = capture.stop();
    expect(payload).toMatchObject({
      schemaVersion: 1,
      captureId: "capture-1",
      appVersion: "0.1.0-dev",
      buildId: "local-build",
      sampleIntervalMs: 250,
      configuration: { handModel: "testing", keyContact: true },
      configurationTimeline: [
        { revision: 0, settings: { handModel: "testing", keyContact: true } },
        { revision: 1, settings: { handModel: "testing", keyContact: false } },
      ],
      truncated: false,
      throttledSamples: 1,
    });
    expect(payload?.records.map(record => record.hand)).toEqual(["left", "right", "left"]);
    expect(payload?.records[0]).toMatchObject({ poseTime: 1, elapsedMs: 0 });
    expect(payload?.records[0]).toMatchObject({ configurationRevision: 0 });
    expect(payload?.records[2]).toMatchObject({ configurationRevision: 1 });
    expect(capture.status().active).toBe(false);
    expect(capture.stop()).toBeNull();
  });

  it("keeps the v1 envelope and identifies Rigged Experimental v2 bones without reinterpreting v1 IDs", () => {
    const capture = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27), monotonic: 10 }), () => "rigged-frame", 8, 100_000, 0);
    capture.start({ handModel: "rigged-experimental", riggedExperimentalFrameSchemaVersion: 2 });
    expect(capture.status()).toMatchObject({ active: true, captureModel: "rigged-experimental" });
    expect(capture.record("right", {
      displayedTransportTimeSeconds: -2,
      sourcePoseTimeSeconds: 0,
      profileIdentity: { profileId: "default", profileRevision: 4 },
      riggedExperimental: {
        frameSchemaVersion: 2,
        sourceAssetSha256: "a".repeat(64),
        boneWorldTransformRows: Array.from({ length: 22 }, (_, id) => [id, 0, 0, 0, 0, 0, 0, 1]),
        fixedDistalSkinSampleRows: Array.from({ length: 15 }, (_, id) => [Math.floor(id / 3) + 1, id % 3, id, 0.75, 0, 0, 0]),
        targetStatus: "unavailable-no-key-targets-passed",
        collisionStatus: "not-computed",
      },
    })).toBe(true);
    const payload = capture.stop()!;
    expect(payload).toMatchObject({ schemaVersion: 1, captureModel: "rigged-experimental" });
    expect(payload.records[0]).toMatchObject({
      captureModel: "rigged-experimental",
      displayedTransportTimeSeconds: -2,
      sourcePoseTimeSeconds: 0,
      profileIdentity: { profileId: "default", profileRevision: 4 },
      riggedExperimental: { frameSchemaVersion: 2, boneWorldTransformRows: expect.any(Array), targetStatus: "unavailable-no-key-targets-passed", collisionStatus: "not-computed" },
    });
    expect(payload.formatSemantics.riggedExperimentalFrameSchemaVersion).toBe(2);
    expect(payload.formatSemantics.riggedExperimentalBoneOrderV2.slice(-2)).toEqual(["forearm", "palm"]);
    expect(payload.formatSemantics.riggedExperimentalFingerBoneOrder).toHaveLength(20);
    expect(payload.formatSemantics.riggedExperimentalBoneWorldRowsV2).toContain("asset has no separate wrist bone");
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThan(100_000);
  });

  it("deduplicates stationary Rigged frames but reports the full hold through Stop", () => {
    let monotonic = 0;
    const capture = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27) + monotonic, monotonic }), () => "stationary", 8, 100_000, 250);
    capture.start({ handModel: "rigged-experimental" });
    expect(capture.record("left", riggedSample())).toBe(true);
    monotonic = 250;
    expect(capture.record("left", riggedSample({ sampleReason: "different-volatile-reason", sampling: { ...riggedSample().sampling as object, samplingCounter: 19 } }))).toBe(false);
    monotonic = 350;
    expect(capture.record("left", riggedSample())).toBe(false);
    monotonic = 500;
    expect(capture.record("left", riggedSample())).toBe(false);
    expect(capture.status()).toMatchObject({ recordCount: 1, duplicateSamples: 2, throttledSamples: 1 });
    const payload = capture.stop()!;
    expect(payload.records).toHaveLength(1);
    expect(payload.riggedExperimentalDuplicateSummary).toMatchObject({
      schemaVersion: 1,
      duplicateSampleCount: 2,
      intervals: [{ hand: "left", startElapsedMs: 0, endElapsedMs: 500, durationMs: 500, duplicateCount: 2, closedBy: "stop" }],
      intervalsTruncated: false,
    });
  });

  it("retains same-time changes to pose, settings, profile, coverage, target surface and transport", () => {
    const capture = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27), monotonic: 0 }), () => "changed-semantics", 20, 100_000, 0);
    capture.start({ handModel: "rigged-experimental", contactMode: "a" });
    const base = riggedSample();
    expect(capture.record("right", base)).toBe(true);
    expect(capture.record("right", riggedSample({ sourceMotionPose: { transportTimeSeconds: 0, layerOrder: [], joints: [["wrist", 1, 0, 0]], bones: [] } }))).toBe(true);
    capture.updateConfiguration({ handModel: "rigged-experimental", contactMode: "b" });
    expect(capture.record("right", base)).toBe(true);
    expect(capture.record("right", riggedSample({ profileIdentity: { profileId: "profile-b", profileRevision: 1 } }))).toBe(true);
    expect(capture.record("right", riggedSample({
      sampling: {
        ...(base.sampling as Record<string, unknown>),
        coverage: { source: "verified-motion-buffer", intervals: [{ start: 0, end: 8 }], requestedTimeCovered: false },
      },
    }))).toBe(true);
    expect(capture.record("right", riggedSample({
      riggedExperimental: {
        ...(base.riggedExperimental as Record<string, unknown>),
        targets: [{ finger: 1, status: "target-sampled", pitch: 61, noteStartSeconds: 0, keyBounds: { centerX: 1 }, targetSurfaceSamples: [[0, 5, 0.2, -0.1]] }],
      },
    }))).toBe(true);
    expect(capture.record("right", riggedSample({ displayedTransportTimeSeconds: 4, sourcePoseTimeSeconds: 4 }))).toBe(true);
    const records = capture.stop()!.records;
    expect(records).toHaveLength(7);
    expect(records.map(record => record.configurationRevision)).toEqual([0, 0, 1, 1, 1, 1, 1]);
    expect(records[4]?.sampling).toMatchObject({ coverage: { intervals: [{ start: 0, end: 8 }], revision: 1 } });
    expect(records[5]?.riggedExperimental).toMatchObject({ targets: [{ pitch: 61, targetSurfaceSamples: [[0, 5, 0.2, -0.1]] }] });
  });

  it("keeps forced identical boundary samples and closes the preceding hold", () => {
    let monotonic = 0;
    const capture = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27), monotonic }), () => "forced-boundary", 8, 100_000, 0);
    capture.start({ handModel: "rigged-experimental" });
    expect(capture.record("left", riggedSample())).toBe(true);
    monotonic = 250;
    expect(capture.record("left", riggedSample())).toBe(false);
    monotonic = 500;
    expect(capture.record("left", riggedSample({ sampleReason: "note-boundary-observed-on-render-frame" }), true)).toBe(true);
    const payload = capture.stop()!;
    expect(payload.records).toHaveLength(2);
    expect(payload.records[1]?.sampleReason).toBe("note-boundary-observed-on-render-frame");
    expect(payload.riggedExperimentalDuplicateSummary).toMatchObject({
      duplicateSampleCount: 1,
      intervals: [{ startElapsedMs: 0, endElapsedMs: 250, duplicateCount: 1, closedBy: "forced-frame" }],
    });
  });

  it("leaves Testing capture unchanged and bounds duplicate summary size", () => {
    const testing = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27), monotonic: 0 }), () => "testing-unchanged", 8, 100_000, 0);
    testing.start({ handModel: "testing" });
    testing.record("left", { value: 1 });
    testing.record("left", { value: 1 });
    const testingPayload = testing.stop()!;
    expect(testingPayload.records).toHaveLength(2);
    expect(testingPayload.riggedExperimentalDuplicateSummary).toBeUndefined();

    let monotonic = 0;
    const segments: ReturnType<TestingHandCapture["stop"]>[] = [];
    const capture = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27) + monotonic, monotonic }), () => "summary-bound", 360, 850_000, 0, "test", "test", segment => segments.push(segment));
    capture.start({ handModel: "rigged-experimental" });
    for (let index = 0; index < 370; index++) {
      const sample = riggedSample({ riggedExperimental: { ...riggedSample().riggedExperimental as object, targets: [{ finger: 1, status: "target-sampled", pitch: 40 + index, noteStartSeconds: 0, keyBounds: null, targetSurfaceSamples: [] }] } });
      capture.record("left", sample);
      monotonic += 1;
      capture.record("left", sample);
      monotonic += 1;
    }
    const final = capture.stop()!;
    segments.push(final);
    expect(final.riggedExperimentalDuplicateSummary).toMatchObject({ duplicateSampleCount: 370, intervals: expect.any(Array), intervalsTruncated: true });
    expect(final.riggedExperimentalDuplicateSummary?.intervals).toHaveLength(360);
    expect(segments.every(segment => new TextEncoder().encode(JSON.stringify(segment)).byteLength <= 850_000)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(final)).byteLength).toBeLessThan(850_000);
    expect(capture.status().duplicateSamples).toBe(0);
  });

  it("routes new Rigged Experimental and legacy Testing frames to their compatible local sinks", async () => {
    const capture = new TestingHandCapture(() => ({ wall: Date.UTC(2026, 9, 27), monotonic: 10 }), () => "route-test", 8, 100_000, 0);
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:5173" } });
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ savedTo: "capture.json", format: "compact", fileCount: 1, maxFiles: 20, totalBytes: 100, maxTotalBytes: 20_000_000 }),
    });
    vi.stubGlobal("fetch", request);
    capture.start({ handModel: "rigged-experimental" });
    capture.record("left", { value: 1 });
    await saveTestingHandCapture(capture.stop()!);
    capture.start({ handModel: "testing" });
    capture.record("left", { value: 2 });
    await saveTestingHandCapture(capture.stop()!);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      `http://127.0.0.1:5173${RIGGED_EXPERIMENTAL_HAND_CAPTURE_ENDPOINT}`,
      `http://127.0.0.1:5173${TESTING_HAND_CAPTURE_ENDPOINT}`,
    ]);
  });

  it("shares capture identity across HMR-style module instances", async () => {
    const refreshedModulePath = "./testingHandCapture?hmr-instance-check";
    const refreshedModule = await import(refreshedModulePath);
    expect(refreshedModule.testingHandCapture).toBe(testingHandCapture);
    refreshedModule.startTestingHandCapture({ handModel: "rigged-experimental" });
    expect(testingHandCapture.isActiveFor("rigged-experimental")).toBe(true);
    expect(testingHandCapture.status().active).toBe(true);
    refreshedModule.stopTestingHandCapture();
    expect(testingHandCapture.status().active).toBe(false);
  });

  it("stops accepting frames when either record or byte bounds are reached", () => {
    let monotonic = 0;
    const byCount = new TestingHandCapture(
      () => ({ wall: Date.UTC(2026, 9, 27), monotonic }),
      () => "count-limited",
      1,
      10_000,
      0,
    );
    byCount.start();
    expect(byCount.record("left", { value: 1 })).toBe(true);
    monotonic += 1;
    expect(byCount.record("left", { value: 2 })).toBe(false);
    expect(byCount.status().truncated).toBe(true);
    expect(byCount.stop()?.records).toHaveLength(1);

    const bySize = new TestingHandCapture(
      () => ({ wall: Date.UTC(2026, 9, 27), monotonic }),
      () => "size-limited",
      10,
      8,
      0,
    );
    bySize.start();
    expect(bySize.record("right", { value: "too large" })).toBe(false);
    expect(bySize.status().truncated).toBe(true);
    expect(bySize.stop()?.records).toHaveLength(0);
  });

  it("assigns each recording a distinct ID for separate tabs or sessions", () => {
    let id = 0;
    const capture = new TestingHandCapture(
      () => ({ wall: Date.UTC(2026, 9, 27), monotonic: id }),
      () => `session-${++id}`,
    );
    expect(capture.start().startedAt).not.toBeNull();
    expect(capture.stop()?.captureId).toBe("session-1");
    capture.start();
    expect(capture.stop()?.captureId).toBe("session-2");
  });

  it("writes large static renderer and coverage metadata only when it changes per hand", () => {
    let monotonic = 0;
    const capture = new TestingHandCapture(
      () => ({ wall: Date.UTC(2026, 9, 27), monotonic }),
      () => "metadata-session",
      10,
      100_000,
      0,
    );
    capture.start();
    const repeatedMetadata = {
      sampling: { coverage: { intervals: [{ start: 0, end: 10 }] } },
      rendererRig: { nodeLabels: ["Carpals", "ProximalPhalanx"], transforms: [[0, 0, 0]] },
    };
    capture.record("left", repeatedMetadata);
    monotonic += 1;
    capture.record("left", repeatedMetadata);
    monotonic += 1;
    capture.record("right", repeatedMetadata);
    monotonic += 1;
    capture.record("left", {
      ...repeatedMetadata,
      sampling: { coverage: { intervals: [{ start: 0, end: 12 }] } },
    });

    const records = capture.stop()?.records ?? [];
    expect(records[0]?.sampling).toEqual({ coverage: { intervals: [{ start: 0, end: 10 }], revision: 0 } });
    expect(records[0]?.rendererRig).toMatchObject({ nodeLabels: ["Carpals", "ProximalPhalanx"], labelsRevision: 0 });
    expect(records[1]?.sampling).toEqual({ coverage: { revision: 0 } });
    expect(records[1]?.rendererRig).toEqual({ transforms: [[0, 0, 0]], labelsRevision: 0 });
    expect(records[2]?.sampling).toEqual({ coverage: { intervals: [{ start: 0, end: 10 }], revision: 0 } });
    expect(records[2]?.rendererRig).toMatchObject({ nodeLabels: ["Carpals", "ProximalPhalanx"], labelsRevision: 0 });
    expect(records[3]?.sampling).toEqual({ coverage: { intervals: [{ start: 0, end: 12 }], revision: 1 } });
    expect(records[3]?.rendererRig).toEqual({ transforms: [[0, 0, 0]], labelsRevision: 0 });
  });
});
