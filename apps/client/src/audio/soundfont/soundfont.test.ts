import { describe, it, expect, vi } from "vitest";
import { InvalidSoundFontError, Sf2Parser } from "./sf2Parser";
import { SoundFontSynth } from "./soundfontSynth";
import { getSoundFontSampleProviderStats, resetSharedSoundFontSampleProviderForTests } from "./soundfontSampleProvider.ts";
import { createSyntheticMonoSf2 } from "./testing/syntheticMonoSf2.ts";
import type { Sf2SoundFont } from "./types";

type StereoTestBuffer = { duration: number; sampleRate: number; getChannelData: (channel: number) => Float32Array };
type StereoTestSource = {
  buffer: StereoTestBuffer | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  playbackRate: { setValueAtTime: ReturnType<typeof vi.fn> };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
};

function createStereoLoopSynth(leftMode: number, rightMode: number) {
  const sources: StereoTestSource[] = [];
  const gains: Array<{
    gain: {
      setValueAtTime: ReturnType<typeof vi.fn>;
      cancelScheduledValues: ReturnType<typeof vi.fn>;
      exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const audioContext = {
    currentTime: 0,
    destination: {},
    createGain: vi.fn().mockImplementation(() => {
      const gain = {
        gain: {
          setValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    }),
    createBuffer: vi.fn().mockImplementation((_channels: number, frames: number, sampleRate: number) => ({
      duration: frames / sampleRate,
      sampleRate,
      getChannelData: vi.fn().mockReturnValue(new Float32Array(frames)),
    })),
    createBufferSource: vi.fn().mockImplementation(() => {
      const source: StereoTestSource = {
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        playbackRate: { setValueAtTime: vi.fn() },
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: null,
      };
      sources.push(source);
      return source;
    }),
  };
  const soundFont: Sf2SoundFont = {
    header: { name: "Stereo Loop Modes", versionMajor: 2, versionMinor: 4 },
    presets: [{ name: "Piano", presetNumber: 0, bankNumber: 0, zones: [
      {
        keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0, instrumentId: 1,
        presetZoneId: 2, instrumentZoneId: 3, sampleModes: rightMode, releaseSeconds: 0.2,
      },
      {
        keyRange: [60, 60], velRange: [1, 127], sampleIndex: 1, instrumentId: 1,
        presetZoneId: 2, instrumentZoneId: 3, sampleModes: leftMode, releaseSeconds: 0.4,
      },
    ] }],
    samples: [
      { name: "Right", start: 0, end: 100, loopStart: 20, loopEnd: 60, sampleRate: 100, originalPitch: 60, pitchCorrection: 0, sampleType: 2, sampleLink: 1 },
      { name: "Left", start: 146, end: 286, loopStart: 180, loopEnd: 250, sampleRate: 100, originalPitch: 60, pitchCorrection: 0, sampleType: 4, sampleLink: 0 },
    ],
    rawSampleData: new Int16Array(286),
  };
  const synth = new SoundFontSynth({ audioContext: audioContext as unknown as AudioContext });
  synth.loadSoundFont(soundFont);
  return { audioContext, gains, sources, synth, soundFont };
}

describe("SoundFont 2 Parser & Synthesizer (W042, W043)", () => {
  it("distinguishes an explicit compressed pair linked to index zero from MuseScore zero links", () => {
    const { synth, sources, soundFont } = createStereoLoopSynth(3, 3);
    soundFont.header.versionMajor = 3;
    for (const sample of soundFont.samples) { sample.compressed = true; sample.sampleType |= 0x10; }
    synth.loadSoundFont(soundFont);
    synth.noteOn(60, 90, "linked-sf3", 0.2);
    expect(sources).toHaveLength(2);
    expect(synth.getActiveVoiceCount()).toBe(1);
    expect(sources.every(source => source.start.mock.calls[0]?.[0] === 0.2)).toBe(true);
    synth.dispose();
  });
  it("plays MuseScore SF3 zero-link channel zones once with shared note lifecycle", () => {
    const { audioContext, sources, synth } = createStereoLoopSynth(3, 3);
    const sf: Sf2SoundFont = {
      header: { name: "SF3 channel zones", versionMajor: 3, versionMinor: 1 },
      presets: [{ name: "Piano", presetNumber: 0, bankNumber: 0, zones: [
        { keyRange: [60,60], velRange: [1,127], sampleIndex: 0, sampleModes: 3 },
        { keyRange: [60,60], velRange: [1,127], sampleIndex: 1, pan: 500, sampleModes: 3 },
      ] }],
      samples: [
        { name: "L", compressed: true, sampleType: 0x14, sampleLink: 0, start: 0, end: 100, loopStart: 20, loopEnd: 60, sampleRate: 100, originalPitch: 60, pitchCorrection: 0 },
        { name: "R", compressed: true, sampleType: 0x12, sampleLink: 0, start: 0, end: 100, loopStart: 20, loopEnd: 60, sampleRate: 100, originalPitch: 60, pitchCorrection: 0 },
      ],
      rawSampleData: new Int16Array(100),
    };
    const pans: number[] = [];
    Object.assign(audioContext, { createStereoPanner: () => ({ pan: { setValueAtTime: (v: number) => pans.push(v) }, connect: vi.fn(), disconnect: vi.fn() }) });
    synth.loadSoundFont(sf);
    synth.noteOn(60, 80, "same-id", 0.2);
    expect(sources).toHaveLength(2);
    expect(sources.every(source => source.start.mock.calls[0]?.[0] === 0.2)).toBe(true);
    expect(pans).toEqual([-1,1]);
    expect(synth.getActiveVoiceCount()).toBe(2);
    synth.pedalChange(64, 127, 0.3);
    synth.noteOff("same-id", undefined, 0.4);
    expect(sources.every(source => source.stop.mock.calls.length === 0)).toBe(true);
    synth.pedalChange(64, 0, 0.5);
    expect(sources.every(source => source.stop.mock.calls.length > 0)).toBe(true);
    synth.dispose();
    expect(synth.getActiveVoiceCount()).toBe(0);
  });

  it("selects bank 0 preset 0 (Grand Piano) by default when presets are not ordered by program number", () => {
    const { audioContext } = createStereoLoopSynth(0, 0);
    const sf: Sf2SoundFont = {
      header: { name: "Unordered GM Bank", versionMajor: 3, versionMinor: 1 },
      presets: [
        { name: "Contrabass", bankNumber: 0, presetNumber: 43, zones: [{ keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0 }] },
        { name: "Cello", bankNumber: 0, presetNumber: 42, zones: [{ keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0 }] },
        { name: "Grand Piano", bankNumber: 0, presetNumber: 0, zones: [{ keyRange: [60, 60], velRange: [1, 127], sampleIndex: 1 }] },
      ],
      samples: [
        { name: "CelloSample", start: 0, end: 50, loopStart: 0, loopEnd: 50, sampleRate: 100, originalPitch: 48, pitchCorrection: 0, sampleType: 1 },
        { name: "PianoSample", start: 50, end: 100, loopStart: 50, loopEnd: 100, sampleRate: 100, originalPitch: 60, pitchCorrection: 0, sampleType: 1 },
      ],
      rawSampleData: new Int16Array(100),
    };
    const synth = new SoundFontSynth({ audioContext: audioContext as unknown as AudioContext });
    synth.loadSoundFont(sf);
    expect(synth.areNotesPrepared([{ pitch: 60, velocity: 100 }])).toBe(false);
    void synth.prepareNotes([{ pitch: 60, velocity: 100 }]);
    expect(synth.areNotesPrepared([{ pitch: 60, velocity: 100 }])).toBe(true);
    synth.noteOn(60, 100, "piano-c4", 0);
    // PianoSample has rootKey 60 -> playbackRate 1.0 (whereas CelloSample has rootKey 48 -> playbackRate 2.0)
    const lastSource = audioContext.createBufferSource.mock.results.at(-1)?.value as StereoTestSource;
    expect(lastSource.playbackRate.setValueAtTime).toHaveBeenCalledWith(1, 0);
    synth.dispose();
  });

  it("rejects non-SF2 buffers with descriptive InvalidSoundFontError", () => {
    // Empty
    expect(() => new Sf2Parser(new Uint8Array(4)).parse()).toThrow(InvalidSoundFontError);

    // Non-RIFF
    const notRiff = new TextEncoder().encode("NOT_RIFF_DATA_1234");
    expect(() => new Sf2Parser(notRiff.buffer).parse()).toThrow(InvalidSoundFontError);

    // RIFF but not sfbk
    const badForm = new Uint8Array(16);
    badForm.set(new TextEncoder().encode("RIFF"), 0);
    new DataView(badForm.buffer).setUint32(4, 8, true);
    badForm.set(new TextEncoder().encode("WAVE"), 8);
    expect(() => new Sf2Parser(badForm.buffer).parse()).toThrow(/sfbk/);
  });

  it("parses valid SF2 RIFF structure with presets and samples", () => {
    const bytes = createSyntheticMonoSf2({ sampleRate: 44_100, seconds: 0.001 });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const parser = new Sf2Parser(buffer);
    const sf = parser.parse();

    expect(sf.header.name).toBe("Synthetic Mono SF2");
    expect(sf.samples).toHaveLength(2); // Includes the required terminal EOS sample header.
    expect(sf.samples[0]?.name).toBe("Synthetic A4");
    expect(sf.samples[0]?.sampleRate).toBe(44100);
    expect(sf.samples[0]?.originalPitch).toBe(69);
    expect(sf.rawSampleData?.length).toBe(128);
    expect(sf.presets.length).toBeGreaterThan(0);
  });

  it("synthesizes notes and handles polyphony and pedals in SoundFontSynth", () => {
    // Mock Web Audio Context
    const mockDestination = {};
    const mockMasterGain = {
      gain: {
        setValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        value: 0.8,
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    const mockBuffer = {
      getChannelData: vi.fn().mockReturnValue(new Float32Array(10)),
    };

    const createdSources: Array<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      playbackRate: { setValueAtTime: ReturnType<typeof vi.fn> };
    }> = [];

    const mockAudioContext = {
      currentTime: 10.0,
      destination: mockDestination,
      createGain: vi.fn().mockReturnValue(mockMasterGain),
      createBuffer: vi.fn().mockReturnValue(mockBuffer),
      createBufferSource: vi.fn().mockImplementation(() => {
        const src = {
          buffer: null,
          playbackRate: { setValueAtTime: vi.fn() },
          start: vi.fn(),
          stop: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
          onended: null as (() => void) | null,
        };
        createdSources.push(src);
        return src;
      }),
      createStereoPanner: vi.fn().mockReturnValue({
        pan: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
    };

    const mockSoundFont: Sf2SoundFont = {
      header: { name: "Concert Grand", versionMajor: 2, versionMinor: 4 },
      presets: [
        {
          name: "Grand Piano",
          presetNumber: 0,
          bankNumber: 0,
          zones: [
            {
              keyRange: [21, 108],
              velRange: [1, 127],
              sampleIndex: 0,
              rootKey: 60,
              pitchCorrection: 0,
              attackSeconds: 0.005,
              releaseSeconds: 0.3,
            },
          ],
        },
      ],
      samples: [
        {
          name: "Piano_C4",
          start: 0,
          end: 10,
          loopStart: 0,
          loopEnd: 10,
          sampleRate: 44100,
          originalPitch: 60,
          pitchCorrection: 0,
          sampleType: 1,
        },
      ],
      rawSampleData: new Int16Array([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
    };

    const synth = new SoundFontSynth({
      // @ts-expect-error mock context
      audioContext: mockAudioContext,
      maxPolyphony: 2,
    });

    synth.loadSoundFont(mockSoundFont);

    // Play note C4 (pitch 60)
    synth.noteOn(60, 100, "note-1");
    expect(createdSources).toHaveLength(1);
    // Playback rate for rootKey 60 played at 60 is exactly 1.0 (2^0)
    expect(createdSources[0]?.playbackRate.setValueAtTime).toHaveBeenCalledWith(1.0, 10.0);
    expect(synth.getActiveVoiceCount()).toBe(1);

    // Play note C5 (pitch 72, +12 semitones = 2.0x playback rate)
    synth.noteOn(72, 80, "note-2");
    expect(createdSources).toHaveLength(2);
    expect(createdSources[1]?.playbackRate.setValueAtTime).toHaveBeenCalledWith(2.0, 10.0);
    expect(synth.getActiveVoiceCount()).toBe(2);

    // Sustain pedal down
    synth.pedalChange(64, 127);
    expect(synth.getPedalState().sustain).toBe(true);

    // Note off should NOT immediately release voice while sustain is engaged
    synth.noteOff(60);
    expect(synth.getActiveVoiceCount()).toBe(2);

    // Sustain pedal lift releases sustained voice
    synth.pedalChange(64, 0);
    expect(synth.getPedalState().sustain).toBe(false);

    // Silence all
    synth.silenceAll();
    expect(synth.getActiveVoiceCount()).toBe(0);

    synth.pedalChange(64, 127, 10.5);
    expect(synth.getPedalState().sustain).toBe(false);
    mockAudioContext.currentTime = 10.5;
    expect(synth.getPedalState().sustain).toBe(true);

    synth.dispose();
  });

  it("validates SF2 loop bounds and handles sample modes 0, 1, and 3 correctly", () => {
    interface MockBufferSource {
      loop?: boolean;
      loopStart?: number;
      loopEnd?: number;
      playbackRate: { setValueAtTime: ReturnType<typeof vi.fn> };
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    }
    const createdSources: MockBufferSource[] = [];
    const mockAudioContext = {
      currentTime: 0,
      destination: {},
      createGain: vi.fn().mockReturnValue({
        gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), exponentialRampToValueAtTime: vi.fn(), value: 0.8 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createBuffer: vi.fn().mockReturnValue({ duration: 1.0, getChannelData: vi.fn().mockReturnValue(new Float32Array(44100)) }),
      createBufferSource: vi.fn().mockImplementation(() => {
        const src = {
          buffer: null,
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          playbackRate: { setValueAtTime: vi.fn() },
          start: vi.fn(),
          stop: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
          onended: null as (() => void) | null,
        };
        createdSources.push(src);
        return src;
      }),
      createStereoPanner: vi.fn().mockReturnValue({ pan: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }),
    };

    const sf: Sf2SoundFont = {
      header: { name: "LoopTest", versionMajor: 2, versionMinor: 4 },
      presets: [
        {
          name: "Presets",
          presetNumber: 0,
          bankNumber: 0,
          zones: [
            // Mode 1: continuous loop
            { keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0, sampleModes: 1 },
            // Mode 0: no loop
            { keyRange: [61, 61], velRange: [1, 127], sampleIndex: 0, sampleModes: 0 },
            // Mode 3: loop while held, unloop on release
            { keyRange: [62, 62], velRange: [1, 127], sampleIndex: 0, sampleModes: 3 },
            // Invalid loop bounds (loopEnd <= loopStart)
            { keyRange: [63, 63], velRange: [1, 127], sampleIndex: 1, sampleModes: 1 },
          ],
        },
      ],
      samples: [
        { name: "ValidSample", start: 0, end: 44100, loopStart: 4410, loopEnd: 22050, sampleRate: 44100, originalPitch: 60, pitchCorrection: 0, sampleType: 1 },
        { name: "InvalidLoopSample", start: 0, end: 44100, loopStart: 22050, loopEnd: 4410, sampleRate: 44100, originalPitch: 63, pitchCorrection: 0, sampleType: 1 },
      ],
      rawSampleData: new Int16Array(44100),
    };

    const synth = new SoundFontSynth({
      // @ts-expect-error mock context
      audioContext: mockAudioContext,
      maxPolyphony: 10,
    });
    synth.loadSoundFont(sf);

    // Pitch 60 (Mode 1 - continuous): should loop
    synth.noteOn(60, 100, "note-mode1");
    expect(createdSources[0].loop).toBe(true);
    expect(createdSources[0].loopStart).toBeCloseTo(0.1, 3);
    expect(createdSources[0].loopEnd).toBeCloseTo(0.5, 3);

    // Pitch 61 (Mode 0 - no loop): should not loop
    synth.noteOn(61, 100, "note-mode0");
    expect(createdSources[1].loop).toBe(false);

    // Pitch 62 (Mode 3 - loop while key down): should loop while pressed, unloop on release
    synth.noteOn(62, 100, "note-mode3");
    expect(createdSources[2].loop).toBe(true);
    synth.noteOff("note-mode3");
    expect(createdSources[2].loop).toBe(true); // the original loop stops at the exact release timestamp
    expect(createdSources[2].stop).toHaveBeenCalledWith(0);
    expect(createdSources[3]?.loop).toBe(false); // a one-shot loop tail continues after release

    // Pitch 63 (Invalid loop bounds): should not loop
    synth.noteOn(63, 100, "note-badloop");
    expect(createdSources[3].loop).toBe(false);

    synth.dispose();
  });

  it("isolates distinct voices of identical pitch when noteId is provided", () => {
    const mockAudioContext = {
      currentTime: 0,
      destination: {},
      createGain: vi.fn().mockReturnValue({
        gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), exponentialRampToValueAtTime: vi.fn(), value: 0.8 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createBuffer: vi.fn().mockReturnValue({ duration: 1.0, getChannelData: vi.fn().mockReturnValue(new Float32Array(44100)) }),
      createBufferSource: vi.fn().mockImplementation(() => ({
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        playbackRate: { setValueAtTime: vi.fn() },
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: null as (() => void) | null,
      })),
      createStereoPanner: vi.fn().mockReturnValue({ pan: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }),
    };

    const sf: Sf2SoundFont = {
      header: { name: "PolyTest", versionMajor: 2, versionMinor: 4 },
      presets: [
        {
          name: "Default",
          presetNumber: 0,
          bankNumber: 0,
          zones: [{ keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0 }],
        },
      ],
      samples: [
        { name: "C4", start: 0, end: 44100, loopStart: 0, loopEnd: 44100, sampleRate: 44100, originalPitch: 60, pitchCorrection: 0, sampleType: 1 },
      ],
      rawSampleData: new Int16Array(44100),
    };

    const synth = new SoundFontSynth({
      // @ts-expect-error mock context
      audioContext: mockAudioContext,
      maxPolyphony: 10,
    });
    synth.loadSoundFont(sf);

    // Strike two voices with identical pitch (C4 = 60), distinct noteIds
    synth.noteOn(60, 90, "voice-left-hand");
    synth.noteOn(60, 110, "voice-right-hand");
    expect(synth.getActiveVoiceCount()).toBe(2);

    // Releasing left-hand note must NOT release right-hand note of same pitch
    synth.noteOff("voice-left-hand");
    expect(synth.getActiveVoiceCount()).toBe(2); // still ringing in release/active

    synth.dispose();
  });

  it("uses the scheduled Web Audio times and cancels only a future release without reattacking", () => {
    const gainCalls = {
      setValueAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    };
    const sources: Array<{
      loop: boolean;
      playbackRate: { setValueAtTime: ReturnType<typeof vi.fn> };
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    }> = [];
    const context = {
      currentTime: 10,
      destination: {},
      createGain: vi.fn().mockReturnValue({ gain: gainCalls, connect: vi.fn(), disconnect: vi.fn() }),
      createBuffer: vi.fn().mockReturnValue({
        duration: 1,
        sampleRate: 44_100,
        getChannelData: vi.fn().mockReturnValue(new Float32Array(44_100)),
      }),
      createBufferSource: vi.fn().mockImplementation(() => {
        const source = {
          loop: false,
          playbackRate: { setValueAtTime: vi.fn() },
          start: vi.fn(),
          stop: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
          onended: null as (() => void) | null,
        };
        sources.push(source);
        return source;
      }),
    };
    const soundFont: Sf2SoundFont = {
      header: { name: "Scheduled", versionMajor: 2, versionMinor: 4 },
      presets: [{ name: "Default", presetNumber: 0, bankNumber: 0, zones: [
        { keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0, releaseSeconds: 0.2 },
      ] }],
      samples: [{ name: "Sample", start: 0, end: 44_100, loopStart: 0, loopEnd: 44_100, sampleRate: 44_100, originalPitch: 60, pitchCorrection: 0, sampleType: 1 }],
      rawSampleData: new Int16Array(44_100),
    };
    const synth = new SoundFontSynth({ audioContext: context as unknown as AudioContext });
    synth.loadSoundFont(soundFont);

    synth.noteOn(60, 100, "scheduled-note", 10.5);
    expect(sources[0]!.start).toHaveBeenCalledWith(10.5);
    expect(sources[0]!.playbackRate.setValueAtTime).toHaveBeenCalledWith(1, 10.5);
    synth.noteOff("scheduled-note", 60, 10.8);
    expect(gainCalls.exponentialRampToValueAtTime).toHaveBeenCalledWith(expect.any(Number), 11);
    expect(sources[0]!.stop).toHaveBeenCalledWith(11.05);

    synth.cancelScheduledFutureEvents(10.7);
    expect(sources[0]!.stop).toHaveBeenLastCalledWith(10.7 + 24 * 60 * 60);
    expect(synth.getKeyDownNotes()).toEqual([{ noteId: "scheduled-note", pitch: 60 }]);
    expect(synth.getActiveVoiceCount()).toBe(1);
    synth.dispose();
  });

  it("uses the SF2 hold-decay-sustain envelope, true dB attenuation, and one-shot default", () => {
    const gains: Array<{
      gain: {
        setValueAtTime: ReturnType<typeof vi.fn>;
        cancelScheduledValues: ReturnType<typeof vi.fn>;
        exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
      };
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    const sources: Array<{
      loop: boolean;
      playbackRate: { setValueAtTime: ReturnType<typeof vi.fn> };
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    }> = [];
    const context = {
      currentTime: 0,
      destination: {},
      createGain: vi.fn().mockImplementation(() => {
        const node = {
          gain: {
            setValueAtTime: vi.fn(),
            cancelScheduledValues: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        gains.push(node);
        return node;
      }),
      createBuffer: vi.fn().mockReturnValue({
        duration: 1,
        sampleRate: 44_100,
        getChannelData: vi.fn().mockReturnValue(new Float32Array(44_100)),
      }),
      createBufferSource: vi.fn().mockImplementation(() => {
        const source = {
          loop: false,
          playbackRate: { setValueAtTime: vi.fn() },
          start: vi.fn(),
          stop: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
          onended: null as (() => void) | null,
        };
        sources.push(source);
        return source;
      }),
    };
    const soundFont: Sf2SoundFont = {
      header: { name: "ADSR", versionMajor: 2, versionMinor: 4 },
      presets: [{ name: "Default", presetNumber: 0, bankNumber: 0, zones: [
        {
          keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0,
          attackSeconds: 0.1, holdSeconds: 0.2, decaySeconds: 0.3,
          sustainPercent: 25, releaseSeconds: 0.4, initialAttenuationDb: 20,
        },
      ] }],
      samples: [{ name: "One shot", start: 0, end: 44_100, loopStart: 4_410, loopEnd: 13_230, sampleRate: 44_100, originalPitch: 60, pitchCorrection: 0, sampleType: 1 }],
      rawSampleData: new Int16Array(44_100),
    };
    const synth = new SoundFontSynth({ audioContext: context as unknown as AudioContext });
    synth.loadSoundFont(soundFont);
    synth.noteOn(60, 100, "adsr-note", 0);

    const gain = gains[1]!.gain;
    const source = sources[0]!;
    const peak = (100 / 127) ** 1.5 * 0.5 * 10 ** (-20 / 20);
    const sustain = peak * 0.25;
    expect(source.loop).toBe(false);
    expect(gain.exponentialRampToValueAtTime).toHaveBeenNthCalledWith(1, peak, 0.1);
    expect(gain.setValueAtTime.mock.calls[1]![0]).toBeCloseTo(peak, 12);
    expect(gain.setValueAtTime.mock.calls[1]![1]).toBeCloseTo(0.3, 12);
    expect(gain.exponentialRampToValueAtTime.mock.calls[1]![0]).toBeCloseTo(sustain, 12);
    expect(gain.exponentialRampToValueAtTime.mock.calls[1]![1]).toBeCloseTo(0.6, 12);

    // A release that begins during decay starts at the instantaneous ADSR value.
    const releaseStart = peak * Math.sqrt(0.25);
    synth.noteOff("adsr-note", 60, 0.45);
    const releaseValue = gain.setValueAtTime.mock.calls[gain.setValueAtTime.mock.calls.length - 1]!;
    const releaseRamp = gain.exponentialRampToValueAtTime.mock.calls[gain.exponentialRampToValueAtTime.mock.calls.length - 1]!;
    expect(releaseValue[0]).toBeCloseTo(releaseStart, 12);
    expect(releaseValue[1]).toBe(0.45);
    expect(releaseRamp[0]).toBe(0.0001);
    expect(releaseRamp[1]).toBeCloseTo(0.85, 12);
    synth.dispose();
  });

  it("cancels a future release and resumes the current decay phase", () => {
    const gains: Array<{
      gain: {
        setValueAtTime: ReturnType<typeof vi.fn>;
        cancelScheduledValues: ReturnType<typeof vi.fn>;
        exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
      };
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    const sources: Array<{
      loop: boolean;
      playbackRate: { setValueAtTime: ReturnType<typeof vi.fn> };
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    }> = [];
    const context = {
      currentTime: 0,
      destination: {},
      createGain: vi.fn().mockImplementation(() => {
        const node = {
          gain: {
            setValueAtTime: vi.fn(),
            cancelScheduledValues: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        gains.push(node);
        return node;
      }),
      createBuffer: vi.fn().mockReturnValue({
        duration: 1,
        sampleRate: 44_100,
        getChannelData: vi.fn().mockReturnValue(new Float32Array(44_100)),
      }),
      createBufferSource: vi.fn().mockImplementation(() => {
        const source = {
          loop: false,
          playbackRate: { setValueAtTime: vi.fn() },
          start: vi.fn(),
          stop: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
          onended: null as (() => void) | null,
        };
        sources.push(source);
        return source;
      }),
    };
    const soundFont: Sf2SoundFont = {
      header: { name: "Cancelled decay", versionMajor: 2, versionMinor: 4 },
      presets: [{ name: "Default", presetNumber: 0, bankNumber: 0, zones: [
        {
          keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0,
          attackSeconds: 0.1, holdSeconds: 0.2, decaySeconds: 0.4,
          sustainPercent: 50, releaseSeconds: 0.2,
        },
      ] }],
      samples: [{ name: "Sample", start: 0, end: 44_100, loopStart: 0, loopEnd: 44_100, sampleRate: 44_100, originalPitch: 60, pitchCorrection: 0, sampleType: 1 }],
      rawSampleData: new Int16Array(44_100),
    };
    const synth = new SoundFontSynth({ audioContext: context as unknown as AudioContext });
    synth.loadSoundFont(soundFont);
    synth.noteOn(60, 100, "cancelled-release", 0);
    synth.noteOff("cancelled-release", 60, 0.55);

    const gain = gains[1]!.gain;
    context.currentTime = 0.4;
    synth.cancelScheduledFutureEvents(0.4);
    const peak = (100 / 127) ** 1.5 * 0.5;
    const sustain = peak * 0.5;
    const currentDecay = peak * (sustain / peak) ** 0.25;
    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(0.4);
    const resumedValue = gain.setValueAtTime.mock.calls[gain.setValueAtTime.mock.calls.length - 1]!;
    const resumedDecay = gain.exponentialRampToValueAtTime.mock.calls[gain.exponentialRampToValueAtTime.mock.calls.length - 1]!;
    expect(resumedValue[0]).toBeCloseTo(currentDecay, 12);
    expect(resumedValue[1]).toBe(0.4);
    expect(resumedDecay[0]).toBeCloseTo(sustain, 12);
    expect(resumedDecay[1]).toBeCloseTo(0.7, 12);
    expect(gain.exponentialRampToValueAtTime.mock.calls.filter((call) => call[0] === peak && call[1] === 0.1)).toHaveLength(1);
    expect(synth.getKeyDownNotes()).toEqual([{ noteId: "cancelled-release", pitch: 60 }]);
    synth.dispose();
  });

  it("keeps mode 3 looping through sustain and exits only at effective release", () => {
    const sources: Array<{
      loop: boolean;
      loopStart: number;
      loopEnd: number;
      playbackRate: { setValueAtTime: ReturnType<typeof vi.fn> };
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    }> = [];
    const context = {
      currentTime: 0,
      destination: {},
      createGain: vi.fn().mockReturnValue({
        gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(), disconnect: vi.fn(),
      }),
      createBuffer: vi.fn().mockReturnValue({
        duration: 1,
        sampleRate: 44_100,
        getChannelData: vi.fn().mockReturnValue(new Float32Array(44_100)),
      }),
      createBufferSource: vi.fn().mockImplementation(() => {
        const source = {
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          playbackRate: { setValueAtTime: vi.fn() },
          start: vi.fn(),
          stop: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
          onended: null as (() => void) | null,
        };
        sources.push(source);
        return source;
      }),
    };
    const soundFont: Sf2SoundFont = {
      header: { name: "Mode3Pedal", versionMajor: 2, versionMinor: 4 },
      presets: [{ name: "Default", presetNumber: 0, bankNumber: 0, zones: [
        { keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0, sampleModes: 3 },
      ] }],
      samples: [{ name: "Loop", start: 0, end: 44_100, loopStart: 4_410, loopEnd: 13_230, sampleRate: 44_100, originalPitch: 60, pitchCorrection: 0, sampleType: 1 }],
      rawSampleData: new Int16Array(44_100),
    };
    const synth = new SoundFontSynth({ audioContext: context as unknown as AudioContext });
    synth.loadSoundFont(soundFont);

    synth.noteOn(60, 100, "pedaled", 0);
    synth.pedalChange(64, 127, 0.1);
    synth.noteOff("pedaled", 60, 0.3);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.loop).toBe(true);
    expect(sources[0]!.stop).not.toHaveBeenCalled();

    synth.pedalChange(64, 0, 0.8);
    expect(sources).toHaveLength(2);
    expect(sources[0]!.stop).toHaveBeenCalledWith(0.8);
    expect(sources[1]!.loop).toBe(false);
    expect(sources[1]!.start).toHaveBeenCalledWith(0.8, expect.any(Number));
    synth.dispose();
  });

  it("restores held mode-3 pedals across tempo cancellation and reschedules the actual loop tail", () => {
    const sources: Array<{
      buffer: { duration: number; sampleRate: number } | null;
      loop: boolean;
      loopStart: number;
      loopEnd: number;
      playbackRate: { setValueAtTime: ReturnType<typeof vi.fn> };
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    }> = [];
    const context = {
      currentTime: 0,
      destination: {},
      createGain: vi.fn().mockReturnValue({
        gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(), disconnect: vi.fn(),
      }),
      createBuffer: vi.fn().mockReturnValue({
        duration: 1,
        sampleRate: 44_100,
        getChannelData: vi.fn().mockReturnValue(new Float32Array(44_100)),
      }),
      createBufferSource: vi.fn().mockImplementation(() => {
        const source = {
          buffer: null as { duration: number; sampleRate: number } | null,
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          playbackRate: { setValueAtTime: vi.fn() },
          start: vi.fn(),
          stop: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
          onended: null as (() => void) | null,
        };
        sources.push(source);
        return source;
      }),
    };
    const soundFont: Sf2SoundFont = {
      header: { name: "RestoredLoop", versionMajor: 2, versionMinor: 4 },
      presets: [{ name: "Default", presetNumber: 0, bankNumber: 0, zones: [
        { keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0, sampleModes: 3, releaseSeconds: 0.2 },
      ] }],
      samples: [{ name: "Loop", start: 0, end: 44_100, loopStart: 4_410, loopEnd: 13_230, sampleRate: 44_100, originalPitch: 60, pitchCorrection: 0, sampleType: 1 }],
      rawSampleData: new Int16Array(44_100),
    };
    const synth = new SoundFontSynth({ audioContext: context as unknown as AudioContext });
    synth.loadSoundFont(soundFont);
    synth.restoreState({
      voices: [{
        noteId: "restored-mode3",
        pitch: 60,
        velocity: 100,
        keyState: "down",
        heldBySostenuto: true,
        sustainedBySustain: false,
        softPedalAtPress: false,
      }],
      pedals: { sustain: true, sostenuto: true, soft: false },
    });

    synth.noteOff("restored-mode3", 60, 0.3);
    synth.pedalChange(64, 0, 0.4);
    synth.pedalChange(66, 0, 0.5);
    expect(synth.getPedalState()).toEqual({ sustain: true, sostenuto: true, soft: false });
    expect(sources[0]!.loop).toBe(true);
    expect(sources).toHaveLength(2); // first lookahead release tail

    // Transport.setSpeed cancels the audio-clock suffix and then queues it again.
    synth.cancelScheduledFutureEvents(0.1);
    expect(synth.getPedalState()).toEqual({ sustain: true, sostenuto: true, soft: false });
    expect(synth.getKeyDownNotes()).toEqual([{ noteId: "restored-mode3", pitch: 60 }]);
    expect(sources[0]!.loop).toBe(true);
    expect(sources[0]!.stop).toHaveBeenLastCalledWith(0.1 + 24 * 60 * 60);

    synth.noteOff("restored-mode3", 60, 0.3);
    synth.pedalChange(64, 0, 0.4);
    synth.pedalChange(66, 0, 0.5);
    context.currentTime = 0.45;
    expect(synth.getPedalState()).toEqual({ sustain: false, sostenuto: true, soft: false });
    expect(sources[0]!.loop).toBe(true);
    context.currentTime = 0.55;
    expect(synth.getPedalState()).toEqual({ sustain: false, sostenuto: false, soft: false });
    expect(sources).toHaveLength(3);
    expect(sources[2]!.loop).toBe(false);
    expect(sources[2]!.start).toHaveBeenCalledWith(0.5, expect.any(Number));
    synth.dispose();
  });

  it("implements selective sostenuto (CC66) capturing only held keys without capturing new notes", () => {
    const mockAudioContext = {
      currentTime: 0,
      destination: {},
      createGain: vi.fn().mockReturnValue({
        gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), exponentialRampToValueAtTime: vi.fn(), value: 0.8 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createBuffer: vi.fn().mockReturnValue({ duration: 1.0, getChannelData: vi.fn().mockReturnValue(new Float32Array(44100)) }),
      createBufferSource: vi.fn().mockImplementation(() => ({
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        playbackRate: { setValueAtTime: vi.fn() },
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: null as (() => void) | null,
      })),
      createStereoPanner: vi.fn().mockReturnValue({ pan: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }),
    };

    const sf: Sf2SoundFont = {
      header: { name: "SostenutoTest", versionMajor: 2, versionMinor: 4 },
      presets: [
        {
          name: "Default",
          presetNumber: 0,
          bankNumber: 0,
          zones: [{ keyRange: [60, 72], velRange: [1, 127], sampleIndex: 0 }],
        },
      ],
      samples: [
        { name: "Sample", start: 0, end: 44100, loopStart: 0, loopEnd: 44100, sampleRate: 44100, originalPitch: 60, pitchCorrection: 0, sampleType: 1 },
      ],
      rawSampleData: new Int16Array(44100),
    };

    const synth = new SoundFontSynth({
      // @ts-expect-error mock context
      audioContext: mockAudioContext,
      maxPolyphony: 10,
    });
    synth.loadSoundFont(sf);

    // 1. Press note 1 (C4 = 60)
    synth.noteOn(60, 90, "n1");

    // 2. Depress Sostenuto pedal (CC 66 = 127) -> captures n1
    synth.pedalChange(66, 127);
    expect(synth.getPedalState().sostenuto).toBe(true);

    // 3. Play note 2 (C5 = 72) while Sostenuto is ALREADY held down -> n2 must NOT be captured!
    synth.noteOn(72, 90, "n2");

    // 4. Release keys
    synth.noteOff("n1");
    synth.noteOff("n2");

    // Sostenuto holds n1; lifting Sostenuto releases n1
    synth.pedalChange(66, 0);
    expect(synth.getPedalState().sostenuto).toBe(false);

    synth.dispose();
  });

  it("prepares linked stereo once, keeps right-side pitch control, and preserves each channel's pan and envelope", async () => {
    resetSharedSoundFontSampleProviderForTests();
    const createdSources: Array<{
      buffer: AudioBuffer | null;
      playbackRate: { setValueAtTime: ReturnType<typeof vi.fn> };
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    }> = [];
    const gains: Array<{ gain: { setValueAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: ReturnType<typeof vi.fn>; exponentialRampToValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    const pans: Array<{ pan: { setValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    const audioContext = {
      currentTime: 10,
      sampleRate: 44_100,
      destination: {},
      createGain: vi.fn().mockImplementation(() => {
        const node = {
          gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        gains.push(node);
        return node;
      }),
      createBuffer: vi.fn().mockImplementation((_channels: number, frames: number, sampleRate: number) => ({
        duration: frames / sampleRate,
        sampleRate,
        getChannelData: () => new Float32Array(frames),
      })),
      createBufferSource: vi.fn().mockImplementation(() => {
        const source = {
          buffer: null,
          playbackRate: { setValueAtTime: vi.fn() },
          start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
          onended: null as (() => void) | null,
        };
        createdSources.push(source);
        return source;
      }),
      createStereoPanner: vi.fn().mockImplementation(() => {
        const node = { pan: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
        pans.push(node);
        return node;
      }),
    };
    const soundFont: Sf2SoundFont = {
      header: { name: "Stereo", versionMajor: 2, versionMinor: 4 },
      presets: [{
        name: "Piano", presetNumber: 0, bankNumber: 0, zones: [
          {
            keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0, instrumentId: 4,
            presetZoneId: 2, instrumentZoneId: 8, rootKey: 61, pitchCorrection: 6,
            pan: 500, initialAttenuationDb: 0, attackSeconds: 0.02, releaseSeconds: 0.2, sampleModes: 0,
          },
          {
            keyRange: [60, 60], velRange: [1, 127], sampleIndex: 1, instrumentId: 4,
            presetZoneId: 2, instrumentZoneId: 9, rootKey: 40, pitchCorrection: -40,
            pan: -500, initialAttenuationDb: 12, attackSeconds: 0.1, releaseSeconds: 0.4, sampleModes: 0,
          },
        ],
      }],
      samples: [
        { name: "Right", start: 0, end: 8, loopStart: 1, loopEnd: 5, sampleRate: 22_050, originalPitch: 61, pitchCorrection: 6, sampleType: 2, sampleLink: 1 },
        { name: "Left", start: 8, end: 20, loopStart: 13, loopEnd: 18, sampleRate: 22_050, originalPitch: 40, pitchCorrection: -40, sampleType: 4, sampleLink: 0 },
      ],
      sampleSource: { blob: new Blob([new Uint8Array(40)]), sampleDataOffset: 0, sampleCount: 20 },
    };
    const synth = new SoundFontSynth({ audioContext: audioContext as unknown as AudioContext });
    synth.loadSoundFont(soundFont);

    expect(() => synth.noteOn(60, 100, "before-prepare")).toThrow(/not prepared/);
    expect(getSoundFontSampleProviderStats()).toMatchObject({ reads: 0, decodes: 0 });
    const cancelledWindow = new AbortController();
    const firstPreparation = synth.prepareNotes([{ pitch: 60, velocity: 100 }], cancelledWindow.signal);
    const replacementPreparation = synth.prepareNotes([{ pitch: 60, velocity: 100 }]);
    cancelledWindow.abort();
    await expect(firstPreparation).rejects.toMatchObject({ name: "AbortError" });
    await replacementPreparation;
    expect(synth.areNotesPrepared([{ pitch: 60, velocity: 100 }])).toBe(true);
    expect(getSoundFontSampleProviderStats()).toMatchObject({ reads: 2, decodes: 2, pinnedBytes: 80 });

    synth.noteOn(60, 100, "stereo-note");
    expect(createdSources).toHaveLength(2);
    expect(createdSources[0]!.start).toHaveBeenCalledWith(10);
    expect(createdSources[1]!.start).toHaveBeenCalledWith(10);
    expect(createdSources[0]!.buffer?.duration).toBeCloseTo(12 / 22_050, 8);
    expect(createdSources[1]!.buffer?.duration).toBeCloseTo(8 / 22_050, 8);
    const expectedRate = 2 ** (((60 - 61) * 100 + 6) / 1200);
    expect(createdSources[0]!.playbackRate.setValueAtTime).toHaveBeenCalledWith(expectedRate, 10);
    expect(createdSources[1]!.playbackRate.setValueAtTime).toHaveBeenCalledWith(expectedRate, 10);
    expect(pans[0]!.pan.setValueAtTime).toHaveBeenCalledWith(-1, 10);
    expect(pans[1]!.pan.setValueAtTime).toHaveBeenCalledWith(1, 10);
    expect(gains[1]!.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(expect.any(Number), 10.1);
    expect(gains[2]!.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(expect.any(Number), 10.02);
    expect(gains[1]!.gain.exponentialRampToValueAtTime.mock.calls[0]![0]).toBeLessThan(
      gains[2]!.gain.exponentialRampToValueAtTime.mock.calls[0]![0],
    );

    synth.noteOff("stereo-note", 60, 10.5);
    expect(gains[1]!.gain.exponentialRampToValueAtTime).toHaveBeenLastCalledWith(expect.any(Number), 10.9);
    expect(gains[2]!.gain.exponentialRampToValueAtTime).toHaveBeenLastCalledWith(expect.any(Number), 10.7);
    expect(createdSources[0]!.stop.mock.calls[0]![0]).toBeCloseTo(10.95);
    expect(createdSources[1]!.stop.mock.calls[0]![0]).toBeCloseTo(10.75);
    createdSources[1]!.onended?.();
    expect(synth.getActiveVoiceCount()).toBe(1);
    createdSources[0]!.onended?.();
    expect(synth.getActiveVoiceCount()).toBe(0);
    synth.dispose();
    expect(getSoundFontSampleProviderStats().pinnedBytes).toBe(0);
    resetSharedSoundFontSampleProviderForTests();
  });

  it("rejects unmatched stereo zones instead of duplicating one channel", () => {
    const soundFont: Sf2SoundFont = {
      header: { name: "Unmatched stereo", versionMajor: 2, versionMinor: 4 },
      presets: [{
        name: "Piano", presetNumber: 0, bankNumber: 0, zones: [
          { keyRange: [60, 60], velRange: [1, 127], sampleIndex: 0, instrumentId: 1, presetZoneId: 2, instrumentZoneId: 3 },
        ],
      }],
      samples: [
        { name: "Right", start: 0, end: 8, loopStart: 0, loopEnd: 8, sampleRate: 22_050, originalPitch: 60, pitchCorrection: 0, sampleType: 2, sampleLink: 1 },
        { name: "Left", start: 8, end: 16, loopStart: 8, loopEnd: 16, sampleRate: 22_050, originalPitch: 60, pitchCorrection: 0, sampleType: 4, sampleLink: 0 },
      ],
      rawSampleData: new Int16Array(16),
    };
    const audioContext = {
      currentTime: 0,
      destination: {},
      createGain: vi.fn().mockReturnValue({
        gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(), disconnect: vi.fn(),
      }),
    };
    const synth = new SoundFontSynth({ audioContext: audioContext as unknown as AudioContext });
    synth.loadSoundFont(soundFont);

    expect(() => synth.noteOn(60, 100, "missing-left-zone")).toThrow(/has 0 left zones and 1 right zones/);
    synth.dispose();
  });

  it("releases mode-1 left and mode-3 right channels together after sustain, then waits for both tails", () => {
    const { sources, gains, synth } = createStereoLoopSynth(1, 3);
    synth.noteOn(60, 100, "left-mode1-right-mode3", 0);
    expect(sources).toHaveLength(2);
    expect(sources[0]!.loop).toBe(true); // left channel
    expect(sources[1]!.loop).toBe(true); // right channel
    expect(sources[0]!.buffer?.duration).toBeCloseTo(1.4); // left has an independent 140-frame range
    expect(sources[0]!.loopStart).toBeCloseTo(0.34);
    expect(sources[0]!.loopEnd).toBeCloseTo(1.04);
    expect(sources[1]!.buffer?.duration).toBeCloseTo(1); // right has a 100-frame range
    expect(sources[1]!.loopStart).toBeCloseTo(0.2);
    expect(sources[1]!.loopEnd).toBeCloseTo(0.6);

    synth.pedalChange(64, 127, 0.1);
    synth.noteOff("left-mode1-right-mode3", 60, 0.2);
    expect(sources[0]!.stop).not.toHaveBeenCalled();
    expect(sources[1]!.stop).not.toHaveBeenCalled();

    synth.pedalChange(64, 0, 0.3);
    expect(sources).toHaveLength(3); // one-shot tail for the mode-3 right channel
    expect(sources[0]!.stop).toHaveBeenCalledWith(0.75); // left's 400 ms release
    expect(sources[1]!.stop).toHaveBeenCalledWith(0.3); // right loop hands off at release
    expect(sources[2]!.start).toHaveBeenCalledWith(0.3, expect.any(Number));
    expect(sources[2]!.stop).toHaveBeenCalledWith(0.55); // right's 200 ms release
    expect(gains[1]!.gain.exponentialRampToValueAtTime).toHaveBeenLastCalledWith(0.0001, 0.7);
    expect(gains[2]!.gain.exponentialRampToValueAtTime).toHaveBeenLastCalledWith(0.0001, 0.5);

    sources[1]!.onended?.();
    sources[2]!.onended?.();
    expect(synth.getActiveVoiceCount()).toBe(1); // left's release is still sounding
    sources[0]!.onended?.();
    expect(synth.getActiveVoiceCount()).toBe(0);
    synth.dispose();
  });

  it("cancels a mode-3 right tail while sustain holds a mode-0 left channel", () => {
    const { sources, synth } = createStereoLoopSynth(0, 3);
    synth.restoreState({
      voices: [{
        noteId: "left-mode0-right-mode3",
        pitch: 60,
        velocity: 100,
        keyState: "down",
        heldBySostenuto: false,
        sustainedBySustain: false,
        softPedalAtPress: false,
      }],
      pedals: { sustain: true, sostenuto: false, soft: false },
    });
    synth.noteOff("left-mode0-right-mode3", 60, 0.2);
    synth.pedalChange(64, 0, 0.8);
    expect(sources).toHaveLength(3);
    expect(sources[0]!.loop).toBe(false);
    expect(sources[1]!.loop).toBe(true);
    expect(sources[2]!.start).toHaveBeenCalledWith(0.8, expect.any(Number));

    synth.cancelScheduledFutureEvents(0.5);
    expect(sources[2]!.onended).toBeNull();
    expect(sources[2]!.disconnect).toHaveBeenCalledOnce();
    expect(sources[0]!.loop).toBe(false);
    expect(sources[1]!.loop).toBe(true);
    expect(sources[0]!.stop).toHaveBeenLastCalledWith(0.5 + 24 * 60 * 60);
    expect(sources[1]!.stop).toHaveBeenLastCalledWith(0.5 + 24 * 60 * 60);
    expect(synth.getActiveVoiceCount()).toBe(1);

    synth.pedalChange(64, 0, 0.9);
    expect(sources).toHaveLength(4);
    expect(sources[1]!.stop).toHaveBeenLastCalledWith(0.9);
    expect(sources[3]!.start).toHaveBeenCalledWith(0.9, expect.any(Number));
    sources[0]!.onended?.();
    sources[1]!.onended?.();
    expect(synth.getActiveVoiceCount()).toBe(1);
    sources[3]!.onended?.();
    expect(synth.getActiveVoiceCount()).toBe(0);
    synth.dispose();
  });

  it("cleans up a new stereo voice only after both channel sources end", () => {
    const { sources, synth } = createStereoLoopSynth(0, 0);
    synth.noteOn(60, 100, "new-stereo-voice", 0);
    expect(synth.getActiveVoiceCount()).toBe(1);
    expect(sources).toHaveLength(2);

    expect(() => sources[0]!.onended?.()).not.toThrow();
    expect(synth.getActiveVoiceCount()).toBe(1);
    expect(() => sources[1]!.onended?.()).not.toThrow();
    expect(synth.getActiveVoiceCount()).toBe(0);
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce();
    expect(sources[1]!.disconnect).toHaveBeenCalledOnce();

    synth.noteOn(60, 100, "next-stereo-voice", 0);
    expect(synth.getActiveVoiceCount()).toBe(1);
    sources[2]!.onended?.();
    sources[3]!.onended?.();
    expect(synth.getActiveVoiceCount()).toBe(0);
    synth.dispose();
  });

  it("falls back to nearest ready SoundFont velocity/pitch zone via tryNoteOnNearestReady when pressed at an unprepared velocity", async () => {
    resetSharedSoundFontSampleProviderForTests();
    const { audioContext, sources } = createStereoLoopSynth(0, 0);
    const multiVelSf: Sf2SoundFont = {
      header: { name: "MultiVelPiano", versionMajor: 2, versionMinor: 4 },
      presets: [{
        name: "Piano",
        presetNumber: 0,
        bankNumber: 0,
        zones: [
          { keyRange: [58, 62], velRange: [1, 80], sampleIndex: 0, rootKey: 60 },
          { keyRange: [58, 62], velRange: [81, 127], sampleIndex: 1, rootKey: 60 },
        ],
      }],
      samples: [
        { name: "SoftC4", start: 0, end: 10, loopStart: 0, loopEnd: 10, sampleRate: 22_050, originalPitch: 60, pitchCorrection: 0, sampleType: 1 },
        { name: "LoudC4", start: 10, end: 20, loopStart: 10, loopEnd: 20, sampleRate: 22_050, originalPitch: 60, pitchCorrection: 0, sampleType: 1 },
      ],
      sampleSource: { blob: new Blob([new Uint8Array(40)]), sampleDataOffset: 0, sampleCount: 20 },
    };

    const synth = new SoundFontSynth({ audioContext: audioContext as unknown as AudioContext });
    synth.loadSoundFont(multiVelSf);

    // Prepare only soft velocity (vel=60 -> sampleIndex 0)
    await synth.prepareNotes([{ pitch: 60, velocity: 60 }]);

    // Direct noteOn at loud velocity (115 -> sampleIndex 1) throws because sampleIndex 1 is not prepared
    expect(() => synth.noteOn(60, 115, "loud-strike")).toThrow(/not prepared/);

    // tryNoteOnNearestReady succeeds using the ready SoftC4 sample at loud amplitude!
    expect(synth.tryNoteOnNearestReady(60, 115, "loud-strike")).toBe(true);
    expect(synth.getActiveVoiceCount()).toBe(1);
    expect(sources).toHaveLength(1);

    // Also works for neighboring key (e.g. D4 = 62 or E4 = 64) pitch-shifted from ready C4
    expect(synth.tryNoteOnNearestReady(64, 115, "neighbor-strike")).toBe(true);
    expect(synth.getActiveVoiceCount()).toBe(2);

    synth.dispose();
    resetSharedSoundFontSampleProviderForTests();
  });

  it("clamps velocity below lowest zone range (e.g. velocity 1 with zone [3, 80]) and plays with audible acoustic floor", async () => {
    resetSharedSoundFontSampleProviderForTests();
    const { audioContext, gains } = createStereoLoopSynth(0, 0);
    const sf: Sf2SoundFont = {
      header: { name: "OffsetVelPiano", versionMajor: 2, versionMinor: 4 },
      presets: [{
        name: "Piano",
        presetNumber: 0,
        bankNumber: 0,
        zones: [
          // Velocity range starts at 3, exactly like MuseScore General SF3
          { keyRange: [24, 24], velRange: [3, 80], sampleIndex: 0, rootKey: 24 },
        ],
      }],
      samples: [
        { name: "BassC1", start: 0, end: 10, loopStart: 0, loopEnd: 10, sampleRate: 22_050, originalPitch: 24, pitchCorrection: 0, sampleType: 1 },
      ],
      sampleSource: { blob: new Blob([new Uint8Array(40)]), sampleDataOffset: 0, sampleCount: 20 },
    };

    const synth = new SoundFontSynth({ audioContext: audioContext as unknown as AudioContext });
    synth.loadSoundFont(sf);

    // Preparing note at velocity 1 resolves the [3, 80] zone sample
    await synth.prepareNotes([{ pitch: 24, velocity: 1 }]);
    expect(synth.areNotesPrepared([{ pitch: 24, velocity: 1 }])).toBe(true);

    // Direct noteOn at velocity 1 plays without throwing or returning early
    synth.noteOn(24, 1, "pianissimo-bass");
    expect(synth.getActiveVoiceCount()).toBe(1);

    // The gain node ramp should receive peakGain with the acoustic floor (> 0.005)
    const voiceGain = gains.at(-1);
    expect(voiceGain).toBeDefined();
    const peakCall = voiceGain?.gain.exponentialRampToValueAtTime.mock.calls[0];
    expect(peakCall).toBeDefined();
    const peakGain = peakCall?.[0] as number;
    expect(peakGain).toBeGreaterThanOrEqual(0.09);

    // Pitch with no zones throws a descriptive error for fallback handling
    expect(() => synth.noteOn(100, 80, "unmapped-pitch")).toThrow(/no sample layers for pitch 100/);

    synth.dispose();
    resetSharedSoundFontSampleProviderForTests();
  });
});

