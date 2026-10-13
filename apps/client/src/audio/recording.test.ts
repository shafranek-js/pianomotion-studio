import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  decodeAudioRecording,
  isAudioFormatSupported,
  MAX_AUDIO_FILE_SIZE_BYTES,
  generateWaveformPeaks,
  extractViewportPeaks,
  calculateDragOffset,
  PEAK_SLICE_SECONDS,
  SyncedAudioSource,
  Transport,
} from "./index.ts";

/**
 * Mock AudioParam for test environment.
 */
class MockAudioParam {
  public value: number;
  public readonly calls: Array<{ type: string; value?: number; time: number }> = [];

  constructor(initial = 0) {
    this.value = initial;
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.calls.push({ type: "setValueAtTime", value, time });
  }

  cancelScheduledValues(time: number): void {
    this.calls.push({ type: "cancelScheduledValues", time });
  }
}

/**
 * Mock AudioNode for test environment.
 */
class MockAudioNode {
  public destination: AudioNode | MockAudioNode | null = null;

  connect(dest: AudioNode | MockAudioNode): AudioNode | MockAudioNode {
    this.destination = dest;
    return dest;
  }

  disconnect(): void {
    this.destination = null;
  }
}

class MockGainNode extends MockAudioNode {
  public gain = new MockAudioParam(1);
}

class MockAudioBufferSourceNode extends MockAudioNode {
  public buffer: AudioBuffer | null = null;
  public started = false;
  public stopped = false;
  public startTime = 0;
  public startOffset = 0;
  public startDuration = 0;
  public onended: (() => void) | null = null;

  start(when = 0, offset = 0, duration?: number): void {
    this.started = true;
    this.startTime = when;
    this.startOffset = offset;
    this.startDuration = duration ?? 0;
  }

  stop(): void {
    this.stopped = true;
  }
}

/**
 * Mock AudioBuffer for unit testing waveform extraction and peak generation.
 */
class MockAudioBuffer {
  public readonly numberOfChannels: number;
  public readonly length: number;
  public readonly sampleRate: number;
  public readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(options: { numberOfChannels?: number; length: number; sampleRate: number }) {
    this.numberOfChannels = options.numberOfChannels ?? 1;
    this.length = options.length;
    this.sampleRate = options.sampleRate;
    this.duration = options.length / options.sampleRate;

    this.channels = [];
    for (let i = 0; i < this.numberOfChannels; i++) {
      this.channels.push(new Float32Array(this.length));
    }
  }

  getChannelData(channel: number): Float32Array {
    if (channel < 0 || channel >= this.numberOfChannels) {
      throw new Error(`Invalid channel index: ${channel}`);
    }
    return this.channels[channel]!;
  }
}

/**
 * Mock AudioContext for test environment.
 */
class MockAudioContext {
  public currentTime = 10.0;
  public state: AudioContextState = "running";
  public destination = new MockGainNode() as unknown as AudioNode;
  public lastCreatedSource: MockAudioBufferSourceNode | null = null;
  public lastCreatedGain: MockGainNode | null = null;

  createGain(): MockGainNode {
    const gain = new MockGainNode();
    this.lastCreatedGain = gain;
    return gain;
  }

  createBufferSource(): MockAudioBufferSourceNode {
    const src = new MockAudioBufferSourceNode();
    this.lastCreatedSource = src;
    return src;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    return new MockAudioBuffer({ numberOfChannels, length, sampleRate }) as unknown as AudioBuffer;
  }

