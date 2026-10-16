import { asInvalidSoundFontError, assertSf2FileSize, InvalidSoundFontError, parseSf2MetadataBuffer } from "./sf2Parser.ts";
import type { Sf2OperationOptions, Sf2Progress } from "./sf2Parser.ts";
import type { Sf2SoundFont } from "./types.ts";

interface BlobChunk {
  tag: string;
  offset: number;
  size: number;
  nextOffset: number;
  unpadded: boolean;
}

/** Maximum cumulative INFO and pdta bytes read into metadata memory. */
export const MAX_SF2_METADATA_BYTES = 16 * 1024 * 1024;
const OGG_MAX_PAGE_BYTES = 27 + 255 + 255 * 255;

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let index = 0; index < length; index++) result += String.fromCharCode(bytes[offset + index]!);
  return result;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

async function readRange(
  blob: Blob,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
  onRead: (length: number) => void,
): Promise<Uint8Array> {
  checkAbort(signal);
  const buffer = await blob.slice(start, end).arrayBuffer();
  checkAbort(signal);
  onRead(buffer.byteLength);
  return new Uint8Array(buffer);
}

function parseChunkHeader(
  bytes: Uint8Array,
  absoluteOffset: number,
  enclosingEnd: number,
  nextTag: string | undefined,
  allowUnpaddedList = false,
  allowUnpaddedSampleData = false,
): BlobChunk {
  if (bytes.byteLength !== 8) throw new InvalidSoundFontError("A chunk header is incomplete.");
  const tag = readAscii(bytes, 0, 4);
  const size = readU32(bytes, 4);
  const offset = absoluteOffset + 8;
  const dataEnd = offset + size;
  const paddedEnd = dataEnd + (size & 1);
  if (dataEnd > enclosingEnd) {
    throw new InvalidSoundFontError(`Chunk '${tag}' extends beyond its containing RIFF/LIST boundary.`);
  }
  const unpaddedList = allowUnpaddedList && tag === "LIST" && (size & 1) !== 0 &&
    (dataEnd === enclosingEnd || nextTag === "LIST");
  const unpaddedSampleData = allowUnpaddedSampleData && tag === "smpl" && (size & 1) !== 0 &&
    (dataEnd === enclosingEnd || nextTag === "sm24");
  const unpadded = unpaddedList || unpaddedSampleData;
  const nextOffset = unpadded ? dataEnd : paddedEnd;
  if (nextOffset > enclosingEnd) {
    throw new InvalidSoundFontError(`Chunk '${tag}' extends beyond its containing RIFF/LIST boundary.`);
  }
  return { tag, offset, size, nextOffset, unpadded };
}

async function peekTag(blob: Blob, offset: number, enclosingEnd: number, signal: AbortSignal | undefined, onRead: (length: number) => void): Promise<string | undefined> {
  if (offset + 4 > enclosingEnd) return undefined;
  return readAscii(await readRange(blob, offset, offset + 4, signal, onRead), 0, 4);
}

