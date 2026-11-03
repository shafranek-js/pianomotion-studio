import { describe, expect, it, vi } from "vitest";
import {
  LocalFolderLibrary,
  type LocalFolderAnalysisResult,
  type LocalFolderAnalyzer,
  type LocalFolderLibrarySnapshot,
  LOCAL_FOLDER_MAX_SCORE_BYTES,
} from "./localFolderLibrary";
import { LocalFolderStore } from "./localFolderStore";

function makeFile(name: string, bytes: number[], lastModified = 1, relativePath = ""): File {
  const content = Uint8Array.from(bytes);
  const file = {
    name,
    size: content.byteLength,
    type: "application/octet-stream",
    lastModified,
    webkitRelativePath: relativePath,
    arrayBuffer: async () => content.slice().buffer,
  } as unknown as File & { webkitRelativePath: string };
  return file;
}

function makeFileHandle(file: File): FileSystemHandle {
  return {
    kind: "file",
    name: file.name,
    getFile: async () => file,
  } as unknown as FileSystemHandle;
}

interface TestDirectory extends FileSystemDirectoryHandle {
  children: FileSystemHandle[];
}

function makeDirectory(name: string, children: FileSystemHandle[] = []): TestDirectory {
  const directory = {
    kind: "directory",
    name,
    children,
    values: async function* (this: TestDirectory) {
      for (const child of this.children) yield child;
    },
    queryPermission: async () => "granted" as PermissionState,
    requestPermission: async () => "granted" as PermissionState,
  } as unknown as TestDirectory;
  return directory;
}

function createLibrary() {
  let stored: unknown = null;
  let failNextSave = false;
  const store = new LocalFolderStore<LocalFolderLibrarySnapshot>({
    load: async () => stored,
    save: async (_key, value) => {
      if (failNextSave) {
        failNextSave = false;
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      stored = value;
    },
  });
  return {
    library: new LocalFolderLibrary(store),
    failNextSave: () => { failNextSave = true; },
    rawSnapshot: () => stored,
  };
}

function analyzerResult(overrides: Partial<LocalFolderAnalysisResult> = {}): LocalFolderAnalysisResult {
  return {
    midiBytes: Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]),
    title: "Converted melody",
    durationSeconds: 12.5,
    noteCount: 24,
    difficultyScore: 3,
    difficultyTier: "Beginner",
    ...overrides,
  };
}

const successfulAnalyzer: LocalFolderAnalyzer = async () => analyzerResult();

