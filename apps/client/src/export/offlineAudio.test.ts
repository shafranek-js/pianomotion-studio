import { afterEach, describe, it, expect, vi } from "vitest";
import type { SongDocument } from "@handthesia/contracts";
import {
  getVideoDimensions,
  calculateExportTiming,
  ensureEvenDimension,
  VIDEO_TAIL_S,
} from "./videoDimensions";
import { encodeAudioBufferToWav, audioBufferToWavBlob } from "./wavEncoder";
import {
  MemoryAudioBuffer,
  normalizeAudioBuffer,
  sliceRecordingAudio,
  renderOfflineAudio,
  NORMALIZE_PEAK,
} from "./offlineAudioRenderer";

describe("videoDimensions", () => {
  it("clamps odd dimensions to even numbers", () => {
    expect(ensureEvenDimension(1920)).toBe(1920);
    expect(ensureEvenDimension(1921)).toBe(1920);
    expect(ensureEvenDimension(1081)).toBe(1080);
    expect(ensureEvenDimension(723)).toBe(722);
  });

  it("returns correct presets for 1080p, 720p, 4k, and window", () => {
    const fhd = getVideoDimensions("1080p");
    expect(fhd.width).toBe(1920);
    expect(fhd.height).toBe(1080);

    const hd = getVideoDimensions("720p");
    expect(hd.width).toBe(1280);
    expect(hd.height).toBe(720);

    const uhd = getVideoDimensions("4k");
    expect(uhd.width).toBe(3840);
    expect(uhd.height).toBe(2160);

    const win = getVideoDimensions("window", 1025, 767);
    expect(win.width).toBe(1024);
    expect(win.height).toBe(766);
  });

  it("calculates export timing and total frame count correctly", () => {
    // leadIn: -2.0, songDuration: 10.0, speed: 1.0, tail: 1.5 => (10 - -2)/1 + 1.5 = 13.5s
    // The default export rate is now 30 fps: 13.5 * 30 = 405 frames.
    const timing = calculateExportTiming(-2.0, 10.0, 1.0, VIDEO_TAIL_S);
    expect(timing.startTime).toBe(-2.0);
    expect(timing.durationSeconds).toBeCloseTo(13.5, 3);
    expect(timing.totalFrames).toBe(405);
    expect(timing.fps).toBe(30);

    // Explicit 60 fps remains available: 13.5 * 60 = 810 frames.
    const at60 = calculateExportTiming(-2.0, 10.0, 1.0, VIDEO_TAIL_S, 60);
    expect(at60.totalFrames).toBe(810);
    expect(at60.fps).toBe(60);

    // half speed: (10 - -2)/0.5 + 1.5 = 25.5s => 25.5 * 60 = 1530 frames
    const halfSpeed = calculateExportTiming(-2.0, 10.0, 0.5, 1.5, 60);
    expect(halfSpeed.durationSeconds).toBeCloseTo(25.5, 3);
    expect(halfSpeed.totalFrames).toBe(1530);

    // 30 fps
    const at30 = calculateExportTiming(-2.0, 10.0, 1.0, 1.5, 30);
    expect(at30.totalFrames).toBe(405);
  });
});

