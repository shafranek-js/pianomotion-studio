import {
  type SongDocument,
  type FingeringPlan,
  type M1AnalyzeMidiResult,
  type M1KeyStyle,
  type PianistProfile,
  type ResourceDescriptor,
  ProjectSourceContextSchema,
  type ProjectSourceContext,
  M1AnalyzeMidiResultSchema,
  PianistProfileSchema,
  ResourceDescriptorSchema,
  SongDocumentSchema,
  FingeringPlanSchema,
  validateFingeringPlanReferences,
  validatePerformancePlanReferences,
  PracticeStateSchema,
  validatePracticeStateForProject,
  type PracticeState,
} from "@handthesia/contracts";
import { z } from "zod";
import {
  openProjectDb,
  SESSION_STORE,
  wrapQuotaError,
} from "./projectDb.ts";
import { computeSha256Hex } from "./packageExporter.ts";
import type { StudioView } from "../studio/types.ts";

export const AUTOSAVE_SESSION_ID = "current_session";

/**
 * Snapshot representing a currently active session for autosave and recovery.
 */
export interface SessionSnapshot {
  projectId: string;
  projectName?: string;
  updatedAt: number;
  /** Full analysis envelope. Required for a coherent current-session recovery. */
  result?: M1AnalyzeMidiResult | null;
  /** Original source MIDI bytes; never reconstructed from normalized notes. */
  rawMidiBytes?: ArrayBuffer | null;
  /** Actual profile DTO used or selected for the current project. */
  profile?: PianistProfile | null;
  /** Current editor draft, which may differ from the last worker result. */
  draftFingeringPlan?: FingeringPlan | null;
  /** `recompute-required` prevents stale derived plans from being treated as valid. */
  plansState?: "valid" | "recompute-required";
  keyStyle?: M1KeyStyle;
  sourceDescriptor?: ResourceDescriptor;
  sourceContext?: ProjectSourceContext;
  /** Legacy v1 fields retained until those snapshots can be migrated or reviewed. */
  document?: SongDocument;
  fingeringPlan?: FingeringPlan | null;
  activeProfileId?: string;
  viewMode?: StudioView | "split";
  sceneView?: { dimension: "2d" | "3d"; cameraPreset: "concert" | "overhead" | "pov" | "side_arch" };
  practiceState?: PracticeState;
  recoveryCorruptReason?: string;
}

export type SessionSnapshotAssessment =
  | { status: "empty"; reasons: [] }
  | { status: "corrupt"; reasons: string[] }
  | { status: "incompatible"; snapshot: SessionSnapshot; reasons: string[]; plansNeedRecompute: true }
  | { status: "recompute-required"; snapshot: SessionSnapshot; reasons: string[]; plansNeedRecompute: true }
  | { status: "compatible"; snapshot: SessionSnapshot; reasons: []; plansNeedRecompute: false };

const SessionSnapshotBaseSchema = z.object({
  projectId: z.string().trim().min(1),
  projectName: z.string().trim().optional(),
  updatedAt: z.number().finite(),
  result: M1AnalyzeMidiResultSchema.nullable().optional(),
  rawMidiBytes: z.custom<ArrayBuffer | null>((value) => value === null || value instanceof ArrayBuffer).optional(),
  profile: PianistProfileSchema.nullable().optional(),
  draftFingeringPlan: FingeringPlanSchema.nullable().optional(),
  plansState: z.enum(["valid", "recompute-required"]).optional(),
  keyStyle: z.enum(["realistic", "equal"]).optional(),
  sourceDescriptor: ResourceDescriptorSchema.optional(),
  sourceContext: ProjectSourceContextSchema.optional(),
  document: SongDocumentSchema.optional(),
  fingeringPlan: FingeringPlanSchema.nullable().optional(),
  activeProfileId: z.string().optional(),
  viewMode: z.enum(["performance", "editor", "split", "play_along"]).optional(),
  sceneView: z.object({
    dimension: z.enum(["2d", "3d"]),
    cameraPreset: z.enum(["concert", "overhead", "pov", "side_arch"]),
  }).optional(),
  practiceState: PracticeStateSchema.optional(),
}).passthrough();

/**
 * Record saved to IndexedDB session store, keyed by `id`.
 */
interface PersistedSessionRecord extends SessionSnapshot {
  id: string;
}

