import { describe, it, expect, beforeEach } from "vitest";
import {
  SCHEMA_VERSION,
  PACKAGE_VERSION,
  type SongDocument,
  type PianistProfile,
  type FingeringPlan,
  type PerformancePlan,
  type ResourceDescriptor,
} from "@handthesia/contracts";
import {
  saveProject,
  getProject,
  listProjects,
  deleteProject,
  clearAllProjects,
  setIndexedDBFactory,
  type SavedProject,
  validateSavedProject,
} from "./projectDb.ts";
import {
  getRecentProjectIds,
  addRecentProjectId,
  removeRecentProjectId,
  clearRecentProjects,
  setRecentStorage,
  RECENT_MAX,
} from "./recent.ts";
import {
  computeSha256Hex,
  buildProjectPackage,
  buildProjectPackageSync,
  exportProjectPackageJson,
  parseProjectPackageJson,
  validateProjectPackage,
  projectPackageToSavedProject,
  importProjectOrPackage,
} from "./packageExporter.ts";
import {
  validateMidiFile,
  validateMidiFileList,
  hasMidiExtension,
  getFileExtension,
  isDragEventWithFiles,
  extractMidiFileFromDrop,
  validateMidiFileInput,
  MAX_MIDI_FILE_SIZE_BYTES,
} from "./fileValidator.ts";

function createValidSongDocument(projectId = "proj_test_1"): SongDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    revision: 0,
    title: "Test Sonata",
    durationSeconds: 120,
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

function createValidProfile(profileId = "profile_default"): PianistProfile {
  return {
    schemaVersion: SCHEMA_VERSION,
    profileId,
    revision: 0,
    name: "Default Profile",
    colorRgb: [0, 120, 215],
    anatomy: {
      reachSpanInches: 8.5,
    },
    behavior: {
      legatoSensitivity: 1.0,
    },
    skin: {},
    weights: {
      fatigue: 0.1,
    },
    createdAtUnixSeconds: 1700000000,
    modifiedAtUnixSeconds: 1700000000,
  };
}

function createPlans(document: SongDocument, profile: PianistProfile): { fingeringPlan: FingeringPlan; performancePlan: PerformancePlan } {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    projectId: document.projectId,
    inputRevision: document.revision,
    profileId: profile.profileId,
    profileRevision: profile.revision,
    engineVersion: "a".repeat(64),
    diagnostics: [],
  };
  const fingeringPlan: FingeringPlan = {
    ...base,
    planId: "fingering_plan_1",
    kind: "fingering",
    assignments: document.notes.map((note) => ({
      noteId: note.noteId,
      hand: note.hand,
      finger: note.finger ?? 1,
      disposition: note.glissando ? "glissando" as const : "played" as const,
    })),
  };
  const performancePlan: PerformancePlan = {
    ...base,
    planId: "performance_plan_1",
    kind: "performance",
    fingeringPlanId: fingeringPlan.planId,
    events: document.notes.flatMap((note) => [
      { type: "press" as const, timeSeconds: note.startSeconds, noteId: note.noteId, pitch: note.pitch, velocity: note.velocity },
      { type: "release" as const, timeSeconds: note.endSeconds, noteId: note.noteId },
    ]).sort((a, b) => a.timeSeconds - b.timeSeconds || (a.type === "release" ? -1 : 1)),
  };
  return { fingeringPlan, performancePlan };
}

describe("recent.ts", () => {
  let mockMap: Map<string, string>;
  let mockStorage: Storage;

  beforeEach(() => {
    mockMap = new Map();
    mockStorage = {
      getItem: (key: string) => mockMap.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mockMap.set(key, value);
      },
      removeItem: (key: string) => {
        mockMap.delete(key);
      },
      clear: () => {
        mockMap.clear();
      },
      key: (i: number) => Array.from(mockMap.keys())[i] ?? null,
      get length() {
        return mockMap.size;
      },
    };
    setRecentStorage(mockStorage);
    clearRecentProjects();
  });

  it("returns empty array initially", () => {
    expect(getRecentProjectIds()).toEqual([]);
  });

  it("adds and moves most recent project ID to the top", () => {
    addRecentProjectId("p1");
    addRecentProjectId("p2");
    expect(getRecentProjectIds()).toEqual(["p2", "p1"]);

    // Adding p1 again moves it to top
    addRecentProjectId("p1");
    expect(getRecentProjectIds()).toEqual(["p1", "p2"]);
  });

  it("limits recent list to RECENT_MAX (5 items)", () => {
    addRecentProjectId("p1");
    addRecentProjectId("p2");
    addRecentProjectId("p3");
    addRecentProjectId("p4");
    addRecentProjectId("p5");
    addRecentProjectId("p6");

    const recent = getRecentProjectIds();
    expect(recent.length).toBe(RECENT_MAX);
    expect(recent).toEqual(["p6", "p5", "p4", "p3", "p2"]);
  });

  it("removes project IDs correctly", () => {
    addRecentProjectId("p1");
    addRecentProjectId("p2");
    addRecentProjectId("p3");

    removeRecentProjectId("p2");
    expect(getRecentProjectIds()).toEqual(["p3", "p1"]);
  });

  it("clears all recent project IDs", () => {
    addRecentProjectId("p1");
    addRecentProjectId("p2");
    clearRecentProjects();
    expect(getRecentProjectIds()).toEqual([]);
  });

  it("ignores empty or invalid project IDs", () => {
    addRecentProjectId("");
    addRecentProjectId("   ");
    expect(getRecentProjectIds()).toEqual([]);
  });
});

