import { assertSf2FileSize, InvalidSoundFontError, MAX_SF2_FILE_BYTES, parseSf2Async } from "./sf2Parser";
import type { Sf2SoundFont } from "./types";

export interface SoundFontAssetMetadata {
  id: string; // SHA-256 hex hash
  name: string;
  byteLength: number;
  presetCount: number;
  sampleCount: number;
  uploadedAt: number;
}

export interface StoredSoundFontAsset extends SoundFontAssetMetadata {
  data: ArrayBuffer;
}

export const SOUNDFONT_DB_NAME = "handthesia_soundfonts";
export const SOUNDFONT_STORE_NAME = "assets";
const SOUNDFONT_DB_VERSION = 1;

let customIdbFactory: IDBFactory | null = null;
let dbInstance: IDBDatabase | null = null;

export function setSoundFontIdbFactory(factory: IDBFactory | null): void {
  customIdbFactory = factory;
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function getIdbFactory(): IDBFactory {
  if (customIdbFactory) {
    return customIdbFactory;
  }
  if (typeof indexedDB !== "undefined") {
    return indexedDB;
  }
  if (typeof window !== "undefined" && window.indexedDB) {
    return window.indexedDB;
  }
  throw new Error("IndexedDB is not available in the current runtime environment.");
}

export function openSoundFontDb(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  const factory = getIdbFactory();

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(SOUNDFONT_DB_NAME, SOUNDFONT_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SOUNDFONT_STORE_NAME)) {
        db.createObjectStore(SOUNDFONT_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      dbInstance = db;
      db.onversionchange = () => {
        db.close();
        dbInstance = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open soundfont database."));
    };
  });
}

export function closeSoundFontDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Computes SHA-256 hex digest of binary buffer.
 */
export async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("Web Crypto SHA-256 is unavailable; SoundFont assets require a secure context.");
}

/**
 * Validates, parses, and saves an SF2 soundfont file into IndexedDB.
 * Returns metadata with computed content hash id without bloating project state.
 */
export async function saveSoundFontAsset(name: string, buffer: ArrayBuffer): Promise<SoundFontAssetMetadata> {
  // Enforce the upload limit before starting a worker or hashing the full bank.
  if (buffer.byteLength > MAX_SF2_FILE_BYTES) {
    throw new InvalidSoundFontError(`File exceeds the ${MAX_SF2_FILE_BYTES / (1024 * 1024)} MiB SoundFont limit.`);
  }

  // Validate that buffer contains a valid SF2 structure off the main thread.
  let parsed: Sf2SoundFont;
  try {
    assertSf2FileSize(buffer.byteLength);
    // The default parser mode preserves the caller's bytes for hashing and storage.
    parsed = await parseSf2Async(buffer);
  } catch (err: unknown) {
    if (err instanceof InvalidSoundFontError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidSoundFontError(`Failed to parse SF2 file '${name}': ${msg}`);
  }

  const id = await computeSha256Hex(buffer);
  const metadata: SoundFontAssetMetadata = {
    id,
    name: name.trim() || parsed.header.name || "Custom SoundFont",
    byteLength: buffer.byteLength,
    presetCount: parsed.presets.length,
    sampleCount: parsed.samples.length,
    uploadedAt: Date.now(),
  };

  const stored: StoredSoundFontAsset = {
    ...metadata,
    data: buffer,
  };

  const db = await openSoundFontDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([SOUNDFONT_STORE_NAME], "readwrite");
    const store = tx.objectStore(SOUNDFONT_STORE_NAME);
    const req = store.put(stored);

    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    req.onerror = () => rejectOnce(req.error ?? new Error("Failed to store SoundFont asset."));
    tx.onerror = () => rejectOnce(tx.error ?? req.error ?? new Error("SoundFont store transaction failed."));
    tx.onabort = () => rejectOnce(tx.error ?? req.error ?? new Error("SoundFont store transaction was aborted."));
  });

  return metadata;
}

/**
 * Retrieves a stored SF2 asset by its content hash ID.
 */
export async function loadSoundFontAsset(id: string): Promise<StoredSoundFontAsset | null> {
  const db = await openSoundFontDb();
  return new Promise<StoredSoundFontAsset | null>((resolve, reject) => {
    const tx = db.transaction([SOUNDFONT_STORE_NAME], "readonly");
    const store = tx.objectStore(SOUNDFONT_STORE_NAME);
    const req = store.get(id);

    req.onsuccess = () => {
      const res = req.result as StoredSoundFontAsset | undefined;
      resolve(res ?? null);
    };
    req.onerror = () => reject(req.error ?? new Error("Failed to load SoundFont asset."));
  });
}

/**
 * Lists all stored SF2 asset descriptors (excluding large raw binary data).
 */
export async function listSoundFontAssets(): Promise<SoundFontAssetMetadata[]> {
  const db = await openSoundFontDb();
  return new Promise<SoundFontAssetMetadata[]>((resolve, reject) => {
    const tx = db.transaction([SOUNDFONT_STORE_NAME], "readonly");
    const store = tx.objectStore(SOUNDFONT_STORE_NAME);
    const req = store.openCursor();
    const results: SoundFontAssetMetadata[] = [];

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const val = cursor.value as StoredSoundFontAsset;
        results.push({
          id: val.id,
          name: val.name,
          byteLength: val.byteLength,
          presetCount: val.presetCount,
          sampleCount: val.sampleCount,
          uploadedAt: val.uploadedAt,
        });
        cursor.continue();
      } else {
        // Sort newest first
        results.sort((a, b) => b.uploadedAt - a.uploadedAt);
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error ?? new Error("Failed to list SoundFont assets."));
  });
}

/**
 * Deletes a stored SF2 asset by ID.
 */
export async function deleteSoundFontAsset(id: string): Promise<void> {
  const db = await openSoundFontDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([SOUNDFONT_STORE_NAME], "readwrite");
    const store = tx.objectStore(SOUNDFONT_STORE_NAME);
    const req = store.delete(id);

    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    req.onerror = () => rejectOnce(req.error ?? new Error("Failed to delete SoundFont asset."));
    tx.onerror = () => rejectOnce(tx.error ?? req.error ?? new Error("SoundFont delete transaction failed."));
    tx.onabort = () => rejectOnce(tx.error ?? req.error ?? new Error("SoundFont delete transaction was aborted."));
  });
}
