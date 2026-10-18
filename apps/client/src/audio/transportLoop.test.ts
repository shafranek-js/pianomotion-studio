import { afterEach, describe, expect, it, vi } from "vitest";
import type { PerformancePlan } from "@handthesia/contracts";
import { Transport, MIN_LOOP_SPAN_SECONDS } from "./transport.ts";
import type { PianoSampler } from "./sampler.ts";
import type { PerformanceOutput, PerformanceOutputWindow, PlaybackState } from "./output/performanceOutput.ts";
import { SyncedAudioSource } from "./recording/syncedAudioSource.ts";
import type { StretchNode } from "./signalsmithStretch.ts";

type OutputCall =
  | { type: "on"; noteId: string; pitch: number; velocity: number; time: number }
  | { type: "off"; noteId: string; pitch: number | undefined; time: number }
  | { type: "pedal"; controller: 64 | 66 | 67; value: number; time: number }
  | { type: "cancel"; time: number };

type MutableAudioClock = { -readonly [Key in keyof AudioContext]: AudioContext[Key] };

class RecordingOutput implements PerformanceOutput {
  public readonly id = "synth" as const;
  public calls: OutputCall[] = [];
  public scheduled: OutputCall[] = [];
  public restored: PlaybackState[] = [];
  public panics = 0;
  public preparationCalls: Array<{ plan: PerformancePlan; windows: PerformanceOutputWindow[] }> = [];
  public readinessChecks: PerformanceOutputWindow[][] = [];
  public enforceReadinessWindowOrder = false;
  private prepared: Array<{ plan: PerformancePlan; window: PerformanceOutputWindow }> = [];

  public noteOn(noteId: string, pitch: number, velocity: number, scheduledTime: number): void {
    const call = { type: "on", noteId, pitch, velocity, time: scheduledTime } as const;
    this.calls.push(call);
    this.scheduled.push(call);
  }

  public noteOff(noteId: string, pitch: number | undefined, scheduledTime: number): void {
    const call = { type: "off", noteId, pitch, time: scheduledTime } as const;
    this.calls.push(call);
    this.scheduled.push(call);
  }

  public pedal(controller: 64 | 66 | 67, value: number, scheduledTime: number): void {
    const call = { type: "pedal", controller, value, time: scheduledTime } as const;
    this.calls.push(call);
    this.scheduled.push(call);
  }

  public panic(): void { this.panics += 1; this.scheduled = []; }
  public cancelScheduledFutureEvents(time: number): void {
    this.calls.push({ type: "cancel", time });
    this.scheduled = this.scheduled.filter((call) => call.type === "cancel" || call.time <= time);
  }
  public restoreState(state: PlaybackState): void { this.restored.push(structuredClone(state)); }
  public dispose(): void {}