/**
 * Persists an autosave recovery snapshot into IndexedDB.
 */
let sessionWriteQueue: Promise<void> = Promise.resolve();

/**
 * Serializes complete snapshots so a late write from the previous project can
 * never finish after and replace a newer current-session record.
 */
export function saveSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
  const write = sessionWriteQueue.then(() => writeSessionSnapshot(snapshot));
  sessionWriteQueue = write.catch(() => undefined);
  return write;
}

async function writeSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
  const validated = SessionSnapshotBaseSchema.parse(snapshot);
  const result = validated.result ?? null;
  const document = validated.document ?? result?.document;
  if (!document) throw new Error("A session snapshot needs an analysis result or a legacy document.");
  if (document.projectId !== validated.projectId) {
    throw new Error("Session document.projectId must match the session projectId.");
  }
  if (validated.profile && validated.activeProfileId &&
      validated.profile.profileId !== validated.activeProfileId) {
    throw new Error("Session profile.profileId must match activeProfileId.");
  }
  const workingPlan = validated.draftFingeringPlan ?? validated.fingeringPlan ?? result?.fingeringPlan ?? null;
  const resultDocumentJson = result?.document ? JSON.stringify(result.document) : null;
  const documentJson = document ? JSON.stringify(document) : null;
  const documentsDiffer = resultDocumentJson !== null && documentJson !== null && resultDocumentJson !== documentJson;
  if (workingPlan) {
    validateFingeringPlanReferences(workingPlan, document);
    if (workingPlan.projectId !== validated.projectId || workingPlan.inputRevision !== document.revision) {
      throw new Error("Session fingering plan must match the project ID and document revision.");
    }
  }
  if (result && (result.projectId !== validated.projectId || result.document?.projectId !== validated.projectId)) {
    throw new Error("Session analysis result must match the session project ID.");
  }
  if (result?.document && document && documentsDiffer &&
      validated.plansState === "valid") {
    throw new Error("An edited session document must mark plansState as recompute-required.");
  }
  if (result && validated.profile && (validated.profile.profileId !== result.profile.profileId ||
      validated.profile.revision !== result.profile.revision) && validated.plansState === "valid") {
    throw new Error("A changed session profile must mark derived plans for recomputation.");
  }
  if (result?.performancePlan) validatePerformancePlanReferences(result.performancePlan, result.document!);
  if (result && validated.sourceDescriptor &&
      JSON.stringify(validated.sourceDescriptor) !== JSON.stringify(result.resource)) {
    throw new Error("Session source descriptor must match the analyzed source resource.");
  }
  if (validated.practiceState) {
    const sourceResource = validated.sourceDescriptor ?? result?.resource;
    if (!sourceResource) {
      throw new Error("A session practice state requires a source MIDI resource descriptor.");
    }
    validatePracticeStateForProject(validated.practiceState, document, sourceResource);
  }
  let requiresRecompute = !result || !validated.rawMidiBytes || validated.rawMidiBytes.byteLength === 0;
  if (result?.document && document && documentsDiffer) requiresRecompute = true;
  if (result && workingPlan && JSON.stringify(workingPlan) !== JSON.stringify(result.fingeringPlan)) {
    requiresRecompute = true;
  }
  if (result && validated.profile && (validated.profile.profileId !== result.profile.profileId ||
      validated.profile.revision !== result.profile.revision)) {
    requiresRecompute = true;
  }
  let rawMidiHash: string | null = null;
  if (result && validated.rawMidiBytes) {
    rawMidiHash = await computeSha256Hex(validated.rawMidiBytes);
    if (result.resource.byteLength !== validated.rawMidiBytes.byteLength ||
        rawMidiHash !== result.resource.sha256) {
      throw new Error("Session source bytes do not match the analyzed source resource.");
    }
  }
  if (validated.sourceDescriptor && validated.rawMidiBytes &&
      (validated.sourceDescriptor.byteLength !== validated.rawMidiBytes.byteLength ||
       (rawMidiHash ?? await computeSha256Hex(validated.rawMidiBytes)) !== validated.sourceDescriptor.sha256)) {
    throw new Error("Session source bytes do not match the saved source descriptor.");
  }
  if (validated.plansState === "valid" && requiresRecompute) {
    throw new Error("A session with changed draft data or source bytes must mark plansState as recompute-required.");
  }
  const plansState = validated.plansState ?? (requiresRecompute ? "recompute-required" : "valid");
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

    const tx = db.transaction(SESSION_STORE, "readwrite");
    const store = tx.objectStore(SESSION_STORE);

    const record: PersistedSessionRecord = {
      ...validated,
      id: AUTOSAVE_SESSION_ID,
      projectId: validated.projectId,
      updatedAt: validated.updatedAt || Date.now(),
      result,
      rawMidiBytes: validated.rawMidiBytes ?? null,
      profile: validated.profile ?? result?.profile ?? null,
      draftFingeringPlan: validated.draftFingeringPlan ?? null,
      plansState,
      document,
      fingeringPlan: workingPlan,
      activeProfileId: validated.activeProfileId ?? validated.profile?.profileId ?? result?.profile.profileId,
      keyStyle: validated.keyStyle ?? "realistic",
      viewMode: validated.viewMode ?? "performance",
    };

    let request: IDBRequest;
    try {
      request = store.put(record);
    } catch (err) {
      safeReject(err, "Failed to save session snapshot");
      return;
    }

    request.onsuccess = () => undefined;

    request.onerror = () => {
      safeReject(request.error, "Failed to save session snapshot");
    };

    tx.onerror = () => {
      safeReject(tx.error, "Transaction failed while saving session snapshot");
    };

    tx.onabort = () => {
      safeReject(tx.error, "Transaction aborted while saving session snapshot");
    };
    tx.oncomplete = safeResolve;
  });
}

