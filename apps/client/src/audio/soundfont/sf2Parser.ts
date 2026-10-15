import type { Sf2Header, Sf2Preset, Sf2SampleHeader, Sf2SoundFont, Sf2Zone } from "./types";

export class InvalidSoundFontError extends Error {
  constructor(message: string) {
    super(`Invalid SoundFont: ${message}`);
    this.name = "InvalidSoundFontError";
  }
}

export const MAX_SF2_FILE_BYTES = 128 * 1024 * 1024;

export function assertSf2FileSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 12) {
    throw new InvalidSoundFontError("File is too small to be a valid SF2 file.");
  }
  if (byteLength > MAX_SF2_FILE_BYTES) {
    throw new InvalidSoundFontError(`File exceeds the ${MAX_SF2_FILE_BYTES / (1024 * 1024)} MiB SoundFont limit.`);
  }
}

/**
 * Parser for SoundFont 2 (SF2) binary files conforming to SF2.04 specification.
 */
export class Sf2Parser {
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(buffer: ArrayBuffer | Uint8Array) {
    if (buffer instanceof Uint8Array) {
      this.bytes = buffer;
      this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else {
      this.bytes = new Uint8Array(buffer);
      this.view = new DataView(buffer);
    }
  }

  public parse(): Sf2SoundFont {
    if (this.bytes.byteLength < 12) {
      throw new InvalidSoundFontError("File is too small to be a valid SF2 file.");
    }

    const riffTag = this.readFourCC();
    if (riffTag !== "RIFF") {
      throw new InvalidSoundFontError(`Expected RIFF header, got '${riffTag}'`);
    }

    const fileSize = this.readUint32();
    if (fileSize + 8 > this.bytes.byteLength + 4) {
      // Tolerate slight padding difference, but enforce reasonable size
    }

    const formType = this.readFourCC();
    if (formType !== "sfbk") {
      throw new InvalidSoundFontError(`Expected form type 'sfbk', got '${formType}'`);
    }

    let header: Sf2Header = {
      name: "Unnamed SoundFont",
      versionMajor: 2,
      versionMinor: 4,
    };

    let rawSampleData: Int16Array = new Int16Array(0);
    const sampleHeaders: Sf2SampleHeader[] = [];
    const presets: Sf2Preset[] = [];

    // Temporary storage for pdta subchunks
    let rawPhdr: Uint8Array | null = null;
    let rawPbag: Uint8Array | null = null;
    let rawPgen: Uint8Array | null = null;
    let rawInst: Uint8Array | null = null;
    let rawIbag: Uint8Array | null = null;
    let rawIgen: Uint8Array | null = null;
    let rawShdr: Uint8Array | null = null;

    while (this.offset + 8 <= this.bytes.byteLength) {
      const chunkTag = this.readFourCC();
      const chunkSize = this.readUint32();
      const nextChunkOffset = this.offset + chunkSize + (chunkSize % 2); // Word aligned

      if (chunkTag === "LIST") {
        const listType = this.readFourCC();
        const listEnd = this.offset + chunkSize - 4;

        if (listType === "INFO") {
          header = this.parseInfoList(listEnd, header);
        } else if (listType === "sdta") {
          rawSampleData = this.parseSdtaList(listEnd);
        } else if (listType === "pdta") {
          // Parse pdta subchunks
          while (this.offset + 8 <= listEnd) {
            const subTag = this.readFourCC();
            const subSize = this.readUint32();
            const subData = this.bytes.subarray(this.offset, this.offset + subSize);

            if (subTag === "phdr") rawPhdr = subData;
            else if (subTag === "pbag") rawPbag = subData;
            else if (subTag === "pgen") rawPgen = subData;
            else if (subTag === "inst") rawInst = subData;
            else if (subTag === "ibag") rawIbag = subData;
            else if (subTag === "igen") rawIgen = subData;
            else if (subTag === "shdr") rawShdr = subData;

            this.offset += subSize + (subSize % 2);
          }
        }
      }

      this.offset = nextChunkOffset;
    }

    // Parse Sample Headers (shdr)
    if (rawShdr) {
      const shdrView = new DataView(rawShdr.buffer, rawShdr.byteOffset, rawShdr.byteLength);
      const entrySize = 46; // SF2 sample header is 46 bytes
      const count = Math.floor(rawShdr.byteLength / entrySize);

      for (let i = 0; i < count; i++) {
        const base = i * entrySize;
        const nameBytes = rawShdr.subarray(base, base + 20);
        const name = this.decodeFixedString(nameBytes);
        const start = shdrView.getUint32(base + 20, true);
        const end = shdrView.getUint32(base + 24, true);
        const loopStart = shdrView.getUint32(base + 28, true);
        const loopEnd = shdrView.getUint32(base + 32, true);
        const sampleRate = shdrView.getUint32(base + 36, true);
        const originalPitch = shdrView.getUint8(base + 40);
        const pitchCorrection = shdrView.getInt8(base + 41);
        const sampleType = shdrView.getUint16(base + 44, true);

        sampleHeaders.push({
          name,
          start,
          end,
          loopStart,
          loopEnd,
          sampleRate: sampleRate > 0 ? sampleRate : 44100,
          originalPitch: originalPitch > 0 && originalPitch < 128 ? originalPitch : 60,
          pitchCorrection,
          sampleType,
        });
      }
    }

    for (const sample of sampleHeaders) {
      if (sample.name === "EOS") continue;
      if ((sample.sampleType & 0x8000) !== 0) {
        throw new InvalidSoundFontError("ROM-backed samples are not supported; choose a bank containing embedded PCM samples.");
      }
      if ((sample.sampleType & 0x7fff) !== 1) {
        throw new InvalidSoundFontError("Only mono PCM samples are supported; stereo, linked, and unknown sample types cannot be rendered.");
      }
    }

    // Parse Presets & Instruments if present
    if (rawPhdr && rawPbag && rawPgen && rawInst && rawIbag && rawIgen) {
      this.assemblePresets(
        rawPhdr,
        rawPbag,
        rawPgen,
        rawInst,
        rawIbag,
        rawIgen,
        sampleHeaders,
        presets,
      );
    }

    // Fallback: If no presets assembled, create default piano preset mapping available samples
    if (presets.length === 0 && sampleHeaders.length > 0) {
      const fallbackZones: Sf2Zone[] = sampleHeaders
        .filter((s) => s.end > s.start && s.name !== "EOS")
        .map((sample, idx) => ({
          keyRange: [0, 127],
          velRange: [0, 127],
          sampleIndex: idx,
          rootKey: sample.originalPitch,
          pitchCorrection: sample.pitchCorrection,
        }));

      presets.push({
        name: header.name || "Default Preset",
        presetNumber: 0,
        bankNumber: 0,
        zones: fallbackZones,
      });
    }

    for (const preset of presets) {
      for (const zone of preset.zones) {
        if (zone.sampleModes !== undefined && ![0, 1, 3].includes(zone.sampleModes)) {
          throw new InvalidSoundFontError(`Preset '${preset.name}' uses reserved or unsupported sampleModes ${zone.sampleModes}; supported values are 0, 1, and 3.`);
        }
      }
    }

    return {
      header,
      presets,
      samples: sampleHeaders,
      rawSampleData,
    };
  }

  private parseInfoList(listEnd: number, currentHeader: Sf2Header): Sf2Header {
    const header: Sf2Header = { ...currentHeader };
    while (this.offset + 8 <= listEnd) {
      const tag = this.readFourCC();
      const size = this.readUint32();
      const strBytes = this.bytes.subarray(this.offset, this.offset + size);
      const val = this.decodeFixedString(strBytes);

      if (tag === "INAM") header.name = val;
      else if (tag === "isng") header.soundEngine = val;
      else if (tag === "ifil" && size >= 4) {
        const versionMajor = this.view.getUint16(this.offset, true);
        const versionMinor = this.view.getUint16(this.offset + 2, true);
        if (versionMajor !== 2 || versionMinor > 4) {
          throw new InvalidSoundFontError(`SoundFont version ${versionMajor}.${versionMinor} is unsupported; this renderer accepts SF2 versions through 2.4.`);
        }
        header.versionMajor = versionMajor;
        header.versionMinor = versionMinor;
      }

      this.offset += size + (size % 2);
    }
    return header;
  }

  private parseSdtaList(listEnd: number): Int16Array {
    while (this.offset + 8 <= listEnd) {
      const tag = this.readFourCC();
      const size = this.readUint32();
      if (tag === "smpl") {
        if (size >= 4 && this.decodeFixedString(this.bytes.subarray(this.offset, this.offset + 4)) === "OggS") {
          throw new InvalidSoundFontError("Ogg/Vorbis-compressed sample data (SF3) is not supported; choose an uncompressed PCM SF2 bank.");
        }
        if (size % 2 !== 0) {
          throw new InvalidSoundFontError("Sample data must contain complete 16-bit PCM values.");
        }
        const sampleCount = Math.floor(size / 2);
        // Copy 16-bit PCM samples
        const sampleData = new Int16Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          sampleData[i] = this.view.getInt16(this.offset + i * 2, true);
        }
        this.offset += size + (size % 2);
        return sampleData;
      }
      this.offset += size + (size % 2);
    }
    return new Int16Array(0);
  }