describe("wavEncoder", () => {
  it("encodes stereo AudioBuffer to valid 16-bit PCM RIFF WAV bytes", () => {
    const sampleRate = 44100;
    const numFrames = 100;
    const buf = new MemoryAudioBuffer(2, numFrames, sampleRate);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);
    left[0] = 0.5;
    right[0] = -0.5;

    const wav = encodeAudioBufferToWav(buf);
    expect(wav.length).toBe(44 + numFrames * 2 * 2);

    const str = String.fromCharCode(...wav.subarray(0, 4));
    expect(str).toBe("RIFF");
    const waveStr = String.fromCharCode(...wav.subarray(8, 12));
    expect(waveStr).toBe("WAVE");
    const fmtStr = String.fromCharCode(...wav.subarray(12, 16));
    expect(fmtStr).toBe("fmt ");
    const dataStr = String.fromCharCode(...wav.subarray(36, 40));
    expect(dataStr).toBe("data");

    const view = new DataView(wav.buffer);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // 2 channels
    expect(view.getUint32(24, true)).toBe(44100); // sampleRate
    expect(view.getUint16(34, true)).toBe(16); // 16 bits

    // First left sample (0.5 * 32767 ≈ 16384)
    expect(view.getInt16(44, true)).toBeCloseTo(16384, -2);
    // First right sample (-0.5 * 32768 ≈ -16384)
    expect(view.getInt16(46, true)).toBeCloseTo(-16384, -2);
  });

  it("produces an audio/wav Blob", () => {
    const buf = new MemoryAudioBuffer(1, 50, 44100);
    const blob = audioBufferToWavBlob(buf);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 50 * 2);
  });
});

