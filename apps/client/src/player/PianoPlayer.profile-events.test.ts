import { afterEach, describe, expect, it, vi } from "vitest";
import type { PianistProfile } from "@handthesia/contracts";
import { DEFAULT_PROFILE } from "../profiles/defaultProfiles";
import {
  deleteProfile,
  getActiveProfile,
  resetProfileStore,
  saveProfile,
  setActiveProfile,
  setProfileStorage,
  subscribeProfileEvents,
  type ProfileStoreEvent,
} from "../profiles/profileStore";
import { profileFromStoreEvent } from "./PianoPlayer";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function makeProfile(profileId: string, revision = 0): PianistProfile {
  return {
    ...structuredClone(DEFAULT_PROFILE),
    profileId,
    name: profileId,
    revision,
  };
}

function deliverEvent(
  event: ProfileStoreEvent,
  current: PianistProfile,
  apply: (profile: PianistProfile) => void,
): void {
  const profile = profileFromStoreEvent(event, current);
  if (profile) apply(profile);
}

afterEach(() => {
  setProfileStorage(null);
});

describe("PianoPlayer profile store events", () => {
  it("ignores saves to a different library profile without requesting a project update", () => {
    const projectProfile = makeProfile("project-profile", 2);
    const otherProfile = makeProfile("other-profile", 1);
    const apply = vi.fn();

    deliverEvent({ type: "profile-updated", profile: otherProfile }, projectProfile, apply);

    expect(apply).not.toHaveBeenCalled();
  });

  it("applies an explicit selection even when it is already the global active profile", () => {
    const openProjectProfile = makeProfile("project-profile", 2);
    const globalProfile = makeProfile("global-profile", 1);
    const apply = vi.fn();

    // The store emits active-selection for an explicit choice even if the
    // global ID was already global-profile; the open project still differs.
    deliverEvent({ type: "active-selection", profile: globalProfile }, openProjectProfile, apply);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(globalProfile);
  });

  it("applies a newer revision of the profile used by the open project", () => {
    const savedProjectProfile = makeProfile("project-profile", 2);
    const updatedProfile = makeProfile("project-profile", 3);
    updatedProfile.anatomy.pp2 += 0.1;
    const apply = vi.fn();

    deliverEvent({ type: "profile-updated", profile: updatedProfile }, savedProjectProfile, apply);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(updatedProfile);
  });

  it("deduplicates repeated selection and update events before they can replan again", () => {
    let currentProfile = makeProfile("project-profile", 2);
    const selectedProfile = makeProfile("global-profile", 1);
    const updatedProfile = makeProfile("global-profile", 2);
    updatedProfile.anatomy.pp2 += 0.1;
    const apply = vi.fn((profile: PianistProfile) => { currentProfile = profile; });

    deliverEvent({ type: "active-selection", profile: selectedProfile }, currentProfile, apply);
    deliverEvent({ type: "active-selection", profile: selectedProfile }, currentProfile, apply);
    deliverEvent({ type: "profile-updated", profile: updatedProfile }, currentProfile, apply);
    deliverEvent({ type: "profile-updated", profile: updatedProfile }, currentProfile, apply);

    expect(apply).toHaveBeenCalledTimes(2);
    expect(currentProfile).toEqual(updatedProfile);
  });

  it("does not replan for a repeated active-profile revision", () => {
    const activeProfile = makeProfile("project-profile", 3);
    const apply = vi.fn();

    deliverEvent({ type: "profile-updated", profile: activeProfile }, activeProfile, apply);

    expect(apply).not.toHaveBeenCalled();
  });

  it("integrates store events without replacing project P for unrelated library changes", async () => {
    setProfileStorage(new MemoryStorage());
    resetProfileStore();

    const projectProfile = await saveProfile(makeProfile("project-profile"));
    const globalProfile = await saveProfile(makeProfile("global-profile"));
    const unrelatedProfile = await saveProfile(makeProfile("unrelated-profile"));
    await setActiveProfile(globalProfile.profileId);

    let currentProjectProfile = projectProfile;
    const appliedProfiles: PianistProfile[] = [];
    const observedEvents: ProfileStoreEvent[] = [];
    const apply = (profile: PianistProfile) => {
      appliedProfiles.push(profile);
      currentProjectProfile = profile;
    };
    const applyStoreEvent = (event: ProfileStoreEvent) => {
      observedEvents.push(event);
      deliverEvent(event, currentProjectProfile, apply);
    };
    const unsubscribe = subscribeProfileEvents(applyStoreEvent);

    try {
      await saveProfile({ ...unrelatedProfile, name: "Updated unrelated profile" });
      await deleteProfile(unrelatedProfile.profileId);

      expect(currentProjectProfile).toEqual(projectProfile);
      expect(appliedProfiles).toEqual([]);

      const updatedProjectProfile = await saveProfile({
        ...projectProfile,
        anatomy: { ...projectProfile.anatomy, pp2: projectProfile.anatomy.pp2 + 0.1 },
      });
      expect(updatedProjectProfile.revision).toBeGreaterThan(projectProfile.revision);
      expect(getActiveProfile().profileId).toBe(globalProfile.profileId);
      expect(currentProjectProfile).toEqual(updatedProjectProfile);
      expect(appliedProfiles).toEqual([updatedProjectProfile]);

      // Setting the already-global ID is still an explicit selection event.
      await setActiveProfile(globalProfile.profileId);
      expect(currentProjectProfile).toEqual(globalProfile);
      expect(appliedProfiles).toEqual([updatedProjectProfile, globalProfile]);

      const updatedGlobalProfile = await saveProfile({
        ...globalProfile,
        anatomy: { ...globalProfile.anatomy, pp2: globalProfile.anatomy.pp2 + 0.1 },
      });
      expect(updatedGlobalProfile.revision).toBeGreaterThan(globalProfile.revision);
      expect(currentProjectProfile).toEqual(updatedGlobalProfile);
      expect(appliedProfiles).toEqual([updatedProjectProfile, globalProfile, updatedGlobalProfile]);

      const repeatedUpdate = observedEvents[observedEvents.length - 1]!;
      deliverEvent(repeatedUpdate, currentProjectProfile, apply);
      expect(appliedProfiles).toHaveLength(3);
    } finally {
      unsubscribe();
    }
  });
});
