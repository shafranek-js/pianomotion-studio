import { asInvalidSoundFontError, assertSf2FileSize, InvalidSoundFontError, parseSf2MetadataBuffer } from "./sf2Parser.ts";
import type { Sf2OperationOptions, Sf2Progress } from "./sf2Parser.ts";
import type { Sf2SoundFont } from "./types.ts";

interface BlobChunk {
  tag: string;
  offset: number;
  size: number;
}

/** Maximum cumulative INFO and pdta bytes read into metadata memory. */
export const MAX_SF2_METADATA_BYTES = 16 * 1024 * 1024;

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

function parseChunkHeader(bytes: Uint8Array, absoluteOffset: number, enclosingEnd: number): BlobChunk {
  if (bytes.byteLength !== 8) throw new InvalidSoundFontError("A chunk header is incomplete.");
  const tag = readAscii(bytes, 0, 4);
  const size = readU32(bytes, 4);
  const offset = absoluteOffset + 8;
  const dataEnd = offset + size;
  const paddedEnd = dataEnd + (size & 1);
  if (dataEnd > enclosingEnd || paddedEnd > enclosingEnd) {
    throw new InvalidSoundFontError(`Chunk '${tag}' extends beyond its containing RIFF/LIST boundary.`);
  }
  return { tag, offset, size };
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
    let metadataBytes = 0;
    let sawInfo = false;
    let sawSdta = false;
    let sawPdta = false;

    while (offset < riffEnd) {
      checkAbort(options.signal);
      if (riffEnd - offset < 8) throw new InvalidSoundFontError("RIFF ends with an incomplete chunk header.");
      const chunkHeader = await readRange(blob, offset, offset + 8, options.signal, noteRead);
      const chunk = parseChunkHeader(chunkHeader, offset, riffEnd);
      const paddedEnd = chunk.offset + chunk.size + (chunk.size & 1);
      if (chunk.tag === "LIST") {
        if (chunk.size < 4) throw new InvalidSoundFontError("LIST chunk is missing its list type.");
        const type = await readRange(blob, chunk.offset, chunk.offset + 4, options.signal, noteRead);
        const listType = readAscii(type, 0, 4);
        const listEnd = chunk.offset + chunk.size;
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
          const child = parseChunkHeader(childHeader, childOffset, listEnd);
          const childPaddedEnd = child.offset + child.size + (child.size & 1);
          if (listType === "sdta" && child.tag === "smpl") {
            if (sampleDataOffset >= 0) throw new InvalidSoundFontError("The sdta list contains more than one smpl PCM chunk.");
            if (child.size % 2 !== 0) throw new InvalidSoundFontError("Sample data must contain complete 16-bit PCM values.");
            if (child.size >= 4) {
              const signature = await readRange(blob, child.offset, child.offset + 4, options.signal, noteRead);
              if (readAscii(signature, 0, 4) === "OggS") {
                throw new InvalidSoundFontError("Ogg/Vorbis-compressed sample data (SF3) is not supported; choose an uncompressed PCM SF2 bank.");
              }
            }
            sampleDataOffset = child.offset;
            sampleCount = child.size / 2;
          }
          childOffset = childPaddedEnd;
        }
        if (listType === "INFO" || listType === "pdta") {
          const fullList = await readRange(blob, offset, paddedEnd, options.signal, noteRead);
          if (listType === "INFO") infoChunk = fullList;
          else pdtaChunk = fullList;
        }
      }
      offset = paddedEnd;
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
    const result = parseSf2MetadataBuffer(pseudoRiff, { blob, sampleDataOffset, sampleCount });
    checkAbort(options.signal);
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw asInvalidSoundFontError(error, "The file could not be parsed as an SF2 bank.");
  }
}
