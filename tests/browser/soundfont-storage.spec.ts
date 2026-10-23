import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createSyntheticMonoSf2 } from "../../apps/client/src/audio/soundfont/testing/syntheticMonoSf2";
import { loadStudioSong } from "./studio-helpers";

const SOUND_FONT_DB = "handthesia_soundfonts";
const LEGACY_STORE = "assets";
const METADATA_STORE = "asset-metadata";
const BLOB_STORE = "asset-blobs";

test("native IndexedDB v1 SoundFont records migrate atomically to Blob storage without changing selection", async ({ page }) => {
  await loadStudioSong(page);
  const bytes = createSyntheticMonoSf2();
  const bytesForPage = Array.from(bytes);
  const expectedId = createHash("sha256").update(bytes).digest("hex");

  const result = await page.evaluate(async ({ bankBytes, assetId, dbName, legacyStore, metadataStore, blobStore }) => {
    const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    });
    const transactionResult = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    });

    const settings = await import("/src/settings/settingsStore.ts");
    await settings.updateSettingsPersisted({ soundfontAssetId: assetId });
    const selectedBeforeMigration = settings.getSettings().soundfontAssetId;

    const openLegacy = indexedDB.open(dbName, 1);
    openLegacy.onupgradeneeded = () => openLegacy.result.createObjectStore(legacyStore, { keyPath: "id" });
    const legacyDb = await requestResult(openLegacy);
    const seedTransaction = legacyDb.transaction([legacyStore], "readwrite");
    const seedCommitted = transactionResult(seedTransaction);
    seedTransaction.objectStore(legacyStore).put({
      id: assetId,
      name: "Legacy synthetic bank.sf2",
      byteLength: bankBytes.length,
      presetCount: 1,
      sampleCount: 1,
      uploadedAt: 123,
      data: Uint8Array.from(bankBytes).buffer,
    });
    await seedCommitted;
    legacyDb.close();

    const store = await import("/src/audio/soundfont/soundfontAssetStore.ts");
    const listed = await store.listSoundFontAssets();
    const loaded = await store.loadSoundFontAsset(assetId);
    const loadedHash = loaded ? await store.computeSha256Hex(loaded.data) : null;
    const selectedAfterMigration = settings.getSettings().soundfontAssetId;

    const db = await requestResult(indexedDB.open(dbName));
    const inspectTransaction = db.transaction([legacyStore, metadataStore, blobStore], "readonly");
    const inspectCommitted = transactionResult(inspectTransaction);
    const legacyRowsRequest = inspectTransaction.objectStore(legacyStore).getAll();
    const metadataRequest = inspectTransaction.objectStore(metadataStore).get(assetId);
    const blobRequest = inspectTransaction.objectStore(blobStore).get(assetId);
    const [legacyRows, metadata, blobRecord] = await Promise.all([
      requestResult(legacyRowsRequest), requestResult(metadataRequest), requestResult(blobRequest),
    ]);
    await inspectCommitted;
    db.close();

    return {
      selectedBeforeMigration,
      selectedAfterMigration,
      listedIds: listed.map((item) => item.id),
      loadedIsBlob: loaded?.data instanceof Blob,
      loadedByteLength: loaded?.data.size ?? null,
      loadedHash,
      legacyRowsAfterCommit: legacyRows.length,
      metadataHasDataField: Boolean(metadata && Object.prototype.hasOwnProperty.call(metadata, "data")),
      metadataId: metadata?.id ?? null,
      storedBlobIsBlob: blobRecord?.data instanceof Blob,
      storedBlobSize: blobRecord?.data?.size ?? null,
    };
  }, { bankBytes: bytesForPage, assetId: expectedId, dbName: SOUND_FONT_DB, legacyStore: LEGACY_STORE, metadataStore: METADATA_STORE, blobStore: BLOB_STORE });

  expect(result).toEqual({
    selectedBeforeMigration: expectedId,
    selectedAfterMigration: expectedId,
    listedIds: [expectedId],
    loadedIsBlob: true,
    loadedByteLength: bytes.byteLength,
    loadedHash: expectedId,
    legacyRowsAfterCommit: 0,
    metadataHasDataField: false,
    metadataId: expectedId,
    storedBlobIsBlob: true,
    storedBlobSize: bytes.byteLength,
  });
});

