import {
  type PianistProfile,
  PianistProfileSchema,
} from "@handthesia/contracts";
import {
  deleteProfile as deleteDbProfile,
  deleteProfileAndSetActive as deleteDbProfileAndSetActive,
  getDbSetting,
  listCustomProfiles,
  saveDbSetting,
  saveProfile as saveDbProfile,
} from "../storage/projectDb.ts";
import { getDefaultProfiles, getDefaultProfile } from "./defaultProfiles.ts";

export const PROFILES_STORAGE_KEY = "handthesia:profiles";
export const ACTIVE_PROFILE_STORAGE_KEY = "handthesia:active_profile_id";
export const ACTIVE_PROFILE_DB_KEY = "profiles.activeProfileId";

const canonicalProfileIds = new Set(getDefaultProfiles().map((profile) => profile.profileId));
let customStorage: Storage | null = null;
let initialized = false;
let initializationPromise: Promise<void> | null = null;
let defaultsSeeded = false;
const profilesMap = new Map<string, PianistProfile>();
let activeProfileId = "default";
const listeners = new Set<() => void>();

function getStorage(): Storage | null {
  if (customStorage !== null) return customStorage;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

/** Configure a legacy Storage source or mock instance. */
export function setProfileStorage(storage: Storage | null): void {
  customStorage = storage;
  initialized = false;
  initializationPromise = null;
  defaultsSeeded = false;
  profilesMap.clear();
  activeProfileId = "default";
}

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error("Profile store listener error:", err);
    }
  }
}

function seedDefaults(): void {
  if (defaultsSeeded) return;
  profilesMap.clear();
  for (const profile of getDefaultProfiles()) profilesMap.set(profile.profileId, profile);
  activeProfileId = "default";
  defaultsSeeded = true;
}

function readLegacyProfiles(): { profiles: PianistProfile[]; activeProfileId: string | null } {
  const storage = getStorage();
  if (!storage) return { profiles: [], activeProfileId: null };
  const profiles: PianistProfile[] = [];
  try {
    const raw = storage.getItem(PROFILES_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const validated = PianistProfileSchema.safeParse(item);
          if (validated.success) profiles.push(validated.data);
        }
      }
    }
  } catch (err) {
    console.warn("Failed to read legacy profiles:", err);
  }
  let savedActive: string | null = null;
  try {
    savedActive = storage.getItem(ACTIVE_PROFILE_STORAGE_KEY);
  } catch (err) {
    console.warn("Failed to read legacy active profile:", err);
  }
  return { profiles, activeProfileId: savedActive };
}

function persistLegacyState(nextProfiles: Map<string, PianistProfile>, nextActiveProfileId: string): void {
  const storage = getStorage();
  if (!storage) throw new Error("Profile persistence is unavailable.");
  storage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(Array.from(nextProfiles.values())));
  storage.setItem(ACTIVE_PROFILE_STORAGE_KEY, nextActiveProfileId);
}

function initializeLegacyOverride(): void {
  seedDefaults();
  const legacy = readLegacyProfiles();
  for (const profile of legacy.profiles) profilesMap.set(profile.profileId, profile);
  if (legacy.activeProfileId && profilesMap.has(legacy.activeProfileId)) {
    activeProfileId = legacy.activeProfileId;
  }
  if (!profilesMap.has("default")) profilesMap.set("default", getDefaultProfile());
  if (!profilesMap.has(activeProfileId)) activeProfileId = "default";
  initialized = true;
}

/**
 * Opens IndexedDB, migrates the prior localStorage profile list and active ID once,
 * then hydrates the synchronous read API used by React components.
 */
export function initializeProfiles(): Promise<void> {
  if (customStorage !== null) {
    if (!initialized) initializeLegacyOverride();
    return Promise.resolve();
  }
  if (initialized) return Promise.resolve();
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    seedDefaults();
    const legacy = readLegacyProfiles();
    const persisted = (await listCustomProfiles()).flatMap((profile) => {
      const validated = PianistProfileSchema.safeParse(profile);
      return validated.success && !isCanonicalProfile(validated.data.profileId) ? [validated.data] : [];
    });
    const persistedIds = new Set(persisted.map((profile) => profile.profileId));
    for (const profile of legacy.profiles) {
      if (isCanonicalProfile(profile.profileId) || persistedIds.has(profile.profileId)) continue;
      await saveDbProfile(profile);
      persistedIds.add(profile.profileId);
      persisted.push(profile);
    }
    for (const profile of persisted) {
      const validated = PianistProfileSchema.safeParse(profile);
      if (validated.success) profilesMap.set(validated.data.profileId, validated.data);
    }

    const storedActive = await getDbSetting<unknown>(ACTIVE_PROFILE_DB_KEY);
    const activeId = typeof storedActive === "string" && profilesMap.has(storedActive)
      ? storedActive
      : legacy.activeProfileId && profilesMap.has(legacy.activeProfileId)
        ? legacy.activeProfileId
        : "default";
    if (activeId !== storedActive) await saveDbSetting(ACTIVE_PROFILE_DB_KEY, activeId);
    activeProfileId = activeId;
    if (!profilesMap.has("default")) profilesMap.set("default", getDefaultProfile());
    initialized = true;
    notifyListeners();
  })().finally(() => {
    initializationPromise = null;
  });
  return initializationPromise;
}