  private assemblePresets(
    rawPhdr: Uint8Array,
    rawPbag: Uint8Array,
    rawPgen: Uint8Array,
    rawInst: Uint8Array,
    rawIbag: Uint8Array,
    rawIgen: Uint8Array,
    sampleHeaders: Sf2SampleHeader[],
    outPresets: Sf2Preset[],
  ): void {
    const phdrView = new DataView(rawPhdr.buffer, rawPhdr.byteOffset, rawPhdr.byteLength);
    const pbagView = new DataView(rawPbag.buffer, rawPbag.byteOffset, rawPbag.byteLength);
    const pgenView = new DataView(rawPgen.buffer, rawPgen.byteOffset, rawPgen.byteLength);
    const instView = new DataView(rawInst.buffer, rawInst.byteOffset, rawInst.byteLength);
    const ibagView = new DataView(rawIbag.buffer, rawIbag.byteOffset, rawIbag.byteLength);
    const igenView = new DataView(rawIgen.buffer, rawIgen.byteOffset, rawIgen.byteLength);

    const presetCount = Math.floor(rawPhdr.byteLength / 38) - 1; // Last is terminal EOP
    if (presetCount <= 0) return;

    for (let p = 0; p < presetCount; p++) {
      const pOffset = p * 38;
      const name = this.decodeFixedString(rawPhdr.subarray(pOffset, pOffset + 20));
      const presetNumber = phdrView.getUint16(pOffset + 20, true);
      const bankNumber = phdrView.getUint16(pOffset + 22, true);
      const pbagStart = phdrView.getUint16(pOffset + 24, true);
      const pbagEnd = phdrView.getUint16(pOffset + 38 + 24, true);

      const zones: Sf2Zone[] = [];

      for (let pb = pbagStart; pb < pbagEnd && pb * 4 + 4 <= rawPbag.byteLength; pb++) {
        const pgenStart = pbagView.getUint16(pb * 4, true);
        const pgenEnd = pbagView.getUint16((pb + 1) * 4, true);

        let instrumentId: number | null = null;
        let pKeyRange: [number, number] = [0, 127];
        let pVelRange: [number, number] = [0, 127];

        for (let pg = pgenStart; pg < pgenEnd && pg * 4 + 4 <= rawPgen.byteLength; pg++) {
          const genOper = pgenView.getUint16(pg * 4, true);
          const genVal = pgenView.getUint16(pg * 4 + 2, true);

          if (genOper === 41) {
            // instrument generator
            instrumentId = genVal;
          } else if (genOper === 43) {
            // key range
            pKeyRange = [genVal & 0xff, (genVal >> 8) & 0xff];
          } else if (genOper === 44) {
            // vel range
            pVelRange = [genVal & 0xff, (genVal >> 8) & 0xff];
          }
        }

        if (instrumentId !== null && instrumentId * 22 + 22 <= rawInst.byteLength) {
          // Resolve instrument
          const instOffset = instrumentId * 22;
          const ibagStart = instView.getUint16(instOffset + 20, true);
          const ibagEnd = instView.getUint16(instOffset + 22 + 20, true);

          for (let ib = ibagStart; ib < ibagEnd && ib * 4 + 4 <= rawIbag.byteLength; ib++) {
            const igenStart = ibagView.getUint16(ib * 4, true);
            const igenEnd = ibagView.getUint16((ib + 1) * 4, true);

            let sampleId: number | null = null;
            let iKeyRange: [number, number] = [0, 127];
            let iVelRange: [number, number] = [0, 127];
            let rootKey: number | undefined;
            let pitchCorrection: number | undefined;
            let pan: number | undefined;
            let attack: number | undefined;
            let release: number | undefined;
            let sampleModes: number | undefined;

            for (let ig = igenStart; ig < igenEnd && ig * 4 + 4 <= rawIgen.byteLength; ig++) {
              const op = igenView.getUint16(ig * 4, true);
              const val = igenView.getUint16(ig * 4 + 2, true);

              if (op === 53) sampleId = val;
              else if (op === 43) iKeyRange = [val & 0xff, (val >> 8) & 0xff];
              else if (op === 44) iVelRange = [val & 0xff, (val >> 8) & 0xff];
              else if (op === 58) rootKey = val;
              else if (op === 54) sampleModes = val;
              else if (op === 52) pitchCorrection = val > 32767 ? val - 65536 : val;
              else if (op === 17) pan = val > 32767 ? val - 65536 : val;
              else if (op === 34) attack = Math.pow(2, (val > 32767 ? val - 65536 : val) / 1200);
              else if (op === 38) release = Math.pow(2, (val > 32767 ? val - 65536 : val) / 1200);
            }

            if (sampleId !== null && sampleId < sampleHeaders.length) {
              const finalKeyMin = Math.max(pKeyRange[0], iKeyRange[0]);
              const finalKeyMax = Math.min(pKeyRange[1], iKeyRange[1]);
              const finalVelMin = Math.max(pVelRange[0], iVelRange[0]);
              const finalVelMax = Math.min(pVelRange[1], iVelRange[1]);

              if (finalKeyMin <= finalKeyMax && finalVelMin <= finalVelMax) {
                zones.push({
                  keyRange: [finalKeyMin, finalKeyMax],
                  velRange: [finalVelMin, finalVelMax],
                  sampleIndex: sampleId,
                  rootKey: rootKey ?? sampleHeaders[sampleId]?.originalPitch,
                  pitchCorrection: pitchCorrection ?? sampleHeaders[sampleId]?.pitchCorrection,
                  sampleModes,
                  pan,
                  attackSeconds: attack,
                  releaseSeconds: release,
                });
              }
            }
          }
        }
      }

      if (zones.length > 0) {
        outPresets.push({
          name: name || `Preset ${presetNumber}`,
          presetNumber,
          bankNumber,
          zones,
        });
      }
    }
  }