  public async prepareWindows(plan: PerformancePlan, windows: readonly PerformanceOutputWindow[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const copied = windows.map((window) => ({ ...window }));
    this.preparationCalls.push({ plan, windows: copied });
    for (const window of copied) this.prepared.push({ plan, window });
  }

  public async prepareWindow(plan: PerformancePlan, startSeconds: number, endSeconds: number, signal?: AbortSignal): Promise<void> {
    return this.prepareWindows(plan, [{ startSeconds, endSeconds }], signal);
  }

  public isWindowsPrepared(plan: PerformancePlan, windows: readonly PerformanceOutputWindow[]): boolean {
    const copied = windows.map((window) => ({ ...window }));
    this.readinessChecks.push(copied);
    if (this.enforceReadinessWindowOrder && (copied.length === 0 || copied.some((window, index) =>
      !Number.isFinite(window.startSeconds) || !Number.isFinite(window.endSeconds) || window.startSeconds < 0 ||
      window.endSeconds < window.startSeconds || (index > 0 && window.startSeconds < copied[index - 1]!.startSeconds)))) {
      return false;
    }
    return windows.every((window) => this.prepared.some((entry) => entry.plan === plan &&
      window.startSeconds >= entry.window.startSeconds && window.endSeconds <= entry.window.endSeconds));
  }

  public isWindowPrepared(plan: PerformancePlan, startSeconds: number, endSeconds: number): boolean {
    return this.isWindowsPrepared(plan, [{ startSeconds, endSeconds }]);
  }
}

function makePlan(events: PerformancePlan["events"]): PerformancePlan {
  return {
    schemaVersion: 1,
    projectId: "loop-test",
    inputRevision: 0,
    profileId: "default",
    profileRevision: 0,
    engineVersion: "0".repeat(64),
    planId: "loop-plan",
    kind: "performance",
    fingeringPlanId: "fingering",
    events,
    diagnostics: [],
  };
}

function createClock() {
  return {
    currentTime: 0,
    state: "running" as AudioContextState,
    resume: vi.fn().mockResolvedValue(undefined),
  } as unknown as MutableAudioClock;
}

function createTransport(options: { plan: PerformancePlan; duration: number; scheduleAhead?: number; leadIn?: number }) {
  const clock = createClock();
  const sampler = { silenceAll: vi.fn(), dispose: vi.fn() } as unknown as PianoSampler;
  const transport = new Transport({
    audioContext: clock,
    sampler,
    leadInSeconds: options.leadIn ?? 0,
    scheduleAheadSeconds: options.scheduleAhead ?? 0.1,
    scheduleIntervalMs: 60_000,
  });
  const output = new RecordingOutput();
  transport.setOutput(output);
  transport.loadPlan(options.plan, options.duration);
  return { transport, output, clock };
}

function tick(transport: Transport): void {
  (transport as unknown as { tickScheduler(): void }).tickScheduler();
}

function loopVoiceIteration(noteId: string): number {
  const marker = "\u0000loop:";
  const markerStart = noteId.lastIndexOf(marker);
  return Number(noteId.slice(markerStart + marker.length).split(":")[1]);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Transport A–B loop", () => {
  it("wraps repeatedly at the audio-clock boundary, respects speed, and excludes B events", async () => {
    const plan = makePlan([
      { type: "press", timeSeconds: 1.02, noteId: "loop-note", pitch: 60, velocity: 90 },
      { type: "release", timeSeconds: 1.06, noteId: "loop-note" },
      { type: "press", timeSeconds: 1.2, noteId: "at-b", pitch: 64, velocity: 80 },
      { type: "release", timeSeconds: 1.25, noteId: "at-b" },
      { type: "press", timeSeconds: 1.3, noteId: "after-b", pitch: 67, velocity: 80 },
      { type: "release", timeSeconds: 1.35, noteId: "after-b" },
    ]);
    const { transport, output, clock } = createTransport({ plan, duration: 2, scheduleAhead: 0.45 });
    const wraps: number[] = [];
    transport.setLoop({ startSeconds: 1, endSeconds: 1.2 });
    transport.subscribeLoop((time) => wraps.push(time));

    await transport.play();

    const presses = output.calls.filter((call): call is Extract<OutputCall, { type: "on" }> =>
      call.type === "on" && call.noteId.includes("loop-note"));
    expect(presses.map((call) => loopVoiceIteration(call.noteId))).toEqual([0, 1, 2]);
    expect(presses).toHaveLength(3);
    expect(presses[0]!.time).toBeCloseTo(0.02, 8);
    expect(presses[1]!.time).toBeCloseTo(0.22, 8);
    expect(presses[2]!.time).toBeCloseTo(0.42, 8);
    expect(output.calls.some((call) => "noteId" in call && (call.noteId.includes("at-b") || call.noteId.includes("after-b")))).toBe(false);
    expect(output.calls.filter((call) => call.type === "on" || call.type === "off")
      .every((call) => call.time < 0.45)).toBe(true);

    clock.currentTime = 0.41;
    tick(transport);
    expect(wraps).toEqual([1, 1]);
    expect(transport.getCurrentTime()).toBeCloseTo(1.01, 8);

    transport.setSpeed(2);
    clock.currentTime = 0.46;
    expect(transport.getCurrentTime()).toBeCloseTo(1.11, 8);
    clock.currentTime = 0.62;
    tick(transport);
    expect(wraps).toEqual([1, 1, 1, 1]);
    expect(output.calls.some((call) => call.type === "cancel" && call.time === 0.41)).toBe(true);
    transport.dispose();
  });

  it("restores crossing sostenuto, sustain, and soft-pedal state in MIDI-safe order", async () => {
    const plan = makePlan([
      { type: "press", timeSeconds: 0.1, noteId: "captured", pitch: 55, velocity: 80 },
      { type: "pedal", timeSeconds: 0.2, controller: 66, value: 127 },
      { type: "pedal", timeSeconds: 0.3, controller: 64, value: 127 },
      { type: "pedal", timeSeconds: 0.4, controller: 67, value: 127 },
      { type: "press", timeSeconds: 0.5, noteId: "sustain-only", pitch: 62, velocity: 95 },
      { type: "release", timeSeconds: 0.6, noteId: "captured" },
      { type: "release", timeSeconds: 0.7, noteId: "sustain-only" },
      { type: "pedal", timeSeconds: 1.3, controller: 64, value: 0 },
      { type: "pedal", timeSeconds: 1.4, controller: 67, value: 0 },
    ]);
    const { transport, output } = createTransport({ plan, duration: 2, scheduleAhead: 0.9 });
    transport.setLoop({ startSeconds: 1, endSeconds: 1.8 });
    await transport.play();

    const atBoundary = output.calls.filter((call) => Math.abs(call.time - 0.8) < 1e-9);
    expect(atBoundary.map((call) => {
      if (call.type === "pedal") return `${call.type}-${call.controller}-${call.value}`;
      if (call.type === "on" || call.type === "off") return `${call.type}-${call.noteId}`;
      return call.type;
    })).toEqual([
      "off-captured\u0000loop:1:0",
      "pedal-64-0",
      "pedal-66-0",
      "pedal-67-0",
      "on-captured\u0000loop:1:1",
      "pedal-66-127",
      "pedal-67-127",
      "on-sustain-only\u0000loop:1:1",
      "pedal-64-127",
      "off-captured\u0000loop:1:1",
      "off-sustain-only\u0000loop:1:1",
    ]);
    expect(output.restored[0]).toMatchObject({
      pedals: { sustain: true, sostenuto: true, soft: true },
      voices: [
        { noteId: "captured\u0000loop:1:0", keyState: "up", heldBySostenuto: true, sustainedBySustain: true },
        { noteId: "sustain-only\u0000loop:1:0", keyState: "up", heldBySostenuto: false, sustainedBySustain: true },
      ],
    });
    transport.dispose();
  });

  it("removes an already queued boundary when speed reanchors before B", async () => {
    const plan = makePlan([
      { type: "press", timeSeconds: 1.05, noteId: "held-to-release", pitch: 60, velocity: 90 },
      { type: "release", timeSeconds: 1.15, noteId: "held-to-release" },
    ]);
    const { transport, output, clock } = createTransport({ plan, duration: 2, scheduleAhead: 0.25 });
    transport.setLoop({ startSeconds: 1, endSeconds: 1.2 });
    await transport.play();
    expect(output.scheduled.some((call) => call.type === "pedal" && Math.abs(call.time - 0.2) < 1e-9)).toBe(true);

    clock.currentTime = 0.1;
    transport.setSpeed(2);

    expect(output.calls.some((call) => call.type === "cancel" && call.time === 0.1)).toBe(true);
    expect(output.scheduled.some((call) => call.type === "pedal" && Math.abs(call.time - 0.2) < 1e-9)).toBe(false);
    const scheduledPress = output.scheduled.find((call): call is Extract<OutputCall, { type: "on" }> => call.type === "on");
    const scheduledRelease = output.scheduled.find((call): call is Extract<OutputCall, { type: "off" }> => call.type === "off");
    expect(scheduledPress).toBeDefined();
    expect(scheduledRelease?.noteId).toBe(scheduledPress?.noteId);
    expect(scheduledRelease?.time).toBeCloseTo(0.125, 8);
    transport.dispose();
  });

  it("keeps paused seeks outside the range, enters at A on Play, and cancels safely on pause, stop, and disable", async () => {
    const plan = makePlan([
      { type: "press", timeSeconds: 1.05, noteId: "held", pitch: 60, velocity: 90 },
      { type: "release", timeSeconds: 1.3, noteId: "held" },
    ]);
    const { transport, output, clock } = createTransport({ plan, duration: 4, scheduleAhead: 0.1, leadIn: 0.25 });
    transport.setLoop({ startSeconds: 1, endSeconds: 2 });
    transport.seek(3);
    expect(transport.getCurrentTime()).toBe(3);
    await transport.play();
    expect(transport.getCurrentTime()).toBe(1);
    expect(output.calls.some((call) => call.type === "on" && call.noteId.includes("held"))).toBe(true);

    clock.currentTime = 0.1;
    transport.pause();
    expect(transport.getState()).toBe("paused");
    expect(output.panics).toBeGreaterThan(0);
    await transport.play();
    expect(transport.getState()).toBe("playing");

    transport.stop();
    await transport.play();
    clock.currentTime = 0.16;
    tick(transport);
    transport.setLoop(null);
    clock.currentTime = 0.41;
    tick(transport);
    const originalPress = output.calls.filter((call): call is Extract<OutputCall, { type: "on" }> =>
      call.type === "on" && call.noteId.includes("held")).at(-1);
    const laterRelease = output.calls.filter((call) => call.type === "off" && call.noteId.includes("held")).at(-1);
    expect(originalPress?.type).toBe("on");
    expect(laterRelease?.type).toBe("off");
    if (originalPress?.type === "on" && laterRelease?.type === "off") {
      expect(laterRelease.noteId).toBe(originalPress.noteId);
    }

    transport.setLoop({ startSeconds: 1, endSeconds: 2 });
    transport.stop();
    expect(transport.getState()).toBe("idle");
    expect(transport.getCurrentTime()).toBe(-0.25);
    await transport.play();
    expect(transport.getCurrentTime()).toBe(1);
    transport.dispose();
  });

  it("validates and preserves ranges, tolerates decimal span error, and clears a range invalidated by duration/plan changes", async () => {
    const plan = makePlan([
      { type: "press", timeSeconds: 1.1, noteId: "a", pitch: 60, velocity: 90 },
      { type: "release", timeSeconds: 1.4, noteId: "a" },
      { type: "press", timeSeconds: 1.5, noteId: "b", pitch: 62, velocity: 90 },
      { type: "release", timeSeconds: 2.2, noteId: "b" },
    ]);
    const { transport } = createTransport({ plan, duration: 3 });
    transport.setLoop({ startSeconds: 1.1, endSeconds: 1.2 });
    expect(MIN_LOOP_SPAN_SECONDS).toBe(0.1);
    expect(() => transport.setLoop({ startSeconds: 1.1, endSeconds: 1.199 })).toThrow(RangeError);
    expect(() => transport.setLoop({ startSeconds: Number.NaN, endSeconds: 2 })).toThrow(RangeError);
    expect(() => transport.setLoop({ startSeconds: 0, endSeconds: 3.1 })).toThrow(RangeError);

    transport.seek(1.8);
    await transport.play();
    expect(transport.getCurrentTime()).toBeCloseTo(1.1, 8);
    transport.pause();

    transport.setLoop({ startSeconds: 1, endSeconds: 2 });
    transport.setDuration(1.9);
    transport.seek(1.8);
    await transport.play();
    expect(transport.getCurrentTime()).toBeCloseTo(1.8, 8);
    transport.pause();

    transport.setLoop({ startSeconds: 1, endSeconds: 1.8 });
    const shorterPlan = makePlan([
      { type: "press", timeSeconds: 0.2, noteId: "short", pitch: 60, velocity: 90 },
      { type: "release", timeSeconds: 1.5, noteId: "short" },
    ]);
    transport.updatePlan(shorterPlan);
    transport.seek(1.4);
    await transport.play();
    expect(transport.getCurrentTime()).toBeCloseTo(1.4, 8);
    transport.dispose();
  });

  it("prepares bounded current and loop-head windows through long loops, including after wraps", async () => {
    const plan = makePlan([
      { type: "press", timeSeconds: 1.1, noteId: "a", pitch: 60, velocity: 90 },
      { type: "release", timeSeconds: 1.2, noteId: "a" },
      { type: "press", timeSeconds: 11.8, noteId: "b", pitch: 62, velocity: 90 },
      { type: "release", timeSeconds: 11.9, noteId: "b" },
    ]);
    const { transport, output, clock } = createTransport({ plan, duration: 15, scheduleAhead: 0.1 });
    transport.setLoop({ startSeconds: 1, endSeconds: 12 });
    await transport.play();

    for (let index = 1; index <= 9; index += 1) {
      clock.currentTime = index * 0.5;
      tick(transport);
      await Promise.resolve();
      await Promise.resolve();
    }
    const longLoopRequests = output.preparationCalls.filter((request) => request.plan === plan);
    expect(longLoopRequests.length).toBeGreaterThan(1);
    expect(longLoopRequests.flatMap((request) => request.windows).every((window) =>
      window.startSeconds >= 1 && window.endSeconds <= 12 && window.endSeconds - window.startSeconds <= 4)).toBe(true);
    expect(longLoopRequests.flatMap((request) => request.windows)
      .some((window) => window.startSeconds === 1 && window.endSeconds === 12)).toBe(false);
    const currentAndHead = longLoopRequests.at(-1)!.windows;
    expect(currentAndHead).toEqual([
      { startSeconds: 1, endSeconds: 5 },
      { startSeconds: 5.5, endSeconds: 9.5 },
    ]);

    clock.currentTime = 11.01;
    tick(transport);
    await Promise.resolve();
    await Promise.resolve();
    const afterWrapRequest = output.preparationCalls.at(-1)!;
    expect(afterWrapRequest.windows.some((window) => window.startSeconds === 1 && window.endSeconds > 1)).toBe(true);
    expect(afterWrapRequest.windows.every((window) => window.endSeconds - window.startSeconds <= 4)).toBe(true);
    transport.dispose();
  });

  it("keeps readiness windows ordered on successive ticks after loop A", async () => {
    const plan = makePlan([
      { type: "press", timeSeconds: 1.1, noteId: "a", pitch: 60, velocity: 90 },
      { type: "release", timeSeconds: 1.2, noteId: "a" },
    ]);
    const { transport, output, clock } = createTransport({ plan, duration: 4, scheduleAhead: 0.1 });
    output.enforceReadinessWindowOrder = true;
    transport.setLoop({ startSeconds: 1, endSeconds: 3 });
    await transport.play();

    clock.currentTime = 0.02;
    tick(transport);
    const stateAfterFirstTick = transport.getState();
    clock.currentTime = 0.04;
    tick(transport);
    const stateAfterSecondTick = transport.getState();
    const laterReadinessChecks = output.readinessChecks.filter((windows) => windows.some((window) => window.startSeconds > 1));

    transport.pause();
    await flushMicrotasks();

    expect(stateAfterFirstTick).toBe("playing");
    expect(stateAfterSecondTick).toBe("playing");
    expect(laterReadinessChecks.length).toBeGreaterThanOrEqual(2);
    expect(laterReadinessChecks.every((windows) => windows.every((window, index) =>
      index === 0 || window.startSeconds >= windows[index - 1]!.startSeconds))).toBe(true);
    transport.dispose();
  });

  it("restarts a pending Play preparation when its loop range changes", async () => {
    const plan = makePlan([
      { type: "press", timeSeconds: 0.5, noteId: "crossing-a", pitch: 60, velocity: 90 },
      { type: "release", timeSeconds: 1.5, noteId: "crossing-a" },
    ]);
    const { transport, output } = createTransport({ plan, duration: 3, leadIn: 0 });
    const firstPreparation = deferred();
    const loopPreparation = deferred();
    const gates = [firstPreparation, loopPreparation];
    const requests: PerformanceOutputWindow[][] = [];
    const prepareWindows = output.prepareWindows.bind(output);
    output.prepareWindows = async (requestedPlan, windows, signal) => {
      requests.push(windows.map((window) => ({ ...window })));
      const gate = gates.shift();
      if (gate) await gate.promise;
      if (signal?.aborted) return;
      await prepareWindows(requestedPlan, windows, signal);
    };

    const originalPlay = transport.play();
    await flushMicrotasks();
    expect(requests).toHaveLength(1);
    expect(requests[0]![0]!.startSeconds).toBeCloseTo(0, 8);
    expect(requests[0]![0]!.endSeconds).toBe(3);

    transport.setLoop({ startSeconds: 1, endSeconds: 2 });
    await flushMicrotasks();
    expect(requests.at(-1)).toEqual([{ startSeconds: 1, endSeconds: 2 }]);

    firstPreparation.resolve();
    await originalPlay;
    expect(transport.getState()).toBe("idle");
    expect(output.restored).toHaveLength(0);

    loopPreparation.resolve();
    await vi.waitFor(() => expect(transport.getState()).toBe("playing"));
    expect(output.restored.at(-1)?.voices).toContainEqual(expect.objectContaining({ pitch: 60 }));
    transport.dispose();
  });

  it("waits for preparation before changing a playing loop to an unprepared active state", async () => {
    const plan = makePlan([
      { type: "press", timeSeconds: 4.5, noteId: "far-crossing", pitch: 67, velocity: 95 },
      { type: "release", timeSeconds: 6, noteId: "far-crossing" },
    ]);
    const { transport, output, clock } = createTransport({ plan, duration: 8, scheduleAhead: 0.1 });
    transport.setLoop({ startSeconds: 1, endSeconds: 2 });
    await transport.play();
    clock.currentTime = 0.1;
    output.restored.length = 0;

    const farPreparation = deferred();
    const requests: PerformanceOutputWindow[][] = [];
    const prepareWindows = output.prepareWindows.bind(output);
    output.prepareWindows = async (requestedPlan, windows, signal) => {
      requests.push(windows.map((window) => ({ ...window })));
      await farPreparation.promise;
      if (!signal?.aborted) await prepareWindows(requestedPlan, windows, signal);
    };

    transport.setLoop({ startSeconds: 5, endSeconds: 7 });
    await flushMicrotasks();
    expect(transport.getState()).toBe("paused");
    expect(requests).toEqual([[{ startSeconds: 5, endSeconds: 7 }]]);
    expect(output.restored).toHaveLength(0);

    farPreparation.resolve();
    await vi.waitFor(() => expect(transport.getState()).toBe("playing"));
    expect(output.restored.at(-1)?.voices).toContainEqual(expect.objectContaining({ pitch: 67 }));
    transport.dispose();
  });

  it("sorts earlier interactive prefetch windows before the loop's current segment", async () => {
    const plan = makePlan([
      { type: "press", timeSeconds: 1.1, noteId: "head", pitch: 60, velocity: 90 },
      { type: "release", timeSeconds: 1.2, noteId: "head" },
    ]);
    const { transport, output } = createTransport({ plan, duration: 12 });
    transport.setLoop({ startSeconds: 1, endSeconds: 10 });
    transport.seek(6);
    await transport.play();

    transport.prefetchWindowAt(4.5, 1);
    await flushMicrotasks();

    expect(output.preparationCalls.at(-1)?.windows).toEqual([
      { startSeconds: 1, endSeconds: 5 },
      { startSeconds: 4.5, endSeconds: 5.5 },
      { startSeconds: 6, endSeconds: 10 },
    ]);
    transport.dispose();
  });
});

