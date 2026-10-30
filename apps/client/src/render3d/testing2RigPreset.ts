import {
  IMPROVED_HAND_JOINT_NAMES,
  validateImprovedHandManifest,
  type ImprovedHandManifest,
  type ImprovedHandSide,
} from "./improvedHandAssets";

export const TESTING2_RIG_PRESET_FORMAT = "handthesia.testing2-rig-preset" as const;
export const TESTING2_RIG_PRESET_VERSION = 1 as const;
export const TESTING2_RIG_PRESET_DB_NAME = "pianomotion-testing2-rigs";
export const TESTING2_RIG_PRESET_DB_VERSION = 1;
export const TESTING2_RIG_PRESET_STORE_NAME = "presets";
export const TESTING2_RIG_PRESET_MAX_ABS_COORDINATE_METERS = 2;
export const TESTING2_RIG_PRESET_MAX_JSON_LENGTH = 64 * 1024;
export const TESTING2_RIG_PRESET_IDB_OPEN_BLOCKED_TIMEOUT_MS = 5_000;

export const TESTING2_RIG_PRESET_JOINT_NAMES = IMPROVED_HAND_JOINT_NAMES;
export type Testing2RigPresetJointName = typeof TESTING2_RIG_PRESET_JOINT_NAMES[number];

export interface Testing2RigPresetSourceAsset {
  modelId: "anatomical-improved";
  manifestSchemaVersion: 1;
  uri: string;
  sha256: string;
  vertices: number;
  triangles: number;
  /** SHA-256 of the exact packaged bind/rest LOD0 GLB bytes for each side. */
  handLod0Sha256: Record<ImprovedHandSide, string>;
}

export interface Testing2RigPresetJointPosition {
  name: Testing2RigPresetJointName;
  positionMeters: readonly [number, number, number];
}

export type Testing2RigPresetHandPositions = readonly Testing2RigPresetJointPosition[];

export interface Testing2RigPreset {
  format: typeof TESTING2_RIG_PRESET_FORMAT;
  version: typeof TESTING2_RIG_PRESET_VERSION;
  presetId: string;
  name: string;
  createdAtUnixMs: number;
  sourceAsset: Testing2RigPresetSourceAsset;
  coordinateFrame: {
    unit: "meters";
    handedness: "right";
    pose: "bind";
  };
  hands: Record<ImprovedHandSide, Testing2RigPresetHandPositions>;
}

export interface Testing2RigPresetDraft {
  presetId: string;
  name: string;
  createdAtUnixMs: number;
  sourceAsset: Testing2RigPresetSourceAsset;
  hands: Record<ImprovedHandSide, Testing2RigPresetHandPositions>;
}

export type Testing2RigPresetErrorCode =
  | "invalid-record"
  | "unsupported-format"
  | "unsupported-version"
  | "invalid-preset-id"
  | "invalid-name"
  | "invalid-timestamp"
  | "invalid-source-asset"
  | "source-asset-unverified"
  | "source-asset-mismatch"
  | "invalid-coordinate-frame"
  | "invalid-hand-positions"
  | "missing-joint"
  | "duplicate-joint"
  | "unknown-joint"
  | "invalid-position"
  | "position-out-of-bounds"
  | "invalid-json"
  | "json-too-large"
  | "storage-unavailable"
  | "storage-open-failed"
  | "storage-blocked"
  | "storage-transaction-failed"
  | "preset-id-conflict";

export class Testing2RigPresetError extends Error {
  readonly code: Testing2RigPresetErrorCode;
  readonly cause?: unknown;

  constructor(code: Testing2RigPresetErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "Testing2RigPresetError";
    this.code = code;
    this.cause = cause;
  }
}

