import { describe, expect, it, vi } from "vitest";
import { SoundFontSampleProvider } from "./soundfontSampleProvider.ts";
import type { Sf2SoundFont } from "./types.ts";

function context(sampleRate = 44_100, decodeAudioData?: (bytes: ArrayBuffer) => Promise<AudioBuffer>) {
  return {
    sampleRate,
    createBuffer: (_channels: number, frames: number, sampleRate: number) => {
      const channel = new Float32Array(frames);
      return {
        duration: frames / sampleRate,
        sampleRate,
        numberOfChannels: 1,
        length: frames,
        getChannelData: () => channel,
      } as unknown as AudioBuffer;
    },
    ...(decodeAudioData ? { decodeAudioData } : {}),
  } as unknown as AudioContext;
}

function soundFont(
  samples: Array<{ start: number; end: number }>,
  pcm: Int16Array,
  prefixBytes = 0,
): Sf2SoundFont {
  const bytes = new Uint8Array(prefixBytes + pcm.byteLength + 3);
  new DataView(bytes.buffer).setInt16(prefixBytes, 1111, true);
  for (let index = 0; index < pcm.length; index++) {
    new DataView(bytes.buffer).setInt16(prefixBytes + index * 2, pcm[index]!, true);
  }
  const blob = new Blob([bytes]);
  return {
    header: { name: "Provider test", versionMajor: 2, versionMinor: 4 },
    presets: [],
    samples: samples.map((sample, sampleIndex) => ({
      name: `sample-${sampleIndex}`,
      start: sample.start,
      end: sample.end,
      loopStart: sample.start,
      loopEnd: sample.end,
      sampleRate: 22_050,
      originalPitch: 60,
      pitchCorrection: 0,
      sampleType: 1,
    })),
    sampleSource: { blob, sampleDataOffset: prefixBytes, sampleCount: pcm.length },
  };
}

function compressedSoundFont(frames: number, bytes = new Uint8Array([79, 103, 103, 83, 1, 2, 3, 4])): Sf2SoundFont {
  const blob = new Blob([bytes]);
  return {
    header: { name: "SF3 provider test", versionMajor: 3, versionMinor: 1 },
    presets: [],
    samples: [{
      name: "compressed",
      start: 0,
      end: frames,
      loopStart: Math.min(1, frames),
      loopEnd: frames,
      sampleRate: 44_100,
      originalPitch: 60,
      pitchCorrection: 0,
      sampleType: 0x11,
      compressed: true,
      compressedByteStart: 0,
      compressedByteEnd: bytes.byteLength,
      decodedFrameCount: frames,
    }],
    sampleSource: { blob, sampleDataOffset: 0, sampleCount: 0, sampleDataByteLength: bytes.byteLength },
  };
}