describe("SyncedAudioSource loop segment scheduling", () => {
  function createSourceFixture(schedule: StretchNode["schedule"] = vi.fn().mockResolvedValue(undefined)) {
    const audioContext = {
      currentTime: 0.5,
      sampleRate: 48_000,
      createGain: vi.fn().mockReturnValue({
        gain: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
    } as unknown as AudioContext;
    const node = {
      schedule,
      dropBuffers: vi.fn().mockResolvedValue(undefined),
      addBuffers: vi.fn().mockResolvedValue(1),
      connect: vi.fn(),
      disconnect: vi.fn(),
      latency: vi.fn().mockReturnValue(0),
    } as unknown as StretchNode;
    const source = new SyncedAudioSource(0, 1, async () => node);
    const buffer = {
      length: 480,
      sampleRate: 48_000,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array(480),
    } as unknown as AudioBuffer;
    const recording = {
      buffer,
      durationSeconds: 8,
      sampleRate: 48_000,
      numberOfChannels: 2,
      peaks: new Float32Array(10),
    };
    return { source, audioContext, schedule, recording };
  }

  it("appends a loop segment at its exact future output time without interrupting the base segment", async () => {
    const { source, audioContext, schedule, recording } = createSourceFixture();
    await source.attach(recording, audioContext, {} as AudioNode);
    await source.play(0.25, 1.5);
    const baseCallCount = vi.mocked(schedule).mock.calls.length;

    await source.seekAt(0.25, 1.5, 2.75);

    expect(vi.mocked(schedule).mock.calls.length).toBe(baseCallCount + 1);
    expect(vi.mocked(schedule)).toHaveBeenLastCalledWith({
      output: 2.75,
      outputTime: 2.75,
      input: 0.25,
      rate: 1.5,
      semitones: 0,
      active: true,
    });
    source.dispose();
  });

  it("drops queued future loop segments when pause invalidates the play generation", async () => {
    let releaseBase!: () => void;
    const schedule = vi.fn<StretchNode["schedule"]>().mockResolvedValue(undefined);
    schedule.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseBase = resolve; }));
    const { source, audioContext, recording } = createSourceFixture(schedule);
    await source.attach(recording, audioContext, {} as AudioNode);

    const base = source.play(0.2, 1);
    const future = source.seekAt(0.2, 1, 3);
    source.pause();
    releaseBase();
    await Promise.all([base, future]);

    expect(schedule.mock.calls.some(([options]) =>
      (options as (typeof options & { outputTime?: number }))?.outputTime === 3 && options?.active === true)).toBe(false);
    expect(source.isPlaying()).toBe(false);
    source.dispose();
  });
});