const EXPECTED_PRESET_KEYS = [
  "format", "version", "presetId", "name", "createdAtUnixMs", "sourceAsset", "coordinateFrame", "hands",
] as const;
const EXPECTED_SOURCE_ASSET_KEYS = ["modelId", "manifestSchemaVersion", "uri", "sha256", "vertices", "triangles", "handLod0Sha256"] as const;
const EXPECTED_COORDINATE_FRAME_KEYS = ["unit", "handedness", "pose"] as const;
const EXPECTED_JOINT_POSITION_KEYS = ["name", "positionMeters"] as const;
const JOINT_NAME_SET = new Set<string>(TESTING2_RIG_PRESET_JOINT_NAMES);
const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_NAME_LENGTH = 120;
const MAX_SOURCE_URI_LENGTH = 256;
const MAX_TIMESTAMP_UNIX_MS = 8.64e15;
const IDB_OPEN_BLOCKED_MESSAGE = "Opening Testing2 rig preset storage is blocked by another tab or connection. Close other tabs and retry.";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: UnknownRecord, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  const unexpected = keys.filter((key) => !expected.includes(key));
  if (unexpected.length > 0) {
    throw new Testing2RigPresetError("invalid-record", `${label} contains unsupported field(s): ${unexpected.join(", ")}.`);
  }
}

function validatePresetId(value: unknown): string {
  if (typeof value !== "string" || !PRESET_ID_PATTERN.test(value)) {
    throw new Testing2RigPresetError("invalid-preset-id", "Preset ID must be 1–120 safe letters, digits, dots, underscores, colons, or hyphens.");
  }
  return value;
}

function validateSourceAsset(value: unknown): Testing2RigPresetSourceAsset {
  if (!isRecord(value)) {
    throw new Testing2RigPresetError("invalid-source-asset", "Source asset identity must be an object.");
  }
  assertExactKeys(value, EXPECTED_SOURCE_ASSET_KEYS, "Source asset identity");
  if (value.modelId !== "anatomical-improved" || value.manifestSchemaVersion !== 1) {
    throw new Testing2RigPresetError("invalid-source-asset", "Source asset identity must name anatomical-improved manifest schema version 1.");
  }
  if (typeof value.uri !== "string" || !value.uri.trim() || value.uri.length > MAX_SOURCE_URI_LENGTH || /[\\/:]/.test(value.uri)) {
    throw new Testing2RigPresetError("invalid-source-asset", "Source asset URI must be a non-empty manifest source filename without slashes or a scheme.");
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256)) {
    throw new Testing2RigPresetError("invalid-source-asset", "Source asset SHA-256 must contain exactly 64 hexadecimal characters.");
  }
  if (!Number.isInteger(value.vertices) || (value.vertices as number) < 1 || (value.vertices as number) > 10_000_000 ||
      !Number.isInteger(value.triangles) || (value.triangles as number) < 1 || (value.triangles as number) > 20_000_000) {
    throw new Testing2RigPresetError("invalid-source-asset", "Source asset vertex and triangle counts are outside the supported manifest bounds.");
  }
  if (!isRecord(value.handLod0Sha256)) {
    throw new Testing2RigPresetError("source-asset-unverified", "Source identity requires content SHA-256 hashes for both packaged hand LOD0 assets.");
  }
  assertExactKeys(value.handLod0Sha256, ["left", "right"], "Hand LOD0 content hashes");
  const leftHash = value.handLod0Sha256.left;
  const rightHash = value.handLod0Sha256.right;
  if (typeof leftHash !== "string" || !/^[a-f0-9]{64}$/i.test(leftHash) ||
      typeof rightHash !== "string" || !/^[a-f0-9]{64}$/i.test(rightHash)) {
    throw new Testing2RigPresetError("source-asset-unverified", "Source identity requires valid SHA-256 hashes for both left and right packaged hand LOD0 assets.");
  }
  return {
    modelId: "anatomical-improved",
    manifestSchemaVersion: 1,
    uri: value.uri,
    sha256: value.sha256.toLowerCase(),
    vertices: value.vertices as number,
    triangles: value.triangles as number,
    handLod0Sha256: { left: leftHash.toLowerCase(), right: rightHash.toLowerCase() },
  };
}

