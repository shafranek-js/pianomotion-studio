import { parseSf2BlobMetadata } from "./sf2BlobParser.ts";
import {
  getSf2BaseSampleType,
  SF2_SAMPLE_COMPRESSED_FLAG,
  SF2_SAMPLE_ROM_FLAG,
  type Sf2Header,
  type Sf2Preset,
  type Sf2SampleHeader,
  type Sf2SoundFont,
  type Sf2Zone,
} from "./types";

export type Sf2ProgressPhase = "reading" | "parsing" | "hashing" | "saving";
export interface Sf2Progress {
  phase: Sf2ProgressPhase;
  loadedBytes: number;
  totalBytes: number;
}
export type Sf2ProgressCallback = (progress: Sf2Progress) => void;
export interface Sf2OperationOptions {
  signal?: AbortSignal;
  onProgress?: Sf2ProgressCallback;
}

export class InvalidSoundFontError extends Error {
  constructor(message: string) {
    super(`Invalid SoundFont: ${message}`);
    this.name = "InvalidSoundFontError";
  }
}

export const MAX_SF2_FILE_BYTES = 1024 * 1024 * 1024;

export function assertSf2FileSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 12) {
    throw new InvalidSoundFontError("File is too small to be a valid SF2 file.");
  }
  if (byteLength > MAX_SF2_FILE_BYTES) {
    throw new InvalidSoundFontError("File exceeds the 1 GiB SoundFont limit.");
  }
}

export interface Sf2ParserOptions {
  /** Used by the Blob metadata parser so the PCM remains in its original Blob. */
  sampleSource?: { blob: Blob; sampleDataOffset: number; sampleCount: number; sampleDataByteLength?: number };
}

interface ChunkView {
  tag: string;
  dataOffset: number;
  size: number;
  unpadded: boolean;
}

const TABLE_ENTRY_BYTES: Record<string, number> = {
  phdr: 38,
  pbag: 4,
  pmod: 10,
  pgen: 4,
  inst: 22,
  ibag: 4,
  imod: 10,
  igen: 4,
  shdr: 46,
};
const MAX_OGG_PAGE_BYTES = 27 + 255 + 255 * 255;

type GeneratorMap = Map<number, number>;

const VALUE_GENERATORS = new Set([17, 34, 35, 36, 37, 38, 48, 51, 52]);
const PRESET_GENERATOR_DEFAULTS: Record<number, number> = {
  17: 0,
  34: -12_000,
  35: -12_000,
  36: -12_000,
  37: 0,
  38: -12_000,
  48: 0,
  51: 0,
  52: 0,
};

/**
 * Parser for SoundFont 2 (SF2) binary files. The synchronous ArrayBuffer path
 * keeps rawSampleData for existing in-memory callers. Blob imports use the
 * metadata-only worker path below and retain PCM as a file-backed source.
 */
export class Sf2Parser {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;

