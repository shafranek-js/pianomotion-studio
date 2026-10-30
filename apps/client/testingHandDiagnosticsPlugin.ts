import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const TESTING_HAND_DIAGNOSTICS_PATH = "/__testing-hand-diagnostics";
export const RIGGED_EXPERIMENTAL_HAND_DIAGNOSTICS_PATH = "/__rigged-experimental-hand-diagnostics";
export const TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES = 1_000_000;
export const TESTING_HAND_DIAGNOSTICS_MAX_FILES = 20;
export const TESTING_HAND_DIAGNOSTICS_MAX_TOTAL_BYTES = 20_000_000;
const TESTING_FILE_PREFIX = "testing-hand-";
const RIGGED_EXPERIMENTAL_FILE_PREFIX = "rigged-experimental-hand-";
const execFileAsync = promisify(execFile);
const PROVENANCE_FILES = [
  "apps/client/src/render3d/handRigBuilder.ts", "apps/client/src/render3d/pianoScene3d.ts",
  "apps/client/src/render3d/testingHandSkin.ts", "apps/client/src/render3d/testingHandContactGuard.ts",
  "apps/client/src/render3d/testingFingerKinematics.ts", "apps/client/src/render3d/testingFingerRigidSwing.ts",
  "apps/client/src/render3d/testingFingerChainInterpolation.ts",
  "apps/client/src/render3d/testingThumbReach.ts",
  "apps/client/src/render3d/testingHandPoseStages.ts", "apps/client/src/diagnostics/testingHandCapture.ts",
  "apps/client/src/render3d/riggedExperimentalHand.ts", "apps/client/src/profiles/riggedHandProfile.ts",
  "apps/client/public/models/hands/left.glb", "apps/client/public/models/hands/right.glb",
  "apps/client/public/models/hands/rigged-experimental/left.glb", "apps/client/public/models/hands/rigged-experimental/right.glb",
  "apps/client/public/models/hands/improved/manifest.json",
  ...["left", "right"].flatMap(side => [0, 1, 2].map(lod => `apps/client/public/models/hands/improved/${side}-lod${lod}.glb`)),
];

/** These are filesystem observations at save time, not proof of bytes already loaded by the browser. */
async function captureSaveProvenance(clientRoot: string) {
  const repo = path.resolve(clientRoot, "../..");
  let gitCommitSha: string | null = null;
  let workingTreeDirty: boolean | null = null;
  const head = (async () => { try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo, timeout: 5000 });
    if (/^[0-9a-f]{40,64}\s*$/i.test(stdout)) gitCommitSha = stdout.trim();
  } catch { /* Unknown is distinct from a clean repository. */ } })();
  const status = (async () => { try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, timeout: 10000, maxBuffer: 2_000_000 });
    workingTreeDirty = stdout.length > 0;
  } catch { /* A failed Git command must not claim a clean checkout. */ } })();
  const files: Record<string, string | null> = {};
  await Promise.all(PROVENANCE_FILES.map(async name => {
    try { files[name] = createHash("sha256").update(await readFile(path.join(repo, name))).digest("hex"); }
    catch { files[name] = null; }
  }));
  await Promise.all([head, status]);
  return { observedAt: new Date().toISOString(), timing: "filesystem-observation-not-proof-of-rendered-bytes", gitCommitSha, workingTreeDirty, sha256: files };
}
const FORBIDDEN_METADATA_KEYS = /^(?:project(?:id|name)?|song(?:id|name)?|filename|filepath|sourcepath|useragent|midibytes|rawmidibytes|audiodata)$/i;

interface CaptureEnvelope {
  schemaVersion: 1;
  captureModel?: "testing" | "rigged-experimental";
  captureId: string;
  appVersion: string;
  buildId: string;
  formatSemantics: Record<string, unknown>;
  startedAt: string;
  stoppedAt: string;
  sampleIntervalMs: number;
  maxRecords: number;
  maxBytes: number;
  configuration: Record<string, unknown>;
  configurationTimeline: Array<{ revision: number; recordedAt: string; elapsedMs: number; settings: Record<string, unknown> }>;
  configurationTimelineTruncated: boolean;
  truncated: boolean;
  throttledSamples: number;
  records: Record<string, unknown>[];
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1" || normalized.endsWith(".localhost");
}