  private readFourCC(): string {
    const chars = [
      String.fromCharCode(this.bytes[this.offset]!),
      String.fromCharCode(this.bytes[this.offset + 1]!),
      String.fromCharCode(this.bytes[this.offset + 2]!),
      String.fromCharCode(this.bytes[this.offset + 3]!),
    ];
    this.offset += 4;
    return chars.join("");
  }

  private readUint32(): number {
    const val = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return val;
  }

  private decodeFixedString(bytes: Uint8Array): string {
    let len = 0;
    while (len < bytes.length && bytes[len] !== 0) {
      len++;
    }
    const decoder = new TextDecoder("ascii");
    return decoder.decode(bytes.subarray(0, len)).trim();
  }
}

/**
 * Convenience helper to parse an SF2 buffer into Sf2SoundFont.
 */
export function parseSf2(buffer: ArrayBuffer | Uint8Array): Sf2SoundFont {
  assertSf2FileSize(buffer.byteLength);
  try {
    return new Sf2Parser(buffer).parse();
  } catch (error) {
    throw asInvalidSoundFontError(error, "The file could not be parsed as an SF2 bank.");
  }
}

/** Converts parser and worker failures into a user-facing SoundFont error. */
function asInvalidSoundFontError(reason: unknown, fallback: string): InvalidSoundFontError {
  if (reason instanceof InvalidSoundFontError) return reason;
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : fallback;
  const cleanMessage = message.replace(/^Invalid SoundFont:\s*/i, "").trim();
  return new InvalidSoundFontError(cleanMessage || fallback);
}

