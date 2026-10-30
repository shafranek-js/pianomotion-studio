/**
 * Independent, immutable IndexedDB snapshots for the experimental rigged hand
 * Pose Mode. These presets describe local runtime transforms; they do not
 * modify a GLB, a user profile, or the Testing2 rig data.
 */

export const RIGGED_HAND_POSE_PRESET_FORMAT = "handthesia.rigged-hand-pose-preset" as const;
export const RIGGED_HAND_POSE_PRESET_VERSION = 1 as const;
export const RIGGED_HAND_POSE_SCHEMA_VERSION = 1 as const;
export const RIGGED_HAND_POSE_PRESET_DB_NAME = "pianomotion-rigged-hand-poses";
export const RIGGED_HAND_POSE_PRESET_DB_VERSION = 1;
export const RIGGED_HAND_POSE_PRESET_STORE_NAME = "presets";
export const RIGGED_HAND_POSE_PRESET_MAX_JSON_LENGTH = 256 * 1024;
export const RIGGED_HAND_POSE_PRESET_IDB_OPEN_BLOCKED_TIMEOUT_MS = 5_000;

export type RiggedHandPoseSide = "left" | "right";
export type RiggedHandPoseVector3 = readonly [number, number, number];
export type RiggedHandPoseQuaternion = readonly [number, number, number, number];

/** Exact runtime bone IDs, in stable diagnostic order and without side prefix. */
export const RIGGED_HAND_POSE_BONE_IDS = [
  "thumb_segment0_cmc-to-mcp", "thumb_segment1_mcp-to-ip", "thumb_distal-segment-a", "thumb_distal-segment-b",
  "index_metacarpal", "index_proximal", "index_intermediate", "index_distal",
  "middle_metacarpal", "middle_proximal", "middle_intermediate", "middle_distal",
  "ring_metacarpal", "ring_proximal", "ring_intermediate", "ring_distal",
  "little_metacarpal", "little_proximal", "little_intermediate", "little_distal",
  "forearm", "palm",
] as const;

export interface RiggedHandPoseBone {
  /** Exact GLB/runtime bone name, including `left_` or `right_`. */
  name: string;
  /** Bone-local position captured from the runtime. */
  position: RiggedHandPoseVector3;
  /** Normalized bone-local quaternion captured from the runtime. */
  quaternion: RiggedHandPoseQuaternion;
}

export interface RiggedExperimentalHandPose {
  schemaVersion: typeof RIGGED_HAND_POSE_SCHEMA_VERSION;
  side: RiggedHandPoseSide;
  /** Local transform of the runtime hand group. */
  group: {
    position: RiggedHandPoseVector3;
    quaternion: RiggedHandPoseQuaternion;
    scale: RiggedHandPoseVector3;
  };
  bones: readonly RiggedHandPoseBone[];
}

export interface RiggedHandPosePreset {
  format: typeof RIGGED_HAND_POSE_PRESET_FORMAT;
  version: typeof RIGGED_HAND_POSE_PRESET_VERSION;
  presetId: string;
  name: string;
  createdAtUnixMs: number;
  /** SHA-256 of the exact source GLB loaded for each hand; never nullable. */
  sourceGlbSha256: Record<RiggedHandPoseSide, string>;
  /** Optional editor context; omitted when the source editor does not provide it. */
  editorProvenance?: RiggedHandPoseEditorProvenance;
  hands: Record<RiggedHandPoseSide, RiggedExperimentalHandPose>;
}

export interface RiggedHandPoseEditorProvenance {
  displayedTransportTimeSeconds?: number;
  sourcePoseTimeSeconds?: Partial<Record<RiggedHandPoseSide, number>>;
  /** Editor-provided zero-based index; numbering is preserved as supplied. */
  positionIndex?: number;
  positionLabel?: string;
}

export type RiggedHandPosePresetDraft = Omit<RiggedHandPosePreset, "format" | "version">;
export type RiggedHandPoseSourceHashes = Record<RiggedHandPoseSide, string>;

