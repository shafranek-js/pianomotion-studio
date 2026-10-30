import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE } from "./defaultProfiles";
import {
  getActiveProfile,
  listProfiles,
  resetProfileStore,
  saveProfile,
  setActiveProfile,
  setProfileStorage,
} from "./profileStore";
import { ProfileModal } from "./ProfileModal";
import { createTesting2DefaultBaselineProfile } from "./testing2BaselineProfile";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

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

describe("Testing2 default baseline profile creation", () => {
  beforeEach(() => {
    setProfileStorage(new MemoryStorage());
    resetProfileStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setProfileStorage(null);
  });

  it("creates an editable Default copy without mutation, overwrite, or activation", async () => {
    const originalDefault = structuredClone(DEFAULT_PROFILE);
    const existing = await saveProfile({
      ...structuredClone(DEFAULT_PROFILE),
      profileId: "existing-id",
      name: "Keep existing profile",
    });
    const existingSnapshot = structuredClone(existing);
    await setActiveProfile("small-hands");

    const randomUUID = vi.fn()
      .mockReturnValueOnce("existing-id")
      .mockReturnValueOnce("created-id");
    vi.stubGlobal("crypto", { randomUUID });

    const created = await createTesting2DefaultBaselineProfile();

    expect(randomUUID).toHaveBeenCalledTimes(2);
    expect(created.profileId).toBe("created-id");
    expect(created.name).toBe("Testing2 — Default baseline");
    expect(created.revision).toBe(0);
    expect(created.createdAtUnixSeconds).toBeGreaterThan(0);
    expect(created.modifiedAtUnixSeconds).toBeGreaterThanOrEqual(created.createdAtUnixSeconds);
    expect(created.anatomy).toEqual(originalDefault.anatomy);
    expect(created.behavior).toEqual(originalDefault.behavior);
    expect(created.skin).toEqual(originalDefault.skin);
    expect(created.weights).toEqual(originalDefault.weights);
    expect(created.colorRgb).toEqual(originalDefault.colorRgb);
    expect(created.behavior).not.toBe(DEFAULT_PROFILE.behavior);
    expect(created.skin).not.toBe(DEFAULT_PROFILE.skin);
    expect((created.skin as { colors: unknown }).colors).not.toBe((DEFAULT_PROFILE.skin as { colors: unknown }).colors);

    expect({
      ...created,
      profileId: originalDefault.profileId,
      revision: originalDefault.revision,
      name: originalDefault.name,
      createdAtUnixSeconds: originalDefault.createdAtUnixSeconds,
      modifiedAtUnixSeconds: originalDefault.modifiedAtUnixSeconds,
    }).toEqual(originalDefault);
    expect(DEFAULT_PROFILE).toEqual(originalDefault);
    expect(listProfiles().find((profile) => profile.profileId === "existing-id")).toEqual(existingSnapshot);
    expect(listProfiles().find((profile) => profile.profileId === "created-id")).toEqual(created);
    expect(getActiveProfile().profileId).toBe("small-hands");

    const markup = renderToStaticMarkup(<ProfileModal isOpen onClose={() => {}} />);
    expect(markup).toContain('value="created-id"');
    expect(markup).toContain("Testing2 — Default baseline");
    expect(markup).toContain('data-testid="create-testing2-default-baseline"');
    expect(markup).toContain("Create Testing2 profile");
    expect(markup).toContain("Default profile for baseline edits; GLB anatomy remains uncalibrated");
    expect(markup).toContain('data-testid="inspect-testing2-measurements"');
    expect(markup).not.toContain('data-testid="testing2-measurements-table"');
  });
});
