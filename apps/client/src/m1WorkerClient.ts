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

export type M1WorkerIdentity = Pick<M1AnalyzeMidiRequest, "requestId" | "projectId" | "revision" | "engineVersion">;

/** Creates the same real module Worker used by the M1 diagnostic page. */
export function createM1AnalysisWorker(): Worker {
  return new Worker(new URL("./workers/midi-analysis.worker.ts", import.meta.url), { type: "module" });
}

/** Transfers a copy so callers retain their original ArrayBuffer for validation or retry. */
export function postM1AnalyzeMidiRequest(worker: Worker, request: M1AnalyzeMidiRequest): M1AnalyzeMidiRequest {
  const validated = M1AnalyzeMidiRequestSchema.parse(request);
  const transferredBytes = validated.midiBytes.slice(0);
  worker.postMessage({ ...validated, midiBytes: transferredBytes }, [transferredBytes]);
  return validated;
}

/** Transfers a copy for fingered MIDI export. */
export function postM1ExportMidiRequest(worker: Worker, request: M1ExportMidiRequest): M1ExportMidiRequest {
  const validated = M1ExportMidiRequestSchema.parse(request);
  const transferredBytes = validated.midiBytes.slice(0);
  worker.postMessage({ ...validated, midiBytes: transferredBytes }, [transferredBytes]);
  return validated;
}

/** Transfers a copy so the editor retains the original source bytes. */
export function postM1ReplanDocumentRequest(worker: Worker, request: M1ReplanDocumentRequest): M1ReplanDocumentRequest {
  const validated = M1ReplanDocumentRequestSchema.parse(request);
  const transferredBytes = validated.midiBytes.slice(0);
  worker.postMessage({ ...validated, midiBytes: transferredBytes }, [transferredBytes]);
  return validated;
}

/** Dispatches a sample motion window request to the active worker. */
export function postM1SampleMotionRequest(worker: Worker, request: M1SampleMotionRequest): M1SampleMotionRequest {
  const validated = M1SampleMotionRequestSchema.parse(request);
  worker.postMessage(validated);
  return validated;
}

/** Shared production gate that drops well-formed replies from older or different jobs. */
export function isCurrentM1WorkerMessage(message: M1EngineMessage, expected: M1WorkerIdentity): boolean {
  return message.requestId === expected.requestId &&
    message.projectId === expected.projectId &&
    message.revision === expected.revision &&
    message.engineVersion === expected.engineVersion;
}
