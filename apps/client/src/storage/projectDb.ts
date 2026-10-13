import { z } from "zod";
import {
  SongDocumentSchema,
  FingeringPlanSchema,
  PerformancePlanSchema,
  MotionPlanSchema,
  PianistProfileSchema,
  type SongDocument,
  type FingeringPlan,
  type PerformancePlan,
  type MotionPlan,
  type PianistProfile,
  ResourceDescriptorSchema,
  validateFingeringPlanReferences,
  validatePerformancePlanReferences,
  type ResourceDescriptor,
} from "@handthesia/contracts";

export const DB_NAME = "handthesia_db";
export const DB_VERSION = 2;
export const STORE_NAME = "projects";

export const PROJECTS_STORE = "projects";
export const PROFILES_STORE = "profiles";
export const SETTINGS_STORE = "settings";
export const SESSION_STORE = "session";

/**
 * Custom error thrown when an IndexedDB write operation fails due to storage quota limits.
 */
export class StorageQuotaExceededError extends Error {
  readonly cause?: unknown;

  constructor(message = "Storage quota exceeded while writing to IndexedDB.", cause?: unknown) {
    super(message);
    this.name = "StorageQuotaExceededError";
    this.cause = cause;
  }
}

/**
 * Helper to determine if an error is a QuotaExceededError or quota-related failure.
 */
export function isQuotaExceededError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof StorageQuotaExceededError) return true;
  if (typeof err === "object") {
    const error = err as { name?: string; code?: number; message?: string };
    if (
      error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED"
    ) {
      return true;
    }
    if (error.code === 22 || error.code === 1014) {
      return true;
    }
    if (typeof error.message === "string" && /quota/i.test(error.message)) {
      return true;
    }
  }
  return false;
}

/**
 * Wraps an unknown error into StorageQuotaExceededError if quota-related, or a standard Error otherwise.
 */
export function wrapQuotaError(err: unknown, fallbackMessage: string): Error {
  if (isQuotaExceededError(err)) {
    return new StorageQuotaExceededError(
      `Storage quota exceeded: ${fallbackMessage}`,
      err,
    );
  }
  if (err instanceof Error) {
    return err;
  }
  return new Error(fallbackMessage);
}

/**
 * Persisted project record stored in IndexedDB.
 */
export interface SavedProject {
  projectId: string;
  name: string;
  updatedAt: number;
  document: SongDocument;
  fingeringPlan?: FingeringPlan | null;
  performancePlan?: PerformancePlan | null;
  motionPlan?: MotionPlan | null;
  rawMidiBytes?: ArrayBuffer | null;
  profile?: PianistProfile | null;
  resources?: ResourceDescriptor[];
  resourcePayloads?: Record<string, ArrayBuffer>;
}

/**
 * Summary descriptor returned by `listProjects`.
 */
export interface ProjectSummary {
  projectId: string;
  name: string;
  updatedAt: number;
  noteCount: number;
}

export const SavedProjectSchema = z.object({
  projectId: z.string().trim().min(1),
  name: z.string().min(1),
  updatedAt: z.number().finite(),
  document: SongDocumentSchema,
  fingeringPlan: FingeringPlanSchema.nullable().optional(),
  performancePlan: PerformancePlanSchema.nullable().optional(),
  motionPlan: MotionPlanSchema.nullable().optional(),
  rawMidiBytes: z
    .custom<ArrayBuffer | null | undefined>(
      (val) => val === undefined || val === null || val instanceof ArrayBuffer,
      "Expected ArrayBuffer or null/undefined",
    )
    .optional(),
  profile: PianistProfileSchema.nullable().optional(),
  resources: z.array(ResourceDescriptorSchema).optional(),
  resourcePayloads: z.record(
    z.string(),
    z.custom<ArrayBuffer>((value) => value instanceof ArrayBuffer, "Expected resource ArrayBuffer"),
  ).optional(),
});

/**
 * Validates both the persisted DTO shape and the identity links between its artifacts.
 */
