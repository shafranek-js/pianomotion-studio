import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  M1AnalyzeMidiRequestSchema,
  M1EngineLoadResultSchema,
  M1ReplanDocumentRequestSchema,
  M1SampleMotionRequestSchema,
  M1SampleMotionResultSchema,
  validateM1AnalyzeMidiResultForRequest,
  validateM1ReplanDocumentResultForRequest,
  type M1AnalyzeMidiResult,
  type M1EngineLoadResult,
  type M1ReplanDocumentRequest,
  type M1ReplanDocumentResult,
  type M1SampleMotionRequest,
  type M1SampleMotionResult,
  type MotionPose,
  type PianistProfile,
} from "@handthesia/contracts";
import { compareM1ResultToGolden, type FixtureParity, type GoldenFixture } from "../parity/compare";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");
const FIXTURE_MANIFEST_PATH = path.resolve(FIXTURES_DIR, "manifest.json");
const GOLDEN_DIR = path.resolve(FIXTURES_DIR, "golden");
const ENGINE_PACKAGE_PATH = path.resolve(__dirname, "../../packages/engine-ts/package.json");
const PYODIDE_MANIFEST_PATH = path.resolve(__dirname, "../../tools/pyodide-runtime-manifest.json");
const CORE_MANIFEST_PATH = path.resolve(__dirname, "../../apps/client/public/python-core/source_manifest.json");
const BUILTIN_MELODIES_DIR = path.resolve(__dirname, "../../apps/client/public/builtin-melodies");
const BUILTIN_MELODIES_MANIFEST_PATH = path.resolve(BUILTIN_MELODIES_DIR, "manifest.json");
const SAMPLE_COVERAGE_LOOKAHEAD_SECONDS = 0.2;

type FixtureManifest = {
  fixtureSources: Record<string, { fixturePath: string; fixtureSha256: string }>;
};
type BuiltinMelodyManifest = {
  entries: Array<{ title: string; fileName: string; assetPath: string; sha256: string; byteLength: number }>;
};
type EngineName = "python" | "typescript";
type WorkerIdentity = { projectId: string; revision: number; engineVersion: string };
type WorkerEnvelope = WorkerIdentity & { requestId: string };
type BrowserSampleChunk = { request: M1SampleMotionRequest; result: M1SampleMotionResult; covered: boolean };
type BrowserWindowResult = {
  chunks: BrowserSampleChunk[];
  poses: MotionPose[];
  coverage: Record<string, { start: number; end: number }[]>;
};
type BrowserHarness = {
  open(engine: EngineName): Promise<{
    actualEngine: EngineName | undefined;
    engineLoaded: M1EngineLoadResult;
    profile: PianistProfile;
  }>;
  analyze(args: {
    engine: EngineName;
    fixtureId: string;
    projectId: string;
    revision: number;
    requestId: string;
    engineVersion: string;
    midiBytes: number[];
  }): Promise<M1AnalyzeMidiResult>;
  replan(args: {
    engine: EngineName;
    request: Omit<M1ReplanDocumentRequest, "midiBytes">;
    midiBytes: number[];
  }): Promise<M1ReplanDocumentResult>;
  sampleWindow(args: {
    engine: EngineName;
    identity: WorkerIdentity;
    startTimeSeconds: number;
    endTimeSeconds: number;
    requestIdPrefix: string;
  }): Promise<BrowserWindowResult>;
  close(engine: EngineName): void;
};

const fixtureManifest = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST_PATH, "utf8")) as FixtureManifest;
const fixtureIds = Object.keys(fixtureManifest.fixtureSources).sort();
const builtinMelodyManifest = JSON.parse(fs.readFileSync(BUILTIN_MELODIES_MANIFEST_PATH, "utf8")) as BuiltinMelodyManifest;
const chopsticksEntry = builtinMelodyManifest.entries.find((entry) => entry.title === "Chopsticks" && entry.fileName === "Chopsticks.mid");
if (!chopsticksEntry || !/^files\/[a-f0-9]{64}\.mid$/.test(chopsticksEntry.assetPath) || chopsticksEntry.assetPath !== `files/${chopsticksEntry.sha256}.mid`) {
  throw new Error("The canonical built-in Chopsticks MIDI is missing or has unsafe catalog metadata.");
}
const chopsticksMidiBytes = fs.readFileSync(path.resolve(BUILTIN_MELODIES_DIR, chopsticksEntry.assetPath));
const chopsticksSha256 = createHash("sha256").update(chopsticksMidiBytes).digest("hex");
if (chopsticksMidiBytes.byteLength !== chopsticksEntry.byteLength || chopsticksSha256 !== chopsticksEntry.sha256) {
  throw new Error("The built-in Chopsticks asset does not match its catalog hash and byte length.");
}
const enginePackage = JSON.parse(fs.readFileSync(ENGINE_PACKAGE_PATH, "utf8")) as { version: string };
const coreManifest = JSON.parse(fs.readFileSync(CORE_MANIFEST_PATH, "utf8")) as { engineVersion: string };
const pyodideRuntime = JSON.parse(fs.readFileSync(PYODIDE_MANIFEST_PATH, "utf8")) as {
  runtime: { version: string; pythonVersion: string };
};

function bufferAsArrayBuffer(value: Buffer): ArrayBuffer {
  return Uint8Array.from(value).buffer as ArrayBuffer;
}

function withoutMidiBytes<T extends { midiBytes: unknown }>(value: T): Omit<T, "midiBytes"> {
  const result = { ...value };
  delete (result as Partial<T>).midiBytes;
  return result as Omit<T, "midiBytes">;
}