/**
 * Loads the autosave recovery snapshot from IndexedDB. Returns `null` if none exists.
 */
export async function loadSessionSnapshot(): Promise<SessionSnapshot | null> {
  const db = await openProjectDb();

  return new Promise<SessionSnapshot | null>((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readonly");
    const store = tx.objectStore(SESSION_STORE);
    const request = store.get(AUTOSAVE_SESSION_ID);

    request.onsuccess = () => {
      const raw = request.result as PersistedSessionRecord | undefined;
      if (!raw) {
        resolve(null);
        return;
      }
      const snapshot = { ...raw };
      Reflect.deleteProperty(snapshot, "id");
      resolve(snapshot);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to load session snapshot"));
    };

    tx.onerror = () => {
      reject(tx.error ?? new Error("Transaction failed while loading session snapshot"));
    };
  });
}

/**
 * Checks whether a loaded session is safe to resume with the current analysis runtime.
 * Older snapshots remain available in the result so callers can explain what recovery needs.
 */
export async function assessSessionSnapshot(
  input: unknown,
  engineVersion: string,
): Promise<SessionSnapshotAssessment> {
  if (input === null || input === undefined) return { status: "empty", reasons: [] };
  const parsed = SessionSnapshotBaseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "corrupt",
      reasons: parsed.error.issues.map((issue) => `${issue.path.join(".") || "snapshot"}: ${issue.message}`),
    };
  }
  const snapshot = parsed.data as SessionSnapshot;
  if (snapshot.recoveryCorruptReason) {
    return { status: "corrupt", reasons: [snapshot.recoveryCorruptReason] };
  }
  if (snapshot.practiceState) {
    const practiceDocument = snapshot.document ?? snapshot.result?.document;
    const sourceResource = snapshot.sourceDescriptor ?? snapshot.result?.resource;
    if (!practiceDocument || !sourceResource) {
      return { status: "corrupt", reasons: ["The saved practice state has no document or source MIDI resource."] };
    }
    try {
      validatePracticeStateForProject(snapshot.practiceState, practiceDocument, sourceResource);
    } catch (error) {
      return { status: "corrupt", reasons: [error instanceof Error ? error.message : String(error)] };
    }
  }
  const reasons: string[] = [];
  const result = snapshot.result ?? null;
  const sourceBytes = snapshot.rawMidiBytes instanceof ArrayBuffer ? snapshot.rawMidiBytes : null;
  const sourceAvailable = sourceBytes !== null && sourceBytes.byteLength > 0;
  const sourceHash = sourceBytes ? await computeSha256Hex(sourceBytes) : null;
  if (snapshot.document && snapshot.document.projectId !== snapshot.projectId) {
    return { status: "corrupt", reasons: ["The saved document does not belong to the saved project."] };
  }
  if (snapshot.profile && snapshot.activeProfileId && snapshot.profile.profileId !== snapshot.activeProfileId) {
    return { status: "corrupt", reasons: ["The saved profile does not match the active profile ID."] };
  }
  if (snapshot.sourceDescriptor && sourceBytes && sourceHash !== null) {
    if (sourceBytes.byteLength !== snapshot.sourceDescriptor.byteLength || sourceHash !== snapshot.sourceDescriptor.sha256) {
      return { status: "corrupt", reasons: ["The saved source bytes do not match their resource descriptor."] };
    }
  }
  if (!result) {
    const reason = sourceAvailable
      ? "This saved session has original bytes but no validated analysis baseline; re-import the MIDI to rebuild trusted note identities."
      : "This saved session has no full analysis result or original MIDI bytes and cannot be restored safely.";
    return { status: "incompatible", snapshot, reasons: [reason], plansNeedRecompute: true };
  } else if (!result.document) {
    return { status: "incompatible", snapshot, reasons: ["The saved analysis has no normalized document to restore."], plansNeedRecompute: true };
  } else {
    if (result.projectId !== snapshot.projectId || result.document.projectId !== snapshot.projectId) {
      return { status: "corrupt", reasons: ["The analysis result and document do not belong to the saved project."] };
    }
    if (result.engineVersion !== engineVersion) reasons.push("The analysis engine version changed; the saved source must be analyzed again.");
    if (sourceBytes && (sourceBytes.byteLength !== result.resource.byteLength || sourceHash !== result.resource.sha256)) {
      return { status: "corrupt", reasons: ["The original MIDI bytes do not match the analyzed source resource."] };
    }
    if (!sourceAvailable) {
      return { status: "incompatible", snapshot, reasons: ["The original MIDI bytes are missing, so the saved analysis cannot be restored coherently."], plansNeedRecompute: true };
    }
    if (snapshot.profile && (snapshot.profile.profileId !== result.profile.profileId ||
        snapshot.profile.revision !== result.profile.revision)) {
      reasons.push("The selected pianist profile changed after this analysis; derived plans must be recomputed.");
    }
    if (snapshot.sourceDescriptor && (snapshot.sourceDescriptor.resourceId !== result.resource.resourceId ||
        snapshot.sourceDescriptor.sha256 !== result.resource.sha256 ||
        snapshot.sourceDescriptor.byteLength !== result.resource.byteLength ||
        snapshot.sourceDescriptor.purpose !== result.resource.purpose ||
        snapshot.sourceDescriptor.mediaType !== result.resource.mediaType ||
        snapshot.sourceDescriptor.path !== result.resource.path)) {
      return { status: "corrupt", reasons: ["The saved source descriptor differs from the analyzed MIDI resource."] };
    }
    if (snapshot.plansState === "recompute-required") reasons.push("The saved fingering draft has pending edits or stale derived plans.");
  }
  const document = snapshot.document ?? result?.document;
  if (result?.document && document && JSON.stringify(result.document) !== JSON.stringify(document)) {
    reasons.push("The saved document or fingering draft differs from the last applied analysis and must be recomputed.");
  }
  const draftPlan = snapshot.draftFingeringPlan ?? snapshot.fingeringPlan ?? null;
  if (draftPlan && document) {
    try {
      validateFingeringPlanReferences(draftPlan, document);
      if (draftPlan.projectId !== snapshot.projectId || draftPlan.inputRevision !== document.revision) {
        return { status: "corrupt", reasons: ["The saved fingering draft does not match the saved document revision."] };
      }
      if (result && (draftPlan.engineVersion !== result.engineVersion || draftPlan.profileId !== result.profile.profileId ||
          draftPlan.profileRevision !== result.profile.revision)) {
        reasons.push("The saved fingering draft uses a different engine or profile revision and must be recomputed.");
      }
    } catch (error) {
      return { status: "corrupt", reasons: [error instanceof Error ? error.message : String(error)] };
    }
  }
  if (reasons.length > 0) return { status: "recompute-required", snapshot, reasons, plansNeedRecompute: true };
  if (!result) return { status: "recompute-required", snapshot, reasons: ["The saved session is missing its full analysis result."], plansNeedRecompute: true };
  try {
    if (result.fingeringPlan) validateFingeringPlanReferences(result.fingeringPlan, result.document!);
    if (result.performancePlan) validatePerformancePlanReferences(result.performancePlan, result.document!);
  } catch (error) {
    return { status: "corrupt", reasons: [error instanceof Error ? error.message : String(error)] };
  }
  if (snapshot.plansState === "recompute-required") {
    return { status: "recompute-required", snapshot, reasons: ["The saved fingering draft has pending edits or stale derived plans."], plansNeedRecompute: true };
  }
  return { status: "compatible", snapshot, reasons: [], plansNeedRecompute: false };
}