export function validateSavedProject(input: unknown): SavedProject {
  const project = SavedProjectSchema.parse(input);
  if (project.document.projectId !== project.projectId) {
    throw new Error("Saved project document.projectId must match projectId.");
  }

  const plans = [project.fingeringPlan, project.performancePlan, project.motionPlan]
    .filter((plan) => plan != null);
  if (plans.length > 0) {
    const reference = plans[0]!;
    for (const plan of plans) {
      if (plan.projectId !== project.projectId || plan.inputRevision !== project.document.revision) {
        throw new Error("Saved project plans must match the project ID and document revision.");
      }
      if (plan.profileId !== reference.profileId || plan.profileRevision !== reference.profileRevision ||
          plan.engineVersion !== reference.engineVersion) {
        throw new Error("Saved project plans must share one profile revision and engine version.");
      }
    }
    if (project.profile && (project.profile.profileId !== reference.profileId ||
        project.profile.revision !== reference.profileRevision)) {
      throw new Error("Saved project profile must match its plan profile ID and revision.");
    }
  }

  if (project.performancePlan) {
    if (!project.fingeringPlan || project.performancePlan.fingeringPlanId !== project.fingeringPlan.planId) {
      throw new Error("Saved performance plan must reference the saved fingering plan.");
    }
    validatePerformancePlanReferences(project.performancePlan, project.document);
  }
  if (project.fingeringPlan) {
    validateFingeringPlanReferences(project.fingeringPlan, project.document);
  }
  if (project.motionPlan && (!project.performancePlan ||
      project.motionPlan.performancePlanId !== project.performancePlan.planId)) {
    throw new Error("Saved motion plan must reference the saved performance plan.");
  }

  const resources = project.resources ?? [];
  const resourceIds = new Set<string>();
  const resourcePaths = new Set<string>();
  for (const resource of resources) {
    if (resourceIds.has(resource.resourceId) || resourcePaths.has(resource.path)) {
      throw new Error("Saved project resource IDs and paths must be unique.");
    }
    resourceIds.add(resource.resourceId);
    resourcePaths.add(resource.path);
  }
  for (const [path, bytes] of Object.entries(project.resourcePayloads ?? {})) {
    const resource = resources.find((candidate) => candidate.path === path);
    if (!resource) throw new Error(`Saved resource payload '${path}' has no descriptor.`);
    if (resource.byteLength !== bytes.byteLength) {
      throw new Error(`Saved resource payload '${path}' has a byte length that does not match its descriptor.`);
    }
  }
  if (project.document.sourceMidiResourceId) {
    const source = resources.find((resource) => resource.resourceId === project.document.sourceMidiResourceId);
    if (source && (source.purpose !== "source-midi" || source.mediaType !== "audio/midi")) {
      throw new Error("The saved source MIDI resource descriptor has an invalid purpose or media type.");
    }
    if (source && project.rawMidiBytes && source.byteLength !== project.rawMidiBytes.byteLength) {
      throw new Error("The source MIDI descriptor byte length does not match the stored original bytes.");
    }
    if (source && project.resourcePayloads?.[source.path] && project.rawMidiBytes &&
        !bytesEqual(project.resourcePayloads[source.path]!, project.rawMidiBytes)) {
      throw new Error("The source MIDI payload and rawMidiBytes must contain the same original bytes.");
    }
  }
  return project;
}

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  return left.every((value, index) => value === right[index]);
}

let dbInstance: IDBDatabase | null = null;
let customIdbFactory: IDBFactory | null = null;

/**
 * Allows injecting a custom IDBFactory (e.g. for testing or Node-based environments).
 */
export function setIndexedDBFactory(factory: IDBFactory | null): void {
  customIdbFactory = factory;
  closeProjectDb();
}

function getIdbFactory(): IDBFactory {
  if (customIdbFactory) {
    return customIdbFactory;
  }
  if (typeof indexedDB !== "undefined") {
    return indexedDB;
  }
  if (typeof window !== "undefined" && window.indexedDB) {
    return window.indexedDB;
  }
  throw new Error("IndexedDB is not available in the current runtime environment.");
}

/**
 * Opens or reuses the active `handthesia_db` IndexedDB connection at version 2.
 */