function goldenFromPythonResult(result: M1AnalyzeMidiResult, fixtureId: string): GoldenFixture {
  const raw = result.rawBaseline;
  if (result.status === "invalid" || raw.status === "invalid-or-rejected") {
    throw new Error(`The Python Worker could not load ${fixtureId} for native parity comparison.`);
  }
  return {
    fixtureId,
    inputSha256: raw.inputSha256,
    status: raw.status,
    sourceNotes: raw.sourceNotes,
    desktopNotes: raw.desktopNotes,
    assignments: raw.assignments,
    performanceEvents: raw.performanceEvents,
    rawPedals: raw.rawPedals,
    pedals: raw.pedals,
    sourcePedals: raw.sourcePedals,
    selectedPoses: raw.selectedPoses,
    tracks: raw.tracks,
  };
}

function anatomicalIssues(poses: MotionPose[]): string[] {
  const issues: string[] = [];
  if (poses.length === 0) return ["no poses returned"];

  for (const [poseIndex, pose] of poses.entries()) {
    const prefix = `pose ${poseIndex} (${pose.hand} @ ${pose.transportTimeSeconds}s)`;
    const counts = pose.bones.reduce<Record<string, number>>((value, bone) => {
      value[bone.kind] = (value[bone.kind] ?? 0) + 1;
      return value;
    }, {});
    for (const [kind, expected] of [["metacarpal", 5], ["proximal", 5], ["middle", 4], ["distal", 5]] as const) {
      if (counts[kind] !== expected) issues.push(`${prefix}: expected ${expected} ${kind} segments, received ${counts[kind] ?? 0}`);
    }
    if ((counts.forearm ?? 0) < 1) issues.push(`${prefix}: missing forearm segment`);
    if (pose.joints.filter((joint) => joint.kind === "tip").length < 5) issues.push(`${prefix}: fewer than five fingertip joints`);

    const wrists = pose.joints.filter((joint) => joint.kind === "wrist");
    if (wrists.length < 2) {
      issues.push(`${prefix}: expected two wrist joints, received ${wrists.length}`);
    } else {
      const wristSpan = Math.hypot(
        wrists[1]!.point[0] - wrists[0]!.point[0],
        wrists[1]!.point[1] - wrists[0]!.point[1],
        wrists[1]!.point[2] - wrists[0]!.point[2],
      );
      if (!(wristSpan > 0.25 && wristSpan < 6)) issues.push(`${prefix}: wrist span ${wristSpan.toFixed(3)}in outside 0.25..6in`);
    }

    for (const bone of pose.bones) {
      if (![...bone.a, ...bone.b].every(Number.isFinite)) issues.push(`${prefix}: ${bone.kind} has non-finite coordinates`);
      const length = Math.hypot(
        bone.b[0] - bone.a[0],
        bone.b[1] - bone.a[1],
        bone.b[2] - bone.a[2],
      );
      if (!(length > 0.01)) issues.push(`${prefix}: ${bone.kind} collapsed to ${length.toFixed(3)}in`);
      if (["metacarpal", "proximal", "middle", "distal"].includes(bone.kind) && length > 4) {
        issues.push(`${prefix}: ${bone.kind} is ${length.toFixed(3)}in, above the 4in finger-segment bound`);
      }
      if (bone.kind === "forearm" && length >= 30) issues.push(`${prefix}: forearm is ${length.toFixed(3)}in, above the 30in bound`);
    }
    for (const joint of pose.joints) {
      if (!joint.point.every(Number.isFinite)) issues.push(`${prefix}: ${joint.kind} joint has non-finite coordinates`);
    }
  }
  return issues.slice(0, 24);
}

function assertWindowMetadata(window: BrowserWindowResult, start: number, end: number, label: string): void {
  expect(window.poses.length, `${label}: no buffered motion poses`).toBeGreaterThan(0);

  for (const chunk of window.chunks) {
    const request = M1SampleMotionRequestSchema.parse(chunk.request);
    const result = M1SampleMotionResultSchema.parse(chunk.result);
    expect(request.maxPoses, `${label}: requested pose cap exceeded`).toBeLessThanOrEqual(200);
    expect(result.poses.length, `${label}: Worker exceeded the request pose cap`).toBeLessThanOrEqual(request.maxPoses);
    expect(result).toMatchObject({
      requestId: request.requestId,
      projectId: request.projectId,
      revision: request.revision,
      engineVersion: request.engineVersion,
      startTimeSeconds: request.startTimeSeconds,
      endTimeSeconds: request.endTimeSeconds,
    });
    if (result.truncated) {
      expect(result.continuationTimeSeconds, `${label}: truncated response omitted continuation`).toBeDefined();
      expect(result.continuationTimeSeconds!, `${label}: continuation did not advance`).toBeGreaterThan(request.startTimeSeconds);
      expect(result.continuationTimeSeconds!, `${label}: continuation exceeded demand`).toBeLessThanOrEqual(end + 1e-4);
    }
    for (let index = 1; index < result.poses.length; index += 1) {
      const previous = result.poses[index - 1]!;
      const current = result.poses[index]!;
      expect(current.transportTimeSeconds, `${label}: response poses are not in numeric time order`).toBeGreaterThanOrEqual(previous.transportTimeSeconds);
    }
    for (const hand of ["left", "right"] as const) {
      const times = result.poses.filter((pose) => pose.hand === hand).map((pose) => pose.transportTimeSeconds);
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index]! - times[index - 1]!, `${label}: ${hand} pose gap exceeds 250ms`).toBeLessThanOrEqual(0.250001);
      }
      const metadata = result.coverage?.[hand];
      if (metadata && metadata.poseCount > 0) {
        expect(metadata.coveredStartTimeSeconds, `${label}: ${hand} coverage starts after request`).toBeLessThanOrEqual(request.startTimeSeconds + 1e-4);
        // The Python sampling contract includes a 200ms forward-strike lookahead
        // in coverage metadata; the returned pose buffer itself remains un-clipped.
        expect(metadata.coveredEndTimeSeconds, `${label}: ${hand} coverage exceeds API lookahead`).toBeLessThanOrEqual(
          request.endTimeSeconds + SAMPLE_COVERAGE_LOOKAHEAD_SECONDS + 1e-4,
        );
        if (!result.truncated) {
          expect(metadata.coveredEndTimeSeconds, `${label}: ${hand} coverage ends before demand`).toBeGreaterThanOrEqual(request.endTimeSeconds - 1e-4);
          expect(metadata.isComplete, `${label}: ${hand} coverage is marked incomplete`).toBe(true);
        }
      }
    }
  }

  for (const hand of ["left", "right"] as const) {
    const times = window.poses.filter((pose) => pose.hand === hand).map((pose) => pose.transportTimeSeconds);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!, `${label}: buffered ${hand} pose gap exceeds 250ms`).toBeLessThanOrEqual(0.250001);
    }
  }
  expect(window.chunks.some((chunk) => chunk.covered), `${label}: MotionBuffer never verified full coverage`).toBe(true);
  for (const [hand, intervals] of Object.entries(window.coverage)) {
    expect(intervals.some((interval) => interval.start <= start + 1e-4 && interval.end >= end - 1e-4),
      `${label}: MotionBuffer did not verify ${hand} coverage for the full demand`).toBe(true);
  }
  const geometry = anatomicalIssues(window.poses);
  expect(geometry, `${label}: invalid sampled hand anatomy`).toEqual([]);
}

