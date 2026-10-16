import { releaseAssetUrl } from "../pwa/urls";

export interface BuiltinMelodyEntry {
  id: string;
  title: string;
  fileName: string;
  assetPath: string;
  sha256: string;
  byteLength: number;
}

interface BuiltinMelodyManifest {
  schemaVersion: 1;
  entries: BuiltinMelodyEntry[];
}

const MANIFEST_PATH = "builtin-melodies/manifest.json";
const SAFE_ASSET_PATH = /^files\/([a-f0-9]{64})\.mid$/;
const SHA256 = /^[a-f0-9]{64}$/;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function makeAbortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) return true;
  }
  return false;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isSafeSourceFileName(fileName: string): boolean {
  return fileName.length > 0 && !fileName.startsWith("/") && !fileName.includes("\\") &&
    !containsControlCharacter(fileName) &&
    fileName.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    /\.(?:mid|midi)$/i.test(fileName);
}

function titleFromFileName(fileName: string): string {
  const leaf = fileName.slice(fileName.lastIndexOf("/") + 1);
  return leaf.replace(/\.(?:mid|midi)$/i, "");
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 verification is unavailable in this browser.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectedId(fileName: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(fileName));
}

function assertMinimalMidiHeader(bytes: ArrayBuffer): void {
  const data = new DataView(bytes);
  const readAscii = (offset: number, count: number) => {
    let result = "";
    for (let index = 0; index < count; index += 1) result += String.fromCharCode(data.getUint8(offset + index));
    return result;
  };
  if (bytes.byteLength < 22 || readAscii(0, 4) !== "MThd") {
    throw new Error("The downloaded built-in melody does not have a valid MIDI header.");
  }
  const headerLength = data.getUint32(4, false);
  if (headerLength < 6 || 8 + headerLength + 8 > bytes.byteLength) {
    throw new Error("The downloaded built-in melody has a truncated MIDI header.");
  }
  if (data.getUint16(8, false) > 2 || data.getUint16(10, false) < 1 || data.getUint16(12, false) === 0) {
    throw new Error("The downloaded built-in melody has invalid MIDI header fields.");
  }
  const trackOffset = 8 + headerLength;
  if (readAscii(trackOffset, 4) !== "MTrk" || data.getUint32(trackOffset + 4, false) > bytes.byteLength - trackOffset - 8) {
    throw new Error("The downloaded built-in melody has an invalid MIDI track chunk.");
  }
}

async function validateEntry(value: unknown): Promise<BuiltinMelodyEntry> {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "title", "fileName", "assetPath", "sha256", "byteLength"])) {
    throw new Error("The built-in melody catalog contains an entry with an invalid shape.");
  }
  const { id, title, fileName, assetPath, sha256, byteLength } = value;
  if (typeof id !== "string" || !SHA256.test(id) || typeof title !== "string" || !title ||
      typeof fileName !== "string" || !isSafeSourceFileName(fileName) || title !== titleFromFileName(fileName) ||
      typeof assetPath !== "string" || !SAFE_ASSET_PATH.test(assetPath) ||
      typeof sha256 !== "string" || !SHA256.test(sha256) || assetPath !== `files/${sha256}.mid` ||
      !Number.isSafeInteger(byteLength) || (byteLength as number) < 22) {
    throw new Error("The built-in melody catalog contains invalid entry metadata.");
  }
  const hashOfName = await expectedId(fileName);
  if (id !== hashOfName) throw new Error("The built-in melody catalog entry ID does not match its source filename.");
  return { id, title, fileName, assetPath, sha256, byteLength: byteLength as number };
}

function compareEntries(left: BuiltinMelodyEntry, right: BuiltinMelodyEntry): number {
  return compareText(left.title, right.title) || compareText(left.fileName, right.fileName);
}

async function validateManifest(value: unknown): Promise<BuiltinMelodyManifest> {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "entries"]) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new Error("The built-in melody catalog manifest has an invalid shape.");
  }
  const entries = await Promise.all(value.entries.map((entry) => validateEntry(entry)));
  const ids = new Set<string>();
  const fileNames = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (ids.has(entry.id) || fileNames.has(entry.fileName.toLowerCase())) {
      throw new Error("The built-in melody catalog contains duplicate entry identifiers or source paths.");
    }
    ids.add(entry.id);
    fileNames.add(entry.fileName.toLowerCase());
    if (index > 0 && compareEntries(entries[index - 1], entry) > 0) {
      throw new Error("The built-in melody catalog entries are not in deterministic order.");
    }
  }
  return { schemaVersion: 1, entries };
}

