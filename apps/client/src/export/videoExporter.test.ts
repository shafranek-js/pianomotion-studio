import { afterEach, describe, expect, it, vi } from "vitest";
import type { FingeringPlan, M1RawBaseline, M1ReplanDocumentResult, PerformancePlan, ResourceDescriptor, SongDocument } from "@handthesia/contracts";
import { DEFAULT_PROFILE } from "../profiles";
import { getSettings } from "../settings";
import { BoundedBlobAccumulator, MAX_VIDEO_BLOB_BYTES, createFileVideoSink, type SaveFileHandleLike } from "./videoExportSink";
import { freezeVideoExportSnapshot } from "./videoExportSnapshot";
import { assertReplanMatchesFrozenSource, getSupportedVideoMimeType, preflightVideoCodecs, VideoExporter, WEIGHT_AUDIO, WEIGHT_FRAMES, WEIGHT_MUX } from "./videoExporter";
import type { ExportSceneDataSource, ExportSourceIdentity, VideoExportOptions } from "./types";

const engineVersion = "a".repeat(64);

function makeSource(): ExportSceneDataSource {
  const midiBytes = new Uint8Array([1, 2, 3, 4]).buffer;
  const document: SongDocument = {
    schemaVersion: 1,
    projectId: "export-project",
    revision: 3,
    title: "Frozen source",
    durationSeconds: 1,
    sourceMidiResourceId: "source-midi",
    tracks: [{ trackId: "track-1", instrumentIndex: 0, name: "Piano", program: 0, hand: null }],
    notes: [{ noteId: "note-1", trackId: "track-1", pitch: 60, startSeconds: 0.1, endSeconds: 0.5, velocity: 90, hand: "right", finger: 1, glissando: false }],
    tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500_000, eventOrdinal: 0 }],
    pedalControls: [],
  };
  const fingeringPlan: FingeringPlan = {
    schemaVersion: 1, kind: "fingering", planId: "fingering-1", projectId: "export-project",
    inputRevision: 3, profileId: DEFAULT_PROFILE.profileId, profileRevision: DEFAULT_PROFILE.revision,
    engineVersion, assignments: [{ noteId: "note-1", hand: "right", finger: 1, disposition: "played" }], diagnostics: [],
  };
  const performancePlan: PerformancePlan = {
    schemaVersion: 1, kind: "performance", planId: "performance-1", projectId: "export-project",
    inputRevision: 3, profileId: DEFAULT_PROFILE.profileId, profileRevision: DEFAULT_PROFILE.revision,
    engineVersion, fingeringPlanId: fingeringPlan.planId, diagnostics: [],
    events: [
      { type: "press", timeSeconds: 0.1, pitch: 60, velocity: 90, noteId: "note-1" },
      { type: "release", timeSeconds: 0.5, noteId: "note-1" },
    ],
  };
  const resource: ResourceDescriptor = {
    resourceId: "source-midi", purpose: "source-midi", mediaType: "audio/midi", path: "resources/source.mid",
    byteLength: midiBytes.byteLength, sha256: "b".repeat(64),
  };
  const identity: ExportSourceIdentity = {
    projectId: "export-project", revision: 3, engineVersion, originalMidiBytes: midiBytes,
    fingeringPlan,
    rawBaseline: { inputSha256: resource.sha256 } as M1RawBaseline,
    sourceContext: { fixtureId: "tracked-right-hand", keyStyle: "realistic" },
    resource, activeOutputId: "soundfont", soundFontAssetId: "sf2-one",
    soundFontAssetBytes: new Uint8Array([8, 9, 10]).buffer,
  };
  const audioChannel = new Float32Array([0.25, 0.5, -0.25]);
  const recordingBuffer = {
    numberOfChannels: 1, sampleRate: 48_000, length: audioChannel.length, duration: audioChannel.length / 48_000,
    getChannelData: () => audioChannel,
  } as unknown as AudioBuffer;
  return {
    sourceIdentity: identity,
    document,
    performancePlan,
    keyStyle: "realistic",
    profile: DEFAULT_PROFILE,
    settings: getSettings(),
    audioRecording: { buffer: recordingBuffer, durationSeconds: recordingBuffer.duration, sampleRate: 48_000, numberOfChannels: 1, peaks: new Float32Array([0.1, 0.2]), filename: "take.wav" },
    audioOffset: 0.25,
  };
}

