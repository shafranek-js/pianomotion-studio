import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  AlertCircle,
  ArrowUpDown,
  FolderOpen,
  FolderPlus,
  Music2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Star,
  X,
} from "lucide-react";
import { StudioDialog } from "../studio/StudioDialog";
import { useI18n } from "../i18n";
import { analyzeLibraryBytes } from "./libraryAnalysisClient";
import { loadBuiltinMelodies, loadBuiltinMelodyBytes, type BuiltinMelodyEntry } from "./catalog";
import { getFavouriteMelodyIds, subscribeFavourites, toggleFavouriteMelody } from "./favourites";
import {
  localFolderLibrary,
  type LocalFolderAnalysisInput,
  type LocalFolderEntry,
  type LocalFolderLibraryView,
  type LocalFolderScanError,
  type LocalFolderScanProgress,
  type LocalFolderScanResult,
  type LocalFolderSource,
} from "./localFolderLibrary";
import { getLibraryStrings } from "./libraryStrings";
import { getRecentMelodyIds, subscribeLibraryRecents } from "./libraryRecents";
import { prepareLibraryPreview, stopLibraryPreview, type LibraryPreviewHandle } from "./libraryPreview";
import {
  loadBuiltinMelodiesPreferences,
  saveBuiltinMelodiesPreferences,
  type BuiltinMelodiesPreferences,
  type SortOption,
} from "./libraryPreferences";
import styles from "./BuiltinMelodiesDialog.module.css";

type CatalogResult =
  | { attempt: number; state: "ready"; entries: BuiltinMelodyEntry[] }
  | { attempt: number; state: "error"; message: string };

type LibraryCardEntry = {
  key: string;
  id: string;
  sourceId: string;
  kind: "builtin" | "local";
  title: string;
  sourceName: string;
  location: string;
  categoryId: string | null;
  categoryName: string | null;
  durationSeconds: number | undefined;
  noteCount: number | undefined;
  difficultyScore: number;
  difficultyTier: string;
  addedAt: number | undefined;
  builtin?: BuiltinMelodyEntry;
  local?: LocalFolderEntry;
};

type ScanSummary = { analyzedCount: number; reusedCount: number; errorCount: number };
type ScanRunner = (signal: AbortSignal, onProgress: (progress: LocalFolderScanProgress) => void) => Promise<LocalFolderScanResult>;

interface BuiltinMelodiesDialogProps {
  open: boolean;
  onClose(): void;
  /** Existing built-in callback remains valid for current callers. */
  onChoose(entry: BuiltinMelodyEntry): void | boolean | Promise<void | boolean>;
  onChooseLocal?(entry: LocalFolderEntry, midiBytes: ArrayBuffer): void | Promise<void>;
  busy?: boolean;
}

interface WebkitFileEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file(success: (file: File) => void, failure?: (error: DOMException) => void): void;
  createReader(): { readEntries(success: (entries: WebkitFileEntry[]) => void, failure?: (error: DOMException) => void): void };
}

type WebkitDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => WebkitFileEntry | null;
};