  constructor(buffer: ArrayBuffer | Uint8Array, private readonly options: Sf2ParserOptions = {}) {
    if (buffer instanceof Uint8Array) {
      this.bytes = buffer;
      this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else {
      this.bytes = new Uint8Array(buffer);
      this.view = new DataView(buffer);
    }
  }

  public parse(): Sf2SoundFont {
    assertSf2FileSize(this.bytes.byteLength);
    if (this.readAscii(0, 4) !== "RIFF") {
      throw new InvalidSoundFontError(`Expected RIFF header, got '${this.readAscii(0, 4)}'`);
    }

    const riffSize = this.readUint32At(4);
    const riffEnd = riffSize + 8;
    if (riffSize < 4 || riffEnd > this.bytes.byteLength) {
      throw new InvalidSoundFontError("RIFF size extends beyond the file boundary.");
    }
    if (this.readAscii(8, 4) !== "sfbk") {
      throw new InvalidSoundFontError(`Expected form type 'sfbk', got '${this.readAscii(8, 4)}'`);
    }

    let header: Sf2Header = { name: "Unnamed SoundFont", versionMajor: 2, versionMinor: 4 };
    let rawSampleData = new Int16Array(0);
    let sawSampleData = false;
    let sawUnpaddedSf3Chunk = false;
    let sampleDataChunk: ChunkView | null = null;
    let rawShdr: Uint8Array | null = null;
    const tables = new Map<string, Uint8Array>();

    for (const chunk of this.listChunks(12, riffEnd, false, true)) {
      if (chunk.tag !== "LIST") continue;
      if (chunk.size < 4) throw new InvalidSoundFontError("LIST chunk is missing its list type.");
      const listType = this.readAscii(chunk.dataOffset, 4);
      const listEnd = chunk.dataOffset + chunk.size;
      const unpaddedList = (chunk.size & 1) !== 0 &&
        (listEnd === riffEnd || (listEnd + 4 <= riffEnd && this.readAscii(listEnd, 4) === "LIST"));
      if (unpaddedList && listType !== "sdta") {
        throw new InvalidSoundFontError(`LIST '${listType}' omits its RIFF padding byte; only an SF3 sdta list may use this form.`);
      }
      if (unpaddedList) sawUnpaddedSf3Chunk = true;
      const children = this.listChunks(chunk.dataOffset + 4, listEnd, listType === "sdta");

      if (listType === "INFO") {
        header = this.parseInfoList(children, header);
      } else if (listType === "sdta") {
        for (const child of children) {
          if (child.tag !== "smpl") continue;
          if (child.unpadded) sawUnpaddedSf3Chunk = true;
          if (sawSampleData) throw new InvalidSoundFontError("The sdta list contains more than one smpl sample-data chunk.");
          sawSampleData = true;
          sampleDataChunk = child;
        }
      } else if (listType === "pdta") {
        for (const child of children) {
          if (!(child.tag in TABLE_ENTRY_BYTES)) continue;
          if (tables.has(child.tag)) throw new InvalidSoundFontError(`pdta contains duplicate '${child.tag}' tables.`);
          const entryBytes = TABLE_ENTRY_BYTES[child.tag]!;
          if (child.size % entryBytes !== 0) {
            throw new InvalidSoundFontError(`pdta '${child.tag}' table has ${child.size} bytes; entries must be ${entryBytes} bytes long.`);
          }
          tables.set(child.tag, this.bytes.subarray(child.dataOffset, child.dataOffset + child.size));
          if (child.tag === "shdr") rawShdr = tables.get(child.tag)!;
        }
      }
    }

    if (sawUnpaddedSf3Chunk && header.versionMajor !== 3) {
      throw new InvalidSoundFontError("An unpadded sdta LIST or smpl chunk is invalid in SF2; only an SF3 sdta list may omit its RIFF padding byte.");
    }

    const sampleHeaders = rawShdr ? this.parseSampleHeaders(rawShdr) : [];
    if (!sampleDataChunk) throw new InvalidSoundFontError("The sdta list does not contain an embedded smpl sample-data chunk.");
    const compressedHeaders = sampleHeaders.filter((sample) => sample.compressed);
    if (compressedHeaders.length === 0 && sampleDataChunk.size % 2 !== 0) {
      throw new InvalidSoundFontError("Sample data must contain complete 16-bit PCM values.");
    }
    const compressedDataStart = compressedHeaders.length > 0
      ? compressedHeaders.reduce((first, sample) => Math.min(first, sample.compressedByteStart ?? 0), Number.POSITIVE_INFINITY)
      : sampleDataChunk.size;
    const pcmSampleCount = compressedHeaders.length > 0
      ? Math.floor(compressedDataStart / 2)
      : this.options.sampleSource?.sampleCount ?? Math.floor(sampleDataChunk.size / 2);
    if (compressedHeaders.length > 0 && !this.options.sampleSource) {
      for (const sample of compressedHeaders) this.populateCompressedSampleMetadata(sample, sampleDataChunk.dataOffset, sampleDataChunk.size);
    }
    let sampleSource = this.options.sampleSource;
    if (compressedHeaders.length > 0) {
      if (!sampleSource) {
        // Sync callers already own the full source buffer. Wrap it as a Blob
        // and keep its encoded sample streams out of rawSampleData.
        sampleSource = {
          blob: new Blob([this.bytes.slice()]),
          sampleDataOffset: sampleDataChunk.dataOffset,
          sampleCount: pcmSampleCount,
          sampleDataByteLength: sampleDataChunk.size,
        };
      } else {
        sampleSource = {
          ...sampleSource,
          sampleCount: pcmSampleCount,
          sampleDataByteLength: sampleSource.sampleDataByteLength ?? sampleDataChunk.size,
        };
      }
    } else if (!sampleSource) {
      rawSampleData = new Int16Array(sampleDataChunk.size / 2);
      for (let i = 0; i < rawSampleData.length; i++) {
        rawSampleData[i] = this.view.getInt16(sampleDataChunk.dataOffset + i * 2, true);
      }
    }
    this.validateSampleHeaders(
      sampleHeaders,
      pcmSampleCount,
      sampleSource?.sampleDataByteLength ?? sampleDataChunk.size,
    );

    const presets: Sf2Preset[] = [];
    const requiredPresetTables = ["phdr", "pbag", "pgen", "inst", "ibag", "igen"];
    const presentPresetTables = requiredPresetTables.filter((tag) => tables.has(tag));
    if (presentPresetTables.length > 0 && presentPresetTables.length !== requiredPresetTables.length) {
      const missing = requiredPresetTables.filter((tag) => !tables.has(tag));
      throw new InvalidSoundFontError(`Preset tables are incomplete; missing ${missing.join(", ")}.`);
    }
    if (presentPresetTables.length === requiredPresetTables.length) {
      this.validateInstrumentSamplePairs(tables, sampleHeaders);
      this.assemblePresets(tables, sampleHeaders, presets);
    }

    if (presets.length === 0 && sampleHeaders.some((sample) => sample.name !== "EOS")) {
      const fallbackZones: Sf2Zone[] = sampleHeaders
        .filter((sample) => sample.name !== "EOS")
        .map((sample, idx) => ({
          keyRange: [0, 127],
          velRange: [0, 127],
          sampleIndex: idx,
          rootKey: sample.originalPitch,
          pitchCorrection: sample.pitchCorrection,
        }));
      presets.push({ name: header.name || "Default Preset", presetNumber: 0, bankNumber: 0, zones: fallbackZones });
    }

    for (const preset of presets) {
      for (const zone of preset.zones) {
        if (zone.sampleModes !== undefined && ![0, 1, 3].includes(zone.sampleModes)) {
          throw new InvalidSoundFontError(`Preset '${preset.name}' uses reserved or unsupported sampleModes ${zone.sampleModes}; supported values are 0, 1, and 3.`);
        }
      }
    }

    const result: Sf2SoundFont = { header, presets, samples: sampleHeaders };
    if (sampleSource) result.sampleSource = sampleSource;
    else result.rawSampleData = rawSampleData;
    return result;
  }

  private parseInfoList(chunks: ChunkView[], currentHeader: Sf2Header): Sf2Header {
    const header = { ...currentHeader };
    for (const chunk of chunks) {
      const value = this.decodeFixedString(this.bytes.subarray(chunk.dataOffset, chunk.dataOffset + chunk.size));
      if (chunk.tag === "INAM") header.name = value;
      else if (chunk.tag === "isng") header.soundEngine = value;
      else if (chunk.tag === "ifil" && chunk.size >= 4) {
        const versionMajor = this.readUint16At(chunk.dataOffset);
        const versionMinor = this.readUint16At(chunk.dataOffset + 2);
        if (!((versionMajor === 2 && versionMinor <= 4) || (versionMajor === 3 && versionMinor <= 1))) {
          throw new InvalidSoundFontError(`SoundFont version ${versionMajor}.${versionMinor} is unsupported; this renderer accepts SF2 through 2.4 and SF3 through 3.1.`);
        }
        header.versionMajor = versionMajor;
        header.versionMinor = versionMinor;
      }
    }
    return header;
  }

  private parseSampleHeaders(rawShdr: Uint8Array): Sf2SampleHeader[] {
    const view = new DataView(rawShdr.buffer, rawShdr.byteOffset, rawShdr.byteLength);
    const headers: Sf2SampleHeader[] = [];
    for (let base = 0; base < rawShdr.byteLength; base += 46) {
      const rawName = this.decodeFixedString(rawShdr.subarray(base, base + 20));
      const rawStart = view.getUint32(base + 20, true);
      const rawEnd = view.getUint32(base + 24, true);
      const loopStart = view.getUint32(base + 28, true);
      const loopEnd = view.getUint32(base + 32, true);
      const sampleRate = view.getUint32(base + 36, true);
      const originalPitch = view.getUint8(base + 40);
      const pitchCorrection = view.getInt8(base + 41);
      const sampleLink = view.getUint16(base + 42, true);
      const sampleType = view.getUint16(base + 44, true);
      const isTrailingZeroTerminal =
        base > 0 &&
        base + 46 === rawShdr.byteLength &&
        rawName === "" &&
        rawStart === 0 &&
        rawEnd === 0 &&
        loopStart === 0 &&
        loopEnd === 0 &&
        sampleRate === 0 &&
        sampleLink === 0 &&
        sampleType === 0;
      const name = isTrailingZeroTerminal ? "EOS" : rawName;
      const compressed = (sampleType & SF2_SAMPLE_COMPRESSED_FLAG) !== 0;
      headers.push({
        name,
        // SF3 stores byte offsets in SHDR for encoded samples. Normalize the
        // playback range to decoded frame indices after reading Ogg metadata.
        start: compressed ? 0 : rawStart,
        end: compressed ? 0 : rawEnd,
        loopStart,
        loopEnd,
        sampleRate,
        originalPitch,
        pitchCorrection,
        sampleLink,
        sampleType,
        ...(compressed ? {
          compressed: true,
          compressedByteStart: rawStart,
          // RFC SF3 says inclusive; MuseScore's official sftools writer emits
          // the exclusive end. Resolve the boundary from the Ogg EOS page.
          compressedByteEnd: rawEnd,
        } : {}),
      });
    }
    return headers;
  }

  private populateCompressedSampleMetadata(sample: Sf2SampleHeader, sampleDataOffset: number, sampleDataByteLength: number): void {
    const byteStart = sample.compressedByteStart ?? -1;
    const rawEnd = sample.compressedByteEnd ?? -1;
    const absoluteStart = sampleDataOffset + byteStart;
    if (byteStart < 0 || rawEnd <= byteStart || rawEnd > sampleDataByteLength || sampleDataOffset + rawEnd > this.bytes.byteLength) {
      throw new InvalidSoundFontError(`Compressed sample '${sample.name}' has invalid encoded byte bounds.`);
    }
    if (absoluteStart + 27 > this.bytes.byteLength || this.readAscii(absoluteStart, 4) !== "OggS" || this.bytes[absoluteStart + 4] !== 0) {
      throw new InvalidSoundFontError(`Compressed sample '${sample.name}' does not begin with an Ogg page.`);
    }
    const streamSerial = this.view.getUint32(absoluteStart + 14, true);
    const segmentCount = this.bytes[absoluteStart + 26]!;
    const lacingOffset = absoluteStart + 27;
    if (lacingOffset + segmentCount > sampleDataOffset + sampleDataByteLength) throw new InvalidSoundFontError(`Compressed sample '${sample.name}' has an incomplete Ogg page header.`);
    let packetLength = 0;
    let packetComplete = false;
    for (let index = 0; index < segmentCount; index++) {
      const lace = this.bytes[lacingOffset + index]!;
      packetLength += lace;
      if (lace < 255) {
        packetComplete = true;
        break;
      }
    }
    const packetOffset = lacingOffset + segmentCount;
    if (!packetComplete || packetLength < 30 || packetOffset + 30 > sampleDataOffset + sampleDataByteLength ||
        this.bytes[packetOffset] !== 1 || this.readAscii(packetOffset + 1, 6) !== "vorbis") {
      throw new InvalidSoundFontError(`Compressed sample '${sample.name}' does not contain a supported Ogg Vorbis identification packet.`);
    }
    if (this.view.getUint32(packetOffset + 7, true) !== 0) throw new InvalidSoundFontError(`Compressed sample '${sample.name}' has an unsupported Vorbis version.`);
    const channels = this.bytes[packetOffset + 11]!;
    const sampleRate = this.view.getUint32(packetOffset + 12, true);
    if (channels !== 1 || sampleRate !== sample.sampleRate) {
      throw new InvalidSoundFontError(`Compressed sample '${sample.name}' must be mono at ${sample.sampleRate} Hz; its Ogg stream declares ${channels} channel(s) at ${sampleRate} Hz.`);
    }

    const candidateEnds = [rawEnd, rawEnd + 1].filter((end) => end > byteStart && end <= sampleDataByteLength);
    let resolvedEnd: number | null = null;
    let frameCount: bigint | null = null;
    for (const candidateEnd of candidateEnds) {
      const absoluteEnd = sampleDataOffset + candidateEnd;
      const searchStart = Math.max(absoluteStart, absoluteEnd - MAX_OGG_PAGE_BYTES);
      for (let offset = absoluteEnd - 27; offset >= searchStart; offset--) {
        if (this.readAscii(offset, 4) !== "OggS" || this.bytes[offset + 4] !== 0 || (this.bytes[offset + 5]! & 0x04) === 0) continue;
        if (this.view.getUint32(offset + 14, true) !== streamSerial) continue;
        const segments = this.bytes[offset + 26]!;
        const tableEnd = offset + 27 + segments;
        if (tableEnd > absoluteEnd) continue;
        let bodyBytes = 0;
        for (let index = 0; index < segments; index++) bodyBytes += this.bytes[offset + 27 + index]!;
        if (tableEnd + bodyBytes !== absoluteEnd) continue;
        const granule = this.view.getBigUint64(offset + 6, true);
        if (granule !== 0xffff_ffff_ffff_ffffn) {
          resolvedEnd = candidateEnd;
          frameCount = granule;
          break;
        }
      }
      if (frameCount !== null) break;
    }
    if (frameCount === null || frameCount <= 0n || frameCount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new InvalidSoundFontError(`Compressed sample '${sample.name}' has no valid Ogg final granule frame count.`);
    }
    const decodedFrameCount = Number(frameCount);
    if (sample.loopStart > sample.loopEnd || sample.loopEnd > decodedFrameCount) {
      throw new InvalidSoundFontError(`Compressed sample '${sample.name}' has loop bounds ${sample.loopStart}..${sample.loopEnd} outside ${decodedFrameCount} decoded frames.`);
    }
    sample.decodedFrameCount = decodedFrameCount;
    sample.compressedByteEnd = resolvedEnd!;
    sample.start = 0;
    sample.end = decodedFrameCount;
  }

  private validateSampleHeaders(samples: Sf2SampleHeader[], sampleCount: number, sampleDataByteLength: number): void {
    const eosIndex = samples.findIndex((sample) => sample.name === "EOS");
    const realCount = eosIndex >= 0 ? eosIndex : samples.length;
    // `sampleCount` is the verified PCM prefix when SF3 streams are present;
    // the source's sampleCount may describe the whole mixed byte chunk.
    const sampleLimit = sampleCount;

    for (let index = 0; index < realCount; index++) {
      const sample = samples[index]!;
      const context = `Sample '${sample.name || index}'`;
      if ((sample.sampleType & SF2_SAMPLE_ROM_FLAG) !== 0) {
        throw new InvalidSoundFontError(`${context}: ROM-backed samples are not supported; choose a bank containing embedded PCM samples.`);
      }
      const type = getSf2BaseSampleType(sample.sampleType);
      if (![1, 2, 4].includes(type)) {
        if (type === 8) throw new InvalidSoundFontError(`${context} uses linked sample type 8, which is not supported.`);
        throw new InvalidSoundFontError(`${context} uses unsupported sample type ${type}; supported SF2 types are mono (1), right (2), and left (4).`);
      }
      if (!(sample.sampleRate >= 3000 && sample.sampleRate <= 384000)) {
        throw new InvalidSoundFontError(`${context} has unsupported sample rate ${sample.sampleRate}; supported playback rates are 3000 to 384000 Hz (resampling is not implemented).`);
      }
      if ((sample.sampleType & ~(SF2_SAMPLE_ROM_FLAG | SF2_SAMPLE_COMPRESSED_FLAG | 0x000f)) !== 0) {
        throw new InvalidSoundFontError(`${context} uses unsupported sample-type flags 0x${sample.sampleType.toString(16)}.`);
      }
      if (sample.compressed) {
        const start = sample.compressedByteStart ?? -1;
        const end = sample.compressedByteEnd ?? -1;
        if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < end && end <= sampleDataByteLength)) {
          throw new InvalidSoundFontError(`${context} has invalid compressed byte bounds ${start}..${end} for ${sampleDataByteLength} available bytes.`);
        }
        if (!(sample.loopStart >= 0 && sample.loopStart <= sample.loopEnd)) {
          throw new InvalidSoundFontError(`${context} has invalid decoded loop bounds ${sample.loopStart}..${sample.loopEnd}.`);
        }
        if (sample.decodedFrameCount !== undefined) {
          if (!(Number.isSafeInteger(sample.decodedFrameCount) && sample.decodedFrameCount > 0 && sample.loopEnd <= sample.decodedFrameCount)) {
            throw new InvalidSoundFontError(`${context} has invalid decoded frame count ${sample.decodedFrameCount} for loop ${sample.loopStart}..${sample.loopEnd}.`);
          }
          sample.start = 0;
          sample.end = sample.decodedFrameCount;
        }
      } else {
        if (!(sample.start < sample.end && sample.end <= sampleLimit)) {
          throw new InvalidSoundFontError(`${context} has invalid PCM bounds ${sample.start}..${sample.end} for ${sampleLimit} available samples.`);
        }
        if (!(sample.start <= sample.loopStart && sample.loopStart <= sample.loopEnd && sample.loopEnd <= sample.end)) {
          throw new InvalidSoundFontError(`${context} has loop bounds ${sample.loopStart}..${sample.loopEnd} outside its PCM range ${sample.start}..${sample.end}.`);
        }
      }
    }