export function openProjectDb(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  const factory = getIdbFactory();

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      // 1. Projects store (from v1) - preserves existing projects
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        const store = db.createObjectStore(PROJECTS_STORE, { keyPath: "projectId" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
        store.createIndex("name", "name", { unique: false });
      }

      // 2. Profiles store (v2) - stores custom PianistProfile DTOs
      if (!db.objectStoreNames.contains(PROFILES_STORE)) {
        db.createObjectStore(PROFILES_STORE, { keyPath: "profileId" });
      }

      // 3. Settings store (v2) - key/value configuration
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }

      // 4. Session store (v2) - autosave recovery snapshots
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      dbInstance = db;

      db.onversionchange = () => {
        db.close();
        dbInstance = null;
      };

      db.onclose = () => {
        dbInstance = null;
      };

      resolve(db);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open IndexedDB database."));
    };

    request.onblocked = () => {
      console.warn("IndexedDB open blocked: close existing connections in other tabs.");
    };
  });
}

/**
 * Closes the active IndexedDB connection if open.
 */
export function closeProjectDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore close errors
    }
    dbInstance = null;
  }
}

/**
 * Persists a project into IndexedDB under the `projects` object store.
 */
export async function saveProject(project: SavedProject): Promise<void> {
  const validated = validateSavedProject(project);
  const db = await openProjectDb();

  const record: SavedProject = {
    ...validated,
    projectId: validated.projectId,
    name: validated.name || validated.projectId,
    updatedAt: validated.updatedAt || Date.now(),
    fingeringPlan: validated.fingeringPlan ?? null,
    performancePlan: validated.performancePlan ?? null,
    motionPlan: validated.motionPlan ?? null,
    rawMidiBytes: validated.rawMidiBytes ?? null,
    profile: validated.profile ?? null,
    resources: validated.resources ?? [],
    resourcePayloads: validated.resourcePayloads ?? {},
  };

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const safeReject = (err: unknown, fallback: string) => {
      if (!settled) {
        settled = true;
        reject(wrapQuotaError(err, fallback));
      }
    };
    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const tx = db.transaction(PROJECTS_STORE, "readwrite");
    const store = tx.objectStore(PROJECTS_STORE);

    let request: IDBRequest;
    try {
      request = store.put(record);
    } catch (err) {
      safeReject(err, `Failed to save project "${project.projectId}"`);
      return;
    }

    request.onsuccess = () => {
      safeResolve();
    };

    request.onerror = () => {
      safeReject(request.error, `Failed to save project "${project.projectId}"`);
    };

    tx.onerror = () => {
      safeReject(tx.error, `Transaction failed while saving project "${project.projectId}"`);
    };

    tx.onabort = () => {
      safeReject(tx.error, `Transaction aborted while saving project "${project.projectId}"`);
    };
  });
}

/**
 * Retrieves a project from IndexedDB by its `projectId`. Returns `null` if not found.
 */
export async function getProject(projectId: string): Promise<SavedProject | null> {
  const db = await openProjectDb();

  return new Promise<SavedProject | null>((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, "readonly");
    const store = tx.objectStore(PROJECTS_STORE);
    const request = store.get(projectId);

    request.onsuccess = () => {
      const result = request.result as SavedProject | undefined;
      resolve(result ? validateSavedProject(result) : null);
    };

    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to get project "${projectId}"`));
    };

    tx.onerror = () => {
      reject(tx.error ?? new Error(`Transaction failed while getting project "${projectId}"`));
    };
  });
}

/**
 * Lists all projects stored in IndexedDB, sorted by `updatedAt` descending (newest first).
 */
export async function listProjects(): Promise<Array<{ projectId: string; name: string; updatedAt: number; noteCount: number }>> {
  const db = await openProjectDb();

  return new Promise<ProjectSummary[]>((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, "readonly");
    const store = tx.objectStore(PROJECTS_STORE);
    const request = store.getAll();

    request.onsuccess = () => {
      const records = (request.result ?? []) as SavedProject[];
      records.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

      const summaries: ProjectSummary[] = records.map((rec) => ({
        projectId: rec.projectId,
        name: rec.name,
        updatedAt: rec.updatedAt,
        noteCount: Array.isArray(rec.document?.notes) ? rec.document.notes.length : 0,
      }));

      resolve(summaries);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to list projects from IndexedDB."));
    };

    tx.onerror = () => {
      reject(tx.error ?? new Error("Transaction failed while listing projects."));
    };
  });
}

/**
 * Deletes a project from IndexedDB by its `projectId`.
 */
export async function deleteProject(projectId: string): Promise<void> {
  const db = await openProjectDb();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, "readwrite");
    const store = tx.objectStore(PROJECTS_STORE);
    const request = store.delete(projectId);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to delete project "${projectId}"`));
    };

    tx.onerror = () => {
      reject(tx.error ?? new Error(`Transaction failed while deleting project "${projectId}"`));
    };
  });
}