export type RiggedHandPosePresetErrorCode =
  | "invalid-record"
  | "unsupported-format"
  | "unsupported-version"
  | "invalid-preset-id"
  | "invalid-name"
  | "invalid-timestamp"
  | "invalid-source-hash"
  | "invalid-editor-provenance"
  | "source-asset-unverified"
  | "source-asset-mismatch"
  | "invalid-pose"
  | "invalid-hand-side"
  | "invalid-group-transform"
  | "invalid-bone-list"
  | "invalid-bone-name"
  | "duplicate-bone"
  | "missing-bone"
  | "invalid-vector"
  | "invalid-quaternion"
  | "invalid-json"
  | "json-too-large"
  | "storage-unavailable"
  | "storage-open-failed"
  | "storage-blocked"
  | "storage-transaction-failed"
  | "preset-id-conflict"
  | "preset-id-mismatch"
  | "preset-name-conflict"
  | "preset-not-found";

export class RiggedHandPosePresetError extends Error {
  readonly code: RiggedHandPosePresetErrorCode;
  readonly cause?: unknown;

  constructor(code: RiggedHandPosePresetErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "RiggedHandPosePresetError";
    this.code = code;
    this.cause = cause;
  }
}

type UnknownRecord = Record<string, unknown>;
const SIDE_SET = new Set<RiggedHandPoseSide>(["left", "right"]);
const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_NAME_LENGTH = 120;
const MAX_TIMESTAMP_UNIX_MS = 8.64e15;
const QUATERNION_NORM_TOLERANCE = 1e-4;
const IDB_OPEN_BLOCKED_MESSAGE = "Opening rigged hand pose preset storage is blocked by another tab or connection. Close other tabs and retry.";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: UnknownRecord, expected: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !expected.includes(key));
  if (unexpected.length > 0) {
    throw new RiggedHandPosePresetError("invalid-record", `${label} contains unsupported field(s): ${unexpected.join(", ")}.`);
  }
}

function validateSide(value: unknown): RiggedHandPoseSide {
  if (typeof value !== "string" || !SIDE_SET.has(value as RiggedHandPoseSide)) {
    throw new RiggedHandPosePresetError("invalid-hand-side", "Hand side must be left or right.");
  }
  return value as RiggedHandPoseSide;
}

function validatePresetId(value: unknown): string {
  if (typeof value !== "string" || !PRESET_ID_PATTERN.test(value)) {
    throw new RiggedHandPosePresetError("invalid-preset-id", "Preset ID must be 1–120 safe letters, digits, dots, underscores, colons, or hyphens.");
  }
  return value;
}

function validateName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > MAX_NAME_LENGTH || value !== value.trim()) {
    throw new RiggedHandPosePresetError("invalid-name", `Preset name must be trimmed and contain 1–${MAX_NAME_LENGTH} characters.`);
  }
  return value;
}

function validateTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_UNIX_MS) {
    throw new RiggedHandPosePresetError("invalid-timestamp", "Preset creation time must be a safe non-negative Unix timestamp in milliseconds.");
  }
  return value;
}

function validateSourceHash(value: unknown, side: RiggedHandPoseSide): string {
  if (value === null || value === undefined || value === "") {
    throw new RiggedHandPosePresetError("source-asset-unverified", `The ${side} GLB SHA-256 is unavailable; an unverified pose cannot be saved or applied.`);
  }
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new RiggedHandPosePresetError("invalid-source-hash", `The ${side} GLB SHA-256 must contain exactly 64 hexadecimal characters.`);
  }
  return value.toLowerCase();
}

function validateSourceHashes(value: unknown, label: string): RiggedHandPoseSourceHashes {
  if (!isRecord(value)) {
    throw new RiggedHandPosePresetError("invalid-source-hash", `${label} must contain both hand GLB SHA-256 values.`);
  }
  assertExactKeys(value, ["left", "right"], label);
  return {
    left: validateSourceHash(value.left, "left"),
    right: validateSourceHash(value.right, "right"),
  };
}

