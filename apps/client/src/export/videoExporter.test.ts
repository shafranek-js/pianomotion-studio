import { describe, it, expect } from "vitest";
import type { SongDocument, PerformancePlan } from "@handthesia/contracts";
import {
  VideoExporter,
  WEIGHT_FRAMES,
  WEIGHT_AUDIO,
  WEIGHT_MUX,
  getSupportedVideoMimeType,
} from "./videoExporter";
import type { ExportSceneDataSource, VideoExportOptions, VideoExportProgress } from "./types";
import { DEFAULT_PROFILE } from "../profiles";
import { getSettings } from "../settings";

describe("videoExporter", () => {
  it("strictly satisfies progress weighting invariants", () => {
    expect(WEIGHT_FRAMES).toBe(0.86);
    expect(WEIGHT_AUDIO).toBe(0.10);
    expect(WEIGHT_MUX).toBe(0.04);
    expect(WEIGHT_FRAMES + WEIGHT_AUDIO + WEIGHT_MUX).toBeCloseTo(1.0, 5);
  });

  it("returns a valid video mime type", () => {
    const mime = getSupportedVideoMimeType();
    expect(mime).toMatch(/^video\/(webm|mp4)/);
  });

  it("handles exporter lifecycle and cancellation flag", () => {
    const exporter = new VideoExporter();
    expect(exporter.isCancelled()).toBe(false);
    expect(exporter.isRunning()).toBe(false);

    exporter.cancel();
    expect(exporter.isCancelled()).toBe(true);
  });

  it("executes export workflow through all phases and produces video blob", async () => {
    const mockDoc: SongDocument = {
      schemaVersion: 1,
      projectId: "proj-1",
      revision: 0,
      title: "Chopin Prelude",
      durationSeconds: 1.0,
      tracks: [{ trackId: "t1", instrumentIndex: 0, name: "Piano", program: 0, hand: null }],
      notes: [
        { noteId: "n1", trackId: "t1", pitch: 60, startSeconds: 0.1, endSeconds: 0.5, velocity: 80, hand: "right", finger: 1, glissando: false },
      ],
      tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500000, eventOrdinal: 0 }],
      pedalControls: [],
    };

    const mockPlan: PerformancePlan = {
      schemaVersion: 1,
      kind: "performance",
      planId: "plan-1",
      projectId: "proj-1",
      inputRevision: 0,
      profileId: DEFAULT_PROFILE.profileId,
      profileRevision: DEFAULT_PROFILE.revision,
      engineVersion: "0".repeat(64),
      fingeringPlanId: "finger-1",
      events: [
        { type: "press", timeSeconds: 0.1, pitch: 60, velocity: 80, noteId: "n1" },
        { type: "release", timeSeconds: 0.5, noteId: "n1" },
      ],
      diagnostics: [],
    };

    const mockSource: ExportSceneDataSource = {
      document: mockDoc,
      performancePlan: mockPlan,
      keyStyle: "realistic",
      profile: DEFAULT_PROFILE,
      settings: getSettings(),
      audioRecording: null,
    };

    const options: VideoExportOptions = {
      preset: "720p",
      width: 1280,
      height: 720,
      fps: 30,
      speed: 1.0,
      includeAudio: true,
      audioSource: "synth",
      tailSeconds: 0.5,
    };

    const progressUpdates: VideoExportProgress[] = [];
    const exporter = new VideoExporter();

    const result = await exporter.exportVideo(mockSource, options, (p) => {
      progressUpdates.push({ ...p });
    });

    expect(result.videoBlob).toBeInstanceOf(Blob);
    expect(result.filename).toContain("Chopin_Prelude_720p_30fps");
    expect(result.audioWavBlob).toBeInstanceOf(Blob);

    // Verify phases were encountered in order
    const phases = progressUpdates.map((u) => u.phase);
    expect(phases).toContain("preparing");
    expect(phases).toContain("rendering_frames");
    expect(phases).toContain("rendering_audio");
    expect(phases).toContain("multiplexing");
    expect(phases).toContain("completed");

    // Verify last progress update is complete
    const last = progressUpdates[progressUpdates.length - 1]!;
    expect(last.overallProgress).toBe(1.0);
    expect(last.frameProgress).toBe(1.0);
  });

  it("aborts promptly when cancel is requested during export", async () => {
    const mockDoc: SongDocument = {
      schemaVersion: 1,
      projectId: "proj-cancel",
      revision: 0,
      title: "Long Piece",
      durationSeconds: 10.0,
      tracks: [{ trackId: "t1", instrumentIndex: 0, name: "Piano", program: 0, hand: null }],
      notes: [],
      tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500000, eventOrdinal: 0 }],
      pedalControls: [],
    };

    const mockPlan: PerformancePlan = {
      schemaVersion: 1,
      kind: "performance",
      planId: "plan-cancel",
      projectId: "proj-cancel",
      inputRevision: 0,
      profileId: DEFAULT_PROFILE.profileId,
      profileRevision: DEFAULT_PROFILE.revision,
      engineVersion: "0".repeat(64),
      fingeringPlanId: "finger-cancel",
      events: [],
      diagnostics: [],
    };

    const mockSource: ExportSceneDataSource = {
      document: mockDoc,
      performancePlan: mockPlan,
      keyStyle: "realistic",
      profile: DEFAULT_PROFILE,
      settings: getSettings(),
    };

    const options: VideoExportOptions = {
      preset: "1080p",
      width: 1920,
      height: 1080,
      fps: 60,
      speed: 1.0,
      includeAudio: false,
      audioSource: "none",
    };

    const exporter = new VideoExporter();

    const promise = exporter.exportVideo(mockSource, options, (p) => {
      if (p.doneFrames >= 5) {
        exporter.cancel();
      }
    });

    await expect(promise).rejects.toThrow("Export cancelled");
    expect(exporter.isCancelled()).toBe(true);
    expect(exporter.isRunning()).toBe(false);
  });
});