  async resume(): Promise<void> {
    this.state = "running";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  async decodeAudioData(
    _audioData: ArrayBuffer,
    successCallback?: (decoded: AudioBuffer) => void,
    _errorCallback?: (error: Error) => void,
  ): Promise<AudioBuffer> {
    void _errorCallback;
    const buffer = new MockAudioBuffer({
      numberOfChannels: 2,
      length: 44100,
      sampleRate: 44100,
    }) as unknown as AudioBuffer;
    if (successCallback) {
      successCallback(buffer);
    }
    return buffer;
  }
}

describe("audioDecoder.ts", () => {
  describe("isAudioFormatSupported", () => {
    it("recognizes supported file extensions (.wav, .mp3, .ogg, .flac)", () => {
      expect(isAudioFormatSupported("song.wav")).toBe(true);
      expect(isAudioFormatSupported("TRACK.MP3")).toBe(true);
      expect(isAudioFormatSupported("recording.ogg")).toBe(true);
      expect(isAudioFormatSupported("piano_take.FLAC")).toBe(true);
      expect(isAudioFormatSupported("path/to/my/recording.wav")).toBe(true);
    });

    it("recognizes supported audio MIME types", () => {
      expect(isAudioFormatSupported("audio/wav")).toBe(true);
      expect(isAudioFormatSupported("audio/x-wav")).toBe(true);
      expect(isAudioFormatSupported("audio/mpeg")).toBe(true);
      expect(isAudioFormatSupported("audio/mp3")).toBe(true);
      expect(isAudioFormatSupported("audio/ogg")).toBe(true);
      expect(isAudioFormatSupported("audio/flac")).toBe(true);
      expect(isAudioFormatSupported("audio/wav; codecs=1")).toBe(true);
    });

    it("rejects unsupported extensions and MIME types", () => {
      expect(isAudioFormatSupported("song.mid")).toBe(false);
      expect(isAudioFormatSupported("song.midi")).toBe(false);
      expect(isAudioFormatSupported("notes.txt")).toBe(false);
      expect(isAudioFormatSupported("video.mp4")).toBe(false);
      expect(isAudioFormatSupported("audio/aac")).toBe(false);
      expect(isAudioFormatSupported("video/mp4")).toBe(false);
      expect(isAudioFormatSupported("image/png")).toBe(false);
      expect(isAudioFormatSupported("")).toBe(false);
    });
  });

  describe("decodeAudioRecording", () => {
    let mockContext: MockAudioContext;

    beforeEach(() => {
      mockContext = new MockAudioContext();
    });

    it("decodes valid ArrayBuffer successfully and computes 5ms peaks", async () => {
      const data = new ArrayBuffer(1024);
      const decoded = await decodeAudioRecording(data, mockContext as unknown as AudioContext);

      expect(decoded.buffer).toBeDefined();
      expect(decoded.durationSeconds).toBe(1.0);
      expect(decoded.sampleRate).toBe(44100);
      expect(decoded.numberOfChannels).toBe(2);
      expect(decoded.peaks).toBeInstanceOf(Float32Array);
      expect(decoded.peaks.length).toBeGreaterThan(0);
    });

    it("rejects empty buffer (0 bytes)", async () => {
      const emptyBuffer = new ArrayBuffer(0);
      await expect(
        decodeAudioRecording(emptyBuffer, mockContext as unknown as AudioContext),
      ).rejects.toThrow(/empty/i);
    });

    it("rejects file larger than 100 MiB", async () => {
      // Fake a large buffer or File-like object exceeding 100 MiB
      const oversizedObject = {
        name: "huge_recording.wav",
        size: MAX_AUDIO_FILE_SIZE_BYTES + 1,
        arrayBuffer: vi.fn(),
      } as unknown as File;

      await expect(
        decodeAudioRecording(oversizedObject, mockContext as unknown as AudioContext),
      ).rejects.toThrow(/exceeds maximum size of 100 MiB/i);
    });

    it("propagates decodeAudioData errors cleanly", async () => {
      const failingContext = new MockAudioContext();
      failingContext.decodeAudioData = vi.fn().mockRejectedValue(new Error("Corrupt audio stream"));

      const data = new ArrayBuffer(512);
      await expect(
        decodeAudioRecording(data, failingContext as unknown as AudioContext),
      ).rejects.toThrow(/Corrupt audio stream/);
    });
  });
});

describe("waveformGenerator.ts", () => {
  describe("generateWaveformPeaks", () => {
    it("verifies 5ms resolution at 44100 Hz", () => {
      // 44100 Hz * 0.005s = 220 samples per slice
      // A 1.0s buffer has 44100 samples -> 44100 / 220 = 200 slices
      const buffer = new MockAudioBuffer({
        numberOfChannels: 1,
        length: 44100,
        sampleRate: 44100,
      }) as unknown as AudioBuffer;

      const peaks = generateWaveformPeaks(buffer, PEAK_SLICE_SECONDS);
      const expectedSliceCount = Math.floor(44100 / Math.floor(0.005 * 44100));

      expect(expectedSliceCount).toBe(200);
      expect(peaks.length).toBe(200);
    });

    it("computes peak amplitude Math.max(Math.abs(min), Math.abs(max)) across all channels", () => {
      const sampleRate = 1000;
      const length = 50; // 5ms slice at 1000Hz = 5 samples -> 10 slices
      const mockBuffer = new MockAudioBuffer({
        numberOfChannels: 2,
        length,
        sampleRate,
      });

      const left = mockBuffer.getChannelData(0);
      const right = mockBuffer.getChannelData(1);

      // In slice 2 (samples 10..14), left has negative peak -0.75
      left[12] = -0.75;
      // In slice 4 (samples 20..24), right has positive peak +0.5
      right[22] = 0.5;

      const peaks = generateWaveformPeaks(mockBuffer as unknown as AudioBuffer, 0.005);
      expect(peaks.length).toBe(10);

      // Slice 2 had 0.75 amplitude, which is the global maximum, so after normalization it becomes 1.0
      expect(peaks[2]).toBeCloseTo(1.0, 5);
      // Slice 4 had 0.5 amplitude -> normalized to 0.5 / 0.75 = 0.6667
      expect(peaks[4]).toBeCloseTo(0.5 / 0.75, 4);
      // Slice 0 had 0 amplitude
      expect(peaks[0]).toBe(0);
    });

    it("normalizes peak amplitudes to [0, 1] range", () => {
      const mockBuffer = new MockAudioBuffer({
        numberOfChannels: 1,
        length: 100,
        sampleRate: 1000,
      });

      const data = mockBuffer.getChannelData(0);
      data[10] = 0.4;
      data[20] = 0.8; // max peak

      const peaks = generateWaveformPeaks(mockBuffer as unknown as AudioBuffer, 0.005);
      let maxVal = 0;
      for (let i = 0; i < peaks.length; i++) {
        if (peaks[i]! > maxVal) maxVal = peaks[i]!;
      }

      expect(maxVal).toBeCloseTo(1.0, 5);
    });

    it("handles zero or short buffers gracefully", () => {
      const emptyBuffer = new MockAudioBuffer({
        numberOfChannels: 1,
        length: 0,
        sampleRate: 44100,
      }) as unknown as AudioBuffer;

      const peaks = generateWaveformPeaks(emptyBuffer);
      expect(peaks.length).toBe(1);
      expect(peaks[0]).toBe(0);
    });
  });

  describe("extractViewportPeaks", () => {
    it("returns min and max arrays of exact targetWidthPx length with central symmetry", () => {
      const peaks = new Float32Array([0.1, 0.5, 0.9, 0.3, 0.0]);
      const totalDuration = 5.0; // 1.0s per slice

      const result = extractViewportPeaks(peaks, 0, 5, 100, totalDuration);

      expect(result.min.length).toBe(100);
      expect(result.max.length).toBe(100);

      // Verify symmetry min[x] === -max[x]
      for (let x = 0; x < 100; x++) {
        expect(result.min[x]).toBe(-result.max[x]!);
        expect(result.max[x]).toBeGreaterThanOrEqual(0);
      }
    });

    it("culls time ranges outside [0, totalDuration] to 0", () => {
      const peaks = new Float32Array([0.5, 0.8, 0.3]);
      const totalDuration = 3.0;

      // Entirely before start: [-5, -1]
      const before = extractViewportPeaks(peaks, -5, -1, 50, totalDuration);
      for (let i = 0; i < 50; i++) {
        expect(before.min[i]).toBe(0);
        expect(before.max[i]).toBe(0);
      }

      // Entirely after end: [10, 15]
      const after = extractViewportPeaks(peaks, 10, 15, 50, totalDuration);
      for (let i = 0; i < 50; i++) {
        expect(after.min[i]).toBe(0);
        expect(after.max[i]).toBe(0);
      }
    });

    it("samples highest peak within each column's time window", () => {
      const peaks = new Float32Array([0.1, 0.2, 0.9, 0.4]);
      const totalDuration = 4.0; // each slice is 1.0s

      // Viewport is exact 4 seconds across 4 pixels
      const result = extractViewportPeaks(peaks, 0, 4, 4, totalDuration);

      expect(result.max[0]).toBeCloseTo(0.1, 5);
      expect(result.max[1]).toBeCloseTo(0.2, 5);
      expect(result.max[2]).toBeCloseTo(0.9, 5);
      expect(result.max[3]).toBeCloseTo(0.4, 5);
    });
  });

  describe("calculateDragOffset", () => {
    it("quantizes coarse drag to 100ms (0.1s) steps when Shift is NOT held", () => {
      const pps = 500; // 500 px/s

      // 100px / 500 = +0.2s -> exactly 0.2s
      expect(calculateDragOffset(0, 100, pps, false)).toBe(0.2);

      // 25px / 500 = +0.05s -> rounds to 0.1s
      expect(calculateDragOffset(0, 25, pps, false)).toBe(0.1);

      // 15px / 500 = +0.03s -> rounds to 0.0s
      expect(calculateDragOffset(0, 15, pps, false)).toBe(0.0);

      // -60px / 500 = -0.12s -> rounds to -0.1s
      expect(calculateDragOffset(0, -60, pps, false)).toBe(-0.1);

      // Start at 1.05s, drag +25px (+0.05s) -> 1.1s
      expect(calculateDragOffset(1.05, 25, pps, false)).toBe(1.1);
    });

    it("quantizes fine drag to 10ms (0.01s) steps when Shift IS held", () => {
      const pps = 500; // 500 px/s

      // 25px / 500 = +0.05s -> exactly 0.05s (50ms)
      expect(calculateDragOffset(0, 25, pps, true)).toBe(0.05);

      // 12px / 500 = +0.024s -> rounds to 0.02s (20ms)
      expect(calculateDragOffset(0, 12, pps, true)).toBe(0.02);

      // 7px / 500 = +0.014s -> rounds to 0.01s (10ms)
      expect(calculateDragOffset(0, 7, pps, true)).toBe(0.01);

      // -18px / 500 = -0.036s -> rounds to -0.04s (-40ms)
      expect(calculateDragOffset(0, -18, pps, true)).toBe(-0.04);
    });
  });
});

describe("SyncedAudioSource", () => {
  let mockContext: MockAudioContext;
  let mockDestination: AudioNode;
  let sampleBuffer: AudioBuffer;

  beforeEach(() => {
    mockContext = new MockAudioContext();
    mockDestination = new MockGainNode() as unknown as AudioNode;
    sampleBuffer = new MockAudioBuffer({
      numberOfChannels: 2,
      length: 44100 * 10, // 10 seconds recording
      sampleRate: 44100,
    }) as unknown as AudioBuffer;
  });

  describe("Timing formulas matching audio_sync.py", () => {
    // Formula: audioTime = recordingOffsetSeconds + (songTime / speed)

    it("calculates audio time correctly at 1.0x speed with positive offset (+1.0s)", () => {
      const source = new SyncedAudioSource(1.0);
      expect(source.calculateAudioTime(0.0, 1.0)).toBe(1.0);
      expect(source.calculateAudioTime(2.5, 1.0)).toBe(3.5);
    });

    it("calculates audio time correctly at 0.5x speed with positive offset (+1.0s)", () => {
      const source = new SyncedAudioSource(1.0);
      // at 0.5x speed, 1 second of songTime takes 2 real seconds
      // audioTime = 1.0 + 1.0 / 0.5 = 3.0s
      expect(source.calculateAudioTime(1.0, 0.5)).toBe(3.0);
      expect(source.calculateAudioTime(2.0, 0.5)).toBe(5.0);
    });

    it("calculates audio time correctly at 2.0x speed with positive offset (+1.0s)", () => {
      const source = new SyncedAudioSource(1.0);
      // at 2.0x speed, 1 second of songTime takes 0.5 real seconds
      // audioTime = 1.0 + 1.0 / 2.0 = 1.5s
      expect(source.calculateAudioTime(1.0, 2.0)).toBe(1.5);
      expect(source.calculateAudioTime(4.0, 2.0)).toBe(3.0);
    });

    it("calculates negative audio time during lead-in with negative offset (-2.0s)", () => {
      const source = new SyncedAudioSource(-2.0);
      // at songTime = 0.0, recording is at -2.0s (delay = 2.0s)
      expect(source.calculateAudioTime(0.0, 1.0)).toBe(-2.0);

      // at 0.5x speed, songTime = 1.0 -> -2.0 + 1.0 / 0.5 = 0.0s (recording begins now!)
      expect(source.calculateAudioTime(1.0, 0.5)).toBe(0.0);

      // at 2.0x speed, songTime = 1.0 -> -2.0 + 1.0 / 2.0 = -1.5s (still 1.5s before start)
      expect(source.calculateAudioTime(1.0, 2.0)).toBe(-1.5);

      // at 2.0x speed, songTime = 4.0 -> -2.0 + 4.0 / 2.0 = 0.0s
      expect(source.calculateAudioTime(4.0, 2.0)).toBe(0.0);
    });
  });

  describe("Playback lifecycle and controls", () => {
    it("attaches recording and connects internal gain node to destination", () => {
      const source = new SyncedAudioSource(0.0, 0.8);
      const recording = {
        buffer: sampleBuffer,
        durationSeconds: 10.0,
        sampleRate: 44100,
        numberOfChannels: 2,
        peaks: new Float32Array(2000),
      };

      source.attach(recording, mockContext as unknown as AudioContext, mockDestination);

      expect(mockContext.lastCreatedGain).not.toBeNull();
      expect(mockContext.lastCreatedGain?.destination).toBe(mockDestination);
      expect(source.getRecording()).toBe(recording);
      expect(source.getVolume()).toBe(0.8);
    });

    it("plays from immediate offset when audioTime >= 0", () => {
      const source = new SyncedAudioSource(1.5);
      const recording = {
        buffer: sampleBuffer,
        durationSeconds: 10.0,
        sampleRate: 44100,
        numberOfChannels: 2,
        peaks: new Float32Array(2000),
      };

      source.attach(recording, mockContext as unknown as AudioContext, mockDestination);
      source.play(0.0, 1.0); // audioTime = 1.5

      expect(source.isPlaying()).toBe(true);
      const bufferNode = mockContext.lastCreatedSource;
      expect(bufferNode).not.toBeNull();
      expect(bufferNode?.started).toBe(true);
      expect(bufferNode?.startTime).toBe(mockContext.currentTime);
      expect(bufferNode?.startOffset).toBe(1.5);
    });

    it("schedules future start with delay when audioTime < 0", () => {
      const source = new SyncedAudioSource(-2.0);
      const recording = {
        buffer: sampleBuffer,
        durationSeconds: 10.0,
        sampleRate: 44100,
        numberOfChannels: 2,
        peaks: new Float32Array(2000),
      };

      source.attach(recording, mockContext as unknown as AudioContext, mockDestination);
      source.play(0.0, 1.0); // audioTime = -2.0s -> delay 2.0s

      expect(source.isPlaying()).toBe(true);
      const bufferNode = mockContext.lastCreatedSource;
      expect(bufferNode?.startTime).toBe(mockContext.currentTime + 2.0);
      expect(bufferNode?.startOffset).toBe(0.0);
    });

    it("pauses active playback and stops source node", () => {
      const source = new SyncedAudioSource(0.0);
      const recording = {
        buffer: sampleBuffer,
        durationSeconds: 10.0,
        sampleRate: 44100,
        numberOfChannels: 2,
        peaks: new Float32Array(2000),
      };

      source.attach(recording, mockContext as unknown as AudioContext, mockDestination);
      source.play(0.0, 1.0);
      expect(source.isPlaying()).toBe(true);

      const bufferNode = mockContext.lastCreatedSource;
      source.pause();
      expect(source.isPlaying()).toBe(false);
      expect(bufferNode?.stopped).toBe(true);
    });

    it("seeks and restarts playback if currently playing", () => {
      const source = new SyncedAudioSource(0.0);
      const recording = {
        buffer: sampleBuffer,
        durationSeconds: 10.0,
        sampleRate: 44100,
        numberOfChannels: 2,
        peaks: new Float32Array(2000),
      };

      source.attach(recording, mockContext as unknown as AudioContext, mockDestination);
      source.play(1.0, 1.0);

      // Seek to 4.0s
      source.seek(4.0, 1.0);
      expect(source.isPlaying()).toBe(true);
      const newSource = mockContext.lastCreatedSource;
      expect(newSource?.startOffset).toBe(4.0);
    });

    it("updates offset and resyncs if playing", () => {
      const source = new SyncedAudioSource(0.0);
      const recording = {
        buffer: sampleBuffer,
        durationSeconds: 10.0,
        sampleRate: 44100,
        numberOfChannels: 2,
        peaks: new Float32Array(2000),
      };

      source.attach(recording, mockContext as unknown as AudioContext, mockDestination);
      source.play(2.0, 1.0);

      source.setOffset(0.5, 2.0, 1.0);
      expect(source.getOffset()).toBe(0.5);

      const updatedSource = mockContext.lastCreatedSource;
      // audioTime = 0.5 + 2.0 / 1.0 = 2.5
      expect(updatedSource?.startOffset).toBe(2.5);
    });

    it("controls volume and mute state", () => {
      const source = new SyncedAudioSource(0.0, 0.5);
      const recording = {
        buffer: sampleBuffer,
        durationSeconds: 10.0,
        sampleRate: 44100,
        numberOfChannels: 2,
        peaks: new Float32Array(2000),
      };

      source.attach(recording, mockContext as unknown as AudioContext, mockDestination);
      const gainNode = mockContext.lastCreatedGain!;

      source.setVolume(0.9);
      expect(source.getVolume()).toBe(0.9);
      expect(gainNode.gain.value).toBe(0.9);

      source.setMuted(true);
      expect(source.isMuted()).toBe(true);
      expect(gainNode.gain.value).toBe(0);

      source.setMuted(false);
      expect(source.isMuted()).toBe(false);
      expect(gainNode.gain.value).toBe(0.9);
    });

    it("disposes resources cleanly", () => {
      const source = new SyncedAudioSource(0.0);
      const recording = {
        buffer: sampleBuffer,
        durationSeconds: 10.0,
        sampleRate: 44100,
        numberOfChannels: 2,
        peaks: new Float32Array(2000),
      };

      source.attach(recording, mockContext as unknown as AudioContext, mockDestination);
      source.play(0.0, 1.0);
      source.dispose();

      expect(source.isPlaying()).toBe(false);
      expect(source.getRecording()).toBeNull();
    });
  });
});

describe("Transport integration with SyncedAudioSource", () => {
  let mockContext: MockAudioContext;
  let sampleBuffer: AudioBuffer;

  beforeEach(() => {
    mockContext = new MockAudioContext();
    sampleBuffer = new MockAudioBuffer({
      numberOfChannels: 2,
      length: 44100 * 5,
      sampleRate: 44100,
    }) as unknown as AudioBuffer;
  });

  it("attaches and forwards play, pause, seek, setSpeed, and setVolume to SyncedAudioSource", async () => {
    const transport = new Transport({
      audioContext: mockContext as unknown as AudioContext,
    });
    transport.setDuration(10.0);
    const syncedAudio = new SyncedAudioSource(0.0, 0.8);
    const recording = {
      buffer: sampleBuffer,
      durationSeconds: 5.0,
      sampleRate: 44100,
      numberOfChannels: 2,
      peaks: new Float32Array(1000),
    };

    syncedAudio.attach(recording, mockContext as unknown as AudioContext, mockContext.destination);
    transport.setSyncedAudio(syncedAudio);

    expect(transport.getSyncedAudio()).toBe(syncedAudio);

    const playSpy = vi.spyOn(syncedAudio, "play");
    const pauseSpy = vi.spyOn(syncedAudio, "pause");
    const seekSpy = vi.spyOn(syncedAudio, "seek");
    const volumeSpy = vi.spyOn(syncedAudio, "setVolume");

    await transport.play();
    expect(playSpy).toHaveBeenCalled();

    transport.seek(2.0);
    expect(seekSpy).toHaveBeenCalledWith(2.0, transport.getSpeed());

    transport.setSpeed(1.5);
    expect(seekSpy).toHaveBeenCalled();

    transport.setVolume(0.5);
    expect(volumeSpy).toHaveBeenCalledWith(0.5);

    transport.pause();
    expect(pauseSpy).toHaveBeenCalled();

    transport.dispose();
    expect(transport.getSyncedAudio()).toBeNull();
  });
});
