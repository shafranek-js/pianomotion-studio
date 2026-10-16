import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidSoundFontError, parseSf2, parseSf2Async, parseSf2BlobMetadata } from "./sf2Parser.ts";
import { MAX_SF2_METADATA_BYTES } from "./sf2BlobParser.ts";
import { createSyntheticMonoSf2 } from "./testing/syntheticMonoSf2.ts";

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function chunk(tag: string, data: Uint8Array): Uint8Array {
  const paddedSize = data.length + (data.length % 2);
  const result = new Uint8Array(8 + paddedSize);
  result.set(encoder.encode(tag), 0);
  new DataView(result.buffer).setUint32(4, data.length, true);
  result.set(data, 8);
  return result;
}

function list(type: string, chunks: Uint8Array[]): Uint8Array {
  return chunk("LIST", concat([encoder.encode(type), ...chunks]));
}

function makeSf2(options: {
  versionMajor?: number;
  versionMinor?: number;
  sampleData?: Uint8Array;
  sampleType?: number;
  sampleLink?: number;
  sampleRate?: number;
  sampleModes?: number;
} = {}): ArrayBuffer {
  const version = new Uint8Array(4);
  const versionView = new DataView(version.buffer);
  versionView.setUint16(0, options.versionMajor ?? 2, true);
  versionView.setUint16(2, options.versionMinor ?? 4, true);

  const sampleHeader = new Uint8Array(46);
  sampleHeader.set(encoder.encode("TestSample"), 0);
  const sampleView = new DataView(sampleHeader.buffer);
  sampleView.setUint32(24, 2, true); // sample end
  sampleView.setUint32(32, 2, true); // loop end
  sampleView.setUint32(36, options.sampleRate ?? 22_050, true);
  sampleView.setUint8(40, 60);
  sampleView.setUint16(42, options.sampleLink ?? 0, true);
  sampleView.setUint16(44, options.sampleType ?? 1, true);

  const pdta = [chunk("shdr", sampleHeader)];
  if (options.sampleModes !== undefined) {
    const phdr = new Uint8Array(76);
    phdr.set(encoder.encode("Preset"), 0);
    new DataView(phdr.buffer).setUint16(24, 0, true);
    phdr.set(encoder.encode("EOP"), 38);
    new DataView(phdr.buffer).setUint16(62, 1, true);

    const pbag = new Uint8Array(8);
    new DataView(pbag.buffer).setUint16(4, 1, true);
    const pgen = new Uint8Array(4);
    new DataView(pgen.buffer).setUint16(0, 41, true); // instrument

    const inst = new Uint8Array(44);
    inst.set(encoder.encode("Instrument"), 0);
    new DataView(inst.buffer).setUint16(42, 1, true);
    const ibag = new Uint8Array(8);
    new DataView(ibag.buffer).setUint16(4, 2, true);
    const igen = new Uint8Array(8);
    const igenView = new DataView(igen.buffer);
    igenView.setUint16(0, 54, true); // sampleModes
    igenView.setUint16(2, options.sampleModes, true);
    igenView.setUint16(4, 53, true); // sampleID
    igenView.setUint16(6, 0, true);

    pdta.unshift(chunk("igen", igen), chunk("ibag", ibag), chunk("inst", inst), chunk("pgen", pgen), chunk("pbag", pbag), chunk("phdr", phdr));
  }

  const riff = chunk("RIFF", concat([
    encoder.encode("sfbk"),
    list("INFO", [chunk("ifil", version)]),
    list("sdta", [chunk("smpl", options.sampleData ?? new Uint8Array([0, 0, 1, 0]))]),
    list("pdta", pdta),
  ]));
  const buffer = new ArrayBuffer(riff.byteLength);
  new Uint8Array(buffer).set(riff);
  return buffer;
}

type Generator = [operator: number, amount: number];