async function fetchChecked(url: URL, context: string, signal?: AbortSignal): Promise<Response> {
  checkAbort(signal);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`${context} returned HTTP ${response.status}.`);
    return response;
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Loads the built-in melody list and validates its stable metadata. */
export async function loadBuiltinMelodies(signal?: AbortSignal): Promise<BuiltinMelodyEntry[]> {
  const url = releaseAssetUrl(MANIFEST_PATH);
  let response: Response;
  try {
    response = await fetchChecked(url, "Failed to load the built-in melody catalog manifest", signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`Could not load built-in melodies: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let value: unknown;
  try {
    value = await response.json() as unknown;
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error("Could not load built-in melodies: the catalog manifest is not valid JSON.", { cause: error });
  }
  try {
    const entries = (await validateManifest(value)).entries;
    registerBuiltinMelodyEntries(entries);
    return entries;
  } catch (error) {
    throw new Error(`Could not load built-in melodies: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Downloads one catalog MIDI file and confirms its exact size, header and digest. */
export async function loadBuiltinMelodyBytes(entry: BuiltinMelodyEntry, signal?: AbortSignal): Promise<ArrayBuffer> {
  checkAbort(signal);
  let safeEntry: BuiltinMelodyEntry;
  try {
    safeEntry = await validateEntry(entry);
  } catch (error) {
    throw new Error(`Could not load built-in melody: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  registerBuiltinMelodyEntries([safeEntry]);

  const url = releaseAssetUrl(`builtin-melodies/${safeEntry.assetPath}`);
  const response = await fetchChecked(url, `Failed to load built-in melody “${safeEntry.title}”`, signal).catch((error: unknown) => {
    if (isAbortError(error)) throw error;
    throw new Error(`Could not load built-in melody “${safeEntry.title}”: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  });
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`Could not load built-in melody “${safeEntry.title}”: the MIDI response could not be read.`, { cause: error });
  }
  checkAbort(signal);
  if (bytes.byteLength !== safeEntry.byteLength) {
    throw new Error(`Could not load built-in melody “${safeEntry.title}”: downloaded size does not match the catalog.`);
  }
  try {
    assertMinimalMidiHeader(bytes);
    const digest = await sha256Hex(bytes);
    checkAbort(signal);
    if (digest !== safeEntry.sha256) throw new Error("the SHA-256 checksum does not match the catalog");
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`Could not load built-in melody “${safeEntry.title}”: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return bytes;
}

const catalogEntriesById = new Map<string, BuiltinMelodyEntry>();

export function registerBuiltinMelodyEntries(entries: readonly BuiltinMelodyEntry[]): void {
  for (const entry of entries) {
    catalogEntriesById.set(entry.id.toLowerCase(), entry);
  }
}

export function lookupBuiltinMelody(idOrFixtureId: string): BuiltinMelodyEntry | undefined {
  const rawId = (idOrFixtureId.startsWith("builtin-") ? idOrFixtureId.slice(8) : idOrFixtureId).toLowerCase();
  return catalogEntriesById.get(rawId);
}

/**
 * Formats a project name or source identity for human-readable display.
 * Resolves internal built-in IDs (e.g. `builtin-cc34d9...`) into a friendly title
 * with a short identifier (e.g. `Ode to Joy (#cc34d9)`), avoiding raw 64-char hex dumps.
 * Also limits long titles with clean ellipsis.
 */
export function formatDisplaySourceName(name: string, fixtureId?: string, maxLength = 36): string {
  const raw = (name || "").trim();
  if (!raw && !fixtureId) return "No project";

  // Check if candidate or fixtureId is a builtin melody: builtin-<sha256>
  const builtinMatch = raw.match(/^builtin-([a-f0-9]{8,64})$/i) ??
    (fixtureId ? fixtureId.match(/^builtin-([a-f0-9]{8,64})$/i) : null);

  if (builtinMatch) {
    const rawId = builtinMatch[1].toLowerCase();
    const shortId = rawId.slice(0, 6);
    const entry = lookupBuiltinMelody(rawId);
    const baseTitle = entry?.title ?? ((!raw.startsWith("builtin-") && !/^[a-f0-9]{64}$/i.test(raw) && raw) ? raw : "Built-in");
    if (baseTitle.includes(`(#${shortId})`)) return baseTitle;
    return `${baseTitle} (#${shortId})`;
  }

  // Bare 64-character SHA-256 hash
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    const rawId = raw.toLowerCase();
    const shortId = rawId.slice(0, 6);
    const entry = lookupBuiltinMelody(rawId);
    if (entry) {
      return `${entry.title} (#${shortId})`;
    }
    return `Project #${shortId}`;
  }

  // If already contains a readable name, limit length if needed
  if (raw.length > maxLength) {
    return raw.slice(0, maxLength - 1) + "…";
  }

  return raw;
}