function makeChunk(tag: string, payload: Uint8Array): Uint8Array {
  const paddedSize = payload.byteLength + (payload.byteLength & 1);
  const result = new Uint8Array(8 + paddedSize);
  result.set(new TextEncoder().encode(tag), 0);
  new DataView(result.buffer).setUint32(4, payload.byteLength, true);
  result.set(payload, 8);
  return result;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  if (!Number.isSafeInteger(length) || length > 0xffffffff) throw new InvalidSoundFontError("SoundFont metadata exceeds the RIFF size limit.");
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function makeList(type: string, chunks: Uint8Array[]): Uint8Array {
  return makeChunk("LIST", concat([new TextEncoder().encode(type), ...chunks]));
}

function report(options: Sf2OperationOptions, progress: Sf2Progress): void {
  options.onProgress?.(progress);
}

/** Reads only RIFF/LIST headers, INFO/pdta tables, and the smpl signature. */
export async function parseSf2BlobMetadata(blob: Blob, options: Sf2OperationOptions = {}): Promise<Sf2SoundFont> {
  assertSf2FileSize(blob.size);
  checkAbort(options.signal);
  let bytesRead = 0;
  const noteRead = (length: number) => {
    bytesRead += length;
    report(options, { phase: "reading", loadedBytes: bytesRead, totalBytes: blob.size });
  };

  try {
    const riffHeader = await readRange(blob, 0, 12, options.signal, noteRead);
    if (readAscii(riffHeader, 0, 4) !== "RIFF") throw new InvalidSoundFontError(`Expected RIFF header, got '${readAscii(riffHeader, 0, 4)}'`);
    const riffSize = readU32(riffHeader, 4);
    const riffEnd = riffSize + 8;
    if (riffSize < 4 || riffEnd > blob.size) throw new InvalidSoundFontError("RIFF size extends beyond the file boundary.");
    if (readAscii(riffHeader, 8, 4) !== "sfbk") throw new InvalidSoundFontError(`Expected form type 'sfbk', got '${readAscii(riffHeader, 8, 4)}'`);

    let offset = 12;
    let infoChunk: Uint8Array | null = null;
    let pdtaChunk: Uint8Array | null = null;
    let sampleDataOffset = -1;
    let sampleCount = 0;
    let sampleDataByteLength = 0;
    let metadataBytes = 0;
    let sawInfo = false;
    let sawSdta = false;
    let sawPdta = false;
    let sawUnpaddedSf3Chunk = false;

    while (offset < riffEnd) {
      checkAbort(options.signal);
      if (riffEnd - offset < 8) throw new InvalidSoundFontError("RIFF ends with an incomplete chunk header.");
      const chunkHeader = await readRange(blob, offset, offset + 8, options.signal, noteRead);
      const declaredSize = readU32(chunkHeader, 4);
      const chunkDataEnd = offset + 8 + declaredSize;
      const chunkNextTag = declaredSize & 1 ? await peekTag(blob, chunkDataEnd, riffEnd, options.signal, noteRead) : undefined;
      const chunk = parseChunkHeader(chunkHeader, offset, riffEnd, chunkNextTag, true);
      if (chunk.tag === "LIST") {
        if (chunk.size < 4) throw new InvalidSoundFontError("LIST chunk is missing its list type.");
        const type = await readRange(blob, chunk.offset, chunk.offset + 4, options.signal, noteRead);
        const listType = readAscii(type, 0, 4);
        const listEnd = chunk.offset + chunk.size;
        if (chunk.unpadded) {
          if (listType !== "sdta") throw new InvalidSoundFontError(`LIST '${listType}' omits its RIFF padding byte; only an SF3 sdta list may use this form.`);
          sawUnpaddedSf3Chunk = true;
        }
        let childOffset = chunk.offset + 4;
        if (listType === "INFO" || listType === "pdta") {
          if (listType === "INFO" ? sawInfo : sawPdta) throw new InvalidSoundFontError(`The file contains more than one '${listType}' list.`);
          if (metadataBytes + chunk.size > MAX_SF2_METADATA_BYTES) {
            throw new InvalidSoundFontError(`INFO and pdta metadata exceeds the ${MAX_SF2_METADATA_BYTES / (1024 * 1024)} MiB metadata parser limit.`);
          }
          metadataBytes += chunk.size;
          if (listType === "INFO") sawInfo = true;
          else sawPdta = true;
        }
        if (listType === "sdta") {
          if (sawSdta) throw new InvalidSoundFontError("The file contains more than one 'sdta' list.");
          sawSdta = true;
        }
        while (childOffset < listEnd) {
          checkAbort(options.signal);
          if (listEnd - childOffset < 8) throw new InvalidSoundFontError(`LIST '${listType}' ends with an incomplete chunk header.`);
          const childHeader = await readRange(blob, childOffset, childOffset + 8, options.signal, noteRead);
          const childDeclaredSize = readU32(childHeader, 4);
          const childDataEnd = childOffset + 8 + childDeclaredSize;
          const childNextTag = childDeclaredSize & 1 ? await peekTag(blob, childDataEnd, listEnd, options.signal, noteRead) : undefined;
          const child = parseChunkHeader(childHeader, childOffset, listEnd, childNextTag, false, listType === "sdta");
          if (child.unpadded) sawUnpaddedSf3Chunk = true;
          if (listType === "sdta" && child.tag === "smpl") {
            if (sampleDataOffset >= 0) throw new InvalidSoundFontError("The sdta list contains more than one smpl sample-data chunk.");
            sampleDataOffset = child.offset;
            sampleDataByteLength = child.size;
            sampleCount = Math.floor(child.size / 2);
          }
          childOffset = child.nextOffset;
        }
        if (listType === "INFO" || listType === "pdta") {
          const fullList = await readRange(blob, offset, chunk.nextOffset, options.signal, noteRead);
          if (listType === "INFO") infoChunk = fullList;
          else pdtaChunk = fullList;
        }
      }
      offset = chunk.nextOffset;
    }

    if (sampleDataOffset < 0) throw new InvalidSoundFontError("The sdta list does not contain an embedded smpl PCM chunk.");
    const sampleData = makeList("sdta", [makeChunk("smpl", new Uint8Array(0))]);
    const parts: Uint8Array[] = [new TextEncoder().encode("sfbk")];
    if (infoChunk) parts.push(infoChunk);
    parts.push(sampleData);
    if (pdtaChunk) parts.push(pdtaChunk);
    const riffPayload = concat(parts);
    const pseudoRiff = new Uint8Array(8 + riffPayload.byteLength);
    pseudoRiff.set(new TextEncoder().encode("RIFF"), 0);
    new DataView(pseudoRiff.buffer).setUint32(4, riffPayload.byteLength, true);
    pseudoRiff.set(riffPayload, 8);

    checkAbort(options.signal);
    report(options, { phase: "parsing", loadedBytes: blob.size, totalBytes: blob.size });
    const result = parseSf2MetadataBuffer(pseudoRiff, { blob, sampleDataOffset, sampleCount, sampleDataByteLength });
    if (sawUnpaddedSf3Chunk && result.header.versionMajor !== 3) {
      throw new InvalidSoundFontError("An unpadded sdta LIST or smpl chunk is invalid in SF2; only an SF3 sdta list may omit its RIFF padding byte.");
    }
    for (const sample of result.samples) {
      if (!sample.compressed) continue;
      checkAbort(options.signal);
      const start = sampleDataOffset + (sample.compressedByteStart ?? -1);
      const rawEnd = sample.compressedByteEnd ?? -1;
      const candidateEnds = [rawEnd, rawEnd + 1]
        .filter((end) => end > (sample.compressedByteStart ?? -1) && end <= sampleDataByteLength)
        .map((end) => sampleDataOffset + end);
      if (start < sampleDataOffset || candidateEnds.length === 0) {
        throw new InvalidSoundFontError(`Sample '${sample.name}' has a compressed range outside the smpl chunk.`);
      }
      const metadata = await readOggVorbisMetadata(blob, start, candidateEnds, options.signal, noteRead);
      if (metadata.channels !== 1) {
        throw new InvalidSoundFontError(`Compressed sample '${sample.name}' must decode to one channel; got ${metadata.channels}.`);
      }
      if (metadata.sampleRate !== sample.sampleRate) {
        throw new InvalidSoundFontError(`Compressed sample '${sample.name}' declares ${sample.sampleRate} Hz but its Ogg stream uses ${metadata.sampleRate} Hz.`);
      }
      if (metadata.frameCount <= 0n || metadata.frameCount > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new InvalidSoundFontError(`Compressed sample '${sample.name}' has an invalid decoded frame count ${metadata.frameCount}.`);
      }
      const frameCount = Number(metadata.frameCount);
      if (sample.loopStart > sample.loopEnd || sample.loopEnd > frameCount) {
        throw new InvalidSoundFontError(`Compressed sample '${sample.name}' has loop bounds ${sample.loopStart}..${sample.loopEnd} outside ${frameCount} decoded frames.`);
      }
      sample.decodedFrameCount = frameCount;
      sample.compressedByteEnd = metadata.end - sampleDataOffset;
      sample.start = 0;
      sample.end = frameCount;
    }
    checkAbort(options.signal);
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw asInvalidSoundFontError(error, "The file could not be parsed as an SF2 bank.");
  }
}

interface OggVorbisMetadata {
  channels: number;
  sampleRate: number;
  frameCount: bigint;
  end: number;
}

/** Reads only the Ogg identification packet and last page for one SF3 sample. */
async function readOggVorbisMetadata(
  blob: Blob,
  start: number,
  endCandidates: number[],
  signal: AbortSignal | undefined,
  onRead: (length: number) => void,
): Promise<OggVorbisMetadata> {
  const firstHeader = await readRange(blob, start, start + 27, signal, onRead);
  if (readAscii(firstHeader, 0, 4) !== "OggS" || firstHeader[4] !== 0 || (firstHeader[5]! & 0x02) === 0) {
    throw new InvalidSoundFontError("A compressed sample does not begin with a valid Ogg beginning-of-stream page.");
  }
  const segmentCount = firstHeader[26]!;
  const streamSerial = readU32(firstHeader, 14);
  const lacing = await readRange(blob, start + 27, start + 27 + segmentCount, signal, onRead);
  let firstPacketBytes = 0;
  let packetComplete = false;
  for (const lace of lacing) {
    firstPacketBytes += lace;
    if (lace < 255) {
      packetComplete = true;
      break;
    }
  }
  if (!packetComplete || firstPacketBytes < 30) {
    throw new InvalidSoundFontError("The Ogg stream is missing a complete Vorbis identification packet.");
  }
  const identification = await readRange(blob, start + 27 + segmentCount, start + 27 + segmentCount + 30, signal, onRead);
  if (identification[0] !== 1 || readAscii(identification, 1, 6) !== "vorbis") {
    throw new InvalidSoundFontError("The compressed sample uses an unsupported encoding; only Ogg Vorbis is supported.");
  }
  const idView = new DataView(identification.buffer, identification.byteOffset, identification.byteLength);
  if (idView.getUint32(7, true) !== 0) throw new InvalidSoundFontError("The Ogg Vorbis identification header has an unsupported version.");
  const channels = identification[11]!;
  const sampleRate = idView.getUint32(12, true);

  // A single Ogg page is at most 65,307 bytes. Expand the tail window until
  // it contains the final EOS page, retaining at most one page in memory. The
  // RFC and MuseScore writer disagree about whether SHDR dwEnd includes the
  // last encoded byte, so accept only a candidate ending exactly at an EOS page.
  const maxEnd = Math.max(...endCandidates);
  const minStart = Math.min(...endCandidates);
  if (minStart - start < 27) throw new InvalidSoundFontError("A compressed sample is too short to contain an Ogg page.");
  const candidateSet = new Set(endCandidates);
  const maxTailBytes = Math.min(maxEnd - start, OGG_MAX_PAGE_BYTES);
  let tailBytes = Math.min(512, maxTailBytes);
  let frameCount: bigint | null = null;
  let resolvedEnd: number | null = null;
  while (tailBytes > 0) {
    checkAbort(signal);
    const tailStart = maxEnd - tailBytes;
    const tail = await readRange(blob, tailStart, maxEnd, signal, onRead);
    for (let offset = tail.byteLength - 27; offset >= 0; offset--) {
      if (readAscii(tail, offset, 4) !== "OggS" || tail[offset + 4] !== 0 || (tail[offset + 5]! & 0x04) === 0) continue;
      if (readU32(tail, offset + 14) !== streamSerial) continue;
      const segments = tail[offset + 26]!;
      if (offset + 27 + segments > tail.byteLength) continue;
      let bodyBytes = 0;
      for (let index = 0; index < segments; index++) bodyBytes += tail[offset + 27 + index]!;
      const pageEnd = tailStart + offset + 27 + segments + bodyBytes;
      if (!candidateSet.has(pageEnd)) continue;
      const granule = readU64(tail, offset + 6);
      if (granule !== 0xffff_ffff_ffff_ffffn) {
        frameCount = granule;
        resolvedEnd = pageEnd;
        break;
      }
    }
    if (frameCount !== null) break;
    if (tailBytes === maxTailBytes) break;
    tailBytes = Math.min(maxTailBytes, tailBytes * 2);
  }
  if (frameCount === null || resolvedEnd === null) throw new InvalidSoundFontError("The Ogg Vorbis stream has no valid final page with a decoded frame count at either SHDR boundary.");
  if (sampleRate < 3000 || sampleRate > 384000) throw new InvalidSoundFontError(`The Ogg Vorbis stream uses unsupported sample rate ${sampleRate}.`);
  return { channels, sampleRate, frameCount, end: resolvedEnd };
}
