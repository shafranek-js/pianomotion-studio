import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES,
  TESTING_HAND_DIAGNOSTICS_MAX_FILES,
  TESTING_HAND_DIAGNOSTICS_PATH,
  RIGGED_EXPERIMENTAL_HAND_DIAGNOSTICS_PATH,
  testingHandDiagnosticsPlugin,
} from "./testingHandDiagnosticsPlugin";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function payload(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    captureId: "capture-test-1",
    appVersion: "0.1.0-dev",
    buildId: "local",
    formatSemantics: { numericPrecision: "rounded" },
    startedAt: "2026-10-27T12:00:00.000Z",
    stoppedAt: "2026-10-27T12:00:01.000Z",
    sampleIntervalMs: 250,
    maxRecords: 360,
    maxBytes: 650_000,
    configuration: { handModel: "testing", testingKeyContact: true },
    configurationTimeline: [{ revision: 0, recordedAt: "2026-10-27T12:00:00.000Z", elapsedMs: 0, settings: { handModel: "testing", testingKeyContact: true } }],
    configurationTimelineTruncated: false,
    truncated: false,
    throttledSamples: 0,
    records: [{ capturedAt: "2026-10-27T12:00:00.250Z", elapsedMs: 250, hand: "left", configurationRevision: 0, ...extra }],
  };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "pianomotion-testing-hand-"));
  temporaryDirectories.push(root);
  const outputDirectory = path.join(root, ".local-diagnostics", "testing-hand");
  let middleware: ((request: IncomingMessage, response: ServerResponse, next: () => void) => void) | undefined;
  const plugin = testingHandDiagnosticsPlugin({ outputDirectory, provenance: async () => ({
    timing: "filesystem-observation-not-proof-of-rendered-bytes", gitCommitSha: null, workingTreeDirty: null,
    sha256: {
      "apps/client/src/render3d/handRigBuilder.ts": null,
      "apps/client/src/render3d/riggedExperimentalHand.ts": null,
      "apps/client/public/models/hands/rigged-experimental/left.glb": null,
      "apps/client/public/models/hands/rigged-experimental/right.glb": null,
    },
  }) });
  plugin.configResolved?.({ root, server: { https: false } } as never);
  plugin.configureServer?.({ middlewares: { use: (handler: typeof middleware) => { middleware = handler; } } } as never);
  if (!middleware) throw new Error("Testing hand diagnostics middleware was not registered.");
  return { root, outputDirectory, riggedExperimentalOutputDirectory: path.join(root, ".local-diagnostics", "rigged-experimental-hand"), middleware };
}

async function request(
  middleware: (request: IncomingMessage, response: ServerResponse, next: () => void) => void,
  body: string,
  options: { peer?: string; origin?: string; method?: string; url?: string; contentType?: string } = {},
) {
  const input = Readable.from([Buffer.from(body)]) as Readable & Partial<IncomingMessage>;
  Object.assign(input, {
    method: options.method ?? "POST",
    url: options.url ?? TESTING_HAND_DIAGNOSTICS_PATH,
    headers: {
      host: "127.0.0.1:5179",
      origin: options.origin ?? "http://127.0.0.1:5179",
      "content-type": options.contentType ?? "application/json",
      "content-length": Buffer.byteLength(body),
    },
  });
  Object.defineProperty(input, "socket", { value: { remoteAddress: options.peer ?? "127.0.0.1", encrypted: false } });
  const response = new EventEmitter() as EventEmitter & Partial<ServerResponse> & { output: string; headers: Record<string, string> };
  response.statusCode = 200;
  response.headersSent = false;
  response.output = "";
  response.headers = {};
  response.setHeader = (name: string, value: string | number | readonly string[]) => { response.headers[name] = String(value); return response as ServerResponse; };
  response.end = (chunk?: string | Buffer) => {
    if (chunk) response.output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    response.headersSent = true;
    response.emit("finish");
    return response as ServerResponse;
  };
  const completed = new Promise<void>(resolve => response.once("finish", resolve));
  middleware(input as IncomingMessage, response as ServerResponse, () => response.emit("next"));
  await completed;
  return { status: response.statusCode!, body: JSON.parse(response.output) as Record<string, unknown>, headers: response.headers };
}

