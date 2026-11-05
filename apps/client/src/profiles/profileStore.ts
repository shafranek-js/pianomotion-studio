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
import { RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID } from "./riggedHandProfileCalibration.ts";

export const PROFILES_STORAGE_KEY = "handthesia:profiles";
export const ACTIVE_PROFILE_STORAGE_KEY = "handthesia:active_profile_id";
export const ACTIVE_PROFILE_DB_KEY = "profiles.activeProfileId";
export const DEFAULT_ACTIVE_PROFILE_ID = RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID;

const canonicalProfileIds = new Set(getDefaultProfiles().map((profile) => profile.profileId));
let customStorage: Storage | null = null;
let initialized = false;
let initializationPromise: Promise<void> | null = null;
let defaultsSeeded = false;
const profilesMap = new Map<string, PianistProfile>();
let activeProfileId = DEFAULT_ACTIVE_PROFILE_ID;
const listeners = new Set<() => void>();
const profileEventListeners = new Set<(event: ProfileStoreEvent) => void>();
const unavailableBuiltinIds = new Set<string>();
const profileStoreDiagnostics = new Map<string, ProfileStoreDiagnostic>();

export type ProfileStoreEvent =
  | { type: "active-selection"; profile: PianistProfile }
  | { type: "profile-updated"; profile: PianistProfile };

export interface ProfileStoreDiagnostic {
  code: "measured-builtin-id-collision";
  profileId: string;
  message: string;
}

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
  unavailableBuiltinIds.clear();
  profileStoreDiagnostics.clear();
  activeProfileId = DEFAULT_ACTIVE_PROFILE_ID;
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

function emitProfileEvent(event: ProfileStoreEvent): void {
  for (const listener of profileEventListeners) {
    try {
      listener(structuredClone(event));
    } catch (err) {
      console.error("Profile store event listener error:", err);
    }
  }
}

function profilesEqualExceptId(left: PianistProfile, right: PianistProfile): boolean {
  const leftCopy = structuredClone(left);
  const rightCopy = structuredClone(right);
  leftCopy.profileId = "__profile_id__";
  rightCopy.profileId = "__profile_id__";
  return JSON.stringify(leftCopy) === JSON.stringify(rightCopy);
}

function getMeasuredBuiltin(): PianistProfile | undefined {
  return getDefaultProfiles().find((profile) => profile.profileId === RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID);
}

function applyMeasuredBuiltinCollision(profile: PianistProfile): boolean {
  if (profile.profileId !== RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID) return false;
  const builtin = getMeasuredBuiltin();
  if (!builtin || profilesEqualExceptId(profile, builtin)) return false;

  // Keep the colliding record at its stored identity. Never alias/delete it or
  // rewrite active selections/project snapshots to make room for the builtin.
  profilesMap.set(profile.profileId, structuredClone(profile));
  unavailableBuiltinIds.add(profile.profileId);
  profileStoreDiagnostics.set(profile.profileId, {
    code: "measured-builtin-id-collision",
    profileId: profile.profileId,
    message: "A saved profile uses the measured baseline built-in ID. Its data and ID are preserved in read-only mode; use Duplicate to make an editable copy. The built-in remains unavailable until the conflict is resolved.",
  });
  return true;
}

function seedDefaults(): void {
  if (defaultsSeeded) return;
  profilesMap.clear();
  for (const profile of getDefaultProfiles()) profilesMap.set(profile.profileId, profile);
  activeProfileId = DEFAULT_ACTIVE_PROFILE_ID;
  defaultsSeeded = true;
}

