import { validateScoreFile } from "../storage/fileValidator";
import { convertGuitarProBytesToMidi } from "./guitarProImporter";
import { normalizeMidiOrKarBytes } from "./karImporter";
import { convertMsczBytesToMidi } from "./msczImporter";
import { convertMusicXmlBytesToMidi } from "./musicXmlImporter";
import { detectScoreFileFormat, type ScoreFileFormat } from "./scoreFormat";

export interface ImportScoreFileOptions {
  onProgress?: (message: string) => void;
  trackIndices?: number[];
}

export interface ImportedScoreResult {
  midiBytes: ArrayBuffer;
  sourceFormat: ScoreFileFormat;
  title?: string;
  originalFilename: string;
}

/**
 * Converts any supported score buffer (`.mid`, `.midi`, `.kar`, `.musicxml`, `.xml`, `.mxl`, `.mlx`,
 * `.mscz`, `.gtp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`, `.gp`) into canonical Standard MIDI File bytes.
 */
export async function importScoreBytesToMidi(
  filename: string,
  inputBytes: ArrayBuffer | Uint8Array,
  options?: ImportScoreFileOptions,
): Promise<ImportedScoreResult> {
  const bytes =
    inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);

  if (bytes.byteLength === 0) {
    throw new Error(`File "${filename}" is empty (0 bytes).`);
  }

  const format = detectScoreFileFormat(filename, bytes);
  if (!format) {
    throw new Error(`Unsupported score format for "${filename}".`);
  }

  switch (format) {
    case "midi":
    case "karaoke": {
      options?.onProgress?.(`Reading ${filename}…`);
      const midiBytes = normalizeMidiOrKarBytes(bytes);
      return {
        midiBytes,
        sourceFormat: format,
        originalFilename: filename,
      };
    }

    case "musicxml":
    case "mxl": {
      options?.onProgress?.(`Converting MusicXML score ${filename}…`);
      const { midiBytes, score } = convertMusicXmlBytesToMidi(bytes);
      return {
        midiBytes,
        sourceFormat: format,
        title: score.title,
        originalFilename: filename,
      };
    }

    case "mscz": {
      options?.onProgress?.(`Converting MuseScore file ${filename}…`);
      const { midiBytes, score } = convertMsczBytesToMidi(bytes);
      return {
        midiBytes,
        sourceFormat: format,
        title: score.title,
        originalFilename: filename,
      };
    }

    case "guitar-pro": {
      options?.onProgress?.(`Converting Guitar Pro score ${filename}…`);
      const { midiBytes, score } = await convertGuitarProBytesToMidi(bytes, {
        trackIndices: options?.trackIndices,
      });
      return {
        midiBytes,
        sourceFormat: format,
        title: score.title,
        originalFilename: filename,
      };
    }
  }
}

/**
 * Validates and imports a user-selected `File` (or `Blob` with filename) into canonical SMF MIDI bytes.
 */
export async function importScoreFileToMidi(
  file: File | Blob,
  filename?: string,
  options?: ImportScoreFileOptions,
): Promise<ImportedScoreResult> {
  const resolvedName =
    filename ?? (file instanceof File ? file.name : "score.mid");
  const validated = validateScoreFile(file, resolvedName);
  if (!validated.valid) {
    throw new Error(validated.error);
  }

  options?.onProgress?.(`Reading ${validated.filename}…`);
  const rawBuffer = await file.arrayBuffer();
  return importScoreBytesToMidi(validated.filename, rawBuffer, options);
}