function tierBadgeClass(tier: string): string {
  switch (tier) {
    case "Beginner": return styles.badgeBeginner;
    case "Intermediate": return styles.badgeIntermediate;
    case "Advanced": return styles.badgeAdvanced;
    case "Virtuoso": return styles.badgeVirtuoso;
    default: return styles.badgeNeutral;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function compareNullableNumber(left: number | undefined, right: number | undefined, direction: 1 | -1): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return direction * (left - right);
}

function attachWebkitRelativePath(file: File, path: string): File {
  try {
    Object.defineProperty(file, "webkitRelativePath", { configurable: true, value: path });
    return file;
  } catch {
    try {
      const copy = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
      Object.defineProperty(copy, "webkitRelativePath", { configurable: true, value: path });
      return copy;
    } catch {
      return file;
    }
  }
}

function readWebkitFile(entry: WebkitFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readWebkitEntries(entry: WebkitFileEntry): Promise<WebkitFileEntry[]> {
  const reader = entry.createReader();
  const entries: WebkitFileEntry[] = [];
  return new Promise((resolve, reject) => {
    const readBatch = () => reader.readEntries((batch) => {
      if (batch.length === 0) {
        resolve(entries);
        return;
      }
      entries.push(...batch);
      readBatch();
    }, reject);
    readBatch();
  });
}

async function collectWebkitEntryFiles(entry: WebkitFileEntry, path: string, output: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await readWebkitFile(entry);
    output.push(attachWebkitRelativePath(file, path));
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readWebkitEntries(entry);
  for (const child of children) await collectWebkitEntryFiles(child, `${path}/${child.name}`, output);
}

async function collectDroppedFiles(items: readonly DataTransferItem[]): Promise<File[]> {
  const files: File[] = [];
  for (const item of items) {
    const webkitItem = item as WebkitDataTransferItem;
    const entry = webkitItem.webkitGetAsEntry?.() as WebkitFileEntry | null | undefined;
    if (entry) {
      await collectWebkitEntryFiles(entry, entry.name, files);
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function toBuiltinCardEntry(entry: BuiltinMelodyEntry): LibraryCardEntry {
  return {
    key: `builtin:${entry.id}`,
    id: entry.id,
    sourceId: "builtin",
    kind: "builtin",
    title: entry.title,
    sourceName: "Built-in",
    location: entry.fileName,
    categoryId: null,
    categoryName: null,
    durationSeconds: entry.durationSeconds,
    noteCount: entry.noteCount,
    difficultyScore: entry.difficultyScore,
    difficultyTier: entry.difficultyTier,
    addedAt: (entry as BuiltinMelodyEntry & { addedAt?: number }).addedAt,
    builtin: entry,
  };
}

function toLocalCardEntry(entry: LocalFolderEntry, source: LocalFolderSource | undefined): LibraryCardEntry {
  return {
    key: `local:${entry.id}`,
    id: entry.id,
    sourceId: entry.sourceId,
    kind: "local",
    title: entry.title,
    sourceName: source?.name ?? "Local folder",
    location: `${source?.name ?? "Local folder"} · ${entry.relativePath}`,
    categoryId: entry.firstLevelFolderId,
    categoryName: entry.firstLevelFolder,
    durationSeconds: entry.durationSeconds,
    noteCount: entry.noteCount,
    difficultyScore: entry.difficultyScore,
    difficultyTier: entry.difficultyTier,
    addedAt: entry.addedAt,
    local: entry,
  };
}

function getFilePicker(): (() => Promise<FileSystemDirectoryHandle>) | null {
  if (typeof window === "undefined") return null;
  const picker = (window as Window & {
    showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (typeof picker !== "function") return null;
  return () => picker.call(window, { mode: "read" });
}

export function BuiltinMelodiesDialog({ open, onClose, onChoose, onChooseLocal, busy = false }: BuiltinMelodiesDialogProps) {
  const { dict, language } = useI18n();
  const strings = useMemo(() => getLibraryStrings(language), [language]);
  const searchId = useId();
  const sortId = useId();
  const sourceIdInput = useId();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileIntentRef = useRef<"add" | "rescan">("add");
  const scanControllerRef = useRef<AbortController | null>(null);
  const previewHandleRef = useRef<LibraryPreviewHandle | null>(null);
  const previewLoadControllerRef = useRef<AbortController | null>(null);
  const previewGenerationRef = useRef(0);
  const openActionGenerationRef = useRef(0);
  const dragDepthRef = useRef(0);

  const [preferences, setPreferences] = useState<BuiltinMelodiesPreferences>(() => loadBuiltinMelodiesPreferences());
  const { query, activeFilter, sortBy, libraryView, categoryId, recentOnly } = preferences;
  const [favouriteIds, setFavouriteIds] = useState<ReadonlySet<string>>(() => getFavouriteMelodyIds());
  const [recentIds, setRecentIds] = useState<ReadonlySet<string>>(() => getRecentMelodyIds());
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [catalogResult, setCatalogResult] = useState<CatalogResult | null>(null);
  const [localView, setLocalView] = useState<LocalFolderLibraryView | null>(null);
  const [localError, setLocalError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pickerFallbackAvailable, setPickerFallbackAvailable] = useState(false);
  const [scanProgress, setScanProgress] = useState<LocalFolderScanProgress | null>(null);
  const [scanErrors, setScanErrors] = useState<LocalFolderScanError[]>([]);
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null);
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [openingKey, setOpeningKey] = useState("");
  const [activePreviewKey, setActivePreviewKey] = useState("");
  const [permissionSnapshot, setPermissionSnapshot] = useState<{
    sourceId: string;
    permission: "granted" | "prompt" | "denied" | "unsupported";
  } | null>(null);

  const updatePreferences = useCallback((patch: Partial<BuiltinMelodiesPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      saveBuiltinMelodiesPreferences(next);
      return next;
    });
  }, []);

  const applyLocalView = useCallback((view: LocalFolderLibraryView) => {
    setLocalView(view);
    setLocalError("");
  }, []);

  const refreshLocalView = useCallback(async () => {
    try {
      const next = await localFolderLibrary.getLibraryView();
      applyLocalView(next);
    } catch (error) {
      setLocalError(asErrorMessage(error));
    }
  }, [applyLocalView]);

  const stopPreview = useCallback(async () => {
    previewGenerationRef.current += 1;
    previewLoadControllerRef.current?.abort();
    previewLoadControllerRef.current = null;
    previewHandleRef.current?.stop();
    previewHandleRef.current = null;
    setActivePreviewKey("");
    try {
      await stopLibraryPreview();
    } catch {
      // Preview cleanup is best effort so the dialog can always close or switch sources.
    }
  }, []);

  useEffect(() => subscribeFavourites((next) => setFavouriteIds(new Set(next))), []);
  useEffect(() => subscribeLibraryRecents((next) => setRecentIds(new Set(next.map((item) => item.id)))), []);
  const setFolderInputRef = useCallback((node: HTMLInputElement | null) => {
    folderInputRef.current = node;
    node?.setAttribute("webkitdirectory", "");
  }, []);

  useLayoutEffect(() => {
    openActionGenerationRef.current += 1;
    return () => { openActionGenerationRef.current += 1; };
  }, [open]);

  useEffect(() => {
    if (!open || catalogResult?.attempt === loadAttempt) return;
    const controller = new AbortController();
    void loadBuiltinMelodies(controller.signal).then((entries) => {
      if (!controller.signal.aborted) setCatalogResult({ attempt: loadAttempt, state: "ready", entries });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setCatalogResult({ attempt: loadAttempt, state: "error", message: asErrorMessage(error) });
    });
    return () => controller.abort();
  }, [open, loadAttempt, catalogResult]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void localFolderLibrary.getLibraryView().then((view) => {
      if (current) applyLocalView(view);
    }).catch((error: unknown) => {
      if (current) setLocalError(asErrorMessage(error));
    });
    return () => {
      current = false;
      scanControllerRef.current?.abort();
      localFolderLibrary.cancelCurrentScan();
      void stopPreview();
    };
  }, [open, applyLocalView, stopPreview]);

  const selectedSource = useMemo(
    () => localView?.sources.find((source) => source.id === localView.selectedSourceId) ?? null,
    [localView],
  );

  const permissionState = useMemo(() => {
    if (!selectedSource || selectedSource.kind !== "directory") return "unknown" as const;
    if (!selectedSource.directoryHandle) return "unsupported" as const;
    const handle = selectedSource.directoryHandle as FileSystemDirectoryHandle & {
      queryPermission?: (descriptor?: { mode?: "read" }) => Promise<PermissionState>;
    };
    if (typeof handle.queryPermission !== "function") return "unsupported" as const;
    if (permissionSnapshot?.sourceId !== selectedSource.id) return "unknown" as const;
    return permissionSnapshot.permission;
  }, [selectedSource, permissionSnapshot]);

  useEffect(() => {
    let current = true;
    if (!selectedSource || selectedSource.kind !== "directory" || !selectedSource.directoryHandle) {
      return;
    }
    const handle = selectedSource.directoryHandle;
    const readableHandle = handle as FileSystemDirectoryHandle & {
      queryPermission?: (descriptor?: { mode?: "read" }) => Promise<PermissionState>;
    };
    if (typeof readableHandle.queryPermission !== "function") {
      return;
    }
    void readableHandle.queryPermission({ mode: "read" }).then((permission) => {
      if (current) setPermissionSnapshot({ sourceId: selectedSource.id, permission });
    }).catch(() => {
      if (current) setPermissionSnapshot({ sourceId: selectedSource.id, permission: "denied" });
    });
    return () => { current = false; };
  }, [selectedSource]);

  const currentCatalog = catalogResult?.attempt === loadAttempt ? catalogResult : null;

  const allCardEntries = useMemo(() => {
    const builtins = currentCatalog?.state === "ready" ? currentCatalog.entries.map(toBuiltinCardEntry) : [];
    const localEntries = (localView?.entries ?? [])
      .filter((entry) => libraryView === "all" || !localView?.selectedSourceId || entry.sourceId === localView.selectedSourceId)
      .map((entry) => toLocalCardEntry(entry, localView?.sources.find((source) => source.id === entry.sourceId)));
    if (libraryView === "builtin") return builtins;
    if (libraryView === "folder") return localEntries;
    return [...builtins, ...localEntries];
  }, [currentCatalog, localView, libraryView]);

  const categoryChoices = useMemo(() => {
    const choices = new Map<string, { name: string; sourceName: string; count: number }>();
    for (const entry of allCardEntries) {
      if (!entry.categoryId || !entry.categoryName) continue;
      const current = choices.get(entry.categoryId);
      choices.set(entry.categoryId, {
        name: entry.categoryName,
        sourceName: entry.sourceName,
        count: (current?.count ?? 0) + 1,
      });
    }
    const ordered = [...choices.entries()]
      .map(([id, value]) => ({ id, ...value }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.sourceName.localeCompare(right.sourceName) || left.id.localeCompare(right.id));
    if (libraryView !== "all") return ordered.map((choice) => ({ ...choice, label: choice.name }));

    const folderNameCounts = new Map<string, number>();
    for (const choice of ordered) {
      const key = choice.name.normalize("NFC").toLocaleLowerCase();
      folderNameCounts.set(key, (folderNameCounts.get(key) ?? 0) + 1);
    }
    const labels = ordered.map((choice) => {
      const key = choice.name.normalize("NFC").toLocaleLowerCase();
      return folderNameCounts.get(key)! > 1 ? `${choice.sourceName} · ${choice.name}` : choice.name;
    });
    const labelCounts = new Map<string, number>();
    for (const label of labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    const duplicateIndexes = new Map<string, number>();
    return ordered.map((choice, index) => {
      const label = labels[index]!;
      if (labelCounts.get(label)! === 1) return { ...choice, label };
      const duplicateIndex = (duplicateIndexes.get(label) ?? 0) + 1;
      duplicateIndexes.set(label, duplicateIndex);
      return { ...choice, label: `${label} (${duplicateIndex})` };
    });
  }, [allCardEntries, libraryView]);

  const filterCounts = useMemo(() => {
    let favourites = 0;
    let recent = 0;
    const tiers: Record<string, number> = { Beginner: 0, Intermediate: 0, Advanced: 0, Virtuoso: 0 };
    for (const entry of allCardEntries) {
      if (favouriteIds.has(entry.id)) favourites += 1;
      if (recentIds.has(entry.id)) recent += 1;
      if (entry.difficultyTier in tiers) tiers[entry.difficultyTier] = (tiers[entry.difficultyTier] ?? 0) + 1;
    }
    return { all: allCardEntries.length, favourites, recent, tiers };
  }, [allCardEntries, favouriteIds, recentIds]);

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    let result = allCardEntries;
    if (activeFilter === "favourites") result = result.filter((entry) => favouriteIds.has(entry.id));
    else if (activeFilter === "Advanced") result = result.filter((entry) => entry.difficultyTier === "Advanced");
    else if (activeFilter !== "all") result = result.filter((entry) => entry.difficultyTier === activeFilter);
    if (recentOnly) result = result.filter((entry) => recentIds.has(entry.id));
    if (categoryId !== "all") result = result.filter((entry) => entry.categoryId === categoryId);
    if (needle) {
      result = result.filter((entry) => `${entry.title} ${entry.location}`.toLocaleLowerCase().includes(needle));
    }

    const sorted = [...result];
    const byTitle = (left: LibraryCardEntry, right: LibraryCardEntry) =>
      left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) || left.key.localeCompare(right.key);
    if (sortBy === "difficulty-asc") sorted.sort((left, right) => left.difficultyScore - right.difficultyScore || byTitle(left, right));
    else if (sortBy === "difficulty-desc") sorted.sort((left, right) => right.difficultyScore - left.difficultyScore || byTitle(left, right));
    else if (sortBy === "duration-asc") sorted.sort((left, right) => compareNullableNumber(left.durationSeconds, right.durationSeconds, 1) || byTitle(left, right));
    else if (sortBy === "duration-desc") sorted.sort((left, right) => compareNullableNumber(left.durationSeconds, right.durationSeconds, -1) || byTitle(left, right));
    else if (sortBy === "date-added-asc") sorted.sort((left, right) => compareNullableNumber(left.addedAt, right.addedAt, 1) || byTitle(left, right));
    else if (sortBy === "date-added-desc") sorted.sort((left, right) => compareNullableNumber(left.addedAt, right.addedAt, -1) || byTitle(left, right));
    else sorted.sort(byTitle);
    return sorted;
  }, [allCardEntries, activeFilter, favouriteIds, recentOnly, recentIds, categoryId, query, sortBy]);

  const runScan = useCallback(async (runner: ScanRunner, selectLatestSource = false) => {
    if (scanControllerRef.current) return;
    const controller = new AbortController();
    scanControllerRef.current = controller;
    setIsScanning(true);
    setScanProgress({ phase: "enumerating", completed: 0, total: null });
    setScanErrors([]);
    setScanSummary(null);
    setActionError("");
    setAnalysisMessage("");
    try {
      const result = await runner(controller.signal, setScanProgress);
      if (controller.signal.aborted) return;
      let nextView = result.snapshot;
      if (selectLatestSource && libraryView === "folder") {
        const latestSource = [...result.snapshot.sources].sort((left, right) => right.lastScannedAt - left.lastScannedAt)[0];
        if (latestSource) nextView = await localFolderLibrary.selectSource(latestSource.id);
      }
      applyLocalView(nextView);
      setScanErrors(result.errors);
      setScanSummary({ analyzedCount: result.analyzedCount, reusedCount: result.reusedCount, errorCount: result.errors.length });
      setScanProgress({ phase: "complete", completed: result.analyzedCount + result.reusedCount, total: result.analyzedCount + result.reusedCount });
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) setActionError(asErrorMessage(error));
      if (!controller.signal.aborted) await refreshLocalView();
    } finally {
      if (scanControllerRef.current === controller) scanControllerRef.current = null;
      setIsScanning(false);
      setAnalysisMessage("");
    }
  }, [applyLocalView, libraryView, refreshLocalView]);

  const analyzer = useCallback((input: LocalFolderAnalysisInput) => analyzeLibraryBytes(input, {
    signal: input.signal,
    onProgress: setAnalysisMessage,
  }), []);

  const startDirectoryScan = useCallback((handle: FileSystemDirectoryHandle) => {
    void stopPreview();
    void runScan((signal, onProgress) => localFolderLibrary.addDirectory(handle, analyzer, { signal, onProgress }), true);
  }, [analyzer, runScan, stopPreview]);

  const openFolderPicker = useCallback(() => {
    setActionError("");
    setPickerFallbackAvailable(false);
    fileIntentRef.current = "add";
    const picker = getFilePicker();
    if (!picker) {
      folderInputRef.current?.click();
      return;
    }
    void picker().then(startDirectoryScan).catch((error: unknown) => {
      if (!isAbortError(error)) {
        setActionError(asErrorMessage(error));
        setPickerFallbackAvailable(true);
      }
    });
  }, [startDirectoryScan]);

  const handleFiles = useCallback((files: FileList | readonly File[], intent: "add" | "rescan" = "add") => {
    const source = selectedSource;
    const rescanExistingFiles = intent === "rescan" && source?.kind === "files";
    void stopPreview();
    void runScan((signal, onProgress) => rescanExistingFiles
      ? localFolderLibrary.rescanFiles(source.id, files, analyzer, { sourceName: source.name, signal, onProgress })
      : localFolderLibrary.addFiles(files, analyzer, { signal, onProgress }), true);
  }, [analyzer, runScan, selectedSource, stopPreview]);

  const handleFileInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = input.files ? Array.from(input.files) : [];
    if (files.length > 0) handleFiles(files, fileIntentRef.current);
    fileIntentRef.current = "add";
    input.value = "";
  }, [handleFiles]);

  const rescanSelectedSource = useCallback(() => {
    if (!selectedSource) {
      openFolderPicker();
      return;
    }
    if (selectedSource.kind === "directory") {
      if (!selectedSource.directoryHandle) {
        setActionError("Select this folder again to restore access.");
        openFolderPicker();
        return;
      }
      void stopPreview();
      void runScan((signal, onProgress) => localFolderLibrary.rescanDirectory(selectedSource.id, analyzer, { signal, onProgress }));
      return;
    }
    fileIntentRef.current = "rescan";
    folderInputRef.current?.click();
  }, [analyzer, openFolderPicker, runScan, selectedSource, stopPreview]);

  const restoreFolderAccess = useCallback(async () => {
    if (!selectedSource) return;
    setActionError("");
    try {
      const handle = selectedSource.directoryHandle as (FileSystemDirectoryHandle & {
        requestPermission?: (descriptor?: { mode?: "read" }) => Promise<PermissionState>;
      }) | undefined;
      // Start the browser permission request before the first await so the
      // saved handle keeps the user's click activation.
      const permissionRequest = handle?.requestPermission
        ? handle.requestPermission({ mode: "read" })
        : localFolderLibrary.requestSourcePermission(selectedSource.id);
      const permission = await permissionRequest;
      setPermissionSnapshot({ sourceId: selectedSource.id, permission });
      await refreshLocalView();
      if (permission === "granted") {
        void runScan((signal, onProgress) => localFolderLibrary.rescanDirectory(selectedSource.id, analyzer, { signal, onProgress }));
      } else if (permission === "unsupported") {
        setActionError(strings.unsupportedFolderPicker);
      } else {
        setActionError(`Folder access is ${permission}. Select the folder again to restore access.`);
      }
    } catch (error) {
      setActionError(asErrorMessage(error));
    }
  }, [analyzer, refreshLocalView, runScan, selectedSource, strings.unsupportedFolderPicker]);

  const cancelScan = useCallback(() => {
    scanControllerRef.current?.abort();
    localFolderLibrary.cancelCurrentScan();
  }, []);

  const selectLibraryView = useCallback((view: BuiltinMelodiesPreferences["libraryView"]) => {
    if (libraryView === view) return;
    void stopPreview();
    updatePreferences({ libraryView: view, categoryId: "all" });
  }, [libraryView, stopPreview, updatePreferences]);

  const selectSource = useCallback(async (sourceId: string) => {
    void stopPreview();
    setActionError("");
    try {
      const next = await localFolderLibrary.selectSource(sourceId || null);
      applyLocalView(next);
      updatePreferences({ categoryId: "all" });
    } catch (error) {
      setActionError(asErrorMessage(error));
    }
  }, [applyLocalView, stopPreview, updatePreferences]);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    const items = Array.from(event.dataTransfer.items);
    void (async () => {
      for (const item of items) {
        const handleGetter = (item as DataTransferItem & {
          getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
        }).getAsFileSystemHandle;
        if (typeof handleGetter !== "function") continue;
        try {
          const handle = await handleGetter.call(item);
          if (handle?.kind === "directory") {
            startDirectoryScan(handle as FileSystemDirectoryHandle);
            return;
          }
        } catch {
          // Try the cross-browser webkit entry fallback below.
        }
      }
      try {
        const files = await collectDroppedFiles(items);
        if (files.length === 0) {
          setActionError(strings.directoryReadError);
          return;
        }
        handleFiles(files);
      } catch (error) {
        setActionError(`${strings.directoryReadError} ${asErrorMessage(error)}`);
      }
    })();
  }, [handleFiles, startDirectoryScan, strings.directoryReadError]);

  const handleChooseBuiltin = useCallback(async (entry: BuiltinMelodyEntry) => {
    const generation = openActionGenerationRef.current;
    setActionError("");
    await stopPreview();
    if (!open || generation !== openActionGenerationRef.current) return;
    try {
      await onChoose(entry);
    } catch (error) {
      setActionError(asErrorMessage(error));
    }
  }, [onChoose, open, stopPreview]);

  const handleChooseLocal = useCallback(async (entry: LocalFolderEntry) => {
    if (!onChooseLocal) return;
    const generation = openActionGenerationRef.current;
    setActionError("");
    setOpeningKey(`local:${entry.id}`);
    try {
      await stopPreview();
      if (!open || generation !== openActionGenerationRef.current) return;
      const bytes = await localFolderLibrary.openEntryMidi(entry.id);
      if (!open || generation !== openActionGenerationRef.current) return;
      await onChooseLocal(entry, bytes.slice().buffer as ArrayBuffer);
    } catch (error) {
      setActionError(asErrorMessage(error));
    } finally {
      setOpeningKey("");
    }
  }, [onChooseLocal, open, stopPreview]);

  const togglePreview = useCallback(async (entry: LibraryCardEntry) => {
    if (activePreviewKey === entry.key) {
      await stopPreview();
      return;
    }
    const generation = ++previewGenerationRef.current;
    previewLoadControllerRef.current?.abort();
    previewHandleRef.current?.stop();
    previewHandleRef.current = null;
    const controller = new AbortController();
    previewLoadControllerRef.current = controller;
    previewHandleRef.current = null;
    setActionError("");
    setActivePreviewKey(entry.key);
    let reservation: ReturnType<typeof prepareLibraryPreview> | null = null;
    try {
      // This synchronous reservation creates/resumes audio inside the click
      // gesture, before local file reads or worker analysis can yield.
      reservation = prepareLibraryPreview();
      let notes = entry.local?.previewNotes;
      if (!notes && entry.local) {
        const bytes = await localFolderLibrary.openEntryMidi(entry.local.id);
        const analyzed = await analyzeLibraryBytes({ name: `${entry.local.title}.mid`, bytes, signal: controller.signal }, { signal: controller.signal });
        notes = analyzed.previewNotes;
      } else if (!notes && entry.builtin) {
        const bytes = new Uint8Array(await loadBuiltinMelodyBytes(entry.builtin, controller.signal));
        const analyzed = await analyzeLibraryBytes({ name: entry.builtin.fileName, bytes, signal: controller.signal }, { signal: controller.signal });
        notes = analyzed.previewNotes;
      }
      if (controller.signal.aborted || generation !== previewGenerationRef.current) {
        await reservation.stop();
        return;
      }
      if (!notes || notes.length === 0) throw new Error(strings.previewUnavailable);
      const handle = await reservation.play(notes, { seconds: 12 });
      if (controller.signal.aborted || generation !== previewGenerationRef.current) {
        handle.stop();
        return;
      }
      previewHandleRef.current = handle;
      void handle.done.finally(() => {
        if (generation === previewGenerationRef.current) {
          previewHandleRef.current = null;
          setActivePreviewKey("");
        }
      });
    } catch (error) {
      if (reservation) await reservation.stop();
      if (!controller.signal.aborted && !isAbortError(error)) setActionError(`${strings.previewError} ${asErrorMessage(error)}`);
      if (generation === previewGenerationRef.current) setActivePreviewKey("");
    } finally {
      if (previewLoadControllerRef.current === controller) previewLoadControllerRef.current = null;
    }
  }, [activePreviewKey, stopPreview, strings.previewError, strings.previewUnavailable]);

  const handleDialogClose = useCallback(() => {
    openActionGenerationRef.current += 1;
    void stopPreview();
    onClose();
  }, [onClose, stopPreview]);

  const visibleBuiltins = currentCatalog?.state === "ready" ? currentCatalog.entries.length : 0;
  const visibleLocal = localView?.entries.filter((entry) => libraryView === "all" || !localView.selectedSourceId || entry.sourceId === localView.selectedSourceId).length ?? 0;
  const totalVisible = allCardEntries.length;
  const sourcesReady = libraryView === "builtin"
    ? currentCatalog?.state === "ready" || currentCatalog?.state === "error"
    : libraryView === "folder"
      ? localView !== null
      : localView !== null && (currentCatalog?.state === "ready" || currentCatalog?.state === "error");
  const isLoadingSources = filteredEntries.length === 0 && (
    (libraryView !== "folder" && currentCatalog === null) ||
    (libraryView !== "builtin" && localView === null && !localError)
  );
  const progressText = scanProgress
    ? `${strings.indexing}${scanProgress.relativePath ? `: ${scanProgress.relativePath}` : ""}${scanProgress.total !== null ? ` (${Math.min(scanProgress.completed + (scanProgress.phase === "analyzing" ? 1 : 0), scanProgress.total)} ${strings.progressOf} ${scanProgress.total})` : ""}${analysisMessage ? ` · ${analysisMessage}` : ""}`
    : "";
  const showDifficultyFilters = totalVisible > 0;
  const emptyMessage = recentOnly && filteredEntries.length === 0
    ? strings.noRecent
    : activeFilter === "favourites" && filteredEntries.length === 0
      ? strings.noFavorites
      : query.trim() && filteredEntries.length === 0
        ? strings.noMatches
        : totalVisible === 0
          ? libraryView === "folder" ? strings.emptyFolder : strings.emptyAll
          : dict.melodies.noMelodiesFound;

  if (!open) return null;

  return (
    <StudioDialog
      screen
      title={strings.title}
      description="Browse built-in melodies or open a read-only folder of your scores."
      onClose={handleDialogClose}
    >
      <div className={styles.dialog}>
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            <span className={styles.titleIcon} aria-hidden="true"><Music2 size={20} /></span>
            <h1>{strings.title}</h1>
          </div>
          <button className={styles.close} type="button" onClick={handleDialogClose} aria-label={`${dict.common.close} ${dict.melodies.title}`}>
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.sourceBar} role="group" aria-label={strings.source}>
          <button className={`${styles.sourceTab} ${libraryView === "builtin" ? styles.sourceTabActive : ""}`} type="button" aria-pressed={libraryView === "builtin"} onClick={() => selectLibraryView("builtin")}>
            {strings.builtIn} <span className={styles.chipCount}>({visibleBuiltins})</span>
          </button>
          <button className={`${styles.sourceTab} ${libraryView === "folder" ? styles.sourceTabActive : ""}`} type="button" aria-pressed={libraryView === "folder"} onClick={() => selectLibraryView("folder")}>
            {strings.myFolder} <span className={styles.chipCount}>({visibleLocal})</span>
          </button>
          <button className={`${styles.sourceTab} ${libraryView === "all" ? styles.sourceTabActive : ""}`} type="button" aria-pressed={libraryView === "all"} onClick={() => selectLibraryView("all")}>
            {strings.allSources} <span className={styles.chipCount}>({visibleBuiltins + visibleLocal})</span>
          </button>
          <div className={styles.sourceActions}>
            {libraryView !== "builtin" && localView?.sources.length ? (
              <div className={styles.sourceSelectBox}>
                <label className={styles.visuallyHidden} htmlFor={sourceIdInput}>{strings.source}</label>
                <select id={sourceIdInput} className={styles.sourceSelect} value={localView.selectedSourceId ?? ""} onChange={(event) => void selectSource(event.currentTarget.value)}>
                  <option value="">{strings.allFolders}</option>
                  {localView.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
                </select>
              </div>
            ) : null}
            {libraryView !== "builtin" && (
              <>
                <button className={styles.actionButton} type="button" onClick={openFolderPicker} disabled={isScanning}>
                  <FolderPlus size={16} aria-hidden="true" /> {selectedSource ? strings.changeFolder : strings.connectFolder}
                </button>
                {selectedSource && (
                  <button className={styles.actionButton} type="button" onClick={rescanSelectedSource} disabled={isScanning}>
                    <RefreshCw size={15} aria-hidden="true" /> {strings.rescan}
                  </button>
                )}
              </>
            )}
            <input ref={setFolderInputRef} className={styles.fileInput} type="file" multiple aria-label={strings.connectFolder} onChange={handleFileInput} />
          </div>
        </div>

        {libraryView !== "builtin" && selectedSource && (
          <div className={styles.sourceStatus}>
            <span className={styles.statusText}>
              {selectedSource.kind === "files" || !selectedSource.directoryHandle ? (
                <><ShieldCheck size={15} aria-hidden="true" /> {strings.cachedCopy} · {strings.fallbackHelp}</>
              ) : (
                <><ShieldCheck size={15} aria-hidden="true" /> {strings.folderHelp}</>
              )}
            </span>
            {selectedSource.kind === "directory" && selectedSource.directoryHandle && permissionState !== "granted" && (
              <button className={styles.actionButton} type="button" onClick={() => void restoreFolderAccess()} disabled={isScanning}>
                <FolderOpen size={15} aria-hidden="true" /> {strings.grantAccess}
              </button>
            )}
          </div>
        )}

        <div className={styles.controls}>
          <div className={styles.searchRow}>
            <div className={styles.searchBox}>
              <label className={styles.visuallyHidden} htmlFor={searchId}>Search melodies</label>
              <Search className={styles.searchIcon} size={17} aria-hidden="true" />
              <input id={searchId} className={styles.search} type="search" value={query} onChange={(event) => updatePreferences({ query: event.currentTarget.value })} placeholder={dict.melodies.searchPlaceholder} autoComplete="off" />
            </div>
            <div className={styles.sortBox}>
              <ArrowUpDown className={styles.sortIcon} size={15} aria-hidden="true" />
              <label className={styles.visuallyHidden} htmlFor={sortId}>{dict.melodies.difficulty}</label>
              <select id={sortId} className={styles.sortSelect} value={sortBy} onChange={(event) => updatePreferences({ sortBy: event.currentTarget.value as SortOption })} aria-label="Sort melodies">
                <option value="title">{strings.sortTitle}</option>
                <option value="difficulty-asc">{dict.melodies.difficulty}: {strings.sortEasiest}</option>
                <option value="difficulty-desc">{dict.melodies.difficulty}: {strings.sortHardest}</option>
                <option value="duration-asc">{strings.sortDurationAsc}</option>
                <option value="duration-desc">{strings.sortDurationDesc}</option>
                <option value="date-added-desc">{strings.sortAdded}</option>
                <option value="date-added-asc">{strings.sortDateAddedAsc}</option>
              </select>
            </div>
          </div>

          <div className={styles.filterBar} role="group" aria-label={dict.melodies.filterByTag}>
            <button className={`${styles.filterChip} ${activeFilter === "all" ? styles.filterChipActive : ""}`} type="button" aria-pressed={activeFilter === "all"} onClick={() => updatePreferences({ activeFilter: "all" })}>
              {dict.melodies.allTags} <span className={styles.chipCount}>({filterCounts.all})</span>
            </button>
            <button className={`${styles.filterChip} ${styles.chipFavourites} ${activeFilter === "favourites" ? styles.filterChipActive : ""}`} type="button" aria-pressed={activeFilter === "favourites"} onClick={() => updatePreferences({ activeFilter: activeFilter === "favourites" ? "all" : "favourites" })}>
              <Star className={styles.chipFavouritesIcon} size={13} fill="currentColor" aria-hidden="true" /> {dict.melodies.favourites} <span className={styles.chipCount}>({filterCounts.favourites})</span>
            </button>
            <button className={`${styles.filterChip} ${recentOnly ? styles.filterChipActive : ""}`} type="button" aria-pressed={recentOnly} onClick={() => updatePreferences({ recentOnly: !recentOnly })}>
              {strings.recent} <span className={styles.chipCount}>({filterCounts.recent})</span>
            </button>
            {showDifficultyFilters && (["Beginner", "Intermediate", "Advanced", "Virtuoso"] as const).map((tier) => (
              <button key={tier} className={`${styles.filterChip} ${styles[`chip${tier}`]} ${activeFilter === tier ? styles.filterChipActive : ""}`} type="button" aria-pressed={activeFilter === tier} onClick={() => updatePreferences({ activeFilter: activeFilter === tier ? "all" : tier })}>
                {tier} <span className={styles.chipCount}>({filterCounts.tiers[tier] ?? 0})</span>
              </button>
            ))}
          </div>

          {categoryChoices.length > 0 && libraryView !== "builtin" && (
            <div className={styles.categoryBar} role="group" aria-label={strings.category}>
              <button className={`${styles.filterChip} ${categoryId === "all" ? styles.filterChipActive : ""}`} type="button" aria-pressed={categoryId === "all"} onClick={() => updatePreferences({ categoryId: "all" })}>
                {strings.allCategories} <span className={styles.chipCount}>({allCardEntries.filter((entry) => entry.categoryId !== null).length})</span>
              </button>
              {categoryChoices.map((category) => (
                <button key={category.id} className={`${styles.filterChip} ${categoryId === category.id ? styles.filterChipActive : ""}`} type="button" aria-pressed={categoryId === category.id} onClick={() => updatePreferences({ categoryId: categoryId === category.id ? "all" : category.id })}>
                  {category.label} <span className={styles.chipCount}>({category.count})</span>
                </button>
              ))}
            </div>
          )}

          <p className={styles.count} role="status" aria-live="polite" aria-atomic="true">
            {filteredEntries.length === totalVisible ? `${totalVisible} melodies` : `${filteredEntries.length} of ${totalVisible} melodies`}
          </p>
        </div>

        {libraryView !== "builtin" && (
          <div className={`${styles.dropZone} ${isDragging ? styles.dropZoneActive : ""}`} onDragEnter={(event) => { event.preventDefault(); dragDepthRef.current += 1; setIsDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { event.preventDefault(); dragDepthRef.current -= 1; if (dragDepthRef.current <= 0) { dragDepthRef.current = 0; setIsDragging(false); } }} onDrop={handleDrop}>
            <FolderOpen size={17} aria-hidden="true" /> {strings.dropFolder}
          </div>
        )}

        <div className={styles.results}>
          {isScanning && (
            <div className={styles.progress} role="status" aria-live="polite">
              <span className={styles.spinner} aria-hidden="true" />
              <span>{progressText || strings.indexing}</span>
              <button className={styles.cancelButton} type="button" onClick={cancelScan}>{strings.cancelScan}</button>
            </div>
          )}
          {currentCatalog?.state === "error" && libraryView !== "folder" && (
            <div className={styles.error} role="alert"><p>{currentCatalog.message}</p><button className={styles.retry} type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}><RefreshCw size={15} aria-hidden="true" /> {dict.common.retry}</button></div>
          )}
          {localError && libraryView !== "builtin" && <div className={styles.error} role="alert"><p>{localError || strings.localLoadError}</p><button className={styles.retry} type="button" onClick={() => void refreshLocalView()}><RefreshCw size={15} aria-hidden="true" /> {dict.common.retry}</button></div>}
          {actionError && <div className={styles.error} role="alert"><AlertCircle size={17} aria-hidden="true" /><p>{actionError}</p>{pickerFallbackAvailable && <button className={styles.retry} type="button" onClick={() => { fileIntentRef.current = "add"; folderInputRef.current?.click(); }}>{strings.unsupportedFolderPicker}</button>}</div>}
          {scanSummary && (
            <p className={styles.scanSummary} role="status" aria-live="polite">
              {scanSummary.analyzedCount} indexed · {scanSummary.reusedCount} reused · {scanSummary.errorCount} errors
            </p>
          )}
          {scanErrors.length > 0 && (
            <details className={styles.scanErrors}>
              <summary>{strings.scanErrors} ({scanErrors.length})</summary>
              <ul>{scanErrors.map((error, index) => <li key={`${error.relativePath}:${index}`}><strong>{error.relativePath}</strong><span>{error.message}</span></li>)}</ul>
            </details>
          )}
          {isLoadingSources && (
            <p className={styles.message} role="status" aria-live="polite">{dict.common.loading}</p>
          )}
          {filteredEntries.length === 0 && sourcesReady && (
            <p className={styles.message} role="status">{emptyMessage}</p>
          )}
          {filteredEntries.length > 0 && (
            <ul className={styles.list} aria-label={dict.melodies.title}>
              {filteredEntries.map((entry) => {
                const isFavourite = favouriteIds.has(entry.id);
                const isPreviewing = activePreviewKey === entry.key;
                const isOpening = openingKey === entry.key || busy;
                const duration = formatDuration(entry.durationSeconds);
                return (
                  <li className={styles.row} key={entry.key}>
                    <div className={styles.itemCard}>
                      <button className={styles.choice} type="button" aria-label={dict.melodies.openMelody === "Open melody" ? `Open ${entry.title}` : `${dict.melodies.openMelody} ${entry.title}`} title={dict.melodies.openMelody} disabled={isOpening || isScanning} onClick={() => entry.builtin ? void handleChooseBuiltin(entry.builtin) : entry.local ? void handleChooseLocal(entry.local) : undefined}>
                        <span className={styles.choiceIcon} aria-hidden="true"><Music2 size={18} /></span>
                        <span className={styles.copy}>
                          <span className={styles.name}>{entry.title}</span>
                          <span className={styles.metaRow}>
                            <span className={styles.meta}>{entry.location}</span>
                            <span className={styles.metadata}>
                              {duration ? <span>{duration}</span> : <span>{strings.unknownDuration}</span>}
                              {entry.noteCount !== undefined && <span>{entry.noteCount} {strings.notes}</span>}
                              <span className={`${styles.badge} ${tierBadgeClass(entry.difficultyTier)}`}>{entry.difficultyTier} · {dict.melodies.difficulty} {entry.difficultyScore.toFixed(1)}/10</span>
                            </span>
                          </span>
                        </span>
                      </button>
                      <button className={`${styles.previewButton} ${isPreviewing ? styles.previewButtonActive : ""}`} type="button" aria-label={`${isPreviewing ? strings.stopPreview : strings.preview}: ${entry.title}`} title={isPreviewing ? strings.stopPreview : strings.preview} aria-pressed={isPreviewing} onClick={() => void togglePreview(entry)} disabled={busy || isScanning}>
                        {isPreviewing ? <Square size={15} fill="currentColor" aria-hidden="true" /> : <Play size={16} fill="currentColor" aria-hidden="true" />}
                      </button>
                      <button className={`${styles.favouriteButton} ${isFavourite ? styles.favouriteButtonActive : ""}`} type="button" aria-label={isFavourite ? `${dict.melodies.removeFromFavourites}: ${entry.title}` : `${dict.melodies.addToFavourites}: ${entry.title}`} title={isFavourite ? dict.melodies.removeFromFavourites : dict.melodies.addToFavourites} aria-pressed={isFavourite} onClick={() => toggleFavouriteMelody(entry.id)}>
                        <Star size={18} fill={isFavourite ? "currentColor" : "none"} strokeWidth={isFavourite ? 1.5 : 2} aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {busy && <p className={styles.opening} role="status" aria-live="polite">{dict.melodies.openMelody}…</p>}
        </div>
      </div>
    </StudioDialog>
  );
}
