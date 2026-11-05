import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccompanimentNote, AccompanimentPlan } from "../accompaniment.ts";
import type { Sf2SoundFont } from "./types.ts";

const mocks = vi.hoisted(() => ({ synths: [] as Array<{
  loadSoundFont: ReturnType<typeof vi.fn>; prepareNotes: ReturnType<typeof vi.fn>; areNotesPrepared: ReturnType<typeof vi.fn>;
  noteOn: ReturnType<typeof vi.fn>; noteOff: ReturnType<typeof vi.fn>; silenceAll: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>;
}> }));
vi.mock("./soundfontSynth.ts", () => ({
  SoundFontSynth: class {
    loadSoundFont = vi.fn();
    prepareNotes = vi.fn(async () => {});
    areNotesPrepared = vi.fn(() => true);
    noteOn = vi.fn(); noteOff = vi.fn(); silenceAll = vi.fn(); dispose = vi.fn();
    constructor() { mocks.synths.push(this); }
  },
}));

import { SoundFontAccompanimentSampler } from "./soundfontAccompaniment.ts";

function context() {
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() });
  const gains: Array<{ gain: ReturnType<typeof param>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const oscillators: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const ctx = {
    currentTime: 2, destination: {},
    createGain: () => { const gain = { gain: param(), connect: vi.fn(), disconnect: vi.fn() }; gains.push(gain); return gain; },
    createBiquadFilter: () => ({ frequency: param(), Q: param(), connect: vi.fn() }),
    createOscillator: () => {
      const oscillator = { frequency: param(), detune: param(), connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      oscillators.push(oscillator);
      return oscillator;
    },
  } as unknown as AudioContext;
  return { ctx, gains, oscillators };
}

function bank(): Sf2SoundFont {
  return {
    header: { name: "GM", versionMajor: 2, versionMinor: 1 },
    presets: [
      { bankNumber: 1, presetNumber: 40, name: "Wrong bank", zones: [{ keyRange: [0, 127], velRange: [0, 127], sampleIndex: 0 }] },
      ...[0, 40, 42].map((program) => ({ bankNumber: 0, presetNumber: program, name: `GM ${program}`, zones: [{ keyRange: [0, 127] as [number, number], velRange: [0, 127] as [number, number], sampleIndex: 0 }] })),
      { bankNumber: 0, presetNumber: 48, name: "Empty", zones: [] },
      { bankNumber: 0, presetNumber: 49, name: "Bad sample", zones: [{ keyRange: [0, 127], velRange: [0, 127], sampleIndex: 99 }] },
    ],
    samples: [{ name: "sample", start: 0, end: 20, loopStart: 0, loopEnd: 20, sampleRate: 44100, originalPitch: 60, pitchCorrection: 0, sampleType: 1 }],
  };
}
function note(id: string, program: number, startSeconds: number, endSeconds: number, pitch = 60): AccompanimentNote {
  return { noteId: id, trackId: `track-${program}`, program, pitch, velocity: 90, startSeconds, endSeconds };
}
function plan(notes: AccompanimentNote[]): AccompanimentPlan { return { notes, events: [], tracks: [] }; }
function bankWithPrograms(programs: number[]): Sf2SoundFont {
  const sf = bank();
  return { ...sf, presets: programs.map((program) => ({ ...sf.presets[2]!, presetNumber: program })) };
}
const backends: SoundFontAccompanimentSampler[] = [];
function setup(sf = bank(), fallbackSoundFont?: Sf2SoundFont) {
  const { ctx, gains, oscillators } = context();
  const destination = {} as AudioNode;
  const backend = new SoundFontAccompanimentSampler({ soundFont: sf, fallbackSoundFont, audioContext: ctx, destinationNode: destination });
  backends.push(backend);
  return { backend, gains, destination, oscillators };
}
afterEach(() => { for (const backend of backends.splice(0)) backend.dispose(); mocks.synths.length = 0; });

describe("SoundFont accompaniment", () => {
  it("prefers the selected bank and uses the built-in bank only for missing exact programs", async () => {
    const selected = bankWithPrograms([40]);
    const builtin = bankWithPrograms([40, 42]);
    const { backend, oscillators } = setup(selected, builtin);
    const score = plan([note("missing", 48, 0, 3), note("builtin", 42, 0, 3), note("primary", 40, 0, 3), note("repeat", 42, 1, 2)]);
    expect(backend.getBuiltinFallbackPrograms(score)).toEqual([42]);
    expect(backend.getFallbackPrograms(score)).toEqual([48]);
    expect(mocks.synths).toHaveLength(0);
    await backend.prepareWindows(score, [{ startSeconds: 0, endSeconds: 3 }]);
    expect(mocks.synths).toHaveLength(2);
    expect(mocks.synths[0]!.loadSoundFont).toHaveBeenCalledExactlyOnceWith(builtin, 1);
    expect(mocks.synths[1]!.loadSoundFont).toHaveBeenCalledExactlyOnceWith(selected, 0);
    backend.noteOn("primary", 60, 90, 40);
    backend.noteOn("builtin", 60, 90, 42);
    expect(oscillators).toHaveLength(0);
    expect(mocks.synths[1]!.noteOn).toHaveBeenCalledWith(60, 90, "primary", undefined);
    expect(mocks.synths[0]!.noteOn).toHaveBeenCalledWith(60, 90, "builtin", undefined);
    backend.noteOn("missing", 60, 90, 48);
    expect(oscillators).toHaveLength(2);
    backend.allNotesOff();
    for (const oscillator of oscillators) expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(selected.presets).toHaveLength(1);
    expect(builtin.presets).toHaveLength(2);
  });

  it("uses built-in programs for empty and broken primary presets without choosing a wrong bank", async () => {
    const selected = bank();
    const builtin = bankWithPrograms([41, 48, 49]);
    builtin.presets.unshift({ ...builtin.presets[0]!, bankNumber: 1, presetNumber: 50 });
    const { backend } = setup(selected, builtin);
    const score = plan([note("missing", 41, 0, 1), note("empty", 48, 0, 1), note("bad", 49, 0, 1), note("wrong-bank", 50, 0, 1)]);
    expect(backend.getBuiltinFallbackPrograms(score)).toEqual([41, 48, 49]);
    expect(backend.getFallbackPrograms(score)).toEqual([50]);
    await backend.prepareWindows(score, [{ startSeconds: 0, endSeconds: 1 }]);
    expect(mocks.synths).toHaveLength(3);
    mocks.synths.forEach((synth, index) => expect(synth.loadSoundFont).toHaveBeenCalledExactlyOnceWith(builtin, index + 1));
  });

  it("prepares only selected routes in the current and loop windows across both banks", async () => {
    const selected = bankWithPrograms([40]);
    const builtin = bankWithPrograms([40, 42, 48]);
    const { backend } = setup(selected, builtin);
    const score = plan([note("held", 40, 0, 20, 62), note("head", 42, 1, 2, 63), note("future", 48, 100, 101)]);
    await backend.prepareWindows(score, [{ startSeconds: 1, endSeconds: 3 }, { startSeconds: 10, endSeconds: 14 }]);
    expect(mocks.synths).toHaveLength(2);
    expect(mocks.synths[0]!.prepareNotes).toHaveBeenCalledExactlyOnceWith([{ pitch: 62, velocity: 90 }], expect.any(AbortSignal));
    expect(mocks.synths[1]!.prepareNotes).toHaveBeenCalledExactlyOnceWith([{ pitch: 63, velocity: 90 }], expect.any(AbortSignal));
    await backend.prepareWindows(score, [{ startSeconds: 100, endSeconds: 101 }]);
    expect(mocks.synths[0]!.prepareNotes).toHaveBeenLastCalledWith([], expect.any(AbortSignal));
    expect(mocks.synths[1]!.prepareNotes).toHaveBeenLastCalledWith([], expect.any(AbortSignal));
    expect(mocks.synths[2]!.loadSoundFont).toHaveBeenCalledExactlyOnceWith(builtin, 2);
    backend.dispose();
    for (const synth of mocks.synths) expect(synth.dispose).toHaveBeenCalledOnce();
  });

  it("selects exact bank-zero GM presets lazily using the same immutable parsed bank", async () => {
    const sf = bank();
    const { backend } = setup(sf);
    const score = plan([note("violin", 40, 0, 3), note("cello", 42, 1, 4), note("later", 0, 100, 101)]);
    expect(mocks.synths).toHaveLength(0);
    await backend.prepareWindows(score, [{ startSeconds: 1, endSeconds: 2 }]);
    expect(mocks.synths).toHaveLength(2);
    expect(mocks.synths[0]!.loadSoundFont).toHaveBeenCalledWith(sf, 2);
    expect(mocks.synths[1]!.loadSoundFont).toHaveBeenCalledWith(sf, 3);
    expect(mocks.synths[0]!.prepareNotes).toHaveBeenCalledWith([{ pitch: 60, velocity: 90 }], expect.any(AbortSignal));
  });

  it("prepares only held/current and loop-head notes and releases programs left behind", async () => {
    const { backend } = setup();
    const score = plan([note("held", 40, 0, 20), note("head", 42, 1, 2), note("middle", 0, 20, 21), note("future", 0, 100, 101)]);
    await backend.prepareWindows(score, [{ startSeconds: 1, endSeconds: 3 }, { startSeconds: 10, endSeconds: 14 }]);
    expect(mocks.synths).toHaveLength(2);
    expect(backend.isWindowsPrepared(score, [{ startSeconds: 11, endSeconds: 12 }])).toBe(true);
    expect(backend.isWindowsPrepared(score, [{ startSeconds: 20, endSeconds: 21 }])).toBe(false);
    await backend.prepareWindows(score, [{ startSeconds: 20, endSeconds: 21 }]);
    expect(mocks.synths[0]!.prepareNotes).toHaveBeenLastCalledWith([], expect.any(AbortSignal));
    expect(mocks.synths[1]!.prepareNotes).toHaveBeenLastCalledWith([], expect.any(AbortSignal));
    expect(mocks.synths).toHaveLength(3);
  });

  it("reports missing, empty, and broken presets explicitly without selecting another bank/piano", async () => {
    const { backend } = setup();
    const score = plan([note("missing", 41, 0, 1), note("empty", 48, 0, 1), note("bad", 49, 0, 1)]);
    expect(backend.getFallbackPrograms(score)).toEqual([41, 48, 49]);
    await backend.prepareWindows(score, [{ startSeconds: 0, endSeconds: 1 }]);
    expect(mocks.synths).toHaveLength(0);
    expect(backend.isWindowsPrepared(score, [{ startSeconds: 0, endSeconds: 1 }])).toBe(true);
    backend.noteOn("fallback", 60, 90, 41);
    backend.allNotesOff();
  });

  it("releases prior program sample preparation when moving to a silent window", async () => {
    const { backend } = setup();
    const score = plan([note("a", 40, 0, 1)]);
    await backend.prepareWindows(score, [{ startSeconds: 0, endSeconds: 1 }]);
    await backend.prepareWindows(score, [{ startSeconds: 5, endSeconds: 6 }]);
    expect(mocks.synths[0]!.prepareNotes).toHaveBeenLastCalledWith([], expect.any(AbortSignal));
  });

  it("keeps same-pitch voice IDs and program routes separate, with independent gain and panic", async () => {
    const { backend, gains, destination } = setup();
    await backend.prepareWindows(plan([note("a", 40, 0, 2), note("b", 42, 0, 2)]), [{ startSeconds: 0, endSeconds: 2 }]);
    backend.noteOn("a", 60, 90, 40, 3); backend.noteOn("b", 60, 80, 42, 3);
    backend.noteOff("a", 4);
    expect(mocks.synths[0]!.noteOff).toHaveBeenCalledWith("a", 60, 4);
    expect(mocks.synths[1]!.noteOff).not.toHaveBeenCalled();
    expect(gains[0]!.connect).toHaveBeenCalledWith(destination);
    backend.setVolume(0);
    expect(gains[0]!.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 2);
    backend.noteOn("silent", 60, 90, 40, 5);
    expect(mocks.synths[0]!.noteOn).toHaveBeenCalledTimes(1);
    backend.setEnabled(false);
    for (const synth of mocks.synths) expect(synth.silenceAll).toHaveBeenCalled();
    backend.dispose();
    for (const synth of mocks.synths) expect(synth.dispose).toHaveBeenCalledOnce();
  });

  it("cancels stale preparation and bank disposal without marking the old request prepared", async () => {
    const { backend } = setup();
    const score = plan([note("a", 40, 0, 10)]);
    await backend.prepareWindows(score, [{ startSeconds: 0, endSeconds: 1 }]);
    let finish!: () => void;
    let pendingSignal!: AbortSignal;
    mocks.synths[0]!.prepareNotes.mockImplementationOnce((_notes, signal) => new Promise<void>((resolve) => { finish = resolve; pendingSignal = signal; }));
    const controller = new AbortController();
    const pending = backend.prepareWindows(score, [{ startSeconds: 5, endSeconds: 6 }], controller.signal);
    controller.abort(); finish();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(pendingSignal.aborted).toBe(true);
    expect(mocks.synths[0]!.prepareNotes).toHaveBeenLastCalledWith([]);
    expect(backend.isWindowsPrepared(score, [{ startSeconds: 5, endSeconds: 6 }])).toBe(false);
    backend.dispose();
    const next = setup(bank()).backend;
    await next.prepareWindows(score, [{ startSeconds: 5, endSeconds: 6 }]);
    expect(mocks.synths).toHaveLength(2);
    expect(mocks.synths[0]!.dispose).toHaveBeenCalledOnce();
    expect(next.isWindowsPrepared(score, [{ startSeconds: 5, endSeconds: 6 }])).toBe(true);
  });

  it("releases successful routes after another program fails and allows a fresh preparation", async () => {
    const { backend } = setup(bankWithPrograms([40]), bankWithPrograms([42]));
    const score = plan([note("a", 40, 0, 20), note("b", 42, 0, 20)]);
    await backend.prepareWindows(score, [{ startSeconds: 0, endSeconds: 1 }]);
    const error = new Error("decode failed");
    mocks.synths[1]!.prepareNotes.mockRejectedValueOnce(error);
    await expect(backend.prepareWindows(score, [{ startSeconds: 5, endSeconds: 6 }])).rejects.toBe(error);
    expect(backend.isWindowsPrepared(score, [{ startSeconds: 0, endSeconds: 1 }])).toBe(false);
    expect(backend.isWindowsPrepared(score, [{ startSeconds: 5, endSeconds: 6 }])).toBe(false);
    for (const synth of mocks.synths) expect(synth.prepareNotes).toHaveBeenLastCalledWith([]);
    await backend.prepareWindows(score, [{ startSeconds: 5, endSeconds: 6 }]);
    expect(backend.isWindowsPrepared(score, [{ startSeconds: 5, endSeconds: 6 }])).toBe(true);
    for (const synth of mocks.synths) expect(synth.loadSoundFont).toHaveBeenCalledOnce();
  });

  it("retains a playable current window while a future window is staging", async () => {
    const { backend } = setup(bankWithPrograms([40]), bankWithPrograms([42]));
    const score = plan([note("current", 40, 0, 2), note("future", 42, 5, 8)]);
    const current = [{ startSeconds: 0, endSeconds: 1 }];
    const future = [{ startSeconds: 5, endSeconds: 6 }];
    await backend.prepareWindows(score, current);
    let finish!: () => void;
    mocks.synths[0]!.prepareNotes.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = backend.prepareWindows(score, future);
    expect(backend.isWindowsPrepared(score, current)).toBe(true);
    expect(backend.isWindowsPrepared(score, future)).toBe(false);
    finish();
    await pending;
    expect(backend.isWindowsPrepared(score, future)).toBe(true);
    expect(backend.isWindowsPrepared(score, current)).toBe(false);
  });

  it("does not let a superseded request clear the new window preparation", async () => {
    const { backend } = setup(bankWithPrograms([40]), bankWithPrograms([42]));
    const score = plan([note("a", 40, 0, 20), note("b", 42, 0, 20)]);
    await backend.prepareWindows(score, [{ startSeconds: 0, endSeconds: 1 }]);
    let finish!: () => void;
    let oldSignal!: AbortSignal;
    mocks.synths[0]!.prepareNotes.mockImplementationOnce((_notes, signal) => new Promise<void>((resolve) => { finish = resolve; oldSignal = signal; }));
    const old = backend.prepareWindows(score, [{ startSeconds: 5, endSeconds: 6 }]);
    await backend.prepareWindows(score, [{ startSeconds: 10, endSeconds: 11 }]);
    finish();
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    expect(oldSignal.aborted).toBe(true);
    expect(backend.isWindowsPrepared(score, [{ startSeconds: 10, endSeconds: 11 }])).toBe(true);
    for (const synth of mocks.synths) expect(synth.prepareNotes).toHaveBeenLastCalledWith([{ pitch: 60, velocity: 90 }], expect.any(AbortSignal));
  });
});
