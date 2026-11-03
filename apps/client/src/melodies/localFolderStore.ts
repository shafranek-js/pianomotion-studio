import {
  openProjectDb,
  SETTINGS_STORE,
  type PersistedSettingRecord,
} from "../storage/projectDb";

export const LOCAL_FOLDER_LIBRARY_STORAGE_KEY = "melodies.local_folder_library.v1";
const LOCAL_FOLDER_CACHE_KEY_PREFIX = `${LOCAL_FOLDER_LIBRARY_STORAGE_KEY}:cache:`;

export interface LocalFolderStoreAdapter {
  /** Loads metadata and all MIDI cache records for operations that need a full snapshot. */
  load(key: string): Promise<unknown | null>;
  /** Atomically saves metadata and all cache records. */
  save(key: string, value: unknown, signal?: AbortSignal): Promise<void>;
  /** Metadata-only methods keep library browsing from deserializing cached MIDI. */
  loadView?(key: string): Promise<unknown | null>;
  saveView?(key: string, value: unknown): Promise<void>;
  loadMidi?(key: string, entryId: string): Promise<unknown | null>;
}

interface SnapshotLike {
  canonicalMidiCache?: Record<string, { sha256: string; midiBytes: Uint8Array }>;
  [key: string]: unknown;
}

interface CacheRecordValue {
  entryId: string;
  sha256: string;
  midiBytes: Uint8Array;
}

function cacheKey(entryId: string): string {
  return `${LOCAL_FOLDER_CACHE_KEY_PREFIX}${encodeURIComponent(entryId)}`;
}

function metadataOnly(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const metadata = { ...(value as SnapshotLike) };
  delete metadata.canonicalMidiCache;
  return metadata;
}

function recordValue(record: unknown): unknown | null {
  if (record === undefined || record === null || typeof record !== "object") return null;
  return (record as PersistedSettingRecord).value ?? null;
}

function makeAbortError(): Error {
  const error = new Error("Local melody storage write cancelled.");
  error.name = "AbortError";
  return error;
}

function openDatabase(signal?: AbortSignal): Promise<IDBDatabase> {
  if (!signal) return openProjectDb();
  if (signal.aborted) return Promise.reject(makeAbortError());
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(makeAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void openProjectDb().then((db) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(db);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function transactionPromise<T>(
  operation: (store: IDBObjectStore, resolveValue: (value: T) => void, rejectValue: (error: unknown) => void) => void,
  mode: IDBTransactionMode,
  signal?: AbortSignal,
): Promise<T> {
  return openDatabase(signal).then((db) => new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    let settled = false;
    let result!: T;
    let hasResult = false;
    let transaction: IDBTransaction | null = null;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const done = (value: T) => {
      result = value;
      hasResult = true;
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
      try { transaction?.abort(); } catch { /* It may already be inactive or aborting. */ }
    };
    const onAbort = () => fail(makeAbortError());
    try {
      transaction = db.transaction(SETTINGS_STORE, mode);
    } catch (error) {
      fail(error);
      return;
    }
    transaction.oncomplete = () => {
      if (settled) return;
      if (!hasResult) {
        fail(new Error("Local melody settings transaction completed without a result."));
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    transaction.onerror = () => fail(transaction.error ?? new Error("Local melody settings transaction failed."));
    transaction.onabort = () => fail(transaction.error ?? new Error("Local melody settings transaction aborted."));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      operation(transaction.objectStore(SETTINGS_STORE), done, fail);
    } catch (error) {
      fail(error);
      try { transaction.abort(); } catch { /* The transaction may already be inactive. */ }
    }
  }));
}

function loadMetadata(key: string): Promise<unknown | null> {
  return transactionPromise<unknown | null>((store, setResult, fail) => {
    const request = store.get(key);
    request.onsuccess = () => setResult(recordValue(request.result));
    request.onerror = () => fail(request.error ?? new Error(`Could not load local melody metadata from "${key}".`));
  }, "readonly");
}

function loadFullSnapshot(key: string): Promise<unknown | null> {
  return transactionPromise<unknown | null>((store, setResult, fail) => {
    let metadataLoaded = false;
    let metadataValue: unknown | null = null;
    let cacheLoaded = false;
    const cache: Record<string, CacheRecordValue> = {};
    const maybeFinish = () => {
      if (!metadataLoaded || !cacheLoaded) return;
      if (metadataValue === null) {
        setResult(null);
        return;
      }
      // Read older monolithic snapshots once and keep their cache usable until a
      // successful rescan migrates them to separate settings records.
      const legacyCache = (metadataValue as SnapshotLike | null)?.canonicalMidiCache;
      if (legacyCache && typeof legacyCache === "object") {
        for (const [entryId, entry] of Object.entries(legacyCache)) {
          if (entry && typeof entry.sha256 === "string" && entry.midiBytes instanceof Uint8Array && !cache[entryId]) {
            cache[entryId] = { entryId, sha256: entry.sha256, midiBytes: entry.midiBytes };
          }
        }
      }
      setResult({ ...(metadataOnly(metadataValue) as Record<string, unknown>), canonicalMidiCache: Object.fromEntries(
        Object.entries(cache).map(([entryId, entry]) => [entryId, { sha256: entry.sha256, midiBytes: entry.midiBytes }]),
      ) });
    };
    const metadataRequest = store.get(key);
    metadataRequest.onsuccess = () => {
      metadataValue = recordValue(metadataRequest.result);
      metadataLoaded = true;
      maybeFinish();
    };
    metadataRequest.onerror = () => fail(metadataRequest.error ?? new Error(`Could not load local melody snapshot from "${key}".`));

    try {
      const range = IDBKeyRange.bound(LOCAL_FOLDER_CACHE_KEY_PREFIX, `${LOCAL_FOLDER_CACHE_KEY_PREFIX}\uffff`);
      const cursorRequest = store.openCursor(range);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          cacheLoaded = true;
          maybeFinish();
          return;
        }
        const record = cursor.value as PersistedSettingRecord;
        const value = record.value as Partial<CacheRecordValue> | undefined;
        if (value && typeof value.entryId === "string" && typeof value.sha256 === "string" && value.midiBytes instanceof Uint8Array) {
          cache[value.entryId] = { entryId: value.entryId, sha256: value.sha256, midiBytes: value.midiBytes };
        }
        cursor.continue();
      };
      cursorRequest.onerror = () => fail(cursorRequest.error ?? new Error("Could not iterate local melody cache records."));
    } catch (error) {
      fail(error);
    }
  }, "readonly");
}