function validateEditorProvenance(value: unknown): RiggedHandPoseEditorProvenance | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new RiggedHandPosePresetError("invalid-editor-provenance", "Editor provenance must be an object when supplied.");
  }
  assertExactKeys(value, ["displayedTransportTimeSeconds", "sourcePoseTimeSeconds", "positionIndex", "positionLabel"], "Editor provenance");

  const result: RiggedHandPoseEditorProvenance = {};
  const validateFiniteTime = (time: unknown, label: string): number => {
    if (typeof time !== "number" || !Number.isFinite(time)) {
      throw new RiggedHandPosePresetError("invalid-editor-provenance", `${label} must be a finite number.`);
    }
    return time;
  };
  if (value.displayedTransportTimeSeconds !== undefined) {
    result.displayedTransportTimeSeconds = validateFiniteTime(value.displayedTransportTimeSeconds, "Displayed transport time");
  }
  if (value.sourcePoseTimeSeconds !== undefined) {
    if (!isRecord(value.sourcePoseTimeSeconds)) {
      throw new RiggedHandPosePresetError("invalid-editor-provenance", "Source pose times must be keyed by hand side.");
    }
    assertExactKeys(value.sourcePoseTimeSeconds, ["left", "right"], "Source pose times");
    const sourcePoseTimeSeconds: Partial<Record<RiggedHandPoseSide, number>> = {};
    for (const side of ["left", "right"] as const) {
      if (value.sourcePoseTimeSeconds[side] !== undefined) {
        sourcePoseTimeSeconds[side] = validateFiniteTime(value.sourcePoseTimeSeconds[side], `${side} source pose time`);
      }
    }
    if (Object.keys(sourcePoseTimeSeconds).length > 0) result.sourcePoseTimeSeconds = sourcePoseTimeSeconds;
  }
  if (value.positionIndex !== undefined) {
    if (typeof value.positionIndex !== "number" || !Number.isSafeInteger(value.positionIndex) || value.positionIndex < 0) {
      throw new RiggedHandPosePresetError("invalid-editor-provenance", "Position index must be a safe non-negative zero-based integer.");
    }
    result.positionIndex = value.positionIndex;
  }
  if (value.positionLabel !== undefined) {
    if (typeof value.positionLabel !== "string" || value.positionLabel.length === 0 || value.positionLabel.trim() !== value.positionLabel || value.positionLabel.length > MAX_NAME_LENGTH) {
      throw new RiggedHandPosePresetError("invalid-editor-provenance", `Position label must be trimmed and contain 1–${MAX_NAME_LENGTH} characters.`);
    }
    result.positionLabel = value.positionLabel;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function validateVector3(value: unknown, label: string): RiggedHandPoseVector3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new RiggedHandPosePresetError("invalid-vector", `${label} must be a finite three-number vector.`);
  }
  const components: number[] = [];
  for (let index = 0; index < 3; index++) {
    const component: unknown = value[index];
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new RiggedHandPosePresetError("invalid-vector", `${label} must be a finite three-number vector.`);
    }
    components.push(component);
  }
  return components as unknown as RiggedHandPoseVector3;
}

function validateQuaternion(value: unknown, label: string): RiggedHandPoseQuaternion {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new RiggedHandPosePresetError("invalid-quaternion", `${label} must be a finite four-number quaternion.`);
  }
  const components: number[] = [];
  for (let index = 0; index < 4; index++) {
    const component: unknown = value[index];
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new RiggedHandPosePresetError("invalid-quaternion", `${label} must be a finite four-number quaternion.`);
    }
    components.push(component);
  }
  const quaternion = components as unknown as RiggedHandPoseQuaternion;
  const norm = Math.hypot(...quaternion);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > QUATERNION_NORM_TOLERANCE) {
    throw new RiggedHandPosePresetError("invalid-quaternion", `${label} must be normalized within ${QUATERNION_NORM_TOLERANCE}.`);
  }
  return quaternion;
}

