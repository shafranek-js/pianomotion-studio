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

    synth.dispose();
  });
});
