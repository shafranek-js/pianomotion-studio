export const BUILTIN_MELODIES_PREFERENCES_STORAGE_KEY = "handthesia:builtin_melodies_preferences:v1";

export type MelodyFilter = "all" | "favourites" | "Beginner" | "Intermediate" | "Advanced" | "Virtuoso";
export type SortOption =
  | "title"
  | "difficulty-asc"
  | "difficulty-desc"
  | "duration-asc"
  | "duration-desc"
  | "date-added-asc"
  | "date-added-desc";
export type LibraryView = "builtin" | "folder" | "all";

export interface BuiltinMelodiesPreferences {
  query: string;
  activeFilter: MelodyFilter;
  sortBy: SortOption;
  libraryView: LibraryView;
  categoryId: string;
  recentOnly: boolean;
}

const MELODY_FILTERS: readonly MelodyFilter[] = ["all", "favourites", "Beginner", "Intermediate", "Advanced", "Virtuoso"];
const SORT_OPTIONS: readonly SortOption[] = [
  "title", "difficulty-asc", "difficulty-desc", "duration-asc", "duration-desc", "date-added-asc", "date-added-desc",
];
const LIBRARY_VIEWS: readonly LibraryView[] = ["builtin", "folder", "all"];

function defaults(): BuiltinMelodiesPreferences {
  return { query: "", activeFilter: "all", sortBy: "title", libraryView: "builtin", categoryId: "all", recentOnly: false };
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined") return window.localStorage;
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }

  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Accessing the global localStorage getter can also throw.
  }

  return null;
}

function isMelodyFilter(value: unknown): value is MelodyFilter {
  return typeof value === "string" && (MELODY_FILTERS as readonly string[]).includes(value);
}

function isSortOption(value: unknown): value is SortOption {
  return typeof value === "string" && (SORT_OPTIONS as readonly string[]).includes(value);
}

function isLibraryView(value: unknown): value is LibraryView {
  return typeof value === "string" && (LIBRARY_VIEWS as readonly string[]).includes(value);
}

function decodePreferences(value: unknown): BuiltinMelodiesPreferences {
  const fallback = defaults();
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fallback;

  const record = value as Record<string, unknown>;
  return {
    query: typeof record.query === "string" ? record.query : fallback.query,
    activeFilter: isMelodyFilter(record.activeFilter) ? record.activeFilter : fallback.activeFilter,
    sortBy: isSortOption(record.sortBy) ? record.sortBy : fallback.sortBy,
    libraryView: isLibraryView(record.libraryView) ? record.libraryView : fallback.libraryView,
    categoryId: typeof record.categoryId === "string" ? record.categoryId : fallback.categoryId,
    recentOnly: typeof record.recentOnly === "boolean" ? record.recentOnly : fallback.recentOnly,
  };
}

/** Read preferences synchronously so a remounted library opens in its saved state. */
export function loadBuiltinMelodiesPreferences(storage: Storage | null = getStorage()): BuiltinMelodiesPreferences {
  if (!storage) return defaults();

  try {
    const raw = storage.getItem(BUILTIN_MELODIES_PREFERENCES_STORAGE_KEY);
    if (raw === null) return defaults();
    return decodePreferences(JSON.parse(raw) as unknown);
  } catch {
    return defaults();
  }
}

/** Persist each user change immediately; storage failures never interrupt the library. */
export function saveBuiltinMelodiesPreferences(
  preferences: BuiltinMelodiesPreferences,
  storage: Storage | null = getStorage(),
): void {
  if (!storage) return;

  try {
    storage.setItem(
      BUILTIN_MELODIES_PREFERENCES_STORAGE_KEY,
      JSON.stringify(decodePreferences(preferences)),
    );
  } catch {
    // Preferences are best-effort so quota or access errors do not break browsing.
  }
}