function validateGroupTransform(value: unknown): RiggedExperimentalHandPose["group"] {
  if (!isRecord(value)) {
    throw new RiggedHandPosePresetError("invalid-group-transform", "Hand group transform must be an object.");
  }
  assertExactKeys(value, ["position", "quaternion", "scale"], "Hand group transform");
  const scale = validateVector3(value.scale, "Hand group scale");
  if (scale.some((component) => component <= 0)) {
    throw new RiggedHandPosePresetError("invalid-group-transform", "Hand group scale components must be positive.");
  }
  return {
    position: validateVector3(value.position, "Hand group position"),
    quaternion: validateQuaternion(value.quaternion, "Hand group quaternion"),
    scale,
  };
}

function validateBone(value: unknown, expectedSide: RiggedHandPoseSide): RiggedHandPoseBone {
  if (!isRecord(value)) {
    throw new RiggedHandPosePresetError("invalid-bone-list", "Each hand bone must be an object.");
  }
  assertExactKeys(value, ["name", "position", "quaternion"], "Hand bone");
  const expectedPrefix = `${expectedSide}_`;
  if (typeof value.name !== "string" || !value.name.startsWith(expectedPrefix)) {
    throw new RiggedHandPosePresetError("invalid-bone-name", `Bone names for the ${expectedSide} hand must use the exact ${expectedPrefix} prefix.`);
  }
  const suffix = value.name.slice(expectedPrefix.length);
  if (!(RIGGED_HAND_POSE_BONE_IDS as readonly string[]).includes(suffix)) {
    throw new RiggedHandPosePresetError("invalid-bone-name", `Unknown ${expectedSide} hand bone name: ${value.name}.`);
  }
  return {
    name: value.name,
    position: validateVector3(value.position, `${value.name} position`),
    quaternion: validateQuaternion(value.quaternion, `${value.name} quaternion`),
  };
}

/** Validates and returns a deep canonical copy of one runtime hand snapshot. */
export function validateRiggedExperimentalHandPose(input: unknown, expectedSide?: RiggedHandPoseSide): RiggedExperimentalHandPose {
  if (!isRecord(input)) {
    throw new RiggedHandPosePresetError("invalid-pose", "Hand pose must be an object.");
  }
  assertExactKeys(input, ["schemaVersion", "side", "group", "bones"], "Hand pose");
  if (input.schemaVersion !== RIGGED_HAND_POSE_SCHEMA_VERSION) {
    throw new RiggedHandPosePresetError("unsupported-version", `Unsupported hand pose schema version: ${String(input.schemaVersion)}.`);
  }
  const side = validateSide(input.side);
  if (expectedSide !== undefined && side !== expectedSide) {
    throw new RiggedHandPosePresetError("invalid-hand-side", `Expected the ${expectedSide} hand pose but received ${side}.`);
  }
  if (!Array.isArray(input.bones) || input.bones.length !== RIGGED_HAND_POSE_BONE_IDS.length) {
    throw new RiggedHandPosePresetError("invalid-bone-list", `The ${side} hand must contain exactly ${RIGGED_HAND_POSE_BONE_IDS.length} runtime bones.`);
  }

  const bonesByName = new Map<string, RiggedHandPoseBone>();
  for (const boneInput of input.bones) {
    const bone = validateBone(boneInput, side);
    if (bonesByName.has(bone.name)) {
      throw new RiggedHandPosePresetError("duplicate-bone", `The ${side} hand contains duplicate bone ${bone.name}.`);
    }
    bonesByName.set(bone.name, bone);
  }
  const bones = RIGGED_HAND_POSE_BONE_IDS.map((boneId) => {
    const name = `${side}_${boneId}`;
    const bone = bonesByName.get(name);
    if (!bone) throw new RiggedHandPosePresetError("missing-bone", `The ${side} hand is missing runtime bone ${name}.`);
    return bone;
  });

  return {
    schemaVersion: RIGGED_HAND_POSE_SCHEMA_VERSION,
    side,
    group: validateGroupTransform(input.group),
    bones,
  };
}

const EXPECTED_PRESET_KEYS = ["format", "version", "presetId", "name", "createdAtUnixMs", "sourceGlbSha256", "editorProvenance", "hands"] as const;

