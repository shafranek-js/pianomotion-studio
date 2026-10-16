export const FAVOURITES_STORAGE_KEY = "handthesia:favourite_melody_ids";

let memoryStorage = new Set<string>();
let customStorage: Storage | null = null;
const listeners = new Set<(ids: ReadonlySet<string>) => void>();

export function setFavouritesStorage(storage: Storage | null): void {
  customStorage = storage;
}

function getStorage(): Storage | null {
  if (customStorage !== null) {
    return customStorage;
  }
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  if (typeof localStorage !== "undefined") {
    return localStorage;
  }
  return null;
}

function notify(): void {
  const current = getFavouriteMelodyIds();
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
  if (!storage) {
    return new Set(memoryStorage);
  }
  try {
    const raw = storage.getItem(FAVOURITES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
  } catch {
    return new Set();
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
    } catch (err) {
      console.warn("Failed to persist favourite melody IDs:", err);
    }
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