describe("local folder melody library", () => {
  it("recurses read-only, tags first-level folders, and stores distinct original and canonical hashes", async () => {
    const { library } = createLibrary();
    const scaleFile = makeFile("scales.musicxml", [1, 2, 3], 101);
    const midiFile = makeFile("song.mid", [4, 5, 6], 102);
    const handle = makeDirectory("Practice", [
      makeDirectory("Warmups", [makeFileHandle(scaleFile)]),
      makeFileHandle(midiFile),
      makeFileHandle(makeFile("notes.txt", [7, 8, 9])),
    ]);
    const analyzer = vi.fn(successfulAnalyzer);

    const result = await library.addDirectory(handle, analyzer);
    expect(analyzer).toHaveBeenCalledTimes(2);
    expect(result.errors).toEqual([]);
    expect(result.snapshot.sources).toHaveLength(1);
    expect(result.snapshot.sources[0]?.name).toBe("Practice");
    expect(result.snapshot.selectedSourceId).toBe(result.snapshot.sources[0]?.id);
    expect(result.snapshot.entries.map((entry) => entry.relativePath).sort()).toEqual(["Warmups/scales.musicxml", "song.mid"]);

    const nested = result.snapshot.entries.find((entry) => entry.relativePath === "Warmups/scales.musicxml")!;
    const root = result.snapshot.entries.find((entry) => entry.relativePath === "song.mid")!;
    expect(nested.firstLevelFolder).toBe("Warmups");
    expect(nested.firstLevelFolderId).toContain(nested.sourceId);
    expect(nested.sourceFormat).toBe("musicxml");
    expect(root.firstLevelFolder).toBeNull();
    expect(root.sourceFormat).toBe("midi");
    expect(nested.id).toBe(`entry:${nested.sourceId}:Warmups%2Fscales.musicxml`);
    expect(nested.originalSha256).not.toBe(nested.canonicalMidiSha256);
    const storedSnapshot = await library.getSnapshot();
    expect(storedSnapshot.canonicalMidiCache[nested.id]?.sha256).toBe(nested.canonicalMidiSha256);
    expect("canonicalMidiCache" in await library.getLibraryView()).toBe(false);
    expect(await library.openEntryMidi(nested.id)).toEqual(analyzerResult().midiBytes);
  });

  it("reuses path/size/mtime cache, then updates content while keeping path identity", async () => {
    const { library } = createLibrary();
    let file = makeFile("phrase.kar", [10, 11, 12], 50);
    const handle = makeDirectory("Songs", [makeFileHandle(file)]);
    const analyzer = vi.fn(async () => analyzerResult());

    const first = await library.addDirectory(handle, analyzer);
    const firstEntry = first.snapshot.entries[0]!;
    expect(first.analyzedCount).toBe(1);

    const second = await library.addDirectory(handle, analyzer);
    expect(second.reusedCount).toBe(1);
    expect(analyzer).toHaveBeenCalledTimes(1);
    expect(second.snapshot.entries[0]?.id).toBe(firstEntry.id);

    file = makeFile("phrase.kar", [10, 11, 12, 13], 51);
    handle.children = [makeFileHandle(file)];
    const third = await library.addDirectory(handle, analyzer);
    expect(third.analyzedCount).toBe(1);
    expect(analyzer).toHaveBeenCalledTimes(2);
    expect(third.snapshot.entries[0]?.id).toBe(firstEntry.id);
    expect(third.snapshot.entries[0]?.originalSha256).not.toBe(firstEntry.originalSha256);
    expect(third.snapshot.entries[0]?.addedAt).toBe(firstEntry.addedAt);
  });

  it("reanalyzes an unchanged file when cached MIDI bytes no longer match their stored digest", async () => {
    const { library, rawSnapshot } = createLibrary();
    const file = makeFile("steady.mid", [10, 11, 12], 50);
    const handle = makeDirectory("Integrity", [makeFileHandle(file)]);
    const analyzer = vi.fn(async () => analyzerResult());
    const first = await library.addDirectory(handle, analyzer);
    const entry = first.snapshot.entries[0]!;
    const raw = rawSnapshot() as LocalFolderLibrarySnapshot;

    // Keep the MThd header and file metadata valid, but change cached MIDI content.
    raw.canonicalMidiCache[entry.id]!.midiBytes[4] = 0xff;
    const rescanned = await library.rescanDirectory(first.snapshot.sources[0]!.id, analyzer);

    expect(rescanned.reusedCount).toBe(0);
    expect(rescanned.analyzedCount).toBe(1);
    expect(analyzer).toHaveBeenCalledTimes(2);
    expect(rescanned.snapshot.entries[0]?.id).toBe(entry.id);
    expect(await library.openEntryMidi(entry.id)).toEqual(analyzerResult().midiBytes);
  });

  it("normalizes webkitRelativePath roots and reports nested folder tags for file-list fallbacks", async () => {
    const { library } = createLibrary();
    const files = [
      makeFile("interlude.musicxml", [1, 3, 5], 8, "Collection/Chopin/interlude.musicxml"),
      makeFile("prelude.mid", [2, 4, 6], 9, "Collection/prelude.mid"),
      makeFile("readme.md", [0], 10, "Collection/readme.md"),
    ];

    const result = await library.addFiles(files, successfulAnalyzer);
    expect(result.snapshot.sources[0]?.name).toBe("Collection");
    expect(result.snapshot.entries.map((entry) => entry.relativePath)).toEqual([
      "Chopin/interlude.musicxml",
      "prelude.mid",
    ]);
    expect(result.snapshot.entries[0]?.firstLevelFolder).toBe("Chopin");
    expect(result.snapshot.entries[1]?.firstLevelFolder).toBeNull();
  });

  it("rejects oversized inputs before reading their bytes", async () => {
    const { library } = createLibrary();
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const largeFile = {
      name: "large.mid",
      size: LOCAL_FOLDER_MAX_SCORE_BYTES + 1,
      lastModified: 3,
      webkitRelativePath: "TooLarge/large.mid",
      arrayBuffer,
    } as unknown as File;

    const result = await library.addFiles([largeFile], successfulAnalyzer);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("local score limit");
    expect(result.snapshot.entries).toEqual([]);
  });

  it("deletes disappeared paths only when a complete rescan commits", async () => {
    const { library } = createLibrary();
    const handle = makeDirectory("Etudes", [
      makeFileHandle(makeFile("one.mid", [1, 1], 1)),
      makeFileHandle(makeFile("two.mid", [2, 2], 2)),
    ]);
    const first = await library.addDirectory(handle, successfulAnalyzer);
    const sourceId = first.snapshot.sources[0]!.id;
    const removedId = first.snapshot.entries.find((entry) => entry.name === "two.mid")!.id;

    handle.children = [makeFileHandle(makeFile("one.mid", [1, 1], 1))];
    const rescanned = await library.rescanDirectory(sourceId, successfulAnalyzer);
    expect(rescanned.snapshot.entries.map((entry) => entry.name)).toEqual(["one.mid"]);
    expect((await library.getSnapshot()).canonicalMidiCache[removedId]).toBeUndefined();
  });

  it("keeps the old committed snapshot when a scan is cancelled or the settings write fails", async () => {
    const { library, failNextSave } = createLibrary();
    let file = makeFile("piece.mid", [1, 2], 1);
    const handle = makeDirectory("Pieces", [makeFileHandle(file)]);
    const first = await library.addDirectory(handle, successfulAnalyzer);
    const beforeCancel = await library.getSnapshot();

    file = makeFile("piece.mid", [1, 2, 3], 2);
    handle.children = [makeFileHandle(file)];
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const slowAnalyzer: LocalFolderAnalyzer = async ({ signal }) => {
      announceStarted?.();
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
      return analyzerResult();
    };
    const pending = library.addDirectory(handle, slowAnalyzer);
    await started;
    expect(library.cancelCurrentScan()).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await library.getSnapshot()).toEqual(beforeCancel);

    const sourceId = first.snapshot.sources[0]!.id;
    failNextSave();
    await expect(library.rescanDirectory(sourceId, successfulAnalyzer)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(await library.getSnapshot()).toEqual(beforeCancel);
  });

  it("passes cancellation into the final atomic storage write", async () => {
    let stored: unknown = null;
    let pauseNextSave = false;
    let announceSaveStarted: (() => void) | undefined;
    const saveStarted = new Promise<void>((resolve) => { announceSaveStarted = resolve; });
    const store = new LocalFolderStore<LocalFolderLibrarySnapshot>({
      load: async () => stored,
      save: async (_key, value, signal) => {
        if (pauseNextSave) {
          pauseNextSave = false;
          announceSaveStarted?.();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const error = new Error("cancelled write");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        }
        stored = value;
      },
    });
    const library = new LocalFolderLibrary(store);
    let file = makeFile("queued.mid", [1, 2], 1);
    const handle = makeDirectory("Queued", [makeFileHandle(file)]);
    const first = await library.addDirectory(handle, successfulAnalyzer);
    const previous = await library.getSnapshot();
    file = makeFile("queued.mid", [1, 2, 3], 2);
    handle.children = [makeFileHandle(file)];
    pauseNextSave = true;

    const pending = library.rescanDirectory(first.snapshot.sources[0]!.id, successfulAnalyzer);
    await saveStarted;
    expect(library.cancelCurrentScan()).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await library.getSnapshot()).toEqual(previous);
  });

  it("reports per-file analyzer errors while retaining that path's prior playable cache", async () => {
    const { library } = createLibrary();
    const handle = makeDirectory("Archive", [makeFileHandle(makeFile("song.mid", [9, 8, 7], 1))]);
    const first = await library.addDirectory(handle, successfulAnalyzer);
    const oldEntry = first.snapshot.entries[0]!;

    handle.children = [makeFileHandle(makeFile("song.mid", [9, 8, 7, 6], 2))];
    const result = await library.rescanDirectory(first.snapshot.sources[0]!.id, async () => {
      throw new Error("Unsupported score details");
    });
    expect(result.errors).toEqual([{ relativePath: "song.mid", message: "Unsupported score details" }]);
    expect(result.snapshot.entries[0]).toEqual(oldEntry);
    expect(await library.openEntryMidi(oldEntry.id)).toEqual(analyzerResult().midiBytes);
  });

  it("persists source and entry selection and exposes folder permission restoration", async () => {
    const { library } = createLibrary();
    const handle = makeDirectory("Catalog", [makeFileHandle(makeFile("theme.mid", [3, 2, 1], 1))]);
    const result = await library.addDirectory(handle, successfulAnalyzer);
    const source = result.snapshot.sources[0]!;

    expect(await library.requestSourcePermission(source.id)).toBe("granted");
    const selected = await library.selectEntry(source.id, result.snapshot.entries[0]!.id);
    expect(selected.selectedSourceId).toBe(source.id);
    expect(selected.selectedEntryId).toBe(result.snapshot.entries[0]!.id);
    await expect(library.selectEntry(source.id, "entry:other:bad.mid")).rejects.toThrow("does not belong");
  });

  it("rejects mismatched path identities and cache bytes when loading or opening entries", async () => {
    const { library, rawSnapshot } = createLibrary();
    const handle = makeDirectory("Integrity", [makeFileHandle(makeFile("valid.mid", [1, 2, 3], 1))]);
    const scanned = await library.addDirectory(handle, successfulAnalyzer);
    const raw = rawSnapshot() as LocalFolderLibrarySnapshot;
    const entry = scanned.snapshot.entries[0]!;

    raw.entries[0] = { ...raw.entries[0]!, id: "entry:wrong-source:tampered.mid" };
    await expect(library.getLibraryView()).rejects.toThrow("ID or path");
    raw.entries[0] = entry;
    raw.canonicalMidiCache[entry.id]!.midiBytes[4] = 0xff;
    await expect(library.openEntryMidi(entry.id)).rejects.toThrow("integrity check failed");
  });
});
