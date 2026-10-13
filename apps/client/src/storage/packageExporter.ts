import {
  PACKAGE_VERSION,
  ProjectPackageSchema,
  type ProjectPackage,
  type PianistProfile,
  type ResourceDescriptor,
} from "@handthesia/contracts";
import {
  SavedProjectSchema,
  validateSavedProject,
  type SavedProject,
} from "./projectDb.ts";
import {
  MAX_PACKAGE_FILE_SIZE_BYTES,
  isSafeResourcePath,
} from "./fileValidator.ts";

export interface ExportProjectPackageOptions {
  profiles?: PianistProfile[];
  resources?: ResourceDescriptor[];
  resourcePayloads?: Record<string, ArrayBuffer>;
  filename?: string;
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset]!;
    const hasB = offset + 1 < bytes.length;
    const hasC = offset + 2 < bytes.length;
    const b = hasB ? bytes[offset + 1]! : 0;
    const c = hasC ? bytes[offset + 2]! : 0;
    output += base64Alphabet[a >> 2];
    output += base64Alphabet[((a & 3) << 4) | (b >> 4)];
    output += hasB ? base64Alphabet[((b & 15) << 2) | (c >> 6)] : "=";
    output += hasC ? base64Alphabet[c & 63] : "=";
  }
  return output;
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Resource payload is not valid base64.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = base64Alphabet.indexOf(value[offset]!);
    const b = base64Alphabet.indexOf(value[offset + 1]!);
    const c = value[offset + 2] === "=" ? 0 : base64Alphabet.indexOf(value[offset + 2]!);
    const d = value[offset + 3] === "=" ? 0 : base64Alphabet.indexOf(value[offset + 3]!);
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputIndex < bytes.length) bytes[outputIndex++] = (packed >> 16) & 0xff;
    if (outputIndex < bytes.length) bytes[outputIndex++] = (packed >> 8) & 0xff;
    if (outputIndex < bytes.length) bytes[outputIndex++] = packed & 0xff;
  }
  return bytes;
}

