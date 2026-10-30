import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Vitest runs checked-in asset tests in Node; Node types are excluded from client source compilation.
import { readFileSync } from "node:fs";
import {
  TESTING2_RIG_PRESET_DB_NAME,
  TESTING2_RIG_PRESET_JOINT_NAMES,
  TESTING2_RIG_PRESET_MAX_ABS_COORDINATE_METERS,
  TESTING2_RIG_PRESET_MAX_JSON_LENGTH,
  TESTING2_RIG_PRESET_STORE_NAME,
  Testing2RigPresetError,
  closeTesting2RigPresetStorage,
  createTesting2RigPreset,
  exportTesting2RigPresetJson,
  getTesting2RigPreset,
  importTesting2RigPresetJson,
  listTesting2RigPresets,
  saveTesting2RigPreset,
  testing2RigPresetSourceAssetFromManifest,
  validateTesting2RigPreset,
  type Testing2RigPreset,
  type Testing2RigPresetSourceAsset,
} from "./testing2RigPreset";

const sourceAsset: Testing2RigPresetSourceAsset = {
  modelId: "anatomical-improved",
  manifestSchemaVersion: 1,
  uri: "hand_standard.glb",
  sha256: "2d516fee4cb0889d8a0c71e86d6f8d48cce789314bc9f857b159baf4ca1c7a77",
  vertices: 985_318,
  triangles: 1_914_904,
  handLod0Sha256: { left: "a".repeat(64), right: "b".repeat(64) },
};

function handPositions(sideOffset: number) {
  return TESTING2_RIG_PRESET_JOINT_NAMES.map((name, index) => ({
    name,
    positionMeters: [sideOffset + index / 1000, index / 2000, -index / 3000] as const,
  }));
}

function makePreset(presetId = "testing2-rig-1", name = "Test bind rig"): Testing2RigPreset {
  return createTesting2RigPreset({
    presetId,
    name,
    createdAtUnixMs: 1_798_000_000_000,
    sourceAsset,
    hands: { left: handPositions(-0.01), right: handPositions(0.01) },
  });
}

type FakeRequest = {
  result: unknown;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
};

type FakeTransaction = {
  error: DOMException | null;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  objectStore: (name: string) => {
    add: (value: Testing2RigPreset) => FakeRequest;
    get: (key: string) => FakeRequest;
    getAll: () => FakeRequest;
  };
};

class FakeDatabase {
  readonly stores = new Map<string, Map<string, Testing2RigPreset>>();
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  readonly close = vi.fn();
  onversionchange: (() => void) | null = null;
  onclose: (() => void) | null = null;

  createObjectStore(name: string): object {
    this.stores.set(name, new Map());
    return {};
  }

  transaction(storeName: string): IDBTransaction {
    const data = this.stores.get(storeName);
    if (!data) throw new DOMException("Missing object store", "NotFoundError");
    const transaction: FakeTransaction = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: (requestedName) => {
        if (requestedName !== storeName) throw new DOMException("Wrong object store", "NotFoundError");
        return {
          add: (value) => {
            const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
            const previous = data.get(value.presetId);
            if (previous) {
              const error = new DOMException("Key already exists", "ConstraintError");
              request.error = error;
              transaction.error = error;
              queueMicrotask(() => {
                request.onerror?.();
                transaction.onerror?.();
                transaction.onabort?.();
              });
            } else {
              data.set(value.presetId, structuredClone(value));
              request.result = value.presetId;
              queueMicrotask(() => {
                request.onsuccess?.();
                transaction.oncomplete?.();
              });
            }
            return request;
          },
          get: (key) => {
            const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
            const value = data.get(key);
            request.result = value ? structuredClone(value) : undefined;
            queueMicrotask(() => {
              request.onsuccess?.();
              transaction.oncomplete?.();
            });
            return request;
          },
          getAll: () => {
            const request: FakeRequest = { result: [...data.values()].map((value) => structuredClone(value)), error: null, onsuccess: null, onerror: null };
            queueMicrotask(() => {
              request.onsuccess?.();
              transaction.oncomplete?.();
            });
            return request;
          },
        };
      },
    };
    return transaction as unknown as IDBTransaction;
  }
}

class FakeIndexedDbFactory {
  readonly names: string[] = [];
  readonly database = new FakeDatabase();