const options: VideoExportOptions = {
  preset: "1080p", width: 1920, height: 1080, fps: 30, speed: 1,
  format: "mp4", includeAudio: true, audioSource: "soundfont", tailSeconds: 1.5,
};

describe("video export foundations", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts request-scoped replan IDs while rejecting changed fingering or performance events", () => {
    const source = makeSource();
    const identity = source.sourceIdentity!;
    const replanned = {
      document: structuredClone(source.document),
      fingeringPlan: { ...structuredClone(identity.fingeringPlan), planId: "fingering-export-request" },
      performancePlan: { ...structuredClone(source.performancePlan), planId: "performance-export-request", fingeringPlanId: "fingering-export-request" },
    } as M1ReplanDocumentResult;
    const check = () => assertReplanMatchesFrozenSource(identity, source.document, source.performancePlan, replanned);
    expect(check).not.toThrow();
    replanned.fingeringPlan!.assignments[0]!.finger = 2;
    expect(check).toThrow(/frozen performance events/);
    replanned.fingeringPlan!.assignments[0]!.finger = 1;
    replanned.performancePlan!.events[0]!.timeSeconds += 0.1;
    expect(check).toThrow(/frozen performance events/);
  });

  it("keeps progress weights normalized", () => {
    expect(WEIGHT_FRAMES).toBe(0.86);
    expect(WEIGHT_AUDIO).toBe(0.10);
    expect(WEIGHT_MUX).toBe(0.04);
    expect(WEIGHT_FRAMES + WEIGHT_AUDIO + WEIGHT_MUX).toBe(1);
  });

  it("freezes DTOs, MIDI, SoundFont, recording channels, and options before asynchronous work", () => {
    const source = makeSource();
    const snapshot = freezeVideoExportSnapshot(source, options);
    const originalBytes = new Uint8Array(source.sourceIdentity!.originalMidiBytes);
    const originalSoundFont = new Uint8Array(source.sourceIdentity!.soundFontAssetBytes!);
    originalBytes[0] = 99;
    originalSoundFont[0] = 99;
    source.document.title = "edited after export started";
    source.audioRecording!.buffer.getChannelData(0)[0] = 0.99;
    source.audioRecording!.peaks[0] = 0.99;

    expect(snapshot.document.title).toBe("Frozen source");
    expect(new Uint8Array(snapshot.sourceIdentity.originalMidiBytes)[0]).toBe(1);
    expect(new Uint8Array(snapshot.sourceIdentity.soundFontAssetBytes!)[0]).toBe(8);
    expect(snapshot.audioRecording!.buffer.getChannelData(0)[0]).toBe(0.25);
    expect(snapshot.audioRecording!.peaks[0]).toBeCloseTo(0.1, 6);
    expect(snapshot.options).toEqual(options);
    expect(snapshot.sourceIdentity.originalMidiBytes).not.toBe(source.sourceIdentity!.originalMidiBytes);
    expect(snapshot.performancePlan).not.toBe(source.performancePlan);
    expect(snapshot.performancePlan.events).not.toBe(source.performancePlan.events);
  });

  it("keeps option and performance event mutations made after an async boundary out of the export snapshot", async () => {
    const source = makeSource();
    const mutableOptions = { ...options };
    const pendingSnapshot = (async () => {
      const snapshot = freezeVideoExportSnapshot(source, mutableOptions);
      await Promise.resolve();
      return snapshot;
    })();

    mutableOptions.speed = 1.75;
    mutableOptions.fps = 60;
    source.performancePlan.events[0]!.timeSeconds = 0.42;
    const snapshot = await pendingSnapshot;

    expect(snapshot.options.speed).toBe(1);
    expect(snapshot.options.fps).toBe(30);
    expect(snapshot.performancePlan.events[0]!.timeSeconds).toBe(0.1);
  });

  it("rejects project revisions and plans that do not share a source identity", () => {
    const source = makeSource();
    source.document.revision += 1;
    expect(() => freezeVideoExportSnapshot(source, options)).toThrow(/saved project revision/i);
  });

  it("requires a real WebCodecs video encoder and never selects MediaRecorder", async () => {
    expect(getSupportedVideoMimeType("mp4")).toBe("video/mp4");
    expect(getSupportedVideoMimeType("webm")).toBe("video/webm");
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "VideoEncoder");
    Object.defineProperty(globalThis, "VideoEncoder", { configurable: true, value: undefined });
    await expect(preflightVideoCodecs("mp4", { width: 1920, height: 1080, fps: 30, includeAudio: false }))
      .rejects.toThrow(/WebCodecs VideoEncoder/);
    if (descriptor) Object.defineProperty(globalThis, "VideoEncoder", descriptor);
    else Reflect.deleteProperty(globalThis, "VideoEncoder");
  });

  it("keeps the Blob output random-access, byte-accurate, and hard-capped", async () => {
    const output = new BoundedBlobAccumulator("video/webm", 8);
    output.write(4, new Uint8Array([5, 6, 7, 8]));
    output.write(0, new Uint8Array([1, 2, 3, 4]));
    const blob = output.finalize();
    expect(blob.size).toBe(8);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(output.size).toBe(8);
    expect(MAX_VIDEO_BLOB_BYTES).toBe(128 * 1024 * 1024);
    expect(() => output.write(8, new Uint8Array([9]))).toThrow(/8-byte in-memory output limit/);
  });

  it("closes completed file output and aborts partial output", async () => {
    const writes: Array<{ position: number; bytes: number[] }> = [];
    let closed = false;
    let aborted = false;
    const handle: SaveFileHandleLike = {
      name: "take.mp4",
      async createWritable() {
        return {
          async write(chunk) { writes.push({ position: chunk.position, bytes: Array.from(chunk.data) }); },
          async close() { closed = true; },
          async abort() { aborted = true; },
        };
      },
    };
    const targetInternals = (sink: Awaited<ReturnType<typeof createFileVideoSink>>["target"]) => sink as unknown as {
      _start(): void;
      _write(data: Uint8Array, position: number): void;
      _flush(): Promise<void>;
      _finalize(): Promise<void>;
    };
    const success = await createFileVideoSink(handle);
    targetInternals(success.target)._start();
    targetInternals(success.target)._write(new Uint8Array([1, 2, 3]), 0);
    await targetInternals(success.target)._flush();
    await targetInternals(success.target)._finalize();
    expect(writes).toEqual([{ position: 0, bytes: [1, 2, 3] }]);
    expect(closed).toBe(true);

    closed = false;
    const partial = await createFileVideoSink(handle);
    targetInternals(partial.target)._start();
    targetInternals(partial.target)._write(new Uint8Array([4, 5]), 0);
    await targetInternals(partial.target)._flush();
    await partial.abort(new Error("test cancellation"));
    expect(aborted).toBe(true);
    expect(closed).toBe(false);
  });

  it("leaves a file sink open when close fails and allows the exporter to abort it", async () => {
    let aborted = false;
    const handle: SaveFileHandleLike = {
      name: "failed-close.mp4",
      async createWritable() {
        return {
          async write() {},
          async close() { throw new Error("injected writer close failure"); },
          async abort() { aborted = true; },
        };
      },
    };
    const sink = await createFileVideoSink(handle);
    const internals = sink.target as unknown as {
      _start(): void;
      _write(data: Uint8Array, position: number): void;
      _flush(): Promise<void>;
      _finalize(): Promise<void>;
    };
    internals._start();
    internals._write(new Uint8Array([1, 2, 3]), 0);
    await internals._flush();
    await expect(internals._finalize()).rejects.toThrow(/injected writer close failure/);
    expect(sink.isClosed()).toBe(false);
    await sink.abort(new Error("finalize failed"));
    expect(aborted).toBe(true);
  });

  it("keeps exporter lifecycle explicit", () => {
    const exporter = new VideoExporter();
    expect(exporter.isRunning()).toBe(false);
    expect(exporter.isCancelled()).toBe(false);
    exporter.cancel();
    expect(exporter.isCancelled()).toBe(true);
  });
});
