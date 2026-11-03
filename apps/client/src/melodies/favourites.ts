export const FAVOURITES_STORAGE_KEY = "handthesia:favourite_melody_ids";

let memoryStorage = new Set<string>();
let customStorage: Storage | null = null;
let memoryFallbackActive = false;
const listeners = new Set<(ids: ReadonlySet<string>) => void>();

export function setFavouritesStorage(storage: Storage | null): void {
  customStorage = storage;
  memoryFallbackActive = false;
  memoryStorage = new Set();
}

function getStorage(): Storage | null {
  if (customStorage !== null) {
    return customStorage;
  }
  try {
    if (typeof window !== "undefined") return window.localStorage;
  } catch {
    // Browser storage can be blocked by the current privacy context.
  }
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Accessing the global storage getter can also throw.
  }
  return null;
}

/** Stable namespace for a melody whose identity is only unique within a source. */
export function makeSourceMelodyId(sourceId: string, entryId: string): string {
  return `source:${encodeURIComponent(sourceId)}:${encodeURIComponent(entryId)}`;
}

function notify(): void {
  const current = new Set(memoryStorage);
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      // Ignore listener error
    }
  }
}

export function getFavouriteMelodyIds(): Set<string> {
  const storage = getStorage();
  if (!storage || memoryFallbackActive) {
    return new Set(memoryStorage);
  }
  try {
    const raw = storage.getItem(FAVOURITES_STORAGE_KEY);
    if (!raw) {
      memoryStorage = new Set();
      return new Set();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      memoryStorage = new Set();
      return new Set();
    }
    if (!Array.isArray(parsed)) {
      memoryStorage = new Set();
      return new Set();
    }
    const ids = new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
    memoryStorage = ids;
    return new Set(ids);
  } catch {
    return new Set(memoryStorage);
  }
}

export function isFavouriteMelody(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  return getFavouriteMelodyIds().has(id.trim());
}

export function saveFavouriteMelodyIds(ids: Iterable<string>): void {
  const set = new Set(
    Array.from(ids).filter((id): id is string => typeof id === "string" && id.trim().length > 0),
  );
  memoryStorage = new Set(set);
  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify([...set]));
      memoryFallbackActive = false;
    } catch {
      memoryFallbackActive = true;
    }
  } else {
    memoryFallbackActive = true;
  }
  notify();
}

export function toggleFavouriteMelody(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  const trimmed = id.trim();
  const current = getFavouriteMelodyIds();
  const nextState = !current.has(trimmed);
  if (nextState) {
    current.add(trimmed);
  } else {
    current.delete(trimmed);
  }
  saveFavouriteMelodyIds(current);
  return nextState;
}

export function subscribeFavourites(listener: (ids: ReadonlySet<string>) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