describe("offlineAudioRenderer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("checks cancellation for empty SoundFont plans and settles OfflineAudioContext before rejecting", async () => {
    class DeferredOfflineAudioContext {
      public static instance: DeferredOfflineAudioContext | null = null;
      public currentTime = 0;
      public state: AudioContextState = "suspended";
      public readonly destination = {} as AudioNode;
      public readonly suspendTimes: number[] = [];
      public resumeCalls = 0;
      public renderingSettled = false;
      private resolveSuspension: (() => void) | null = null;
      private resolveRendering: ((buffer: AudioBuffer) => void) | null = null;

      constructor(_channels: number, _length: number, _sampleRate: number) {
        void _channels;
        void _length;
        void _sampleRate;
        DeferredOfflineAudioContext.instance = this;
      }

      createGain(): GainNode {
        return {
          gain: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
        } as unknown as GainNode;
      }

      suspend(time: number): Promise<void> {
        this.suspendTimes.push(time);
        return new Promise((resolve) => {
          this.resolveSuspension = () => {
            this.state = "suspended";
            resolve();
          };
        });
      }

      startRendering(): Promise<AudioBuffer> {
        this.state = "running";
        return new Promise((resolve) => {
          this.resolveRendering = resolve;
        });
      }

      resume(): Promise<void> {
        this.resumeCalls += 1;
        this.state = "running";
        this.renderingSettled = true;
        this.resolveRendering?.(new MemoryAudioBuffer(2, 1, 44_100) as unknown as AudioBuffer);
        return Promise.resolve();
      }

      reachNextSuspension(): void {
        this.resolveSuspension?.();
        this.resolveSuspension = null;
      }
    }

    vi.stubGlobal("OfflineAudioContext", DeferredOfflineAudioContext);
    const controller = new AbortController();
    const rendering = renderOfflineAudio({
      document: {} as SongDocument,
      performancePlan: null,
      soundFont: {
        header: { name: "Empty test bank", versionMajor: 2, versionMinor: 4 },
        presets: [],
        samples: [],
        rawSampleData: new Int16Array(0),
      } as never,
      speed: 1,
      startTime: 0,
      durationSeconds: 2,
      sampleRate: 44_100,
      createWav: false,
      cancelSignal: controller.signal,
    });
    const context = DeferredOfflineAudioContext.instance!;

    expect(context.suspendTimes[0]).toBeCloseTo(0.5, 6);
    controller.abort();
    context.reachNextSuspension();

    await expect(rendering).rejects.toThrow(/Offline audio rendering aborted/);
    expect(context.resumeCalls).toBe(1);
    expect(context.renderingSettled).toBe(true);
  });

  it("normalizes audio peak to 0.89 (-1 dBFS)", () => {
    const buf = new MemoryAudioBuffer(1, 10, 44100);
    const ch = buf.getChannelData(0);
    ch[2] = 0.1; // peak is 0.1
    const gain = normalizeAudioBuffer(buf);
    expect(gain).toBeCloseTo(8.9, 2);
    expect(ch[2]).toBeCloseTo(NORMALIZE_PEAK, 3);
  });

  it("slices external recording with silence padding where unplayed", () => {
    const recordingBuffer = new MemoryAudioBuffer(1, 1000, 1000);
    const src = recordingBuffer.getChannelData(0);
    for (let i = 0; i < 1000; i++) src[i] = (i + 1) / 1000;

    const mockRecording = {
      buffer: recordingBuffer as unknown as AudioBuffer,
      durationSeconds: 1.0,
      sampleRate: 1000,
      numberOfChannels: 1,
      peaks: new Float32Array(0),
    };

    // startTime: -0.5s, speed: 1.0, duration: 1.0s, offset: 0.0s
    // startFrame = -500. Out buffer length = 1000 frames.
    // Frames 0..500 should be silence (0).
    // Frames 500..1000 should receive src[0..500].
    const sliced = sliceRecordingAudio(mockRecording, -0.5, 1.0, 1.0, 0.0);
    expect(sliced.length).toBe(1000);
    const out = sliced.getChannelData(0);
    expect(out[0]).toBe(0);
    expect(out[499]).toBe(0);
    expect(out[500]).toBeCloseTo(1 / 1000, 4);
    expect(out[999]).toBeCloseTo(500 / 1000, 4);
  });

  it("renders silence when no PerformancePlan exists, regardless of SongDocument notes", async () => {
    const mockDoc: SongDocument = {
      schemaVersion: 1,
      projectId: "test-proj",
      revision: 0,
      title: "Test Piece",
      durationSeconds: 2.0,
      tracks: [{ trackId: "t1", instrumentIndex: 0, name: "Piano", program: 0, hand: null }],
      notes: [
        { noteId: "n1", trackId: "t1", pitch: 60, startSeconds: 0.0, endSeconds: 0.5, velocity: 80, hand: "right", finger: 1, glissando: false },
        { noteId: "n2", trackId: "t1", pitch: 64, startSeconds: 0.5, endSeconds: 1.0, velocity: 90, hand: "right", finger: 2, glissando: false },
      ],
      tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500000, eventOrdinal: 0 }],
      pedalControls: [],
    };

    const result = await renderOfflineAudio({
      document: mockDoc,
      speed: 1.0,
      startTime: -0.5,
      durationSeconds: 2.0,
      sampleRate: 22050,
    });

    expect(result.audioBuffer.length).toBe(22050 * 2);
    expect(result.wavBytes.length).toBeGreaterThan(44);
    expect(result.wavBlob.size).toBe(result.wavBytes.length);
    expect(result.audioBuffer.getChannelData(0).every((sample) => sample === 0)).toBe(true);
  });

  it("renders audio strictly using PerformancePlan events, producing bitwise distinct WAV on timing shift (A05)", async () => {
    const mockDoc: SongDocument = {
      schemaVersion: 1,
      projectId: "test-proj",
      revision: 0,
      title: "Test Piece",
      durationSeconds: 2.0,
      tracks: [{ trackId: "t1", instrumentIndex: 0, name: "Piano", program: 0, hand: null }],
      notes: [
        { noteId: "n1", trackId: "t1", pitch: 60, startSeconds: 0.0, endSeconds: 0.5, velocity: 80, hand: "right", finger: 1, glissando: false },
      ],
      tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500000, eventOrdinal: 0 }],
      pedalControls: [],
    };

    const planA = {
      schemaVersion: 1 as const,
      projectId: "test-proj",
      inputRevision: 0,
      profileId: "default",
      profileRevision: 0,
      engineVersion: "0".repeat(64),
      planId: "p1",
      kind: "performance" as const,
      fingeringPlanId: "f1",
      events: [
        { type: "press" as const, timeSeconds: 0.0, noteId: "n1", pitch: 60, velocity: 80 },
        { type: "release" as const, timeSeconds: 0.5, noteId: "n1" },
      ],
      diagnostics: [],
    };

    const planB = {
      ...planA,
      events: [
        { type: "press" as const, timeSeconds: 0.1, noteId: "n1", pitch: 60, velocity: 80 },
        { type: "release" as const, timeSeconds: 0.6, noteId: "n1" },
      ],
    };

    const resultA = await renderOfflineAudio({
      document: mockDoc,
      performancePlan: planA,
      speed: 1.0,
      startTime: 0.0,
      durationSeconds: 1.5,
      sampleRate: 22050,
    });

    const resultB = await renderOfflineAudio({
      document: mockDoc,
      performancePlan: planB,
      speed: 1.0,
      startTime: 0.0,
      durationSeconds: 1.5,
      sampleRate: 22050,
    });

    // Both produce valid WAVs with equal length
    expect(resultA.wavBytes.length).toBe(resultB.wavBytes.length);
    // But bitwise distinctly different due to timing shift of PerformancePlan
    expect(resultA.wavBytes).not.toEqual(resultB.wavBytes);
  });

  it("sustain pedal prolongs note ringing in rendered WAV", async () => {
    const mockDoc: SongDocument = {
      schemaVersion: 1,
      projectId: "test-proj",
      revision: 0,
      title: "Test Piece",
      durationSeconds: 2.0,
      tracks: [{ trackId: "t1", instrumentIndex: 0, name: "Piano", program: 0, hand: null }],
      notes: [{ noteId: "n1", trackId: "t1", pitch: 60, startSeconds: 0.0, endSeconds: 0.2, velocity: 90, hand: "right", finger: 1, glissando: false }],
      tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500000, eventOrdinal: 0 }],
      pedalControls: [],
    };

    const planWithoutSustain = {
      schemaVersion: 1 as const,
      projectId: "test-proj",
      inputRevision: 0,
      profileId: "default",
      profileRevision: 0,
      engineVersion: "0".repeat(64),
      planId: "p1",
      kind: "performance" as const,
      fingeringPlanId: "f1",
      events: [
        { type: "press" as const, timeSeconds: 0.0, noteId: "n1", pitch: 60, velocity: 90 },
        { type: "release" as const, timeSeconds: 0.2, noteId: "n1" },
      ],
      diagnostics: [],
    };

    const planWithSustain = {
      ...planWithoutSustain,
      events: [
        { type: "pedal" as const, timeSeconds: 0.0, controller: 64 as const, value: 127 as const },
        { type: "press" as const, timeSeconds: 0.0, noteId: "n1", pitch: 60, velocity: 90 },
        { type: "release" as const, timeSeconds: 0.2, noteId: "n1" },
        { type: "pedal" as const, timeSeconds: 1.0, controller: 64 as const, value: 0 as const },
      ],
    };

    const resNoSustain = await renderOfflineAudio({
      document: mockDoc,
      performancePlan: planWithoutSustain,
      speed: 1.0,
      startTime: 0.0,
      durationSeconds: 1.5,
      sampleRate: 22050,
    });

    const resWithSustain = await renderOfflineAudio({
      document: mockDoc,
      performancePlan: planWithSustain,
      speed: 1.0,
      startTime: 0.0,
      durationSeconds: 1.5,
      sampleRate: 22050,
    });

    // Check sample at t=0.5s (sample index 11025)
    // In resNoSustain, the damper dropped at 0.2s, so 0.5s is damped/decayed
    // In resWithSustain, damper remains held open by CC64 until 1.0s, so amplitude at 0.5s is noticeably higher
    const frameAt05s = Math.round(0.5 * 22050);
    const ampNoSustain = Math.abs(resNoSustain.audioBuffer.getChannelData(0)[frameAt05s]!);
    const ampWithSustain = Math.abs(resWithSustain.audioBuffer.getChannelData(0)[frameAt05s]!);

    expect(ampWithSustain).toBeGreaterThan(ampNoSustain);
  });
});