describe("packageExporter.ts", () => {
  it("computes standard SHA-256 hex correctly", async () => {
    // SHA-256 of empty buffer is known standard constant
    const empty = new ArrayBuffer(0);
    const hash = await computeSha256Hex(empty);
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    // SHA-256 of "hello" (ASCII bytes: 104, 101, 108, 108, 111)
    const helloBytes = new Uint8Array([104, 101, 108, 108, 111]);
    const helloHash = await computeSha256Hex(helloBytes.buffer);
    expect(helloHash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("builds a valid ProjectPackage conforming to ProjectPackageSchema", async () => {
    const document = createValidSongDocument("proj_export_1");
    const project: SavedProject = {
      projectId: "proj_export_1",
      name: "Sonata 1",
      updatedAt: 1700000000,
      document,
    };

    const pkg = await buildProjectPackage(project);
    expect(pkg.packageVersion).toBe(PACKAGE_VERSION);
    expect(pkg.projectId).toBe("proj_export_1");
    expect(pkg.document.title).toBe("Test Sonata");
    expect(pkg.profiles).toEqual([]);
    expect(pkg.resources).toEqual([]);

    const validated = validateProjectPackage(pkg);
    expect(validated.projectId).toBe("proj_export_1");
  });

  it("auto-synthesizes source-midi resource if document references it and rawMidiBytes are provided", async () => {
    const document = createValidSongDocument("proj_midi_res");
    document.sourceMidiResourceId = "res_midi_1";

    const midiBuffer = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06]).buffer;
    const project: SavedProject = {
      projectId: "proj_midi_res",
      name: "Midi Project",
      updatedAt: 1700000000,
      document,
      rawMidiBytes: midiBuffer,
    };

    const pkg = await buildProjectPackage(project);
    expect(pkg.resources.length).toBe(1);
    expect(pkg.resources[0]?.resourceId).toBe("res_midi_1");
    expect(pkg.resources[0]?.purpose).toBe("source-midi");
    expect(pkg.resources[0]?.byteLength).toBe(midiBuffer.byteLength);
    expect(pkg.resources[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(pkg.resourcePayloads?.[pkg.resources[0]!.path]).toBeDefined();
    expect(() => validateProjectPackage({ ...pkg, resourcePayloads: undefined })).toThrow();
  });

  it("round-trips original MIDI bytes, descriptors, active profile, and coherent plans", async () => {
    const projectId = "proj_complete_roundtrip";
    const document = createValidSongDocument(projectId);
    document.sourceMidiResourceId = "source_midi_1";
    const profile = createValidProfile("prof_active");
    const { fingeringPlan, performancePlan } = createPlans(document, profile);
    const rawMidiBytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 1, 2, 3, 4]).buffer;
    const source: ResourceDescriptor = {
      resourceId: "source_midi_1",
      purpose: "source-midi",
      mediaType: "audio/midi",
      byteLength: rawMidiBytes.byteLength,
      sha256: await computeSha256Hex(rawMidiBytes),
      path: "resources/source.mid",
    };
    const project: SavedProject = {
      projectId,
      name: "Complete Roundtrip",
      updatedAt: 1700000000,
      document,
      fingeringPlan,
      performancePlan,
      motionPlan: null,
      rawMidiBytes,
      profile,
      resources: [source],
    };

    const checked = validateSavedProject(project);
    expect(checked.profile?.profileId).toBe(profile.profileId);
    const json = await exportProjectPackageJson(checked);
    const pkg = parseProjectPackageJson(json);
    const restored = projectPackageToSavedProject(pkg);

    expect(restored.profile).toEqual(profile);
    expect(restored.fingeringPlan).toEqual(fingeringPlan);
    expect(restored.performancePlan).toEqual(performancePlan);
    expect(restored.motionPlan).toBeNull();
    expect(restored.resources).toEqual([source]);
    expect(Array.from(new Uint8Array(restored.rawMidiBytes!))).toEqual(Array.from(new Uint8Array(rawMidiBytes)));
    expect(Array.from(new Uint8Array(restored.resourcePayloads![source.path]!))).toEqual(Array.from(new Uint8Array(rawMidiBytes)));
    expect(() => projectPackageToSavedProject(pkg, new Uint8Array([1, 2, 3]).buffer)).toThrow(/do not match the package source/i);
  });

  it("rejects saved plans whose project or input revision is inconsistent", () => {
    const doc = createValidSongDocument("proj_inconsistent");
    const profile = createValidProfile("prof_inconsistent");
    const { fingeringPlan } = createPlans(doc, profile);
    expect(() => validateSavedProject({
      projectId: doc.projectId,
      name: "Invalid links",
      updatedAt: 1,
      document: doc,
      fingeringPlan: { ...fingeringPlan, projectId: "another-project" },
      profile,
    })).toThrow(/project ID and document revision/i);
    expect(() => validateSavedProject({
      projectId: "another-project",
      name: "Invalid document link",
      updatedAt: 1,
      document: doc,
    })).toThrow(/document.projectId/i);
  });

  it("exports package as JSON and imports/validates it back", async () => {
    const document = createValidSongDocument("proj_roundtrip");
    const profile = createValidProfile("prof_custom");
    const project: SavedProject = {
      projectId: "proj_roundtrip",
      name: "Roundtrip Song",
      updatedAt: 1700000000,
      document,
    };

    const json = await exportProjectPackageJson(project, { profiles: [profile] });
    expect(typeof json).toBe("string");

    const imported = parseProjectPackageJson(json);
    expect(imported.projectId).toBe("proj_roundtrip");
    expect(imported.profiles.length).toBe(1);
    expect(imported.profiles[0]?.name).toBe("Default Profile");

    const convertedSaved = projectPackageToSavedProject(imported);
    expect(convertedSaved.projectId).toBe("proj_roundtrip");
    expect(convertedSaved.name).toBe("Test Sonata");
    expect(convertedSaved.document.notes.length).toBe(1);
  });

  it("importProjectOrPackage handles both ProjectPackage and SavedProject schemas", () => {
    const doc = createValidSongDocument("proj_flex");
    const savedProj: SavedProject = {
      projectId: "proj_flex",
      name: "Flex Song",
      updatedAt: 1234567,
      document: doc,
    };

    const resFromSaved = importProjectOrPackage(savedProj);
    expect(resFromSaved.projectId).toBe("proj_flex");

    const syncPkg = buildProjectPackageSync(savedProj);
    const resFromPkg = importProjectOrPackage(syncPkg);
    expect(resFromPkg.projectId).toBe("proj_flex");
  });

  it("rejects invalid package JSON with Zod error", () => {
    expect(() => parseProjectPackageJson('{"invalid": true}')).toThrow();
  });
});

describe("fileValidator.ts", () => {
  it("detects midi extension correctly", () => {
    expect(hasMidiExtension("song.mid")).toBe(true);
    expect(hasMidiExtension("SONG.MIDI")).toBe(true);
    expect(hasMidiExtension("piece.Mid")).toBe(true);
    expect(hasMidiExtension("track.mp3")).toBe(false);
    expect(hasMidiExtension("notes.txt")).toBe(false);
    expect(hasMidiExtension("no_ext")).toBe(false);
  });

  it("extracts extension correctly", () => {
    expect(getFileExtension("test.MID")).toBe(".mid");
    expect(getFileExtension("archive.tar.gz")).toBe(".gz");
    expect(getFileExtension("bare")).toBe("");
  });

  it("validates valid MIDI file", () => {
    const file = new File([new Uint8Array(100)], "chopin.mid", { type: "audio/midi" });
    const result = validateMidiFile(file);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.filename).toBe("chopin.mid");
      expect(result.sizeBytes).toBe(100);
      expect(result.extension).toBe(".mid");
    }
  });

  it("rejects missing file", () => {
    const result = validateMidiFile(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("NO_FILE_PROVIDED");
    }
  });

  it("rejects non-midi file", () => {
    const file = new File([new Uint8Array(100)], "track.wav", { type: "audio/wav" });
    const result = validateMidiFile(file);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("INVALID_EXTENSION");
    }
  });

  it("rejects empty file (0 bytes)", () => {
    const file = new File([], "empty.mid", { type: "audio/midi" });
    const result = validateMidiFile(file);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("EMPTY_FILE");
    }
  });

  it("rejects file exceeding 16 MiB", () => {
    const oversizedBlob = new Blob([new Uint8Array(10)]);
    Object.defineProperty(oversizedBlob, "size", { value: MAX_MIDI_FILE_SIZE_BYTES + 1 });
    const result = validateMidiFile(oversizedBlob, "huge.mid");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("FILE_TOO_LARGE");
    }
  });

  it("validates multiple files in validateMidiFileList", () => {
    const f1 = new File([new Uint8Array(10)], "a.mid");
    const f2 = new File([new Uint8Array(10)], "b.txt");
    const results = validateMidiFileList([f1, f2]);
    expect(results.length).toBe(2);
    expect(results[0]?.valid).toBe(true);
    expect(results[1]?.valid).toBe(false);
  });

  it("validates input event with files", () => {
    const file = new File([new Uint8Array(20)], "bach.midi");
    const fakeFileList = [file] as unknown as FileList;
    const result = validateMidiFileInput({ target: { files: fakeFileList } });
    expect(result.valid).toBe(true);
  });

  it("handles drag-and-drop helpers safely", () => {
    const fakeDragEnter = {
      dataTransfer: {
        types: ["Files"],
      },
    } as unknown as DragEvent;
    expect(isDragEventWithFiles(fakeDragEnter)).toBe(true);

    const fakeDragOther = {
      dataTransfer: {
        types: ["text/plain"],
      },
    } as unknown as DragEvent;
    expect(isDragEventWithFiles(fakeDragOther)).toBe(false);

    const droppedFile = new File([new Uint8Array(50)], "mozart.mid");
    const fakeDrop = {
      dataTransfer: {
        files: [droppedFile] as unknown as FileList,
      },
    } as unknown as DragEvent;
    const dropResult = extractMidiFileFromDrop(fakeDrop);
    expect(dropResult.valid).toBe(true);
  });
});

