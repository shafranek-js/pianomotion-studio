import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidSoundFontError, parseSf2, parseSf2Async } from "./sf2Parser.ts";
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
  sampleView.setUint32(36, 22_050, true);
  sampleView.setUint8(40, 60);
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

class FakeWorker {
  public static instances: FakeWorker[] = [];
  public static onPostMessage: ((message: { buffer: ArrayBuffer }, transfer: Transferable[]) => void) | undefined;
  public static lastPayload: { buffer: ArrayBuffer } | undefined;
  public static lastTransfer: Transferable[] = [];
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly terminate = vi.fn();
  public postMessage(message: { buffer: ArrayBuffer }, transfer: Transferable[] = []): void {
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

  it("rejects ROM and linked/stereo samples rather than treating them as mono PCM", () => {
    expect(() => parseSf2(makeSf2({ sampleType: 0x8001 }))).toThrow(/ROM-backed samples are not supported/);
    expect(() => parseSf2(makeSf2({ sampleType: 2 }))).toThrow(/Only mono PCM samples are supported/);
  });

  it("rejects reserved sample loop modes in preset zones", () => {
    expect(() => parseSf2(makeSf2({ sampleModes: 2 }))).toThrow(/sampleModes 2.*supported values are 0, 1, and 3/);
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
    worker.onmessage?.({ data: { soundFont: { header: {}, presets: [], samples: [] }, rawSampleBuffer: {} } } as MessageEvent);
    await expect(parsing).rejects.toMatchObject({ name: "InvalidSoundFontError", message: /invalid sample data/ });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
