export interface LibraryPreviewNote {
  noteId: string;
  pitch: number;
  velocity: number;
  startSeconds: number;
  endSeconds: number;
}

export type LibrarySourceFormat =
  | "midi"
  | "karaoke"
  | "musicxml"
  | "mxl"
  | "mscz"
  | "guitar-pro";

export type LibraryDifficultyTier =
  | "Beginner"
  | "Intermediate"
  | "Advanced"
  | "Virtuoso";

export interface LibraryAnalysisResult {
  midiBytes: Uint8Array;
  title?: string;
  sourceFormat: LibrarySourceFormat;
  durationSeconds: number;
  noteCount: number;
  difficultyScore: number;
  difficultyTier: LibraryDifficultyTier;
  previewNotes: LibraryPreviewNote[];
}

export interface LibraryAnalysisInput {
  name: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
}

export interface LibraryAnalysisOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

type LibraryAnalysisWorkerResponse =
  | { type: "progress"; requestId: string; message: string }
  | {
      type: "result";
      requestId: string;
      result: Omit<LibraryAnalysisResult, "midiBytes"> & { midiBytes: ArrayBuffer };
    }
  | {
      type: "error";
      requestId: string;
      error: { name: string; message: string };
    };

interface LibraryAnalysisWorkerRequest {
  type: "analyze";
  requestId: string;
  name: string;
  bytes: ArrayBuffer;
}