function bufferFromBase64(value: string): ArrayBuffer {
  const bytes = decodeBase64(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function mergeProfiles(project: SavedProject, extra: PianistProfile[] = []): PianistProfile[] {
  const byId = new Map<string, PianistProfile>();
  for (const profile of extra) byId.set(profile.profileId, profile);
  if (project.profile) byId.set(project.profile.profileId, project.profile);
  return Array.from(byId.values());
}

function addResource(resources: ResourceDescriptor[], resource: ResourceDescriptor): void {
  if (!isSafeResourcePath(resource.path)) {
    throw new Error(`Unsafe resource path detected: '${resource.path}'.`);
  }
  const byId = resources.find((candidate) => candidate.resourceId === resource.resourceId);
  const byPath = resources.find((candidate) => candidate.path === resource.path);
  if (byId && JSON.stringify(byId) !== JSON.stringify(resource)) {
    throw new Error(`Conflicting resource descriptors for '${resource.resourceId}'.`);
  }
  if (byPath && byPath.resourceId !== resource.resourceId) {
    throw new Error(`Resource path '${resource.path}' is already assigned to another resource.`);
  }
  if (!byId) resources.push(resource);
}

function buildPackageFields(project: SavedProject, options?: ExportProjectPackageOptions) {
  const profiles = mergeProfiles(project, options?.profiles);
  const resources: ResourceDescriptor[] = [];
  for (const resource of [...(project.resources ?? []), ...(options?.resources ?? [])]) addResource(resources, resource);
  const resourcePayloads = new Map<string, ArrayBuffer>();
  for (const [path, bytes] of Object.entries(project.resourcePayloads ?? {})) resourcePayloads.set(path, bytes);
  for (const [path, bytes] of Object.entries(options?.resourcePayloads ?? {})) resourcePayloads.set(path, bytes);

  return { profiles, resources, resourcePayloads };
}

function verifyPackagePayloads(pkg: ProjectPackage): void {
  const descriptorsByPath = new Map(pkg.resources.map((resource) => [resource.path, resource]));
  const payloads = pkg.resourcePayloads ?? {};
  for (const resource of pkg.resources) {
    if (!isSafeResourcePath(resource.path)) {
      throw new Error(`Unsafe resource path detected: '${resource.path}'.`);
    }
    const encoded = payloads[resource.path];
    if (encoded === undefined) throw new Error(`Project package is missing recoverable bytes for resource '${resource.path}'.`);
    const bytes = decodeBase64(encoded);
    if (bytes.byteLength !== resource.byteLength) {
      throw new Error(`Resource '${resource.path}' byte length does not match its descriptor.`);
    }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if (fallbackSha256(new Uint8Array(buffer)) !== resource.sha256) {
      throw new Error(`Resource '${resource.path}' checksum does not match its descriptor.`);
    }
  }
  for (const path of Object.keys(payloads)) {
    if (!isSafeResourcePath(path)) {
      throw new Error(`Unsafe resource payload path detected: '${path}'.`);
    }
    if (!descriptorsByPath.has(path)) throw new Error(`Project package payload '${path}' has no resource descriptor.`);
  }
  if (pkg.document.sourceMidiResourceId) {
    const source = pkg.resources.find((resource) => resource.resourceId === pkg.document.sourceMidiResourceId);
    if (!source || source.purpose !== "source-midi" || payloads[source.path] === undefined) {
      throw new Error("Project package must include the original source MIDI descriptor and bytes.");
    }
  }
}

/**
 * Computes SHA-256 hex string from an ArrayBuffer using native crypto.subtle with pure-JS fallback.
 */
export async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return fallbackSha256(new Uint8Array(buffer));
}

function fallbackSha256(data: Uint8Array): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const len = data.length;
  const bitLen = len * 8;
  const padLen = len % 64 < 56 ? 56 - (len % 64) : 120 - (len % 64);
  const totalLen = len + padLen + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(data);
  padded[len] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Int32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let i = 0; i < totalLen; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = view.getInt32(i + j * 4, false);
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15]!, 7) ^ rotr(w[j - 15]!, 18) ^ (w[j - 15]! >>> 3);
      const s1 = rotr(w[j - 2]!, 17) ^ rotr(w[j - 2]!, 19) ^ (w[j - 2]! >>> 10);
      w[j] = (w[j - 16]! + s0 + w[j - 7]! + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[j]! + w[j]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => (v >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/**
 * Builds and validates a `ProjectPackage` conforming to `ProjectPackageSchema`.
 * If the document references a `sourceMidiResourceId` and the resource descriptor is not provided,
 * it synthesizes one automatically from `rawMidiBytes` if available.
 */
export async function buildProjectPackage(
  project: SavedProject,
  options?: ExportProjectPackageOptions,
): Promise<ProjectPackage> {
  const validated = validateSavedProject(project);
  const { profiles, resources, resourcePayloads } = buildPackageFields(validated, options);
  const sourceBytes = validated.rawMidiBytes ?? null;
  if (sourceBytes) {
    let source = validated.document.sourceMidiResourceId
      ? resources.find((resource) => resource.resourceId === validated.document.sourceMidiResourceId)
      : resources.find((resource) => resource.purpose === "source-midi");
    if (!source) {
      source = {
        resourceId: validated.document.sourceMidiResourceId ?? `source-midi-${validated.projectId}`,
        purpose: "source-midi",
        mediaType: "audio/midi",
        byteLength: sourceBytes.byteLength,
        sha256: await computeSha256Hex(sourceBytes),
        path: "resources/source.mid",
      };
      addResource(resources, source);
    }
    resourcePayloads.set(source.path, sourceBytes);
  }
  for (const [path, bytes] of resourcePayloads) {
    if (!isSafeResourcePath(path)) throw new Error(`Unsafe resource payload path detected: '${path}'.`);
    const descriptor = resources.find((resource) => resource.path === path);
    if (!descriptor) throw new Error(`Resource payload '${path}' has no descriptor.`);
    if (descriptor.byteLength !== bytes.byteLength) throw new Error(`Resource payload '${path}' has an invalid byte length.`);
    if (await computeSha256Hex(bytes) !== descriptor.sha256) throw new Error(`Resource payload '${path}' checksum does not match its descriptor.`);
  }
  const encodedPayloads = Object.fromEntries(
    Array.from(resourcePayloads, ([path, bytes]) => [path, encodeBase64(new Uint8Array(bytes))]),
  );
  const pkg: ProjectPackage = {
    packageVersion: PACKAGE_VERSION,
    projectId: validated.projectId,
    document: validated.document,
    profiles,
    resources,
    activeProfileId: validated.profile?.profileId,
    fingeringPlan: validated.fingeringPlan ?? null,
    performancePlan: validated.performancePlan ?? null,
    motionPlan: validated.motionPlan ?? null,
    resourcePayloads: encodedPayloads,
  };
  return validateProjectPackage(pkg);
}

/**
 * Synchronous variant of `buildProjectPackage` when all resources are already prepared.
 */
export function buildProjectPackageSync(
  project: SavedProject,
  options?: ExportProjectPackageOptions,
): ProjectPackage {
  const validated = validateSavedProject(project);
  const { profiles, resources, resourcePayloads } = buildPackageFields(validated, options);
  if (validated.rawMidiBytes) {
    let source = validated.document.sourceMidiResourceId
      ? resources.find((resource) => resource.resourceId === validated.document.sourceMidiResourceId)
      : resources.find((resource) => resource.purpose === "source-midi");
    if (!source) {
      source = {
        resourceId: validated.document.sourceMidiResourceId ?? `source-midi-${validated.projectId}`,
        purpose: "source-midi",
        mediaType: "audio/midi",
        byteLength: validated.rawMidiBytes.byteLength,
        sha256: fallbackSha256(new Uint8Array(validated.rawMidiBytes)),
        path: "resources/source.mid",
      };
      addResource(resources, source);
    }
    resourcePayloads.set(source.path, validated.rawMidiBytes);
  }
  for (const [path] of resourcePayloads) {
    if (!isSafeResourcePath(path)) throw new Error(`Unsafe resource payload path detected: '${path}'.`);
  }
  const encodedPayloads = Object.fromEntries(
    Array.from(resourcePayloads, ([path, bytes]) => [path, encodeBase64(new Uint8Array(bytes))]),
  );
  const pkg: ProjectPackage = {
    packageVersion: PACKAGE_VERSION,
    projectId: validated.projectId,
    document: validated.document,
    profiles,
    resources,
    activeProfileId: validated.profile?.profileId,
    fingeringPlan: validated.fingeringPlan ?? null,
    performancePlan: validated.performancePlan ?? null,
    motionPlan: validated.motionPlan ?? null,
    resourcePayloads: encodedPayloads,
  };

  return validateProjectPackage(pkg);
}

/**
 * Serializes the project as a JSON string conforming to `ProjectPackageSchema`.
 */
export async function exportProjectPackageJson(
  project: SavedProject,
  options?: ExportProjectPackageOptions,
): Promise<string> {
  const pkg = await buildProjectPackage(project, options);
  return JSON.stringify(pkg, null, 2);
}

/**
 * Triggers a browser file download of the given text content.
 */
export function downloadFile(filename: string, content: string, mimeType = "application/json"): void {
  if (typeof document === "undefined" || !document.createElement) {
    return;
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Exports the project as a downloadable `.pianomotion.json` package conforming to `ProjectPackageSchema`.
 */
export async function downloadProjectPackage(
  project: SavedProject,
  options?: ExportProjectPackageOptions,
): Promise<void> {
  const json = await exportProjectPackageJson(project, options);
  const safeName = (options?.filename ?? `${project.name || project.projectId}.pianomotion.json`).replace(
    /[\\/:*?"<>|]/g,
    "_",
  );
  downloadFile(safeName, json, "application/json");
}

/**
 * Recursively inspects data to ensure __proto__, constructor, or prototype
 * properties are not present to prevent prototype pollution attacks.
 */
export function assertNoPrototypePollution(data: unknown): void {
  if (data === null || typeof data !== "object") {
    return;
  }
  const keys = Object.getOwnPropertyNames(data);
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`Prototype pollution attempt detected: forbidden property '${key}'.`);
    }
    assertNoPrototypePollution((data as Record<string, unknown>)[key]);
  }
}

/**
 * Validates unknown data against `ProjectPackageSchema`.
 * Throws ZodError on failure.
 */
export function validateProjectPackage(data: unknown): ProjectPackage {
  assertNoPrototypePollution(data);
  const pkg = ProjectPackageSchema.parse(data);
  verifyPackagePayloads(pkg);
  return pkg;
}

/**
 * Safely validates unknown data against `ProjectPackageSchema`.
 */
export function safeValidateProjectPackage(data: unknown) {
  try {
    return { success: true as const, data: validateProjectPackage(data) };
  } catch (error) {
    return { success: false as const, error };
  }
}

export const MAX_PACKAGE_JSON_LENGTH_CHARS = 64 * 1024 * 1024; // 64 MiB

/**
 * Parses and validates a JSON string as a `ProjectPackage`.
 */
export function parseProjectPackageJson(jsonText: string): ProjectPackage {
  if (jsonText.length > MAX_PACKAGE_JSON_LENGTH_CHARS) {
    throw new Error(
      `Package JSON text length (${jsonText.length} characters) exceeds the maximum allowed length of 64 MiB.`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(jsonText, (key, value) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error(`Prototype pollution attempt detected: forbidden property '${key}'.`);
      }
      return value;
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Prototype pollution")) {
      throw err;
    }
    throw new Error(
      `Failed to parse project package JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return validateProjectPackage(data);
}

/**
 * Reads a File or Blob, parses its JSON content, and validates it conforming to `ProjectPackageSchema`.
 */
export async function importProjectPackageFile(file: Blob): Promise<ProjectPackage> {
  if (file.size > MAX_PACKAGE_FILE_SIZE_BYTES) {
    const sizeMiB = (file.size / (1024 * 1024)).toFixed(2);
    throw new Error(`Package file size (${sizeMiB} MiB) exceeds the maximum allowed size of 32 MiB.`);
  }
  const text = await file.text();
  return parseProjectPackageJson(text);
}

/**
 * Converts a validated `ProjectPackage` into a `SavedProject` ready for persistence in IndexedDB.
 */
export function projectPackageToSavedProject(
  pkg: ProjectPackage,
  rawMidiBytes?: ArrayBuffer | null,
): SavedProject {
  pkg = validateProjectPackage(pkg);
  const sourceDescriptor = pkg.document.sourceMidiResourceId
    ? pkg.resources.find((resource) => resource.resourceId === pkg.document.sourceMidiResourceId)
    : pkg.resources.find((resource) => resource.purpose === "source-midi");
  const payloads = Object.fromEntries(
    Object.entries(pkg.resourcePayloads ?? {}).map(([path, encoded]) => [path, bufferFromBase64(encoded)]),
  );
  const recoveredMidi = rawMidiBytes ?? (sourceDescriptor ? payloads[sourceDescriptor.path] ?? null : null);
  const actualProfile = pkg.activeProfileId
    ? pkg.profiles.find((profile) => profile.profileId === pkg.activeProfileId) ?? null
    : pkg.profiles.find((profile) => profile.profileId === pkg.fingeringPlan?.profileId) ?? null;
  if (sourceDescriptor && recoveredMidi &&
      (recoveredMidi.byteLength !== sourceDescriptor.byteLength ||
       fallbackSha256(new Uint8Array(recoveredMidi)) !== sourceDescriptor.sha256)) {
    throw new Error("The provided original MIDI bytes do not match the package source resource.");
  }
  return {
    projectId: pkg.projectId,
    name: pkg.document.title || pkg.projectId,
    updatedAt: Date.now(),
    document: pkg.document,
    fingeringPlan: pkg.fingeringPlan ?? null,
    performancePlan: pkg.performancePlan ?? null,
    motionPlan: pkg.motionPlan ?? null,
    rawMidiBytes: recoveredMidi,
    profile: actualProfile,
    resources: pkg.resources,
    resourcePayloads: payloads,
  };
}

/**
 * Flexible importer that accepts either a `ProjectPackage` or a persisted `SavedProject` format,
 * validating against contracts schemas and returning a valid `SavedProject`.
 */
export function importProjectOrPackage(data: unknown, rawMidiBytes?: ArrayBuffer | null): SavedProject {
  const pkgCheck = safeValidateProjectPackage(data);
  if (pkgCheck.success) {
    return projectPackageToSavedProject(pkgCheck.data, rawMidiBytes);
  }

  const savedCheck = SavedProjectSchema.safeParse(data);
  if (savedCheck.success) {
    return validateSavedProject(savedCheck.data);
  }

  // Rethrow the package validation error for clear diagnostics
  throw pkgCheck.error;
}