function loadMidi(key: string, entryId: string): Promise<unknown | null> {
  return transactionPromise<unknown | null>((store, setResult, fail) => {
    const request = store.get(cacheKey(entryId));
    request.onsuccess = () => {
      const value = recordValue(request.result) as CacheRecordValue | null;
      if (value && value.entryId === entryId) {
        setResult({ sha256: value.sha256, midiBytes: value.midiBytes });
        return;
      }
      // Compatibility path for a not-yet-migrated monolithic v1 record.
      const metadataRequest = store.get(key);
      metadataRequest.onsuccess = () => {
        const legacy = (recordValue(metadataRequest.result) as SnapshotLike | null)?.canonicalMidiCache?.[entryId];
        setResult(legacy ?? null);
      };
      metadataRequest.onerror = () => fail(metadataRequest.error ?? new Error(`Could not load MIDI cache for "${entryId}".`));
    };
    request.onerror = () => fail(request.error ?? new Error(`Could not load MIDI cache for "${entryId}".`));
  }, "readonly");
}

function saveMetadata(key: string, value: unknown): Promise<void> {
  return transactionPromise<void>((store, setResult, fail) => {
    const oldRequest = store.get(key);
    oldRequest.onsuccess = () => {
      try {
        const oldValue = recordValue(oldRequest.result) as SnapshotLike | null;
        const legacyCache = oldValue?.canonicalMidiCache;
        if (legacyCache && typeof legacyCache === "object") {
          for (const [entryId, entry] of Object.entries(legacyCache)) {
            if (!entry || typeof entry.sha256 !== "string" || !(entry.midiBytes instanceof Uint8Array)) continue;
            store.put({
              key: cacheKey(entryId),
              value: { entryId, sha256: entry.sha256, midiBytes: entry.midiBytes } satisfies CacheRecordValue,
              updatedAt: Date.now(),
            } satisfies PersistedSettingRecord);
          }
        }
        const request = store.put({ key, value: metadataOnly(value), updatedAt: Date.now() } satisfies PersistedSettingRecord);
        request.onerror = () => fail(request.error ?? new Error(`Could not save local melody metadata to "${key}".`));
        setResult(undefined);
      } catch (error) {
        fail(error);
      }
    };
    oldRequest.onerror = () => fail(oldRequest.error ?? new Error(`Could not load local melody metadata from "${key}" before saving.`));
  }, "readwrite");
}

