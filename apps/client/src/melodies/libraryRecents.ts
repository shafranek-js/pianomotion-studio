import { makeSourceMelodyId } from "./favourites";

export const LIBRARY_RECENTS_STORAGE_KEY = "handthesia:melody_library_recents:v1";
export const LIBRARY_RECENTS_LIMIT = 40;

export interface RecentMelody {
  id: string;
  openedAt: number;
  sourceId?: string;
  entryId?: string;
}

let memoryRecents: RecentMelody[] = [];
let customStorage: Storage | null = null;
let memoryFallbackActive = false;
const listeners = new Set<(recents: readonly RecentMelody[]) => void>();

export function setLibraryRecentsStorage(storage: Storage | null): void {
  customStorage = storage;
  memoryFallbackActive = false;
  memoryRecents = [];
}

function getStorage(): Storage | null {
  if (customStorage !== null) return customStorage;
  try {
    if (typeof window !== "undefined") return window.localStorage;
  } catch {
    // Storage may be unavailable in private or restricted browser contexts.
  }
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // The global storage getter can throw as well.
  }
  return null;
}

function isRecentMelody(value: unknown): value is RecentMelody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const hasSourceIdentity = typeof record.sourceId === "string" && record.sourceId.trim().length > 0 &&
    typeof record.entryId === "string" && record.entryId.trim().length > 0;
  const hasGenericIdentity = record.sourceId === undefined && record.entryId === undefined;
  return typeof record.id === "string" && record.id.trim().length > 0 &&
    typeof record.openedAt === "number" && Number.isFinite(record.openedAt) && record.openedAt >= 0 &&
    ((hasSourceIdentity && record.id === makeSourceMelodyId(record.sourceId as string, record.entryId as string)) || hasGenericIdentity);
}

function decodeRecents(raw: string | null): RecentMelody[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const deduplicated = new Map<string, RecentMelody>();
  for (const candidate of parsed) {
    if (!isRecentMelody(candidate)) continue;
    const prior = deduplicated.get(candidate.id);
    if (!prior || candidate.openedAt > prior.openedAt) deduplicated.set(candidate.id, candidate);
  }
  return [...deduplicated.values()]
    .sort((left, right) => right.openedAt - left.openedAt || left.id.localeCompare(right.id))
    .slice(0, LIBRARY_RECENTS_LIMIT);
}

function notify(): void {
  const current = getLibraryRecents();
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      // One UI listener must not prevent other subscribers from updating.
    }
  }
}

/** Return most recently opened entries first. Invalid records are ignored. */
export function getLibraryRecents(): RecentMelody[] {
  const storage = getStorage();
  if (!storage || memoryFallbackActive) return memoryRecents.map((entry) => ({ ...entry }));
  let raw: string | null;
  try {
    raw = storage.getItem(LIBRARY_RECENTS_STORAGE_KEY);
  } catch {
    return memoryRecents.map((entry) => ({ ...entry }));
  }
  try {
    const recents = decodeRecents(raw);
    memoryRecents = recents;
    return recents.map((entry) => ({ ...entry }));
  } catch {
    memoryRecents = [];
    return [];
  }
}

/** Store a successful open, moving an existing source/entry pair to the front. */
export function markMelodyRecent(sourceId: string, entryId: string, openedAt = Date.now()): RecentMelody | null {
  const normalizedSourceId = sourceId.trim();
  const normalizedEntryId = entryId.trim();
  if (!normalizedSourceId || !normalizedEntryId || !Number.isFinite(openedAt) || openedAt < 0) return null;

  const recent: RecentMelody = {
    id: makeSourceMelodyId(normalizedSourceId, normalizedEntryId),
    sourceId: normalizedSourceId,
    entryId: normalizedEntryId,
    openedAt,
  };
  return saveRecent(recent);
}

/** Record an opened catalog item by its already-stable global or source-scoped ID. */
export function recordRecentMelody(id: string, openedAt = Date.now()): RecentMelody | null {
  const normalizedId = id.trim();
  if (!normalizedId || !Number.isFinite(openedAt) || openedAt < 0) return null;
  return saveRecent({ id: normalizedId, openedAt });
}

function saveRecent(recent: RecentMelody): RecentMelody {
  const next = [recent, ...getLibraryRecents().filter((item) => item.id !== recent.id)]
    .slice(0, LIBRARY_RECENTS_LIMIT);
  memoryRecents = next;

  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(LIBRARY_RECENTS_STORAGE_KEY, JSON.stringify(next));
      memoryFallbackActive = false;
    } catch {
      memoryFallbackActive = true;
    }
  } else {
    memoryFallbackActive = true;
  }
  notify();
  return { ...recent };
}

export function getRecentMelodyIds(): Set<string> {
  return new Set(getLibraryRecents().map((recent) => recent.id));
}

export function subscribeLibraryRecents(listener: (recents: readonly RecentMelody[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

