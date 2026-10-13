import { getProject, type SavedProject } from "./projectDb.ts";

export const RECENT_MAX = 5;
export const RECENT_STORAGE_KEY = "handthesia:recent_project_ids";

let memoryStorage: string[] = [];
let customStorage: Storage | null = null;

/**
 * Allows injecting custom storage (e.g. for testing or mocking).
 */
export function setRecentStorage(storage: Storage | null): void {
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

/**
 * Returns the list of up to 5 recently opened project IDs, ordered newest-first.
 */
export function getRecentProjectIds(): string[] {
  const storage = getStorage();
  if (!storage) {
    return [...memoryStorage];
  }

  try {
    const raw = storage.getItem(RECENT_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/**
 * Alias for `getRecentProjectIds()`.
 */
export const getRecentProjects = getRecentProjectIds;

/**
 * Persists the project ID list to storage (trimmed to RECENT_MAX).
 */
export function saveRecentProjectIds(ids: string[]): void {
  const sanitized = ids
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .slice(0, RECENT_MAX);

  memoryStorage = [...sanitized];

  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(RECENT_STORAGE_KEY, JSON.stringify(sanitized));
    } catch (err) {
      console.warn("Failed to persist recent project IDs to storage:", err);
    }
  }
}

/**
 * Adds a project ID to the recent list:
 * - If already present, moves it to the top.
 * - Deduplicates.
 * - Trims to at most `RECENT_MAX` (5).
 *
 * Returns the updated list.
 */
export function addRecentProjectId(projectId: string): string[] {
  if (!projectId || typeof projectId !== "string" || projectId.trim().length === 0) {
    return getRecentProjectIds();
  }

  const trimmedId = projectId.trim();
  const current = getRecentProjectIds();
  const next = [trimmedId, ...current.filter((id) => id !== trimmedId)].slice(0, RECENT_MAX);

  saveRecentProjectIds(next);
  return next;
}

/**
 * Alias for `addRecentProjectId(projectId)`.
 */
export const addRecentProject = addRecentProjectId;

/**
 * Removes a project ID from the recent list.
 * Returns the updated list.
 */
export function removeRecentProjectId(projectId: string): string[] {
  const current = getRecentProjectIds();
  const next = current.filter((id) => id !== projectId);

  saveRecentProjectIds(next);
  return next;
}

/**
 * Alias for `removeRecentProjectId(projectId)`.
 */
export const removeRecentProject = removeRecentProjectId;

/**
 * Clears all recent project IDs.
 */
export function clearRecentProjects(): void {
  memoryStorage = [];
  const storage = getStorage();
  if (storage) {
    try {
      storage.removeItem(RECENT_STORAGE_KEY);
    } catch {
      // Ignore removal error
    }
  }
}

/**
 * Fetches the full `SavedProject` records for the recent IDs from IndexedDB.
 * Prunes any IDs that no longer exist in the database.
 */
export async function getRecentSavedProjects(): Promise<SavedProject[]> {
  const ids = getRecentProjectIds();
  const projects: SavedProject[] = [];
  const validIds: string[] = [];

  for (const id of ids) {
    try {
      const p = await getProject(id);
      if (p) {
        projects.push(p);
        validIds.push(id);
      }
    } catch {
      // If fetching fails, skip
    }
  }

  // If any IDs were missing from DB, update the stored list
  if (validIds.length !== ids.length) {
    saveRecentProjectIds(validIds);
  }

  return projects;
}
