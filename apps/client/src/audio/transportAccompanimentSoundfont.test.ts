import { afterEach, describe, expect, it, vi } from "vitest";
import type { PerformancePlan } from "@handthesia/contracts";
import type { AccompanimentBackend, AccompanimentPlan, AccompanimentWindow } from "./accompaniment.ts";
import type { PerformanceOutput } from "./output/performanceOutput.ts";
import type { PianoSampler } from "./sampler.ts";
import { Transport } from "./transport.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

class Backing implements AccompanimentBackend {
  volume = 0.65; enabled = true;
  gate: ReturnType<typeof deferred> | null = null;
  requests: Array<{ plan: AccompanimentPlan; windows: AccompanimentWindow[]; signal?: AbortSignal }> = [];
  ready: { plan: AccompanimentPlan; windows: AccompanimentWindow[] } | null = null;
  noteOn = vi.fn(); noteOff = vi.fn(); allNotesOff = vi.fn(); dispose = vi.fn();
  setVolume(volume: number) { this.volume = volume; }
  getVolume() { return this.volume; }
  setEnabled(enabled: boolean) { this.enabled = enabled; }
  isEnabled() { return this.enabled; }
  async prepareWindows(plan: AccompanimentPlan, windows: readonly AccompanimentWindow[], signal?: AbortSignal) {
    const copied = windows.map((window) => ({ ...window }));
    this.requests.push({ plan, windows: copied, signal });
    if (this.gate) await this.gate.promise;
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    this.ready = { plan, windows: copied };
  }
  isWindowsPrepared(plan: AccompanimentPlan, windows: readonly AccompanimentWindow[]) {
    return this.ready?.plan === plan && windows.every((window) => this.ready!.windows.some((candidate) =>
      window.startSeconds >= candidate.startSeconds && window.endSeconds <= candidate.endSeconds));
  }
}

const transports: Transport[] = [];
function setup() {
  const parameter = { setValueAtTime: vi.fn() };
  const clock = { currentTime: 0, state: "running", destination: {}, createGain: () => ({ gain: parameter, connect: vi.fn(), disconnect: vi.fn() }) } as unknown as AudioContext;
  const sampler = { silenceAll: vi.fn(), dispose: vi.fn() } as unknown as PianoSampler;
  const transport = new Transport({ audioContext: clock, sampler, leadInSeconds: 0, scheduleIntervalMs: 60_000 });
  transports.push(transport);
  const output: PerformanceOutput = {
    id: "synth", noteOn: vi.fn(), noteOff: vi.fn(), pedal: vi.fn(), panic: vi.fn(),
    cancelScheduledFutureEvents: vi.fn(), restoreState: vi.fn(), dispose: vi.fn(),
  };
  const backend = new Backing();
  const plan = { schemaVersion: 1, projectId: "backing", inputRevision: 0, profileId: "default", profileRevision: 0,
    engineVersion: "0".repeat(64), planId: "plan", kind: "performance", fingeringPlanId: "fingering", diagnostics: [],
    events: [{ type: "press", noteId: "piano", timeSeconds: 0, pitch: 60, velocity: 90 }, { type: "release", noteId: "piano", timeSeconds: 19 }],
  } as PerformancePlan;
  const backingPlan: AccompanimentPlan = { tracks: [], notes: [{ noteId: "violin", trackId: "strings", program: 40, pitch: 60, velocity: 90, startSeconds: 0, endSeconds: 20 }],
    events: [{ type: "press", noteId: "violin", trackId: "strings", program: 40, pitch: 60, velocity: 90, timeSeconds: 0 }, { type: "release", noteId: "violin", pitch: 60, timeSeconds: 20 }] };
  transport.setOutput(output, backend);
  transport.loadPlan(plan, 20);
  transport.loadAccompanimentPlan(backingPlan);
  return { transport, output, backend, clock, backingPlan, plan };
}
afterEach(() => { for (const transport of transports.splice(0)) transport.dispose(); });

