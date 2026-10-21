import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SCHEMA_VERSION,
  M1AnalyzeMidiResultSchema,
  type SongDocument,
  type PianistProfile,
} from "@handthesia/contracts";
import {
  DB_NAME,
  DB_VERSION,
  PROJECTS_STORE,
  PROFILES_STORE,
  SETTINGS_STORE,
  SESSION_STORE,
  openProjectDb,
  closeProjectDb,
  setIndexedDBFactory,
  saveProject,
  getProject,
  saveProfile,
  getProfile,
  listCustomProfiles,
  getDbSetting,
  deleteProfile,
  clearAllProfiles,
  StorageQuotaExceededError,
  isQuotaExceededError,
  type SavedProject,
} from "./projectDb.ts";
import {
  saveSessionSnapshot,
  loadSessionSnapshot,
  clearSessionSnapshot,
  assessSessionSnapshot,
  getStorageQuota,
  AutosaveService,
  type SessionSnapshot,
} from "./autosave.ts";
import { computeSha256Hex } from "./packageExporter.ts";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SETTINGS_DB_KEY,
  SettingsStore,
  initializeSettings,
  setSettingsStorage,
} from "../settings/index.ts";
import {
  ACTIVE_PROFILE_DB_KEY,
  ACTIVE_PROFILE_STORAGE_KEY,
  PROFILES_STORAGE_KEY,
  getActiveProfile,
  initializeProfiles,
  listProfiles,
  saveProfile as saveProfileThroughStore,
  setProfileStorage,
} from "../profiles/index.ts";

function createValidSongDocument(projectId = "proj_test_1"): SongDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    revision: 0,
    title: "M5 Test Sonata",
    durationSeconds: 60,
    tracks: [
      {
        trackId: "track_1",
        instrumentIndex: 0,
        name: "Piano",
        program: 0,
        hand: "right",
      },
    ],
    notes: [
      {
        noteId: "note_1",
        trackId: "track_1",
        pitch: 60,
        velocity: 80,
        startSeconds: 0.5,
        endSeconds: 1.0,
        hand: "right",
        finger: 1,
        glissando: false,
      },
    ],
    tempoMap: [
      {
        timeSeconds: 0,
        microsecondsPerQuarterNote: 500000,
        eventOrdinal: 0,
      },
    ],
    pedalControls: [],
  };
}

function createValidProfile(profileId = "profile_test_1", modifiedOffset = 0): PianistProfile {
  return {
    schemaVersion: SCHEMA_VERSION,
    profileId,
    revision: 1,
    name: `Custom Profile ${profileId}`,
    colorRgb: [64, 128, 255],
    anatomy: {
      reachSpanInches: 8.5,
      fingerLengthInches: 3.5,
    },
    behavior: {
      legatoSensitivity: 1.0,
      dampingVelocity: 0.9,
    },
    skin: { theme: "modern" },
    weights: {
      fatigue: 0.1,
      stretchPenalty: 0.2,
    },
    createdAtUnixSeconds: 1700000000,
    modifiedAtUnixSeconds: 1700000000 + modifiedOffset,
  };
}

// ============================================================================
// Robust In-Memory Mock IndexedDB for Schema Upgrade & Multi-Store Testing
// ============================================================================

interface MockReq<T = unknown> {
  result: T;
  error: DOMException | Error | null;
  onsuccess: ((ev: { target: MockReq<T> }) => void) | null;
  onerror: ((ev: { target: MockReq<T> }) => void) | null;
}

class MockIDBStore {
  name: string;
  keyPath: string;
  indexes = new Map<string, string>();
  records = new Map<unknown, unknown>();
  simulateQuotaError = false;
  putDelaysMs: number[] = [];
  putCount = 0;

  constructor(name: string, keyPath: string) {
    this.name = name;
    this.keyPath = keyPath;
  }

  createIndex(indexName: string, keyPath: string): void {
    this.indexes.set(indexName, keyPath);
  }

  put(value: unknown): MockReq<unknown> {
    this.putCount += 1;
    const req: MockReq<unknown> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };

    if (this.simulateQuotaError) {
      const err = new DOMException("Quota exceeded", "QuotaExceededError");
      req.error = err;
      setTimeout(() => {
        if (req.onerror) req.onerror({ target: req });
      }, 0);
      return req;
    }

    const rec = value as Record<string, unknown>;
    const key = this.keyPath ? rec[this.keyPath] : rec["id"];
    req.result = key;
    const delayMs = this.putDelaysMs.shift() ?? 0;

