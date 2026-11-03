import { analyze_midi, sha256 } from "@handthesia/engine-ts";
import { calculateDifficulty } from "../editor/difficulty.ts";
import { importScoreBytesToMidi } from "../import/importScoreFile.ts";
import type {
  LibraryAnalysisResult,
  LibraryPreviewNote,
} from "./libraryAnalysisClient.ts";

const PREVIEW_WINDOW_SECONDS = 15;

export interface LibraryAnalysisWorkerRequest {
  type: "analyze";
  requestId: string;
  name: string;
  bytes: ArrayBuffer;
}

export type LibraryAnalysisWorkerMessage =
  | {
      type: "progress";
      requestId: string;
      message: string;
    }
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

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: LibraryAnalysisWorkerMessage, transfer?: Transferable[]): void;
}

interface AnalyzedMidiNote {
  noteId?: unknown;
  pitch?: unknown;
  velocity?: unknown;
  startSeconds?: unknown;
  endSeconds?: unknown;
}

function basenameWithoutExtension(name: string): string {
  const basename = name.split(/[\\/]/).at(-1) ?? name;
  return basename.replace(/\.[^.]+$/, "").trim();
}

function toPreviewNotes(notes: readonly AnalyzedMidiNote[]): LibraryPreviewNote[] {
  return notes.flatMap((note, index) => {
    const startSeconds = Number(note.startSeconds);
    const endSeconds = Number(note.endSeconds);
    const pitch = Number(note.pitch);
    const velocity = Number(note.velocity);
    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      !Number.isInteger(pitch) ||
      pitch < 0 ||
      pitch > 127 ||
      !Number.isFinite(velocity) ||
      endSeconds <= 0 ||
      startSeconds >= PREVIEW_WINDOW_SECONDS ||
      endSeconds <= startSeconds
    ) {
      return [];
    }

    return [
      {
        noteId:
          typeof note.noteId === "string" && note.noteId.length > 0
            ? note.noteId
            : `preview-note-${index}`,
        pitch,
        velocity: Math.max(1, Math.min(127, Math.round(velocity))),
        startSeconds: Math.max(0, startSeconds),
        endSeconds: Math.min(PREVIEW_WINDOW_SECONDS, endSeconds),
      },
    ];
  });
}

/**
 * Imports any supported score file to canonical MIDI and computes the same
 * difficulty metadata used by the built-in melody catalog generator.
 */
export async function analyzeLibrarySource(
  name: string,
  sourceBytes: Uint8Array,
  onProgress?: (message: string) => void,
): Promise<LibraryAnalysisResult> {
  if (!name.trim()) throw new Error("A score filename is required.");
  if (sourceBytes.byteLength === 0) {
    throw new Error(`File "${name}" is empty (0 bytes).`);
  }
  if (sourceBytes.byteLength > 16 * 1024 * 1024) {
    throw new Error(`File "${name}" exceeds the maximum allowed size of 16 MiB.`);
  }

  const imported = await importScoreBytesToMidi(name, sourceBytes, {
    onProgress,
  });
  const midiBytes = new Uint8Array(imported.midiBytes);
  if (midiBytes.byteLength === 0) {
    throw new Error(`Converting "${name}" produced an empty MIDI file.`);
  }

  onProgress?.("Analyzing melody difficulty…");
  const contentId = sha256(midiBytes);
  const analysis = analyze_midi(midiBytes, {
    fixtureId: `builtin-${contentId}`,
    projectId: "builtin-catalog",
    revision: 0,
    requestId: `builtin-catalog/${contentId}`,
    engineVersion: "builtin-catalog",
    keyStyle: "realistic",
    keyboardRect: [0, 0, 1400, 150],
  });
  if (analysis.status === "invalid" || !analysis.document || !analysis.fingeringPlan) {
    const diagnostic = Array.isArray(analysis.diagnostics)
      ? analysis.diagnostics.find(
          (item: { severity?: unknown; message?: unknown }) => item.severity === "error",
        )
      : undefined;
    const detail =
      typeof diagnostic?.message === "string" ? ` ${diagnostic.message}` : "";
    throw new Error(`Could not analyze "${name}" as a score.${detail}`);
  }

  const difficulty = calculateDifficulty(analysis.document, analysis.fingeringPlan);
  const notes = analysis.document.notes as AnalyzedMidiNote[];
  const durationSeconds = Number(analysis.document.durationSeconds);
  const noteCount = notes.length;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 0 ||
    !Number.isSafeInteger(noteCount) ||
    noteCount < 0 ||
    !Number.isFinite(difficulty.overallScore) ||
    typeof difficulty.tier !== "string"
  ) {
    throw new Error(`Analysis of "${name}" returned invalid metadata.`);
  }

  return {
    midiBytes,
    title: imported.title?.trim() || basenameWithoutExtension(name),
    sourceFormat: imported.sourceFormat,
    durationSeconds,
    noteCount,
    difficultyScore: difficulty.overallScore,
    difficultyTier: difficulty.tier,
    previewNotes: toPreviewNotes(notes),
  };
}

function isAnalysisRequest(value: unknown): value is LibraryAnalysisWorkerRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<LibraryAnalysisWorkerRequest>;
  return (
    request.type === "analyze" &&
    typeof request.requestId === "string" &&
    typeof request.name === "string" &&
    request.bytes instanceof ArrayBuffer
  );
}

function installWorker(scope: WorkerScope): void {
  scope.addEventListener("message", (event) => {
    if (!isAnalysisRequest(event.data)) return;
    const request = event.data;
    void analyzeLibrarySource(request.name, new Uint8Array(request.bytes), (message) => {
      scope.postMessage({
        type: "progress",
        requestId: request.requestId,
        message,
      });
    }).then(
      (result) => {
        const midiBuffer = result.midiBytes.buffer.slice(
          result.midiBytes.byteOffset,
          result.midiBytes.byteOffset + result.midiBytes.byteLength,
        ) as ArrayBuffer;
        scope.postMessage(
          {
            type: "result",
            requestId: request.requestId,
            result: { ...result, midiBytes: midiBuffer },
          },
          [midiBuffer],
        );
      },
      (error: unknown) => {
        scope.postMessage({
          type: "error",
          requestId: request.requestId,
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
  });
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  installWorker(self as unknown as WorkerScope);
}