function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%", 1)[0];
  return normalized === "::1" || normalized === "127.0.0.1" || normalized === "::ffff:127.0.0.1" ||
    normalized?.startsWith("127.") === true;
}

function sameLoopbackOrigin(request: IncomingMessage, originHeader: string | undefined, configuredHttps: boolean): boolean {
  if (!originHeader || !request.headers.host) return false;
  try {
    const origin = new URL(originHeader);
    const expected = new URL(`${configuredHttps || Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted) ? "https" : "http"}://${request.headers.host}`);
    return origin.origin === expected.origin && isLoopbackHost(origin.hostname);
  } catch { return false; }
}

function hasForbiddenMetadata(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 8) return false;
  if (Array.isArray(value)) return value.some(item => hasForbiddenMetadata(item, depth + 1));
  return Object.entries(value).some(([key, item]) => FORBIDDEN_METADATA_KEYS.test(key) || hasForbiddenMetadata(item, depth + 1));
}

function isCaptureEnvelope(value: unknown): value is CaptureEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<CaptureEnvelope>;
  return item.schemaVersion === 1 && typeof item.captureId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(item.captureId) &&
    typeof item.appVersion === "string" && item.appVersion.length <= 100 &&
    typeof item.buildId === "string" && item.buildId.length <= 100 &&
    Boolean(item.formatSemantics) && typeof item.formatSemantics === "object" && !Array.isArray(item.formatSemantics) &&
    typeof item.startedAt === "string" && Number.isFinite(Date.parse(item.startedAt)) &&
    typeof item.stoppedAt === "string" && Number.isFinite(Date.parse(item.stoppedAt)) &&
    Number.isInteger(item.sampleIntervalMs) && item.sampleIntervalMs! >= 0 &&
    Number.isInteger(item.maxRecords) && item.maxRecords! > 0 && item.maxRecords! <= 360 &&
    Number.isInteger(item.maxBytes) && item.maxBytes! > 0 && item.maxBytes! <= TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES &&
    typeof item.truncated === "boolean" && Number.isInteger(item.throttledSamples) && item.throttledSamples! >= 0 &&
    Boolean(item.configuration) && typeof item.configuration === "object" && !Array.isArray(item.configuration) &&
    typeof item.configurationTimelineTruncated === "boolean" && Array.isArray(item.configurationTimeline) &&
    item.configurationTimeline.length > 0 && item.configurationTimeline.length <= 100 &&
    item.configurationTimeline.every((revision, index) => Boolean(revision) && revision.revision === index &&
      typeof revision.recordedAt === "string" && Number.isFinite(Date.parse(revision.recordedAt)) &&
      Number.isSafeInteger(revision.elapsedMs) && revision.elapsedMs >= 0 &&
      Boolean(revision.settings) && typeof revision.settings === "object" && !Array.isArray(revision.settings)) &&
    (item.captureModel === undefined || item.captureModel === "testing" || item.captureModel === "rigged-experimental") &&
    Array.isArray(item.records) && item.records.length <= 360 && item.records.every(record =>
      Boolean(record) && typeof record === "object" && !Array.isArray(record) &&
      (record.hand === "left" || record.hand === "right") &&
      (record.captureModel === undefined || record.captureModel === (item.captureModel ?? "testing")) &&
      (item.captureModel !== "rigged-experimental" || record.captureModel === "rigged-experimental") &&
      typeof record.capturedAt === "string" && Number.isFinite(Date.parse(record.capturedAt)) &&
      Number.isSafeInteger(record.elapsedMs) && Number(record.elapsedMs) >= 0 &&
      Number.isSafeInteger(record.configurationRevision) &&
      Number(record.configurationRevision) >= 0 && Number(record.configurationRevision) < item.configurationTimeline!.length);
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES) return null;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function getExistingUsage(directory: string, filePrefix: string): Promise<{ files: number; bytes: number }> {
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: 0, bytes: 0 };
    throw error;
  }
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.startsWith(filePrefix) || !entry.endsWith(".json")) continue;
    try {
      const details = await stat(path.join(directory, entry));
      if (details.isFile()) { files += 1; bytes += details.size; }
    } catch { /* A concurrent local removal only lowers the usage total. */ }
  }
  return { files, bytes };
}