    setTimeout(() => {
      this.records.set(key, structuredClone(value));
      if (req.onsuccess) req.onsuccess({ target: req });
    }, delayMs);
    return req;
  }

  get(key: unknown): MockReq<unknown> {
    const req: MockReq<unknown> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    const val = this.records.get(key);
    req.result = val !== undefined ? structuredClone(val) : undefined;

    setTimeout(() => {
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }

  getAll(): MockReq<unknown[]> {
    const req: MockReq<unknown[]> = {
      result: [],
      error: null,
      onsuccess: null,
      onerror: null,
    };
    req.result = Array.from(this.records.values()).map((v) => structuredClone(v));

    setTimeout(() => {
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }

  delete(key: unknown): MockReq<undefined> {
    const req: MockReq<undefined> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    this.records.delete(key);

    setTimeout(() => {
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }

  clear(): MockReq<undefined> {
    const req: MockReq<undefined> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    this.records.clear();

    setTimeout(() => {
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }
}

class MockDatabaseState {
  version = 0;
  stores = new Map<string, MockIDBStore>();

  createDbInterface(): IDBDatabase {
    const { stores } = this;
    const getVersion = () => this.version;
    const dbObj = {
      get version() {
        return getVersion();
      },
      objectStoreNames: {
        contains: (name: string) => stores.has(name),
        item: (index: number) => Array.from(stores.keys())[index] ?? null,
        get length() {
          return stores.size;
        },
      },
      createObjectStore: (name: string, options?: { keyPath?: string }) => {
        const store = new MockIDBStore(name, options?.keyPath ?? "id");
        stores.set(name, store);
        return store;
      },
      transaction: (_storeNames: string | string[], mode = "readonly") => {
        let pendingRequests = 0;
        let finished = false;
        const beforeWrites = new Map<MockIDBStore, Map<unknown, unknown>>();
        const scheduleCompletion = () => {
          setTimeout(() => {
            if (finished || pendingRequests !== 0) return;
            finished = true;
            txObj.oncomplete?.();
          }, 0);
        };
        const abortTransaction = (error: DOMException | Error | null = null) => {
          if (finished) return;
          finished = true;
          txObj.error = error;
          for (const [store, records] of beforeWrites) store.records = new Map(records);
          setTimeout(() => {
            if (error) txObj.onerror?.({ target: txObj });
            txObj.onabort?.({ target: txObj });
          }, 0);
        };
        const txObj = {
          mode,
          error: null as DOMException | Error | null,
          onerror: null as ((ev: { target: unknown }) => void) | null,
          onabort: null as ((ev: { target: unknown }) => void) | null,
          oncomplete: null as (() => void) | null,
          objectStore: (name: string) => {
            const store = stores.get(name);
            if (!store) {
              throw new Error(`Store "${name}" not found`);
            }
            if (mode === "readwrite" && !beforeWrites.has(store)) {
              beforeWrites.set(store, new Map(store.records));
            }
            // Bind each request to its transaction without changing the shared
            // store counters/delays used by the serialization assertions.
            return new Proxy(store, {
              get(target, property) {
                const member = Reflect.get(target, property);
                if (!["put", "get", "getAll", "delete", "clear"].includes(String(property))) return member;
                return (...args: unknown[]) => {
                  if (finished) throw new DOMException("Transaction inactive", "TransactionInactiveError");
                  pendingRequests += 1;
                  const request = Reflect.apply(member, target, args) as MockReq;
                  let consumerSuccess: MockReq["onsuccess"] = null;
                  let consumerError: MockReq["onerror"] = null;
                  Object.defineProperties(request, {
                    onsuccess: {
                      configurable: true,
                      get: () => (event: { target: MockReq }) => {
                        if (finished) return;
                        consumerSuccess?.(event);
                        pendingRequests -= 1;
                        scheduleCompletion();
                      },
                      set: (handler: MockReq["onsuccess"]) => { consumerSuccess = handler; },
                    },
                    onerror: {
                      configurable: true,
                      get: () => (event: { target: MockReq }) => {
                        if (finished) return;
                        consumerError?.(event);
                        abortTransaction(request.error);
                      },
                      set: (handler: MockReq["onerror"]) => { consumerError = handler; },
                    },
                  });
                  return request;
                };
              },
            });
          },
          abort: () => abortTransaction(),
        };
        scheduleCompletion();
        return txObj;
      },
      close: () => {},
      onversionchange: null,
      onclose: null,
    };
    return dbObj as unknown as IDBDatabase;
  }
}

class MockIDBFactory {
  databases = new Map<string, MockDatabaseState>();

  open(name: string, requestedVersion = 1): IDBOpenDBRequest {
    let dbState = this.databases.get(name);
    if (!dbState) {
      dbState = new MockDatabaseState();
      this.databases.set(name, dbState);
    }

    const mockDb = dbState.createDbInterface();
    const req: {
      result: IDBDatabase;
      error: DOMException | null;
      onsuccess: ((ev: { target: unknown }) => void) | null;
      onerror: ((ev: { target: unknown }) => void) | null;
      onupgradeneeded: ((ev: { target: unknown; oldVersion: number; newVersion: number }) => void) | null;
      onblocked: (() => void) | null;
    } = {
      result: mockDb,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };

    setTimeout(() => {
      if (requestedVersion > dbState.version) {
        const oldVersion = dbState.version;
        dbState.version = requestedVersion;
        if (req.onupgradeneeded) {
          req.onupgradeneeded({
            target: req,
            oldVersion,
            newVersion: requestedVersion,
          });
        }
      }
      if (req.onsuccess) {
        req.onsuccess({ target: req });
      }
    }, 0);

    return req as unknown as IDBOpenDBRequest;
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe("Milestone M5 Storage & Persistence", () => {
  let mockFactory: MockIDBFactory;
  let mockLocalStorageMap: Map<string, string>;
  let mockLocalStorage: Storage;

  beforeEach(() => {
    closeProjectDb();
    mockFactory = new MockIDBFactory();
    setIndexedDBFactory(mockFactory as unknown as IDBFactory);

    mockLocalStorageMap = new Map();
    mockLocalStorage = {
      getItem: (key: string) => mockLocalStorageMap.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mockLocalStorageMap.set(key, value);
      },
      removeItem: (key: string) => {
        mockLocalStorageMap.delete(key);
      },
      clear: () => {
        mockLocalStorageMap.clear();
      },
      key: (i: number) => Array.from(mockLocalStorageMap.keys())[i] ?? null,
      get length() {
        return mockLocalStorageMap.size;
      },
    };
    setSettingsStorage(mockLocalStorage);
    setProfileStorage(null);
  });

  afterEach(() => {
    closeProjectDb();
    setIndexedDBFactory(null);
    setSettingsStorage(null);
    setProfileStorage(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // 1. DB Schema Upgrade from v1 to v2
  // --------------------------------------------------------------------------
  describe("DB Schema Upgrade (v1 -> v2)", () => {
    it("preserves existing projects and initializes new stores (profiles, settings, session)", async () => {
      // Simulate existing v1 database with a project
      const existingDbState = new MockDatabaseState();
      existingDbState.version = 1;
      const v1ProjectsStore = new MockIDBStore(PROJECTS_STORE, "projectId");
      const existingDoc = createValidSongDocument("proj_v1_legacy");
      const legacyProject: SavedProject = {
        projectId: "proj_v1_legacy",
        name: "Legacy v1 Project",
        updatedAt: 1700000000,
        document: existingDoc,
      };
      v1ProjectsStore.records.set(legacyProject.projectId, legacyProject);
      existingDbState.stores.set(PROJECTS_STORE, v1ProjectsStore);
      mockFactory.databases.set(DB_NAME, existingDbState);

      expect(existingDbState.version).toBe(1);
      expect(existingDbState.stores.has(PROJECTS_STORE)).toBe(true);
      expect(existingDbState.stores.has(PROFILES_STORE)).toBe(false);
      expect(existingDbState.stores.has(SETTINGS_STORE)).toBe(false);
      expect(existingDbState.stores.has(SESSION_STORE)).toBe(false);

      // Trigger upgrade by opening with DB_VERSION = 2
      const db = await openProjectDb();
      expect(db).toBeDefined();
      expect(existingDbState.version).toBe(DB_VERSION);
      expect(DB_VERSION).toBe(2);

      // Verify all new stores exist
      expect(existingDbState.stores.has(PROJECTS_STORE)).toBe(true);
      expect(existingDbState.stores.has(PROFILES_STORE)).toBe(true);
      expect(existingDbState.stores.has(SETTINGS_STORE)).toBe(true);
      expect(existingDbState.stores.has(SESSION_STORE)).toBe(true);

      // Verify existing project was preserved untouched
      const retrieved = await getProject("proj_v1_legacy");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.projectId).toBe("proj_v1_legacy");
      expect(retrieved?.name).toBe("Legacy v1 Project");
      expect(retrieved?.document.title).toBe("M5 Test Sonata");
    });
  });

  describe("CLI-1 settled project reads", () => {
    it("rejects a malformed stored record and reads the repaired record afterwards", async () => {
      const document = createValidSongDocument("proj_cli1");
      const project: SavedProject = {
        projectId: document.projectId,
        name: "CLI-1 project",
        updatedAt: 1,
        document,
      };
      await saveProject(project);

      const store = mockFactory.databases.get(DB_NAME)!.stores.get(PROJECTS_STORE)!;
      const validRecord = store.records.get(project.projectId);
      expect(validRecord).toBeDefined();

      store.records.set(project.projectId, { projectId: project.projectId, name: "Broken record" });
      await expect(getProject(project.projectId)).rejects.toThrow();

      // The rejected read must not poison the database: restoring the valid
      // record lets the next read succeed.
      store.records.set(project.projectId, validRecord);
      await expect(getProject(project.projectId)).resolves.toMatchObject({
        projectId: project.projectId,
        name: "CLI-1 project",
      });
    });
  });

  describe("Application persistence migration", () => {
    it("migrates legacy profiles and active ID to IndexedDB while retaining localStorage data", async () => {
      const legacyProfile = createValidProfile("legacy-pianist");
      vi.stubGlobal("localStorage", mockLocalStorage);
      mockLocalStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify([legacyProfile]));
      mockLocalStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, legacyProfile.profileId);

      await initializeProfiles();

      expect((await getProfile(legacyProfile.profileId))?.name).toBe(legacyProfile.name);
      expect(getActiveProfile().profileId).toBe(legacyProfile.profileId);
      expect(await getDbSetting(ACTIVE_PROFILE_DB_KEY)).toBe(legacyProfile.profileId);
      expect(mockLocalStorage.getItem(PROFILES_STORAGE_KEY)).toBe(JSON.stringify([legacyProfile]));
      expect(mockLocalStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY)).toBe(legacyProfile.profileId);
    });

    it("merges profiles left by an interrupted migration without replacing IndexedDB or canonical data", async () => {
      const currentProfile = { ...createValidProfile("migration-existing"), name: "Current IndexedDB profile" };
      const staleLegacyCopy = { ...currentProfile, name: "Stale localStorage copy" };
      const missingLegacyProfile = createValidProfile("migration-missing");
      const legacyCanonicalOverride = { ...createValidProfile("default"), name: "Legacy default override" };
      await saveProfile(currentProfile);
      vi.stubGlobal("localStorage", mockLocalStorage);
      mockLocalStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify([
        staleLegacyCopy,
        missingLegacyProfile,
        legacyCanonicalOverride,
      ]));
      mockLocalStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, missingLegacyProfile.profileId);

      await initializeProfiles();

      expect((await getProfile(currentProfile.profileId))?.name).toBe("Current IndexedDB profile");
      expect((await getProfile(missingLegacyProfile.profileId))?.name).toBe(missingLegacyProfile.name);
      expect(getActiveProfile().profileId).toBe(missingLegacyProfile.profileId);
      expect(listProfiles().find((profile) => profile.profileId === "default")?.name).not.toBe("Legacy default override");
    });

    it("does not report a profile save or change memory when IndexedDB rejects the write", async () => {
      await initializeProfiles();
      const profile = { ...getActiveProfile(), profileId: "quota-test-profile", revision: 0 };
      mockFactory.databases.get(DB_NAME)!.stores.get(PROFILES_STORE)!.simulateQuotaError = true;

      await expect(saveProfileThroughStore(profile)).rejects.toBeInstanceOf(StorageQuotaExceededError);
      expect(listProfiles().some((entry) => entry.profileId === profile.profileId)).toBe(false);
    });
  });

  describe("Saved project artifact roundtrip", () => {
    it("preserves original MIDI bytes, descriptor, profile, and linked plans in IndexedDB", async () => {
      const document = createValidSongDocument("proj_artifact_roundtrip");
      document.sourceMidiResourceId = "m5-source-midi";
      const profile = createValidProfile("m5-active-profile");
      const engineVersion = "a".repeat(64);
      const fingeringPlan = {
        schemaVersion: SCHEMA_VERSION,
        planId: "m5-fingering-plan",
        projectId: document.projectId,
        inputRevision: document.revision,
        profileId: profile.profileId,
        profileRevision: profile.revision,
        engineVersion,
        kind: "fingering" as const,
        diagnostics: [],
        assignments: [{ noteId: "note_1", hand: "right" as const, finger: 1, disposition: "played" as const }],
      };
      const performancePlan = {
        schemaVersion: SCHEMA_VERSION,
        planId: "m5-performance-plan",
        projectId: document.projectId,
        inputRevision: document.revision,
        profileId: profile.profileId,
        profileRevision: profile.revision,
        engineVersion,
        kind: "performance" as const,
        diagnostics: [],
        fingeringPlanId: fingeringPlan.planId,
        events: [
          { type: "press" as const, timeSeconds: 0.6, noteId: "note_1", pitch: 60, velocity: 80 },
          { type: "release" as const, timeSeconds: 0.9, noteId: "note_1" },
        ],
      };
      const rawMidiBytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 1, 2, 3]).buffer;
      const resource = {
        resourceId: "m5-source-midi",
        purpose: "source-midi" as const,
        mediaType: "audio/midi",
        byteLength: rawMidiBytes.byteLength,
        sha256: await computeSha256Hex(rawMidiBytes),
        path: "resources/source.mid",
      };
      const project: SavedProject = {
        projectId: document.projectId,
        name: "Artifact Roundtrip",
        updatedAt: 1700000000,
        document,
        fingeringPlan,
        performancePlan,
        profile,
        rawMidiBytes,
        resources: [resource],
        resourcePayloads: { [resource.path]: rawMidiBytes.slice(0) },
      };

      await saveProject(project);
      const loaded = await getProject(project.projectId);

      expect(loaded?.profile).toEqual(profile);
      expect(loaded?.fingeringPlan).toEqual(fingeringPlan);
      expect(loaded?.performancePlan).toEqual(performancePlan);
      expect(loaded?.resources).toEqual([resource]);
      expect(Array.from(new Uint8Array(loaded!.rawMidiBytes!))).toEqual(Array.from(new Uint8Array(rawMidiBytes)));
      expect(Array.from(new Uint8Array(loaded!.resourcePayloads![resource.path]!))).toEqual(Array.from(new Uint8Array(rawMidiBytes)));
    });
  });

  // --------------------------------------------------------------------------
  // 2. Custom PianistProfile Persistence
  // --------------------------------------------------------------------------
  describe("PianistProfile Persistence in IndexedDB", () => {
    it("saves, retrieves, lists, and deletes custom profiles", async () => {
      const p1 = createValidProfile("prof_custom_alpha", 100);
      const p2 = createValidProfile("prof_custom_beta", 200);

      // Save profiles
      await saveProfile(p1);
      await saveProfile(p2);

      // Retrieve by ID
      const loadedAlpha = await getProfile("prof_custom_alpha");
      expect(loadedAlpha).not.toBeNull();
      expect(loadedAlpha?.name).toBe(p1.name);
      expect(loadedAlpha?.anatomy.reachSpanInches).toBe(8.5);

      const loadedBeta = await getProfile("prof_custom_beta");
      expect(loadedBeta).not.toBeNull();
      expect(loadedBeta?.name).toBe(p2.name);

      // Non-existent profile
      const nonExistent = await getProfile("prof_does_not_exist");
      expect(nonExistent).toBeNull();

      // List profiles sorted by modifiedAtUnixSeconds descending (beta newer than alpha)
      const list = await listCustomProfiles();
      expect(list.length).toBe(2);
      expect(list[0]?.profileId).toBe("prof_custom_beta");
      expect(list[1]?.profileId).toBe("prof_custom_alpha");

      // Delete profile
      await deleteProfile("prof_custom_alpha");
      expect(await getProfile("prof_custom_alpha")).toBeNull();

      const listAfterDelete = await listCustomProfiles();
      expect(listAfterDelete.length).toBe(1);
      expect(listAfterDelete[0]?.profileId).toBe("prof_custom_beta");

      // Clear all profiles
      await clearAllProfiles();
      expect(await listCustomProfiles()).toEqual([]);
    });

    it("rejects invalid profiles that violate PianistProfileSchema", async () => {
      const invalidProfile = {
        schemaVersion: SCHEMA_VERSION,
        profileId: "invalid_prof",
        revision: 0,
        name: "Invalid Anatomy Profile",
        colorRgb: [0, 0, 0],
        anatomy: {
          reachSpanInches: -5, // must be positive according to superRefine
        },
        behavior: {},
        skin: {},
        weights: {},
        createdAtUnixSeconds: 100,
        modifiedAtUnixSeconds: 100,
      } as unknown as PianistProfile;

      await expect(saveProfile(invalidProfile)).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Autosave Session Snapshot & Debounce Service
  // --------------------------------------------------------------------------
  describe("Autosave Session Snapshot & AutosaveService", () => {
    it("saves, loads, and clears session snapshots", async () => {
      const doc = createValidSongDocument("proj_autosave_1");
      const snapshot: SessionSnapshot = {
        projectId: "proj_autosave_1",
        updatedAt: 1700500000,
        document: doc,
        activeProfileId: "prof_custom_alpha",
        viewMode: "performance",
        sceneView: { dimension: "3d", cameraPreset: "side_arch" },
      };

      // Initially null
      const initial = await loadSessionSnapshot();
      expect(initial).toBeNull();

      // Save snapshot
      await saveSessionSnapshot(snapshot);

      // Load snapshot
      const loaded = await loadSessionSnapshot();
      expect(loaded).not.toBeNull();
      expect(loaded?.projectId).toBe("proj_autosave_1");
      expect(loaded?.viewMode).toBe("performance");
      expect(loaded?.sceneView).toEqual({ dimension: "3d", cameraPreset: "side_arch" });
      expect(loaded?.activeProfileId).toBe("prof_custom_alpha");
      expect(loaded?.document?.title).toBe("M5 Test Sonata");
      const assessment = await assessSessionSnapshot(loaded, "engine-current");
      expect(assessment.status).toBe("incompatible");
      if (assessment.status === "incompatible") {
        expect(assessment.snapshot.document?.projectId).toBe("proj_autosave_1");
      }
      expect((await loadSessionSnapshot())?.document?.projectId).toBe("proj_autosave_1");
      const legacyBytes = new Uint8Array([0x4d, 0x54, 0x68]).buffer;
      const legacyHash = await computeSha256Hex(legacyBytes);
      const bytesOnlyAssessment = await assessSessionSnapshot({
        ...loaded,
        rawMidiBytes: legacyBytes,
        sourceDescriptor: {
          resourceId: "legacy-source-midi",
          purpose: "source-midi",
          mediaType: "audio/midi",
          byteLength: legacyBytes.byteLength,
          sha256: legacyHash,
          path: "resources/source.mid",
        },
      }, "engine-current");
      expect(bytesOnlyAssessment.status).toBe("incompatible");
      expect(bytesOnlyAssessment.reasons.join(" ")).toMatch(/re-import/i);

      // Clear snapshot
      await clearSessionSnapshot();
      const cleared = await loadSessionSnapshot();
      expect(cleared).toBeNull();
    });

    it("debounces rapid autosave requests and saves the latest snapshot", async () => {
      const doc = createValidSongDocument("proj_debounce_1");
      const service = new AutosaveService({ delayMs: 40 });

      const snap1: SessionSnapshot = {
        projectId: "proj_debounce_1",
        updatedAt: 1000,
        document: { ...doc, title: "Draft 1" },
      };
      const snap2: SessionSnapshot = {
        projectId: "proj_debounce_1",
        updatedAt: 2000,
        document: { ...doc, title: "Draft 2" },
      };
      const snap3: SessionSnapshot = {
        projectId: "proj_debounce_1",
        updatedAt: 3000,
        document: { ...doc, title: "Draft 3 - Final" },
        viewMode: "split",
      };

      service.schedule(snap1);
      expect(service.isPending()).toBe(true);
      service.schedule(snap2);
      service.schedule(snap3);

      expect(service.getPendingSnapshot()?.document?.title).toBe("Draft 3 - Final");

      // Flush to commit
      await service.flush();
      expect(service.isPending()).toBe(false);

      const loaded = await service.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.document?.title).toBe("Draft 3 - Final");
      expect(loaded?.viewMode).toBe("split");

      // Clear through service
      await service.clear();
      expect(await loadSessionSnapshot()).toBeNull();
    });

    it("serializes overlapping flushes and persists the newest scheduled draft", async () => {
      await openProjectDb();
      const sessionStore = mockFactory.databases.get(DB_NAME)?.stores.get(SESSION_STORE);
      expect(sessionStore).toBeDefined();
      if (!sessionStore) return;
      sessionStore.putDelaysMs = [60, 0];

      const doc = createValidSongDocument("proj_flush_race");
      const service = new AutosaveService({ delayMs: 1000 });
      service.schedule({ projectId: doc.projectId, updatedAt: 1000, document: { ...doc, title: "First" } });
      const firstFlush = service.flush();
      await vi.waitFor(() => expect(sessionStore.putCount).toBe(1));

      service.schedule({ projectId: doc.projectId, updatedAt: 2000, document: { ...doc, title: "Newest" } });
      const secondFlush = service.flush();
      await Promise.all([firstFlush, secondFlush]);

      expect((await loadSessionSnapshot())?.document?.title).toBe("Newest");
      expect(sessionStore.putCount).toBe(2);
    });

    it("rejects mismatched source bytes and classifies a stored mismatch as corrupt", async () => {
      const doc = createValidSongDocument("proj_bad_source");
      const rawMidiBytes = new Uint8Array([0x4d, 0x54, 0x68]).buffer;
      const sourceDescriptor = {
        resourceId: "source-midi/bad-source",
        purpose: "source-midi" as const,
        mediaType: "audio/midi",
        byteLength: 3,
        sha256: "0".repeat(64),
        path: "resources/source.mid",
      };
      const snapshot = {
        projectId: doc.projectId,
        updatedAt: 1000,
        document: doc,
        rawMidiBytes,
        sourceDescriptor,
      } satisfies SessionSnapshot;

      await expect(saveSessionSnapshot(snapshot)).rejects.toThrow(/source bytes do not match/i);
      expect(await loadSessionSnapshot()).toBeNull();
      const assessment = await assessSessionSnapshot(snapshot, "engine-current");
      expect(assessment.status).toBe("corrupt");
    });

    it("restores a coherent full snapshot and marks engine changes for recomputation", async () => {
      const projectId = "proj_full_session";
      const document = createValidSongDocument(projectId);
      document.notes = [];
      document.sourceMidiResourceId = "full-session-midi";
      const profile = createValidProfile("full-session-profile");
      const engineVersion = "b".repeat(64);
      const rawMidiBytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 1]).buffer;
      const sha256 = await computeSha256Hex(rawMidiBytes);
      const resource = {
        resourceId: "full-session-midi",
        purpose: "source-midi" as const,
        mediaType: "audio/midi",
        byteLength: rawMidiBytes.byteLength,
        sha256,
        path: "resources/source.mid",
      };
      const planIdentity = {
        schemaVersion: SCHEMA_VERSION,
        projectId,
        inputRevision: document.revision,
        profileId: profile.profileId,
        profileRevision: profile.revision,
        engineVersion,
        diagnostics: [],
      };
      const fingeringPlan = {
        ...planIdentity,
        planId: "full-session-fingering",
        kind: "fingering" as const,
        assignments: [],
      };
      const performancePlan = {
        ...planIdentity,
        planId: "full-session-performance",
        kind: "performance" as const,
        fingeringPlanId: fingeringPlan.planId,
        events: [],
      };
      const result = M1AnalyzeMidiResultSchema.parse({
        type: "analysis-result",
        requestId: "full-session-request",
        projectId,
        revision: document.revision,
        engineVersion,
        status: "loaded",
        profile,
        resource,
        document,
        fingeringPlan,
        performancePlan,
        motionPlan: null,
        diagnostics: [],
        rawBaseline: {
          fixtureId: "session-fixture",
          inputSha256: sha256,
          status: "loaded",
          duration: 60,
          sourceNotes: [],
          sourcePedals: [],
          sourceParseErrors: [],
          desktopNotes: [],
          assignments: [],
          performanceEvents: [],
          pedals: [],
          rawPedals: [],
          selectedPoses: [],
          cleanup: [],
          unmappedSourceNoteIds: [],
          tracks: [],
          hands: [],
          crossingEpisodes: [],
          identityLosses: [],
          identityMappings: [],
          sourceNoteIdentitySemantics: "Stable IDs are preserved from the original MIDI.",
          provenance: {
            profile: "session fixture profile DTO",
            engineVersion,
            desktopSourceCommit: "f".repeat(40),
            desktopVersion: "v1",
            adaptedFiles: { "test.py": "c".repeat(64) },
            keyStyle: "realistic",
            rawEventCount: 0,
          },
          goldenTrust: "contract test fixture",
        },
      });
      const snapshot: SessionSnapshot = {
        projectId,
        updatedAt: 2000,
        result,
        document,
        rawMidiBytes,
        profile,
        activeProfileId: profile.profileId,
        draftFingeringPlan: fingeringPlan,
        fingeringPlan,
        plansState: "valid",
        keyStyle: "realistic",
        viewMode: "split",
      };

      await saveSessionSnapshot(snapshot);
      const loaded = await loadSessionSnapshot();
      expect(loaded?.result).toEqual(result);
      expect(loaded?.profile).toEqual(profile);
      expect(loaded?.viewMode).toBe("split");
      expect(Array.from(new Uint8Array(loaded!.rawMidiBytes!))).toEqual(Array.from(new Uint8Array(rawMidiBytes)));
      expect((await assessSessionSnapshot(loaded, engineVersion)).status).toBe("compatible");
      expect((await assessSessionSnapshot(loaded, "d".repeat(64))).status).toBe("recompute-required");

      const badBytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 2]).buffer;
      const corrupted = { ...snapshot, rawMidiBytes: badBytes };
      await expect(saveSessionSnapshot(corrupted)).rejects.toThrow(/source bytes do not match/i);
      expect((await assessSessionSnapshot(corrupted, engineVersion)).status).toBe("corrupt");
      expect(Array.from(new Uint8Array((await loadSessionSnapshot())!.rawMidiBytes!))).toEqual(Array.from(new Uint8Array(rawMidiBytes)));
    });
  });

  // --------------------------------------------------------------------------
  // 4. Quota Error Handling Safety
  // --------------------------------------------------------------------------
  describe("Quota Error Handling Safety", () => {
    it("accurately detects quota exceeded errors across standard and legacy formats", () => {
      expect(isQuotaExceededError(new StorageQuotaExceededError())).toBe(true);
      expect(isQuotaExceededError(new DOMException("Quota exceeded", "QuotaExceededError"))).toBe(true);
      expect(isQuotaExceededError({ name: "QuotaExceededError" })).toBe(true);
      expect(isQuotaExceededError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
      expect(isQuotaExceededError({ code: 22 })).toBe(true);
      expect(isQuotaExceededError({ code: 1014 })).toBe(true);
      expect(isQuotaExceededError({ message: "IndexedDB quota has been exceeded on device" })).toBe(true);

      // Normal errors should not be flagged as quota errors
      expect(isQuotaExceededError(new Error("File not found"))).toBe(false);
      expect(isQuotaExceededError(null)).toBe(false);
      expect(isQuotaExceededError(undefined)).toBe(false);
    });

    it("wraps write QuotaExceededError in StorageQuotaExceededError without crashing", async () => {
      // Ensure database is initialized
      await openProjectDb();
      const dbState = mockFactory.databases.get(DB_NAME);
      expect(dbState).toBeDefined();

      // Configure projects store to simulate quota exceeded
      const projectsStore = dbState?.stores.get(PROJECTS_STORE);
      expect(projectsStore).toBeDefined();
      if (projectsStore) {
        projectsStore.simulateQuotaError = true;
      }

      const doc = createValidSongDocument("p_quota_test");
      const project: SavedProject = {
        projectId: "p_quota_test",
        name: "Quota Project",
        updatedAt: Date.now(),
        document: doc,
      };

      await expect(saveProject(project)).rejects.toThrow(StorageQuotaExceededError);

      // Configure profiles store to simulate quota error
      const profilesStore = dbState?.stores.get(PROFILES_STORE);
      if (profilesStore) {
        profilesStore.simulateQuotaError = true;
      }
      const profile = createValidProfile("prof_quota");
      await expect(saveProfile(profile)).rejects.toThrow(StorageQuotaExceededError);

      // Configure session store to simulate quota error
      const sessionStore = dbState?.stores.get(SESSION_STORE);
      if (sessionStore) {
        sessionStore.simulateQuotaError = true;
      }
      const snapshot: SessionSnapshot = {
        projectId: "p_quota_test",
        updatedAt: Date.now(),
        document: doc,
      };
      await expect(saveSessionSnapshot(snapshot)).rejects.toThrow(StorageQuotaExceededError);
    });

    it("AutosaveService catches quota errors gracefully and notifies onError without unhandled rejection", async () => {
      await openProjectDb();
      const dbState = mockFactory.databases.get(DB_NAME);
      const sessionStore = dbState?.stores.get(SESSION_STORE);
      if (sessionStore) {
        sessionStore.simulateQuotaError = true;
      }

      const errorHandler = vi.fn();
      const service = new AutosaveService({
        delayMs: 10,
        onError: errorHandler,
      });

      const doc = createValidSongDocument("proj_err_safe");
      service.schedule({
        projectId: "proj_err_safe",
        updatedAt: Date.now(),
        document: doc,
      });

      // Flushing should trigger onError callback rather than throwing an unhandled rejection
      await expect(service.flush()).resolves.toBeUndefined();
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler.mock.calls[0]?.[0]).toBeInstanceOf(StorageQuotaExceededError);
      // A release/update barrier must observe even a previously reported failure.
      await expect(service.flush({ throwOnError: true })).rejects.toThrow(StorageQuotaExceededError);
    });

    it("getStorageQuota uses navigator.storage.estimate when available and handles missing API", async () => {
      // Test when navigator.storage is missing
      const originalNavigator = globalThis.navigator;
      Object.defineProperty(globalThis, "navigator", {
        value: {},
        configurable: true,
      });

      const quotaWhenMissing = await getStorageQuota();
      expect(quotaWhenMissing).toBeNull();

      // Test when navigator.storage.estimate is available
      Object.defineProperty(globalThis, "navigator", {
        value: {
          storage: {
            estimate: vi.fn().mockResolvedValue({
              usage: 250_000_000,
              quota: 1_000_000_000,
            }),
          },
        },
        configurable: true,
      });

      const quota = await getStorageQuota();
      expect(quota).toEqual({
        usageBytes: 250_000_000,
        quotaBytes: 1_000_000_000,
        percentUsed: 25,
      });

      // Restore navigator
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
      });
    });
  });

  // --------------------------------------------------------------------------
  // 5. Settings Store Local Persistence & Reset to Defaults
  // --------------------------------------------------------------------------
  describe("SettingsStore Persistence & Reactive Behavior", () => {
    it("initializes with DEFAULT_SETTINGS and provides all required default values", () => {
      const store = new SettingsStore();
      const s = store.getSettings();

      expect(s.keyStyle).toBe("realistic");
      expect(s.playbackSpeed).toBe(1.0);
      expect(s.masterVolume).toBe(0.8);
      expect(s.leadInSeconds).toBe(-2.0);
      expect(s.showFpsOverlay).toBe(false);
      expect(s.showFingerLabels).toBe(false);
      expect(s.showNoteNames).toBe(false);
      expect(s.soundTimbre).toBe("acoustic");
      expect(s.renderCapFps).toBe(60);
      expect(s).toEqual(DEFAULT_SETTINGS);
    });

    it("persists updates to localStorage under handthesia:settings and notifies subscribers", () => {
      const store = new SettingsStore();
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);

      const updated = store.updateSettings({
        masterVolume: 0.65,
        soundTimbre: "warm",
        renderCapFps: 120,
        showFpsOverlay: true,
      });

      expect(updated.masterVolume).toBe(0.65);
      expect(updated.soundTimbre).toBe("warm");
      expect(updated.renderCapFps).toBe(120);
      expect(updated.showFpsOverlay).toBe(true);

      // Verify localStorage was written
      const rawStored = mockLocalStorageMap.get(SETTINGS_STORAGE_KEY);
      expect(rawStored).toBeDefined();
      const parsedStored = JSON.parse(rawStored!);
      expect(parsedStored.masterVolume).toBe(0.65);
      expect(parsedStored.soundTimbre).toBe("warm");

      // Verify listener was called with new snapshot
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ masterVolume: 0.65 }));

      // Unsubscribe stops future notifications
      unsubscribe();
      store.updateSettings({ masterVolume: 0.4 });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("restores settings accurately when instantiating a new store instance", () => {
      const store1 = new SettingsStore();
      store1.updateSettings({
        keyStyle: "equal",
        playbackSpeed: 1.5,
        showNoteNames: true,
      });

      // Create new instance reading the same localStorage
      const store2 = new SettingsStore();
      const s2 = store2.getSettings();
      expect(s2.keyStyle).toBe("equal");
      expect(s2.playbackSpeed).toBe(1.5);
      expect(s2.showNoteNames).toBe(true);
      expect(s2.soundTimbre).toBe("acoustic"); // preserved default
    });

    it("clamps numeric values and sanitizes invalid inputs to valid bounds", () => {
      const store = new SettingsStore();

      store.updateSettings({
        playbackSpeed: 99.0, // max is 2.0
        masterVolume: -5.0,  // min is 0.0
        leadInSeconds: 10.0, // max is 0.0
        soundTimbre: "invalid_timbre" as unknown as "acoustic",
        renderCapFps: 45,    // invalid, should fallback to 60
      });

      const s = store.getSettings();
      expect(s.playbackSpeed).toBe(2.0);
      expect(s.masterVolume).toBe(0.0);
      expect(s.leadInSeconds).toBe(0.0);
      expect(s.soundTimbre).toBe("acoustic");
      expect(s.renderCapFps).toBe(60);
    });

    it("recovers gracefully from corrupted JSON in localStorage", () => {
      mockLocalStorageMap.set(SETTINGS_STORAGE_KEY, "{ corrupted JSON text <<<");
      const store = new SettingsStore();
      expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it("resetToDefaults resets settings back to defaults, updates storage, and notifies listeners", () => {
      const store = new SettingsStore();
      store.updateSettings({
        playbackSpeed: 1.75,
        masterVolume: 0.2,
        showFpsOverlay: true,
      });

      const listener = vi.fn();
      store.subscribe(listener);

      const resetSettings = store.resetToDefaults();
      expect(resetSettings).toEqual(DEFAULT_SETTINGS);
      expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);

      const stored = JSON.parse(mockLocalStorageMap.get(SETTINGS_STORAGE_KEY)!);
      expect(stored).toEqual(DEFAULT_SETTINGS);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(DEFAULT_SETTINGS);
    });

    it("migrates legacy settings into IndexedDB without removing the old value", async () => {
      const legacy = { ...DEFAULT_SETTINGS, keyStyle: "equal" as const, playbackSpeed: 1.5 };
      mockLocalStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(legacy));
      const store = new SettingsStore();

      await store.initialize();

      expect(store.getSettings()).toEqual(legacy);
      expect(await getDbSetting(SETTINGS_DB_KEY)).toEqual(legacy);
      expect(mockLocalStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(JSON.stringify(legacy));
    });

    it("propagates IndexedDB write failures without publishing an unsaved setting", async () => {
      const store = new SettingsStore();
      await initializeSettings();
      await store.initialize();
      const before = store.getSettings();
      mockFactory.databases.get(DB_NAME)!.stores.get(SETTINGS_STORE)!.simulateQuotaError = true;

      await expect(store.updateSettingsPersisted({ masterVolume: 0.23 })).rejects.toBeInstanceOf(StorageQuotaExceededError);
      expect(store.getSettings()).toEqual(before);
    });
  });
});
