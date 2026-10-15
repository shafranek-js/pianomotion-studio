import { expect, test } from "@playwright/test";
import type {
  M1AnalyzeMidiRequest,
  M1AnalyzeMidiResult,
  M1EngineMessage,
  M1ReplanDocumentRequest,
  M1ReplanDocumentResult,
  M1SampleMotionRequest,
  M1SampleMotionResult,
} from "@handthesia/contracts";
import type {
  MotionStreamController as MotionStreamControllerType,
  MotionStreamError,
  MotionStreamFlight,
} from "../../apps/client/src/player/motionStreamController";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIDI_BYTES = fs.readFileSync(path.resolve(__dirname, "../fixtures/midi/tracked-demo-song.mid"));
const MIDI_BASE64 = MIDI_BYTES.toString("base64");

type BrowserWorkerClient = typeof import("../../apps/client/src/m1WorkerClient");
type WorkerRequestIdentity = {
  type: string;
  requestId: string;
  projectId: string;
  revision: number;
  engineVersion: string;
};

test("real Worker analyzes, replans, streams, restores, and filters stale motion requests", async ({ page }) => {
  test.setTimeout(300_000);
  // This static JSON document keeps the test away from Player/UI helpers. The
  // Vite-served TypeScript client below still creates the production module Worker.
  await page.goto("/manifest.webmanifest");

  const result = await page.evaluate(async (encodedMidi) => {
    const importBrowserModule = (url: string) => import(new URL(url, location.origin).href);
    const client = await importBrowserModule("/src/m1WorkerClient.ts") as BrowserWorkerClient;
    const { MotionStreamController } = await importBrowserModule("/src/player/motionStreamController.ts") as typeof import("../../apps/client/src/player/motionStreamController");
    const coreManifestResponse = await fetch("/python-core/source_manifest.json", { cache: "no-store" });
    if (!coreManifestResponse.ok) throw new Error(`Python source manifest returned ${coreManifestResponse.status}`);
    const coreManifest = await coreManifestResponse.json() as { engineVersion: string };
    const engineVersion = coreManifest.engineVersion;
    const raw = Uint8Array.from(atob(encodedMidi), character => character.charCodeAt(0));
    const midiBytes = raw.buffer as ArrayBuffer;
    const projectId = `motion-browser-${crypto.randomUUID()}`;
    const requestId = (stage: string) => `motion-browser-${stage}-${crypto.randomUUID()}`;
    const identity = (revision: number) => ({ projectId, revision, engineVersion });

    function requestTerminal<TResult>(worker: Worker, request: WorkerRequestIdentity, terminalType: string, send: () => void, timeoutMs = 120_000): Promise<TResult> {
      return new Promise((resolve, reject) => {
        const finish = (error?: Error, value?: unknown) => {
          clearTimeout(timer);
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          worker.removeEventListener("messageerror", onMessageError);
          if (error) reject(error);
          else resolve(value as TResult);
        };
        const timer = setTimeout(() => finish(new Error(`${request.type} timed out after ${timeoutMs}ms`)), timeoutMs);
        const onMessage = (event: MessageEvent<unknown>) => {
          const message = event.data as M1EngineMessage;
          if (message?.requestId !== request.requestId || message?.projectId !== request.projectId ||
              message?.revision !== request.revision || message?.engineVersion !== request.engineVersion) return;
          if (message.type === "worker-error") {
            finish(new Error(`${message.error.code}: ${message.error.message}`));
          } else if (message.type === terminalType) {
            finish(undefined, message as TResult);
          }
        };
        const onError = (event: ErrorEvent) => finish(new Error(event.message || "Worker crashed"));
        const onMessageError = () => finish(new Error("Worker message could not be decoded"));
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.addEventListener("messageerror", onMessageError);
        try { send(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
    }

    function makeAnalyzeRequest(revision: number, dense: boolean): M1AnalyzeMidiRequest {
      return {
        type: "analyze-midi",
        requestId: requestId(`analyze-r${revision}`),
        ...identity(revision),
        midiBytes,
        options: { fixtureId: "tracked-demo-song", keyStyle: "realistic", sampleDense: dense },
      };
    }

    async function analyze(worker: Worker, revision: number, dense: boolean): Promise<M1AnalyzeMidiResult> {
      const request = makeAnalyzeRequest(revision, dense);
      return requestTerminal<M1AnalyzeMidiResult>(worker, request, "analysis-result", () => client.postM1AnalyzeMidiRequest(worker, request));
    }

    async function replan(
      worker: Worker,
      base: M1AnalyzeMidiResult,
      document: NonNullable<M1AnalyzeMidiResult["document"]>,
      plan: NonNullable<M1AnalyzeMidiResult["fingeringPlan"]>,
      revision: number,
      keyStyle: "realistic" | "equal",
    ): Promise<M1ReplanDocumentResult> {
      const request: M1ReplanDocumentRequest = {
        type: "replan-document",
        requestId: requestId(`replan-r${revision}`),
        ...identity(revision),
        midiBytes,
        document,
        fingeringPlan: plan,
        profile: base.profile,
        resource: base.resource,
        rawBaseline: base.rawBaseline,
        options: { fixtureId: "tracked-demo-song", keyStyle },
      };
      return requestTerminal<M1ReplanDocumentResult>(worker, request, "replan-document-result", () => client.postM1ReplanDocumentRequest(worker, request));
    }

    async function stream(worker: Worker, revision: number, startTimeSeconds: number, endTimeSeconds: number): Promise<M1SampleMotionResult> {
      const request: M1SampleMotionRequest = {
        type: "sample-motion",
        requestId: requestId(`stream-r${revision}`),
        ...identity(revision),
        startTimeSeconds,
        endTimeSeconds,
        maxPoses: 200,
      };
      return requestTerminal<M1SampleMotionResult>(worker, request, "sample-motion-result", () => client.postM1SampleMotionRequest(worker, request));
    }

    const worker = client.createM1AnalysisWorker() as Worker;
    let restoredWorker: Worker | null = null;
    let controller: MotionStreamControllerType | null = null;
    try {
      const analysis = await analyze(worker, 1, true);
      if (analysis.status !== "loaded" || !analysis.document || !analysis.fingeringPlan || !analysis.initialMotionWindow) {
        throw new Error("Real Worker analysis omitted a playable plan or bounded initial motion window.");
      }
      const firstStream = await stream(worker, 1, 0, 2);
      if (firstStream.poses.length === 0) throw new Error("Real Worker stream returned no poses after analysis.");

      const nextRevision = 2;
      const editedDocument = { ...analysis.document, revision: nextRevision };
      const editedPlan = {
        ...analysis.fingeringPlan,
        planId: `motion-replan-${crypto.randomUUID()}`,
        inputRevision: nextRevision,
      };
      const replanned = await replan(worker, analysis, editedDocument, editedPlan, nextRevision, "equal");
      if (replanned.revision !== nextRevision || replanned.keyStyle !== "equal" ||
          !replanned.initialMotionWindow || replanned.initialMotionWindow.poses.length === 0) {
        throw new Error("Real Worker replan did not return a fresh bounded initial window for the current revision.");
      }
      const replannedStream = await stream(worker, nextRevision, 0, 2);
      if (replannedStream.revision !== nextRevision || replannedStream.poses.length === 0) {
        throw new Error("Real Worker did not stream the replanned revision from its cached context.");
      }

      // A restored project first reanalyzes original bytes on a new Worker,
      // then reapplies the saved document and fingering plan before streaming.
      restoredWorker = client.createM1AnalysisWorker() as Worker;
      const restoredSource = await analyze(restoredWorker, nextRevision, false);
      if (restoredSource.status === "invalid" || !restoredSource.document || !restoredSource.fingeringPlan) {
        throw new Error("A fresh Worker could not recreate the source document before restoring the saved plan.");
      }
      if (!replanned.document || !replanned.fingeringPlan) {
        throw new Error("The replanned project omitted the document or fingering plan required for restore.");
      }
      const restoredReplan = await replan(
        restoredWorker,
        restoredSource,
        replanned.document,
        replanned.fingeringPlan,
        nextRevision,
        "equal",
      );
      const restoredStream = await stream(restoredWorker, nextRevision, 0, 2);
      if (restoredReplan.revision !== nextRevision || restoredStream.revision !== nextRevision || restoredStream.poses.length === 0) {
        throw new Error("A fresh Worker could not restore the saved source context and continue streaming.");
      }

      const controllerResults: Array<{ requestId: string; revision: number; seekEpoch: number }> = [];
      const controllerErrors: Array<{ code: string; revision: number | null; retryable: boolean }> = [];
      const activeIdentity = identity(nextRevision);
      let resultHandler = (_message: M1SampleMotionResult, flight: MotionStreamFlight): boolean => {
        controllerResults.push({ requestId: flight.request.requestId, revision: flight.request.revision, seekEpoch: flight.seekEpoch });
        return false;
      };
      let errorHandler = (error: MotionStreamError, flight: MotionStreamFlight | null, retryable: boolean): void => {
        controllerErrors.push({ code: error.code, revision: flight?.request.revision ?? null, retryable });
      };
      controller = new MotionStreamController({
        worker: restoredWorker,
        identity: activeIdentity,
        timeoutMs: 20_000,
        requestIdFactory: () => requestId("controller"),
        onResult: (message: M1SampleMotionResult, flight: MotionStreamFlight) => resultHandler(message, flight),
        onError: (error: MotionStreamError, flight: MotionStreamFlight | null, retryable: boolean) => errorHandler(error, flight, retryable),
      });
      let resolveSeek!: (value: unknown) => void;
      const seekTerminal = new Promise(resolve => { resolveSeek = resolve; });
      const onSeekResult = (_message: M1SampleMotionResult, flight: MotionStreamFlight): boolean => {
        controllerResults.push({ requestId: flight.request.requestId, revision: flight.request.revision, seekEpoch: flight.seekEpoch });
        if (flight.seekEpoch === 7) resolveSeek({ requestId: flight.request.requestId, revision: flight.request.revision, seekEpoch: flight.seekEpoch });
        return false;
      };
      // Replace the callback before issuing the seek sequence to capture only
      // the current epoch; the first in-flight Worker result must be ignored.
      resultHandler = onSeekResult;
      controller.requestWindow(0, 0.5, 200);
      controller.reset(activeIdentity, 7);
      controller.requestWindow(1, 1.5, 200);
      const seekResult = await Promise.race([
        seekTerminal,
        new Promise((_, reject) => setTimeout(() => reject(new Error("seek stream timed out")), 25_000)),
      ]) as { requestId: string; revision: number; seekEpoch: number };

      let resolveIdentityError!: (value: unknown) => void;
      const identityErrorTerminal = new Promise(resolve => { resolveIdentityError = resolve; });
      resultHandler = () => false;
      errorHandler = (error: MotionStreamError, flight: MotionStreamFlight | null, retryable: boolean) => {
        controllerErrors.push({ code: error.code, revision: flight?.request.revision ?? null, retryable });
        if (flight?.request.revision === nextRevision + 1) {
          resolveIdentityError({ code: error.code, revision: flight.request.revision, retryable });
        }
      };
      controller.requestWindow(2, 2.5, 200);
      controller.reset(identity(nextRevision + 1), 8);
      controller.requestWindow(0, 0.5, 200);
      const staleIdentityError = await Promise.race([
        identityErrorTerminal,
        new Promise((_, reject) => setTimeout(() => reject(new Error("identity-error stream timed out")), 25_000)),
      ]) as { code: string; revision: number; retryable: boolean };

      return {
        projectId,
        engineVersion,
        initialWindow: {
          startTimeSeconds: analysis.initialMotionWindow.startTimeSeconds,
          endTimeSeconds: analysis.initialMotionWindow.endTimeSeconds,
          poseCount: analysis.initialMotionWindow.poses.length,
          truncated: analysis.initialMotionWindow.truncated,
        },
        firstStream: { revision: firstStream.revision, poseCount: firstStream.poses.length, coverage: firstStream.coverage },
        replan: { revision: replanned.revision, keyStyle: replanned.keyStyle, poseCount: replanned.initialMotionWindow.poses.length },
        replannedStream: { revision: replannedStream.revision, poseCount: replannedStream.poses.length },
        restored: { revision: restoredReplan.revision, streamRevision: restoredStream.revision, poseCount: restoredStream.poses.length },
        seekResult,
        seekResultCount: controllerResults.filter(result => result.seekEpoch === 7).length,
        staleIdentityError,
      };
    } finally {
      controller?.dispose();
      worker.terminate();
      restoredWorker?.terminate();
    }
  }, MIDI_BASE64);

  expect(result.initialWindow.startTimeSeconds).toBe(0);
  expect(result.initialWindow.endTimeSeconds).toBeLessThanOrEqual(4);
  expect(result.initialWindow.poseCount).toBeGreaterThan(0);
  expect(result.initialWindow.poseCount).toBeLessThanOrEqual(200);
  expect(result.firstStream.revision).toBe(1);
  expect(result.firstStream.poseCount).toBeGreaterThan(0);
  expect(result.replan).toMatchObject({ revision: 2, keyStyle: "equal" });
  expect(result.replannedStream).toMatchObject({ revision: 2 });
  expect(result.restored).toMatchObject({ revision: 2, streamRevision: 2 });
  expect(result.seekResult).toMatchObject({ revision: 2, seekEpoch: 7 });
  expect(result.seekResultCount).toBe(1);
  expect(result.staleIdentityError.revision).toBe(3);
  expect(result.staleIdentityError.code).toBeTruthy();
});