describe("projectDb.ts in-memory mock integration", () => {
  interface MockReq {
    result: unknown;
    onsuccess: ((ev: { target: MockReq }) => void) | null;
  }

  class MockIDBStore {
    data = new Map<string, SavedProject>();

    put(val: SavedProject): MockReq {
      this.data.set(val.projectId, val);
      return this.createReq(val.projectId);
    }
    get(key: string): MockReq {
      return this.createReq(this.data.get(key));
    }
    getAll(): MockReq {
      return this.createReq(Array.from(this.data.values()));
    }
    delete(key: string): MockReq {
      this.data.delete(key);
      return this.createReq(undefined);
    }
    clear(): MockReq {
      this.data.clear();
      return this.createReq(undefined);
    }
    private createReq(result: unknown): MockReq {
      const req: MockReq = { result, onsuccess: null };
      setTimeout(() => {
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    }
  }

  const store = new MockIDBStore();

  const mockDb = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({ createIndex: () => {} }),
    transaction: () => ({
      objectStore: () => store,
    }),
    close: () => {},
  } as unknown as IDBDatabase;

  interface MockOpenRequest {
    result: IDBDatabase;
    onsuccess: ((ev: { target: MockOpenRequest }) => void) | null;
  }

  const mockFactory = {
    open: () => {
      const req: MockOpenRequest = { result: mockDb, onsuccess: null };
      setTimeout(() => {
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
  } as unknown as IDBFactory;

  beforeEach(() => {
    setIndexedDBFactory(mockFactory);
  });

  it("saves, gets, lists, clears, and deletes a project", async () => {
    const doc = createValidSongDocument("p_idb_1");
    const proj: SavedProject = {
      projectId: "p_idb_1",
      name: "IDB Test Project",
      updatedAt: 1000,
      document: doc,
    };

    await saveProject(proj);
    const retrieved = await getProject("p_idb_1");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.projectId).toBe("p_idb_1");
    expect(retrieved?.name).toBe("IDB Test Project");

    const list = await listProjects();
    expect(list.length).toBe(1);
    expect(list[0]?.projectId).toBe("p_idb_1");
    expect(list[0]?.noteCount).toBe(1);

    await deleteProject("p_idb_1");
    const afterDelete = await getProject("p_idb_1");
    expect(afterDelete).toBeNull();

    await saveProject(proj);
    await clearAllProjects();
    const afterClear = await listProjects();
    expect(afterClear.length).toBe(0);
  });
});
