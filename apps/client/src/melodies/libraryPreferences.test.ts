import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_MELODIES_PREFERENCES_STORAGE_KEY,
  loadBuiltinMelodiesPreferences,
  saveBuiltinMelodiesPreferences,
  type BuiltinMelodiesPreferences,
} from "./libraryPreferences.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const DEFAULTS: BuiltinMelodiesPreferences = {
  query: "",
  activeFilter: "all",
  sortBy: "title",
};

describe("built-in melody library preferences", () => {
  it("round-trips the query, filter, and sort using a separate versioned key", () => {
    const storage = new MemoryStorage();
    const preferences: BuiltinMelodiesPreferences = {
      query: "moonlight",
      activeFilter: "Beginner",
      sortBy: "difficulty-desc",
    };

    saveBuiltinMelodiesPreferences(preferences, storage);

    expect(storage.getItem(BUILTIN_MELODIES_PREFERENCES_STORAGE_KEY)).toBe(JSON.stringify(preferences));
    expect(loadBuiltinMelodiesPreferences(storage)).toEqual(preferences);
  });

  it("loads defaults without writing them on initial read", () => {
    const storage = new MemoryStorage();
    const setItem = vi.spyOn(storage, "setItem");

    expect(loadBuiltinMelodiesPreferences(storage)).toEqual(DEFAULTS);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("falls back safely for corrupt JSON and invalid root values", () => {
    const storage = new MemoryStorage();
    for (const raw of ["{broken", "null", "[]", "17", '"preferences"']) {
      storage.setItem(BUILTIN_MELODIES_PREFERENCES_STORAGE_KEY, raw);
      expect(loadBuiltinMelodiesPreferences(storage)).toEqual(DEFAULTS);
    }
  });

  it("validates each stored field independently", () => {
    const storage = new MemoryStorage();
    storage.setItem(BUILTIN_MELODIES_PREFERENCES_STORAGE_KEY, JSON.stringify({
      query: 42,
      activeFilter: "Beginner",
      sortBy: "unsupported",
    }));

    expect(loadBuiltinMelodiesPreferences(storage)).toEqual({
      query: "",
      activeFilter: "Beginner",
      sortBy: "title",
    });

    storage.setItem(BUILTIN_MELODIES_PREFERENCES_STORAGE_KEY, JSON.stringify({
      query: "",
      activeFilter: "unknown-tier",
      sortBy: "difficulty-asc",
    }));

    expect(loadBuiltinMelodiesPreferences(storage)).toEqual({
      query: "",
      activeFilter: "all",
      sortBy: "difficulty-asc",
    });
  });

  it("accepts every supported filter and sort enum, including saved defaults", () => {
    const storage = new MemoryStorage();
    const filters = ["all", "favourites", "Beginner", "Intermediate", "Advanced"] as const;
    const sorts = ["title", "difficulty-asc", "difficulty-desc"] as const;

    for (const activeFilter of filters) {
      for (const sortBy of sorts) {
        const preferences = { query: "", activeFilter, sortBy };
        saveBuiltinMelodiesPreferences(preferences, storage);
        expect(loadBuiltinMelodiesPreferences(storage)).toEqual(preferences);
      }
    }
  });

  it("handles denied storage reads and writes without throwing", () => {
    const deniedReads = { getItem: () => { throw new Error("Access denied"); } } as unknown as Storage;
    const deniedWrites = { setItem: () => { throw new Error("Quota exceeded"); } } as unknown as Storage;

    expect(loadBuiltinMelodiesPreferences(deniedReads)).toEqual(DEFAULTS);
    expect(() => saveBuiltinMelodiesPreferences({
      query: "",
      activeFilter: "all",
      sortBy: "title",
    }, deniedWrites)).not.toThrow();
  });

  it("leaves the independent favourites storage key untouched", () => {
    const storage = new MemoryStorage();
    const favouritesKey = "handthesia:favourite_melody_ids";
    storage.setItem(favouritesKey, '["melody-1"]');

    saveBuiltinMelodiesPreferences({ query: "", activeFilter: "favourites", sortBy: "title" }, storage);

    expect(BUILTIN_MELODIES_PREFERENCES_STORAGE_KEY).not.toBe(favouritesKey);
    expect(storage.getItem(favouritesKey)).toBe('["melody-1"]');
    expect(storage.getItem(BUILTIN_MELODIES_PREFERENCES_STORAGE_KEY)).not.toBeNull();
  });
});