describe("Vite local Testing hand diagnostics endpoint", () => {
  it("exposes a loopback-only provenance snapshot before capture", async () => {
    const { middleware } = await setup();
    const response = await request(middleware, "{}", { url: `${TESTING_HAND_DIAGNOSTICS_PATH}/provenance` });
    expect(response.status).toBe(200);
    expect(response.body.provenance).toMatchObject({ gitCommitSha: null, workingTreeDirty: null });
    const denied = await request(middleware, "{}", { url: `${TESTING_HAND_DIAGNOSTICS_PATH}/provenance`, origin: "http://other.test" });
    expect(denied.status).toBe(403);
  });
  it("writes unique, readable JSON captures under the local app root", async () => {
    const { root, outputDirectory, middleware } = await setup();
    const first = await request(middleware, JSON.stringify(payload()));
    const second = await request(middleware, JSON.stringify(payload()));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.format).toBe("pretty");
    expect(first.body.savedTo).toMatch(/^\.local-diagnostics\/testing-hand\/testing-hand-/);
    expect(first.body.fileCount).toBe(1);
    expect(second.body.fileCount).toBe(2);
    const files = await readdir(outputDirectory);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    const saved = await readFile(path.join(root, String(first.body.savedTo)), "utf8");
    expect(saved).toContain('"hand": "left"');
    expect(saved).toContain("\n  \"schemaVersion\": 1");
    const provenance = JSON.parse(saved).provenanceAtSave;
    expect(provenance.timing).toBe("filesystem-observation-not-proof-of-rendered-bytes");
    expect(provenance).toHaveProperty("gitCommitSha");
    expect(provenance).toHaveProperty("workingTreeDirty");
    expect(provenance.sha256).toHaveProperty("apps/client/src/render3d/handRigBuilder.ts");
  });

  it("routes Rigged Experimental captures to their own bounded directory and prefix while preserving Testing paths", async () => {
    const { root, outputDirectory, riggedExperimentalOutputDirectory, middleware } = await setup();
    const originalTesting = await request(middleware, JSON.stringify(payload()));
    const mismatch = await request(middleware, JSON.stringify({
      ...payload(),
      captureModel: "rigged-experimental",
      configuration: { handModel: "rigged-experimental" },
      records: [{ ...payload().records[0], captureModel: "rigged-experimental" }],
    }));
    const riggedPayload = {
      ...payload(),
      captureModel: "rigged-experimental",
      configuration: { handModel: "rigged-experimental" },
      records: [{ ...payload().records[0], captureModel: "rigged-experimental" }],
    };
    const rigged = await request(middleware, JSON.stringify(riggedPayload), { url: RIGGED_EXPERIMENTAL_HAND_DIAGNOSTICS_PATH });
    expect(originalTesting.status).toBe(201);
    expect(originalTesting.body.savedTo).toMatch(/^\.local-diagnostics\/testing-hand\/testing-hand-/);
    expect(mismatch.status).toBe(400);
    expect(rigged.status).toBe(201);
    expect(rigged.body.savedTo).toMatch(/^\.local-diagnostics\/rigged-experimental-hand\/rigged-experimental-hand-/);
    expect(await readdir(outputDirectory)).toHaveLength(1);
    expect(await readdir(riggedExperimentalOutputDirectory)).toHaveLength(1);
    const saved = JSON.parse(await readFile(path.join(root, String(rigged.body.savedTo)), "utf8"));
    expect(saved.captureModel).toBe("rigged-experimental");
    expect(saved.records[0].captureModel).toBe("rigged-experimental");
    expect(saved.provenanceAtSave.sha256).toHaveProperty("apps/client/src/render3d/riggedExperimentalHand.ts");
    expect(saved.provenanceAtSave.sha256).toHaveProperty("apps/client/public/models/hands/rigged-experimental/left.glb");
  });

  it("saves profile and per-frame plan and scale evidence", async () => {
    const { root, middleware } = await setup();
    const data = {
      ...payload({
        sampling: { motionPlanIdentity: { planId: "motion/test", inputRevision: 2, profileId: "pianist", profileRevision: 3, engineVersion: "test" } },
        preContactBoneScale: { "thumb-phalanx-distal": { requestedRatio: 1.9, appliedRatio: 1.55, bindLengthIn: 0.58 } },
      }),
      provenanceAtStart: { pianistProfileAtCaptureStart: { profileId: "pianist", revision: 3, anatomy: { pp1: 3.3 }, behavior: { finger_curve: 0.4 }, profileSkinFingerWidth: 0.75 } },
    };
    const response = await request(middleware, JSON.stringify(data));
    expect(response.status).toBe(201);
    const saved = JSON.parse(await readFile(path.join(root, String(response.body.savedTo)), "utf8"));
    expect(saved.provenanceAtStart.pianistProfileAtCaptureStart).toEqual(data.provenanceAtStart.pianistProfileAtCaptureStart);
    expect(saved.records[0].sampling.motionPlanIdentity.profileRevision).toBe(3);
    expect(saved.records[0].preContactBoneScale["thumb-phalanx-distal"].appliedRatio).toBe(1.55);
  });

  it("rejects remote peers, cross-origin requests, malformed content and oversized captures", async () => {
    const { middleware } = await setup();
    expect((await request(middleware, JSON.stringify(payload()), { peer: "192.0.2.7" })).status).toBe(403);
    expect((await request(middleware, JSON.stringify(payload()), { origin: "http://example.test:5179" })).status).toBe(403);
    expect((await request(middleware, JSON.stringify(payload()), { contentType: "text/plain" })).status).toBe(415);
    expect((await request(middleware, "not json")).status).toBe(400);
    const oversized = JSON.stringify(payload({ filler: "x".repeat(TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES + 100) }));
    expect((await request(middleware, oversized)).status).toBe(413);
  });

  it("saves a compact JSON fallback when indentation would exceed the file limit", async () => {
    const { root, middleware } = await setup();
    const largePayload = payload();
    largePayload.records = Array.from({ length: 100 }, (_, index) => ({
      capturedAt: "2026-10-27T12:00:00.250Z",
      elapsedMs: index,
      hand: index % 2 === 0 ? "left" : "right",
      configurationRevision: 0,
      rendererRig: {
        nodeLabels: Array.from({ length: 25 }, (_unused, bone) => `bone-${bone}`),
        transforms: Array.from({ length: 25 }, () => [0.123, 0.456, 0.789, 0, 0, 0, 1, 1, 1, 1]),
      },
      sourcePose: {
        bones: Array.from({ length: 28 }, () => ["distal", 0, 0, 0, 1, 1, 1]),
        joints: Array.from({ length: 8 }, () => ["tip", 0, 0, 0]),
      },
      contacts: Array.from({ length: 4 }, () => ({
        finger: 1, pitch: 60, keyBounds: { centerX: 0, minX: -1, maxX: 1 }, padWorldPosition: [0, 0, 0], gap: 0,
      })),
    }));
    const compactLength = Buffer.byteLength(JSON.stringify(largePayload));
    const prettyLength = Buffer.byteLength(`${JSON.stringify(largePayload, null, 2)}\n`);
    expect(compactLength).toBeLessThan(TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES);
    expect(prettyLength).toBeGreaterThan(TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES);
    const response = await request(middleware, JSON.stringify(largePayload));
    expect(response.status).toBe(201);
    expect(response.body.format).toBe("compact");
    const saved = await readFile(path.join(root, String(response.body.savedTo)), "utf8");
    expect(Buffer.byteLength(saved)).toBeLessThan(TESTING_HAND_DIAGNOSTICS_MAX_FILE_BYTES);
    expect(saved).not.toContain("\n");
    expect(JSON.parse(saved).records).toHaveLength(100);
  });

  it("rejects private project/file metadata and reports the bounded file-count limit", async () => {
    const { middleware, outputDirectory } = await setup();
    expect((await request(middleware, JSON.stringify(payload({ projectName: "private" })))).status).toBe(400);
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all(Array.from({ length: TESTING_HAND_DIAGNOSTICS_MAX_FILES }, (_, index) =>
      writeFile(path.join(outputDirectory, `testing-hand-existing-${index}.json`), "{}")));
    const limit = await request(middleware, JSON.stringify(payload()));
    expect(limit.status).toBe(507);
    expect(limit.body.message).toContain(`${TESTING_HAND_DIAGNOSTICS_MAX_FILES}-file limit`);
  });
});
