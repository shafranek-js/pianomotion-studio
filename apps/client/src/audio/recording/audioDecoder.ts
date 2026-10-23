import {
  generateWaveformPeaks,
  PEAK_SLICE_SECONDS,
} from "./waveformGenerator.ts";

export const MAX_AUDIO_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MiB
export const MAX_AUDIO_DURATION_SECONDS = 20 * 60; // 20 minutes
export const MAX_DECODED_PCM_BYTES = 256 * 1024 * 1024; // 256 MiB of Float32 samples

export const SUPPORTED_AUDIO_EXTENSIONS = [".wav", ".mp3", ".ogg", ".flac"] as const;

export const SUPPORTED_AUDIO_MIME_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/mp3",
  "audio/mpeg",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
] as const;

/**
 * Decoded audio recording structure matching Desktop Hand-thesia audio sync engine.
 */
export interface DecodedAudioRecording {
  buffer: AudioBuffer;
  durationSeconds: number;
  sampleRate: number;
  numberOfChannels: number;
  filename?: string;
  peaks: Float32Array; // Precomputed 5ms peaks in range [0, 1]
}

/**
 * Checks whether an audio format is supported based on file name or MIME type.
 * Supports WAV, MP3, OGG, and FLAC.
 */
export function isAudioFormatSupported(filenameOrMime: string): boolean {
  if (!filenameOrMime || typeof filenameOrMime !== "string") {
    return false;
  }

  const normalized = filenameOrMime.trim().toLowerCase();

  for (const mime of SUPPORTED_AUDIO_MIME_TYPES) {
    if (normalized === mime || normalized.startsWith(`${mime};`)) {
      return true;
    }
  }

  // Also check if MIME matches generic audio pattern
  if (normalized.startsWith("audio/")) {
    const subtype = normalized.slice(6).split(";")[0]?.trim();
    if (subtype && ["wav", "x-wav", "wave", "vnd.wave", "mp3", "mpeg", "ogg", "flac", "x-flac"].includes(subtype)) {
      return true;
    }
  }

  // Check file extension
  for (const ext of SUPPORTED_AUDIO_EXTENSIONS) {
    if (normalized.endsWith(ext)) {
      return true;
    }
  }

  return false;
}

/**
 * Bytes held by the decoded Float32 PCM channels.
 */
export function decodedPcmBytes(buffer: Pick<AudioBuffer, "length" | "numberOfChannels">): number {
  return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

/**
 * Rejects decoded recordings that exceed the duration or decoded-PCM budget.
 * The compressed file size cap alone cannot bound the decoded allocation.
 */
export function assertDecodedAudioBudget(buffer: Pick<AudioBuffer, "duration" | "length" | "numberOfChannels">): void {
  if (!Number.isFinite(buffer.duration) || buffer.duration > MAX_AUDIO_DURATION_SECONDS) {
    throw new Error(
      `Audio recording exceeds maximum duration of ${MAX_AUDIO_DURATION_SECONDS / 60} minutes`,
    );
  }
  const bytes = decodedPcmBytes(buffer);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_DECODED_PCM_BYTES) {
    throw new Error(
      `Decoded audio PCM exceeds maximum size of ${MAX_DECODED_PCM_BYTES / (1024 * 1024)} MiB`,
    );
  }
}

/**
 * Decodes an external audio recording (WAV, MP3, OGG, FLAC) using the Web Audio API.
 * Rejects files larger than 100 MiB, empty buffers, and decoded PCM above the
 * duration/size budget. Precomputes 5ms peaks.
 */
export async function decodeAudioRecording(
  data: ArrayBuffer | File,
  audioContext: AudioContext,
): Promise<DecodedAudioRecording> {
  if (!data) {
    throw new Error("No audio data provided");
  }

  let filename: string | undefined;
  let rawBytes: ArrayBuffer;

  const isFileLike =
    (typeof File !== "undefined" && data instanceof File) ||
    (typeof Blob !== "undefined" && data instanceof Blob) ||
    (typeof data === "object" &&
      data !== null &&
      "size" in data &&
      typeof (data as { arrayBuffer?: unknown }).arrayBuffer === "function");

  if (isFileLike) {
    const fileObj = data as { name?: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };
    filename = fileObj.name;

    if (fileObj.size > MAX_AUDIO_FILE_SIZE_BYTES) {
      throw new Error(
        `Audio file exceeds maximum size of 100 MiB (received ${(fileObj.size / (1024 * 1024)).toFixed(1)} MiB)`,
      );
    }
    if (fileObj.size === 0) {
      throw new Error("Audio data is empty");
    }

    rawBytes = await fileObj.arrayBuffer();
  } else if (data instanceof ArrayBuffer) {
    if (data.byteLength > MAX_AUDIO_FILE_SIZE_BYTES) {
      throw new Error(
        `Audio file exceeds maximum size of 100 MiB (received ${(data.byteLength / (1024 * 1024)).toFixed(1)} MiB)`,
      );
    }
    if (data.byteLength === 0) {
      throw new Error("Audio data is empty");
    }

    rawBytes = data;
  } else {
    throw new Error("Unsupported data type; expected File or ArrayBuffer");
  }

  if (rawBytes.byteLength === 0) {
    throw new Error("Audio data is empty");
  }

  // decodeAudioData detaches the underlying buffer, so slice a copy to keep rawBytes intact
  const copy = rawBytes.slice(0);

  let buffer: AudioBuffer;
  try {
    buffer = await new Promise<AudioBuffer>((resolve, reject) => {
      const promise = audioContext.decodeAudioData(
        copy,
        (decoded) => resolve(decoded),
        (err) => reject(err ?? new Error("Failed to decode audio data")),
      );
      if (promise && typeof promise.then === "function") {
        promise.then(resolve, reject);
      }
    });
  } catch (err) {
    throw new Error(`Audio decoding failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  if (!buffer || buffer.length === 0 || buffer.duration === 0 || buffer.numberOfChannels === 0) {
    throw new Error("Decoded audio buffer is empty");
  }

  assertDecodedAudioBudget(buffer);

  const peaks = generateWaveformPeaks(buffer, PEAK_SLICE_SECONDS);

  return {
    buffer,
    durationSeconds: buffer.duration,
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    filename,
    peaks,
  };
}
