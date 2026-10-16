import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAVOURITES_STORAGE_KEY,
  getFavouriteMelodyIds,
  isFavouriteMelody,
  saveFavouriteMelodyIds,
  setFavouritesStorage,
  subscribeFavourites,
  toggleFavouriteMelody,
} from "./favourites.ts";

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe("favourites storage", () => {
  let mockStorage: MockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    setFavouritesStorage(mockStorage);
  });

  it("starts empty", () => {
    expect(getFavouriteMelodyIds().size).toBe(0);
    expect(isFavouriteMelody("m1")).toBe(false);
  });

  it("toggles favourite status and persists to storage", () => {
    const added = toggleFavouriteMelody("m1");
    expect(added).toBe(true);
    expect(isFavouriteMelody("m1")).toBe(true);
    expect(getFavouriteMelodyIds().has("m1")).toBe(true);
    expect(JSON.parse(mockStorage.getItem(FAVOURITES_STORAGE_KEY)!)).toEqual(["m1"]);

    const removed = toggleFavouriteMelody("m1");
    expect(removed).toBe(false);
    expect(isFavouriteMelody("m1")).toBe(false);
    expect(getFavouriteMelodyIds().size).toBe(0);
  });

  it("notifies subscribers when favourites change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFavourites(listener);

    toggleFavouriteMelody("m2");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].has("m2")).toBe(true);

    toggleFavouriteMelody("m3");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    toggleFavouriteMelody("m2");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("handles corrupted storage gracefully", () => {
    mockStorage.setItem(FAVOURITES_STORAGE_KEY, "invalid json {");
    expect(getFavouriteMelodyIds().size).toBe(0);
    expect(isFavouriteMelody("m1")).toBe(false);
  });

  it("saves multiple melody IDs cleanly", () => {
    saveFavouriteMelodyIds(["a", "b", "c", ""]);
    expect(getFavouriteMelodyIds()).toEqual(new Set(["a", "b", "c"]));
  });
});