/** Validates the complete immutable, two-hand preset and optionally checks loaded source GLBs. */
export function validateRiggedHandPosePreset(
  input: unknown,
  expectedSourceGlbSha256?: RiggedHandPoseSourceHashes,
): RiggedHandPosePreset {
  if (!isRecord(input)) {
    throw new RiggedHandPosePresetError("invalid-record", "Rigged hand pose preset must be an object.");
  }
  assertExactKeys(input, EXPECTED_PRESET_KEYS, "Rigged hand pose preset");
  if (input.format !== RIGGED_HAND_POSE_PRESET_FORMAT) {
    throw new RiggedHandPosePresetError("unsupported-format", "Rigged hand pose preset has an unsupported format identifier.");
  }
  if (input.version !== RIGGED_HAND_POSE_PRESET_VERSION) {
    throw new RiggedHandPosePresetError("unsupported-version", `Unsupported rigged hand pose preset version: ${String(input.version)}.`);
  }

  const presetId = validatePresetId(input.presetId);
  const name = validateName(input.name);
  const createdAtUnixMs = validateTimestamp(input.createdAtUnixMs);
  const sourceGlbSha256 = validateSourceHashes(input.sourceGlbSha256, "Source GLB hashes");
  const editorProvenance = validateEditorProvenance(input.editorProvenance);
  if (expectedSourceGlbSha256 !== undefined) {
    const expected = validateSourceHashes(expectedSourceGlbSha256, "Expected source GLB hashes");
    for (const side of ["left", "right"] as const) {
      if (sourceGlbSha256[side] !== expected[side]) {
        throw new RiggedHandPosePresetError("source-asset-mismatch", `The saved ${side} hand pose belongs to a different source GLB.`);
      }
    }
  }
  if (!isRecord(input.hands)) {
    throw new RiggedHandPosePresetError("invalid-pose", "Preset hands must contain both left and right runtime snapshots.");
  }
  assertExactKeys(input.hands, ["left", "right"], "Preset hands");

  return {
    format: RIGGED_HAND_POSE_PRESET_FORMAT,
    version: RIGGED_HAND_POSE_PRESET_VERSION,
    presetId,
    name,
    createdAtUnixMs,
    sourceGlbSha256,
    ...(editorProvenance === undefined ? {} : { editorProvenance }),
    hands: {
      left: validateRiggedExperimentalHandPose(input.hands.left, "left"),
      right: validateRiggedExperimentalHandPose(input.hands.right, "right"),
    },
  };
}

/** Creates a canonical preset from two runtime snapshots. */
export function createRiggedHandPosePreset(draft: RiggedHandPosePresetDraft): RiggedHandPosePreset {
  return validateRiggedHandPosePreset({
    format: RIGGED_HAND_POSE_PRESET_FORMAT,
    version: RIGGED_HAND_POSE_PRESET_VERSION,
    ...draft,
  });
}

/** Serializes only a validated canonical pose preset. */
export function exportRiggedHandPosePresetJson(input: unknown): string {
  return JSON.stringify(validateRiggedHandPosePreset(input), null, 2);
}