function makeSf2WithGenerators(options: {
  presetZones: Generator[][];
  instrumentZones: Generator[][];
  originalPitch?: number;
  pitchCorrection?: number;
}): ArrayBuffer {
  const version = new Uint8Array(4);
  const versionView = new DataView(version.buffer);
  versionView.setUint16(0, 2, true);
  versionView.setUint16(2, 4, true);

  const makeZoneTables = (zones: Generator[][], entryBytes: number) => {
    const bagBytes = new Uint8Array((zones.length + 1) * 4);
    const generatorBytes = new Uint8Array((zones.reduce((total, zone) => total + zone.length, 0) + 1) * 4);
    const bagView = new DataView(bagBytes.buffer);
    const generatorView = new DataView(generatorBytes.buffer);
    let generatorIndex = 0;
    let bagIndex = 0;
    for (const zone of zones) {
      bagView.setUint16(bagIndex * 4, generatorIndex, true);
      for (const [operator, amount] of zone) {
        generatorView.setUint16(generatorIndex * 4, operator, true);
        generatorView.setUint16(generatorIndex * 4 + 2, amount, true);
        generatorIndex++;
      }
      bagIndex++;
    }
    bagView.setUint16(bagIndex * 4, generatorIndex, true);
    // The last four-byte entry is the mandatory terminal generator record.
    generatorView.setUint16(generatorIndex * 4, 0, true);
    generatorView.setUint16(generatorIndex * 4 + 2, 0, true);
    void entryBytes;
    return { bags: chunk(entryBytes === 38 ? "pbag" : "ibag", bagBytes), generators: chunk(entryBytes === 38 ? "pgen" : "igen", generatorBytes) };
  };

  const presetTables = makeZoneTables(options.presetZones, 38);
  const instrumentTables = makeZoneTables(options.instrumentZones, 22);
  const phdr = new Uint8Array(76);
  phdr.set(encoder.encode("Generator Fixture"), 0);
  new DataView(phdr.buffer).setUint16(24, 0, true);
  phdr.set(encoder.encode("EOP"), 38);
  new DataView(phdr.buffer).setUint16(62, options.presetZones.length, true);
  const inst = new Uint8Array(44);
  inst.set(encoder.encode("Generator Instrument"), 0);
  new DataView(inst.buffer).setUint16(42, 0, true);
  inst.set(encoder.encode("EOI"), 22);
  new DataView(inst.buffer).setUint16(42, options.instrumentZones.length, true);

  const sampleHeaders = new Uint8Array(92);
  sampleHeaders.set(encoder.encode("Fixture Sample"), 0);
  const sampleView = new DataView(sampleHeaders.buffer);
  sampleView.setUint32(24, 2, true);
  sampleView.setUint32(32, 2, true);
  sampleView.setUint32(36, 22_050, true);
  sampleView.setUint8(40, options.originalPitch ?? 60);
  sampleView.setInt8(41, options.pitchCorrection ?? 0);
  sampleView.setUint16(44, 1, true);
  sampleHeaders.set(encoder.encode("EOS"), 46);

  const riff = chunk("RIFF", concat([
    encoder.encode("sfbk"),
    list("INFO", [chunk("ifil", version)]),
    list("sdta", [chunk("smpl", new Uint8Array([0, 0, 1, 0]))]),
    list("pdta", [
      chunk("phdr", phdr), presetTables.bags, chunk("pmod", new Uint8Array(10)), presetTables.generators,
      chunk("inst", inst), instrumentTables.bags, chunk("imod", new Uint8Array(10)), instrumentTables.generators,
      chunk("shdr", sampleHeaders),
    ]),
  ]));
  const buffer = new ArrayBuffer(riff.byteLength);
  new Uint8Array(buffer).set(riff);
  return buffer;
}

function packedRange(min: number, max: number): number {
  return min | (max << 8);
}

