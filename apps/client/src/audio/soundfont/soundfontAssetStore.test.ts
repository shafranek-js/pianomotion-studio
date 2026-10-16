import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeSoundFontDb,
  computeSha256Hex,
  deleteSoundFontAsset,
  listSoundFontAssets,
  loadSoundFontAsset,
  saveSoundFontAsset,
  setSoundFontIdbFactory,
  SOUNDFONT_BLOB_STORE_NAME,
  SOUNDFONT_METADATA_STORE_NAME,
  SOUNDFONT_STORE_NAME,
  type SoundFontAssetMetadata,
} from "./soundfontAssetStore.ts";
import { createSyntheticMonoSf2 } from "./testing/syntheticMonoSf2.ts";

type CursorValue = { value: unknown; primaryKey: string; continue: () => void; delete: () => unknown };
type MemoryTransactionState = {
  mode?: IDBTransactionMode;
  active: boolean;
  finished: boolean;
  abortScheduled: boolean;
  cursorCount: number;
  oncomplete: (() => void) | null;
  onerror: ((event: Event) => void) | null;
  onabort: (() => void) | null;
  error: DOMException | null;
  abort: () => void;
  complete: () => void;
  snapshot: Map<MemoryStore, Map<string, unknown>>;
};

class MemoryStore {
  records = new Map<string, unknown>();

  constructor(private readonly owner: MemoryDatabase) {}

  put(value: { id: string }, tx?: MemoryTransactionState): { onsuccess: (() => void) | null; onerror: null } {
    this.records.set(value.id, value);
    const request = { onsuccess: null as (() => void) | null, onerror: null };
    if (tx) this.owner.writeRequested(tx);
    setTimeout(() => request.onsuccess?.(), 0);
    return request;
  }

  get(id: string): { result: unknown; onsuccess: (() => void) | null; onerror: null } {
    const request = { result: this.records.get(id), onsuccess: null as (() => void) | null, onerror: null };
    setTimeout(() => request.onsuccess?.(), 0);
    return request;
  }

  delete(id: string, tx?: MemoryTransactionState): { onsuccess: (() => void) | null; onerror: null } {
    this.records.delete(id);
    const request = { onsuccess: null as (() => void) | null, onerror: null };
    if (tx) this.owner.writeRequested(tx);
    setTimeout(() => request.onsuccess?.(), 0);
    return request;
  }

  openCursor(tx: MemoryTransactionState): { result: CursorValue | null; onsuccess: (() => void) | null; onerror: null } {
    const entries = Array.from(this.records.entries());
    const request = { result: null as CursorValue | null, onsuccess: null as (() => void) | null, onerror: null };
    let index = 0;
    const advance = () => {
      if (index >= entries.length) {
        request.result = null;
        request.onsuccess?.();
        this.owner.cursorFinished(tx);
        return;
      }
      const [key, value] = entries[index++]!;
      request.result = {
        value,
        primaryKey: key,
        continue: () => setTimeout(advance, 0),
        delete: () => {
          this.records.delete(key);
          return { onsuccess: null, onerror: null };
        },
      };
      request.onsuccess?.();
    };
    this.owner.cursorStarted(tx);
    setTimeout(advance, 0);
    return request;
  }
}

class MemoryDatabase {
  stores = new Map<string, MemoryStore>();
  abortNextWrite = false;
  abortNextWriteWithoutError = false;
  requestErrorNextWrite: DOMException | null = null;

  get objectStoreNames() {
    return { contains: (name: string) => this.stores.has(name) };
  }

  createObjectStore(name: string): MemoryStore {
    const store = new MemoryStore(this);
    this.stores.set(name, store);
    return store;
  }

