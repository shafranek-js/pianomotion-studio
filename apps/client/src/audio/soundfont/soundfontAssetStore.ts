import { createSHA256 } from "hash-wasm";
import {
  assertSf2FileSize,
  InvalidSoundFontError,
  parseSf2Async,
  type Sf2OperationOptions,
  type Sf2Progress,
} from "./sf2Parser";
import type { Sf2SoundFont } from "./types";

export interface SoundFontAssetMetadata {
  id: string;
  name: string;
  byteLength: number;
  presetCount: number;
  sampleCount: number;
  uploadedAt: number;
}

export interface StoredSoundFontAsset extends SoundFontAssetMetadata {
  data: Blob;
}

interface LegacySoundFontAsset extends SoundFontAssetMetadata {
  data: ArrayBuffer | Blob;
}

interface SoundFontBlobRecord {
  id: string;
  data: Blob;
}

export const SOUNDFONT_DB_NAME = "handthesia_soundfonts";
/** Legacy v1 store retained only so its records can be migrated atomically. */
export const SOUNDFONT_STORE_NAME = "assets";
export const SOUNDFONT_METADATA_STORE_NAME = "asset-metadata";
export const SOUNDFONT_BLOB_STORE_NAME = "asset-blobs";
const SOUNDFONT_DB_VERSION = 2;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

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
  if (customIdbFactory) return customIdbFactory;
  if (typeof indexedDB !== "undefined") return indexedDB;
  if (typeof window !== "undefined" && window.indexedDB) return window.indexedDB;
  throw new Error("IndexedDB is not available in the current runtime environment.");
}

export function openSoundFontDb(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  const factory = getIdbFactory();
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(SOUNDFONT_DB_NAME, SOUNDFONT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SOUNDFONT_STORE_NAME)) db.createObjectStore(SOUNDFONT_STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SOUNDFONT_METADATA_STORE_NAME)) db.createObjectStore(SOUNDFONT_METADATA_STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SOUNDFONT_BLOB_STORE_NAME)) db.createObjectStore(SOUNDFONT_BLOB_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to open SoundFont database."));
    request.onblocked = () => reject(new Error("SoundFont storage upgrade is blocked by another open app tab. Close the other tab and try again."));
  });
}

export function closeSoundFontDb(): void {
  dbInstance?.close();
  dbInstance = null;
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

function asBlob(input: Blob | ArrayBuffer): Blob {
  return input instanceof Blob ? input : new Blob([input]);
}

function fileSize(input: Blob | ArrayBuffer): number {
  return input instanceof Blob ? input.size : input.byteLength;
}

function metadataFrom(value: SoundFontAssetMetadata): SoundFontAssetMetadata {
  return {
    id: value.id,
    name: value.name,
    byteLength: value.byteLength,
    presetCount: value.presetCount,
    sampleCount: value.sampleCount,
    uploadedAt: value.uploadedAt,
  };
}

function report(options: Sf2OperationOptions, progress: Sf2Progress): void {
  options.onProgress?.(progress);
}

function hashBlobInWorker(blob: Blob, options: Sf2OperationOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./sf2Hash.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      try { worker.terminate(); } catch { /* It may already have exited. */ }
      callback();
    };
    const abort = () => finish(() => reject(makeAbortError()));
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ digest?: string; progress?: Sf2Progress; error?: string }>) => {
      if (event.data?.progress) {
        options.onProgress?.(event.data.progress);
        return;
      }
      if (typeof event.data?.digest === "string" && /^[a-f0-9]{64}$/i.test(event.data.digest)) {
        finish(() => resolve(event.data!.digest!.toLowerCase()));
      } else {
        finish(() => reject(new Error(event.data?.error ?? "The hash worker returned an invalid SHA-256 digest.")));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => reject(new Error(event.message || "The SoundFont hash worker failed.")));
    };
    worker.onmessageerror = () => finish(() => reject(new Error("The SoundFont hash worker returned data that could not be decoded.")));
    try {
      worker.postMessage({ blob });
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

async function hashBlobInChunks(blob: Blob, options: Sf2OperationOptions): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  let loadedBytes = 0;
  while (loadedBytes < blob.size) {
    checkAbort(options.signal);
    const end = Math.min(blob.size, loadedBytes + HASH_CHUNK_BYTES);
    const chunk = new Uint8Array(await blob.slice(loadedBytes, end).arrayBuffer());
    checkAbort(options.signal);
    hasher.update(chunk);
    loadedBytes = end;
    report(options, { phase: "hashing", loadedBytes, totalBytes: blob.size });
  }
  return hasher.digest("hex").toLowerCase();
}

