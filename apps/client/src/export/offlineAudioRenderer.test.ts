import { afterEach, describe, expect, it, vi } from "vitest";

const synthState = vi.hoisted(() => ({
  operations: [] as string[],
  prepared: [] as Array<Array<{ pitch: number; velocity: number }>>,
  failPrepare: false,
  abortController: null as AbortController | null,
}));

vi.mock("../audio/soundfont/soundfontSynth.ts", () => ({
  SoundFontSynth: class MockSoundFontSynth {
    private lastPrepared = new Set<string>();

    constructor() { synthState.operations.push("construct"); }
    loadSoundFont() { synthState.operations.push("load"); }
    async prepareNotes(notes: readonly { pitch: number; velocity: number }[]) {
      const copy = notes.map(({ pitch, velocity }) => ({ pitch, velocity }));
      synthState.prepared.push(copy);
      synthState.operations.push(`prepare:${copy.map(({ pitch }) => pitch).join(",")}`);
      if (synthState.failPrepare) throw new Error("Injected sample preparation failure");
      this.lastPrepared = new Set(copy.map(({ pitch, velocity }) => `${pitch}:${velocity}`));
      if (synthState.abortController) {
        const controller = synthState.abortController;
        synthState.abortController = null;
        controller.abort();
      }
    }
    areNotesPrepared(notes: readonly { pitch: number; velocity: number }[]) {
      return notes.every(({ pitch, velocity }) => this.lastPrepared.has(`${pitch}:${velocity}`));
    }
    restoreState(state: { voices: readonly { pitch: number; velocity: number }[] }) {
      if (state.voices.some(({ pitch, velocity }) => !this.lastPrepared.has(`${pitch}:${velocity}`))) {
        throw new Error("Restored voice was not prepared");
      }
      synthState.operations.push(`restore:${state.voices.map(({ pitch }) => pitch).join(",")}`);
    }
    noteOn(pitch: number, velocity: number) {
      if (!this.lastPrepared.has(`${pitch}:${velocity}`)) throw new Error(`Note ${pitch} was not prepared`);
      synthState.operations.push(`noteOn:${pitch}`);
    }
    noteOff() {}
    pedalChange() {}
    dispose() { synthState.operations.push("dispose"); }
  },
}));

import { renderOfflineAudio } from "./offlineAudioRenderer";
import type { PerformancePlan, SongDocument } from "@handthesia/contracts";

class FakeOfflineAudioContext {
  static last: FakeOfflineAudioContext | null = null;
  readonly destination = {} as AudioNode;
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "suspended";
  startCount = 0;
  private suspendTarget: number | null = null;
  private resolveSuspend: (() => void) | null = null;
  private resolveRender: ((buffer: AudioBuffer) => void) | null = null;

  constructor(_channels: number, length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    FakeOfflineAudioContext.last = this;
  }

  suspend(time: number): Promise<void> {
    this.suspendTarget = time;
    return new Promise((resolve) => { this.resolveSuspend = resolve; });
  }

  startRendering(): Promise<AudioBuffer> {
    this.startCount += 1;
    this.state = "running";
    return new Promise((resolve) => {
      this.resolveRender = resolve;
      queueMicrotask(() => this.reachSuspend());
    });
  }

  resume(): Promise<void> {
    if (this.suspendTarget !== null && this.resolveSuspend) {
      this.state = "running";
      queueMicrotask(() => this.reachSuspend());
    } else {
      this.state = "closed";
      const channels = [new Float32Array(this.length), new Float32Array(this.length)];
      this.resolveRender?.({
        numberOfChannels: 2,
        sampleRate: this.sampleRate,
        length: this.length,
        duration: this.duration,
        getChannelData: (channel: number) => channels[channel]!,
      } as AudioBuffer);
    }
    return Promise.resolve();
  }

  private reachSuspend(): void {
    if (!this.resolveSuspend || this.suspendTarget === null) return;
    this.currentTime = this.suspendTarget;
    this.state = "suspended";
    this.suspendTarget = null;
    const resolve = this.resolveSuspend;
    this.resolveSuspend = null;
    resolve();
  }
}

