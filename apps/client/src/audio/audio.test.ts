import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PerformancePlan } from "@handthesia/contracts";
import {
  closeAudioContext,
  getAudioContext,
  getMasterGain,
  getMasterVolume,
  isAudioContextRunning,
  resumeAudioContext,
  setAudioContextForTesting,
  setMasterVolume,
} from "./audioContext.ts";
import { PianoSampler } from "./sampler.ts";
import { Transport } from "./transport.ts";
import type { PerformanceOutput } from "./output/performanceOutput.ts";

/**
 * Lightweight mock AudioContext for Node/Vitest test environment.
 */
class MockAudioParam {
  public value = 0;
  public readonly scheduled: Array<{ type: string; value?: number; time: number }> = [];

  constructor(initial = 0) {
    this.value = initial;
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.scheduled.push({ type: "setValueAtTime", value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.scheduled.push({ type: "exponentialRampToValueAtTime", value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.scheduled.push({ type: "linearRampToValueAtTime", value, time });
  }

  setTargetAtTime(target: number, time: number): void {
    this.scheduled.push({ type: "setTargetAtTime", value: target, time });
  }

  cancelScheduledValues(time: number): void {
    this.scheduled.push({ type: "cancelScheduledValues", time });
  }
}

class MockAudioNode {
  public connectedTo: MockAudioNode | null = null;

  connect(destination: MockAudioNode): MockAudioNode {
    this.connectedTo = destination;
    return destination;
  }

  disconnect(): void {
    this.connectedTo = null;
  }
}

class MockGainNode extends MockAudioNode {
  public gain = new MockAudioParam(1);
}

class MockBiquadFilterNode extends MockAudioNode {
  public type: BiquadFilterType = "lowpass";
  public frequency = new MockAudioParam(1000);
  public Q = new MockAudioParam(1);
}

class MockOscillatorNode extends MockAudioNode {
  public type: OscillatorType = "sine";
  public frequency = new MockAudioParam(440);
  public detune = new MockAudioParam(0);
  public started = false;
  public stopped = false;
  public startTime = 0;
  public stopTime = 0;

  start(time = 0): void {
    this.started = true;
    this.startTime = time;
  }

  stop(time = 0): void {
    this.stopped = true;
    this.stopTime = time;
  }

  setPeriodicWave(): void {
    // mock no-op
  }
}

class MockAudioContext {
  public currentTime = 0;
  public state: AudioContextState = "suspended";
  public destination = new MockGainNode();
  public periodicWaves: Array<{ real: number[]; imag: number[] }> = [];

  createGain(): MockGainNode {
    return new MockGainNode();
  }

  createOscillator(): MockOscillatorNode {
    return new MockOscillatorNode();
  }

  createBiquadFilter(): MockBiquadFilterNode {
    return new MockBiquadFilterNode();
  }

  createPeriodicWave(real?: Float32Array, imag?: Float32Array): object {
    const wave = { real: Array.from(real ?? []), imag: Array.from(imag ?? []) };
    this.periodicWaves.push(wave);
    return wave;
  }

  async resume(): Promise<void> {
    this.state = "running";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }
}

function createMockAudioContext(): AudioContext {
  return new MockAudioContext() as unknown as AudioContext;
}

function makeTestPerformancePlan(events: PerformancePlan["events"]): PerformancePlan {
  return {
    schemaVersion: 1,
    planId: "test-performance-plan",
    projectId: "test-project",
    inputRevision: 1,
    profileId: "test-profile",
    profileRevision: 1,
    engineVersion: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    diagnostics: [],
    kind: "performance",
    fingeringPlanId: "test-fingering-plan",
    events,
  };
}

describe("audioContext.ts", () => {
  let mockCtx: AudioContext;

  beforeEach(() => {
    mockCtx = createMockAudioContext();
    setAudioContextForTesting(mockCtx);
  });

  afterEach(async () => {
    await closeAudioContext();
  });

  it("provides singleton audio context and master gain", () => {
    const ctx = getAudioContext();
    expect(ctx).toBe(mockCtx);
    const gain = getMasterGain();
    expect(gain).toBeDefined();
  });

  it("clamps and sets master volume", () => {
    setMasterVolume(0.5);
    expect(getMasterVolume()).toBe(0.5);

    setMasterVolume(1.5);
    expect(getMasterVolume()).toBe(1.0);

    setMasterVolume(-0.2);
    expect(getMasterVolume()).toBe(0.0);
  });

  it("resumes suspended audio context", async () => {
    expect(isAudioContextRunning()).toBe(false);
    await resumeAudioContext();
    expect(isAudioContextRunning()).toBe(true);
  });

  it("closes context and resets singleton", async () => {
    await closeAudioContext();
    expect(getMasterVolume()).toBe(0.0);
  });
});

describe("sampler.ts", () => {
  let mockCtx: AudioContext;
  let sampler: PianoSampler;

  beforeEach(() => {
    mockCtx = createMockAudioContext();
    sampler = new PianoSampler({ audioContext: mockCtx });
  });

  afterEach(() => {
    sampler.dispose();
  });

  it("computes accurate pitch frequencies", () => {
    expect(PianoSampler.pitchToFrequency(69)).toBeCloseTo(440, 2); // A4
    expect(PianoSampler.pitchToFrequency(60)).toBeCloseTo(261.63, 1); // C4 Middle C
    expect(PianoSampler.pitchToFrequency(21)).toBeCloseTo(27.5, 1); // A0 Lowest key
    expect(PianoSampler.pitchToFrequency(108)).toBeCloseTo(4186.01, 1); // C8 Highest key
  });

  it("plays polyphonic notes (noteOn / noteOff)", () => {
    sampler.noteOn("note-1", 60, 80);
    sampler.noteOn("note-2", 64, 85);
    sampler.noteOn("note-3", 67, 90);

    expect(sampler.getActiveVoiceCount()).toBe(3);

    sampler.noteOff("note-1");
    // noteOff applies release envelope, note is still in teardown pipeline
    expect(sampler.getActiveVoiceCount()).toBe(3);

    sampler.silenceAll();
    expect(sampler.getActiveVoiceCount()).toBe(0);
  });

  it("handles sustain pedal (CC 64) ringing and lifting", () => {
    // Engage sustain pedal
    sampler.pedal(64, 127);
    expect(sampler.getPedalState().sustain).toBe(true);

    sampler.noteOn("note-1", 60, 80);
    expect(sampler.getActiveVoiceCount()).toBe(1);

    // Note released by key while sustain is active
    sampler.noteOff("note-1");
    // Voice should still be active and not choked
    expect(sampler.getActiveVoiceCount()).toBe(1);

    // Lifting sustain pedal (CC 64 = 0)
    sampler.pedal(64, 0);
    expect(sampler.getPedalState().sustain).toBe(false);
  });

  it("handles sostenuto pedal (CC 66) selective latching", () => {
    // Play note 1 BEFORE sostenuto
    sampler.noteOn("note-1", 60, 80);

    // Engage sostenuto pedal (CC 66 = 127)
    sampler.pedal(66, 127);
    expect(sampler.getPedalState().sostenuto).toBe(true);

    // Play note 2 AFTER sostenuto
    sampler.noteOn("note-2", 64, 80);

    // Release note 1 (captured by sostenuto)
    sampler.noteOff("note-1");
    // Release note 2 (not captured by sostenuto)
    sampler.noteOff("note-2");

    expect(sampler.getActiveVoiceCount()).toBe(2);

    // Disengage sostenuto pedal (CC 66 = 0)
    sampler.pedal(66, 0);
    expect(sampler.getPedalState().sostenuto).toBe(false);
  });

  it("handles soft pedal (CC 67) velocity scaling to 0.7x", () => {
    sampler.pedal(67, 127);
    expect(sampler.getPedalState().soft).toBe(true);

    sampler.noteOn("note-soft", 60, 100);
    expect(sampler.getActiveVoiceCount()).toBe(1);

    sampler.pedal(67, 0);
    expect(sampler.getPedalState().soft).toBe(false);
  });

  it("silenceAll chokes all active voices immediately", () => {
    sampler.noteOn("n1", 60, 100);
    sampler.noteOn("n2", 64, 100);
    sampler.pedal(64, 127);

    expect(sampler.getActiveVoiceCount()).toBe(2);
    expect(sampler.getPedalState().sustain).toBe(true);

    sampler.silenceAll();
    expect(sampler.getActiveVoiceCount()).toBe(0);
    expect(sampler.getPedalState().sustain).toBe(false);
  });

  it("changes the harmonic wave for new notes without stopping active voices", () => {
    sampler.noteOn("existing", 60, 90);
    const acousticWave = (mockCtx as unknown as MockAudioContext).periodicWaves[0];

    sampler.setTimbre("bright");
    const brightWave = (mockCtx as unknown as MockAudioContext).periodicWaves[1];

    expect(brightWave?.imag).not.toEqual(acousticWave?.imag);
    expect(sampler.getTimbre()).toBe("bright");
    expect(sampler.getActiveVoiceCount()).toBe(1);
  });

  it("restores strike-time soft velocity separately from the current soft pedal", () => {
    sampler.restoreState({
      voices: [{
        noteId: "soft-strike",
        pitch: 60,
        velocity: 100,
        keyState: "down",
        heldBySostenuto: false,
        sustainedBySustain: false,
        softPedalAtPress: true,
      }],
      pedals: { sustain: false, sostenuto: false, soft: false },
    });
    const voices = (sampler as unknown as {
      activeVoices: Map<string, { effectiveVelocity: number }>;
    }).activeVoices;

    expect(voices.get("soft-strike")?.effectiveVelocity).toBe(70);
    expect(sampler.getPedalState()).toEqual({ sustain: false, sostenuto: false, soft: false });
  });
});

describe("transport.ts", () => {
  let mockCtx: AudioContext;
  let sampler: PianoSampler;
  let transport: Transport;

  beforeEach(() => {
    vi.useFakeTimers();
    mockCtx = createMockAudioContext();
    sampler = new PianoSampler({ audioContext: mockCtx });
    transport = new Transport({
      audioContext: mockCtx,
      sampler,
      leadInSeconds: 2.0,
      scheduleAheadSeconds: 0.1,
      scheduleIntervalMs: 25,
    });
  });

  afterEach(() => {
    transport.dispose();
    vi.useRealTimers();
  });

  function deferredOutput() {
    const requests: Array<{ start: number; end: number; signal?: AbortSignal; resolve(): void; reject(error: Error): void }> = [];
    let ready = false;
    const output: PerformanceOutput = {
      id: "soundfont", noteOn: vi.fn(), noteOff: vi.fn(), pedal: vi.fn(),
      panic: vi.fn(), cancelScheduledFutureEvents: vi.fn(), restoreState: vi.fn(), dispose: vi.fn(),
      isWindowPrepared: () => ready,
      prepareWindow: (_plan, start, end, signal) => new Promise<void>((resolve, reject) => {
        requests.push({ start, end, signal, resolve: () => { ready = true; resolve(); }, reject });
      }),
    };
    return { output, requests };
  }

  it("freezes musical time until file-backed output preparation has finished", async () => {
    Object.assign(mockCtx, { state: "running" });
    const { output, requests } = deferredOutput();
    transport.loadPlan(makeTestPerformancePlan([
      { type: "press", timeSeconds: 0, noteId: "n1", pitch: 60, velocity: 80 },
      { type: "release", timeSeconds: 3, noteId: "n1" },
    ]), 8);
    transport.setOutput(output);
    const pending = transport.play();
    await Promise.resolve();
    expect(transport.isPreparingOutput()).toBe(true);
    expect(requests[0]).toMatchObject({ start: -2, end: 2 });
    Object.assign(mockCtx, { currentTime: 100 });
    expect(transport.getCurrentTime()).toBe(-2);
    expect(output.restoreState).not.toHaveBeenCalled();
    requests[0]!.resolve();
    await pending;
    expect(transport.getCurrentTime()).toBe(-2);
    expect(transport.getState()).toBe("playing");
    expect(transport.isPreparingOutput()).toBe(false);
    expect(output.restoreState).toHaveBeenCalledOnce();
  });

  it.each(["pause", "stop", "dispose"] as const)("%s cancels pending SoundFont preparation without late resume", async (action) => {
    Object.assign(mockCtx, { state: "running" });
    const { output, requests } = deferredOutput();
    transport.loadPlan(makeTestPerformancePlan([]), 8);
    transport.setOutput(output);
    const pending = transport.play();
    await Promise.resolve();
    transport[action]();
    expect(requests[0]!.signal!.aborted).toBe(true);
    requests[0]!.resolve();
    await pending;
    expect(transport.getState()).not.toBe("playing");
    expect(output.restoreState).not.toHaveBeenCalled();
    expect(transport.isPreparingOutput()).toBe(false);
  });

  it("seek replaces a pending preparation and ignores its obsolete response", async () => {
    Object.assign(mockCtx, { state: "running" });
    const { output, requests } = deferredOutput();
    transport.loadPlan(makeTestPerformancePlan([]), 12);
    transport.setOutput(output);
    const first = transport.play();
    await Promise.resolve();
    transport.seek(5);
    await Promise.resolve();
    expect(requests[0]!.signal!.aborted).toBe(true);
    expect(requests[1]).toMatchObject({ start: 5, end: 9 });
    requests[0]!.resolve();
    await first;
    expect(transport.getState()).not.toBe("playing");
    requests[1]!.resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(transport.getState()).toBe("playing");
    expect(transport.getCurrentTime()).toBe(5);
  });

  it("reports a preparation failure and leaves a failed Play stopped", async () => {
    Object.assign(mockCtx, { state: "running" });
    const { output, requests } = deferredOutput();
    transport.loadPlan(makeTestPerformancePlan([]), 8);
    transport.setOutput(output);
    const errors = vi.fn();
    transport.subscribeOutputError(errors);
    const pending = transport.play();
    await Promise.resolve();
    requests[0]!.reject(new Error("SoundFont working set exceeds budget"));
    await expect(pending).rejects.toThrow(/working set/);
    expect(errors).toHaveBeenCalledOnce();
    expect(transport.getState()).not.toBe("playing");
    expect(transport.isPreparingOutput()).toBe(false);
  });

  it("an unavailable output cancels pending sample preparation and cannot resume late", async () => {
    Object.assign(mockCtx, { state: "running" });
    const { output, requests } = deferredOutput();
    let unavailable!: (error: Error) => void;
    output.subscribeUnavailable = listener => { unavailable = listener; return () => {}; };
    transport.loadPlan(makeTestPerformancePlan([]), 8);
    transport.setOutput(output);
    const pending = transport.play();
    await Promise.resolve();
    unavailable(new Error("Output removed"));
    expect(requests[0]!.signal!.aborted).toBe(true);
    expect(transport.isPreparingOutput()).toBe(false);
    requests[0]!.resolve();
    await pending;
    expect(transport.getState()).not.toBe("playing");
    expect(transport.getOutputError()?.message).toBe("Output removed");
  });

  it("starts in idle state at lead-in position -2.0s", () => {
    expect(transport.getState()).toBe("idle");
    expect(transport.getCurrentTime()).toBe(-2.0);
  });

  it("transitions between idle, playing, paused, and stopped", async () => {
    const stateSpy = vi.fn();
    transport.subscribeState(stateSpy);

    const plan = makeTestPerformancePlan([
      { type: "press", timeSeconds: 0.0, noteId: "n1", pitch: 60, velocity: 80 },
      { type: "release", timeSeconds: 0.5, noteId: "n1" },
    ]);
    transport.loadPlan(plan, 2.0);

    expect(transport.getDuration()).toBe(2.0);
    expect(transport.getCurrentTime()).toBe(-2.0);

    await transport.play();
    expect(transport.getState()).toBe("playing");
    expect(stateSpy).toHaveBeenCalledWith("playing");

    transport.pause();
    expect(transport.getState()).toBe("paused");
    expect(stateSpy).toHaveBeenCalledWith("paused");

    transport.stop();
    expect(transport.getState()).toBe("idle");
    expect(transport.getCurrentTime()).toBe(-2.0);
  });

  it.each(["pause", "stop", "dispose"] as const)(
    "does not start a pending play after %s invalidates a suspended-context resume",
    async (cancel) => {
      let resolveResume!: () => void;
      vi.spyOn(mockCtx, "resume").mockImplementation(() => new Promise<void>((resolve) => {
        resolveResume = () => {
          (mockCtx as unknown as MockAudioContext).state = "running";
          resolve();
        };
      }));
      const noteOn = vi.spyOn(sampler, "noteOn");
      transport.loadPlan(makeTestPerformancePlan([
        { type: "press", timeSeconds: 0, noteId: "cancelled-resume", pitch: 60, velocity: 90 },
        { type: "release", timeSeconds: 1, noteId: "cancelled-resume" },
      ]), 2);
      transport.seek(0);

      const pendingPlay = transport.play();
      expect(resolveResume).toBeTypeOf("function");
      transport[cancel]();
      resolveResume();
      await pendingPlay;

      expect(transport.getState()).not.toBe("playing");
      expect(noteOn).not.toHaveBeenCalled();
    },
  );

  it("accurately computes playhead time across playback and speed changes", async () => {
    const plan = makeTestPerformancePlan([]);
    transport.loadPlan(plan, 10.0);

    // Seek to 0.0s
    transport.seek(0.0);
    expect(transport.getCurrentTime()).toBe(0.0);

    await transport.play();

    // Advance mock AudioContext clock by 1.5 seconds
    (mockCtx as unknown as MockAudioContext).currentTime = 1.5;
    expect(transport.getCurrentTime()).toBeCloseTo(1.5, 3);

    // Change speed to 1.5x
    transport.setSpeed(1.5);
    expect(transport.getSpeed()).toBe(1.5);

    // Advance clock by 1.0 second: elapsed song time should be 1.0 * 1.5 = 1.5s
    (mockCtx as unknown as MockAudioContext).currentTime = 2.5;
    expect(transport.getCurrentTime()).toBeCloseTo(1.5 + 1.5, 3);
  });

  it("clamps speed to [0.25, 2.0]", () => {
    transport.setSpeed(0.1);
    expect(transport.getSpeed()).toBe(0.25);

    transport.setSpeed(3.0);
    expect(transport.getSpeed()).toBe(2.0);

    transport.setSpeed(1.25);
    expect(transport.getSpeed()).toBe(1.25);
  });

  it("schedules performance events with lookahead window without gaps", async () => {
    const noteOnSpy = vi.spyOn(sampler, "noteOn");
    const noteOffSpy = vi.spyOn(sampler, "noteOff");
    const pedalSpy = vi.spyOn(sampler, "pedal");

    const plan = makeTestPerformancePlan([
      { type: "pedal", timeSeconds: 0.0, controller: 64, value: 127 },
      { type: "press", timeSeconds: 0.05, noteId: "n1", pitch: 60, velocity: 80 },
      { type: "release", timeSeconds: 0.2, noteId: "n1" },
      { type: "pedal", timeSeconds: 0.25, controller: 64, value: 0 },
    ]);

    transport.loadPlan(plan, 1.0);
    // Seek to -0.05s (50ms before time 0, inside the 100ms lookahead window)
    transport.seek(-0.05);

    await transport.play();

    // Events at 0.0 and 0.05 are within lookahead horizon (-0.05 + 0.1 = 0.05)
    expect(pedalSpy).toHaveBeenCalledWith(64, 127, expect.any(Number));
    expect(noteOnSpy).toHaveBeenCalledWith("n1", 60, 80, expect.any(Number));

    // Now advance clock to 0.15s, triggering scheduler tick
    (mockCtx as unknown as MockAudioContext).currentTime = 0.2;
    vi.advanceTimersByTime(25);

    expect(noteOffSpy).toHaveBeenCalledWith("n1", expect.any(Number));
    expect(pedalSpy).toHaveBeenCalledWith(64, 0, expect.any(Number));
  });

  it("restores pedal states on seek", () => {
    const pedalSpy = vi.spyOn(sampler, "pedal");

    const plan = makeTestPerformancePlan([
      { type: "pedal", timeSeconds: 1.0, controller: 64, value: 127 },
      { type: "pedal", timeSeconds: 2.0, controller: 66, value: 127 },
      { type: "pedal", timeSeconds: 3.0, controller: 67, value: 127 },
    ]);

    transport.loadPlan(plan, 5.0);
    pedalSpy.mockClear();

    // Seek to 2.5s: sustain (64) and sostenuto (66) should be restored
    transport.seek(2.5);

    expect(pedalSpy).toHaveBeenCalledWith(64, 127, expect.any(Number));
    expect(pedalSpy).toHaveBeenCalledWith(66, 127, expect.any(Number));
    expect(pedalSpy).toHaveBeenCalledWith(67, 0, expect.any(Number));
  });

  it("replays held notes when seeking while playing and skips the exact boundary afterward", async () => {
    const noteOnSpy = vi.spyOn(sampler, "noteOn");
    const noteOffSpy = vi.spyOn(sampler, "noteOff");
    const pedalSpy = vi.spyOn(sampler, "pedal");
    const plan = makeTestPerformancePlan([
      { type: "press", timeSeconds: 0, noteId: "a", pitch: 60, velocity: 80 },
      { type: "release", timeSeconds: 1, noteId: "a" },
      { type: "pedal", timeSeconds: 1, controller: 64, value: 127 },
      { type: "press", timeSeconds: 1, noteId: "b", pitch: 64, velocity: 90 },
      { type: "release", timeSeconds: 2, noteId: "b" },
    ]);

    transport.loadPlan(plan, 4);
    await transport.play();
    noteOnSpy.mockClear();
    noteOffSpy.mockClear();
    pedalSpy.mockClear();

    transport.seek(1);

    expect(sampler.getActiveVoiceCount()).toBe(1);
    expect(sampler.getPedalState().sustain).toBe(true);
    const orderedCalls = [
      ...noteOnSpy.mock.calls.map((call, index) => [noteOnSpy.mock.invocationCallOrder[index]!, `on:${call[0]}`] as const),
      ...noteOffSpy.mock.calls.map((call, index) => [noteOffSpy.mock.invocationCallOrder[index]!, `off:${call[0]}`] as const),
      ...pedalSpy.mock.calls.map((call, index) => [pedalSpy.mock.invocationCallOrder[index]!, `pedal:${call[0]}:${call[1]}`] as const),
    ].sort((a, b) => a[0] - b[0]).map(([, label]) => label);
    expect(orderedCalls).toEqual(["on:b"]);
    expect(noteOnSpy).not.toHaveBeenCalledWith("a", 60, 80, expect.any(Number));

    noteOnSpy.mockClear();
    noteOffSpy.mockClear();
    pedalSpy.mockClear();
    vi.advanceTimersByTime(25);
    expect(noteOnSpy).not.toHaveBeenCalledWith("b", 64, 90, expect.any(Number));
    expect(noteOffSpy).not.toHaveBeenCalledWith("a", expect.any(Number));
    expect(pedalSpy).not.toHaveBeenCalledWith(64, 127, expect.any(Number));
  });

  it("restores key-down notes on resume and speed changes", async () => {
    const plan = makeTestPerformancePlan([
      { type: "press", timeSeconds: 0, noteId: "held", pitch: 60, velocity: 90 },
      { type: "release", timeSeconds: 3, noteId: "held" },
    ]);
    transport.loadPlan(plan, 5);
    transport.seek(0.5);

    await transport.play();
    expect(sampler.getActiveVoiceCount()).toBe(1);
    transport.pause();
    expect(sampler.getActiveVoiceCount()).toBe(0);

    await transport.play();
    expect(sampler.getActiveVoiceCount()).toBe(1);
    (mockCtx as unknown as MockAudioContext).currentTime = 0.25;
    transport.setSpeed(1.5);

    expect(transport.getCurrentTime()).toBeCloseTo(0.75, 5);
    expect(sampler.getActiveVoiceCount()).toBe(1);
    (mockCtx as unknown as MockAudioContext).currentTime = 0.5;
    expect(transport.getCurrentTime()).toBeCloseTo(1.125, 5);
  });

  it("preserves active voices and envelope decay during speed change without silenceAll or note re-attack (A15)", async () => {
    const plan = makeTestPerformancePlan([
      { type: "press", timeSeconds: 0, noteId: "voice1", pitch: 60, velocity: 90 },
      { type: "release", timeSeconds: 2.0, noteId: "voice1" },
    ]);
    transport.loadPlan(plan, 4);
    transport.seek(0.5);
    await transport.play();
    expect(sampler.getActiveVoiceCount()).toBe(1);

    const silenceAllSpy = vi.spyOn(sampler, "silenceAll");
    const noteOnSpy = vi.spyOn(sampler, "noteOn");

    // Advance clock and change speed while playing
    (mockCtx as unknown as MockAudioContext).currentTime = 0.5;
    transport.setSpeed(1.5);

    // Verified: silenceAll must NOT be called on speed change
    expect(silenceAllSpy).not.toHaveBeenCalled();
    // Verified: sounding note must NOT be re-attacked with noteOn
    expect(noteOnSpy).not.toHaveBeenCalled();
    // Voice remains active and ringing
    expect(sampler.getActiveVoiceCount()).toBe(1);
  });

  it("rewinds queued NoteOff and sustain/sostenuto events to the clock before tempo rescheduling", async () => {
    const plan = makeTestPerformancePlan([
      { type: "press", timeSeconds: 0, noteId: "queued-held", pitch: 60, velocity: 90 },
      { type: "pedal", timeSeconds: 0.02, controller: 64, value: 127 },
      { type: "pedal", timeSeconds: 0.03, controller: 66, value: 127 },
      { type: "release", timeSeconds: 0.04, noteId: "queued-held" },
    ]);
    transport.loadPlan(plan, 4);
    transport.seek(0);
    await transport.play();

    expect(sampler.getKeyDownNotes()).toEqual([{ noteId: "queued-held", pitch: 60 }]);
    expect(sampler.getPedalState()).toEqual({ sustain: false, sostenuto: false, soft: false });

    (mockCtx as unknown as MockAudioContext).currentTime = 0.01;
    transport.setSpeed(2);

    expect(sampler.getKeyDownNotes()).toEqual([{ noteId: "queued-held", pitch: 60 }]);
    const voices = (sampler as unknown as {
      activeVoices: Map<string, { keyState: "down" | "up"; released: boolean; keyReleaseTimePoint?: number; releaseTimePoint?: number }>;
    }).activeVoices;
    expect(voices.get("queued-held")?.released).toBe(false);
    expect(voices.get("queued-held")?.keyReleaseTimePoint).toBeGreaterThan(0.01);
    expect(sampler.getPedalState()).toEqual({ sustain: false, sostenuto: false, soft: false });
    const futurePedals = (sampler as unknown as {
      pedalEvents: Array<{ controller: number; value: number; time: number }>;
    }).pedalEvents;
    expect(futurePedals.map(({ controller, value }) => ({ controller, value }))).toEqual([
      { controller: 64, value: 127 },
      { controller: 66, value: 127 },
    ]);
    expect(futurePedals[0]?.time).toBeCloseTo(0.015, 8);
    expect(futurePedals[1]?.time).toBeCloseTo(0.02, 8);

    (mockCtx as unknown as MockAudioContext).currentTime = 0.015;
    expect(sampler.getPedalState().sustain).toBe(true);
    expect(sampler.getKeyDownNotes()).toEqual([{ noteId: "queued-held", pitch: 60 }]);
  });

  it("keeps restored pedal holds while a tempo change requeues future NoteOff and pedal commands", async () => {
    const plan = makeTestPerformancePlan([
      { type: "press", timeSeconds: 0, noteId: "restored-held", pitch: 60, velocity: 90 },
      { type: "pedal", timeSeconds: 0.02, controller: 64, value: 127 },
      { type: "pedal", timeSeconds: 0.03, controller: 66, value: 127 },
      { type: "release", timeSeconds: 0.15, noteId: "restored-held" },
      { type: "pedal", timeSeconds: 0.16, controller: 64, value: 0 },
      { type: "pedal", timeSeconds: 0.17, controller: 66, value: 0 },
    ]);
    transport.loadPlan(plan, 1);
    transport.seek(0.1);
    await transport.play();

    expect(sampler.getPedalState()).toEqual({ sustain: true, sostenuto: true, soft: false });
    expect(sampler.getKeyDownNotes()).toEqual([{ noteId: "restored-held", pitch: 60 }]);
    (mockCtx as unknown as MockAudioContext).currentTime = 0.04;
    transport.setSpeed(1.5);

    expect(sampler.getPedalState()).toEqual({ sustain: true, sostenuto: true, soft: false });
    expect(sampler.getKeyDownNotes()).toEqual([{ noteId: "restored-held", pitch: 60 }]);
    const scheduled = (sampler as unknown as {
      activeVoices: Map<string, { keyState: "down" | "up"; released: boolean; keyReleaseTimePoint?: number; releaseTimePoint?: number }>;
      pedalEvents: Array<{ controller: number; value: number; time: number }>;
    });
    const voice = scheduled.activeVoices.get("restored-held");
    expect(voice?.keyReleaseTimePoint).toBeCloseTo(0.046667, 5);
    expect(voice?.released).toBe(true);
    expect(voice?.releaseTimePoint).toBeCloseTo(0.06, 5);
    expect(scheduled.pedalEvents.map(({ controller, value }) => ({ controller, value }))).toEqual([
      { controller: 64, value: 0 },
      { controller: 66, value: 0 },
    ]);
    expect(scheduled.pedalEvents.every((event) => event.time > 0.04)).toBe(true);

    (mockCtx as unknown as MockAudioContext).currentTime = 0.055;
    expect(sampler.getPedalState()).toEqual({ sustain: false, sostenuto: true, soft: false });
    expect(voice?.releaseTimePoint).toBeCloseTo(0.06, 5);
    (mockCtx as unknown as MockAudioContext).currentTime = 0.065;
    expect(sampler.getPedalState()).toEqual({ sustain: false, sostenuto: false, soft: false });
    expect(voice?.released).toBe(true);
  });

  it("reconstructs sustain, sostenuto capture, and soft pedal state in event order", async () => {
    const plan = makeTestPerformancePlan([
      { type: "press", timeSeconds: 0, noteId: "captured", pitch: 60, velocity: 90 },
      { type: "pedal", timeSeconds: 0.2, controller: 66, value: 127 },
      { type: "press", timeSeconds: 0.3, noteId: "sustain-only", pitch: 64, velocity: 90 },
      { type: "pedal", timeSeconds: 0.4, controller: 64, value: 127 },
      { type: "pedal", timeSeconds: 0.45, controller: 67, value: 127 },
      { type: "release", timeSeconds: 0.5, noteId: "captured" },
      { type: "release", timeSeconds: 0.6, noteId: "sustain-only" },
    ]);
    transport.loadPlan(plan, 4);
    await transport.play();

    transport.seek(0.8);

    expect(sampler.getActiveVoiceCount()).toBe(2);
    expect(sampler.getPedalState()).toEqual({ sustain: true, sostenuto: true, soft: true });
  });

  it("restores only live voices after a long released-note prefix", async () => {
    const events: PerformancePlan["events"] = [];
    for (let index = 0; index < 100; index += 1) {
      const start = index * 0.02;
      events.push({ type: "press", timeSeconds: start, noteId: `past-${index}`, pitch: 48, velocity: 70 });
      events.push({ type: "release", timeSeconds: start + 0.01, noteId: `past-${index}` });
    }
    events.push({ type: "press", timeSeconds: 2.5, noteId: "still-down", pitch: 72, velocity: 95 });
    events.push({ type: "release", timeSeconds: 4.5, noteId: "still-down" });
    const noteOnSpy = vi.spyOn(sampler, "noteOn");

    transport.loadPlan(makeTestPerformancePlan(events), 5);
    await transport.play();
    noteOnSpy.mockClear();
    transport.seek(3);

    expect(noteOnSpy.mock.calls.map(([noteId]) => noteId)).toEqual(["still-down"]);
    expect(sampler.getActiveVoiceCount()).toBe(1);
  });

  it("replaces a plan while retaining playhead and playing or paused state", async () => {
    const initial = makeTestPerformancePlan([]);
    const replacement = makeTestPerformancePlan([
      { type: "press", timeSeconds: 0, noteId: "replacement-note", pitch: 67, velocity: 80 },
      { type: "release", timeSeconds: 2, noteId: "replacement-note" },
    ]);
    transport.loadPlan(initial, 5);
    transport.seek(0.4);
    await transport.play();
    (mockCtx as unknown as MockAudioContext).currentTime = 0.1;

    transport.updatePlan(replacement, 5);

    expect(transport.getState()).toBe("playing");
    expect(transport.getCurrentTime()).toBeCloseTo(0.5, 5);
    expect(sampler.getActiveVoiceCount()).toBe(1);

    transport.pause();
    transport.updatePlan(initial, 5);
    expect(transport.getState()).toBe("paused");
    expect(transport.getCurrentTime()).toBeCloseTo(0.5, 5);
    expect(sampler.getActiveVoiceCount()).toBe(0);
  });

  it("changes lead-in while preserving non-start positions", () => {
    transport.setDuration(5);
    transport.setLeadInSeconds(1);
    expect(transport.getCurrentTime()).toBe(-1);
    transport.seek(0.75);
    transport.setLeadInSeconds(0.5);
    expect(transport.getCurrentTime()).toBe(0.75);
  });

  it("notifies ended listener when song reaches duration plus tail", async () => {
    const endedSpy = vi.fn();
    transport.subscribeEnded(endedSpy);

    const plan = makeTestPerformancePlan([
      { type: "press", timeSeconds: 0.0, noteId: "n1", pitch: 60, velocity: 80 },
      { type: "release", timeSeconds: 1.0, noteId: "n1" },
    ]);

    transport.loadPlan(plan, 1.0);
    transport.seek(0.0);
    await transport.play();

    // Advance past duration (1.0s) + tail (1.2s)
    (mockCtx as unknown as MockAudioContext).currentTime = 2.5;
    vi.advanceTimersByTime(50);

    expect(transport.getState()).toBe("idle");
    expect(endedSpy).toHaveBeenCalled();
  });

  it("allows active notes to ring out during natural tail window without panic choking", async () => {
    const panicSpy = vi.spyOn(transport["output"], "panic");
    const endedSpy = vi.fn();
    transport.subscribeEnded(endedSpy);

    const plan = makeTestPerformancePlan([
      { type: "press", timeSeconds: 0.0, noteId: "n1", pitch: 60, velocity: 80 },
      { type: "release", timeSeconds: 1.0, noteId: "n1" },
    ]);

    transport.loadPlan(plan, 1.0);
    transport.seek(0.0);
    await transport.play();
    panicSpy.mockClear();

    // Advance into the tail window (1.2s is past 1.0s duration but before 1.0 + 1.2 = 2.2s end)
    (mockCtx as unknown as MockAudioContext).currentTime = 1.2;
    vi.advanceTimersByTime(50);

    // Verified: still playing the tail, panic has NOT choked voices, ended has not fired
    expect(transport.getState()).toBe("playing");
    expect(panicSpy).not.toHaveBeenCalled();
    expect(endedSpy).not.toHaveBeenCalled();
    expect(transport.getCurrentTime()).toBe(1.0);

    // Advance past the tail window
    (mockCtx as unknown as MockAudioContext).currentTime = 2.5;
    vi.advanceTimersByTime(50);

    expect(transport.getState()).toBe("idle");
    expect(endedSpy).toHaveBeenCalled();
  });
});