async function sha256Hex(buffer: ArrayBuffer, hand: ImprovedHandSide): Promise<string> {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
    throw new Testing2RigPresetError("source-asset-unverified", `The loaded ${hand} LOD0 asset must have non-empty ArrayBuffer content.`);
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") {
    throw new Testing2RigPresetError("source-asset-unverified", "Web Crypto SHA-256 is unavailable; the Testing2 rig preset source identity cannot be verified.");
  }
  try {
    const digest = await subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    throw new Testing2RigPresetError("source-asset-unverified", `Could not hash the loaded ${hand} LOD0 asset.`, error);
  }
}

/** Extracts manifest identity and hashes both exact packaged LOD0 GLB buffers. */
export function testing2RigPresetSourceAssetFromManifest(
  input: ImprovedHandManifest | unknown,
  lod0Buffers: Record<ImprovedHandSide, ArrayBuffer>,
): Promise<Testing2RigPresetSourceAsset> {
  const manifest = validateImprovedHandManifest(input);
  return Promise.all([
    sha256Hex(lod0Buffers.left, "left"),
    sha256Hex(lod0Buffers.right, "right"),
  ]).then(([left, right]) => validateSourceAsset({
    modelId: manifest.modelId,
    manifestSchemaVersion: manifest.schemaVersion,
    uri: manifest.source.uri,
    sha256: manifest.source.sha256,
    vertices: manifest.source.vertices,
    triangles: manifest.source.triangles,
    handLod0Sha256: { left, right },
  }));
}

function sameSourceAsset(a: Testing2RigPresetSourceAsset, b: Testing2RigPresetSourceAsset): boolean {
  return a.modelId === b.modelId && a.manifestSchemaVersion === b.manifestSchemaVersion &&
    a.uri === b.uri && a.sha256 === b.sha256 && a.vertices === b.vertices && a.triangles === b.triangles &&
    a.handLod0Sha256.left === b.handLod0Sha256.left && a.handLod0Sha256.right === b.handLod0Sha256.right;
}

function validateHandPositions(value: unknown, hand: ImprovedHandSide): Testing2RigPresetHandPositions {
  if (!Array.isArray(value) || value.length !== TESTING2_RIG_PRESET_JOINT_NAMES.length) {
    throw new Testing2RigPresetError(
      "invalid-hand-positions",
      `The ${hand} hand must contain exactly ${TESTING2_RIG_PRESET_JOINT_NAMES.length} named bind joint positions.`,
    );
  }

  const seen = new Set<string>();
  const points: Testing2RigPresetJointPosition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index];
    if (!isRecord(entry)) {
      throw new Testing2RigPresetError("invalid-position", `The ${hand} joint at index ${index} must be a named position object.`);
    }
    assertExactKeys(entry, EXPECTED_JOINT_POSITION_KEYS, `The ${hand} joint at index ${index}`);
    if (typeof entry.name !== "string" || !JOINT_NAME_SET.has(entry.name)) {
      throw new Testing2RigPresetError("unknown-joint", `The ${hand} hand contains an unrecognized joint name at index ${index}.`);
    }
    if (seen.has(entry.name)) {
      throw new Testing2RigPresetError("duplicate-joint", `The ${hand} hand contains joint '${entry.name}' more than once.`);
    }
    seen.add(entry.name);
    const positionMeters = entry.positionMeters;
    if (!Array.isArray(positionMeters) || positionMeters.length !== 3 ||
        [0, 1, 2].some((componentIndex) => {
          const component: unknown = positionMeters[componentIndex];
          return typeof component !== "number" || !Number.isFinite(component);
        })) {
      throw new Testing2RigPresetError("invalid-position", `Joint '${entry.name}' for the ${hand} hand must have three finite meter coordinates.`);
    }
    const [x, y, z] = positionMeters as number[];
    for (const [axis, component] of [["x", x], ["y", y], ["z", z]] as const) {
      if (Math.abs(component) > TESTING2_RIG_PRESET_MAX_ABS_COORDINATE_METERS) {
        throw new Testing2RigPresetError(
          "position-out-of-bounds",
          `Joint '${entry.name}' for the ${hand} hand has ${axis}=${component} m outside ±${TESTING2_RIG_PRESET_MAX_ABS_COORDINATE_METERS} m.`,
        );
      }
    }
    points.push({
      name: entry.name as Testing2RigPresetJointName,
      positionMeters: [x!, y!, z!].map((component) => Object.is(component, -0) ? 0 : component) as [number, number, number],
    });
  }

  const missing = TESTING2_RIG_PRESET_JOINT_NAMES.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Testing2RigPresetError("missing-joint", `The ${hand} hand is missing required joint(s): ${missing.join(", ")}.`);
  }
  points.sort((a, b) => TESTING2_RIG_PRESET_JOINT_NAMES.indexOf(a.name) - TESTING2_RIG_PRESET_JOINT_NAMES.indexOf(b.name));
  return points;
}