function getFallbackActiveProfileId(): string {
  // A saved collision retains its identity, but must never become active merely
  // because that ID is now the default. Explicit saved selections still win.
  return unavailableBuiltinIds.has(DEFAULT_ACTIVE_PROFILE_ID) ? "default" : DEFAULT_ACTIVE_PROFILE_ID;
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
  for (const profile of legacy.profiles) {
    if (profile.profileId === RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID) {
      if (!applyMeasuredBuiltinCollision(profile) && !unavailableBuiltinIds.has(profile.profileId)) {
        profilesMap.set(profile.profileId, profile);
      }
    } else {
      // Preserve the established localStorage override behavior for existing IDs.
      profilesMap.set(profile.profileId, profile);
    }
  }
  if (legacy.activeProfileId && profilesMap.has(legacy.activeProfileId)) {
    activeProfileId = legacy.activeProfileId;
  } else {
    activeProfileId = getFallbackActiveProfileId();
  }
  if (!profilesMap.has("default")) profilesMap.set("default", getDefaultProfile());
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
    const rawPersisted = await listCustomProfiles();
    const persistedValid = rawPersisted.flatMap((profile) => {
      const validated = PianistProfileSchema.safeParse(profile);
      return validated.success ? [validated.data] : [];
    });
    const measuredBuiltin = getMeasuredBuiltin();
    const persistedMeasured = persistedValid.find((profile) =>
      profile.profileId === RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID,
    );
    const legacyMeasured = [...legacy.profiles].reverse().find((profile) =>
      profile.profileId === RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID,
    );
    let measuredCollision: PianistProfile | undefined;

    if (persistedMeasured && measuredBuiltin && !profilesEqualExceptId(persistedMeasured, measuredBuiltin)) {
      measuredCollision = persistedMeasured;
    } else if (legacyMeasured && measuredBuiltin && !profilesEqualExceptId(legacyMeasured, measuredBuiltin)) {
      // A matching IndexedDB default row is only a redundant builtin copy. Preserve
      // the legacy collision in memory, but never overwrite an existing DB row here.
      measuredCollision = legacyMeasured;
      if (!persistedMeasured) {
        await saveDbProfile(legacyMeasured);
        persistedValid.push(legacyMeasured);
      }
    }

    if (measuredCollision) applyMeasuredBuiltinCollision(measuredCollision);

    const persisted = persistedValid.filter((profile) => {
      if (profile.profileId === RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID) {
        return Boolean(measuredCollision && !profilesEqualExceptId(profile, measuredBuiltin!));
      }
      return !canonicalProfileIds.has(profile.profileId);
    });
    const persistedIdsAfterMigration = new Set(persisted.map((profile) => profile.profileId));
    for (const profile of legacy.profiles) {
      if (profile.profileId === RIGGED_HAND_MEASURED_BASELINE_PROFILE_ID) {
        if (measuredCollision && !persistedIdsAfterMigration.has(profile.profileId)) {
          profilesMap.set(profile.profileId, structuredClone(measuredCollision));
        }
        continue;
      }
      if (canonicalProfileIds.has(profile.profileId) || persistedIdsAfterMigration.has(profile.profileId)) continue;
      await saveDbProfile(profile);
      persistedIdsAfterMigration.add(profile.profileId);
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
        : getFallbackActiveProfileId();
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
  unavailableBuiltinIds.clear();
  profileStoreDiagnostics.clear();
  defaultsSeeded = false;
  initialized = false;
  initializationPromise = null;
  activeProfileId = DEFAULT_ACTIVE_PROFILE_ID;
  ensureReadable();
  notifyListeners();
}

export function isCanonicalProfile(profileId: string): boolean {
  return canonicalProfileIds.has(profileId);
}

/** True when an ID currently resolves to the shipped built-in instead of a saved collision. */
export function isBuiltinProfileAvailable(profileId: string): boolean {
  return canonicalProfileIds.has(profileId) && !unavailableBuiltinIds.has(profileId);
}

/** Returns non-destructive diagnostics discovered while loading persisted profiles. */
export function getProfileStoreDiagnostics(): ProfileStoreDiagnostic[] {
  return Array.from(profileStoreDiagnostics.values(), (diagnostic) => structuredClone(diagnostic));
}

/** Returns a cloned copy of the active profile. Call after initializeProfiles during app startup. */
export function getActiveProfile(): PianistProfile {
  ensureReadable();
  const profile = profilesMap.get(activeProfileId) ?? profilesMap.get(getFallbackActiveProfileId()) ?? getDefaultProfile();
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
  const committed = getActiveProfile();
  emitProfileEvent({ type: "active-selection", profile: committed });
  return committed;
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
  if (canonicalProfileIds.has(toSave.profileId)) {
    if (unavailableBuiltinIds.has(toSave.profileId)) {
      throw new Error(
        `Saved profile '${toSave.profileId}' conflicts with a protected built-in identity and cannot be modified in place. Please clone or save as a copy.`,
      );
    }
    throw new Error(
      `Canonical built-in profile '${toSave.profileId}' cannot be modified or overwritten. Please clone or save as a copy.`,
    );
  }
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
  emitProfileEvent({ type: "profile-updated", profile: validated });
  return structuredClone(validated);
}

/** Deletes a custom profile; canonical profiles are protected from removal. */
export async function deleteProfile(profileId: string): Promise<boolean> {
  await initializeProfiles();
  if (canonicalProfileIds.has(profileId) || !profilesMap.has(profileId)) return false;
  const nextActiveId = activeProfileId === profileId ? getFallbackActiveProfileId() : activeProfileId;
  const deletedActiveProfile = nextActiveId !== activeProfileId;
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
  if (deletedActiveProfile) {
    emitProfileEvent({ type: "active-selection", profile: getActiveProfile() });
  }
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

/** Subscribes to committed profile changes and explicit active-profile selections. */
export function subscribeProfileEvents(listener: (event: ProfileStoreEvent) => void): () => void {
  profileEventListeners.add(listener);
  return () => profileEventListeners.delete(listener);
}

export const subscribeProfiles = subscribe;
