import {
  M1AnalyzeMidiRequestSchema,
  M1ExportMidiRequestSchema,
  M1ReplanDocumentRequestSchema,
  M1SampleMotionRequestSchema,
  type M1AnalyzeMidiRequest,
  type M1EngineMessage,
  type M1ExportMidiRequest,
  type M1ReplanDocumentRequest,
  type M1SampleMotionRequest,
} from "@handthesia/contracts";

import { getSettings, type CalculationEngine } from "./settings";
import { recordDiagnostic } from "./diagnostics/eventLog";

export type M1WorkerIdentity = Pick<M1AnalyzeMidiRequest, "requestId" | "projectId" | "revision" | "engineVersion">;
const workerEngines = new WeakMap<Worker, CalculationEngine>();
const workerDiagnostics = new WeakMap<Worker, { workerId: string; engine: CalculationEngine; started: Map<string, number>; stages: Map<string, string> }>();

function logWorkerMessage(worker: Worker, direction: "request" | "response", message: unknown): void {
  if (!message || typeof message !== "object") return;
  const data = message as Record<string, unknown>;
  const meta = workerDiagnostics.get(worker);
  const requestId = typeof data.requestId === "string" ? data.requestId : "";
  const type = typeof data.type === "string" ? data.type : "unknown";
  if (type === "progress") {
    const stage = String(data.stage);
    if (meta?.stages.get(requestId) === stage) return;
    meta?.stages.set(requestId, stage);
  }
  if (direction === "request") meta?.started.set(requestId, performance.now());
  if (meta) {
    for (const history of [meta.started, meta.stages]) {
      while (history.size > 64) history.delete(history.keys().next().value!);
    }
  }
  const started = meta?.started.get(requestId);
  const error = data.error && typeof data.error === "object" ? data.error as Record<string, unknown> : undefined;
  recordDiagnostic(`worker.${direction}`, {
    workerId: meta?.workerId, engine: meta?.engine, type, requestId, projectId: data.projectId,
    revision: data.revision, engineVersion: data.engineVersion, stage: data.stage, status: data.status,
    startTimeSeconds: data.startTimeSeconds, endTimeSeconds: data.endTimeSeconds, maxPoses: data.maxPoses,
    poseCount: Array.isArray(data.poses) ? data.poses.length : undefined,
    coverage: data.coverage, truncated: data.truncated, continuationTimeSeconds: data.continuationTimeSeconds,
    durationMs: direction === "response" && started !== undefined ? Math.round(performance.now() - started) : undefined,
    error: error ? { code: error.code, message: error.message, retryable: error.retryable, stack: error.stack } : undefined,
  }, type === "worker-error" ? "error" : "info");
  if (direction === "response" && type !== "progress") {
    meta?.started.delete(requestId);
    meta?.stages.delete(requestId);
  }
}

/** Runtime chosen when this Worker was created, independent of later preference changes. */
export function getM1AnalysisWorkerEngine(worker: Worker | undefined): CalculationEngine | undefined {
  return worker ? workerEngines.get(worker) : undefined;
}

/** Creates the module Worker for analysis: Python (Pyodide) or pure TypeScript. */
export function createM1AnalysisWorker(engine?: CalculationEngine): Worker {
  const selectedEngine =
    engine ??
    (typeof window !== "undefined" ? getSettings()?.calculationEngine : undefined) ??
    "python";
  const worker = selectedEngine === "typescript"
    ? new Worker(new URL("./workers/midi-analysis-ts.worker.ts", import.meta.url), { type: "module" })
    : new Worker(new URL("./workers/midi-analysis.worker.ts", import.meta.url), { type: "module" });
  workerEngines.set(worker, selectedEngine);
  const workerId = `calculation-${crypto.randomUUID()}`;
  workerDiagnostics.set(worker, { workerId, engine: selectedEngine, started: new Map(), stages: new Map() });
  recordDiagnostic("worker.created", { workerId, engine: selectedEngine });
  worker.addEventListener?.("message", event => logWorkerMessage(worker, "response", event.data));
  worker.addEventListener?.("error", event => recordDiagnostic("worker.crashed", {
    workerId, engine: selectedEngine, message: event.message, filename: event.filename, line: event.lineno,
  }, "error"));
  worker.addEventListener?.("messageerror", () => recordDiagnostic("worker.message-error", { workerId, engine: selectedEngine }, "error"));
  return worker;
}

/** Transfers a copy so callers retain their original ArrayBuffer for validation or retry. */
export function postM1AnalyzeMidiRequest(worker: Worker, request: M1AnalyzeMidiRequest): M1AnalyzeMidiRequest {
  const validated = M1AnalyzeMidiRequestSchema.parse(request);
  const transferredBytes = validated.midiBytes.slice(0);
  logWorkerMessage(worker, "request", validated);
  worker.postMessage({ ...validated, midiBytes: transferredBytes }, [transferredBytes]);
  return validated;
}

/** Transfers a copy for fingered MIDI export. */
export function postM1ExportMidiRequest(worker: Worker, request: M1ExportMidiRequest): M1ExportMidiRequest {
  const validated = M1ExportMidiRequestSchema.parse(request);
  const transferredBytes = validated.midiBytes.slice(0);
  logWorkerMessage(worker, "request", validated);
  worker.postMessage({ ...validated, midiBytes: transferredBytes }, [transferredBytes]);
  return validated;
}

/** Transfers a copy so the editor retains the original source bytes. */
export function postM1ReplanDocumentRequest(worker: Worker, request: M1ReplanDocumentRequest): M1ReplanDocumentRequest {
  const validated = M1ReplanDocumentRequestSchema.parse(request);
  const transferredBytes = validated.midiBytes.slice(0);
  logWorkerMessage(worker, "request", validated);
  worker.postMessage({ ...validated, midiBytes: transferredBytes }, [transferredBytes]);
  return validated;
}

/** Dispatches a sample motion window request to the active worker. */
export function postM1SampleMotionRequest(worker: Worker, request: M1SampleMotionRequest): M1SampleMotionRequest {
  const validated = M1SampleMotionRequestSchema.parse(request);
  logWorkerMessage(worker, "request", validated);
  worker.postMessage(validated);
  return validated;
}

export function isCurrentM1WorkerMessage(message: M1EngineMessage, expected: M1WorkerIdentity): boolean {
  return message.requestId === expected.requestId &&
    message.projectId === expected.projectId &&
    message.revision === expected.revision;
}