/**
 * Clears the active autosave session snapshot from IndexedDB.
 */
export async function clearSessionSnapshot(): Promise<void> {
  const db = await openProjectDb();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readwrite");
    const store = tx.objectStore(SESSION_STORE);
    const request = store.delete(AUTOSAVE_SESSION_ID);

    request.onsuccess = () => undefined;

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to clear session snapshot"));
    };

    tx.onerror = () => {
      reject(tx.error ?? new Error("Transaction failed while clearing session snapshot"));
    };
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted while clearing session snapshot"));
    tx.oncomplete = () => resolve();
  });
}

/**
 * Deletes the recovery snapshot only when its projectId still matches. The
 * read and delete run in one readwrite transaction, so a snapshot for another
 * project written between an earlier read and this call is preserved.
 */
export async function clearSessionSnapshotIfProject(projectId: string): Promise<boolean> {
  const db = await openProjectDb();

  return new Promise<boolean>((resolve, reject) => {
    let deleted = false;
    let settled = false;
    const finish = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const tx = db.transaction(SESSION_STORE, "readwrite");
    const store = tx.objectStore(SESSION_STORE);
    const read = store.get(AUTOSAVE_SESSION_ID);

    read.onsuccess = () => {
      const raw = read.result as PersistedSessionRecord | undefined;
      if (!raw || raw.projectId !== projectId) return;
      const deletion = store.delete(AUTOSAVE_SESSION_ID);
      deletion.onsuccess = () => { deleted = true; };
      deletion.onerror = () => fail(deletion.error ?? new Error("Failed to clear session snapshot"));
    };
    read.onerror = () => fail(read.error ?? new Error("Failed to read session snapshot"));

    tx.onerror = () => fail(tx.error ?? new Error("Transaction failed while clearing session snapshot"));
    tx.onabort = () => fail(tx.error ?? new Error("Transaction aborted while clearing session snapshot"));
    tx.oncomplete = () => finish(deleted);
  });
}