    for (let index = 0; index < realCount; index++) {
      const sample = samples[index]!;
      const type = getSf2BaseSampleType(sample.sampleType);
      if (type !== 2 && type !== 4) continue;
      const link = sample.sampleLink ?? 0;
      // MuseScore emits independent mono streams with sampleLink=0. However,
      // a real compressed pair can also use index 0 as the partner. Treat 0 as
      // unlinked only if sample 0 does not reciprocally point to this header.
      if (this.isUnlinkedCompressedStereo(sample, index, samples)) continue;
      if (link >= realCount || link === index) {
        throw new InvalidSoundFontError(`Stereo sample '${sample.name}' has invalid sampleLink ${link}.`);
      }
      const partner = samples[link]!;
      const partnerType = getSf2BaseSampleType(partner.sampleType);
      if (partner.sampleLink !== index || partnerType !== (type === 2 ? 4 : 2)) {
        throw new InvalidSoundFontError(`Stereo sample '${sample.name}' must link reciprocally to an opposite-channel sample.`);
      }
      const left = type === 4 ? sample : partner;
      const right = type === 2 ? sample : partner;
      if (left.sampleRate !== right.sampleRate) {
        throw new InvalidSoundFontError(`Stereo samples '${left.name}' and '${right.name}' must have matching sample rates.`);
      }
    }
  }

  private validateInstrumentSamplePairs(tables: Map<string, Uint8Array>, samples: Sf2SampleHeader[]): void {
    const realCount = samples.findIndex((sample) => sample.name === "EOS") >= 0
      ? samples.findIndex((sample) => sample.name === "EOS")
      : samples.length;
    const inst = tables.get("inst")!;
    const ibag = tables.get("ibag")!;
    const igen = tables.get("igen")!;
    const instView = this.dataView(inst);
    const ibagView = this.dataView(ibag);
    const igenView = this.dataView(igen);
    const instrumentCount = this.terminalCount(inst, 22, "EOI");
    const bagCount = ibag.byteLength / 4;
    const genCount = igen.byteLength / 4;
    const sampleInstruments = Array.from({ length: realCount }, () => new Set<number>());

    for (let id = 0; id < instrumentCount; id++) {
      const start = instView.getUint16(id * 22 + 20, true);
      const end = instView.getUint16((id + 1) * 22 + 20, true);
      this.assertIndexRange("instrument bag", start, end, bagCount - 1, `Instrument ${id}`);
      for (let bag = start; bag < end; bag++) {
        const genStart = ibagView.getUint16(bag * 4, true);
        const genEnd = ibagView.getUint16((bag + 1) * 4, true);
        this.assertIndexRange("instrument generator", genStart, genEnd, genCount, `Instrument ${id}, zone ${bag - start}`);
        for (let gen = genStart; gen < genEnd; gen++) {
          if (igenView.getUint16(gen * 4, true) !== 53) continue;
          const sampleId = igenView.getUint16(gen * 4 + 2, true);
          if (sampleId >= realCount) {
            throw new InvalidSoundFontError(`Instrument ${id} references invalid sample index ${sampleId}.`);
          }
          sampleInstruments[sampleId]!.add(id);
        }
      }
    }

    for (let index = 0; index < realCount; index++) {
      const sample = samples[index]!;
      const type = getSf2BaseSampleType(sample.sampleType);
      if (type !== 2 && type !== 4) continue;
      if (this.isUnlinkedCompressedStereo(sample, index, samples)) continue;
      const other = sampleInstruments[sample.sampleLink ?? -1];
      const own = sampleInstruments[index]!;
      if (!other) throw new InvalidSoundFontError(`Stereo sample '${sample.name}' links to a sample outside the sample table.`);
      if (own.size > 0 || other.size > 0) {
        if (own.size === 0 || own.size !== other.size || [...own].some((instrumentId) => !other.has(instrumentId))) {
          throw new InvalidSoundFontError(`Stereo samples '${sample.name}' and '${samples[sample.sampleLink!]!.name}' must be paired within the same instrument(s).`);
        }
      }
    }
  }

  private isUnlinkedCompressedStereo(sample: Sf2SampleHeader, index: number, samples: Sf2SampleHeader[]): boolean {
    if (!sample.compressed || (sample.sampleLink ?? 0) !== 0) return false;
    if (index === 0) return true;
    const first = samples[0];
    const type = getSf2BaseSampleType(sample.sampleType);
    const firstType = first ? getSf2BaseSampleType(first.sampleType) : 0;
    const oppositeType = type === 2 ? 4 : type === 4 ? 2 : 0;
    return !first || first.sampleLink !== index || firstType !== oppositeType;
  }

  private assemblePresets(tables: Map<string, Uint8Array>, sampleHeaders: Sf2SampleHeader[], outPresets: Sf2Preset[]): void {
    const rawPhdr = tables.get("phdr")!;
    const rawPbag = tables.get("pbag")!;
    const rawPgen = tables.get("pgen")!;
    const rawInst = tables.get("inst")!;
    const rawIbag = tables.get("ibag")!;
    const rawIgen = tables.get("igen")!;
    const phdrView = this.dataView(rawPhdr);
    const pbagView = this.dataView(rawPbag);
    const pgenView = this.dataView(rawPgen);
    const instView = this.dataView(rawInst);
    const ibagView = this.dataView(rawIbag);
    const igenView = this.dataView(rawIgen);

    const presetCount = this.terminalCount(rawPhdr, 38, "EOP");
    const instrumentCount = this.terminalCount(rawInst, 22, "EOI");
    const pbagCount = rawPbag.byteLength / 4;
    const pgenCount = rawPgen.byteLength / 4;
    const ibagCount = rawIbag.byteLength / 4;
    const igenCount = rawIgen.byteLength / 4;
    const eosIndex = sampleHeaders.findIndex((sample) => sample.name === "EOS");
    const realSampleCount = eosIndex >= 0 ? eosIndex : sampleHeaders.length;

    for (let p = 0; p < presetCount; p++) {
      const pOffset = p * 38;
      const name = this.decodeFixedString(rawPhdr.subarray(pOffset, pOffset + 20));
      const presetNumber = phdrView.getUint16(pOffset + 20, true);
      const bankNumber = phdrView.getUint16(pOffset + 22, true);
      const pbagStart = phdrView.getUint16(pOffset + 24, true);
      const pbagEnd = phdrView.getUint16((p + 1) * 38 + 24, true);
      this.assertIndexRange("preset bag", pbagStart, pbagEnd, pbagCount - 1, `Preset '${name || presetNumber}'`);
      const zones: Sf2Zone[] = [];
      let presetGlobal: GeneratorMap | undefined;

      for (let pb = pbagStart; pb < pbagEnd; pb++) {
        const pgenStart = pbagView.getUint16(pb * 4, true);
        const pgenEnd = pbagView.getUint16((pb + 1) * 4, true);
        this.assertIndexRange("preset generator", pgenStart, pgenEnd, pgenCount, `Preset '${name || presetNumber}', zone ${pb - pbagStart}`);
        const presetGenerators = this.readGeneratorMap(pgenView, pgenStart, pgenEnd);
        const instrumentId = presetGenerators.get(41);
        if (pb === pbagStart && instrumentId === undefined) {
          presetGlobal = presetGenerators;
          continue;
        }
        if (instrumentId === undefined) continue;
        if (instrumentId >= instrumentCount) {
          throw new InvalidSoundFontError(`Preset '${name || presetNumber}' references invalid instrument index ${instrumentId}.`);
        }

        const presetValues = this.resolveValueGenerators(presetGlobal, presetGenerators, VALUE_GENERATORS);
        const pKeyRange = this.resolveGeneratorRange(presetGlobal, presetGenerators, 43, "preset key");
        const pVelRange = this.resolveGeneratorRange(presetGlobal, presetGenerators, 44, "preset velocity");
        const instOffset = instrumentId * 22;
        const ibagStart = instView.getUint16(instOffset + 20, true);
        const ibagEnd = instView.getUint16((instrumentId + 1) * 22 + 20, true);
        this.assertIndexRange("instrument bag", ibagStart, ibagEnd, ibagCount - 1, `Instrument ${instrumentId}`);

        const instrumentZones: Array<{ bagIndex: number; generators: GeneratorMap }> = [];
        for (let ib = ibagStart; ib < ibagEnd; ib++) {
          const igenStart = ibagView.getUint16(ib * 4, true);
          const igenEnd = ibagView.getUint16((ib + 1) * 4, true);
          this.assertIndexRange("instrument generator", igenStart, igenEnd, igenCount, `Instrument ${instrumentId}, zone ${ib - ibagStart}`);
          instrumentZones.push({ bagIndex: ib, generators: this.readGeneratorMap(igenView, igenStart, igenEnd) });
        }
        const firstInstrumentZone = instrumentZones[0]?.generators;
        const instrumentGlobal = firstInstrumentZone && !firstInstrumentZone.has(53) ? firstInstrumentZone : undefined;

        for (const { bagIndex: ib, generators: instrumentGenerators } of instrumentZones) {
          const sampleId = instrumentGenerators.get(53);
          if (sampleId === undefined) continue;
          if (sampleId >= realSampleCount) {
            throw new InvalidSoundFontError(`Instrument ${instrumentId}, zone ${ib - ibagStart} references invalid sample index ${sampleId}.`);
          }
          const iValues = this.resolveValueGenerators(instrumentGlobal, instrumentGenerators, VALUE_GENERATORS);
          const iKeyRange = this.resolveGeneratorRange(instrumentGlobal, instrumentGenerators, 43, "instrument key");
          const iVelRange = this.resolveGeneratorRange(instrumentGlobal, instrumentGenerators, 44, "instrument velocity");
          const finalKeyRange = this.intersectRanges(pKeyRange, iKeyRange);
          const finalVelRange = this.intersectRanges(pVelRange, iVelRange);
          if (!finalKeyRange || !finalVelRange) continue;

          const amount = (operator: number): number | undefined => {
            const instrumentValue = iValues.get(operator);
            const presetValue = presetValues.get(operator);
            if (presetValue === undefined) {
              return instrumentValue === undefined ? undefined : this.signedAmount(instrumentValue);
            }
            const base = instrumentValue === undefined
              ? PRESET_GENERATOR_DEFAULTS[operator] ?? 0
              : this.signedAmount(instrumentValue);
            return base + this.signedAmount(presetValue);
          };
          const coarseTune = amount(51) ?? 0;
          const fineTune = amount(52) ?? 0;
          const sample = sampleHeaders[sampleId];
          const rawRootKey = instrumentGenerators.get(58) ?? instrumentGlobal?.get(58);
          const rootKeyAmount = rawRootKey === undefined ? undefined : this.signedAmount(rawRootKey);
          if (rootKeyAmount !== undefined && rootKeyAmount !== -1 && (rootKeyAmount < 0 || rootKeyAmount > 127)) {
            throw new InvalidSoundFontError(`Instrument ${instrumentId}, zone ${ib - ibagStart} has invalid overridingRootKey ${rootKeyAmount}.`);
          }
          const timecentsToSeconds = (value: number | undefined): number | undefined => value === undefined ? undefined : Math.pow(2, value / 1200);
          const sustainCentibels = amount(37);
          const attenuationCentibels = amount(48);

          zones.push({
            keyRange: finalKeyRange,
            velRange: finalVelRange,
            sampleIndex: sampleId,
            instrumentId,
            presetZoneId: pb,
            instrumentZoneId: ib,
            rootKey: rootKeyAmount === undefined || rootKeyAmount === -1 ? sample?.originalPitch : rootKeyAmount,
            pitchCorrection: (sample?.pitchCorrection ?? 0) + coarseTune * 100 + fineTune,
            // sampleModes is instrument-local only. overridingRootKey may be
            // inherited from the instrument global zone, never the preset.
            sampleModes: instrumentGenerators.get(54),
            pan: amount(17),
            initialAttenuationDb: attenuationCentibels === undefined ? undefined : attenuationCentibels / 10,
            attackSeconds: timecentsToSeconds(amount(34)),
            holdSeconds: timecentsToSeconds(amount(35)),
            decaySeconds: timecentsToSeconds(amount(36)),
            sustainPercent: sustainCentibels === undefined ? undefined : 100 * Math.pow(10, -sustainCentibels / 200),
            releaseSeconds: timecentsToSeconds(amount(38)),
          });
        }
      }

      if (zones.length > 0) outPresets.push({ name: name || `Preset ${presetNumber}`, presetNumber, bankNumber, zones });
    }
    // SF2/SF3 phdr tables are not required to be stored in bank/program order
    // (e.g. MuseScore General stores Contrabass/Cello first and Grand Piano at index 299).
    // Sort by (bankNumber, presetNumber) so bank 0 preset 0 (Grand Piano) is first.
    outPresets.sort((a, b) => (a.bankNumber - b.bankNumber) || (a.presetNumber - b.presetNumber));
  }

  private readGeneratorMap(view: DataView, start: number, end: number): GeneratorMap {
    const generators: GeneratorMap = new Map();
    for (let index = start; index < end; index++) {
      const operator = view.getUint16(index * 4, true);
      // SF2 says the first occurrence is ignored when a zone repeats a generator.
      generators.set(operator, view.getUint16(index * 4 + 2, true));
    }
    return generators;
  }

  private resolveValueGenerators(globalZone: GeneratorMap | undefined, localZone: GeneratorMap, supported: Set<number>): GeneratorMap {
    const resolved: GeneratorMap = new Map();
    if (globalZone) {
      for (const [operator, amount] of globalZone) {
        if (supported.has(operator)) resolved.set(operator, amount);
      }
    }
    for (const [operator, amount] of localZone) {
      if (supported.has(operator)) resolved.set(operator, amount);
    }
    return resolved;
  }

  private resolveGeneratorRange(
    globalZone: GeneratorMap | undefined,
    localZone: GeneratorMap,
    operator: 43 | 44,
    context: string,
  ): [number, number] {
    const amount = localZone.get(operator) ?? globalZone?.get(operator);
    return amount === undefined ? [0, 127] : this.readRange(amount, context);
  }

  private intersectRanges(left: [number, number], right: [number, number]): [number, number] | undefined {
    const range: [number, number] = [Math.max(left[0], right[0]), Math.min(left[1], right[1])];
    return range[0] <= range[1] ? range : undefined;
  }

  private listChunks(start: number, end: number, allowOddSampleData = false, allowUnpaddedList = false): ChunkView[] {
    const chunks: ChunkView[] = [];
    let offset = start;
    while (offset < end) {
      if (end - offset < 8) throw new InvalidSoundFontError("Chunk table ends with an incomplete chunk header.");
      const tag = this.readAscii(offset, 4);
      const size = this.readUint32At(offset + 4);
      const dataOffset = offset + 8;
      const dataEnd = dataOffset + size;
      let next = dataEnd + (size & 1);
      const unpaddedSample = tag === "smpl" && allowOddSampleData && (size & 1) !== 0 &&
          (dataEnd === end || (dataEnd + 4 <= end && this.readAscii(dataEnd, 4) === "sm24"));
      if (unpaddedSample) {
        next = dataEnd;
      }
      const unpaddedList = tag === "LIST" && allowUnpaddedList && (size & 1) !== 0 &&
          (dataEnd === end || (dataEnd + 4 <= end && this.readAscii(dataEnd, 4) === "LIST"));
      if (unpaddedList) {
        next = dataEnd;
      }
      if (dataEnd > end || next > end) {
        throw new InvalidSoundFontError(`Chunk '${tag}' extends beyond its containing RIFF/LIST boundary.`);
      }
      chunks.push({ tag, dataOffset, size, unpadded: unpaddedSample || unpaddedList });
      offset = next;
    }
    return chunks;
  }

  private terminalCount(bytes: Uint8Array, entrySize: number, terminalName: string): number {
    const count = bytes.byteLength / entrySize;
    if (count === 0) return 0;
    // The SF2 terminal record is mandatory by format. Older small fixtures use
    // a zero-filled terminal name, so its position is authoritative here.
    void terminalName;
    return count - 1;
  }

  private assertIndexRange(kind: string, start: number, end: number, limit: number, context: string): void {
    if (start > end || end > limit) {
      throw new InvalidSoundFontError(`${context} has invalid ${kind} index range ${start}..${end}; table limit is ${limit}.`);
    }
  }

  private readRange(value: number, context: string): [number, number] {
    const min = value & 0xff;
    const max = (value >>> 8) & 0xff;
    if (min > max || max > 127) throw new InvalidSoundFontError(`Invalid ${context} range ${min}..${max}.`);
    return [min, max];
  }

  private signedAmount(value: number): number {
    return value > 32767 ? value - 65536 : value;
  }

  private dataView(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private readAscii(offset: number, length: number): string {
    this.assertBytes(offset, length);
    let result = "";
    for (let i = 0; i < length; i++) result += String.fromCharCode(this.bytes[offset + i]!);
    return result;
  }

  private readUint32At(offset: number): number {
    this.assertBytes(offset, 4);
    return this.view.getUint32(offset, true);
  }

  private readUint16At(offset: number): number {
    this.assertBytes(offset, 2);
    return this.view.getUint16(offset, true);
  }

  private assertBytes(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.bytes.byteLength) {
      throw new InvalidSoundFontError("A chunk references bytes outside the file boundary.");
    }
  }

  private decodeFixedString(bytes: Uint8Array): string {
    let len = 0;
    while (len < bytes.length && bytes[len] !== 0) len++;
    return new TextDecoder("ascii").decode(bytes.subarray(0, len)).trim();
  }
}