/** Validates and returns a canonical copy. Pass an expected source identity to reject presets for another asset. */
export function validateTesting2RigPreset(
  input: unknown,
  expectedSourceAsset?: Testing2RigPresetSourceAsset,
): Testing2RigPreset {
  if (!isRecord(input)) {
    throw new Testing2RigPresetError("invalid-record", "Testing2 rig preset must be a JSON object.");
  }
  assertExactKeys(input, EXPECTED_PRESET_KEYS, "Testing2 rig preset");
  if (input.format !== TESTING2_RIG_PRESET_FORMAT) {
    throw new Testing2RigPresetError("unsupported-format", `Expected format '${TESTING2_RIG_PRESET_FORMAT}'.`);
  }
  if (input.version !== TESTING2_RIG_PRESET_VERSION) {
    throw new Testing2RigPresetError("unsupported-version", `Preset version ${String(input.version)} is unsupported; expected ${TESTING2_RIG_PRESET_VERSION}.`);
  }

  const presetId = validatePresetId(input.presetId);
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > MAX_NAME_LENGTH) {
    throw new Testing2RigPresetError("invalid-name", `Preset name must contain 1–${MAX_NAME_LENGTH} non-whitespace characters.`);
  }
  if (typeof input.createdAtUnixMs !== "number" || !Number.isSafeInteger(input.createdAtUnixMs) ||
      input.createdAtUnixMs < 0 || input.createdAtUnixMs > MAX_TIMESTAMP_UNIX_MS) {
    throw new Testing2RigPresetError("invalid-timestamp", "Preset creation time must be a non-negative safe Unix-millisecond timestamp within Date bounds.");
  }

  const sourceAsset = validateSourceAsset(input.sourceAsset);
  if (expectedSourceAsset && !sameSourceAsset(sourceAsset, validateSourceAsset(expectedSourceAsset))) {
    throw new Testing2RigPresetError("source-asset-mismatch", "Preset source asset identity does not match the currently loaded Testing2 asset.");
  }

  if (!isRecord(input.coordinateFrame)) {
    throw new Testing2RigPresetError("invalid-coordinate-frame", "Preset coordinate frame must be an object.");
  }
  assertExactKeys(input.coordinateFrame, EXPECTED_COORDINATE_FRAME_KEYS, "Preset coordinate frame");
  if (input.coordinateFrame.unit !== "meters" || input.coordinateFrame.handedness !== "right" || input.coordinateFrame.pose !== "bind") {
    throw new Testing2RigPresetError("invalid-coordinate-frame", "Preset coordinates must use the right-handed bind frame in meters.");
  }

  if (!isRecord(input.hands)) {
    throw new Testing2RigPresetError("invalid-hand-positions", "Preset must contain both left and right hands.");
  }
  assertExactKeys(input.hands, ["left", "right"], "Preset hands");
  if (!Object.hasOwn(input.hands, "left") || !Object.hasOwn(input.hands, "right")) {
    throw new Testing2RigPresetError("invalid-hand-positions", "Preset must contain both left and right hands.");
  }

  return {
    format: TESTING2_RIG_PRESET_FORMAT,
    version: TESTING2_RIG_PRESET_VERSION,
    presetId,
    name: input.name.trim(),
    createdAtUnixMs: input.createdAtUnixMs,
    sourceAsset,
    coordinateFrame: { unit: "meters", handedness: "right", pose: "bind" },
    hands: {
      left: validateHandPositions(input.hands.left, "left"),
      right: validateHandPositions(input.hands.right, "right"),
    },
  };
}