/** Computes a streaming SHA-256 digest without making a second full-bank buffer. */
export async function computeSha256Hex(input: Blob | ArrayBuffer, options: Sf2OperationOptions = {}): Promise<string> {
  const blob = asBlob(input);
  assertSf2FileSize(blob.size);
  checkAbort(options.signal);
  if (typeof Worker !== "undefined") return hashBlobInWorker(blob, options);
  return hashBlobInChunks(blob, options);
}

async function assertStorageCapacity(db: IDBDatabase, id: string, incomingBytes: number): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return;
  const tx = db.transaction([SOUNDFONT_BLOB_STORE_NAME], "readonly");
  const existing = await new Promise<boolean>((resolve, reject) => {
    const request = tx.objectStore(SOUNDFONT_BLOB_STORE_NAME).get(id);
    request.onsuccess = () => resolve(Boolean(request.result));
    request.onerror = () => reject(request.error ?? new Error("Could not inspect existing SoundFont storage."));
  });
  if (existing) return;
  const estimate = await navigator.storage.estimate();
  if (typeof estimate.quota === "number" && typeof estimate.usage === "number" && estimate.quota - estimate.usage < incomingBytes) {
    throw new DOMException("There is not enough browser storage available for this SoundFont.", "QuotaExceededError");
  }
}

function commitWrite(
  db: IDBDatabase,
  storeNames: string[],
  write: (transaction: IDBTransaction) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(storeNames, "readwrite");
      write(transaction);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    let transactionFailure: Error | null = null;
    const onAbortSignal = () => transaction.abort();
    signal?.addEventListener("abort", onAbortSignal, { once: true });
    const clearSignal = () => signal?.removeEventListener("abort", onAbortSignal);
    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      clearSignal();
      resolve();
    };
    transaction.onerror = (event) => {
      if (settled) return;
      const requestError = (event.target as (EventTarget & { error?: DOMException | null }) | null)?.error;
      transactionFailure ??= requestError ?? transaction.error ?? null;
      try { transaction.abort(); } catch { /* The transaction may already be aborting. */ }
    };
    transaction.onabort = () => {
      if (settled) return;
      settled = true;
      clearSignal();
      reject(transactionFailure ?? transaction.error ?? makeAbortError());
    };
  });
}

function legacyMetadata(value: LegacySoundFontAsset): SoundFontAssetMetadata {
  return metadataFrom(value);
}

/**
 * Version 1 stored metadata and ArrayBuffer PCM together. On first database
 * access, migrate records one at a time into separate stores. One transaction
 * covers the migration so a quota or IDB error restores every original record.
 */