export interface StorageQuotaInfo {
  usageBytes: number;
  quotaBytes: number;
  percentUsed: number;
}

/**
 * Estimates available and used storage quota in bytes and percentage.
 * Uses `navigator.storage.estimate()` if supported; returns `null` otherwise.
 */
export async function getStorageQuota(): Promise<StorageQuotaInfo | null> {
  if (
    typeof navigator !== "undefined" &&
    navigator.storage &&
    typeof navigator.storage.estimate === "function"
  ) {
    try {
      const estimate = await navigator.storage.estimate();
      const usageBytes = estimate.usage ?? 0;
      const quotaBytes = estimate.quota ?? 0;
      const percentUsed = quotaBytes > 0 ? (usageBytes / quotaBytes) * 100 : 0;
      return {
        usageBytes,
        quotaBytes,
        percentUsed: Math.min(100, Math.max(0, percentUsed)),
      };
    } catch {
      return null;
    }
  }
  return null;
}

export interface AutosaveServiceOptions {
  delayMs?: number;
  onError?: (error: Error) => void;
  onSaved?: (snapshot: SessionSnapshot) => void;
}

/**
 * Debounced background autosave manager.
 * Batches rapid document or playback state mutations to prevent write amplification.
 */
export class AutosaveService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSnapshot: SessionSnapshot | null = null;
  private isSaving = false;
  private savingPromise: Promise<void> | null = null;
  private lastSaveError: Error | null = null;
  private readonly blockedProjects = new Set<string>();
  private readonly delayMs: number;
  private readonly onError?: (error: Error) => void;
  private readonly onSaved?: (snapshot: SessionSnapshot) => void;

  constructor(options: AutosaveServiceOptions = {}) {
    this.delayMs = options.delayMs ?? 1000;
    this.onError = options.onError;
    this.onSaved = options.onSaved;
  }

  /**
   * Schedules a snapshot to be saved after the configured debounce interval.
   */
  schedule(snapshot: SessionSnapshot): void {
    if (this.blockedProjects.has(snapshot.projectId)) return;
    this.pendingSnapshot = snapshot;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.delayMs);
  }

  /**
   * Immediately flushes any pending autosave snapshot.
   */
  async flush(options: { throwOnError?: boolean } = {}): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.pendingSnapshot || this.savingPromise) {
      if (this.savingPromise) {
        const inFlight = this.savingPromise;
        await inFlight;
        if (this.savingPromise === inFlight) this.savingPromise = null;
      }
      if (this.pendingSnapshot && !this.savingPromise) {
        const snapshotToSave = this.pendingSnapshot;
        this.pendingSnapshot = null;
        if (this.blockedProjects.has(snapshotToSave.projectId)) continue;
        this.isSaving = true;
        this.savingPromise = this.saveAndNotify(snapshotToSave);
      }
    }
    if (options.throwOnError && this.lastSaveError) throw this.lastSaveError;
  }

  private async saveAndNotify(snapshot: SessionSnapshot): Promise<void> {
    try {
      await saveSessionSnapshot(snapshot);
      this.lastSaveError = null;
      this.onSaved?.(snapshot);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.lastSaveError = error;
      if (this.onError) {
        this.onError(error);
      } else {
        console.warn("AutosaveService: Failed to save snapshot:", error);
      }
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Cancels any pending scheduled autosave.
   */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingSnapshot = null;
  }

  /**
   * Returns true if an autosave is scheduled or currently in progress.
   */
  isPending(): boolean {
    return this.timer !== null || this.pendingSnapshot !== null || this.isSaving || this.savingPromise !== null;
  }

  /**
   * Returns the currently pending snapshot, if any.
   */
  getPendingSnapshot(): SessionSnapshot | null {
    return this.pendingSnapshot;
  }

  /**
   * Loads the current session snapshot from persistence.
   */
  load(): Promise<SessionSnapshot | null> {
    return loadSessionSnapshot();
  }

  /**
   * Blocks future autosaves for a deleted project and removes its recovery
   * snapshot atomically. An in-flight save for the same project is allowed to
   * finish first so the conditional delete definitely sees it; snapshots for
   * other projects remain untouched.
   */
  async clearProjectRecovery(projectId: string): Promise<boolean> {
    this.blockedProjects.add(projectId);
    if (this.pendingSnapshot?.projectId === projectId) {
      this.pendingSnapshot = null;
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
    while (this.savingPromise) {
      const inFlight = this.savingPromise;
      await inFlight;
      if (this.savingPromise === inFlight) this.savingPromise = null;
    }
    return clearSessionSnapshotIfProject(projectId);
  }

  /** Allows autosave again after a deleted project is explicitly saved anew. */
  allowProject(projectId: string): void {
    this.blockedProjects.delete(projectId);
  }

  /**
   * Cancels pending operations and clears the persisted session snapshot.
   */
  clear(): Promise<void> {
    this.cancel();
    this.blockedProjects.clear();
    return clearSessionSnapshot();
  }
}

/**
 * Creates an AutosaveService instance with optional configuration.
 */
export function createAutosaveService(options?: AutosaveServiceOptions): AutosaveService {
  return new AutosaveService(options);
}

/**
 * Flush a pending autosave when the page is hidden or unloaded. The async
 * IndexedDB commit cannot be guaranteed during teardown, but this closes the
 * normal debounce window; errors are reported by the service's onError.
 */
export function registerAutosaveFlush(
  service: Pick<AutosaveService, "flush">,
  windowTarget: EventTarget,
  documentTarget: EventTarget & { visibilityState: DocumentVisibilityState },
): () => void {
  const flush = () => {
    void service.flush().catch(() => {
      // onError reports persistence failures; teardown cannot surface them.
    });
  };
  const onVisibilityChange = () => {
    if (documentTarget.visibilityState === "hidden") flush();
  };
  windowTarget.addEventListener("pagehide", flush);
  documentTarget.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    windowTarget.removeEventListener("pagehide", flush);
    documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