describe("Transport SoundFont backing lifecycle", () => {
  it("adopts piano and prepared backing together, retaining controls and disposing the previous pair", async () => {
    const { transport, backend, output } = setup();
    transport.setAccompanimentVolume(0.35); transport.setAccompanimentEnabled(false);
    const candidate = new Backing();
    await transport.prepareAccompanimentBackend(candidate);
    expect(backend.dispose).not.toHaveBeenCalled();
    const nextOutput = { ...output, dispose: vi.fn(), panic: vi.fn() };
    transport.setOutput(nextOutput, candidate);
    expect(transport.getOutput()).toBe(nextOutput);
    expect(candidate.getVolume()).toBe(0.35); expect(candidate.isEnabled()).toBe(false);
    expect(backend.allNotesOff).toHaveBeenCalled(); expect(backend.dispose).toHaveBeenCalledOnce();
    expect(output.panic).toHaveBeenCalled(); expect(output.dispose).toHaveBeenCalledOnce();
    transport.dispose();
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("waits for backing preparation even when the main synth has no sample preparation, including a seek", async () => {
    const { transport, backend, clock } = setup();
    backend.gate = deferred();
    const playing = transport.play(); await flush();
    expect(transport.getState()).toBe("idle"); expect(transport.isPreparingOutput()).toBe(true);
    expect(backend.noteOn).not.toHaveBeenCalled();
    expect(backend.requests[0]!.windows).toEqual([{ startSeconds: 0, endSeconds: 4 }]);
    backend.gate.resolve(); await playing;
    expect(transport.getState()).toBe("playing"); expect(backend.noteOn).toHaveBeenCalledWith("violin", 60, 90, 40, 0);
    backend.gate = deferred();
    transport.seek(9); await flush();
    expect(transport.getState()).toBe("paused"); expect(transport.isPreparingOutput()).toBe(true);
    expect(backend.requests.at(-1)!.windows).toEqual([{ startSeconds: 9, endSeconds: 13 }]);
    (clock as unknown as { currentTime: number }).currentTime = 2;
    expect(transport.getCurrentTime()).toBe(9);
    backend.gate.resolve(); await flush();
    expect(transport.getState()).toBe("playing"); expect(transport.getCurrentTime()).toBe(9);
  });

  it("requeues the old lookahead presses after an atomic output/bank switch", async () => {
    const { transport, output, backingPlan, plan } = setup();
    transport.loadPlan({ ...plan, events: [
      { type: "press", noteId: "future", pitch: 62, velocity: 90, timeSeconds: 0.05 },
      { type: "release", noteId: "future", timeSeconds: 1 },
    ] }, 20);
    transport.loadAccompanimentPlan(backingPlan);
    await transport.play();
    expect(output.noteOn).toHaveBeenCalledWith("future", 62, 90, 0.05);
    const candidate = new Backing();
    await transport.prepareAccompanimentBackend(candidate);
    const nextOutput = { ...output, noteOn: vi.fn(), dispose: vi.fn(), panic: vi.fn() };
    transport.setOutput(nextOutput, candidate);
    expect(transport.getState()).toBe("playing");
    expect(nextOutput.noteOn).toHaveBeenCalledWith("future", 62, 90, 0.05);
  });

  it("prepares bounded loop head and current windows together and rejects a stale plan candidate", async () => {
    const { transport } = setup();
    transport.setLoop({ startSeconds: 1, endSeconds: 18 }); transport.seek(8);
    const candidate = new Backing();
    await transport.prepareAccompanimentBackend(candidate);
    expect(candidate.requests[0]!.windows).toEqual([{ startSeconds: 1, endSeconds: 5 }, { startSeconds: 8, endSeconds: 12 }]);
    candidate.ready = null; candidate.gate = deferred();
    const pending = transport.prepareAccompanimentBackend(candidate); await flush();
    transport.loadAccompanimentPlan(null); candidate.gate.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.getAccompanimentPlan()).toBeNull();
  });

  it.each(["pause", "dispose"] as const)("aborts pending backing preparation on %s without late resume", async (action) => {
    const { transport, backend } = setup();
    const errors: Error[] = []; transport.subscribeOutputError((error) => errors.push(error));
    backend.gate = deferred();
    const playing = transport.play(); await flush();
    const request = backend.requests[0]!;
    transport[action]();
    expect(request.signal?.aborted).toBe(true);
    backend.gate.resolve(); await playing;
    expect(transport.getState()).not.toBe("playing"); expect(transport.isPreparingOutput()).toBe(false);
    expect(backend.noteOn).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  });

  it("keeps the active pair when candidate preparation fails", async () => {
    const { transport, output, backend } = setup();
    const candidate = new Backing();
    candidate.prepareWindows = async () => { throw new Error("Cannot decode violin"); };
    await expect(transport.prepareAccompanimentBackend(candidate)).rejects.toThrow("Cannot decode violin");
    expect(transport.getOutput()).toBe(output); expect(output.dispose).not.toHaveBeenCalled();
    expect(backend.dispose).not.toHaveBeenCalled();
  });
});