async function migrateLegacyAssets(db: IDBDatabase): Promise<void> {
  if (!db.objectStoreNames.contains(SOUNDFONT_STORE_NAME)) return;
  const storeNames = [SOUNDFONT_STORE_NAME, SOUNDFONT_METADATA_STORE_NAME, SOUNDFONT_BLOB_STORE_NAME];
  await new Promise<void>((resolve, reject) => {
    let transaction: IDBTransaction;
    let migrationFailure: Error | null = null;
    try {
      transaction = db.transaction(storeNames, "readwrite");
      const legacyStore = transaction.objectStore(SOUNDFONT_STORE_NAME);
      const metadataStore = transaction.objectStore(SOUNDFONT_METADATA_STORE_NAME);
      const blobStore = transaction.objectStore(SOUNDFONT_BLOB_STORE_NAME);
      const fail = (reason: unknown) => {
        if (!migrationFailure) migrationFailure = reason instanceof Error ? reason : new Error(String(reason));
        try { transaction.abort(); } catch { /* The transaction may already be aborting. */ }
      };
      const cursorRequest = legacyStore.openCursor();
      cursorRequest.onerror = () => fail(cursorRequest.error ?? new Error("Could not read a legacy SoundFont record."));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const legacy = cursor.value as LegacySoundFontAsset;
        try {
          if (!legacy || typeof legacy.id !== "string" || !(legacy.data instanceof ArrayBuffer || legacy.data instanceof Blob)) {
            throw new Error("A legacy SoundFont record has invalid file data and could not be migrated.");
          }
          const blob = legacy.data instanceof Blob ? legacy.data : new Blob([legacy.data]);
          const metadataRequest = metadataStore.get(legacy.id);
          metadataRequest.onerror = () => fail(metadataRequest.error ?? new Error("Could not inspect migrated SoundFont metadata."));
          metadataRequest.onsuccess = () => {
            const blobRequest = blobStore.get(legacy.id);
            blobRequest.onerror = () => fail(blobRequest.error ?? new Error("Could not inspect migrated SoundFont PCM."));
            blobRequest.onsuccess = () => {
              try {
                if (!metadataRequest.result) {
                  const putMetadata = metadataStore.put(legacyMetadata(legacy));
                  putMetadata.onerror = () => fail(putMetadata.error ?? new Error("Could not migrate SoundFont metadata."));
                }
                if (!blobRequest.result) {
                  const putBlob = blobStore.put({ id: legacy.id, data: blob } satisfies SoundFontBlobRecord);
                  putBlob.onerror = () => fail(putBlob.error ?? new Error("Could not migrate SoundFont PCM."));
                }
                const deleteLegacy = cursor.delete();
                deleteLegacy.onerror = () => fail(deleteLegacy.error ?? new Error("Could not remove a migrated SoundFont record."));
                cursor.continue();
              } catch (error) {
                fail(error);
              }
            };
          };
        } catch (error) {
          fail(error);
        }
      };
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Legacy SoundFont migration failed."));
    transaction.onabort = () => reject(migrationFailure ?? transaction.error ?? new Error("Legacy SoundFont migration was aborted; original records were preserved."));
  });
}