  transaction(names: string[], mode?: IDBTransactionMode): IDBTransaction {
    const selected = names.map((name) => this.stores.get(name)!).filter(Boolean);
    const tx = {
      mode,
      active: true,
      finished: false,
      abortScheduled: false,
      cursorCount: 0,
      oncomplete: null as (() => void) | null,
      onerror: null as ((event: Event) => void) | null,
      onabort: null as (() => void) | null,
      error: null as DOMException | null,
      snapshot: new Map(selected.map((store) => [store, new Map(store.records)])),
      abort: () => {
        if (tx.finished) return;
        tx.active = false;
        tx.finished = true;
        for (const [store, snapshot] of tx.snapshot) store.records = snapshot;
        tx.error = this.abortNextWriteWithoutError
          ? null
          : new DOMException("Mock transaction aborted", "AbortError");
        this.abortNextWriteWithoutError = false;
        setTimeout(() => tx.onabort?.(), 0);
      },
      complete: () => {
        if (tx.finished || tx.cursorCount > 0) return;
        tx.finished = true;
        setTimeout(() => tx.oncomplete?.(), 0);
      },
    };
    const transaction = {
      objectStore: (name: string) => {
        const store = this.stores.get(name)!;
        return {
          put: (value: { id: string }) => store.put(value, tx),
          get: (id: string) => store.get(id),
          delete: (id: string) => store.delete(id, tx),
          openCursor: () => store.openCursor(tx),
        };
      },
      abort: tx.abort,
      get error() { return tx.error; },
      set oncomplete(value: (() => void) | null) { tx.oncomplete = value; },
      get oncomplete() { return tx.oncomplete; },
      set onerror(value: ((event: Event) => void) | null) { tx.onerror = value; },
      get onerror() { return tx.onerror; },
      set onabort(value: (() => void) | null) { tx.onabort = value; },
      get onabort() { return tx.onabort; },
    };
    return transaction as unknown as IDBTransaction;
  }

  cursorStarted(tx: MemoryTransactionState): void {
    if (!tx.finished) tx.cursorCount++;
  }

  cursorFinished(tx: MemoryTransactionState): void {
    if (!tx.finished && tx.cursorCount > 0) {
      tx.cursorCount--;
      tx.complete();
    }
  }

  writeRequested(tx: MemoryTransactionState): void {
    if (!tx.active || tx.finished || tx.mode !== "readwrite") return;
    if (this.requestErrorNextWrite && !tx.abortScheduled) {
      const requestError = this.requestErrorNextWrite;
      this.requestErrorNextWrite = null;
      tx.abortScheduled = true;
      setTimeout(() => {
        tx.onerror?.({ target: { error: requestError } } as unknown as Event);
        if (!tx.finished) tx.abort();
      }, 0);
    } else if (this.abortNextWrite && !tx.abortScheduled) {
      this.abortNextWrite = false;
      tx.abortScheduled = true;
      setTimeout(tx.abort, 0);
    } else if (!tx.abortScheduled) {
      tx.complete();
    }
  }

  close(): void {}
}