function makeStereoSf2(): ArrayBuffer {
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint16(0, 2, true);
  new DataView(version.buffer).setUint16(2, 4, true);
  const headers = new Uint8Array(92);
  const view = new DataView(headers.buffer);
  const samples = [
    { base: 0, name: "Right", start: 0, end: 4, loopStart: 1, loopEnd: 3, type: 2, link: 1 },
    { base: 46, name: "Left", start: 50, end: 55, loopStart: 52, loopEnd: 54, type: 4, link: 0 },
  ];
  for (const sample of samples) {
    headers.set(encoder.encode(sample.name), sample.base);
    view.setUint32(sample.base + 20, sample.start, true);
    view.setUint32(sample.base + 24, sample.end, true);
    view.setUint32(sample.base + 28, sample.loopStart, true);
    view.setUint32(sample.base + 32, sample.loopEnd, true);
    view.setUint32(sample.base + 36, 22_050, true);
    view.setUint8(sample.base + 40, 60);
    view.setUint16(sample.base + 42, sample.link, true);
    view.setUint16(sample.base + 44, sample.type, true);
  }
  const riff = chunk("RIFF", concat([
    encoder.encode("sfbk"),
    list("INFO", [chunk("ifil", version)]),
    list("sdta", [chunk("smpl", new Uint8Array(55 * 2))]),
    list("pdta", [chunk("shdr", headers)]),
  ]));
  const result = new ArrayBuffer(riff.byteLength);
  new Uint8Array(result).set(riff);
  return result;
}

class FakeWorker {
  public static instances: FakeWorker[] = [];
  public static onPostMessage: ((message: { buffer?: ArrayBuffer; blob?: Blob }, transfer: Transferable[]) => void) | undefined;
  public static lastPayload: { buffer?: ArrayBuffer; blob?: Blob } | undefined;
  public static lastTransfer: Transferable[] = [];
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly terminate = vi.fn();
  public postMessage(message: { buffer?: ArrayBuffer; blob?: Blob }, transfer: Transferable[] = []): void {
    FakeWorker.lastPayload = message;
    FakeWorker.lastTransfer = transfer;
    FakeWorker.onPostMessage?.(message, transfer);
  }