function planWithNotes(): PerformancePlan {
  return {
    schemaVersion: 1, kind: "performance", planId: "window-plan", projectId: "p", inputRevision: 0,
    profileId: "default", profileRevision: 0, engineVersion: "d".repeat(64),
    fingeringPlanId: "window-fingering", diagnostics: [],
    events: [
      { type: "press", timeSeconds: -1, noteId: "restored", pitch: 60, velocity: 90 },
      { type: "press", timeSeconds: 0.25, noteId: "first", pitch: 61, velocity: 91 },
      { type: "release", timeSeconds: 0.5, noteId: "first" },
      { type: "press", timeSeconds: 4.2, noteId: "second", pitch: 62, velocity: 92 },
      { type: "release", timeSeconds: 4.5, noteId: "second" },
      { type: "press", timeSeconds: 8.5, noteId: "third", pitch: 63, velocity: 93 },
      { type: "release", timeSeconds: 9, noteId: "third" },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  synthState.operations.length = 0;
  synthState.prepared.length = 0;
  synthState.failPrepare = false;
  synthState.abortController = null;
  FakeOfflineAudioContext.last = null;
});

describe("offline SoundFont sample preparation", () => {
  it("prepares restored and upcoming notes in bounded windows before scheduling them", async () => {
    vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
    const result = await renderOfflineAudio({
      document: {} as SongDocument,
      performancePlan: planWithNotes(),
      soundFont: { header: { name: "test", versionMajor: 2, versionMinor: 4 }, presets: [], samples: [] },
      speed: 1,
      startTime: 0,
      durationSeconds: 10,
      sampleRate: 100,
      createWav: false,
    });

    expect(result.audioBuffer.numberOfChannels).toBe(2);
    expect(synthState.operations.indexOf("prepare:60")).toBeLessThan(synthState.operations.indexOf("restore:60"));
    expect(synthState.prepared.filter((notes) => notes.length > 0).map((notes) => notes.map(({ pitch }) => pitch)))
      .toEqual([[60], [61], [62], [63]]);
    for (const pitch of [61, 62, 63]) {
      expect(synthState.operations.indexOf(`prepare:${pitch}`)).toBeGreaterThanOrEqual(0);
      expect(synthState.operations.indexOf(`prepare:${pitch}`)).toBeLessThan(synthState.operations.indexOf(`noteOn:${pitch}`));
    }
    expect(synthState.prepared.every((notes) => notes.length <= 1)).toBe(true);
    expect(synthState.operations.at(-1)).toBe("dispose");
  });

  it("settles before native rendering when initial sample preparation fails", async () => {
    vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
    synthState.failPrepare = true;

    await expect(renderOfflineAudio({
      document: {} as SongDocument,
      performancePlan: planWithNotes(),
      soundFont: { header: { name: "test", versionMajor: 2, versionMinor: 4 }, presets: [], samples: [] },
      speed: 1,
      startTime: 0,
      durationSeconds: 2,
      sampleRate: 100,
      createWav: false,
    })).rejects.toThrow("Injected sample preparation failure");

    expect(FakeOfflineAudioContext.last?.startCount).toBe(0);
    expect(synthState.operations.at(-1)).toBe("dispose");
  });

  it("schedules the old-side note before replacing its preparation at a four-second boundary", async () => {
    vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
    const plan = {
      ...planWithNotes(),
      events: [
        { type: "press" as const, timeSeconds: 3.98, noteId: "before-boundary", pitch: 70, velocity: 100 },
        { type: "press" as const, timeSeconds: 4.01, noteId: "after-boundary", pitch: 71, velocity: 101 },
        { type: "release" as const, timeSeconds: 4.5, noteId: "before-boundary" },
        { type: "release" as const, timeSeconds: 4.5, noteId: "after-boundary" },
      ],
    };

    await renderOfflineAudio({
      document: {} as SongDocument,
      performancePlan: plan,
      soundFont: { header: { name: "test", versionMajor: 2, versionMinor: 4 }, presets: [], samples: [] },
      speed: 1,
      startTime: 0,
      durationSeconds: 5,
      sampleRate: 100,
      createWav: false,
    });

    expect(synthState.prepared).toContainEqual([
      { pitch: 70, velocity: 100 },
      { pitch: 71, velocity: 101 },
    ]);
    const crossingPreparation = synthState.operations.indexOf("prepare:70,71");
    expect(crossingPreparation).toBeGreaterThanOrEqual(0);
    expect(crossingPreparation).toBeLessThan(synthState.operations.indexOf("noteOn:70"));
    expect(crossingPreparation).toBeLessThan(synthState.operations.indexOf("noteOn:71"));
  });

  it("disposes the synth without starting native rendering when cancellation arrives during initial preparation", async () => {
    vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
    const controller = new AbortController();
    synthState.abortController = controller;
    const plan = {
      ...planWithNotes(),
      events: [{ type: "press" as const, timeSeconds: -1, noteId: "restored", pitch: 60, velocity: 90 }],
    };
    await expect(renderOfflineAudio({
      document: {} as SongDocument,
      performancePlan: plan,
      soundFont: { header: { name: "test", versionMajor: 2, versionMinor: 4 }, presets: [], samples: [] },
      speed: 1,
      startTime: 0,
      durationSeconds: 2,
      sampleRate: 100,
      createWav: false,
      cancelSignal: controller.signal,
    })).rejects.toThrow("Offline audio rendering aborted");

    expect(FakeOfflineAudioContext.last?.startCount).toBe(0);
    expect(synthState.operations.at(-1)).toBe("dispose");
  });
});
