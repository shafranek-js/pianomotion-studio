import { detectScoreFileFormat, isSmfBytes, type ScoreFileFormat } from "../import/scoreFormat";
import { MAX_MIDI_FILE_SIZE_BYTES } from "../storage/fileValidator";
import { LocalFolderStore } from "./localFolderStore";

export type LocalFolderSourceKind = "directory" | "files";
export type LocalMelodyDifficultyTier = "Beginner" | "Intermediate" | "Advanced" | "Virtuoso";
export const LOCAL_FOLDER_MAX_SCORE_BYTES = MAX_MIDI_FILE_SIZE_BYTES;

export interface LocalMelodyPreviewNote {
  noteId: string;
  pitch: number;
  velocity: number;
  startSeconds: number;
  endSeconds: number;
}

export interface LocalFolderSource {
  id: string;
  kind: LocalFolderSourceKind;
  name: string;
  createdAt: number;
  lastScannedAt: number;
  entryCount: number;
  lastScanErrorCount: number;
  /** Persisted by IndexedDB in browsers that support structured-cloning file handles. */
  directoryHandle?: FileSystemDirectoryHandle;
}

export interface LocalFolderEntry {
  /** Stable for a source and normalized path; independent of file contents. */
  id: string;
  sourceId: string;
  relativePath: string;
  name: string;
  firstLevelFolder: string | null;
  firstLevelFolderId: string | null;
  title: string;
  addedAt: number;
  sourceFormat: ScoreFileFormat;
  originalSha256: string;
  canonicalMidiSha256: string;
  size: number;
  lastModified: number;
  durationSeconds: number;
  noteCount: number;
  difficultyScore: number;
  difficultyTier: LocalMelodyDifficultyTier;
  previewNotes?: LocalMelodyPreviewNote[];
}

export interface LocalFolderMidiCacheEntry {
  sha256: string;
  midiBytes: Uint8Array;
}

export interface LocalFolderLibrarySnapshot {
  schemaVersion: 1;
  revision: number;
  sources: LocalFolderSource[];
  entries: LocalFolderEntry[];
  /** Canonical MIDI is stored by path entry ID; hashes never serve as identity. */
  canonicalMidiCache: Record<string, LocalFolderMidiCacheEntry>;
  selectedSourceId: string | null;
  selectedEntryId: string | null;
}

/** Metadata-only view for UI lists; it deliberately omits potentially large MIDI buffers. */
export type LocalFolderLibraryView = Omit<LocalFolderLibrarySnapshot, "canonicalMidiCache">;

export interface LocalFolderAnalysisInput {
  name: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
}

export interface LocalFolderAnalysisResult {
  midiBytes: Uint8Array;
  title?: string;
  durationSeconds: number;
  noteCount: number;
  difficultyScore: number;
  difficultyTier: string;
  previewNotes?: LocalMelodyPreviewNote[];
}

export type LocalFolderAnalyzer = (
  input: LocalFolderAnalysisInput,
) => Promise<LocalFolderAnalysisResult>;

export interface LocalFolderScanProgress {
  phase: "enumerating" | "analyzing" | "saving" | "complete";
  completed: number;
  total: number | null;
  relativePath?: string;
}

export interface LocalFolderScanError {
  relativePath: string;
  message: string;
}

export interface LocalFolderScanResult {
  snapshot: LocalFolderLibraryView;
  errors: LocalFolderScanError[];
  analyzedCount: number;
  reusedCount: number;
}

export interface LocalFolderScanOptions {
  onProgress?: (progress: LocalFolderScanProgress) => void;
  signal?: AbortSignal;
}

export interface AddLocalFilesOptions extends LocalFolderScanOptions {
  sourceName?: string;
}

export type LocalFolderPermission = "granted" | "prompt" | "denied" | "unsupported";

interface FileCandidate {
  relativePath: string;
  name: string;
  file: File | null;
  error?: unknown;
}

interface FileHandleLike extends FileSystemHandle {
  kind: "file";
  getFile(): Promise<File>;
}

interface DirectoryHandleLike {
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
}

interface PermissionHandleLike {
  queryPermission?: (descriptor?: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode: "read" }) => Promise<PermissionState>;
  isSameEntry?: (other: FileSystemHandle) => Promise<boolean>;
}

const EMPTY_SNAPSHOT: LocalFolderLibrarySnapshot = {
  schemaVersion: 1,
  revision: 0,
  sources: [],
  entries: [],
  canonicalMidiCache: {},
  selectedSourceId: null,
  selectedEntryId: null,
};