function createFactory(db: MemoryDatabase): IDBFactory {
  return {
    open: () => {
      const request = {
        result: db,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      };
      setTimeout(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

function makeLegacyRecord(id: string, bytes: Uint8Array): SoundFontAssetMetadata & { data: ArrayBuffer } {
  return {
    id,
    name: "Legacy bank.sf2",
    byteLength: bytes.byteLength,
    presetCount: 1,
    sampleCount: 1,
    uploadedAt: 10,
    data: bytes.slice().buffer,
  };
}

function blobFromBytes(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer]);
}

afterEach(() => {
  closeSoundFontDb();
  setSoundFontIdbFactory(null);
  vi.unstubAllGlobals();
});

describe("SoundFont Blob asset storage", () => {
  it("saves a Blob, lists metadata without PCM, loads a Blob, and deletes both rows", async () => {
    vi.stubGlobal("Worker", undefined);
    const db = new MemoryDatabase();
    setSoundFontIdbFactory(createFactory(db));
    const bytes = createSyntheticMonoSf2();
    const blob = blobFromBytes(bytes);

    const metadata = await saveSoundFontAsset("  Concert.sf2  ", blob);
    expect(metadata.name).toBe("Concert.sf2");
    expect(metadata.byteLength).toBe(blob.size);
    expect(db.stores.get(SOUNDFONT_METADATA_STORE_NAME)?.records.get(metadata.id)).not.toHaveProperty("data");

    const assets = await listSoundFontAssets();
    expect(assets).toContainEqual(metadata);
    const loaded = await loadSoundFontAsset(metadata.id);
    expect(loaded?.data).toBeInstanceOf(Blob);
    expect(new Uint8Array(await loaded!.data.arrayBuffer())).toEqual(bytes);

    await deleteSoundFontAsset(metadata.id);
    expect(await loadSoundFontAsset(metadata.id)).toBeNull();
    expect(db.stores.get(SOUNDFONT_BLOB_STORE_NAME)?.records.has(metadata.id)).toBe(false);
  });

  it("migrates legacy ArrayBuffer rows on first access while preserving the SHA id", async () => {
    vi.stubGlobal("Worker", undefined);
    const bytes = createSyntheticMonoSf2();
    const id = await computeSha256Hex(blobFromBytes(bytes));
    const db = new MemoryDatabase();
    const legacyStore = db.createObjectStore(SOUNDFONT_STORE_NAME);
    legacyStore.records.set(id, makeLegacyRecord(id, bytes));
    setSoundFontIdbFactory(createFactory(db));

    const [metadata] = await listSoundFontAssets();
    expect(metadata).toMatchObject({ id, name: "Legacy bank.sf2", byteLength: bytes.byteLength });
    expect(legacyStore.records.has(id)).toBe(false);
    const migrated = await loadSoundFontAsset(id);
    expect(migrated?.data).toBeInstanceOf(Blob);
    expect(new Uint8Array(await migrated!.data.arrayBuffer())).toEqual(bytes);
  });

  it("keeps the original v1 record when migration transaction aborts", async () => {
    vi.stubGlobal("Worker", undefined);
    const bytes = createSyntheticMonoSf2();
    const id = await computeSha256Hex(blobFromBytes(bytes));
    const db = new MemoryDatabase();
    const legacyStore = db.createObjectStore(SOUNDFONT_STORE_NAME);
    legacyStore.records.set(id, makeLegacyRecord(id, bytes));
    db.abortNextWrite = true;
    setSoundFontIdbFactory(createFactory(db));

    await expect(listSoundFontAssets()).rejects.toThrow(/abort/i);
    expect(legacyStore.records.has(id)).toBe(true);
    expect(db.stores.get(SOUNDFONT_BLOB_STORE_NAME)?.records.has(id)).toBe(false);
  });

  it("normalizes a transaction abort with no transaction.error to AbortError and preserves prior data", async () => {
    vi.stubGlobal("Worker", undefined);
    const db = new MemoryDatabase();
    setSoundFontIdbFactory(createFactory(db));
    const retainedBytes = createSyntheticMonoSf2();
    const retainedBlob = blobFromBytes(retainedBytes);
    const retained = await saveSoundFontAsset("retained.sf2", retainedBlob);

    db.abortNextWrite = true;
    db.abortNextWriteWithoutError = true;
    await expect(saveSoundFontAsset("aborted.sf2", blobFromBytes(createSyntheticMonoSf2({ frequency: 660 }))))
      .rejects.toMatchObject({ name: "AbortError" });

    const assets = await listSoundFontAssets();
    const loaded = await loadSoundFontAsset(retained.id);
    expect(assets.map((asset) => asset.id)).toEqual([retained.id]);
    expect(loaded?.data).toBeInstanceOf(Blob);
    expect(new Uint8Array(await loaded!.data.arrayBuffer())).toEqual(retainedBytes);
  });

  it("keeps the request AbortError when transaction.onerror precedes abort with no transaction.error", async () => {
    vi.stubGlobal("Worker", undefined);
    const db = new MemoryDatabase();
    setSoundFontIdbFactory(createFactory(db));
    const retained = await saveSoundFontAsset("retained.sf2", blobFromBytes(createSyntheticMonoSf2()));

    db.abortNextWriteWithoutError = true;
    db.requestErrorNextWrite = new DOMException("Request was aborted", "AbortError");
    await expect(saveSoundFontAsset("aborted.sf2", blobFromBytes(createSyntheticMonoSf2({ frequency: 660 }))))
      .rejects.toMatchObject({ name: "AbortError" });

    expect((await listSoundFontAssets()).map((asset) => asset.id)).toEqual([retained.id]);
  });

  it("preserves a request storage error when transaction.onerror precedes abort", async () => {
    vi.stubGlobal("Worker", undefined);
    const db = new MemoryDatabase();
    setSoundFontIdbFactory(createFactory(db));
    db.abortNextWriteWithoutError = true;
    db.requestErrorNextWrite = new DOMException("Storage quota exceeded", "QuotaExceededError");

    await expect(saveSoundFontAsset("quota.sf2", blobFromBytes(createSyntheticMonoSf2())))
      .rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  it("streams hash chunks and rejects cancellation between chunks", async () => {
    vi.stubGlobal("Worker", undefined);
    const controller = new AbortController();
    const blob = new Blob([new ArrayBuffer(4 * 1024 * 1024 + 12)]);
    await expect(computeSha256Hex(blob, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === "hashing" && progress.loadedBytes > 0) controller.abort();
      },
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
