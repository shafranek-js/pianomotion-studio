import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLibraryRecents,
  getRecentMelodyIds,
  LIBRARY_RECENTS_LIMIT,
  LIBRARY_RECENTS_STORAGE_KEY,
  markMelodyRecent,
  recordRecentMelody,
  setLibraryRecentsStorage,
  subscribeLibraryRecents,
} from "./libraryRecents.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("local melody library recents", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    setLibraryRecentsStorage(storage);
  });

  it("records successful opens with stable source-scoped IDs and newest first", () => {
    markMelodyRecent("folder-a", "same-entry", 10);
    markMelodyRecent("folder-b", "same-entry", 20);
    markMelodyRecent("folder-a", "same-entry", 30);

    const recents = getLibraryRecents();
    expect(recents.map(({ sourceId, entryId, openedAt }) => [sourceId, entryId, openedAt])).toEqual([
      ["folder-a", "same-entry", 30],
      ["folder-b", "same-entry", 20],
    ]);
    expect(recents[0]?.id).not.toBe(recents[1]?.id);
    expect(getRecentMelodyIds()).toEqual(new Set(recents.map((recent) => recent.id)));
    expect(JSON.parse(storage.getItem(LIBRARY_RECENTS_STORAGE_KEY)!)).toEqual(recents);
  });

  it("accepts a caller-provided stable catalog ID for success recorded after project commit", () => {
    expect(recordRecentMelody("builtin:moonlight", 12)).toEqual({ id: "builtin:moonlight", openedAt: 12 });
    expect(getRecentMelodyIds()).toEqual(new Set(["builtin:moonlight"]));
    expect(recordRecentMelody(" ", 13)).toBeNull();
  });

  it("notifies subscribers once per accepted record and ignores invalid identities", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLibraryRecents(listener);

    expect(markMelodyRecent(" ", "entry", 1)).toBeNull();
    expect(markMelodyRecent("folder", "entry", Number.NaN)).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(markMelodyRecent("folder", "entry", 1)).not.toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    markMelodyRecent("folder", "other", 2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops duplicate, malformed, and excess stored records", () => {
    const entries = Array.from({ length: LIBRARY_RECENTS_LIMIT + 3 }, (_, index) => {
      const sourceId = `folder-${index}`;
      const entryId = `entry-${index}`;
      return { id: `source:${encodeURIComponent(sourceId)}:${encodeURIComponent(entryId)}`, sourceId, entryId, openedAt: index };
    });
    storage.setItem(LIBRARY_RECENTS_STORAGE_KEY, JSON.stringify([
      ...entries,
      { ...entries[0], openedAt: LIBRARY_RECENTS_LIMIT + 10 },
      { ...entries[1], id: "wrong-id" },
      null,
    ]));

    const loaded = getLibraryRecents();
    expect(loaded).toHaveLength(LIBRARY_RECENTS_LIMIT);
    expect(loaded[0]?.openedAt).toBe(LIBRARY_RECENTS_LIMIT + 10);
    expect(loaded.some((recent) => recent.id === "wrong-id")).toBe(false);
  });

  it("recovers from corrupt or inaccessible storage and keeps writes usable after quota errors", () => {
    storage.setItem(LIBRARY_RECENTS_STORAGE_KEY, "not-json");
    expect(getLibraryRecents()).toEqual([]);
    storage.setItem(LIBRARY_RECENTS_STORAGE_KEY, "[]");

    const denied = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } } as unknown as Storage;
    setLibraryRecentsStorage(denied);
    expect(markMelodyRecent("folder", "entry", 7)?.openedAt).toBe(7);
    expect(getLibraryRecents()).toEqual([
      { id: "source:folder:entry", sourceId: "folder", entryId: "entry", openedAt: 7 },
    ]);
  });
});