function routeRequest(request: IncomingMessage): string | null {
  if (!request.url) return null;
  try { return new URL(request.url, "http://127.0.0.1").pathname; }
  catch { return null; }
}

/** Dev-server-only, loopback-only sinks for explicit local hand-frame captures. */
export function testingHandDiagnosticsPlugin(options: {
  outputDirectory?: string;
  riggedExperimentalOutputDirectory?: string;
  provenance?: (root: string) => Promise<unknown>;
} = {}): Plugin {
  let outputDirectory = "";
  let riggedExperimentalOutputDirectory = "";
  let rootDirectory = process.cwd();
  let configuredHttps = false;
  let writes = Promise.resolve();

  return {
    name: "pianomotion-testing-hand-diagnostics",
    apply: "serve",
    configResolved(config) {
      rootDirectory = config.root;
      configuredHttps = Boolean(config.server.https);
      outputDirectory = options.outputDirectory
        ? path.resolve(options.outputDirectory)
        : path.resolve(config.root, ".local-diagnostics", "testing-hand");
      riggedExperimentalOutputDirectory = options.riggedExperimentalOutputDirectory
        ? path.resolve(options.riggedExperimentalOutputDirectory)
        : path.resolve(path.dirname(outputDirectory), "rigged-experimental-hand");
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const route = routeRequest(request);
        const isRiggedRoute = route === RIGGED_EXPERIMENTAL_HAND_DIAGNOSTICS_PATH || route === `${RIGGED_EXPERIMENTAL_HAND_DIAGNOSTICS_PATH}/provenance`;
        const isTestingRoute = route === TESTING_HAND_DIAGNOSTICS_PATH || route === `${TESTING_HAND_DIAGNOSTICS_PATH}/provenance`;
        if (!isRiggedRoute && !isTestingRoute) { next(); return; }
        if (request.method !== "POST") { json(response, 405, { message: "Use POST to save a local hand diagnostic capture." }); return; }
        if (!isLoopbackPeer(request.socket.remoteAddress)) { json(response, 403, { message: "The local diagnostic endpoint accepts loopback connections only." }); return; }
        if (!sameLoopbackOrigin(request, typeof request.headers.origin === "string" ? request.headers.origin : undefined, configuredHttps)) {
          json(response, 403, { message: "The local diagnostic endpoint requires a same-origin loopback request." }); return;
        }
        const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType !== "application/json") { json(response, 415, { message: "Send the capture as application/json." }); return; }
        if (route === `${TESTING_HAND_DIAGNOSTICS_PATH}/provenance` || route === `${RIGGED_EXPERIMENTAL_HAND_DIAGNOSTICS_PATH}/provenance`) {
          void (options.provenance ?? captureSaveProvenance)(rootDirectory)
            .then(provenance => json(response, 200, { provenance }))
            .catch(() => json(response, 500, { message: "Could not inspect local capture provenance." }));
          return;
        }

        void readBody(request).then(body => {
          if (!body) { json(response, 413, { message: `Capture exceeds the ${TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES.toLocaleString()}-byte file limit.` }); return; }
          let payload: unknown;
          try { payload = JSON.parse(body.toString("utf8")); }
          catch { json(response, 400, { message: "Capture body is not valid JSON." }); return; }
          if (!isCaptureEnvelope(payload) || payload.records.length > payload.maxRecords || payload.maxRecords > 360 || payload.maxBytes > TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES) {
            json(response, 400, { message: "Capture schema or declared bounds are invalid." }); return;
          }
          const captureModel = payload.captureModel ?? "testing";
          if ((isRiggedRoute && captureModel !== "rigged-experimental") || (isTestingRoute && captureModel !== "testing")) {
            json(response, 400, { message: "Capture model does not match the selected local diagnostics endpoint." }); return;
          }
          if (hasForbiddenMetadata(payload)) {
            json(response, 400, { message: "Capture contains project, file, MIDI, audio, or browser identity metadata." }); return;
          }

          const operation = writes.then(async () => {
            const selectedOutputDirectory = captureModel === "rigged-experimental" ? riggedExperimentalOutputDirectory : outputDirectory;
            const filePrefix = captureModel === "rigged-experimental" ? RIGGED_EXPERIMENTAL_FILE_PREFIX : TESTING_FILE_PREFIX;
            const folderLabel = captureModel === "rigged-experimental" ? "rigged-experimental-hand" : "testing-hand";
            const usage = await getExistingUsage(selectedOutputDirectory, filePrefix);
            const actualBytes = body.byteLength;
            if (usage.files >= TESTING_HAND_DIAGNOSTICS_MAX_FILES) {
              json(response, 507, { message: `The local ${folderLabel} folder reached its ${TESTING_HAND_DIAGNOSTICS_MAX_FILES}-file limit. Remove older ${folderLabel} JSON files to save another capture.` });
              return;
            }
            if (usage.bytes + actualBytes > TESTING_HAND_DIAGNOSTICS_MAX_TOTAL_BYTES) {
              json(response, 507, { message: `The local ${folderLabel} folder reached its 20 MB limit. Remove older ${folderLabel} JSON files to save another capture.` });
              return;
            }
            await mkdir(selectedOutputDirectory, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const filename = `${filePrefix}${stamp}-${randomUUID()}.json`;
            const absolutePath = path.join(selectedOutputDirectory, filename);
            const savedPayload = { ...payload, provenanceAtSave: await (options.provenance ?? captureSaveProvenance)(rootDirectory) };
            const pretty = `${JSON.stringify(savedPayload, null, 2)}\n`;
            const compact = JSON.stringify(savedPayload);
            const prettyBytes = Buffer.byteLength(pretty, "utf8");
            const compactBytes = Buffer.byteLength(compact, "utf8");
            if (compactBytes > TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES) {
              json(response, 413, { message: "Capture exceeds the 1,000,000-byte file limit, including compact JSON." });
              return;
            }
            const format = prettyBytes <= TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES ? "pretty" : "compact";
            const serialized = format === "pretty" ? pretty : compact;
            if (usage.bytes + Buffer.byteLength(serialized, "utf8") > TESTING_HAND_DIAGNOSTICS_MAX_TOTAL_BYTES) {
              json(response, 507, { message: `The local ${folderLabel} folder reached its 20 MB limit. Remove older ${folderLabel} JSON files to save another capture.` });
              return;
            }
            await writeFile(absolutePath, serialized, { flag: "wx" });
            const nextUsage = { files: usage.files + 1, bytes: usage.bytes + Buffer.byteLength(serialized, "utf8") };
            json(response, 201, {
              savedTo: path.relative(rootDirectory, absolutePath).replace(/\\/g, "/"),
              format,
              fileCount: nextUsage.files,
              maxFiles: TESTING_HAND_DIAGNOSTICS_MAX_FILES,
              totalBytes: nextUsage.bytes,
              maxTotalBytes: TESTING_HAND_DIAGNOSTICS_MAX_TOTAL_BYTES,
            });
          });
          writes = operation.catch(() => undefined);
          void operation.catch(error => {
            if (!response.headersSent) json(response, 500, { message: `Could not write the local diagnostic file: ${error instanceof Error ? error.message : "unknown filesystem error"}` });
          });
        }).catch(error => {
          if (!response.headersSent) json(response, 500, { message: `Could not read the capture body: ${error instanceof Error ? error.message : "unknown request error"}` });
        });
      });
    },
  };
}