/** Parses and validates imported JSON, optionally binding it to currently loaded GLBs. */
export function importRiggedHandPosePresetJson(
  json: string,
  expectedSourceGlbSha256?: RiggedHandPoseSourceHashes,
): RiggedHandPosePreset {
  if (typeof json !== "string") {
    throw new RiggedHandPosePresetError("invalid-json", "Rigged hand pose preset import must be JSON text.");
  }
  if (json.length > RIGGED_HAND_POSE_PRESET_MAX_JSON_LENGTH) {
    throw new RiggedHandPosePresetError("json-too-large", `Rigged hand pose preset JSON exceeds ${RIGGED_HAND_POSE_PRESET_MAX_JSON_LENGTH} characters.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new RiggedHandPosePresetError("invalid-json", "Rigged hand pose preset JSON could not be parsed.", error);
  }
  return validateRiggedHandPosePreset(parsed, expectedSourceGlbSha256);
}

let cachedDatabase: IDBDatabase | null = null;
let openingDatabase: Promise<IDBDatabase> | null = null;

function getIndexedDbFactory(): IDBFactory {
  try {
    if (typeof indexedDB !== "undefined") return indexedDB;
  } catch (error) {
    throw new RiggedHandPosePresetError("storage-unavailable", "IndexedDB is unavailable for rigged hand pose presets.", error);
  }
  throw new RiggedHandPosePresetError("storage-unavailable", "IndexedDB is unavailable for rigged hand pose presets.");
}

function openRiggedHandPosePresetDb(): Promise<IDBDatabase> {
  if (cachedDatabase) return Promise.resolve(cachedDatabase);
  if (openingDatabase) return openingDatabase;

  let factory: IDBFactory;
  try {
    factory = getIndexedDbFactory();
  } catch (error) {
    return Promise.reject(error);
  }

  let request: IDBOpenDBRequest;
  try {
    request = factory.open(RIGGED_HAND_POSE_PRESET_DB_NAME, RIGGED_HAND_POSE_PRESET_DB_VERSION);
  } catch (error) {
    return Promise.reject(new RiggedHandPosePresetError("storage-open-failed", "Could not open rigged hand pose preset storage.", error));
  }

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;
    const clearBlockedTimer = () => {
      if (blockedTimer !== null) {
        clearTimeout(blockedTimer);
        blockedTimer = null;
      }
    };
    const fail = (code: "storage-open-failed" | "storage-blocked", message: string, cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearBlockedTimer();
      reject(new RiggedHandPosePresetError(code, message, cause));
    };

    request.onupgradeneeded = () => {
      try {
        const db = request.result;
        if (!db.objectStoreNames.contains(RIGGED_HAND_POSE_PRESET_STORE_NAME)) {
          db.createObjectStore(RIGGED_HAND_POSE_PRESET_STORE_NAME, { keyPath: "presetId" });
        }
      } catch (error) {
        fail("storage-open-failed", "Could not create the isolated rigged hand pose preset store.", error);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        try { db.close(); } catch { /* A late connection must not be cached after a blocked timeout. */ }
        return;
      }
      if (!db.objectStoreNames.contains(RIGGED_HAND_POSE_PRESET_STORE_NAME)) {
        try { db.close(); } catch { /* Ignore cleanup errors. */ }
        fail("storage-open-failed", "Rigged hand pose preset database is missing its isolated store.");
        return;
      }
      settled = true;
      clearBlockedTimer();
      cachedDatabase = db;
      const clearConnection = () => {
        try { db.close(); } catch { /* Ignore close errors. */ }
        if (cachedDatabase === db) cachedDatabase = null;
        if (openingDatabase === promise) openingDatabase = null;
      };
      db.onversionchange = clearConnection;
      db.onclose = clearConnection;
      resolve(db);
    };
    request.onerror = () => {
      fail("storage-open-failed", "Could not open rigged hand pose preset storage.", request.error);
    };
    request.onblocked = () => {
      if (settled || blockedTimer !== null) return;
      blockedTimer = setTimeout(() => {
        blockedTimer = null;
        fail("storage-blocked", IDB_OPEN_BLOCKED_MESSAGE);
      }, RIGGED_HAND_POSE_PRESET_IDB_OPEN_BLOCKED_TIMEOUT_MS);
    };
  });

  openingDatabase = promise;
  void promise.then(
    () => { if (openingDatabase === promise) openingDatabase = null; },
    () => { if (openingDatabase === promise) openingDatabase = null; },
  );
  return promise;
}

/** Closes only the independent rigged hand pose preset database connection. */
export function closeRiggedHandPosePresetStorage(): void {
  const db = cachedDatabase;
  cachedDatabase = null;
  openingDatabase = null;
  if (db) {
    try { db.close(); } catch { /* Ignore close errors. */ }
  }
}

function storageFailure(cause: unknown): RiggedHandPosePresetError {
  if (cause instanceof RiggedHandPosePresetError) return cause;
  return new RiggedHandPosePresetError("storage-transaction-failed", "Rigged hand pose preset storage operation failed.", cause);
}

function transactionError(transaction: IDBTransaction, request?: IDBRequest): RiggedHandPosePresetError {
  const cause = request?.error ?? transaction.error;
  if (cause?.name === "ConstraintError") {
    return new RiggedHandPosePresetError("preset-id-conflict", "A rigged hand pose preset with this presetId already exists. Use the explicit replace operation to update it.", cause);
  }
  return storageFailure(cause ?? new Error("IndexedDB transaction aborted."));
}

function normalizePresetName(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

function validateStoredPresets(value: unknown): RiggedHandPosePreset[] {
  if (!Array.isArray(value)) {
    throw new RiggedHandPosePresetError("invalid-record", "Rigged hand pose preset store returned a non-array result.");
  }
  return value.map((record: unknown) => validateRiggedHandPosePreset(record));
}

type PresetWriteMode = { kind: "create" } | { kind: "replace"; presetId: string };

async function writeRiggedHandPosePreset(preset: RiggedHandPosePreset, mode: PresetWriteMode): Promise<RiggedHandPosePreset> {
  const db = await openRiggedHandPosePresetDb();
  return new Promise<RiggedHandPosePreset>((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest;
    let operationError: RiggedHandPosePresetError | null = null;
    let nameConflict: RiggedHandPosePresetError | null = null;
    try {
      transaction = db.transaction(RIGGED_HAND_POSE_PRESET_STORE_NAME, "readwrite");
      const store = transaction.objectStore(RIGGED_HAND_POSE_PRESET_STORE_NAME);
      request = store.getAll();

      request.onsuccess = () => {
        try {
          const existing = validateStoredPresets(request.result);
          if (mode.kind === "create") {
            if (existing.some((candidate) => normalizePresetName(candidate.name) === normalizePresetName(preset.name))) {
              nameConflict = new RiggedHandPosePresetError("preset-name-conflict", `A rigged hand pose preset named “${preset.name}” already exists.`);
              return;
            }
            request = store.add(preset);
            return;
          }

          const current = existing.find((candidate) => candidate.presetId === mode.presetId);
          if (!current) {
            operationError = new RiggedHandPosePresetError("preset-not-found", `Rigged hand pose preset ${mode.presetId} no longer exists.`);
            transaction.abort();
            return;
          }
          if (normalizePresetName(current.name) !== normalizePresetName(preset.name)
            && existing.some((candidate) => candidate.presetId !== mode.presetId
              && normalizePresetName(candidate.name) === normalizePresetName(preset.name))) {
            nameConflict = new RiggedHandPosePresetError("preset-name-conflict", `A rigged hand pose preset named “${preset.name}” already exists.`);
            return;
          }
          request = store.put(preset);
        } catch (error) {
          operationError = storageFailure(error);
          try { transaction.abort(); } catch { /* The transaction may already have ended. */ }
        }
      };
    } catch (error) {
      reject(storageFailure(error));
      return;
    }
    transaction.oncomplete = () => {
      if (operationError) reject(operationError);
      else if (nameConflict) reject(nameConflict);
      else resolve(preset);
    };
    transaction.onabort = () => reject(operationError ?? transactionError(transaction, request));
    transaction.onerror = () => { /* The abort handler carries the request-level cause. */ };
  });
}

/** Adds a new preset atomically; IDs and normalized names already in storage are never overwritten. */
export async function saveRiggedHandPosePreset(input: unknown): Promise<RiggedHandPosePreset> {
  return writeRiggedHandPosePreset(validateRiggedHandPosePreset(input), { kind: "create" });
}

/** Explicitly replaces an existing preset while preserving its selected ID. */
export async function replaceRiggedHandPosePreset(presetId: string, input: unknown): Promise<RiggedHandPosePreset> {
  const id = validateRequestedPresetId(presetId);
  const preset = validateRiggedHandPosePreset(input);
  if (preset.presetId !== id) {
    throw new RiggedHandPosePresetError("preset-id-mismatch", "The replacement presetId must match the selected existing presetId.");
  }
  return writeRiggedHandPosePreset(preset, { kind: "replace", presetId: id });
}

/** Deletes exactly one selected preset, failing when that ID is no longer present. */
export async function deleteRiggedHandPosePreset(presetId: string): Promise<void> {
  const id = validateRequestedPresetId(presetId);
  const db = await openRiggedHandPosePresetDb();
  return new Promise<void>((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest;
    let operationError: RiggedHandPosePresetError | null = null;
    try {
      transaction = db.transaction(RIGGED_HAND_POSE_PRESET_STORE_NAME, "readwrite");
      const store = transaction.objectStore(RIGGED_HAND_POSE_PRESET_STORE_NAME);
      request = store.get(id);
      request.onsuccess = () => {
        if (request.result === undefined) {
          operationError = new RiggedHandPosePresetError("preset-not-found", `Rigged hand pose preset ${id} no longer exists.`);
          return;
        }
        try {
          request = store.delete(id);
        } catch (error) {
          operationError = storageFailure(error);
          try { transaction.abort(); } catch { /* The transaction may already have ended. */ }
        }
      };
    } catch (error) {
      reject(storageFailure(error));
      return;
    }
    transaction.oncomplete = () => {
      if (operationError) reject(operationError);
      else resolve();
    };
    transaction.onabort = () => reject(operationError ?? transactionError(transaction, request));
    transaction.onerror = () => { /* The abort handler carries the request-level cause. */ };
  });
}

function validateRequestedPresetId(presetId: string): string {
  return validatePresetId(presetId);
}

/** Loads a preset only when both exact source GLB hashes match the current rigs. */
export async function loadRiggedHandPosePreset(
  presetId: string,
  expectedSourceGlbSha256: RiggedHandPoseSourceHashes,
): Promise<RiggedHandPosePreset | null> {
  const id = validateRequestedPresetId(presetId);
  const expected = validateSourceHashes(expectedSourceGlbSha256, "Expected source GLB hashes");
  const db = await openRiggedHandPosePresetDb();
  return new Promise<RiggedHandPosePreset | null>((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest;
    try {
      transaction = db.transaction(RIGGED_HAND_POSE_PRESET_STORE_NAME, "readonly");
      request = transaction.objectStore(RIGGED_HAND_POSE_PRESET_STORE_NAME).get(id);
    } catch (error) {
      reject(storageFailure(error));
      return;
    }
    let result: RiggedHandPosePreset | null = null;
    request.onsuccess = () => {
      if (request.result !== undefined) {
        try {
          result = validateRiggedHandPosePreset(request.result, expected);
        } catch (error) {
          reject(error);
        }
      }
    };
    request.onerror = () => reject(storageFailure(request.error));
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transactionError(transaction, request));
  });
}

/** Lists presets newest first; optionally rejects records for different GLBs. */
export async function listRiggedHandPosePresets(
  expectedSourceGlbSha256?: RiggedHandPoseSourceHashes,
): Promise<RiggedHandPosePreset[]> {
  const expected = expectedSourceGlbSha256 === undefined
    ? undefined
    : validateSourceHashes(expectedSourceGlbSha256, "Expected source GLB hashes");
  const db = await openRiggedHandPosePresetDb();
  return new Promise<RiggedHandPosePreset[]>((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest;
    try {
      transaction = db.transaction(RIGGED_HAND_POSE_PRESET_STORE_NAME, "readonly");
      request = transaction.objectStore(RIGGED_HAND_POSE_PRESET_STORE_NAME).getAll();
    } catch (error) {
      reject(storageFailure(error));
      return;
    }
    let result: RiggedHandPosePreset[] = [];
    request.onsuccess = () => {
      try {
        if (!Array.isArray(request.result)) {
          throw new RiggedHandPosePresetError("invalid-record", "Rigged hand pose preset store returned a non-array result.");
        }
        result = request.result.map((record: unknown) => validateRiggedHandPosePreset(record, expected));
        result.sort((a, b) => b.createdAtUnixMs - a.createdAtUnixMs || a.presetId.localeCompare(b.presetId));
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = () => reject(storageFailure(request.error));
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transactionError(transaction, request));
  });
}