interface LibraryAnalysisWorkerInstance {
  onmessage: ((event: MessageEvent<LibraryAnalysisWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: LibraryAnalysisWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

interface AnalysisJob {
  requestId: string;
  name: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  resolve: (result: LibraryAnalysisResult) => void;
  reject: (error: Error) => void;
  worker?: LibraryAnalysisWorkerInstance;
  abortListener?: () => void;
  settled: boolean;
}

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_JOBS = 4;
const MAX_PREVIEW_SECONDS = 15;
const queue: AnalysisJob[] = [];
let activeJob: AnalysisJob | null = null;
let nextRequestNumber = 0;

function makeAbortError(): Error {
  const error = new Error("Melody analysis was cancelled.");
  error.name = "AbortError";
  return error;
}

function reportProgress(job: AnalysisJob, message: string): void {
  try {
    job.onProgress?.(message);
  } catch {
    // UI progress handlers must not fail the conversion job.
  }
}

function failJob(job: AnalysisJob, error: Error): void {
  if (job.settled) return;
  job.settled = true;
  job.signal?.removeEventListener("abort", job.abortListener!);
  job.worker?.terminate();
  job.worker = undefined;
  if (activeJob === job) activeJob = null;
  job.reject(error);
  pumpQueue();
}

function finishJob(job: AnalysisJob, result: LibraryAnalysisResult): void {
  if (job.settled) return;
  job.settled = true;
  job.signal?.removeEventListener("abort", job.abortListener!);
  job.worker?.terminate();
  job.worker = undefined;
  if (activeJob === job) activeJob = null;
  job.resolve(result);
  pumpQueue();
}

function validateWorkerResult(
  value: LibraryAnalysisWorkerResponse,
): LibraryAnalysisResult {
  if (value.type !== "result" || !(value.result.midiBytes instanceof ArrayBuffer)) {
    throw new Error("The analysis worker returned an invalid result.");
  }
  const result = value.result;
  if (
    !["midi", "karaoke", "musicxml", "mxl", "mscz", "guitar-pro"].includes(
      result.sourceFormat,
    ) ||
    !Number.isFinite(result.durationSeconds) ||
    result.durationSeconds < 0 ||
    !Number.isSafeInteger(result.noteCount) ||
    result.noteCount < 0 ||
    !Number.isFinite(result.difficultyScore) ||
    result.difficultyScore < 1 ||
    result.difficultyScore > 10 ||
    !["Beginner", "Intermediate", "Advanced", "Virtuoso"].includes(
      result.difficultyTier,
    ) ||
    !Array.isArray(result.previewNotes)
  ) {
    throw new Error("The analysis worker returned invalid melody metadata.");
  }

  const previewNotes = result.previewNotes.map((note) => {
    if (
      !note ||
      typeof note.noteId !== "string" ||
      !Number.isInteger(note.pitch) ||
      note.pitch < 0 ||
      note.pitch > 127 ||
      !Number.isInteger(note.velocity) ||
      note.velocity < 1 ||
      note.velocity > 127 ||
      !Number.isFinite(note.startSeconds) ||
      note.startSeconds < 0 ||
      !Number.isFinite(note.endSeconds) ||
      note.endSeconds <= note.startSeconds ||
      note.endSeconds > MAX_PREVIEW_SECONDS
    ) {
      throw new Error("The analysis worker returned invalid preview notes.");
    }
    return { ...note };
  });

  return {
    midiBytes: new Uint8Array(result.midiBytes),
    ...(typeof result.title === "string" && result.title.trim()
      ? { title: result.title.trim() }
      : {}),
    sourceFormat: result.sourceFormat,
    durationSeconds: result.durationSeconds,
    noteCount: result.noteCount,
    difficultyScore: result.difficultyScore,
    difficultyTier: result.difficultyTier,
    previewNotes,
  };
}

function pumpQueue(): void {
  if (activeJob) return;

  let job = queue.shift();
  while (job?.signal?.aborted) {
    if (!job.settled) {
      job.settled = true;
      job.signal.removeEventListener("abort", job.abortListener!);
      job.reject(makeAbortError());
    }
    job = queue.shift();
  }
  if (!job) return;

  activeJob = job;
  reportProgress(job, "Analyzing melody in background…");

  let worker: Worker;
  try {
    worker = new Worker(new URL("./libraryAnalysisWorker.ts", import.meta.url), {
      type: "module",
    });
  } catch (error) {
    failJob(
      job,
      error instanceof Error
        ? error
        : new Error("Could not start the melody analysis worker."),
    );
    return;
  }
  job.worker = worker as unknown as LibraryAnalysisWorkerInstance;

  worker.onmessage = (event: MessageEvent<LibraryAnalysisWorkerResponse>) => {
    const message = event.data;
    if (!message || message.requestId !== job.requestId || job.settled) return;
    if (message.type === "progress") {
      reportProgress(job, message.message);
      return;
    }
    if (message.type === "error") {
      const error = new Error(message.error.message || "Melody analysis failed.");
      error.name = message.error.name || "Error";
      failJob(job, error);
      return;
    }
    try {
      finishJob(job, validateWorkerResult(message));
    } catch (error) {
      failJob(
        job,
        error instanceof Error
          ? error
          : new Error("The analysis worker returned an invalid result."),
      );
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    failJob(job, new Error(event.message || "Melody analysis worker failed."));
  };
  worker.onmessageerror = () => {
    failJob(job, new Error("Could not read the melody analysis worker result."));
  };

  const transferCopy = job.bytes.slice();
  try {
    worker.postMessage(
      {
        type: "analyze",
        requestId: job.requestId,
        name: job.name,
        bytes: transferCopy.buffer,
      },
      [transferCopy.buffer],
    );
  } catch (error) {
    failJob(
      job,
      error instanceof Error
        ? error
        : new Error("Could not send the score to the analysis worker."),
    );
  }
}

/**
 * Converts and analyzes one local score. Requests run one at a time with a
 * four-job waiting queue; cancelling an active request terminates its worker.
 */
export function analyzeLibraryBytes(
  input: LibraryAnalysisInput,
  options: LibraryAnalysisOptions = {},
): Promise<LibraryAnalysisResult> {
  const signal = options.signal ?? input.signal;
  if (!input.name.trim()) return Promise.reject(new Error("A score filename is required."));
  if (input.bytes.byteLength === 0) {
    return Promise.reject(new Error(`File "${input.name}" is empty (0 bytes).`));
  }
  if (input.bytes.byteLength > MAX_INPUT_BYTES) {
    return Promise.reject(
      new Error(`File "${input.name}" exceeds the maximum allowed size of 16 MiB.`),
    );
  }
  if (signal?.aborted) return Promise.reject(makeAbortError());
  if (queue.length >= MAX_QUEUED_JOBS) {
    return Promise.reject(
      new Error("The local melody analysis queue is full. Try again after a job finishes."),
    );
  }

  const bytes = input.bytes.slice();
  const requestId = `local-library-${++nextRequestNumber}`;
  return new Promise<LibraryAnalysisResult>((resolve, reject) => {
    const job: AnalysisJob = {
      requestId,
      name: input.name,
      bytes,
      ...(signal ? { signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      resolve,
      reject,
      settled: false,
    };
    job.abortListener = () => {
      const queuedIndex = queue.indexOf(job);
      if (queuedIndex >= 0) {
        queue.splice(queuedIndex, 1);
        failJob(job, makeAbortError());
        return;
      }
      if (activeJob === job) failJob(job, makeAbortError());
    };
    signal?.addEventListener("abort", job.abortListener, { once: true });
    if (activeJob) reportProgress(job, "Waiting for the current melody analysis…");
    queue.push(job);
    pumpQueue();
  });
}

/** Reads a user-selected file and analyzes it through the bounded worker queue. */
export async function analyzeLibraryFile(
  file: File,
  options: LibraryAnalysisOptions = {},
): Promise<LibraryAnalysisResult> {
  if (options.signal?.aborted) throw makeAbortError();
  if (file.size === 0) throw new Error(`File "${file.name}" is empty (0 bytes).`);
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(`File "${file.name}" exceeds the maximum allowed size of 16 MiB.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (options.signal?.aborted) throw makeAbortError();
  return analyzeLibraryBytes({ name: file.name, bytes }, options);
}

