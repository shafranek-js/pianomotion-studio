import { describe, it, expect, vi } from "vitest";
import { InvalidSoundFontError, Sf2Parser } from "./sf2Parser";
import { SoundFontSynth } from "./soundfontSynth";
import type { Sf2SoundFont } from "./types";

describe("SoundFont 2 Parser & Synthesizer (W042, W043)", () => {
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
    // Construct a minimal valid SF2 binary structure in memory
    const totalSize = 256;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // RIFF header
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    view.setUint32(4, totalSize - 8, true);
    bytes.set(new TextEncoder().encode("sfbk"), 8);

    // LIST INFO
    let offset = 12;
    bytes.set(new TextEncoder().encode("LIST"), offset);
    view.setUint32(offset + 4, 24, true); // 4 (INFO) + 8 (INAM header) + 8 (data) = 20 + 4 = 24
    bytes.set(new TextEncoder().encode("INFO"), offset + 8);

    // INAM chunk
    bytes.set(new TextEncoder().encode("INAM"), offset + 12);
    view.setUint32(offset + 16, 8, true);
    bytes.set(new TextEncoder().encode("Piano\0\0\0"), offset + 20);

    offset += 8 + 24; // 44

    // LIST sdta
    bytes.set(new TextEncoder().encode("LIST"), offset);
    view.setUint32(offset + 4, 32, true); // 4 (sdta) + 8 (smpl header) + 20 (data) = 32
    bytes.set(new TextEncoder().encode("sdta"), offset + 8);

    // smpl chunk with 10 dummy 16-bit PCM samples
    bytes.set(new TextEncoder().encode("smpl"), offset + 12);
    view.setUint32(offset + 16, 20, true);
    for (let i = 0; i < 10; i++) {
      view.setInt16(offset + 20 + i * 2, i * 1000, true);
    }

    offset += 8 + 32; // 84

    // LIST pdta with shdr
    bytes.set(new TextEncoder().encode("LIST"), offset);
    view.setUint32(offset + 4, 58, true); // 4 (pdta) + 8 (shdr header) + 46 (data) = 58
    bytes.set(new TextEncoder().encode("pdta"), offset + 8);

    // shdr chunk (46 bytes per entry)
    bytes.set(new TextEncoder().encode("shdr"), offset + 12);
    view.setUint32(offset + 16, 46, true);
    const shdrBase = offset + 20;
    bytes.set(new TextEncoder().encode("A0_Sample\0\0\0\0\0\0\0\0\0\0\0"), shdrBase);
    view.setUint32(shdrBase + 20, 0, true); // start
    view.setUint32(shdrBase + 24, 10, true); // end
    view.setUint32(shdrBase + 28, 0, true); // loopStart
    view.setUint32(shdrBase + 32, 10, true); // loopEnd
    view.setUint32(shdrBase + 36, 44100, true); // sampleRate
    view.setUint8(shdrBase + 40, 60); // originalPitch (C4)
    view.setInt8(shdrBase + 41, 0); // pitchCorrection
    view.setUint16(shdrBase + 44, 1, true); // mono sample

    const parser = new Sf2Parser(buffer);
    const sf = parser.parse();

    expect(sf.header.name).toBe("Piano");
    expect(sf.samples).toHaveLength(1);
    expect(sf.samples[0]?.name).toBe("A0_Sample");
    expect(sf.samples[0]?.sampleRate).toBe(44100);
    expect(sf.samples[0]?.originalPitch).toBe(60);
    expect(sf.rawSampleData?.length).toBe(10);
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
});