/**
 * Clears all projects from the store (utility for resets and testing).
 */
export async function clearAllProjects(): Promise<void> {
  const db = await openProjectDb();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, "readwrite");
    const store = tx.objectStore(PROJECTS_STORE);
    const request = store.clear();

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to clear projects store."));
    };

    tx.onerror = () => {
      reject(tx.error ?? new Error("Transaction failed while clearing projects."));
    };
  });
}

// ============================================================================
// Profiles Persistence Methods (v2)
// ============================================================================

/**
 * Persists a custom PianistProfile into IndexedDB under the `profiles` object store.
 */
export async function saveProfile(profile: PianistProfile): Promise<void> {
  PianistProfileSchema.parse(profile);
  const db = await openProjectDb();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const safeReject = (err: unknown, fallback: string) => {
      if (!settled) {
        settled = true;
        reject(wrapQuotaError(err, fallback));
      }
    };
    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const tx = db.transaction(PROFILES_STORE, "readwrite");
    const store = tx.objectStore(PROFILES_STORE);

    let request: IDBRequest;
    try {
      request = store.put(profile);
    } catch (err) {
      safeReject(err, `Failed to save profile "${profile.profileId}"`);
      return;
    }

    request.onsuccess = () => {
      safeResolve();
    };

    request.onerror = () => {
      safeReject(request.error, `Failed to save profile "${profile.profileId}"`);
    };

    tx.onerror = () => {
      safeReject(tx.error, `Transaction failed while saving profile "${profile.profileId}"`);
    };

    tx.onabort = () => {
      safeReject(tx.error, `Transaction aborted while saving profile "${profile.profileId}"`);
    };
  });
}

/**
 * Retrieves a custom PianistProfile from IndexedDB by its `profileId`. Returns `null` if not found.
 */
export async function getProfile(profileId: string): Promise<PianistProfile | null> {
  const db = await openProjectDb();

  return new Promise<PianistProfile | null>((resolve, reject) => {
    const tx = db.transaction(PROFILES_STORE, "readonly");
    const store = tx.objectStore(PROFILES_STORE);
    const request = store.get(profileId);

    request.onsuccess = () => {
      const result = request.result as PianistProfile | undefined;
      resolve(result ?? null);
    };

    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to get profile "${profileId}"`));
    };

    tx.onerror = () => {
      reject(tx.error ?? new Error(`Transaction failed while getting profile "${profileId}"`));
    };
  });
}

/**
 * Lists all custom profiles stored in IndexedDB, sorted by `modifiedAtUnixSeconds` descending.
 */
export async function listCustomProfiles(): Promise<PianistProfile[]> {
  const db = await openProjectDb();

  return new Promise<PianistProfile[]>((resolve, reject) => {
    const tx = db.transaction(PROFILES_STORE, "readonly");
    const store = tx.objectStore(PROFILES_STORE);
    const request = store.getAll();

    request.onsuccess = () => {
      const records = (request.result ?? []) as PianistProfile[];
      records.sort((a, b) => (b.modifiedAtUnixSeconds ?? 0) - (a.modifiedAtUnixSeconds ?? 0));
      resolve(records);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to list custom profiles from IndexedDB."));
    };

    tx.onerror = () => {
      reject(tx.error ?? new Error("Transaction failed while listing profiles."));
    };
  });
}

/**
 * Deletes a custom profile from IndexedDB by its `profileId`.
 */
export async function deleteProfile(profileId: string): Promise<void> {
  const db = await openProjectDb();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROFILES_STORE, "readwrite");
    const store = tx.objectStore(PROFILES_STORE);
    const request = store.delete(profileId);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to delete profile "${profileId}"`));
    };

    tx.onerror = () => {
      reject(tx.error ?? new Error(`Transaction failed while deleting profile "${profileId}"`));
    };
  });
}

