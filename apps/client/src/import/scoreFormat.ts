import { getFileExtension } from "../storage/fileValidator";

export type ScoreFileFormat =
  | "midi"
  | "karaoke"
  | "musicxml"
  | "mxl"
  | "mscz"
  | "guitar-pro";

export const GUITAR_PRO_EXTENSIONS = [
  ".gtp",
  ".gp3",
  ".gp4",
  ".gp5",
  ".gpx",
  ".gp",
] as const;

export const MUSICXML_TEXT_EXTENSIONS = [".musicxml", ".xml"] as const;
export const MUSICXML_COMPRESSED_EXTENSIONS = [".mxl", ".mlx"] as const;
export const MUSESCORE_EXTENSIONS = [".mscz"] as const;
export const KARAOKE_EXTENSIONS = [".kar"] as const;
export const MIDI_BINARY_EXTENSIONS = [".mid", ".midi"] as const;

export function isZipBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

export function isSmfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x4d &&
    bytes[1] === 0x54 &&
    bytes[2] === 0x68 &&
    bytes[3] === 0x64
  );
}

export function isRiffRmidBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const isRiff =
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46;
  const isRmid =
    bytes[8] === 0x52 &&
    bytes[9] === 0x4d &&
    bytes[10] === 0x49 &&
    bytes[11] === 0x44;
  return isRiff && isRmid;
}

export function isXmlTextBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  let offset = 0;
  // UTF-8 BOM
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    offset = 3;
  } else if (
    bytes.byteLength >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    // UTF-16 BOM
    return true;
  }
  while (offset < bytes.byteLength && offset < 64) {
    const b = bytes[offset]!;
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
      offset++;
      continue;
    }
    return b === 0x3c; // '<'
  }
  return false;
}

/**
 * Determines the score format from filename extension and optional file bytes.
 */
export function detectScoreFileFormat(
  filename: string,
  inputBytes?: ArrayBuffer | Uint8Array,
): ScoreFileFormat | null {
  const ext = getFileExtension(filename);
  const bytes =
    inputBytes instanceof Uint8Array
      ? inputBytes
      : inputBytes
        ? new Uint8Array(inputBytes)
        : undefined;

  if (ext === ".kar") {
    return "karaoke";
  }

  if (ext === ".mid" || ext === ".midi") {
    if (bytes && isRiffRmidBytes(bytes)) {
      return "karaoke";
    }
    return "midi";
  }

  if ((GUITAR_PRO_EXTENSIONS as readonly string[]).includes(ext)) {
    return "guitar-pro";
  }

  if (ext === ".mscz") {
    return "mscz";
  }

  if (ext === ".mxl" || ext === ".mlx") {
    if (bytes && !isZipBytes(bytes) && isXmlTextBytes(bytes)) {
      return "musicxml";
    }
    return "mxl";
  }

  if (ext === ".musicxml" || ext === ".xml") {
    if (bytes && isZipBytes(bytes)) {
      return "mxl";
    }
    return "musicxml";
  }

  // Fallback inspection by magic bytes if extension was missing or non-standard
  if (bytes) {
    if (isRiffRmidBytes(bytes)) return "karaoke";
    if (isSmfBytes(bytes)) return "midi";
    if (isXmlTextBytes(bytes)) return "musicxml";
  }

  return null;
}