export function parseSf2(buffer: ArrayBuffer | Uint8Array): Sf2SoundFont {
  assertSf2FileSize(buffer.byteLength);
  try {
    return new Sf2Parser(buffer).parse();
  } catch (error) {
    throw asInvalidSoundFontError(error, "The file could not be parsed as an SF2 bank.");
  }
}

export function parseSf2MetadataBuffer(
  buffer: ArrayBuffer | Uint8Array,
  sampleSource: { blob: Blob; sampleDataOffset: number; sampleCount: number; sampleDataByteLength?: number },
): Sf2SoundFont {
  assertSf2FileSize(buffer.byteLength);
  try {
    return new Sf2Parser(buffer, { sampleSource }).parse();
  } catch (error) {
    throw asInvalidSoundFontError(error, "The file could not be parsed as an SF2 bank.");
  }
}

/** Converts parser and worker failures into a user-facing SoundFont error. */
export function asInvalidSoundFontError(reason: unknown, fallback: string): InvalidSoundFontError {
  if (reason instanceof InvalidSoundFontError) return reason;
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : fallback;
  const cleanMessage = message.replace(/^Invalid SoundFont:\s*/i, "").trim();
  return new InvalidSoundFontError(cleanMessage || fallback);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function makeAbortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Parses an SF2 file off the main thread. Blob input is never materialized as a
 * whole-file ArrayBuffer. ArrayBuffer callers remain supported and receive a
 * metadata result whose PCM source is a Blob.
 */
export function parseSf2Async(
  input: Blob | ArrayBuffer | Uint8Array,
  options: Sf2OperationOptions & { transferInput?: boolean } = {},
): Promise<Sf2SoundFont> {
  const size = input instanceof Blob ? input.size : input.byteLength;
  try {
    assertSf2FileSize(size);
    if (options.signal?.aborted) return Promise.reject(makeAbortError());
    if (typeof Worker === "undefined") {
      const blob = input instanceof Blob ? input : new Blob([input instanceof Uint8Array ? input.slice() : input]);
      return parseSf2BlobMetadata(blob, options).catch((error: unknown) => {
        if (isAbortError(error)) throw error;
        throw asInvalidSoundFontError(error, "The file could not be parsed as an SF2 bank.");
      });
    }
  } catch (error) {
    return Promise.reject(isAbortError(error) ? error : asInvalidSoundFontError(error, "Unable to read this file."));
  }

  let payload: { blob: Blob } | { buffer: ArrayBuffer };
  let transfer: Transferable[] = [];
  try {
    if (input instanceof Blob) payload = { blob: input };
    else {
      let bytes: ArrayBuffer;
      if (input instanceof Uint8Array) {
        bytes = input.buffer instanceof ArrayBuffer && input.byteOffset === 0 && input.byteLength === input.buffer.byteLength
          ? input.buffer.slice(0)
          : input.slice().buffer as ArrayBuffer;
      } else {
        bytes = options.transferInput ? input : input.slice(0);
      }
      payload = { buffer: bytes };
      transfer = [bytes];
    }
  } catch (error) {
    return Promise.reject(asInvalidSoundFontError(error, "Unable to read this file."));
  }

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./sf2Parse.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(asInvalidSoundFontError(error, "The SoundFont parser worker could not be started."));
      return;
    }
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      try { worker.terminate(); } catch { /* The worker may already have stopped. */ }
      callback();
    };
    const abort = () => finish(() => reject(makeAbortError()));
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ soundFont?: Sf2SoundFont; progress?: Sf2Progress; error?: string }>) => {
      const data = event.data;
      if (data?.progress) {
        options.onProgress?.(data.progress);
        return;
      }
      if (!data || data.error || !data.soundFont) {
        finish(() => reject(asInvalidSoundFontError(data?.error, "The parser worker returned incomplete data.")));
        return;
      }
      const source = data.soundFont.sampleSource;
      if (!(source?.blob instanceof Blob) || !Number.isSafeInteger(source.sampleDataOffset) || !Number.isSafeInteger(source.sampleCount)) {
        finish(() => reject(new InvalidSoundFontError("The parser worker returned invalid file-backed sample data.")));
        return;
      }
      finish(() => resolve(data.soundFont!));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => reject(asInvalidSoundFontError(event.message, "The SoundFont parser worker failed.")));
    };
    worker.onmessageerror = () => finish(() => reject(new InvalidSoundFontError("The SoundFont parser worker returned data that could not be decoded.")));
    try {
      worker.postMessage(payload, transfer);
    } catch (error) {
      finish(() => reject(asInvalidSoundFontError(error, "The SoundFont parser worker could not receive the file.")));
    }
  });
}

export { MAX_SF2_METADATA_BYTES, parseSf2BlobMetadata } from "./sf2BlobParser.ts";