/** Atomically removes an active profile and records its fallback selection. */
export async function deleteProfileAndSetActive(
  profileId: string,
  activeProfileSettingKey: string,
  fallbackProfileId: string,
): Promise<void> {
  const db = await openProjectDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([PROFILES_STORE, SETTINGS_STORE], "readwrite");
    let settled = false;
    const safeReject = (error: unknown, message: string) => {
      if (settled) return;
      settled = true;
      reject(wrapQuotaError(error, message));
    };
    const profileRequest = tx.objectStore(PROFILES_STORE).delete(profileId);
    const settingRequest = tx.objectStore(SETTINGS_STORE).put({
      key: activeProfileSettingKey,
      value: fallbackProfileId,
      updatedAt: Date.now(),
    } satisfies PersistedSettingRecord<string>);
    profileRequest.onerror = () => safeReject(profileRequest.error, `Failed to delete profile "${profileId}"`);
    settingRequest.onerror = () => safeReject(settingRequest.error, "Failed to save the fallback active profile");
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onerror = () => safeReject(tx.error, "Transaction failed while deleting the active profile");
    tx.onabort = () => safeReject(tx.error, "Transaction aborted while deleting the active profile");
  });
}

/**
 * Clears all profiles from the store (utility for resets and testing).
 */
export async function clearAllProfiles(): Promise<void> {
  const db = await openProjectDb();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROFILES_STORE, "readwrite");
    const store = tx.objectStore(PROFILES_STORE);
    const request = store.clear();

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to clear profiles store."));
    };

    tx.onerror = () => {
      reject(tx.error ?? new Error("Transaction failed while clearing profiles."));
    };
  });
}

// ============================================================================
// Settings Store Methods (v2)
// ============================================================================

export interface PersistedSettingRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
}

/**
 * Persists an arbitrary setting value into the IndexedDB `settings` store.
 */
export async function saveDbSetting<T>(key: string, value: T): Promise<void> {
  const db = await openProjectDb();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const safeReject = (err: unknown, fallback: string) => {
      if (!settled) {
        settled = true;
        reject(wrapQuotaError(err, fallback));
      }
    };
    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const tx = db.transaction(SETTINGS_STORE, "readwrite");
    const store = tx.objectStore(SETTINGS_STORE);
    const record: PersistedSettingRecord<T> = {
      key,
      value,
      updatedAt: Date.now(),
    };

    let request: IDBRequest;
    try {
      request = store.put(record);
    } catch (err) {
      safeReject(err, `Failed to save setting "${key}"`);
      return;
    }

    request.onsuccess = () => safeResolve();
    request.onerror = () => safeReject(request.error, `Failed to save setting "${key}"`);
    tx.onerror = () => safeReject(tx.error, `Transaction failed while saving setting "${key}"`);
    tx.onabort = () => safeReject(tx.error, `Transaction aborted while saving setting "${key}"`);
  });
}

/**
 * Retrieves a persisted setting value by key from the IndexedDB `settings` store.
 */
export async function getDbSetting<T>(key: string): Promise<T | null> {
  const db = await openProjectDb();

  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, "readonly");
    const store = tx.objectStore(SETTINGS_STORE);
    const request = store.get(key);

    request.onsuccess = () => {
      const record = request.result as PersistedSettingRecord<T> | undefined;
      resolve(record ? record.value : null);
    };

    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to get setting "${key}"`));
    };

    tx.onerror = () => {
      reject(tx.error ?? new Error(`Transaction failed while getting setting "${key}"`));
    };
  });
}

/**
 * Deletes a persisted setting by key from the IndexedDB `settings` store.
 */
export async function deleteDbSetting(key: string): Promise<void> {
  const db = await openProjectDb();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, "readwrite");
    const store = tx.objectStore(SETTINGS_STORE);
    const request = store.delete(key);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Failed to delete setting "${key}"`));
    tx.onerror = () => reject(tx.error ?? new Error(`Transaction failed while deleting setting "${key}"`));
  });
}