  constructor() {
    FakeWorker.instances.push(this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
  FakeWorker.onPostMessage = undefined;
  FakeWorker.lastPayload = undefined;
  FakeWorker.lastTransfer = [];
});

describe("SF2 format boundary and parser worker lifecycle", () => {
  it("rejects SF3 versions and Ogg/Vorbis-compressed sample blocks with actionable errors", () => {
    expect(() => parseSf2(makeSf2({ versionMajor: 3, versionMinor: 0 }))).toThrow(/SF2 versions through 2\.4/);
    expect(() => parseSf2(makeSf2({ sampleData: encoder.encode("OggS") }))).toThrow(/Ogg\/Vorbis-compressed.*SF3/);
  });

  it("parses the complete synthetic mono SF2 used by browser output coverage", () => {
    const sampleBytes = createSyntheticMonoSf2();
    const buffer = new ArrayBuffer(sampleBytes.byteLength);
    new Uint8Array(buffer).set(sampleBytes);
    const parsed = parseSf2(buffer);
    expect(parsed.presets[0]?.name).toBe("Synthetic 440");
    expect(parsed.presets[0]?.zones[0]).toMatchObject({ sampleIndex: 0, sampleModes: 3, keyRange: [0, 127], velRange: [0, 127] });
    expect(parsed.samples[0]).toMatchObject({ sampleRate: 22_050, originalPitch: 69, sampleType: 1 });
    expect(parsed.rawSampleData).toHaveLength(11_025);
  });

  it("rejects ROM, malformed stereo links, and unsupported linked samples", () => {
    expect(() => parseSf2(makeSf2({ sampleType: 0x8001 }))).toThrow(/ROM-backed samples are not supported/);
    expect(() => parseSf2(makeSf2({ sampleType: 2 }))).toThrow(/invalid sampleLink/);
    expect(() => parseSf2(makeSf2({ sampleType: 8 }))).toThrow(/linked sample type 8/);
  });

  it("ignores mono sampleLink and accepts the supported 3000 Hz playback floor", () => {
    const parsed = parseSf2(makeSf2({ sampleLink: 1234, sampleRate: 3000 }));
    expect(parsed.samples[0]).toMatchObject({ sampleLink: 1234, sampleRate: 3000, sampleType: 1 });
    expect(() => parseSf2(makeSf2({ sampleRate: 2999 }))).toThrow(/unsupported sample rate 2999; supported playback rates are 3000 to 384000 Hz/);
  });

it("accepts reciprocal stereo samples with independent lengths and relative loops", () => {
    const bytes = makeStereoSf2();
    const parsed = parseSf2(bytes);
    expect(parsed.samples).toMatchObject([
      { name: "Right", start: 0, end: 4, loopStart: 1, loopEnd: 3, sampleType: 2, sampleLink: 1 },
      { name: "Left", start: 50, end: 55, loopStart: 52, loopEnd: 54, sampleType: 4, sampleLink: 0 },
    ]);
    expect(parsed.samples.map((sample) => ({
      length: sample.end - sample.start,
      loopOffsets: [sample.loopStart - sample.start, sample.loopEnd - sample.start],
    }))).toEqual([
      { length: 4, loopOffsets: [1, 3] },
      { length: 5, loopOffsets: [2, 4] },
    ]);
    expect(parsed.presets[0]?.zones.map((zone) => zone.sampleIndex)).toEqual([0, 1]);

    const malformed = new Uint8Array(bytes.slice(0));
    const rightName = encoder.encode("Right");
    const rightOffset = malformed.findIndex((value, index) => index < malformed.length - rightName.length && rightName.every((byte, i) => malformed[index + i] === byte));
    expect(rightOffset).toBeGreaterThan(-1);
    new DataView(malformed.buffer).setUint32(rightOffset + 32, 5, true);
    expect(() => parseSf2(malformed)).toThrow(/loop bounds/);
  });

  it("still rejects invalid per-channel PCM bounds, mismatched rates, and broken stereo links", () => {
    const bytes = makeStereoSf2();
    const leftName = encoder.encode("Left");
    const leftOffset = new Uint8Array(bytes).findIndex((value, index, all) =>
      index < all.length - leftName.length && leftName.every((byte, i) => all[index + i] === byte));
    const rightName = encoder.encode("Right");
    const rightOffset = new Uint8Array(bytes).findIndex((value, index, all) =>
      index < all.length - rightName.length && rightName.every((byte, i) => all[index + i] === byte));
    expect(leftOffset).toBeGreaterThan(-1);
    expect(rightOffset).toBeGreaterThan(-1);

    const invalidBounds = new Uint8Array(bytes.slice(0));
    new DataView(invalidBounds.buffer).setUint32(rightOffset + 24, 56, true);
    expect(() => parseSf2(invalidBounds)).toThrow(/invalid PCM bounds/);

    const mismatchedRate = new Uint8Array(bytes.slice(0));
    new DataView(mismatchedRate.buffer).setUint32(leftOffset + 36, 44_100, true);
    expect(() => parseSf2(mismatchedRate)).toThrow(/must have matching sample rates/);

    const brokenLink = new Uint8Array(bytes.slice(0));
    new DataView(brokenLink.buffer).setUint16(leftOffset + 42, 1, true);
    expect(() => parseSf2(brokenLink)).toThrow(/link reciprocally to an opposite-channel sample/);
  });

  it("parses Blob metadata without allocating PCM and returns the original file-backed source", async () => {
    vi.stubGlobal("Worker", undefined);
    const bytes = makeStereoSf2();
    const blob = new Blob([bytes]);
    const parsed = await parseSf2Async(blob);
    expect(parsed.rawSampleData).toBeUndefined();
    expect(parsed.sampleSource).toMatchObject({ blob, sampleCount: 55 });
    expect(parsed.samples.map((sample) => ({ start: sample.start, end: sample.end, loopStart: sample.loopStart, loopEnd: sample.loopEnd }))).toEqual([
      { start: 0, end: 4, loopStart: 1, loopEnd: 3 },
      { start: 50, end: 55, loopStart: 52, loopEnd: 54 },
    ]);
    const offset = parsed.sampleSource?.sampleDataOffset ?? -1;
    expect(await blob.slice(offset, offset + 8).arrayBuffer()).toEqual(await new Blob([new Uint8Array(8)]).arrayBuffer());
  });

  it("rejects oversized INFO/pdta metadata before reading or allocating the declared table", async () => {
    const oversizedData = MAX_SF2_METADATA_BYTES + 1;
    const listSize = 4 + 8 + oversizedData + (oversizedData & 1);
    const fileSize = 12 + 8 + listSize;
    const header = new Uint8Array(32);
    header.set(encoder.encode("RIFF"), 0);
    new DataView(header.buffer).setUint32(4, fileSize - 8, true);
    header.set(encoder.encode("sfbkLIST"), 8);
    new DataView(header.buffer).setUint32(16, listSize, true);
    header.set(encoder.encode("INFOXTRA"), 20);
    new DataView(header.buffer).setUint32(28, oversizedData, true);
    const backing = new Blob([header.buffer]);
    const requestedRanges: Array<[number, number]> = [];
    const oversizedBlob = {
      size: fileSize,
      slice: (start: number, end: number) => {
        requestedRanges.push([start, end]);
        return backing.slice(start, Math.min(end, backing.size));
      },
    } as unknown as Blob;

    await expect(parseSf2BlobMetadata(oversizedBlob)).rejects.toThrow(/metadata exceeds the 16 MiB metadata parser limit/);
    expect(requestedRanges.every(([start, end]) => end - start <= 12)).toBe(true);
  });

  it("rejects reserved sample loop modes in preset zones", () => {
    expect(() => parseSf2(makeSf2({ sampleModes: 2 }))).toThrow(/sampleModes 2.*supported values are 0, 1, and 3/);
  });

  it("resolves instrument and preset globals before converting additive SF2 amounts", () => {
    const parsed = parseSf2(makeSf2WithGenerators({
      presetZones: [
        [
          [43, packedRange(50, 90)], [44, packedRange(10, 120)], [17, 100], [34, 0], [35, 0],
          [36, 0], [37, 30], [38, 0], [48, 10], [51, 2], [52, 5], [54, 3], [58, 99],
        ],
        [
          [43, packedRange(55, 70)], [44, packedRange(30, 110)], [17, -30], [34, 1200], [35, 0],
          [36, -1200], [37, 60], [38, 1200], [48, 40], [51, 1], [52, -10], [54, 0], [58, 45], [41, 0],
        ],
      ],
      instrumentZones: [
        [
          [43, packedRange(65, 75)], [44, packedRange(45, 55)], [17, -100], [34, -7200], [35, -6000],
          [36, -6000], [37, 60], [38, -6000], [48, 30], [51, 2], [52, 8], [54, 1], [58, 99],
        ],
        [
          [43, packedRange(60, 100)], [44, packedRange(40, 80)], [17, 200], [34, -6000], [35, -8400],
          [36, -4800], [37, 120], [38, -4800], [48, 20], [51, 0], [52, -20], [58, 61], [53, 0],
        ],
        [
          [53, 0], [54, 3],
        ],
        [
          [43, packedRange(10, 20)], [44, packedRange(10, 20)], [53, 0],
        ],
      ],
      originalPitch: 60,
      pitchCorrection: -3,
    }));

    const overridden = parsed.presets[0]?.zones[0];
    expect(parsed.presets[0]?.zones).toHaveLength(2);
    expect(overridden).toMatchObject({
      keyRange: [60, 70],
      velRange: [40, 80],
      rootKey: 61,
      pitchCorrection: 67,
      pan: 170,
      initialAttenuationDb: 6,
      attackSeconds: Math.pow(2, -4800 / 1200),
      holdSeconds: Math.pow(2, -8400 / 1200),
      decaySeconds: Math.pow(2, -6000 / 1200),
      sustainPercent: 100 * Math.pow(10, -180 / 200),
      releaseSeconds: Math.pow(2, -3600 / 1200),
    });
    // Global ranges constrain only zones that do not override them; preset ranges intersect instrument ranges.
    // Global sampleModes and preset sampleModes/rootKey are ignored, while instrument global rootKey is inherited.
    expect(overridden?.sampleModes).toBeUndefined();
    expect(parsed.presets[0]?.zones[1]).toMatchObject({ keyRange: [65, 70], velRange: [45, 55], rootKey: 99, sampleModes: 3 });
  });

  it("keeps full-range and sample-header defaults when generator values are absent", () => {
    const parsed = parseSf2(makeSf2WithGenerators({
      presetZones: [[[41, 0]]],
      instrumentZones: [[[53, 0]]],
      originalPitch: 64,
      pitchCorrection: -2,
    }));
    const zone = parsed.presets[0]?.zones[0];
    expect(zone).toMatchObject({ keyRange: [0, 127], velRange: [0, 127], rootKey: 64, pitchCorrection: -2 });
    expect(zone?.sampleModes).toBeUndefined();
    expect(zone?.pan).toBeUndefined();
    expect(zone?.initialAttenuationDb).toBeUndefined();
    expect(zone?.attackSeconds).toBeUndefined();
    expect(zone?.holdSeconds).toBeUndefined();
    expect(zone?.decaySeconds).toBeUndefined();
    expect(zone?.sustainPercent).toBeUndefined();
    expect(zone?.releaseSeconds).toBeUndefined();
  });

  it("returns a rejected promise for fallback parser failures", async () => {
    vi.stubGlobal("Worker", undefined);
    const parsing = parseSf2Async(makeSf2({ versionMajor: 3, versionMinor: 0 }));
    await expect(parsing).rejects.toBeInstanceOf(InvalidSoundFontError);
  });

  it("normalizes malformed chunk reads and preserves Uint8Array views while preparing a transferable copy", async () => {
    expect(() => parseSf2(new ArrayBuffer(16))).toThrow(InvalidSoundFontError);
    vi.stubGlobal("Worker", FakeWorker);
    const bytes = new Uint8Array(makeSf2({ versionMajor: 3, versionMinor: 0 }));
    const view = bytes.subarray(0, bytes.byteLength);
    const before = [...view];
    const parsing = parseSf2Async(view);
    const worker = FakeWorker.instances[0]!;
    expect(FakeWorker.lastPayload?.buffer).toBeInstanceOf(ArrayBuffer);
    expect(FakeWorker.lastTransfer).toEqual([FakeWorker.lastPayload?.buffer]);
    expect([...view]).toEqual(before);
    worker.onmessage?.({ data: { error: "unsupported bank" } } as MessageEvent);
    await expect(parsing).rejects.toBeInstanceOf(InvalidSoundFontError);
  });

  it("terminates its worker and normalizes a parser error response without duplicating the prefix", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const parsing = parseSf2Async(new ArrayBuffer(16));
    const worker = FakeWorker.instances[0]!;
    worker.onmessage?.({ data: { error: "Invalid SoundFont: unsupported data" } } as MessageEvent);

    await expect(parsing).rejects.toMatchObject({
      name: "InvalidSoundFontError",
      message: "Invalid SoundFont: unsupported data",
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("cleans up the worker when postMessage throws", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    FakeWorker.onPostMessage = () => { throw new Error("transfer failed"); };
    const parsing = parseSf2Async(new ArrayBuffer(16));
    const worker = FakeWorker.instances[0]!;

    await expect(parsing).rejects.toMatchObject({ name: "InvalidSoundFontError", message: /transfer failed/ });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects worker message deserialization failures and terminates the worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const parsing = parseSf2Async(new ArrayBuffer(16));
    const worker = FakeWorker.instances[0]!;
    worker.onmessageerror?.({} as MessageEvent);

    await expect(parsing).rejects.toMatchObject({
      name: "InvalidSoundFontError",
      message: /could not be decoded/,
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed worker sample buffers and still terminates", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const parsing = parseSf2Async(new ArrayBuffer(16));
    const worker = FakeWorker.instances[0]!;
    worker.onmessage?.({ data: { soundFont: { header: {}, presets: [], samples: [] } } } as MessageEvent);
    await expect(parsing).rejects.toMatchObject({ name: "InvalidSoundFontError", message: /invalid file-backed sample data/ });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("passes Blob inputs to the worker without transferring or cloning a PCM buffer", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const blob = new Blob([makeStereoSf2()]);
    const parsing = parseSf2Async(blob);
    const worker = FakeWorker.instances[0]!;
    expect(FakeWorker.lastPayload).toEqual({ blob });
    expect(FakeWorker.lastTransfer).toEqual([]);
    worker.onmessage?.({ data: {
      soundFont: {
        header: { name: "Stereo", versionMajor: 2, versionMinor: 4 },
        presets: [],
        samples: [],
        sampleSource: { blob, sampleDataOffset: 20, sampleCount: 4 },
      },
    } } as MessageEvent);
    await expect(parsing).resolves.toMatchObject({ sampleSource: { blob, sampleCount: 4 } });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