function saveFullSnapshot(key: string, value: unknown, signal?: AbortSignal): Promise<void> {
  const snapshot = value as SnapshotLike;
  const canonicalMidiCache = snapshot.canonicalMidiCache ?? {};
  return transactionPromise<void>((store, setResult, fail) => {
    const keysRequest = store.getAllKeys();
    keysRequest.onerror = () => fail(keysRequest.error ?? new Error("Could not list existing local melody cache records."));
    keysRequest.onsuccess = () => {
      try {
        for (const oldKey of keysRequest.result) {
          if (typeof oldKey === "string" && oldKey.startsWith(LOCAL_FOLDER_CACHE_KEY_PREFIX)) store.delete(oldKey);
        }
        const metadataRequest = store.put({ key, value: metadataOnly(value), updatedAt: Date.now() } satisfies PersistedSettingRecord);
        metadataRequest.onerror = () => fail(metadataRequest.error ?? new Error("Could not save local melody metadata."));
        for (const [entryId, entry] of Object.entries(canonicalMidiCache)) {
          const cacheRecord: CacheRecordValue = { entryId, sha256: entry.sha256, midiBytes: entry.midiBytes };
          const request = store.put({ key: cacheKey(entryId), value: cacheRecord, updatedAt: Date.now() } satisfies PersistedSettingRecord);
          request.onerror = () => fail(request.error ?? new Error(`Could not save canonical MIDI for "${entryId}".`));
        }
        setResult(undefined);
      } catch (error) {
        fail(error);
      }
    };
  }, "readwrite", signal);
}

const indexedDbSettingsAdapter: LocalFolderStoreAdapter = {
  load: loadFullSnapshot,
  save: saveFullSnapshot,
  loadView: loadMetadata,
  saveView: saveMetadata,
  loadMidi,
};

/**
 * Stores metadata and each canonical MIDI cache as settings records in one
 * existing IndexedDB object store. A rescan updates/deletes those records in a
 * single transaction, so quota or request failures roll back the full snapshot.
 */
export class LocalFolderStore<TSnapshot> {
  private readonly adapter: LocalFolderStoreAdapter;

  constructor(adapter: LocalFolderStoreAdapter = indexedDbSettingsAdapter) {
    this.adapter = adapter;
  }

  async loadSnapshot(): Promise<TSnapshot | null> {
    return (await this.adapter.load(LOCAL_FOLDER_LIBRARY_STORAGE_KEY)) as TSnapshot | null;
  }

  async loadLibraryView(): Promise<unknown | null> {
    if (this.adapter.loadView) return this.adapter.loadView(LOCAL_FOLDER_LIBRARY_STORAGE_KEY);
    return this.adapter.load(LOCAL_FOLDER_LIBRARY_STORAGE_KEY);
  }

  async loadMidiCache(entryId: string): Promise<unknown | null> {
    if (this.adapter.loadMidi) return this.adapter.loadMidi(LOCAL_FOLDER_LIBRARY_STORAGE_KEY, entryId);
    const snapshot = await this.adapter.load(LOCAL_FOLDER_LIBRARY_STORAGE_KEY) as SnapshotLike | null;
    return snapshot?.canonicalMidiCache?.[entryId] ?? null;
  }

  async saveSnapshot(snapshot: TSnapshot, signal?: AbortSignal): Promise<void> {
    await this.adapter.save(LOCAL_FOLDER_LIBRARY_STORAGE_KEY, snapshot, signal);
  }

  async saveLibraryView(view: unknown): Promise<void> {
    if (this.adapter.saveView) {
      await this.adapter.saveView(LOCAL_FOLDER_LIBRARY_STORAGE_KEY, view);
      return;
    }
    const existing = await this.adapter.load(LOCAL_FOLDER_LIBRARY_STORAGE_KEY) as SnapshotLike | null;
    const currentCache = existing?.canonicalMidiCache ?? {};
    await this.adapter.save(LOCAL_FOLDER_LIBRARY_STORAGE_KEY, {
      ...(view as Record<string, unknown>),
      canonicalMidiCache: currentCache,
    });
  }
}

export const localFolderStore = new LocalFolderStore<unknown>();