test("native IndexedDB aborts after request success reject save/delete and preserve the prior bank", async ({ page }) => {
  await loadStudioSong(page);
  const retainedBytes = createSyntheticMonoSf2({ frequency: 440 });
  const rejectedBytes = createSyntheticMonoSf2({ frequency: 660 });
  const result = await page.evaluate(async ({ retainedInput, rejectedInput }) => {
    const isAbortError = (error: unknown) => {
      if (typeof error === "object" && error !== null && "name" in error) {
        if ((error as { name?: unknown }).name === "AbortError") return true;
      }
      return /abort/i.test(String(error));
    };
    const store = await import("/src/audio/soundfont/soundfontAssetStore.ts");
    const settings = await import("/src/settings/settingsStore.ts");
    const retained = await store.saveSoundFontAsset("retained.sf2", new Blob([Uint8Array.from(retainedInput).buffer]));
    await settings.updateSettingsPersisted({ soundfontAssetId: retained.id });

    const objectStorePrototype = IDBObjectStore.prototype as unknown as {
      put: (this: IDBObjectStore, ...args: unknown[]) => IDBRequest;
      delete: (this: IDBObjectStore, ...args: unknown[]) => IDBRequest;
    };
    const originalPut = objectStorePrototype.put;
    const originalDelete = objectStorePrototype.delete;
    let putSucceededBeforeAbort = false;
    let saveTransactionAborted = false;
    let deleteSucceededBeforeAbort = false;
    let deleteTransactionAborted = false;

    objectStorePrototype.put = function (...args: unknown[]) {
      const request = originalPut.apply(this, args);
      if (this.name === "asset-metadata") {
        const transaction = this.transaction;
        transaction.addEventListener("abort", () => { saveTransactionAborted = true; }, { once: true });
        request.addEventListener("success", () => {
          putSucceededBeforeAbort = true;
          queueMicrotask(() => transaction.abort());
        }, { once: true });
      }
      return request;
    };

    let saveRejectedAsAbort = false;
    try {
      await store.saveSoundFontAsset("must-not-commit.sf2", new Blob([Uint8Array.from(rejectedInput).buffer]));
    } catch (error) {
      saveRejectedAsAbort = isAbortError(error);
    } finally {
      objectStorePrototype.put = originalPut;
    }

    objectStorePrototype.delete = function (...args: unknown[]) {
      const request = originalDelete.apply(this, args);
      if (this.name === "asset-metadata") {
        const transaction = this.transaction;
        transaction.addEventListener("abort", () => { deleteTransactionAborted = true; }, { once: true });
        request.addEventListener("success", () => {
          deleteSucceededBeforeAbort = true;
          queueMicrotask(() => transaction.abort());
        }, { once: true });
      }
      return request;
    };

    let deleteRejectedAsAbort = false;
    try {
      await store.deleteSoundFontAsset(retained.id);
    } catch (error) {
      deleteRejectedAsAbort = isAbortError(error);
    } finally {
      objectStorePrototype.delete = originalDelete;
    }

    const metadata = await store.listSoundFontAssets();
    const loaded = await store.loadSoundFontAsset(retained.id);
    const selectedId = settings.getSettings().soundfontAssetId;
    const retainedHash = loaded ? await store.computeSha256Hex(loaded.data) : null;
    store.closeSoundFontDb();
    return {
      saveRejectedAsAbort,
      putSucceededBeforeAbort,
      saveTransactionAborted,
      deleteRejectedAsAbort,
      deleteSucceededBeforeAbort,
      deleteTransactionAborted,
      listedIds: metadata.map((item) => item.id),
      retainedBlob: loaded?.data instanceof Blob,
      retainedHash,
      selectedId,
    };
  }, { retainedInput: Array.from(retainedBytes), rejectedInput: Array.from(rejectedBytes) });

  const retainedId = createHash("sha256").update(retainedBytes).digest("hex");
  expect(result).toEqual({
    saveRejectedAsAbort: true,
    putSucceededBeforeAbort: true,
    saveTransactionAborted: true,
    deleteRejectedAsAbort: true,
    deleteSucceededBeforeAbort: true,
    deleteTransactionAborted: true,
    listedIds: [retainedId],
    retainedBlob: true,
    retainedHash: retainedId,
    selectedId: retainedId,
  });
});