function makeId(prefix: string): string {
  let unique: string;
  try {
    unique = globalThis.crypto?.randomUUID?.() ?? "";
  } catch {
    unique = "";
  }
  if (!unique) unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${unique}`;
}

function makeEntryId(sourceId: string, relativePath: string): string {
  return `entry:${sourceId}:${encodeURIComponent(relativePath)}`;
}

function makeFolderId(sourceId: string, folder: string): string {
  return `folder:${sourceId}:${encodeURIComponent(folder)}`;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function cloneSnapshot(snapshot: LocalFolderLibrarySnapshot): LocalFolderLibrarySnapshot {
  const canonicalMidiCache: Record<string, LocalFolderMidiCacheEntry> = {};
  for (const [entryId, cache] of Object.entries(snapshot.canonicalMidiCache)) {
    canonicalMidiCache[entryId] = { sha256: cache.sha256, midiBytes: cloneBytes(cache.midiBytes) };
  }
  return {
    ...snapshot,
    sources: snapshot.sources.map((source) => ({ ...source })),
    entries: snapshot.entries.map((entry) => ({
      ...entry,
      ...(entry.previewNotes ? { previewNotes: entry.previewNotes.map((note) => ({ ...note })) } : {}),
    })),
    canonicalMidiCache,
  };
}

function cloneLibraryView(snapshot: LocalFolderLibrarySnapshot): LocalFolderLibraryView {
  return {
    schemaVersion: snapshot.schemaVersion,
    revision: snapshot.revision,
    sources: snapshot.sources.map((source) => ({ ...source })),
    entries: snapshot.entries.map((entry) => ({
      ...entry,
      ...(entry.previewNotes ? { previewNotes: entry.previewNotes.map((note) => ({ ...note })) } : {}),
    })),
    selectedSourceId: snapshot.selectedSourceId,
    selectedEntryId: snapshot.selectedEntryId,
  };
}

function decodeSnapshot(value: unknown, requireCache = true): LocalFolderLibrarySnapshot {
  if (value === null || value === undefined) return cloneSnapshot(EMPTY_SNAPSHOT);
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The saved local melody library snapshot is invalid.");
  }
  const candidate = value as Partial<LocalFolderLibrarySnapshot>;
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.revision) || candidate.revision! < 0 ||
    !Array.isArray(candidate.sources) ||
    !Array.isArray(candidate.entries) ||
    (requireCache && (candidate.canonicalMidiCache === null || typeof candidate.canonicalMidiCache !== "object")) ||
    (!requireCache && candidate.canonicalMidiCache !== undefined && candidate.canonicalMidiCache !== null && typeof candidate.canonicalMidiCache !== "object")
  ) {
    throw new Error("The saved local melody library snapshot is invalid.");
  }

  const canonicalMidiCache: Record<string, LocalFolderMidiCacheEntry> = {};
  const rawCaches = requireCache ? candidate.canonicalMidiCache ?? {} : {};
  for (const [entryId, rawCache] of Object.entries(rawCaches)) {
    if (rawCache === null || typeof rawCache !== "object") {
      throw new Error(`The saved canonical MIDI cache for "${entryId}" is invalid.`);
    }
    const cache = rawCache as { sha256: unknown; midiBytes: unknown };
    const midiBytes = cache.midiBytes instanceof Uint8Array
      ? cache.midiBytes
      : cache.midiBytes instanceof ArrayBuffer
        ? new Uint8Array(cache.midiBytes)
        : null;
    if (!midiBytes || !isSha256(cache.sha256) || !isSmfBytes(midiBytes)) {
      throw new Error(`The saved canonical MIDI cache for "${entryId}" is invalid.`);
    }
    canonicalMidiCache[entryId] = { sha256: cache.sha256, midiBytes };
  }

  if (candidate.sources.some((source) => !isLocalFolderSource(source))) {
    throw new Error("The saved local melody library contains an invalid source.");
  }
  if (candidate.entries.some((entry) => !isLocalFolderEntry(entry))) {
    throw new Error("The saved local melody library contains an invalid entry.");
  }
  const sources = candidate.sources.map((source) => ({ ...source }));
  const entries = candidate.entries.map((entry) => ({
    ...entry,
    ...(entry.previewNotes ? { previewNotes: entry.previewNotes.map((note) => ({ ...note })) } : {}),
  }));
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) throw new Error("The saved local melody library contains duplicate source IDs.");
    sourceIds.add(source.id);
    const actualCount = entries.filter((entry) => entry.sourceId === source.id).length;
    if (source.entryCount !== actualCount) throw new Error(`The saved entry count for source "${source.id}" is inconsistent.`);
  }

  const entryIds = new Set<string>();
  for (const entry of entries) {
    if (entryIds.has(entry.id)) throw new Error("The saved local melody library contains duplicate entry IDs.");
    entryIds.add(entry.id);
    if (!sourceIds.has(entry.sourceId)) throw new Error(`The saved melody "${entry.id}" refers to a missing source.`);
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRelativePath(entry.relativePath);
    } catch {
      throw new Error(`The saved path for melody "${entry.id}" is invalid.`);
    }
    if (normalizedPath !== entry.relativePath || entry.id !== makeEntryId(entry.sourceId, entry.relativePath)) {
      throw new Error(`The saved melody ID or path for "${entry.id}" is inconsistent.`);
    }
    const segments = entry.relativePath.split("/");
    const expectedFolder = segments.length > 1 ? segments[0]! : null;
    const expectedFolderId = expectedFolder ? makeFolderId(entry.sourceId, expectedFolder) : null;
    if (entry.firstLevelFolder !== expectedFolder || entry.firstLevelFolderId !== expectedFolderId) {
      throw new Error(`The saved folder tag for melody "${entry.id}" is inconsistent.`);
    }
    const cache = canonicalMidiCache[entry.id];
    if (requireCache && (!cache || cache.sha256 !== entry.canonicalMidiSha256)) {
      throw new Error(`The canonical MIDI cache for melody "${entry.id}" is missing or mismatched.`);
    }
  }
  if (requireCache && Object.keys(canonicalMidiCache).some((entryId) => !entryIds.has(entryId))) {
    throw new Error("The saved local melody library contains an orphaned MIDI cache entry.");
  }

  const selectedSourceId = typeof candidate.selectedSourceId === "string" ? candidate.selectedSourceId : null;
  const selectedEntryId = typeof candidate.selectedEntryId === "string" ? candidate.selectedEntryId : null;
  if (candidate.selectedSourceId !== null && typeof candidate.selectedSourceId !== "string") {
    throw new Error("The saved selected source ID is invalid.");
  }
  if (candidate.selectedEntryId !== null && typeof candidate.selectedEntryId !== "string") {
    throw new Error("The saved selected melody ID is invalid.");
  }
  if (selectedSourceId !== null && !sourceIds.has(selectedSourceId)) {
    throw new Error("The saved selection refers to a missing source.");
  }
  if (selectedEntryId !== null && !entries.some((entry) => entry.id === selectedEntryId && entry.sourceId === selectedSourceId)) {
    throw new Error("The saved selection refers to a missing melody or source.");
  }

  return {
    schemaVersion: 1,
    revision: candidate.revision!,
    sources,
    entries,
    canonicalMidiCache,
    selectedSourceId,
    selectedEntryId,
  };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isLocalMelodyDifficultyTier(value: unknown): value is LocalMelodyDifficultyTier {
  return value === "Beginner" || value === "Intermediate" || value === "Advanced" || value === "Virtuoso";
}

function isLocalFolderSource(value: unknown): value is LocalFolderSource {
  if (value === null || typeof value !== "object") return false;
  const source = value as Partial<LocalFolderSource>;
  const handle = source.directoryHandle as FileSystemDirectoryHandle | undefined;
  return typeof source.id === "string" && source.id.startsWith("source:") &&
    (source.kind === "directory" || source.kind === "files") &&
    typeof source.name === "string" && source.name.trim().length > 0 &&
    isFiniteNonNegative(source.createdAt) && Number.isSafeInteger(source.createdAt) &&
    isFiniteNonNegative(source.lastScannedAt) && Number.isSafeInteger(source.lastScannedAt) &&
    isFiniteNonNegative(source.entryCount) && Number.isSafeInteger(source.entryCount) &&
    isFiniteNonNegative(source.lastScanErrorCount) && Number.isSafeInteger(source.lastScanErrorCount) &&
    (!handle || (source.kind === "directory" && handle.kind === "directory"));
}

function isLocalFolderEntry(value: unknown): value is LocalFolderEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<LocalFolderEntry>;
  const validFormat = ["midi", "karaoke", "musicxml", "mxl", "mscz", "guitar-pro"].includes(String(entry.sourceFormat));
  const validPreviewNotes = entry.previewNotes === undefined || (Array.isArray(entry.previewNotes) && entry.previewNotes.every((note) =>
    note !== null && typeof note === "object" &&
    typeof note.noteId === "string" && note.noteId.length > 0 &&
    Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127 &&
    Number.isInteger(note.velocity) && note.velocity >= 1 && note.velocity <= 127 &&
    isFiniteNonNegative(note.startSeconds) &&
    typeof note.endSeconds === "number" && Number.isFinite(note.endSeconds) && note.endSeconds > note.startSeconds && note.endSeconds <= 15,
  ));
  return typeof entry.id === "string" &&
    typeof entry.sourceId === "string" &&
    typeof entry.relativePath === "string" &&
    typeof entry.name === "string" &&
    (typeof entry.firstLevelFolder === "string" || entry.firstLevelFolder === null) &&
    (typeof entry.firstLevelFolderId === "string" || entry.firstLevelFolderId === null) &&
    typeof entry.title === "string" && entry.title.trim().length > 0 &&
    isFiniteNonNegative(entry.addedAt) &&
    validFormat &&
    isSha256(entry.originalSha256) &&
    isSha256(entry.canonicalMidiSha256) &&
    isFiniteNonNegative(entry.size) && Number.isSafeInteger(entry.size) &&
    isFiniteNonNegative(entry.lastModified) &&
    isFiniteNonNegative(entry.durationSeconds) &&
    isFiniteNonNegative(entry.noteCount) && Number.isSafeInteger(entry.noteCount) &&
    typeof entry.difficultyScore === "number" && Number.isFinite(entry.difficultyScore) && entry.difficultyScore >= 1 && entry.difficultyScore <= 10 && Math.round(entry.difficultyScore * 10) / 10 === entry.difficultyScore &&
    isLocalMelodyDifficultyTier(entry.difficultyTier) &&
    validPreviewNotes;
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").normalize("NFC");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("The file path must be relative to the selected folder.");
  }
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === ".." || segment.includes("\0"))) {
    throw new Error("The file path contains an invalid path segment.");
  }
  if (segments.length === 0) throw new Error("The file has an empty relative path.");
  return segments.join("/");
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function extensionlessName(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeAbortError(): Error {
  const error = new Error("Local melody scan cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw makeAbortError();
}

function sendProgress(options: LocalFolderScanOptions, progress: LocalFolderScanProgress): void {
  try {
    options.onProgress?.(progress);
  } catch {
    // Progress observers must not be able to interrupt or partially commit a scan.
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 is unavailable in this browser context.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", cloneBytes(bytes).buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asDirectoryHandle(handle: FileSystemDirectoryHandle): DirectoryHandleLike {
  return handle as unknown as DirectoryHandleLike;
}

function isDirectoryHandle(handle: FileSystemDirectoryHandle | FileSystemHandle): handle is FileSystemDirectoryHandle {
  return handle.kind === "directory";
}

function isFileHandle(handle: FileSystemHandle): handle is FileHandleLike {
  return handle.kind === "file" && typeof (handle as FileHandleLike).getFile === "function";
}

async function collectDirectoryFiles(
  handle: FileSystemDirectoryHandle,
  signal: AbortSignal,
  onProgress: (relativePath: string) => void,
): Promise<FileCandidate[]> {
  const candidates: FileCandidate[] = [];

  const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    throwIfAborted(signal);
    const children: FileSystemHandle[] = [];
    for await (const child of asDirectoryHandle(directory).values()) {
      throwIfAborted(signal);
      children.push(child);
    }
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      throwIfAborted(signal);
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      if (isDirectoryHandle(child)) {
        await walk(child, relativePath);
      } else if (isFileHandle(child) && detectScoreFileFormat(child.name) !== null) {
        onProgress(relativePath);
        try {
          const file = await child.getFile();
          if (file.size > MAX_MIDI_FILE_SIZE_BYTES) {
            candidates.push({ relativePath: normalizeRelativePath(relativePath), name: child.name, file: null, error: new Error(`File exceeds the ${MAX_MIDI_FILE_SIZE_BYTES}-byte local score limit.`) });
          } else {
            candidates.push({ relativePath: normalizeRelativePath(relativePath), name: child.name, file });
          }
        } catch (error) {
          if (signal.aborted) throw makeAbortError();
          candidates.push({ relativePath: normalizeRelativePath(relativePath), name: child.name, file: null, error });
        }
      }
    }
  };

  await walk(handle, "");
  return candidates;
}

function collectFileList(files: FileList | readonly File[], requestedRootName?: string): {
  rootName: string;
  candidates: FileCandidate[];
} {
  const fileArray = Array.from(files as ArrayLike<File>);
  const webkitPaths = fileArray.map((file) => {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return path && path.trim() ? path : file.name;
  });
  const firstSegments = webkitPaths.map((path) => path.replace(/\\/g, "/").split("/").filter(Boolean)[0] ?? "");
  const commonRoot = firstSegments.length > 0 && firstSegments[0] !== "" && firstSegments.every((part) => part === firstSegments[0])
    ? firstSegments[0]
    : "";
  const rootName = requestedRootName?.trim() || commonRoot || "Selected files";
  const candidates: FileCandidate[] = [];

  fileArray.forEach((file, index) => {
    const rawPath = webkitPaths[index] ?? file.name;
    try {
      let relativePath = rawPath.replace(/\\/g, "/");
      const segments = relativePath.split("/").filter(Boolean);
      const rootToStrip = commonRoot || (requestedRootName?.trim() ?? "");
      if (rootToStrip && segments[0] === rootToStrip && segments.length > 1) segments.shift();
      relativePath = normalizeRelativePath(segments.join("/"));
      if (detectScoreFileFormat(basename(relativePath)) === null) return;
      if (file.size > MAX_MIDI_FILE_SIZE_BYTES) {
        candidates.push({ relativePath, name: basename(relativePath), file: null, error: new Error(`File exceeds the ${MAX_MIDI_FILE_SIZE_BYTES}-byte local score limit.`) });
        return;
      }
      candidates.push({ relativePath, name: basename(relativePath), file });
    } catch (error) {
      candidates.push({ relativePath: `invalid/${file.name}`, name: file.name, file: null, error });
    }
  });

  return { rootName, candidates };
}

function makeSource(kind: LocalFolderSourceKind, name: string, handle?: FileSystemDirectoryHandle): LocalFolderSource {
  return {
    id: makeId("source"),
    kind,
    name: name.trim() || (kind === "directory" ? "Folder" : "Selected files"),
    createdAt: Date.now(),
    lastScannedAt: 0,
    entryCount: 0,
    lastScanErrorCount: 0,
    ...(handle ? { directoryHandle: handle } : {}),
  };
}

function makeCandidateError(relativePath: string, error: unknown): LocalFolderScanError {
  return { relativePath, message: asErrorMessage(error) };
}

function validAnalysis(
  result: LocalFolderAnalysisResult,
): asserts result is LocalFolderAnalysisResult & { difficultyTier: LocalMelodyDifficultyTier } {
  if (!(result.midiBytes instanceof Uint8Array) || result.midiBytes.byteLength < 4 || !isSmfBytes(result.midiBytes)) {
    throw new Error("The analyzer did not return a valid Standard MIDI File.");
  }
  if (result.midiBytes.byteLength > MAX_MIDI_FILE_SIZE_BYTES) {
    throw new Error(`Canonical MIDI exceeds the ${MAX_MIDI_FILE_SIZE_BYTES}-byte local score limit.`);
  }
  if (!Number.isFinite(result.durationSeconds) || result.durationSeconds < 0) {
    throw new Error("The analyzer returned an invalid duration.");
  }
  if (!Number.isInteger(result.noteCount) || result.noteCount < 0) {
    throw new Error("The analyzer returned an invalid note count.");
  }
  if (!Number.isFinite(result.difficultyScore) || result.difficultyScore < 1 || result.difficultyScore > 10 || Math.round(result.difficultyScore * 10) / 10 !== result.difficultyScore) {
    throw new Error("The analyzer returned an invalid difficulty score.");
  }
  if (!isLocalMelodyDifficultyTier(result.difficultyTier)) {
    throw new Error("The analyzer returned an invalid difficulty tier.");
  }
  for (const note of result.previewNotes ?? []) {
    if (
      typeof note.noteId !== "string" || !note.noteId ||
      !Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 ||
      !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127 ||
      !Number.isFinite(note.startSeconds) || note.startSeconds < 0 ||
      !Number.isFinite(note.endSeconds) || note.endSeconds <= note.startSeconds || note.endSeconds > 15
    ) {
      throw new Error("The analyzer returned invalid preview notes.");
    }
  }
}

function deepCloneNotes(notes: LocalMelodyPreviewNote[] | undefined): LocalMelodyPreviewNote[] | undefined {
  return notes?.map((note) => ({ ...note }));
}

/**
 * Local, read-only melody folder library backed by the existing IndexedDB
 * settings store. Folder scans build a complete candidate snapshot and persist
 * it with one settings-record write only after the scan completes.
 */
export class LocalFolderLibrary {
  private readonly store: LocalFolderStore<LocalFolderLibrarySnapshot>;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private activeScan: AbortController | null = null;
  private activeExternalSignal: { signal: AbortSignal; listener: () => void } | null = null;

  constructor(store = new LocalFolderStore<LocalFolderLibrarySnapshot>()) {
    this.store = store;
  }

  private async readSnapshot(): Promise<LocalFolderLibrarySnapshot> {
    return decodeSnapshot(await this.store.loadSnapshot());
  }

  private async readMetadataSnapshot(): Promise<LocalFolderLibrarySnapshot> {
    return decodeSnapshot(await this.store.loadLibraryView(), false);
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.catch(() => undefined).then(operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private beginScan(externalSignal?: AbortSignal): AbortController {
    if (this.activeScan) throw new Error("A local melody scan is already running.");
    const controller = new AbortController();
    this.activeScan = controller;
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else {
        const listener = () => controller.abort();
        this.activeExternalSignal = { signal: externalSignal, listener };
        externalSignal.addEventListener("abort", listener, { once: true });
      }
    }
    return controller;
  }

  private finishScan(controller: AbortController): void {
    if (this.activeScan !== controller) return;
    this.activeScan = null;
    this.activeExternalSignal?.signal.removeEventListener("abort", this.activeExternalSignal.listener);
    this.activeExternalSignal = null;
  }

  async getSnapshot(): Promise<LocalFolderLibrarySnapshot> {
    return cloneSnapshot(await this.readSnapshot());
  }

  async getLibraryView(): Promise<LocalFolderLibraryView> {
    return cloneLibraryView(await this.readMetadataSnapshot());
  }

  async listSources(): Promise<LocalFolderSource[]> {
    return (await this.readMetadataSnapshot()).sources.map((source) => ({ ...source }));
  }

  async getEntries(sourceId?: string): Promise<LocalFolderEntry[]> {
    const snapshot = await this.readMetadataSnapshot();
    return snapshot.entries
      .filter((entry) => sourceId === undefined || entry.sourceId === sourceId)
      .map((entry) => ({ ...entry, ...(entry.previewNotes ? { previewNotes: entry.previewNotes.map((note) => ({ ...note })) } : {}) }));
  }

  async selectSource(sourceId: string | null): Promise<LocalFolderLibraryView> {
    return this.runMutation(async () => {
      const snapshot = await this.readMetadataSnapshot();
      if (sourceId !== null && !snapshot.sources.some((source) => source.id === sourceId)) {
        throw new Error("The selected local melody source no longer exists.");
      }
      const firstEntry = sourceId === null ? null : snapshot.entries.find((entry) => entry.sourceId === sourceId);
      const currentEntry = snapshot.entries.find((entry) => entry.id === snapshot.selectedEntryId && entry.sourceId === sourceId);
      const next = {
        ...snapshot,
        revision: snapshot.revision + 1,
        selectedSourceId: sourceId,
        selectedEntryId: currentEntry?.id ?? firstEntry?.id ?? null,
      };
      await this.store.saveLibraryView(next);
      return cloneLibraryView(next);
    });
  }

  async selectEntry(sourceId: string, entryId: string | null): Promise<LocalFolderLibraryView> {
    return this.runMutation(async () => {
      const snapshot = await this.readMetadataSnapshot();
      if (!snapshot.sources.some((source) => source.id === sourceId)) {
        throw new Error("The selected local melody source no longer exists.");
      }
      if (entryId !== null && !snapshot.entries.some((entry) => entry.id === entryId && entry.sourceId === sourceId)) {
        throw new Error("The selected melody does not belong to this source.");
      }
      const next = { ...snapshot, revision: snapshot.revision + 1, selectedSourceId: sourceId, selectedEntryId: entryId };
      await this.store.saveLibraryView(next);
      return cloneLibraryView(next);
    });
  }

  async addDirectory(
    handle: FileSystemDirectoryHandle,
    analyzer: LocalFolderAnalyzer,
    options: LocalFolderScanOptions = {},
  ): Promise<LocalFolderScanResult> {
    const controller = this.beginScan(options.signal);
    return this.runMutation(async () => {
      try {
        const snapshot = await this.readSnapshot();
        let source = await this.findExistingDirectorySource(snapshot, handle);
        if (!source) source = makeSource("directory", handle.name, handle);
        else source = { ...source, name: handle.name, directoryHandle: handle };
        const candidates = await collectDirectoryFiles(handle, controller.signal, (relativePath) => {
          sendProgress(options, { phase: "enumerating", completed: 0, total: null, relativePath });
        });
        return await this.scanAndCommit(snapshot, source, candidates, analyzer, controller, options);
      } finally {
        this.finishScan(controller);
      }
    });
  }

  async rescanDirectory(
    sourceId: string,
    analyzer: LocalFolderAnalyzer,
    options: LocalFolderScanOptions = {},
  ): Promise<LocalFolderScanResult> {
    const controller = this.beginScan(options.signal);
    return this.runMutation(async () => {
      try {
        const snapshot = await this.readSnapshot();
        const source = snapshot.sources.find((item) => item.id === sourceId);
        if (!source || source.kind !== "directory" || !source.directoryHandle) {
          throw new Error("This local melody source has no saved folder handle. Select the folder again to restore access.");
        }
        const permission = await this.currentPermission(source.directoryHandle);
        if (permission !== "granted") {
          throw new Error(`Folder permission is ${permission}. Restore folder access before rescanning.`);
        }
        const candidates = await collectDirectoryFiles(source.directoryHandle, controller.signal, (relativePath) => {
          sendProgress(options, { phase: "enumerating", completed: 0, total: null, relativePath });
        });
        return await this.scanAndCommit(snapshot, source, candidates, analyzer, controller, options);
      } finally {
        this.finishScan(controller);
      }
    });
  }

  async addFiles(
    files: FileList | readonly File[],
    analyzer: LocalFolderAnalyzer,
    options: AddLocalFilesOptions = {},
  ): Promise<LocalFolderScanResult> {
    const controller = this.beginScan(options.signal);
    return this.runMutation(async () => {
      try {
        const snapshot = await this.readSnapshot();
        const normalized = collectFileList(files, options.sourceName);
        const source = makeSource("files", normalized.rootName);
        return await this.scanAndCommit(snapshot, source, normalized.candidates, analyzer, controller, options);
      } finally {
        this.finishScan(controller);
      }
    });
  }

  async rescanFiles(
    sourceId: string,
    files: FileList | readonly File[],
    analyzer: LocalFolderAnalyzer,
    options: AddLocalFilesOptions = {},
  ): Promise<LocalFolderScanResult> {
    const controller = this.beginScan(options.signal);
    return this.runMutation(async () => {
      try {
        const snapshot = await this.readSnapshot();
        const source = snapshot.sources.find((item) => item.id === sourceId);
        if (!source || source.kind !== "files") throw new Error("The selected file-list source no longer exists.");
        const normalized = collectFileList(files, options.sourceName ?? source.name);
        return await this.scanAndCommit(snapshot, source, normalized.candidates, analyzer, controller, options);
      } finally {
        this.finishScan(controller);
      }
    });
  }

  cancelCurrentScan(): boolean {
    if (!this.activeScan) return false;
    this.activeScan.abort();
    return true;
  }

  async requestSourcePermission(sourceId: string): Promise<LocalFolderPermission> {
    const snapshot = await this.readMetadataSnapshot();
    const source = snapshot.sources.find((item) => item.id === sourceId);
    if (!source || source.kind !== "directory" || !source.directoryHandle) return "unsupported";
    const handle = source.directoryHandle as PermissionHandleLike;
    if (typeof handle.queryPermission !== "function" && typeof handle.requestPermission !== "function") return "unsupported";
    const descriptor = { mode: "read" as const };
    try {
      const permission = handle.queryPermission
        ? await handle.queryPermission(descriptor)
        : "prompt";
      if (permission === "prompt" && handle.requestPermission) {
        return await handle.requestPermission(descriptor);
      }
      return permission;
    } catch {
      return "denied";
    }
  }

  async openEntryMidi(entryId: string): Promise<Uint8Array> {
    const snapshot = await this.readMetadataSnapshot();
    if (!snapshot.entries.some((entry) => entry.id === entryId)) {
      throw new Error("The selected melody is no longer in this library.");
    }
    const rawCache = await this.store.loadMidiCache(entryId) as LocalFolderMidiCacheEntry | null;
    const cache = rawCache && rawCache.midiBytes instanceof Uint8Array ? rawCache : null;
    if (!cache) throw new Error("Canonical MIDI is unavailable for this melody. Rescan its source to rebuild the cache.");
    if (cache.sha256 !== snapshot.entries.find((entry) => entry.id === entryId)?.canonicalMidiSha256 || await sha256(cache.midiBytes) !== cache.sha256) {
      throw new Error("Canonical MIDI cache integrity check failed for this melody.");
    }
    return cloneBytes(cache.midiBytes);
  }

  private async findExistingDirectorySource(
    snapshot: LocalFolderLibrarySnapshot,
    handle: FileSystemDirectoryHandle,
  ): Promise<LocalFolderSource | undefined> {
    for (const source of snapshot.sources) {
      if (source.kind !== "directory" || !source.directoryHandle) continue;
      if (source.directoryHandle === handle) return source;
      const previous = source.directoryHandle as PermissionHandleLike;
      try {
        if (previous.isSameEntry && await previous.isSameEntry(handle)) return source;
      } catch {
        // A non-permitted old handle can still be retained as a separate source.
      }
    }
    return undefined;
  }

  private async currentPermission(handle: FileSystemDirectoryHandle): Promise<LocalFolderPermission> {
    const permissionHandle = handle as PermissionHandleLike;
    if (!permissionHandle.queryPermission) return "unsupported";
    try {
      return await permissionHandle.queryPermission({ mode: "read" });
    } catch {
      return "denied";
    }
  }

  private async scanAndCommit(
    previous: LocalFolderLibrarySnapshot,
    source: LocalFolderSource,
    candidates: FileCandidate[],
    analyzer: LocalFolderAnalyzer,
    controller: AbortController,
    options: LocalFolderScanOptions,
  ): Promise<LocalFolderScanResult> {
    throwIfAborted(controller.signal);
    const sourceEntries = previous.entries.filter((entry) => entry.sourceId === source.id);
    const oldEntriesByPath = new Map(sourceEntries.map((entry) => [entry.relativePath, entry]));
    const uniqueCandidates = new Map<string, FileCandidate>();
    const errors: LocalFolderScanError[] = [];
    for (const candidate of candidates) {
      if (uniqueCandidates.has(candidate.relativePath)) {
        errors.push({ relativePath: candidate.relativePath, message: "Duplicate file path in the selected folder." });
        continue;
      }
      uniqueCandidates.set(candidate.relativePath, candidate);
    }

    const nextEntries: LocalFolderEntry[] = [];
    const nextCache: Record<string, LocalFolderMidiCacheEntry> = {};
    let analyzedCount = 0;
    let reusedCount = 0;
    const list = Array.from(uniqueCandidates.values());

    for (let index = 0; index < list.length; index += 1) {
      const candidate = list[index]!;
      throwIfAborted(controller.signal);
      sendProgress(options, { phase: "analyzing", completed: index, total: list.length, relativePath: candidate.relativePath });
      const previousEntry = oldEntriesByPath.get(candidate.relativePath);
      const previousCache = previousEntry ? previous.canonicalMidiCache[previousEntry.id] : undefined;
      let previousCacheValid = false;
      if (
        previousEntry && previousCache &&
        previousCache.sha256 === previousEntry.canonicalMidiSha256 &&
        isSmfBytes(previousCache.midiBytes)
      ) {
        try {
          previousCacheValid = await sha256(previousCache.midiBytes) === previousEntry.canonicalMidiSha256;
        } catch {
          if (controller.signal.aborted) throw makeAbortError();
        }
      }

      if (candidate.error || !candidate.file) {
        errors.push(makeCandidateError(candidate.relativePath, candidate.error ?? new Error("Could not read this file.")));
        if (previousEntry && previousCache && previousCacheValid) {
          nextEntries.push(previousEntry);
          nextCache[previousEntry.id] = previousCache;
        }
        continue;
      }

      const file = candidate.file;
      const lastModified = Number.isFinite(file.lastModified) ? file.lastModified : 0;
      if (
        previousEntry && previousCache && previousCacheValid &&
        previousEntry.size === file.size &&
        previousEntry.lastModified === lastModified
      ) {
        nextEntries.push(previousEntry);
        nextCache[previousEntry.id] = previousCache;
        reusedCount += 1;
        continue;
      }

      try {
        if (file.size === 0) throw new Error("The file is empty.");
        if (file.size > MAX_MIDI_FILE_SIZE_BYTES) {
          throw new Error(`File exceeds the ${MAX_MIDI_FILE_SIZE_BYTES}-byte local score limit.`);
        }
        const originalBytes = new Uint8Array(await file.arrayBuffer());
        throwIfAborted(controller.signal);
        if (originalBytes.byteLength !== file.size) throw new Error("The file byte count changed while it was being read.");
        const sourceFormat = detectScoreFileFormat(candidate.name, originalBytes);
        if (!sourceFormat) throw new Error("The file contents do not match a supported score format.");
        if (originalBytes.byteLength > MAX_MIDI_FILE_SIZE_BYTES) {
          throw new Error(`File exceeds the ${MAX_MIDI_FILE_SIZE_BYTES}-byte local score limit.`);
        }
        const analysis = await analyzer({ name: candidate.name, bytes: originalBytes, signal: controller.signal });
        throwIfAborted(controller.signal);
        validAnalysis(analysis);
        const originalSha256 = await sha256(originalBytes);
        const canonicalBytes = cloneBytes(analysis.midiBytes);
        const canonicalMidiSha256 = await sha256(canonicalBytes);
        const folderSegments = candidate.relativePath.split("/");
        const firstLevelFolder = folderSegments.length > 1 ? folderSegments[0]! : null;
        const entryId = makeEntryId(source.id, candidate.relativePath);
        const entry: LocalFolderEntry = {
          id: entryId,
          sourceId: source.id,
          relativePath: candidate.relativePath,
          name: candidate.name,
          firstLevelFolder,
          firstLevelFolderId: firstLevelFolder ? makeFolderId(source.id, firstLevelFolder) : null,
          title: analysis.title?.trim() || extensionlessName(candidate.name),
          addedAt: previousEntry?.addedAt ?? Date.now(),
          sourceFormat,
          originalSha256,
          canonicalMidiSha256,
          size: file.size,
          lastModified,
          durationSeconds: analysis.durationSeconds,
          noteCount: analysis.noteCount,
          difficultyScore: analysis.difficultyScore,
          difficultyTier: analysis.difficultyTier,
          ...(analysis.previewNotes ? { previewNotes: deepCloneNotes(analysis.previewNotes) } : {}),
        };
        nextEntries.push(entry);
        nextCache[entryId] = { sha256: canonicalMidiSha256, midiBytes: canonicalBytes };
        analyzedCount += 1;
      } catch (error) {
        if (controller.signal.aborted) throw makeAbortError();
        errors.push(makeCandidateError(candidate.relativePath, error));
        if (previousEntry && previousCache && previousCacheValid) {
          nextEntries.push(previousEntry);
          nextCache[previousEntry.id] = previousCache;
        }
      }
    }

    throwIfAborted(controller.signal);
    const now = Date.now();
    const committedSource: LocalFolderSource = {
      ...source,
      lastScannedAt: now,
      entryCount: nextEntries.length,
      lastScanErrorCount: errors.length,
    };
    const otherEntries = previous.entries.filter((entry) => entry.sourceId !== source.id);
    const sources = previous.sources.some((item) => item.id === source.id)
      ? previous.sources.map((item) => item.id === source.id ? committedSource : item)
      : [...previous.sources, committedSource];
    let selectedSourceId = previous.selectedSourceId;
    let selectedEntryId = previous.selectedEntryId;
    if (selectedSourceId === null || selectedSourceId === source.id) {
      selectedSourceId = source.id;
      if (!nextEntries.some((entry) => entry.id === selectedEntryId)) selectedEntryId = nextEntries[0]?.id ?? null;
    }
    const nextSnapshot: LocalFolderLibrarySnapshot = {
      schemaVersion: 1,
      revision: previous.revision + 1,
      sources,
      entries: [...otherEntries, ...nextEntries],
      canonicalMidiCache: {
        ...Object.fromEntries(Object.entries(previous.canonicalMidiCache).filter(([entryId]) => !sourceEntries.some((entry) => entry.id === entryId))),
        ...nextCache,
      },
      selectedSourceId,
      selectedEntryId,
    };

    throwIfAborted(controller.signal);
    sendProgress(options, { phase: "saving", completed: list.length, total: list.length });
    await this.store.saveSnapshot(nextSnapshot, controller.signal);
    const resultSnapshot = cloneLibraryView(nextSnapshot);
    sendProgress(options, { phase: "complete", completed: list.length, total: list.length });
    return { snapshot: resultSnapshot, errors, analyzedCount, reusedCount };
  }
}

export const localFolderLibrary = new LocalFolderLibrary();

/** Small adapter for drag/drop and input handlers that only need directory roots. */
export function isLocalDirectoryHandle(value: unknown): value is FileSystemDirectoryHandle {
  return value !== null && typeof value === "object" &&
    (value as FileSystemHandle).kind === "directory" &&
    typeof (value as FileSystemDirectoryHandle).values === "function";
}