function assertMotionPoseParity(reference: MotionPose[], actual: MotionPose[], label: string): void {
  expect(actual.length, `${label}: pose count`).toBe(reference.length);
  const whiteKeyInches = 6.5 / 7;
  const tolerance = whiteKeyInches * 0.01;
  for (const [poseIndex, expectedPose] of reference.entries()) {
    const actualPose = actual[poseIndex]!;
    expect(actualPose.hand, `${label}: pose ${poseIndex} hand`).toBe(expectedPose.hand);
    expect(Math.abs(actualPose.transportTimeSeconds - expectedPose.transportTimeSeconds),
      `${label}: pose ${poseIndex} time delta`).toBeLessThanOrEqual(0.001);
    expect(actualPose.bones.length, `${label}: pose ${poseIndex} bone count`).toBe(expectedPose.bones.length);
    expect(actualPose.joints.length, `${label}: pose ${poseIndex} joint count`).toBe(expectedPose.joints.length);
    for (const [boneIndex, expectedBone] of expectedPose.bones.entries()) {
      const actualBone = actualPose.bones[boneIndex]!;
      expect(actualBone.kind, `${label}: pose ${poseIndex} bone ${boneIndex} kind`).toBe(expectedBone.kind);
      expect(actualBone.boneId, `${label}: pose ${poseIndex} bone ${boneIndex} identity`).toBe(expectedBone.boneId);
      for (let axis = 0; axis < 3; axis += 1) {
        expect(Math.abs(actualBone.a[axis]! - expectedBone.a[axis]!), `${label}: pose ${poseIndex} bone ${boneIndex} start axis ${axis}`).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(actualBone.b[axis]! - expectedBone.b[axis]!), `${label}: pose ${poseIndex} bone ${boneIndex} end axis ${axis}`).toBeLessThanOrEqual(tolerance);
      }
    }
    for (const [jointIndex, expectedJoint] of expectedPose.joints.entries()) {
      const actualJoint = actualPose.joints[jointIndex]!;
      expect(actualJoint.kind, `${label}: pose ${poseIndex} joint ${jointIndex} kind`).toBe(expectedJoint.kind);
      for (let axis = 0; axis < 3; axis += 1) {
        expect(Math.abs(actualJoint.point[axis]! - expectedJoint.point[axis]!), `${label}: pose ${poseIndex} joint ${jointIndex} axis ${axis}`).toBeLessThanOrEqual(tolerance);
      }
    }
  }
}

function buildEditedReplanRequest(
  base: M1AnalyzeMidiResult,
  midiBytes: Buffer,
  requestId: string,
): M1ReplanDocumentRequest {
  if (!base.document || !base.fingeringPlan) throw new Error("Cannot replan an invalid source result.");
  const target = base.fingeringPlan.assignments.find((assignment) =>
    assignment.disposition === "played" && assignment.fingerMode !== "manual" && assignment.glissMode !== "manual",
  );
  if (!target) throw new Error("The sample fixture has no automatic played assignment available for a manual edit.");
  const finger = target.finger === 1 ? 2 : 1;
  const revision = base.revision + 1;
  const document = {
    ...base.document,
    revision,
    notes: base.document.notes.map((note) => note.noteId === target.noteId ? { ...note, finger } : note),
  };
  const fingeringPlan = {
    ...base.fingeringPlan,
    planId: `${base.fingeringPlan.planId}-native-parity-edit`,
    inputRevision: revision,
    assignments: base.fingeringPlan.assignments.map((assignment) => assignment.noteId === target.noteId
      ? { ...assignment, finger, fingerMode: "manual" as const }
      : assignment),
  };
  return M1ReplanDocumentRequestSchema.parse({
    type: "replan-document",
    requestId,
    projectId: base.projectId,
    revision,
    engineVersion: base.engineVersion,
    midiBytes: bufferAsArrayBuffer(midiBytes),
    document,
    fingeringPlan,
    profile: base.profile,
    resource: base.resource,
    rawBaseline: base.rawBaseline,
    options: { fixtureId: base.rawBaseline.fixtureId, keyStyle: "realistic" },
  });
}

function replanParityProjection(result: M1ReplanDocumentResult) {
  return {
    status: result.status,
    keyStyle: result.keyStyle,
    notes: result.document?.notes.map((note) => ({
      noteId: note.noteId,
      sourceNoteIds: note.sourceNoteIds,
      pitch: note.pitch,
      startSeconds: note.startSeconds,
      endSeconds: note.endSeconds,
      hand: note.hand,
      finger: note.finger,
      glissando: note.glissando,
    })),
    assignments: result.fingeringPlan?.assignments.map((assignment) => ({
      noteId: assignment.noteId,
      hand: assignment.hand,
      finger: assignment.finger,
      fingerMode: assignment.fingerMode,
      glissMode: assignment.glissMode,
      disposition: assignment.disposition,
    })),
    events: result.performancePlan?.events.map((event) => ({
      type: event.type,
      noteId: "noteId" in event ? event.noteId : undefined,
      hand: "hand" in event ? event.hand : undefined,
      timeSeconds: event.timeSeconds,
    })),
  };
}

