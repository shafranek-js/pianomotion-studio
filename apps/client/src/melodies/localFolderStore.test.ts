import { afterEach, describe, expect, it, vi } from "vitest";
import * as projectDb from "../storage/projectDb";
import { LocalFolderStore, LOCAL_FOLDER_LIBRARY_STORAGE_KEY } from "./localFolderStore";

interface TestRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

function createIndexedDbDouble(initial: TestRecord[] = []) {
  const records = new Map(initial.map((record) => [record.key, record]));
  let failCachePut = false;
  let failSyncCachePut = false;
  let getAllCalls = 0;

  const db = {
    transaction: () => {
      const before = new Map(records);
      let pending = 0;
      let finished = false;
      let txError: DOMException | Error | null = null;
      const tx = {
        error: null as DOMException | Error | null,
        oncomplete: null as (() => void) | null,
        onerror: null as ((event: unknown) => void) | null,
        onabort: null as ((event: unknown) => void) | null,
        objectStore: () => store,
        abort: () => abort(txError),
      };

      const abort = (error: DOMException | Error | null = null) => {
        if (finished) return;
        finished = true;
        txError = error;
        tx.error = error;
        records.clear();
        for (const [key, value] of before) records.set(key, value);
        setTimeout(() => {
          tx.onerror?.({ target: tx });
          tx.onabort?.({ target: tx });
        }, 0);
      };

      const scheduleComplete = () => {
        setTimeout(() => {
          if (finished || pending > 0) return;
          finished = true;
          tx.oncomplete?.();
        }, 0);
      };

      const request = <T>(work: () => T, fail = false): IDBRequest<T> => {
        const req = {
          result: undefined as T,
          error: null as DOMException | null,
          onsuccess: null as ((event: { target: IDBRequest<T> }) => void) | null,
          onerror: null as ((event: { target: IDBRequest<T> }) => void) | null,
        };
        pending += 1;
        setTimeout(() => {
          if (finished) return;
          if (fail) {
            req.error = new DOMException("Quota exceeded", "QuotaExceededError");
            req.onerror?.({ target: req as unknown as IDBRequest<T> });
            abort(req.error);
            return;
          }
          try {
            req.result = work();
            req.onsuccess?.({ target: req as unknown as IDBRequest<T> });
            pending -= 1;
            scheduleComplete();
          } catch (error) {
            abort(error instanceof Error ? error : new Error(String(error)));
          }
        }, 0);
        return req as unknown as IDBRequest<T>;
      };

      const store = {
        get: (key: IDBValidKey) => request(() => records.get(String(key))),
        getAll: () => {
          getAllCalls += 1;
          return request(() => Array.from(records.values()));
        },
        getAllKeys: () => request(() => Array.from(records.keys())),
        put: (record: TestRecord) => {
          const isCacheRecord = record.key.startsWith(`${LOCAL_FOLDER_LIBRARY_STORAGE_KEY}:cache:`);
          if (failSyncCachePut && isCacheRecord) {
            failSyncCachePut = false;
            throw new DOMException("Could not clone cached MIDI", "DataCloneError");
          }
          return request(() => {
            records.set(record.key, record);
            return record.key;
          }, failCachePut && isCacheRecord);
        },
        delete: (key: IDBValidKey) => request(() => records.delete(String(key))),
        openCursor: (range: IDBKeyRange) => {
          const matchingRecords = Array.from(records.entries())
            .filter(([key]) => key >= String(range.lower) && key <= String(range.upper));
          const req = {
            result: null as IDBCursorWithValue | null,
            error: null as DOMException | null,
            onsuccess: null as ((event: { target: IDBRequest<IDBCursorWithValue | null> }) => void) | null,
            onerror: null as ((event: { target: IDBRequest<IDBCursorWithValue | null> }) => void) | null,
          };
          pending += 1;
          let index = 0;
          const advance = () => setTimeout(() => {
            if (finished) return;
            const record = matchingRecords[index];
            if (!record) {
              req.result = null;
              req.onsuccess?.({ target: req as unknown as IDBRequest<IDBCursorWithValue | null> });
              pending -= 1;
              scheduleComplete();
              return;
            }
            req.result = {
              key: record[0],
              value: record[1],
              continue: () => { index += 1; advance(); },
            } as unknown as IDBCursorWithValue;
            req.onsuccess?.({ target: req as unknown as IDBRequest<IDBCursorWithValue | null> });
          }, 0);
          advance();
          return req as unknown as IDBRequest<IDBCursorWithValue | null>;
        },
      };
      scheduleComplete();
      return tx as unknown as IDBTransaction;
    },
  } as unknown as IDBDatabase;

  return {
    db,
    records,
    getAllCalls: () => getAllCalls,
    failNextCachePut: () => { failCachePut = true; },
    failNextCachePutSynchronously: () => { failSyncCachePut = true; },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local folder library settings-store persistence", () => {
  it("loads list metadata without MIDI and uses bounded reads for cache records", async () => {
    vi.stubGlobal("IDBKeyRange", { bound: (lower: string, upper: string) => ({ lower, upper }) });
    const entryId = "entry:source:test:song.mid";
    const metadata = {
      schemaVersion: 1,
      revision: 1,
      sources: [],
      entries: [],
      selectedSourceId: null,
      selectedEntryId: null,
    };
    const cache = { entryId, sha256: "a".repeat(64), midiBytes: Uint8Array.from([0x4d, 0x54, 0x68, 0x64]) };
    const idb = createIndexedDbDouble([
      { key: LOCAL_FOLDER_LIBRARY_STORAGE_KEY, value: metadata, updatedAt: 1 },
      { key: `${LOCAL_FOLDER_LIBRARY_STORAGE_KEY}:cache:${encodeURIComponent(entryId)}`, value: cache, updatedAt: 1 },
    ]);
    vi.spyOn(projectDb, "openProjectDb").mockResolvedValue(idb.db);
    const store = new LocalFolderStore<unknown>();

    await expect(store.loadLibraryView()).resolves.toEqual(metadata);
    expect(idb.getAllCalls()).toBe(0);
    await expect(store.loadMidiCache(entryId)).resolves.toEqual({ sha256: cache.sha256, midiBytes: cache.midiBytes });
    const full = await store.loadSnapshot() as { canonicalMidiCache: Record<string, { sha256: string; midiBytes: Uint8Array }> };
    expect(full.canonicalMidiCache[entryId]).toEqual({ sha256: cache.sha256, midiBytes: cache.midiBytes });
    expect(idb.getAllCalls()).toBe(0);
  });

  it("rolls back metadata and cache deletion together when a cache write exceeds quota", async () => {
    const entryId = "entry:source:old:old.mid";
    const oldMetadata = { schemaVersion: 1, revision: 1, entries: [], sources: [] };
    const oldCache = { entryId, sha256: "b".repeat(64), midiBytes: Uint8Array.from([0x4d, 0x54, 0x68, 0x64]) };
    const oldCacheKey = `${LOCAL_FOLDER_LIBRARY_STORAGE_KEY}:cache:${encodeURIComponent(entryId)}`;
    const idb = createIndexedDbDouble([
      { key: LOCAL_FOLDER_LIBRARY_STORAGE_KEY, value: oldMetadata, updatedAt: 1 },
      { key: oldCacheKey, value: oldCache, updatedAt: 1 },
    ]);
    vi.spyOn(projectDb, "openProjectDb").mockResolvedValue(idb.db);
    idb.failNextCachePut();
    const store = new LocalFolderStore<unknown>();

    await expect(store.saveSnapshot({
      schemaVersion: 1,
      revision: 2,
      sources: [],
      entries: [],
      selectedSourceId: null,
      selectedEntryId: null,
      canonicalMidiCache: {
        "entry:source:new:new.mid": {
          sha256: "c".repeat(64),
          midiBytes: Uint8Array.from([0x4d, 0x54, 0x68, 0x64]),
        },
      },
    })).rejects.toMatchObject({ name: "QuotaExceededError" });

    expect(idb.records.get(LOCAL_FOLDER_LIBRARY_STORAGE_KEY)?.value).toEqual(oldMetadata);
    expect(idb.records.get(oldCacheKey)?.value).toEqual(oldCache);
    expect(Array.from(idb.records.keys()).filter((key) => key.startsWith(`${LOCAL_FOLDER_LIBRARY_STORAGE_KEY}:cache:`))).toEqual([oldCacheKey]);
  });

  it("aborts and rolls back when a cached MIDI structured clone fails synchronously", async () => {
    const oldMetadata = { schemaVersion: 1, revision: 1, entries: [], sources: [] };
    const oldCache = {
      entryId: "entry:source:old:old.mid",
      sha256: "e".repeat(64),
      midiBytes: Uint8Array.from([0x4d, 0x54, 0x68, 0x64]),
    };
    const oldCacheKey = `${LOCAL_FOLDER_LIBRARY_STORAGE_KEY}:cache:${encodeURIComponent(oldCache.entryId)}`;
    const idb = createIndexedDbDouble([
      { key: LOCAL_FOLDER_LIBRARY_STORAGE_KEY, value: oldMetadata, updatedAt: 1 },
      { key: oldCacheKey, value: oldCache, updatedAt: 1 },
    ]);
    vi.spyOn(projectDb, "openProjectDb").mockResolvedValue(idb.db);
    idb.failNextCachePutSynchronously();
    const store = new LocalFolderStore<unknown>();

    await expect(store.saveSnapshot({
      schemaVersion: 1,
      revision: 2,
      sources: [],
      entries: [],
      selectedSourceId: null,
      selectedEntryId: null,
      canonicalMidiCache: {
        "entry:source:new:new.mid": {
          sha256: "f".repeat(64),
          midiBytes: Uint8Array.from([0x4d, 0x54, 0x68, 0x64]),
        },
      },
    })).rejects.toMatchObject({ name: "DataCloneError" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(idb.records.get(LOCAL_FOLDER_LIBRARY_STORAGE_KEY)?.value).toEqual(oldMetadata);
    expect(idb.records.get(oldCacheKey)?.value).toEqual(oldCache);
  });

  it("saves metadata-only selection changes without touching MIDI cache records", async () => {
    const oldMetadata = { schemaVersion: 1, revision: 1, sources: [], entries: [], selectedSourceId: null, selectedEntryId: null };
    const cacheRecord = {
      entryId: "entry:source:one:song.mid",
      sha256: "d".repeat(64),
      midiBytes: Uint8Array.from([0x4d, 0x54, 0x68, 0x64]),
    };
    const cacheKey = `${LOCAL_FOLDER_LIBRARY_STORAGE_KEY}:cache:${encodeURIComponent(cacheRecord.entryId)}`;
    const idb = createIndexedDbDouble([
      { key: LOCAL_FOLDER_LIBRARY_STORAGE_KEY, value: oldMetadata, updatedAt: 1 },
      { key: cacheKey, value: cacheRecord, updatedAt: 1 },
    ]);
    vi.spyOn(projectDb, "openProjectDb").mockResolvedValue(idb.db);
    const store = new LocalFolderStore<unknown>();
    const nextMetadata = { ...oldMetadata, revision: 2, selectedSourceId: "source:one" };

    await store.saveLibraryView(nextMetadata);

    expect(idb.records.get(LOCAL_FOLDER_LIBRARY_STORAGE_KEY)?.value).toEqual(nextMetadata);
    expect(idb.records.get(cacheKey)?.value).toEqual(cacheRecord);
  });
});
