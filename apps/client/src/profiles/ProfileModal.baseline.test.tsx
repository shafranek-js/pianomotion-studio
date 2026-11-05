import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE, RIGGED_HAND_MEASURED_BASELINE_PROFILE } from "./defaultProfiles";
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
import { RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID } from "./riggedHandProfileCalibration";
import { ACTIVE_PROFILE_STORAGE_KEY, PROFILES_STORAGE_KEY } from "./profileStore";

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

describe("Legacy Testing2 profile preservation", () => {
  beforeEach(() => {
    setProfileStorage(new MemoryStorage());
    resetProfileStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setProfileStorage(null);
  });

  it("retains existing editable Default copies without exposing legacy creation or inspection controls", async () => {
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
    expect(markup).not.toContain('data-testid="create-testing2-default-baseline"');
    expect(markup).not.toContain("Create Testing2 profile");
    expect(markup).not.toContain('data-testid="open-testing2-rig-editor"');
    expect(markup).not.toContain("Testing2 rig editor");
    expect(markup).not.toContain('data-testid="testing2-measurement-inspection"');
    expect(markup).not.toContain('data-testid="inspect-testing2-measurements"');
    expect(markup).not.toContain('data-testid="testing2-measurements-table"');

    await setActiveProfile(created.profileId);
    const legacyMarkup = renderToStaticMarkup(<ProfileModal isOpen onClose={() => {}} />);
    expect(legacyMarkup).toContain('value="created-id" selected=""');
    expect(legacyMarkup).toContain("Testing2 — Default baseline");
    expect(legacyMarkup).toContain('title="Create and apply an editable copy of the selected profile, including your current edits."');
    expect(legacyMarkup).not.toContain('disabled="" title="Duplicate this preset before editing and saving it"');
    expect(legacyMarkup).not.toContain("Built-in presets are read-only.");
    expect(listProfiles().find((profile) => profile.profileId === created.profileId)).toEqual(created);
  });
});

describe("Rigged hands built-in baseline profile", () => {
  beforeEach(() => {
    setProfileStorage(new MemoryStorage());
    resetProfileStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setProfileStorage(null);
  });

  it("is available with a distinct built-in label while same-name saved copies remain unchanged", async () => {
    await setActiveProfile("small-hands");
    const oldCopy = await saveProfile({
      ...structuredClone(RIGGED_HAND_MEASURED_BASELINE_PROFILE),
      profileId: "old-rigged-copy-uuid",
      revision: 6,
      createdAtUnixSeconds: 100,
      modifiedAtUnixSeconds: 200,
    });
    const oldCopySnapshot = structuredClone(oldCopy);

    const markup = renderToStaticMarkup(
      <ProfileModal
        isOpen
        onClose={() => {}}
        initialProfile={RIGGED_HAND_MEASURED_BASELINE_PROFILE}
      />,
    );

    expect(markup).toContain(`value="${RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID}"`);
    expect(markup).toContain("Rigged hands — measured baseline (Built-in)");
    expect(markup).toContain("Rigged hands — measured baseline (Copy)");
    expect(markup).not.toContain("Create editable Rigged hands copy");
    expect(markup).not.toContain('data-testid="create-rigged-hand-profile"');
    expect(markup).toContain("Built-in presets are read-only. Use Duplicate to create an editable copy.");
    expect(markup).toContain('data-testid="rigged-hand-profile-calibration-note"');
    expect(markup).toContain("This preset uses measured lengths for four fingers. Thumb, palm, wrist, and motion settings use Default values.");
    expect(markup).toContain('data-testid="apply-measured-baseline"');
    expect(markup).toContain('aria-label="Apply built-in Rigged hands measured baseline and close"');
    expect(markup).toContain("disabled=\"\" title=\"Duplicate this preset before editing and saving it\"");
    expect(markup).not.toContain("Delete profile");
    expect(getActiveProfile().profileId).toBe("small-hands");
    expect(listProfiles().find((profile) => profile.profileId === oldCopy.profileId)).toEqual(oldCopySnapshot);
    expect(listProfiles().find((profile) => profile.profileId === RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID))
      .toEqual(RIGGED_HAND_MEASURED_BASELINE_PROFILE);
  });

  it("labels a colliding saved row as a conflict and presents a non-destructive diagnostic", () => {
    const storage = new MemoryStorage();
    const collision = {
      ...structuredClone(RIGGED_HAND_MEASURED_BASELINE_PROFILE),
      name: RIGGED_HAND_MEASURED_BASELINE_PROFILE.name,
      revision: 5,
      createdAtUnixSeconds: 100,
      modifiedAtUnixSeconds: 200,
      anatomy: {
        ...RIGGED_HAND_MEASURED_BASELINE_PROFILE.anatomy,
        pp2: RIGGED_HAND_MEASURED_BASELINE_PROFILE.anatomy.pp2 + 0.25,
      },
    };
    storage.setItem(PROFILES_STORAGE_KEY, JSON.stringify([collision]));
    storage.setItem(ACTIVE_PROFILE_STORAGE_KEY, RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID);
    setProfileStorage(storage);

    const markup = renderToStaticMarkup(<ProfileModal isOpen onClose={() => {}} />);

    expect(markup).toContain("Rigged hands — measured baseline (Saved ID conflict)");
    expect(markup).not.toContain("Rigged hands — measured baseline (Built-in)");
    expect(markup).toContain('data-testid="profile-store-diagnostic"');
    expect(markup).toContain("Its data and ID are preserved in read-only mode");
    expect(markup).not.toContain('data-testid="create-rigged-hand-profile"');
    expect(markup).not.toContain('data-testid="rigged-hand-profile-calibration-note"');
    expect(markup).toContain("Built-in presets are read-only. Use Duplicate to create an editable copy.");
    expect(markup).not.toContain('data-testid="apply-measured-baseline"');
    expect(markup).toContain('disabled="" title="Duplicate this preset before editing and saving it"');
    expect(markup).not.toContain("Delete profile");
    expect(listProfiles().find((profile) => profile.profileId === RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID))
      .toEqual(collision);
    expect(getActiveProfile().profileId).toBe(RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID);
  });
});