/** Parses in a Worker and preserves input bytes by default. `transferInput: true` detaches an ArrayBuffer; Uint8Array inputs are copied into a plain transferable buffer. */
export function parseSf2Async(
  buffer: ArrayBuffer | Uint8Array,
  options: { transferInput?: boolean } = {},
): Promise<Sf2SoundFont> {
  let bytes: ArrayBuffer;
  try {
    assertSf2FileSize(buffer.byteLength);
    if (typeof Worker === "undefined") return Promise.resolve(parseSf2(buffer));
    if (buffer instanceof Uint8Array) {
      // `view.buffer` is typed as ArrayBufferLike and may be a SharedArrayBuffer.
      // Copy into a plain ArrayBuffer for Worker.postMessage's transfer list.
      const copy = new ArrayBuffer(buffer.byteLength);
      new Uint8Array(copy).set(buffer);
      bytes = copy;
    } else {
      bytes = options.transferInput ? buffer : buffer.slice(0);
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
      try {
        worker.terminate();
      } catch {
        // The worker may already have terminated after a runtime failure.
      }
      callback();
    };
    worker.onmessage = (event: MessageEvent<{ soundFont?: Omit<Sf2SoundFont, "rawSampleData">; rawSampleBuffer?: ArrayBuffer; error?: string }>) => {
      const data = event.data;
      if (!data || data.error || !data.soundFont || !data.rawSampleBuffer) {
        finish(() => reject(asInvalidSoundFontError(data?.error, "The parser worker returned incomplete data.")));
        return;
      }
      if (!(data.rawSampleBuffer instanceof ArrayBuffer)) {
        finish(() => reject(new InvalidSoundFontError("The parser worker returned invalid sample data.")));
        return;
      }
      try {
        const result: Sf2SoundFont = { ...data.soundFont, rawSampleData: new Int16Array(data.rawSampleBuffer) };
        finish(() => resolve(result));
      } catch (error) {
        finish(() => reject(asInvalidSoundFontError(error, "The parser worker returned invalid SoundFont data.")));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => reject(asInvalidSoundFontError(event.message, "The SoundFont parser worker failed.")));
    };
    worker.onmessageerror = () => {
      finish(() => reject(new InvalidSoundFontError("The SoundFont parser worker returned data that could not be decoded.")));
    };
    try {
      worker.postMessage({ buffer: bytes }, [bytes]);
    } catch (error) {
      finish(() => reject(asInvalidSoundFontError(error, "The SoundFont parser worker could not receive the file.")));
    }
  });
}
