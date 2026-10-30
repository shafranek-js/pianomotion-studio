import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RIGGED_HAND_POSE_BONE_IDS,
  RIGGED_HAND_POSE_PRESET_DB_NAME,
  RIGGED_HAND_POSE_PRESET_STORE_NAME,
  RiggedHandPosePresetError,
  closeRiggedHandPosePresetStorage,
  createRiggedHandPosePreset,
  deleteRiggedHandPosePreset,
  exportRiggedHandPosePresetJson,
  importRiggedHandPosePresetJson,
  listRiggedHandPosePresets,
  loadRiggedHandPosePreset,
  replaceRiggedHandPosePreset,
  saveRiggedHandPosePreset,
  validateRiggedExperimentalHandPose,
  validateRiggedHandPosePreset,
  type RiggedExperimentalHandPose,
  type RiggedHandPosePreset,
  type RiggedHandPoseSourceHashes,
} from "./riggedHandPosePreset";

const sourceGlbSha256: RiggedHandPoseSourceHashes = {
  left: "a".repeat(64),
  right: "b".repeat(64),
};

function makePose(side: "left" | "right", positionOffset = 0): RiggedExperimentalHandPose {
  return {
    schemaVersion: 1,
    side,
    group: {
      position: [positionOffset, 0.2, -0.1],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    bones: RIGGED_HAND_POSE_BONE_IDS.map((boneId, index) => ({
      name: `${side}_${boneId}`,
      position: [positionOffset, index / 1000, 0],
      quaternion: [0, 0, 0, 1],
    })),
  };
}

function makePreset(presetId = "rigged-pose-1", name = "Piano pose", createdAtUnixMs = 1_798_000_000_000): RiggedHandPosePreset {
  return createRiggedHandPosePreset({
    presetId,
    name,
    createdAtUnixMs,
    sourceGlbSha256,
    hands: { left: makePose("left", -0.1), right: makePose("right", 0.1) },
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
  abort: () => void;
  objectStore: (name: string) => {
    add: (value: RiggedHandPosePreset) => FakeRequest;
    put: (value: RiggedHandPosePreset) => FakeRequest;
    delete: (key: string) => FakeRequest;
    get: (key: string) => FakeRequest;
    getAll: () => FakeRequest;
  };
};

class FakeDatabase {
  readonly stores = new Map<string, Map<string, RiggedHandPosePreset>>();
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  readonly close = vi.fn();
  onversionchange: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private writeTransactionTail: Promise<void> = Promise.resolve();

  createObjectStore(name: string): object {
    this.stores.set(name, new Map());
    return {};
  }

  transaction(storeName: string, mode: IDBTransactionMode = "readonly"): IDBTransaction {
    const data = this.stores.get(storeName);
    if (!data) throw new DOMException("Missing object store", "NotFoundError");
    let pendingRequests = 0;
    let aborted = false;
    let finished = false;
    let releaseWriteTransaction = () => {};
    const startAfter = mode === "readwrite" ? this.writeTransactionTail : Promise.resolve();
    if (mode === "readwrite") {
      this.writeTransactionTail = new Promise<void>((resolve) => { releaseWriteTransaction = resolve; });
    }
    const transaction: FakeTransaction = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      abort: () => {
        if (aborted || finished) return;
        aborted = true;
        queueMicrotask(() => {
          transaction.onabort?.();
          finished = true;
          if (mode === "readwrite") releaseWriteTransaction();
        });
      },
      objectStore: (requestedName) => {
        if (requestedName !== storeName) throw new DOMException("Wrong object store", "NotFoundError");
        const queueRequest = (operation: () => void) => {
          pendingRequests++;
          void startAfter.then(() => queueMicrotask(() => {
            if (!aborted) operation();
            pendingRequests--;
            if (!aborted && pendingRequests === 0) {
              queueMicrotask(() => {
                if (!aborted && !finished && pendingRequests === 0) {
                  transaction.oncomplete?.();
                  finished = true;
                  if (mode === "readwrite") releaseWriteTransaction();
                }
              });
            }
          }));
        };
        const failTransaction = () => {
          if (aborted || finished) return;
          aborted = true;
          transaction.onabort?.();
          finished = true;
          if (mode === "readwrite") releaseWriteTransaction();
        };
        const makeWriteRequest = (value: RiggedHandPosePreset, replace: boolean): FakeRequest => {
          const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
          queueRequest(() => {
            if (!replace && data.has(value.presetId)) {
              const error = new DOMException("Key already exists", "ConstraintError");
              request.error = error;
              transaction.error = error;
              request.onerror?.();
              transaction.onerror?.();
              failTransaction();
              return;
            }
            data.set(value.presetId, structuredClone(value));
            request.result = value.presetId;
            request.onsuccess?.();
          });
          return request;
        };
        return {
          add: (value) => makeWriteRequest(value, false),
          put: (value) => makeWriteRequest(value, true),
          delete: (key) => {
            const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
            queueRequest(() => {
              data.delete(key);
              request.onsuccess?.();
            });
            return request;
          },
          get: (key) => {
            const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
            queueRequest(() => {
              const value = data.get(key);
              request.result = value ? structuredClone(value) : undefined;
              request.onsuccess?.();
            });
            return request;
          },
          getAll: () => {
            const request: FakeRequest = {
              result: [...data.values()].map((value) => structuredClone(value)),
              error: null,
              onsuccess: null,
              onerror: null,
            };
            request.result = undefined;
            queueRequest(() => {
              request.result = [...data.values()].map((value) => structuredClone(value));
              request.onsuccess?.();
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
      if (!this.database.objectStoreNames.contains(RIGGED_HAND_POSE_PRESET_STORE_NAME)) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  };
}

afterEach(() => {
  closeRiggedHandPosePresetStorage();
  vi.unstubAllGlobals();
});

describe("independent rigged hand pose presets", () => {
  it("validates and deep-copies the two local-space runtime snapshots", () => {
    const input = {
      presetId: "pose-1",
      name: "Piano pose",
      createdAtUnixMs: 1_798_000_000_000,
      sourceGlbSha256,
      hands: { left: makePose("left"), right: makePose("right") },
    };
    const preset = createRiggedHandPosePreset(input);

    expect(preset.format).toBe("handthesia.rigged-hand-pose-preset");
    expect(preset.version).toBe(1);
    expect(preset.hands.left.schemaVersion).toBe(1);
    expect(preset.hands.left.side).toBe("left");
    expect(preset.hands.right.side).toBe("right");
    expect(preset.hands.left.group).toEqual({ position: [0, 0.2, -0.1], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(preset.hands.left.bones.map((bone) => bone.name)).toEqual(RIGGED_HAND_POSE_BONE_IDS.map((bone) => `left_${bone}`));
    expect(preset.hands.right.bones.map((bone) => bone.name)).toEqual(RIGGED_HAND_POSE_BONE_IDS.map((bone) => `right_${bone}`));
    expect(preset.sourceGlbSha256).toEqual(sourceGlbSha256);
    expect(preset.hands.left).not.toBe(input.hands.left);
    expect(preset.hands.left.bones).not.toBe(input.hands.left.bones);
  });

  it("rejects incomplete, duplicate, foreign-side, non-finite, and non-normalized bone data", () => {
    const pose = makePose("left");
    expect(() => validateRiggedExperimentalHandPose({ ...pose, bones: pose.bones.slice(1) }))
      .toThrowError(expect.objectContaining({ code: "invalid-bone-list" }));

    const duplicate = {
      ...pose,
      bones: pose.bones.map((bone, index) => index === 1 ? { ...bone, name: pose.bones[0]!.name } : bone),
    };
    expect(() => validateRiggedExperimentalHandPose(duplicate))
      .toThrowError(expect.objectContaining({ code: "duplicate-bone" }));

    const wrongSide = {
      ...pose,
      bones: pose.bones.map((bone, index) => index === 0 ? { ...bone, name: `right_${RIGGED_HAND_POSE_BONE_IDS[0]}` } : bone),
    };
    expect(() => validateRiggedExperimentalHandPose(wrongSide))
      .toThrowError(expect.objectContaining({ code: "invalid-bone-name" }));

    const nonFinite = {
      ...pose,
      bones: pose.bones.map((bone, index) => index === 0 ? { ...bone, position: [Number.NaN, 0, 0] as const } : bone),
    };
    expect(() => validateRiggedExperimentalHandPose(nonFinite))
      .toThrowError(expect.objectContaining({ code: "invalid-vector" }));

    const sparseVector = new Array<number>(3);
    sparseVector[1] = 0;
    sparseVector[2] = 0;
    const sparse = {
      ...pose,
      group: { ...pose.group, position: sparseVector as unknown as readonly [number, number, number] },
    };
    expect(() => validateRiggedExperimentalHandPose(sparse))
      .toThrowError(expect.objectContaining({ code: "invalid-vector" }));

    const nonNormalized = { ...pose, group: { ...pose.group, quaternion: [0, 0, 0, 2] as const } };
    expect(() => validateRiggedExperimentalHandPose(nonNormalized))
      .toThrowError(expect.objectContaining({ code: "invalid-quaternion" }));
  });

  it("requires known SHA-256 values and rejects mismatched source GLBs", () => {
    const preset = makePreset();
    expect(() => validateRiggedHandPosePreset({
      ...preset,
      sourceGlbSha256: { ...sourceGlbSha256, left: null },
    })).toThrowError(expect.objectContaining({ code: "source-asset-unverified" }));
    expect(() => validateRiggedHandPosePreset(preset, { ...sourceGlbSha256, right: "c".repeat(64) }))
      .toThrowError(expect.objectContaining({ code: "source-asset-mismatch" }));
  });

  it("preserves only supplied editor provenance, including negative lead-in and source times", () => {
    const preset = makePreset();
    expect(preset).not.toHaveProperty("editorProvenance");

    const withProvenance = validateRiggedHandPosePreset({
      ...preset,
      editorProvenance: {
        displayedTransportTimeSeconds: -2,
        sourcePoseTimeSeconds: { left: -2, right: 0.25 },
        positionIndex: 0,
        positionLabel: "Lead-in / −0:02",
      },
    });
    expect(withProvenance.editorProvenance).toEqual({
      displayedTransportTimeSeconds: -2,
      sourcePoseTimeSeconds: { left: -2, right: 0.25 },
      positionIndex: 0,
      positionLabel: "Lead-in / −0:02",
    });
    expect(validateRiggedHandPosePreset({ ...preset, editorProvenance: {} })).not.toHaveProperty("editorProvenance");
    expect(() => validateRiggedHandPosePreset({
      ...preset,
      editorProvenance: { displayedTransportTimeSeconds: Number.NaN },
    })).toThrowError(expect.objectContaining({ code: "invalid-editor-provenance" }));
    expect(() => validateRiggedHandPosePreset({
      ...preset,
      editorProvenance: { positionIndex: -1 },
    })).toThrowError(expect.objectContaining({ code: "invalid-editor-provenance" }));
  });

  it("round-trips JSON and rejects invalid or oversized imports", () => {
    const preset = makePreset();
    const json = exportRiggedHandPosePresetJson(preset);
    expect(importRiggedHandPosePresetJson(json, sourceGlbSha256)).toEqual(preset);
    expect(() => importRiggedHandPosePresetJson(json, { ...sourceGlbSha256, left: "c".repeat(64) }))
      .toThrowError(expect.objectContaining({ code: "source-asset-mismatch" }));
    expect(() => importRiggedHandPosePresetJson("{"))
      .toThrowError(expect.objectContaining({ code: "invalid-json" }));
    expect(() => importRiggedHandPosePresetJson(" ".repeat(256 * 1024 + 1)))
      .toThrowError(expect.objectContaining({ code: "json-too-large" }));
  });

  it("uses its own IDB namespace, create-only saves, and guards loads by both source hashes", async () => {
    const factory = new FakeIndexedDbFactory();
    vi.stubGlobal("indexedDB", factory as unknown as IDBFactory);

    const first = makePreset("same-id", "First pose", 1_798_000_000_000);
    const second = makePreset("same-id", "Replacement pose", 1_798_000_000_001);
    const results = await Promise.allSettled([saveRiggedHandPosePreset(first), saveRiggedHandPosePreset(second)]);

    expect(factory.names).toEqual([RIGGED_HAND_POSE_PRESET_DB_NAME]);
    expect(RIGGED_HAND_POSE_PRESET_DB_NAME).toBe("pianomotion-rigged-hand-poses");
    expect(RIGGED_HAND_POSE_PRESET_DB_NAME).not.toBe("handthesia_db");
    expect(RIGGED_HAND_POSE_PRESET_DB_NAME).not.toBe("pianomotion-testing2-rigs");
    expect(factory.database.stores.has(RIGGED_HAND_POSE_PRESET_STORE_NAME)).toBe(true);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(RiggedHandPosePresetError);
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe("preset-id-conflict");

    const listed = await listRiggedHandPosePresets();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.presetId).toBe("same-id");
    expect(listed[0]?.name === first.name || listed[0]?.name === second.name).toBe(true);
    const loaded = await loadRiggedHandPosePreset("same-id", sourceGlbSha256);
    expect(loaded).toEqual(listed[0]);
    await expect(loadRiggedHandPosePreset("same-id", { ...sourceGlbSha256, right: "c".repeat(64) }))
      .rejects.toMatchObject({ code: "source-asset-mismatch" });
    await expect(saveRiggedHandPosePreset({ ...first, name: "overwrite" }))
      .rejects.toMatchObject({ code: "preset-id-conflict" });
    expect((await listRiggedHandPosePresets())[0]?.name).toBe(listed[0]?.name);
    expect(await loadRiggedHandPosePreset("missing", sourceGlbSha256)).toBeNull();
  });

  it("atomically rejects concurrent saves with the same normalized name", async () => {
    const factory = new FakeIndexedDbFactory();
    vi.stubGlobal("indexedDB", factory as unknown as IDBFactory);
    const first = makePreset("unique-name-1", "Warm-up pose");
    const second = makePreset("unique-name-2", "WARM-UP POSE");

    const results = await Promise.allSettled([
      saveRiggedHandPosePreset(first),
      saveRiggedHandPosePreset(second),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "preset-name-conflict" });
    const stored = await listRiggedHandPosePresets();
    expect(stored).toHaveLength(1);
    expect([first.presetId, second.presetId]).toContain(stored[0]?.presetId);
  });

  it("preserves legacy duplicate-name records and permits same-name replacement only", async () => {
    const factory = new FakeIndexedDbFactory();
    factory.database.createObjectStore(RIGGED_HAND_POSE_PRESET_STORE_NAME);
    const records = factory.database.stores.get(RIGGED_HAND_POSE_PRESET_STORE_NAME)!;
    const selected = makePreset("legacy-selected", "Legacy pose");
    const duplicate = makePreset("legacy-duplicate", "LEGACY POSE");
    const other = makePreset("other-name", "Held pose");
    records.set(selected.presetId, structuredClone(selected));
    records.set(duplicate.presetId, structuredClone(duplicate));
    records.set(other.presetId, structuredClone(other));
    vi.stubGlobal("indexedDB", factory as unknown as IDBFactory);

    const refreshed = makePreset(selected.presetId, selected.name, selected.createdAtUnixMs + 10);
    await expect(replaceRiggedHandPosePreset(selected.presetId, refreshed)).resolves.toEqual(refreshed);
    await expect(saveRiggedHandPosePreset(makePreset("new-legacy-name", "Legacy pose")))
      .rejects.toMatchObject({ code: "preset-name-conflict" });
    await expect(replaceRiggedHandPosePreset(selected.presetId, makePreset(selected.presetId, "Held pose")))
      .rejects.toMatchObject({ code: "preset-name-conflict" });
    await expect(replaceRiggedHandPosePreset("missing-preset", makePreset("missing-preset", "Missing pose")))
      .rejects.toMatchObject({ code: "preset-not-found" });
    await expect(replaceRiggedHandPosePreset(selected.presetId, makePreset("different-id", "Wrong ID")))
      .rejects.toMatchObject({ code: "preset-id-mismatch" });

    const stored = await listRiggedHandPosePresets();
    expect(stored).toHaveLength(3);
    expect(stored.map((preset) => preset.presetId).sort()).toEqual([
      "legacy-duplicate", "legacy-selected", "other-name",
    ]);
    expect(stored.find((preset) => preset.presetId === selected.presetId)).toEqual(refreshed);
    expect(stored.find((preset) => preset.presetId === duplicate.presetId)).toEqual(duplicate);
  });

  it("deletes only the selected preset and reports when that ID is already absent", async () => {
    const factory = new FakeIndexedDbFactory();
    vi.stubGlobal("indexedDB", factory as unknown as IDBFactory);
    const selected = makePreset("delete-selected", "Delete this pose");
    const retained = makePreset("keep-this", "Keep this pose");
    await saveRiggedHandPosePreset(selected);
    await saveRiggedHandPosePreset(retained);

    await expect(deleteRiggedHandPosePreset(selected.presetId)).resolves.toBeUndefined();
    await expect(deleteRiggedHandPosePreset(selected.presetId)).rejects.toMatchObject({ code: "preset-not-found" });
    expect(await listRiggedHandPosePresets()).toEqual([retained]);
  });

  it("returns an explicit storage error when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(saveRiggedHandPosePreset(makePreset())).rejects.toMatchObject({ code: "storage-unavailable" });
  });
});