async function installBrowserHarness(page: Page): Promise<void> {
  await page.evaluate(() => {
    const global = window as unknown as { __nativeParityHarness?: BrowserHarness };
    const importModule = (url: string) => import(new URL(url, location.origin).href);
    const engines = new Map<EngineName, {
      worker: Worker;
      client: typeof import("../../apps/client/src/m1WorkerClient");
      actualEngine: EngineName | undefined;
      profile: PianistProfile;
      engineLoaded: M1EngineLoadResult;
    }>();

    function terminal<T>(
      worker: Worker,
      identity: Pick<WorkerEnvelope, "requestId" | "projectId" | "revision">,
      expectedType: string,
      send: () => void,
      timeoutMs = 120_000,
    ): Promise<T> {
      return new Promise((resolve, reject) => {
        const finish = (error?: Error, value?: unknown) => {
          clearTimeout(timer);
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          worker.removeEventListener("messageerror", onMessageError);
          if (error) reject(error);
          else resolve(value as T);
        };
        const timer = setTimeout(() => finish(new Error(`${expectedType} timed out after ${timeoutMs}ms`)), timeoutMs);
        const onMessage = (event: MessageEvent<unknown>) => {
          const message = event.data as Record<string, unknown>;
          if (message.requestId !== identity.requestId || message.projectId !== identity.projectId || message.revision !== identity.revision) return;
          if (message.type === "worker-error") {
            const detail = message.error as { code?: string; message?: string } | undefined;
            finish(new Error(`${detail?.code ?? "WORKER_ERROR"}: ${detail?.message ?? "unknown Worker failure"}`));
          } else if (message.type === expectedType) {
            finish(undefined, message);
          }
        };
        const onError = (event: ErrorEvent) => finish(new Error(event.message || "Worker crashed"));
        const onMessageError = () => finish(new Error("Worker response could not be decoded"));
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.addEventListener("messageerror", onMessageError);
        try {
          send();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }

    const harness: BrowserHarness = {
      async open(engine) {
        const client = await importModule("/src/m1WorkerClient.ts") as typeof import("../../apps/client/src/m1WorkerClient");
        const { DEFAULT_PROFILE } = await importModule("/src/profiles/defaultProfiles.ts") as typeof import("../../apps/client/src/profiles/defaultProfiles");
        const pyManifestResponse = await fetch("/python-core/source_manifest.json", { cache: "no-store" });
        if (!pyManifestResponse.ok) throw new Error(`Python core manifest returned HTTP ${pyManifestResponse.status}`);
        const pyManifest = await pyManifestResponse.json() as { engineVersion: string };
        const worker = client.createM1AnalysisWorker(engine) as Worker;
        const actualEngine = client.getM1AnalysisWorkerEngine(worker);
        const loadRequest = {
          type: "engine-load" as const,
          requestId: `native-parity-load-${engine}`,
          projectId: `native-parity-load-project-${engine}`,
          revision: 0,
          engineVersion: pyManifest.engineVersion,
        };
        const engineLoaded = await terminal<M1EngineLoadResult>(
          worker,
          loadRequest,
          "engine-loaded",
          () => worker.postMessage(loadRequest),
        );
        engines.set(engine, { worker, client, actualEngine, profile: DEFAULT_PROFILE, engineLoaded });
        return { actualEngine, engineLoaded, profile: DEFAULT_PROFILE };
      },

      async analyze(args) {
        const entry = engines.get(args.engine);
        if (!entry) throw new Error("The selected parity Worker has not been opened.");
        const midiBytes = Uint8Array.from(args.midiBytes).buffer as ArrayBuffer;
        const request = {
          type: "analyze-midi" as const,
          requestId: args.requestId,
          projectId: args.projectId,
          revision: args.revision,
          engineVersion: args.engineVersion,
          midiBytes,
          profile: entry.profile,
          options: { fixtureId: args.fixtureId, keyStyle: "realistic" as const, sampleDense: true },
        };
        return terminal<M1AnalyzeMidiResult>(entry.worker, request, "analysis-result", () => {
          entry.client.postM1AnalyzeMidiRequest(entry.worker, request);
        });
      },

      async replan(args) {
        const entry = engines.get(args.engine);
        if (!entry) throw new Error(`The ${args.engine} parity Worker has not been opened.`);
        const request = { ...args.request, midiBytes: Uint8Array.from(args.midiBytes).buffer as ArrayBuffer } as M1ReplanDocumentRequest;
        return terminal<M1ReplanDocumentResult>(entry.worker, request, "replan-document-result", () => {
          entry.client.postM1ReplanDocumentRequest(entry.worker, request);
        });
      },

      async sampleWindow(args) {
        const entry = engines.get(args.engine);
        if (!entry) throw new Error(`The ${args.engine} parity Worker has not been opened.`);
        const { MotionStreamController } = await importModule("/src/player/motionStreamController.ts") as typeof import("../../apps/client/src/player/motionStreamController");
        const { MotionBuffer } = await importModule("/src/render/motionBuffer.ts") as typeof import("../../apps/client/src/render/motionBuffer");
        const chunks: BrowserSampleChunk[] = [];
        const motionBuffer = new MotionBuffer();
        let controller: InstanceType<typeof MotionStreamController> | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await new Promise<BrowserWindowResult>((resolve, reject) => {
            controller = new MotionStreamController({
              worker: entry.worker,
              identity: args.identity,
              timeoutMs: 90_000,
              requestIdFactory: (() => {
                let index = 0;
                return () => `${args.requestIdPrefix}-${index++}`;
              })(),
              onResult: (sample, flight) => {
                const request = flight.request as M1SampleMotionRequest;
                const validated = sample as M1SampleMotionResult;
                motionBuffer.addSampleMotionResult(validated);
                const activeHands = Object.keys(validated.coverage ?? {})
                  .filter((hand) => validated.coverage?.[hand as "left" | "right"]?.poseCount)
                  .filter((hand): hand is "left" | "right" => hand === "left" || hand === "right");
                motionBuffer.setExpectedHands(activeHands);
                const covered = motionBuffer.hasCoverage(args.startTimeSeconds, args.endTimeSeconds);
                chunks.push({ request, result: validated, covered });
                if (covered) {
                  const coverage = {
                    left: motionBuffer.getHandCoverageIntervals("left").map((interval) => ({ start: interval.start, end: interval.end })),
                    right: motionBuffer.getHandCoverageIntervals("right").map((interval) => ({ start: interval.start, end: interval.end })),
                  };
                  resolve({
                    chunks,
                    poses: motionBuffer.poses.filter((pose) =>
                      pose.transportTimeSeconds >= args.startTimeSeconds - 1e-4 &&
                      pose.transportTimeSeconds <= args.endTimeSeconds + 1e-4,
                    ),
                    coverage,
                  });
                }
                return !covered;
              },
              onError: (error) => reject(new Error(`${error.code}: ${error.message}`)),
            });
            timeout = setTimeout(() => reject(new Error("MotionStreamController did not cover the requested interval")), 100_000);
            controller.requestWindow(args.startTimeSeconds, args.endTimeSeconds, 200);
          });
          return result;
        } finally {
          if (timeout) clearTimeout(timeout);
          controller?.dispose();
        }
      },

      close(engine) {
        engines.get(engine)?.worker.terminate();
        engines.delete(engine);
      },
    };
    global.__nativeParityHarness = harness;
  });
}

async function browserHarness(page: Page): Promise<BrowserHarness> {
  return {
    open: async (engine) => await page.evaluate(async (selected: EngineName) => {
      const harness = (window as unknown as { __nativeParityHarness?: BrowserHarness }).__nativeParityHarness;
      if (!harness) throw new Error("Native parity browser harness was not installed.");
      return harness.open(selected);
    }, engine) as Awaited<ReturnType<BrowserHarness["open"]>>,
    analyze: async (args) => await page.evaluate(async (request: Parameters<BrowserHarness["analyze"]>[0]) => {
      const harness = (window as unknown as { __nativeParityHarness?: BrowserHarness }).__nativeParityHarness;
      if (!harness) throw new Error("Native parity browser harness was not installed.");
      return harness.analyze(request);
    }, args) as M1AnalyzeMidiResult,
    // @ts-expect-error -- Playwright's serialized evaluate generic is too deep for this harness type.
    replan: async (args) => await page.evaluate(async (request: Parameters<BrowserHarness["replan"]>[0]) => {
      const harness = (window as unknown as { __nativeParityHarness?: BrowserHarness }).__nativeParityHarness;
      if (!harness) throw new Error("Native parity browser harness was not installed.");
      return harness.replan(request);
    }, args) as M1ReplanDocumentResult,
    sampleWindow: async (args) => await page.evaluate(async (request: Parameters<BrowserHarness["sampleWindow"]>[0]) => {
      const harness = (window as unknown as { __nativeParityHarness?: BrowserHarness }).__nativeParityHarness;
      if (!harness) throw new Error("Native parity browser harness was not installed.");
      return harness.sampleWindow(request);
    }, args) as BrowserWindowResult,
    close: (engine) => page.evaluate((selected: EngineName) => {
      const harness = (window as unknown as { __nativeParityHarness?: BrowserHarness }).__nativeParityHarness;
      if (!harness) throw new Error("Native parity browser harness was not installed.");
      harness.close(selected);
    }, engine),
  };
}

test.describe.serial("Native TypeScript and Python Worker parity", () => {
  test("real Workers match all desktop golden fixtures and bounded motion coverage", async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    expect(fixtureIds).toHaveLength(13);

    const pageErrors: string[] = [];
    const workerUrls: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
    page.on("worker", (worker) => workerUrls.push(worker.url()));

    // The manifest route is a tiny Vite-served page: all calculations below
    // still pass through the production factory and its real module Workers.
    await page.goto("/manifest.webmanifest");
    await installBrowserHarness(page);
    const harness = await browserHarness(page);

    const report: {
      engines: Record<string, { runtime: string; runtimeVersion: string; pythonVersion: string; packageVersions: Record<string, string>; engineVersion: string; actualFactoryEngine: string | undefined; workerUrl?: string }>;
      fixtures: Array<{ engine: EngineName; fixtureId: string; status: string; counts: FixtureParity["actualCounts"]; checkedPosePairs: number; differences: number }>;
      windows: Array<{ engine: EngineName; phase: "analyzed" | "replanned" | "restored"; start: number; end: number; chunks: number; poses: number; covered: Record<string, { start: number; end: number }[]> }>;
      restoredWorkerLoads: Array<{ engine: EngineName; runtime: string; runtimeVersion: string; engineVersion: string }>;
      builtinChopsticks: { assetSha256: string; byteLength: number; parity?: { counts: FixtureParity["actualCounts"]; checkedPosePairs: number; differences: number }; replanParity?: boolean };
      errors: string[];
    } = {
      engines: {},
      fixtures: [],
      windows: [],
      restoredWorkerLoads: [],
      builtinChopsticks: { assetSha256: chopsticksSha256, byteLength: chopsticksMidiBytes.byteLength },
      errors: pageErrors,
    };
    const sampleResults = new Map<string, BrowserWindowResult>();
    const replanResults = new Map<EngineName, M1ReplanDocumentResult>();
    const restoredReplanResults = new Map<EngineName, M1ReplanDocumentResult>();
    const builtinAnalysisResults = new Map<EngineName, M1AnalyzeMidiResult>();
    const builtinReplanResults = new Map<EngineName, M1ReplanDocumentResult>();
    const sampleFixture = "tracked-demo-song";

    for (const engine of ["typescript", "python"] as const) {
      const opened = await harness.open(engine);
      const loaded = M1EngineLoadResultSchema.parse(opened.engineLoaded);
      expect(loaded).toMatchObject({
        requestId: `native-parity-load-${engine}`,
        projectId: `native-parity-load-project-${engine}`,
        revision: 0,
      });
      expect(opened.actualEngine, `${engine}: factory selected the wrong Worker`).toBe(engine);
      expect(loaded.runtime, `${engine}: Worker loaded the wrong runtime`).toBe(engine === "typescript" ? "typescript" : "pyodide");
      expect(loaded.engineVersion).toMatch(/^[a-f0-9]{64}$/);
      expect(loaded.engineVersion, `${engine}: contract version must identify the Python musical compatibility baseline`).toBe(coreManifest.engineVersion);
      if (engine === "typescript") {
        expect(loaded.runtimeVersion, "TypeScript runtime version must come from the engine package").toBe(enginePackage.version);
        expect(loaded.packageVersions["@handthesia/engine-ts"]).toBe(enginePackage.version);
      } else {
        expect(loaded.runtimeVersion).toBe(pyodideRuntime.runtime.version);
        expect(loaded.pythonVersion).toBe(pyodideRuntime.runtime.pythonVersion);
      }
      report.engines[engine] = {
        runtime: loaded.runtime,
        runtimeVersion: loaded.runtimeVersion,
        pythonVersion: loaded.pythonVersion,
        packageVersions: loaded.packageVersions,
        engineVersion: loaded.engineVersion,
        actualFactoryEngine: opened.actualEngine,
      };
      const currentWorkerUrl = [...workerUrls].reverse().find((url) => engine === "typescript"
        ? url.includes("midi-analysis-ts.worker")
        : url.includes("midi-analysis.worker") && !url.includes("midi-analysis-ts.worker"));
      await testInfo.attach(`native-parity-${engine}-engine-load.json`, {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({
          runtime: loaded.runtime,
          runtimeVersion: loaded.runtimeVersion,
          pythonVersion: loaded.pythonVersion,
          packageVersions: loaded.packageVersions,
          engineVersion: loaded.engineVersion,
          actualFactoryEngine: opened.actualEngine,
          workerUrl: currentWorkerUrl,
        }, null, 2)),
      });

      const loadedProfile = opened.profile;
      let sampleBase: M1AnalyzeMidiResult | undefined;
      let sampleBytes: Buffer | undefined;
      for (const fixtureId of fixtureIds) {
        const source = fixtureManifest.fixtureSources[fixtureId]!;
        const bytes = fs.readFileSync(path.resolve(FIXTURES_DIR, source.fixturePath));
        const hash = createHash("sha256").update(bytes).digest("hex");
        expect(hash, `${fixtureId}: fixture bytes do not match manifest`).toBe(source.fixtureSha256);
        const projectId = `native-parity-${fixtureId}`;
        const requestId = `native-parity-${engine}-${fixtureId}-analyze`;
        const result = await harness.analyze({
          engine,
          fixtureId,
          projectId,
          revision: 0,
          requestId,
          engineVersion: loaded.engineVersion,
          midiBytes: [...bytes],
        });
        const request = M1AnalyzeMidiRequestSchema.parse({
          type: "analyze-midi",
          requestId,
          projectId,
          revision: 0,
          engineVersion: loaded.engineVersion,
          midiBytes: bufferAsArrayBuffer(bytes),
          profile: loadedProfile,
          options: { fixtureId, keyStyle: "realistic", sampleDense: true },
        });
        const validated = validateM1AnalyzeMidiResultForRequest(request, result);
        const golden: GoldenFixture = JSON.parse(fs.readFileSync(path.resolve(GOLDEN_DIR, `${fixtureId}.json`), "utf8"));
        const parity = compareM1ResultToGolden(validated, golden);
        expect(parity.differences, `${engine}/${fixtureId}: ${JSON.stringify(parity.differences.slice(0, 12))}`).toEqual([]);

        if (validated.status !== "invalid") {
          expect(validated.document, `${engine}/${fixtureId}: valid input omitted its document`).not.toBeNull();
          expect(validated.fingeringPlan, `${engine}/${fixtureId}: valid input omitted its fingering plan`).not.toBeNull();
          if ((validated.document?.notes.length ?? 0) > 0 && (validated.document?.durationSeconds ?? 0) > 0) {
            expect(validated.initialMotionWindow, `${engine}/${fixtureId}: sampleDense omitted the bounded startup window`).toBeDefined();
            expect(validated.initialMotionWindow!.poses.length, `${engine}/${fixtureId}: empty startup window`).toBeGreaterThan(0);
            expect(validated.initialMotionWindow!.poses.length, `${engine}/${fixtureId}: startup pose cap exceeded`).toBeLessThanOrEqual(200);
            const geometry = anatomicalIssues(validated.initialMotionWindow!.poses);
            expect(geometry, `${engine}/${fixtureId}: invalid startup hand anatomy`).toEqual([]);
          }
        } else {
          expect(validated.document).toBeNull();
          expect(validated.diagnostics.length).toBeGreaterThan(0);
        }

        report.fixtures.push({
          engine,
          fixtureId,
          status: validated.status,
          counts: parity.actualCounts,
          checkedPosePairs: parity.checkedPosePairs,
          differences: parity.differences.length,
        });

        if (fixtureId === sampleFixture) {
          sampleBase = validated;
          sampleBytes = bytes;
          const identity = {
            projectId: validated.projectId,
            revision: validated.revision,
            engineVersion: validated.engineVersion,
          };
          for (const [start, end] of [[8.75, 12.75], [98.75, 102.75]] as const) {
            const window = await harness.sampleWindow({
              engine,
              identity,
              startTimeSeconds: start,
              endTimeSeconds: end,
              requestIdPrefix: `native-parity-${engine}-base-${start}`,
            });
            assertWindowMetadata(window, start, end, `${engine} analyzed ${start}..${end}`);
            const key = `${engine}:analyzed:${start}`;
            sampleResults.set(key, window);
            report.windows.push({ engine, phase: "analyzed", start, end, chunks: window.chunks.length, poses: window.poses.length, covered: window.coverage });
          }

          const replanRequest = buildEditedReplanRequest(
            validated,
            bytes,
            `native-parity-${engine}-${sampleFixture}-edit`,
          );
          const replanResult = await harness.replan({
            engine,
            request: withoutMidiBytes(replanRequest),
            midiBytes: [...bytes],
          });
          const checkedReplan = validateM1ReplanDocumentResultForRequest(replanRequest, replanResult);
          const editedTarget = replanRequest.fingeringPlan.assignments.find((assignment) => assignment.fingerMode === "manual")!;
          expect(checkedReplan.fingeringPlan!.assignments.find((assignment) => assignment.noteId === editedTarget.noteId)).toMatchObject({
            finger: editedTarget.finger,
            fingerMode: "manual",
          });
          expect(checkedReplan.document!.notes.find((note) => note.noteId === editedTarget.noteId)?.finger).toBe(editedTarget.finger);
          replanResults.set(engine, checkedReplan);

          const replannedWindow = await harness.sampleWindow({
            engine,
            identity: {
              projectId: checkedReplan.projectId,
              revision: checkedReplan.revision,
              engineVersion: checkedReplan.engineVersion,
            },
            startTimeSeconds: 98.75,
            endTimeSeconds: 102.75,
            requestIdPrefix: `native-parity-${engine}-replanned-98.75`,
          });
          assertWindowMetadata(replannedWindow, 98.75, 102.75, `${engine} replanned 98.75..102.75`);
          sampleResults.set(`${engine}:replanned:98.75`, replannedWindow);
          report.windows.push({ engine, phase: "replanned", start: 98.75, end: 102.75, chunks: replannedWindow.chunks.length, poses: replannedWindow.poses.length, covered: replannedWindow.coverage });

          // Recreate the source on a fresh real Worker, restore the edited
          // document/plan, then verify that its cold motion context is usable.
          harness.close(engine);
          const restoredOpened = await harness.open(engine);
          const restoredLoaded = M1EngineLoadResultSchema.parse(restoredOpened.engineLoaded);
          expect(restoredLoaded).toMatchObject({
            requestId: `native-parity-load-${engine}`,
            projectId: `native-parity-load-project-${engine}`,
            revision: 0,
          });
          expect(restoredOpened.actualEngine).toBe(engine);
          expect(restoredLoaded.runtime).toBe(engine === "typescript" ? "typescript" : "pyodide");
          expect(restoredLoaded.runtimeVersion).toBe(loaded.runtimeVersion);
          expect(restoredLoaded.engineVersion).toBe(loaded.engineVersion);
          report.restoredWorkerLoads.push({
            engine,
            runtime: restoredLoaded.runtime,
            runtimeVersion: restoredLoaded.runtimeVersion,
            engineVersion: restoredLoaded.engineVersion,
          });
          const restoreSourceRequestId = `native-parity-${engine}-${sampleFixture}-restore-source`;
          const restoreSourceRaw = await harness.analyze({
            engine,
            fixtureId: sampleFixture,
            projectId: validated.projectId,
            revision: 1,
            requestId: restoreSourceRequestId,
            engineVersion: restoredLoaded.engineVersion,
            midiBytes: [...bytes],
          });
          const restoreSourceRequest = M1AnalyzeMidiRequestSchema.parse({
            type: "analyze-midi",
            requestId: restoreSourceRequestId,
            projectId: validated.projectId,
            revision: 1,
            engineVersion: restoredLoaded.engineVersion,
            midiBytes: bufferAsArrayBuffer(bytes),
            profile: restoredOpened.profile,
            options: { fixtureId: sampleFixture, keyStyle: "realistic", sampleDense: true },
          });
          const restoreSource = validateM1AnalyzeMidiResultForRequest(restoreSourceRequest, restoreSourceRaw);
          const restoreRequest = M1ReplanDocumentRequestSchema.parse({
            type: "replan-document",
            requestId: `native-parity-${engine}-${sampleFixture}-restore-replan`,
            projectId: restoreSource.projectId,
            revision: 1,
            engineVersion: restoredLoaded.engineVersion,
            midiBytes: bufferAsArrayBuffer(bytes),
            document: checkedReplan.document,
            fingeringPlan: checkedReplan.fingeringPlan,
            profile: restoreSource.profile,
            resource: restoreSource.resource,
            rawBaseline: restoreSource.rawBaseline,
            options: { fixtureId: sampleFixture, keyStyle: "realistic" },
          });
          const restoreResultRaw = await harness.replan({
            engine,
            request: withoutMidiBytes(restoreRequest),
            midiBytes: [...bytes],
          });
          const restoreResult = validateM1ReplanDocumentResultForRequest(restoreRequest, restoreResultRaw);
          expect(replanParityProjection(restoreResult)).toEqual(replanParityProjection(checkedReplan));
          restoredReplanResults.set(engine, restoreResult);
          const restoredWindow = await harness.sampleWindow({
            engine,
            identity: {
              projectId: restoreResult.projectId,
              revision: restoreResult.revision,
              engineVersion: restoreResult.engineVersion,
            },
            startTimeSeconds: 98.75,
            endTimeSeconds: 102.75,
            requestIdPrefix: `native-parity-${engine}-restored-98.75`,
          });
          assertWindowMetadata(restoredWindow, 98.75, 102.75, `${engine} restored 98.75..102.75`);
          sampleResults.set(`${engine}:restored:98.75`, restoredWindow);
          report.windows.push({ engine, phase: "restored", start: 98.75, end: 102.75, chunks: restoredWindow.chunks.length, poses: restoredWindow.poses.length, covered: restoredWindow.coverage });
        }
      }
      expect(sampleBase, `${engine}: sample fixture was not analyzed`).toBeDefined();
      expect(sampleBytes, `${engine}: source bytes for the replan fixture were lost`).toBeDefined();

      const builtinFixtureId = "builtin-chopsticks";
      const builtinProjectId = `native-parity-${builtinFixtureId}`;
      const builtinRequestId = `native-parity-${engine}-${builtinFixtureId}-analyze`;
      const builtinRawResult = await harness.analyze({
        engine,
        fixtureId: builtinFixtureId,
        projectId: builtinProjectId,
        revision: 0,
        requestId: builtinRequestId,
        engineVersion: loaded.engineVersion,
        midiBytes: [...chopsticksMidiBytes],
      });
      const builtinRequest = M1AnalyzeMidiRequestSchema.parse({
        type: "analyze-midi",
        requestId: builtinRequestId,
        projectId: builtinProjectId,
        revision: 0,
        engineVersion: loaded.engineVersion,
        midiBytes: bufferAsArrayBuffer(chopsticksMidiBytes),
        profile: loadedProfile,
        options: { fixtureId: builtinFixtureId, keyStyle: "realistic", sampleDense: true },
      });
      const builtinResult = validateM1AnalyzeMidiResultForRequest(builtinRequest, builtinRawResult);
      expect(builtinResult.status, `${engine}: canonical Chopsticks MIDI did not load`).not.toBe("invalid");
      expect(builtinResult.rawBaseline.inputSha256, `${engine}: Worker did not retain the catalog asset identity`).toBe(chopsticksSha256);
      expect(builtinResult.document?.notes.length, `${engine}: Chopsticks has no normalized notes`).toBeGreaterThan(0);
      expect(builtinResult.initialMotionWindow?.poses.length, `${engine}: Chopsticks has no startup hand poses`).toBeGreaterThan(0);
      expect(anatomicalIssues(builtinResult.initialMotionWindow!.poses), `${engine}: Chopsticks startup hand anatomy`).toEqual([]);
      builtinAnalysisResults.set(engine, builtinResult);

      const builtinReplanRequest = buildEditedReplanRequest(
        builtinResult,
        chopsticksMidiBytes,
        `native-parity-${engine}-${builtinFixtureId}-edit`,
      );
      const builtinReplanRaw = await harness.replan({
        engine,
        request: withoutMidiBytes(builtinReplanRequest),
        midiBytes: [...chopsticksMidiBytes],
      });
      const builtinReplan = validateM1ReplanDocumentResultForRequest(builtinReplanRequest, builtinReplanRaw);
      const builtinEditedTarget = builtinReplanRequest.fingeringPlan.assignments.find((assignment) => assignment.fingerMode === "manual")!;
      expect(builtinReplan.fingeringPlan!.assignments.find((assignment) => assignment.noteId === builtinEditedTarget.noteId)).toMatchObject({
        finger: builtinEditedTarget.finger,
        fingerMode: "manual",
      });
      builtinReplanResults.set(engine, builtinReplan);
      harness.close(engine);
    }

    for (const start of [8.75, 98.75]) {
      const python = sampleResults.get(`python:analyzed:${start}`)!;
      const typescript = sampleResults.get(`typescript:analyzed:${start}`)!;
      assertMotionPoseParity(python.poses, typescript.poses, `analyzed ${start}..${start + 4}s Python/TypeScript sample`);
    }
    assertMotionPoseParity(
      sampleResults.get("python:replanned:98.75")!.poses,
      sampleResults.get("typescript:replanned:98.75")!.poses,
      "replanned 98.75..102.75s Python/TypeScript sample",
    );
    assertMotionPoseParity(
      sampleResults.get("python:restored:98.75")!.poses,
      sampleResults.get("typescript:restored:98.75")!.poses,
      "restored 98.75..102.75s Python/TypeScript sample",
    );
    expect(replanParityProjection(replanResults.get("typescript")!)).toEqual(replanParityProjection(replanResults.get("python")!));
    expect(replanParityProjection(restoredReplanResults.get("typescript")!)).toEqual(replanParityProjection(restoredReplanResults.get("python")!));

    const pythonChopsticks = builtinAnalysisResults.get("python")!;
    const typescriptChopsticks = builtinAnalysisResults.get("typescript")!;
    const chopsticksParity = compareM1ResultToGolden(
      typescriptChopsticks,
      goldenFromPythonResult(pythonChopsticks, "builtin-chopsticks"),
    );
    expect(chopsticksParity.differences, `typescript/builtin-chopsticks: ${JSON.stringify(chopsticksParity.differences.slice(0, 12))}`).toEqual([]);
    report.builtinChopsticks.parity = {
      counts: chopsticksParity.actualCounts,
      checkedPosePairs: chopsticksParity.checkedPosePairs,
      differences: chopsticksParity.differences.length,
    };
    expect(replanParityProjection(builtinReplanResults.get("typescript")!)).toEqual(replanParityProjection(builtinReplanResults.get("python")!));
    report.builtinChopsticks.replanParity = true;

    const nativeUrl = workerUrls.find((url) => url.includes("midi-analysis-ts.worker"));
    const pythonUrl = workerUrls.find((url) => url.includes("midi-analysis.worker") && !url.includes("midi-analysis-ts.worker"));
    expect(nativeUrl, "the real TypeScript module Worker was not observed").toBeTruthy();
    expect(pythonUrl, "the real Python module Worker was not observed").toBeTruthy();
    report.engines.typescript!.workerUrl = nativeUrl;
    report.engines.python!.workerUrl = pythonUrl;
    report.errors = pageErrors;
    expect(pageErrors).toEqual([]);

    await testInfo.attach("native-python-parity-report.json", {
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({
        fixtureCount: fixtureIds.length,
        fixtureIds,
        engineVersionsEqual: report.engines.python!.engineVersion === report.engines.typescript!.engineVersion,
        ...report,
      }, null, 2)),
    });
  });
});