test("aborting parse and hash workers leaves no partial asset and keeps the selected bank", async ({ page }) => {
  await loadStudioSong(page);
  const retainedBytes = createSyntheticMonoSf2({ frequency: 440 });
  const candidateBytes = createSyntheticMonoSf2({ frequency: 660 });
  const result = await page.evaluate(async ({ retainedInput, candidateInput }) => {
    const isAbortError = (error: unknown) => {
      if (typeof error === "object" && error !== null && "name" in error) {
        if ((error as { name?: unknown }).name === "AbortError") return true;
      }
      return /abort/i.test(String(error));
    };
    const store = await import("/src/audio/soundfont/soundfontAssetStore.ts");
    const settings = await import("/src/settings/settingsStore.ts");
    const retained = await store.saveSoundFontAsset("retained.sf2", new Blob([Uint8Array.from(retainedInput).buffer]));
    await settings.updateSettingsPersisted({ soundfontAssetId: retained.id });

    const parserController = new AbortController();
    let parserWorkerStarted = false;
    let parserRejectedAsAbort = false;
    try {
      await store.saveSoundFontAsset("cancel-parse.sf2", new Blob([Uint8Array.from(candidateInput).buffer]), {
        signal: parserController.signal,
        onProgress: (progress: { phase: string; loadedBytes: number }) => {
          if (progress.phase === "reading" && progress.loadedBytes > 0 && !parserController.signal.aborted) {
            parserWorkerStarted = true;
            parserController.abort();
          }
        },
      });
    } catch (error) {
      parserRejectedAsAbort = isAbortError(error);
    }

    const base = Uint8Array.from(candidateInput);
    const readTag = (array: Uint8Array, offset: number) => String.fromCharCode(...array.subarray(offset, offset + 4));
    const view = new DataView(base.buffer, base.byteOffset, base.byteLength);
    let offset = 12;
    let sdtaListOffset = -1;
    let smplChunkOffset = -1;
    let smplDataOffset = -1;
    let oldSampleBytes = -1;
    let shdrDataOffset = -1;
    while (offset < base.byteLength) {
      const tag = readTag(base, offset);
      const size = view.getUint32(offset + 4, true);
      if (tag === "LIST") {
        const listType = readTag(base, offset + 8);
        let childOffset = offset + 12;
        const listEnd = offset + 8 + size;
        while (childOffset < listEnd) {
          const childTag = readTag(base, childOffset);
          const childSize = view.getUint32(childOffset + 4, true);
          if (listType === "sdta" && childTag === "smpl") {
            sdtaListOffset = offset;
            smplChunkOffset = childOffset;
            smplDataOffset = childOffset + 8;
            oldSampleBytes = childSize;
          }
          if (listType === "pdta" && childTag === "shdr") shdrDataOffset = childOffset + 8;
          childOffset += 8 + childSize + (childSize & 1);
        }
      }
      offset += 8 + size + (size & 1);
    }
    if ([sdtaListOffset, smplChunkOffset, smplDataOffset, oldSampleBytes, shdrDataOffset].some((value) => value < 0)) {
      throw new Error("Could not locate the synthetic bank's smpl/shdr chunks.");
    }

    const targetSampleBytes = 5 * 1024 * 1024;
    const extraBytes = targetSampleBytes - oldSampleBytes;
    if (extraBytes <= 0 || extraBytes % 2 !== 0) throw new Error("The hash-cancellation SF2 must grow by a positive even byte count.");
    const largeBank = new Uint8Array(base.byteLength + extraBytes);
    largeBank.set(base.subarray(0, smplDataOffset), 0);
    largeBank.set(base.subarray(smplDataOffset, smplDataOffset + oldSampleBytes), smplDataOffset);
    largeBank.set(base.subarray(smplDataOffset + oldSampleBytes), smplDataOffset + targetSampleBytes);
    const largeView = new DataView(largeBank.buffer);
    largeView.setUint32(4, largeBank.byteLength - 8, true);
    largeView.setUint32(sdtaListOffset + 4, view.getUint32(sdtaListOffset + 4, true) + extraBytes, true);
    largeView.setUint32(smplChunkOffset + 4, targetSampleBytes, true);
    const enlargedShdrDataOffset = shdrDataOffset + extraBytes;
    const sampleCount = targetSampleBytes / 2;
    largeView.setUint32(enlargedShdrDataOffset + 24, sampleCount, true);
    largeView.setUint32(enlargedShdrDataOffset + 32, sampleCount, true);

    const hashController = new AbortController();
    let hashWorkerStarted = false;
    let hashRejectedAsAbort = false;
    try {
      await store.saveSoundFontAsset("cancel-hash.sf2", new Blob([largeBank.buffer]), {
        signal: hashController.signal,
        onProgress: (progress: { phase: string; loadedBytes: number }) => {
          if (progress.phase === "hashing" && progress.loadedBytes > 0 && !hashController.signal.aborted) {
            hashWorkerStarted = true;
            hashController.abort();
          }
        },
      });
    } catch (error) {
      hashRejectedAsAbort = isAbortError(error);
    }

    const assets = await store.listSoundFontAssets();
    const loaded = await store.loadSoundFontAsset(retained.id);
    const selectedId = settings.getSettings().soundfontAssetId;
    const retainedHash = loaded ? await store.computeSha256Hex(loaded.data) : null;
    const candidateId = await store.computeSha256Hex(new Blob([Uint8Array.from(candidateInput).buffer]));
    store.closeSoundFontDb();
    return {
      parserWorkerStarted,
      parserRejectedAsAbort,
      hashWorkerStarted,
      hashRejectedAsAbort,
      candidateId,
      retainedId: retained.id,
      listedIds: assets.map((asset: { id: string }) => asset.id),
      selectedId,
      retainedHash,
      retainedBlob: loaded?.data instanceof Blob,
    };
  }, { retainedInput: Array.from(retainedBytes), candidateInput: Array.from(candidateBytes) });

  const retainedId = createHash("sha256").update(retainedBytes).digest("hex");
  const candidateId = createHash("sha256").update(candidateBytes).digest("hex");
  expect(result).toEqual({
    parserWorkerStarted: true,
    parserRejectedAsAbort: true,
    hashWorkerStarted: true,
    hashRejectedAsAbort: true,
    candidateId,
    retainedId,
    listedIds: [retainedId],
    selectedId: retainedId,
    retainedHash: retainedId,
    retainedBlob: true,
  });
});
