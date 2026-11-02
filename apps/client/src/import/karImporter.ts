import { isRiffRmidBytes, isSmfBytes } from "./scoreFormat";

/**
 * Normalizes a `.kar` or `.mid` buffer into a canonical Standard MIDI File (SMF) ArrayBuffer.
 *
 * Handles:
 * - Standard SMF files starting with `MThd`
 * - RIFF-wrapped MIDI / Karaoke files (`RIFF....RMIDdata....MThd...`)
 * - Leading non-SMF prefix padding up to 512 bytes before `MThd`
 */
export function normalizeMidiOrKarBytes(input: ArrayBuffer | Uint8Array): ArrayBuffer {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 14) {
    throw new Error("MIDI/KAR file is too short to contain a valid MThd header.");
  }

  if (isSmfBytes(bytes)) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  // Search for MThd within the first 1024 bytes (covers RIFF RMID headers and custom prefixes)
  const searchLimit = Math.min(bytes.byteLength - 4, 1024);
  let mthdOffset = -1;
  for (let i = 0; i <= searchLimit; i++) {
    if (
      bytes[i] === 0x4d &&
      bytes[i + 1] === 0x54 &&
      bytes[i + 2] === 0x68 &&
      bytes[i + 3] === 0x64
    ) {
      mthdOffset = i;
      break;
    }
  }

  if (mthdOffset === -1) {
    throw new Error(
      isRiffRmidBytes(bytes)
        ? "RIFF RMID karaoke file does not contain an embedded MThd MIDI stream."
        : "Invalid MIDI/KAR file: missing MThd header.",
    );
  }

  // If wrapped in RIFF RMID ("data" chunk before MThd), respect the data chunk byte length if valid
  if (mthdOffset >= 8) {
    const isDataChunk =
      bytes[mthdOffset - 8] === 0x64 &&
      bytes[mthdOffset - 7] === 0x61 &&
      bytes[mthdOffset - 6] === 0x74 &&
      bytes[mthdOffset - 5] === 0x61;
    if (isDataChunk) {
      const dataLength =
        (bytes[mthdOffset - 4]! |
          (bytes[mthdOffset - 3]! << 8) |
          (bytes[mthdOffset - 2]! << 16) |
          (bytes[mthdOffset - 1]! << 24)) >>>
        0;
      const endOffset = Math.min(bytes.byteLength, mthdOffset + dataLength);
      if (endOffset > mthdOffset + 14) {
        return bytes.slice(mthdOffset, endOffset).buffer;
      }
    }
  }

  return bytes.slice(mthdOffset).buffer;
}