function ensureReadable(): void {
  seedDefaults();
  if (customStorage !== null && !initialized) initializeLegacyOverride();
}

/** Resets the in-memory/legacy test state. It does not clear IndexedDB. */
export function resetProfileStore(): void {
  const storage = getStorage();
  if (storage) {
    try {
      storage.removeItem(PROFILES_STORAGE_KEY);
      storage.removeItem(ACTIVE_PROFILE_STORAGE_KEY);
    } catch {
      // This helper is used only by tests; the next initialization still reseeds defaults.
    }
  }
  profilesMap.clear();
  defaultsSeeded = false;
  initialized = false;
  initializationPromise = null;
  activeProfileId = "default";
  ensureReadable();
  notifyListeners();
}

export function isCanonicalProfile(profileId: string): boolean {
  return canonicalProfileIds.has(profileId);
}

/** Returns a cloned copy of the active profile. Call after initializeProfiles during app startup. */
export function getActiveProfile(): PianistProfile {
  ensureReadable();
  const profile = profilesMap.get(activeProfileId) ?? profilesMap.get("default") ?? getDefaultProfile();
  return structuredClone(profile);
}

/** Sets the active profile only after IndexedDB accepts the new selection. */
export async function setActiveProfile(profileId: string): Promise<PianistProfile> {
  await initializeProfiles();
  if (!profilesMap.has(profileId)) throw new Error(`Profile not found: ${profileId}`);
  if (activeProfileId !== profileId) {
    if (customStorage !== null) {
      const nextProfiles = new Map(profilesMap);
      persistLegacyState(nextProfiles, profileId);
    } else {
      await saveDbSetting(ACTIVE_PROFILE_DB_KEY, profileId);
    }
    activeProfileId = profileId;
    notifyListeners();
  }
  return getActiveProfile();
}

/** Returns a cloned list of built-in and persisted pianist profiles. */
export function listProfiles(): PianistProfile[] {
  ensureReadable();
  return Array.from(profilesMap.values()).map((profile) => structuredClone(profile));
}

/** Saves a profile and returns the normalized, committed revision. */
export async function saveProfile(profile: PianistProfile): Promise<PianistProfile> {
  await initializeProfiles();
  const toSave = structuredClone(PianistProfileSchema.parse(profile));
  const existing = profilesMap.get(toSave.profileId);
  if (existing) toSave.revision = Math.max(toSave.revision, existing.revision + 1);
  const now = Date.now() / 1000;
  toSave.modifiedAtUnixSeconds = Math.max(now, toSave.createdAtUnixSeconds);
  const validated = PianistProfileSchema.parse(toSave);

  if (customStorage !== null) {
    const nextProfiles = new Map(profilesMap);
    nextProfiles.set(validated.profileId, validated);
    persistLegacyState(nextProfiles, activeProfileId);
  } else {
    await saveDbProfile(validated);
  }
  profilesMap.set(validated.profileId, validated);
  notifyListeners();
  return structuredClone(validated);
}

/** Deletes a custom profile; canonical profiles are protected from removal. */
export async function deleteProfile(profileId: string): Promise<boolean> {
  await initializeProfiles();
  if (isCanonicalProfile(profileId) || !profilesMap.has(profileId)) return false;
  const nextActiveId = activeProfileId === profileId ? "default" : activeProfileId;
  if (customStorage !== null) {
    const nextProfiles = new Map(profilesMap);
    nextProfiles.delete(profileId);
    persistLegacyState(nextProfiles, nextActiveId);
  } else if (nextActiveId !== activeProfileId) {
    await deleteDbProfileAndSetActive(profileId, ACTIVE_PROFILE_DB_KEY, nextActiveId);
  } else {
    await deleteDbProfile(profileId);
  }
  profilesMap.delete(profileId);
  activeProfileId = nextActiveId;
  notifyListeners();
  return true;
}

/** Clones an existing profile, persists it, and returns the committed DTO. */
export async function cloneProfile(profileId: string, newName: string): Promise<PianistProfile> {
  await initializeProfiles();
  const source = profilesMap.get(profileId);
  if (!source) throw new Error(`Cannot clone: source profile '${profileId}' not found`);
  if (typeof newName !== "string" || newName.trim().length === 0) {
    throw new Error("Cannot clone: newName must be a non-empty string");
  }
  const trimmedName = newName.trim();
  const baseSlug = trimmedName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
  let candidateId = baseSlug;
  let counter = 1;
  while (profilesMap.has(candidateId)) candidateId = `${baseSlug}-${counter++}`;
  const now = Date.now() / 1000;
  return saveProfile({
    ...structuredClone(source),
    profileId: candidateId,
    name: trimmedName,
    revision: 0,
    createdAtUnixSeconds: now,
    modifiedAtUnixSeconds: now,
  });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const subscribeProfiles = subscribe;