  open = (name: string): IDBOpenDBRequest => {
    this.names.push(name);
    const request = {
      result: this.database,
      error: null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onblocked: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
    };
    queueMicrotask(() => {
      if (!this.database.objectStoreNames.contains(TESTING2_RIG_PRESET_STORE_NAME)) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  };
}

afterEach(() => {
  closeTesting2RigPresetStorage();
  vi.unstubAllGlobals();
});

describe("Testing2 independent rig preset format", () => {
  it("requires exactly 25 named bind positions for each hand and returns a canonical copy", () => {
    const preset = makePreset();

    expect(preset.format).toBe("handthesia.testing2-rig-preset");
    expect(preset.version).toBe(1);
    expect(preset.coordinateFrame).toEqual({ unit: "meters", handedness: "right", pose: "bind" });
    expect(preset.hands.left.map((joint) => joint.name)).toEqual(TESTING2_RIG_PRESET_JOINT_NAMES);
    expect(preset.hands.right.map((joint) => joint.name)).toEqual(TESTING2_RIG_PRESET_JOINT_NAMES);
    expect(preset.hands.left).not.toBe(preset.hands.right);
    expect(preset.sourceAsset.sha256).toBe(sourceAsset.sha256);
  });

  it("round-trips JSON and rejects a preset tied to a different source identity", () => {
    const preset = makePreset();
    const json = exportTesting2RigPresetJson(preset);

    expect(importTesting2RigPresetJson(json, sourceAsset)).toEqual(preset);
    expect(() => importTesting2RigPresetJson(json, {
      ...sourceAsset,
      handLod0Sha256: { ...sourceAsset.handLod0Sha256, right: "c".repeat(64) },
    }))
      .toThrowError(expect.objectContaining({ code: "source-asset-mismatch" }));
    expect(() => importTesting2RigPresetJson("{broken", sourceAsset))
      .toThrowError(expect.objectContaining({ code: "invalid-json" }));
    expect(() => importTesting2RigPresetJson(" ".repeat(TESTING2_RIG_PRESET_MAX_JSON_LENGTH + 1), sourceAsset))
      .toThrowError(expect.objectContaining({ code: "json-too-large" }));
  });

  it("extracts complete source identity from the checked-in manifest and both real LOD0 GLBs", async () => {
    const manifestUrl = new URL("../../public/models/hands/improved/manifest.json", import.meta.url);
    const improvedModelsUrl = new URL("../../public/models/hands/improved/", import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as unknown;
    const typedManifest = manifest as {
      hands: Record<"left" | "right", { lods: Array<{ url: string }> }>;
    };
    const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer;
    const identity = await testing2RigPresetSourceAssetFromManifest(manifest, {
      left: toArrayBuffer(readFileSync(new URL(typedManifest.hands.left.lods[0]!.url, improvedModelsUrl))),
      right: toArrayBuffer(readFileSync(new URL(typedManifest.hands.right.lods[0]!.url, improvedModelsUrl))),
    });

    expect(identity).toMatchObject({
      modelId: sourceAsset.modelId,
      manifestSchemaVersion: sourceAsset.manifestSchemaVersion,
      uri: sourceAsset.uri,
      sha256: sourceAsset.sha256,
      vertices: sourceAsset.vertices,
      triangles: sourceAsset.triangles,
    });
    expect(identity.handLod0Sha256.left).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.handLod0Sha256.right).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.handLod0Sha256.left).not.toBe(identity.handLod0Sha256.right);
  });

  it("rejects wrong versions, format references, IDs, names, timestamps, and asset metadata", () => {
    const preset = makePreset();
    expect(() => validateTesting2RigPreset({ ...preset, format: "other" }))
      .toThrowError(expect.objectContaining({ code: "unsupported-format" }));
    expect(() => validateTesting2RigPreset({ ...preset, version: 2 }))
      .toThrowError(expect.objectContaining({ code: "unsupported-version" }));
    expect(() => validateTesting2RigPreset({ ...preset, presetId: "../bad" }))
      .toThrowError(expect.objectContaining({ code: "invalid-preset-id" }));
    expect(() => validateTesting2RigPreset({ ...preset, name: "   " }))
      .toThrowError(expect.objectContaining({ code: "invalid-name" }));
    expect(() => validateTesting2RigPreset({ ...preset, createdAtUnixMs: Number.NaN }))
      .toThrowError(expect.objectContaining({ code: "invalid-timestamp" }));
    expect(() => validateTesting2RigPreset({ ...preset, sourceAsset: { ...sourceAsset, sha256: "no hash" } }))
      .toThrowError(expect.objectContaining({ code: "invalid-source-asset" }));
    expect(() => validateTesting2RigPreset({ ...preset, sourceAsset: { ...sourceAsset, vertices: 0 } }))
      .toThrowError(expect.objectContaining({ code: "invalid-source-asset" }));
    expect(() => validateTesting2RigPreset({
      ...preset,
      sourceAsset: { ...sourceAsset, handLod0Sha256: { left: "a".repeat(64) } },
    }))
      .toThrowError(expect.objectContaining({ code: "source-asset-unverified" }));
  });

  it("rejects missing, duplicated, unknown, and extra joint references", () => {
    const preset = makePreset();
    const duplicate = structuredClone(preset) as unknown as { hands: { left: Array<{ name: string; positionMeters: number[] }>; right: Array<{ name: string; positionMeters: number[] }> } };
    duplicate.hands.left[1] = { ...duplicate.hands.left[1]!, name: duplicate.hands.left[0]!.name };
    expect(() => validateTesting2RigPreset(duplicate))
      .toThrowError(expect.objectContaining({ code: "duplicate-joint" }));

    const missing = structuredClone(preset) as unknown as { hands: { left: Array<{ name: string; positionMeters: number[] }>; right: Array<{ name: string; positionMeters: number[] }> } };
    missing.hands.right.pop();
    expect(() => validateTesting2RigPreset(missing))
      .toThrowError(expect.objectContaining({ code: "invalid-hand-positions" }));

    const unknown = structuredClone(preset) as unknown as { hands: { left: Array<{ name: string; positionMeters: number[] }> } };
    unknown.hands.left[2]!.name = "finger-unknown";
    expect(() => validateTesting2RigPreset(unknown))
      .toThrowError(expect.objectContaining({ code: "unknown-joint" }));

    expect(() => validateTesting2RigPreset({ ...preset, hands: { left: preset.hands.left, right: preset.hands.right, center: [] } }))
      .toThrowError(expect.objectContaining({ code: "invalid-record" }));
  });

  it("rejects non-finite, sparse, malformed, and out-of-bounds meter positions", () => {
    const preset = makePreset();
    const nonFinite = structuredClone(preset) as unknown as { hands: { left: Array<{ positionMeters: number[] }> } };
    nonFinite.hands.left[0]!.positionMeters[1] = Number.POSITIVE_INFINITY;
    expect(() => validateTesting2RigPreset(nonFinite))
      .toThrowError(expect.objectContaining({ code: "invalid-position" }));

    const sparse = structuredClone(preset) as unknown as { hands: { right: Array<{ positionMeters: number[] }> } };
    const sparsePoint = new Array<number>(3);
    sparsePoint[0] = 0;
    sparsePoint[2] = 0;
    sparse.hands.right[0]!.positionMeters = sparsePoint;
    expect(() => validateTesting2RigPreset(sparse))
      .toThrowError(expect.objectContaining({ code: "invalid-position" }));

    const malformed = structuredClone(preset) as unknown as { hands: { right: Array<{ positionMeters: number[] }> } };
    malformed.hands.right[0]!.positionMeters = [0, 1];
    expect(() => validateTesting2RigPreset(malformed))
      .toThrowError(expect.objectContaining({ code: "invalid-position" }));

    const outOfBounds = structuredClone(preset) as unknown as { hands: { left: Array<{ positionMeters: number[] }> } };
    outOfBounds.hands.left[0]!.positionMeters[0] = TESTING2_RIG_PRESET_MAX_ABS_COORDINATE_METERS + 0.001;
    expect(() => validateTesting2RigPreset(outOfBounds))
      .toThrowError(expect.objectContaining({ code: "position-out-of-bounds" }));
  });

  it("rejects unsupported coordinate frames and extra fields", () => {
    const preset = makePreset();
    expect(() => validateTesting2RigPreset({ ...preset, coordinateFrame: { ...preset.coordinateFrame, pose: "rest" } }))
      .toThrowError(expect.objectContaining({ code: "invalid-coordinate-frame" }));
    expect(() => validateTesting2RigPreset({ ...preset, futureField: true }))
      .toThrowError(expect.objectContaining({ code: "invalid-record" }));
    expect(() => validateTesting2RigPreset({ ...preset, hands: { left: preset.hands.left } }))
      .toThrowError(expect.objectContaining({ code: "invalid-hand-positions" }));
  });

  it("uses a separate IndexedDB namespace and makes create-only saves race-safe", async () => {
    const factory = new FakeIndexedDbFactory();
    vi.stubGlobal("indexedDB", factory as unknown as IDBFactory);

    const leftName = "left writer";
    const rightName = "right writer";
    const left = makePreset("same-id", leftName);
    const right = makePreset("same-id", rightName);
    const results = await Promise.allSettled([saveTesting2RigPreset(left), saveTesting2RigPreset(right)]);

    expect(factory.names).toEqual([TESTING2_RIG_PRESET_DB_NAME]);
    expect(TESTING2_RIG_PRESET_DB_NAME).toBe("pianomotion-testing2-rigs");
    expect(TESTING2_RIG_PRESET_DB_NAME).not.toBe("handthesia_db");
    expect(factory.database.stores.has(TESTING2_RIG_PRESET_STORE_NAME)).toBe(true);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(Testing2RigPresetError);
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe("preset-id-conflict");

    const saved = await getTesting2RigPreset("same-id", sourceAsset);
    const listed = await listTesting2RigPresets(sourceAsset);
    expect(saved?.name === leftName || saved?.name === rightName).toBe(true);
    expect(listed).toEqual([saved]);
    await expect(saveTesting2RigPreset(makePreset("same-id", "replacement")))
      .rejects.toMatchObject({ code: "preset-id-conflict" });
    expect((await getTesting2RigPreset("same-id"))?.name).toBe(saved?.name);
    expect(await getTesting2RigPreset("missing-id")).toBeNull();
  });

  it("returns explicit storage errors when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(saveTesting2RigPreset(makePreset())).rejects.toMatchObject({ code: "storage-unavailable" });
  });
});