/** Validates and saves an SF2 file, resolving only after both stores commit. */
export async function saveSoundFontAsset(
  name: string,
  input: Blob | ArrayBuffer,
  options: Sf2OperationOptions = {},
): Promise<SoundFontAssetMetadata> {
  const byteLength = fileSize(input);
  assertSf2FileSize(byteLength);
  checkAbort(options.signal);
  const blob = asBlob(input);

  let parsed: Sf2SoundFont;
  try {
    parsed = await parseSf2Async(blob, options);
  } catch (error) {
    if (isAbortError(error) || error instanceof InvalidSoundFontError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidSoundFontError(`Failed to parse SF2 file '${name}': ${message}`);
  }
  checkAbort(options.signal);
  const id = await computeSha256Hex(blob, options);
  checkAbort(options.signal);
  const metadata: SoundFontAssetMetadata = {
    id,
    name: name.trim() || parsed.header.name || "Custom SoundFont",
    byteLength,
    presetCount: parsed.presets.length,
    sampleCount: parsed.samples.filter((sample) => sample.name !== "EOS").length,
    uploadedAt: Date.now(),
  };

  const db = await openSoundFontDb();
  await assertStorageCapacity(db, id, byteLength);
  checkAbort(options.signal);
  report(options, { phase: "saving", loadedBytes: 0, totalBytes: byteLength });
  await commitWrite(db, [SOUNDFONT_METADATA_STORE_NAME, SOUNDFONT_BLOB_STORE_NAME], (transaction) => {
    transaction.objectStore(SOUNDFONT_METADATA_STORE_NAME).put(metadata);
    transaction.objectStore(SOUNDFONT_BLOB_STORE_NAME).put({ id, data: blob } satisfies SoundFontBlobRecord);
  }, options.signal);
  report(options, { phase: "saving", loadedBytes: byteLength, totalBytes: byteLength });
  return metadata;
}

/** Retrieves a migrated SF2 asset with PCM held in a Blob. */
export async function loadSoundFontAsset(id: string): Promise<StoredSoundFontAsset | null> {
  const db = await openSoundFontDb();
  await migrateLegacyAssets(db);
  return new Promise<StoredSoundFontAsset | null>((resolve, reject) => {
    const tx = db.transaction([SOUNDFONT_METADATA_STORE_NAME, SOUNDFONT_BLOB_STORE_NAME], "readonly");
    const metadataRequest = tx.objectStore(SOUNDFONT_METADATA_STORE_NAME).get(id);
    const blobRequest = tx.objectStore(SOUNDFONT_BLOB_STORE_NAME).get(id);
    let metadata: SoundFontAssetMetadata | undefined;
    let blobRecord: SoundFontBlobRecord | undefined;
    let metadataLoaded = false;
    let blobLoaded = false;
    const finish = () => {
      if (!metadataLoaded || !blobLoaded) return;
      if (!metadata || !blobRecord) resolve(null);
      else if (!(blobRecord.data instanceof Blob)) reject(new Error("Stored SoundFont PCM is not a Blob."));
      else resolve({ ...metadataFrom(metadata), data: blobRecord.data });
    };
    metadataRequest.onsuccess = () => { metadata = metadataRequest.result as SoundFontAssetMetadata | undefined; metadataLoaded = true; finish(); };
    blobRequest.onsuccess = () => { blobRecord = blobRequest.result as SoundFontBlobRecord | undefined; blobLoaded = true; finish(); };
    metadataRequest.onerror = () => reject(metadataRequest.error ?? new Error("Failed to load SoundFont metadata."));
    blobRequest.onerror = () => reject(blobRequest.error ?? new Error("Failed to load SoundFont PCM."));
  });
}

/** Lists metadata rows only; large PCM Blobs are never read by the cursor. */
export async function listSoundFontAssets(): Promise<SoundFontAssetMetadata[]> {
  const db = await openSoundFontDb();
  await migrateLegacyAssets(db);
  return new Promise<SoundFontAssetMetadata[]>((resolve, reject) => {
    const tx = db.transaction([SOUNDFONT_METADATA_STORE_NAME], "readonly");
    const request = tx.objectStore(SOUNDFONT_METADATA_STORE_NAME).openCursor();
    const results: SoundFontAssetMetadata[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        results.push(metadataFrom(cursor.value as SoundFontAssetMetadata));
        cursor.continue();
      } else {
        results.sort((a, b) => b.uploadedAt - a.uploadedAt);
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to list SoundFont assets."));
  });
}

/** Deletes metadata, Blob data and any old v1 record in one commit. */
export async function deleteSoundFontAsset(id: string): Promise<void> {
  const db = await openSoundFontDb();
  await commitWrite(db, [SOUNDFONT_METADATA_STORE_NAME, SOUNDFONT_BLOB_STORE_NAME, SOUNDFONT_STORE_NAME], (transaction) => {
    transaction.objectStore(SOUNDFONT_METADATA_STORE_NAME).delete(id);
    transaction.objectStore(SOUNDFONT_BLOB_STORE_NAME).delete(id);
    transaction.objectStore(SOUNDFONT_STORE_NAME).delete(id);
  });
}