describe("shared lazy SoundFont sample provider", () => {
  it("reads only the requested PCM range and pins decoded audio until release", async () => {
    const provider = new SoundFontSampleProvider(1024, 1024);
    const sf = soundFont([{ start: 2, end: 4 }], new Int16Array([10, 20, 8192, -16384, 30]), 6);

    const leases = await provider.prepareSamples(sf, [0], context());
    const lease = leases.get(0)!;
    expect([...lease.buffer.getChannelData(0)]).toEqual([0.25, -0.5]);
    expect(provider.getStats()).toMatchObject({ reads: 1, decodes: 1, decodedBytes: 8, preparingBytes: 0, pinnedBytes: 8 });

    lease.release();
    expect(provider.getStats()).toMatchObject({ inactiveBytes: 8, pinnedBytes: 0 });
  });

  it("decodes only the requested SF3 stream at its source rate and pins the frame-bounded buffer", async () => {
    const provider = new SoundFontSampleProvider(1024, 1024);
    const sf = compressedSoundFont(5);
    const output = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => {
      expect(bytes.byteLength).toBe(8);
      return {
        duration: 5 / 44_100,
        sampleRate: 44_100,
        numberOfChannels: 1,
        length: 5,
        getChannelData: () => output,
      } as unknown as AudioBuffer;
    });

    const leases = await provider.prepareSamples(sf, [0], context(44_100, decodeAudioData));
    expect([...leases.get(0)!.buffer.getChannelData(0)]).toEqual([...output]);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(provider.getStats()).toMatchObject({ reads: 1, decodes: 1, decodedBytes: 20, preparingBytes: 0, pinnedBytes: 20 });
    leases.get(0)!.release();
  });

  it("accounts for compressed input plus decoded frames before any SF3 read", async () => {
    const provider = new SoundFontSampleProvider(23, 23);
    await expect(provider.prepareSamples(compressedSoundFont(5), [0], context(44_100, vi.fn()))).rejects.toThrow(/shared cache budget/);
    expect(provider.getStats()).toMatchObject({ reads: 0, decodes: 0, preparingBytes: 0 });
  });

  it("rejects a browser decode whose output disagrees with the validated Ogg granule", async () => {
    const provider = new SoundFontSampleProvider(1024, 1024);
    const decodeAudioData = vi.fn(async () => ({
      duration: 4 / 44_100,
      sampleRate: 44_100,
      numberOfChannels: 1,
      length: 4,
      getChannelData: () => new Float32Array(4),
    } as unknown as AudioBuffer));
    await expect(provider.prepareSamples(compressedSoundFont(5), [0], context(44_100, decodeAudioData))).rejects.toThrow(/expected 1 channel, 5 frames/);
    expect(provider.getStats()).toMatchObject({ reads: 1, decodes: 0, preparingBytes: 0, cachedSamples: 0 });
  });

  it("deduplicates concurrent range reads and counts each caller's pin", async () => {
    const provider = new SoundFontSampleProvider(1024, 1024);
    const sf = soundFont([{ start: 0, end: 4 }], new Int16Array([0, 1, 2, 3]));
    const first = provider.prepareSamples(sf, [0], context());
    const second = provider.prepareSamples(sf, [0], context());
    const [firstLeases, secondLeases] = await Promise.all([first, second]);

    expect(provider.getStats()).toMatchObject({ reads: 1, decodes: 1, pinnedBytes: 16, cacheHits: 0 });
    firstLeases.get(0)!.release();
    expect(provider.getStats().pinnedBytes).toBe(16);
    secondLeases.get(0)!.release();
    expect(provider.getStats().pinnedBytes).toBe(0);
  });

  it("rejects over-budget work before reading and leaves prepared pins intact", async () => {
    const small = new SoundFontSampleProvider(10, 10);
    const tooLarge = soundFont([{ start: 0, end: 2 }], new Int16Array([0, 1]));
    await expect(small.prepareSamples(tooLarge, [0], context())).rejects.toThrow(/shared cache budget/);
    expect(small.getStats()).toMatchObject({ reads: 0, decodes: 0, preparingBytes: 0 });

    const provider = new SoundFontSampleProvider(12, 12);
    const sf = soundFont([{ start: 0, end: 1 }, { start: 1, end: 3 }], new Int16Array([1, 2, 3]));
    const first = await provider.prepareSamples(sf, [0], context());
    await expect(provider.prepareSamples(sf, [1], context())).rejects.toThrow(/shared cache budget/);
    expect(provider.getStats()).toMatchObject({ reads: 1, pinnedBytes: 4, cachedSamples: 1 });
    first.get(0)!.release();
  });

  it("reclaims enough unpinned LRU bytes before reserving another range", async () => {
    const provider = new SoundFontSampleProvider(256, 256);
    const sf = soundFont(
      [{ start: 0, end: 40 }, { start: 40, end: 48 }, { start: 48, end: 59 }],
      new Int16Array(59),
    );
    const pinned = await provider.prepareSamples(sf, [0], context()); // 160 decoded bytes
    const inactive = await provider.prepareSamples(sf, [1], context()); // 32 decoded bytes
    inactive.get(1)!.release();

    const next = await provider.prepareSamples(sf, [2], context()); // 66 temporary bytes
    expect(provider.getStats()).toMatchObject({ reads: 3, preparingBytes: 0, pinnedBytes: 204, decodedBytes: 204 });
    expect(provider.getStats().inactiveBytes).toBe(0);
    pinned.get(0)!.release();
    next.get(2)!.release();
  });

  it("cancels a pending range read and releases its reservation", async () => {
    const provider = new SoundFontSampleProvider(4096, 4096);
    const sf = soundFont([{ start: 0, end: 256 }], new Int16Array(256));
    const controller = new AbortController();
    const preparing = provider.prepareSamples(sf, [0], context(), controller.signal);
    controller.abort();

    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.getStats()).toMatchObject({ preparingBytes: 0, preparingSamples: 0, cachedSamples: 0 });
  });
});
