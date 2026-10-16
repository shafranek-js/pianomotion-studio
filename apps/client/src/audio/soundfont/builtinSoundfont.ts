import { releaseAssetUrl } from "../../pwa/urls";
import { computeSha256Hex } from "./soundfontAssetStore";

/** The content SHA is also the stable SoundFont asset ID used by export verification. */
export const BUILTIN_SOUNDFONT_ID = "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3";
export const BUILTIN_SOUNDFONT_SHA256 = BUILTIN_SOUNDFONT_ID;
export const BUILTIN_SOUNDFONT_NAME = "MuseScore General v0.2";
export const BUILTIN_SOUNDFONT_BYTE_LENGTH = 39_900_972;
export const BUILTIN_SOUNDFONT_ASSET_PATH = `soundfonts/musescore-general/${BUILTIN_SOUNDFONT_ID}.sf3`;

export interface BuiltinSoundFontAsset {
  id: string;
  name: string;
  data: Blob;
  byteLength: number;
}

export interface LoadBuiltinSoundFontOptions {
  signal?: AbortSignal;
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

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError();
}

/** Fetches the release-pinned bank into a Blob and verifies its length and SHA-256. */
export async function loadBuiltinSoundFont({ signal }: LoadBuiltinSoundFontOptions = {}): Promise<BuiltinSoundFontAsset> {
  checkAbort(signal);
  let response: Response;
  try {
    response = await fetch(releaseAssetUrl(BUILTIN_SOUNDFONT_ASSET_PATH), { signal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`Could not load the built-in SoundFont: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`Could not load the built-in SoundFont: release asset returned HTTP ${response.status}.`);
  }

  let data: Blob;
  try {
    data = await response.blob();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error("Could not load the built-in SoundFont: the response body could not be read.", { cause: error });
  }
  checkAbort(signal);
  if (data.size !== BUILTIN_SOUNDFONT_BYTE_LENGTH) {
    throw new Error("Could not load the built-in SoundFont: downloaded size does not match the release descriptor.");
  }

  const digest = await computeSha256Hex(data, { signal });
  checkAbort(signal);
  if (digest !== BUILTIN_SOUNDFONT_SHA256) {
    throw new Error("Could not load the built-in SoundFont: SHA-256 does not match the release descriptor.");
  }
  return {
    id: BUILTIN_SOUNDFONT_ID,
    name: BUILTIN_SOUNDFONT_NAME,
    data,
    byteLength: data.size,
  };
}