/** Creates a versioned independent rig-preset DTO without reading or modifying profile state. */
export function createTesting2RigPreset(draft: Testing2RigPresetDraft): Testing2RigPreset {
  return validateTesting2RigPreset({
    format: TESTING2_RIG_PRESET_FORMAT,
    version: TESTING2_RIG_PRESET_VERSION,
    presetId: draft.presetId,
    name: draft.name,
    createdAtUnixMs: draft.createdAtUnixMs,
    sourceAsset: draft.sourceAsset,
    coordinateFrame: { unit: "meters", handedness: "right", pose: "bind" },
    hands: draft.hands,
  });
}

/** Serializes only a validated canonical preset. */
export function exportTesting2RigPresetJson(input: unknown): string {
  return JSON.stringify(validateTesting2RigPreset(input), null, 2);
}

/** Parses and validates an imported JSON document against the currently loaded source asset identity. */
export function importTesting2RigPresetJson(
  json: string,
  expectedSourceAsset: Testing2RigPresetSourceAsset,
): Testing2RigPreset {
  if (typeof json !== "string") {
    throw new Testing2RigPresetError("invalid-json", "Testing2 rig preset import must be JSON text.");
  }
  if (json.length > TESTING2_RIG_PRESET_MAX_JSON_LENGTH) {
    throw new Testing2RigPresetError("json-too-large", `Testing2 rig preset JSON exceeds ${TESTING2_RIG_PRESET_MAX_JSON_LENGTH} characters.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Testing2RigPresetError("invalid-json", "Testing2 rig preset JSON could not be parsed.", error);
  }
  return validateTesting2RigPreset(parsed, expectedSourceAsset);
}

let cachedDatabase: IDBDatabase | null = null;
let openingDatabase: Promise<IDBDatabase> | null = null;

function getIndexedDbFactory(): IDBFactory {
  try {
    if (typeof indexedDB !== "undefined") return indexedDB;
  } catch (error) {
    throw new Testing2RigPresetError("storage-unavailable", "IndexedDB is unavailable for Testing2 rig presets.", error);
  }
  throw new Testing2RigPresetError("storage-unavailable", "IndexedDB is unavailable for Testing2 rig presets.");
}

function openTesting2RigPresetDb(): Promise<IDBDatabase> {
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
    request = factory.open(TESTING2_RIG_PRESET_DB_NAME, TESTING2_RIG_PRESET_DB_VERSION);
  } catch (error) {
    return Promise.reject(new Testing2RigPresetError("storage-open-failed", "Could not open Testing2 rig preset storage.", error));
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
      reject(new Testing2RigPresetError(code, message, cause));
    };

    request.onupgradeneeded = () => {
      try {
        const db = request.result;
        if (!db.objectStoreNames.contains(TESTING2_RIG_PRESET_STORE_NAME)) {
          db.createObjectStore(TESTING2_RIG_PRESET_STORE_NAME, { keyPath: "presetId" });
        }
      } catch (error) {
        fail("storage-open-failed", "Could not create the isolated Testing2 rig preset store.", error);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        try { db.close(); } catch { /* A late connection must not be cached after a blocked timeout. */ }
        return;
      }
      if (!db.objectStoreNames.contains(TESTING2_RIG_PRESET_STORE_NAME)) {
        try { db.close(); } catch { /* Ignore cleanup errors. */ }
        fail("storage-open-failed", "Testing2 rig preset database is missing its isolated preset store.");
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
      fail("storage-open-failed", "Could not open Testing2 rig preset storage.", request.error);
    };
    request.onblocked = () => {
      if (settled || blockedTimer !== null) return;
      blockedTimer = setTimeout(() => {
        blockedTimer = null;
        fail("storage-blocked", IDB_OPEN_BLOCKED_MESSAGE);
      }, TESTING2_RIG_PRESET_IDB_OPEN_BLOCKED_TIMEOUT_MS);
    };
  });

  openingDatabase = promise;
  void promise.then(
    () => { if (openingDatabase === promise) openingDatabase = null; },
    () => { if (openingDatabase === promise) openingDatabase = null; },
  );
  return promise;
}

/** Closes only the separate Testing2 rig-preset database connection. */
export function closeTesting2RigPresetStorage(): void {
  const db = cachedDatabase;
  cachedDatabase = null;
  openingDatabase = null;
  if (db) {
    try { db.close(); } catch { /* Ignore close errors. */ }
  }
}

function storageFailure(cause: unknown): Testing2RigPresetError {
  if (cause instanceof Testing2RigPresetError) return cause;
  return new Testing2RigPresetError("storage-transaction-failed", "Testing2 rig preset storage operation failed.", cause);
}

function transactionError(transaction: IDBTransaction, request?: IDBRequest): Testing2RigPresetError {
  const cause = request?.error ?? transaction.error;
  if (cause?.name === "ConstraintError") {
    return new Testing2RigPresetError("preset-id-conflict", "A Testing2 rig preset with this presetId already exists. Saved presets are immutable; choose a different presetId.", cause);
  }
  return storageFailure(cause ?? new Error("IndexedDB transaction aborted."));
}

/** Adds a new preset atomically; duplicate IDs fail instead of overwriting an existing preset. */
export async function saveTesting2RigPreset(input: unknown): Promise<Testing2RigPreset> {
  const preset = validateTesting2RigPreset(input);
  const db = await openTesting2RigPresetDb();
  return new Promise<Testing2RigPreset>((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest<IDBValidKey>;
    try {
      transaction = db.transaction(TESTING2_RIG_PRESET_STORE_NAME, "readwrite");
      request = transaction.objectStore(TESTING2_RIG_PRESET_STORE_NAME).add(preset);
    } catch (error) {
      reject(storageFailure(error));
      return;
    }
    transaction.oncomplete = () => resolve(preset);
    transaction.onabort = () => reject(transactionError(transaction, request));
    transaction.onerror = () => { /* The abort handler carries the request-level cause. */ };
  });
}

function validateRequestedPresetId(presetId: string): string {
  return validatePresetId(presetId);
}

/** Reads an immutable preset by ID; an optional expected asset identity guards later use. */
export async function getTesting2RigPreset(
  presetId: string,
  expectedSourceAsset?: Testing2RigPresetSourceAsset,
): Promise<Testing2RigPreset | null> {
  const id = validateRequestedPresetId(presetId);
  const db = await openTesting2RigPresetDb();
  return new Promise<Testing2RigPreset | null>((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest;
    try {
      transaction = db.transaction(TESTING2_RIG_PRESET_STORE_NAME, "readonly");
      request = transaction.objectStore(TESTING2_RIG_PRESET_STORE_NAME).get(id);
    } catch (error) {
      reject(storageFailure(error));
      return;
    }
    let result: Testing2RigPreset | null = null;
    request.onsuccess = () => {
      if (request.result !== undefined) {
        try {
          result = validateTesting2RigPreset(request.result, expectedSourceAsset);
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

/** Lists isolated presets in creation-time order, rejecting corrupted or incompatible records. */
export async function listTesting2RigPresets(
  expectedSourceAsset?: Testing2RigPresetSourceAsset,
): Promise<Testing2RigPreset[]> {
  const db = await openTesting2RigPresetDb();
  return new Promise<Testing2RigPreset[]>((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest;
    try {
      transaction = db.transaction(TESTING2_RIG_PRESET_STORE_NAME, "readonly");
      request = transaction.objectStore(TESTING2_RIG_PRESET_STORE_NAME).getAll();
    } catch (error) {
      reject(storageFailure(error));
      return;
    }
    let result: Testing2RigPreset[] = [];
    request.onsuccess = () => {
      try {
        if (!Array.isArray(request.result)) {
          throw new Testing2RigPresetError("invalid-record", "Testing2 preset store returned a non-array result.");
        }
        result = request.result.map((record: unknown) => validateTesting2RigPreset(record, expectedSourceAsset));
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
