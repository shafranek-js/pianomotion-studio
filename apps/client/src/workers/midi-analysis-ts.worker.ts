import {
  M1AnalyzeMidiRequestSchema,
  M1EngineErrorSchema,
  M1EngineLoadResultSchema,
  M1EngineMessageSchema,
  M1EngineProgressSchema,
  M1ExportMidiRequestSchema,
  M1ExportMidiResultSchema,
  M1ReplanDocumentRequestSchema,
  M1SampleMotionRequestSchema,
  M1SampleMotionResultSchema,
  validateM1ReplanDocumentResultForRequest,
  validateM1AnalyzeMidiResultForRequest,
  type M1EngineStage,
} from "@handthesia/contracts";
import {
  analyze_midi,
  replan_document,
  sample_motion_window,
  export_fingered_midi,
  set_progress_callback,
  _engine_version,
  _manifest,
} from "@handthesia/engine-ts";
import enginePackage from "../../../../packages/engine-ts/package.json";

const workerScope = self as unknown as {
  location: Location;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const maxMidiBytes = 16 * 1024 * 1024;

type ActiveSongContext = {
  projectId: string;
  revision: number;
  midiBytes?: Uint8Array;
  document?: unknown;
  fingeringPlan?: unknown;
  profile?: unknown;
  keyStyle?: unknown;
  keyboardRect?: unknown;
};

let analysisRunning = false;
let activeSongContext: ActiveSongContext | undefined;
let operationQueue: Promise<void> = Promise.resolve();

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  operationQueue = operationQueue.then(() => handleMessage(message)).catch((error) => {
    const request = M1EngineMessageSchema.safeParse(message);
    if (request.success) {
      postError(request.data, "compute", "WORKER_OPERATION_FAILED", errorMessage(error), true, error);
    }
  });
});

async function handleMessage(message: unknown): Promise<void> {
  const parsed = M1EngineMessageSchema.safeParse(message);
  if (!parsed.success) return;

  if (parsed.data.type === "engine-load") {
    try {
      const manifest = _manifest();
      const engineVersion = _engine_version(manifest);
      workerScope.postMessage(
        M1EngineLoadResultSchema.parse({
          ...parsed.data,
          type: "engine-loaded",
          runtime: "typescript",
          runtimeVersion: enginePackage.version,
          pythonVersion: "N/A (Pure TypeScript)",
          packageVersions: {
            "@handthesia/engine-ts": enginePackage.version,
          },
          engineVersion,
        }),
      );
    } catch (error) {
      postError(parsed.data, "init", "RUNTIME_INITIALIZATION_FAILED", errorMessage(error), true, error);
    }
    return;
  }

  if (parsed.data.type === "export-midi") {
    const request = M1ExportMidiRequestSchema.parse(parsed.data);
    try {
      const res = export_fingered_midi(
        new Uint8Array(request.midiBytes),
        request.document,
        request.fingeringPlan,
      );
      const rawBytes: Uint8Array = res.exportedBytes instanceof Uint8Array
        ? res.exportedBytes
        : new Uint8Array(res.exportedBytes);
      const responseBuffer = rawBytes.buffer.slice(
        rawBytes.byteOffset,
        rawBytes.byteOffset + rawBytes.byteLength,
      );
      const result = M1ExportMidiResultSchema.parse({
        type: "export-midi-result",
        requestId: request.requestId,
        projectId: request.projectId,
        revision: request.revision,
        engineVersion: request.engineVersion,
        exportedBytes: responseBuffer,
        markedCount: Number(res.markedCount ?? 0),
        diagnostics: Array.isArray(res.diagnostics) ? res.diagnostics : [],
      });
      workerScope.postMessage(result, [responseBuffer]);
    } catch (error) {
      postError(request, "compute", "EXPORT_FAILED", errorMessage(error), false, error);
    }
    return;
  }

  if (parsed.data.type === "replan-document") {
    const request = M1ReplanDocumentRequestSchema.parse(parsed.data);
    if (analysisRunning) {
      postError(request, "compute", "WORKER_BUSY", "The analysis worker already has an active job.", true);
      return;
    }
    if (request.midiBytes.byteLength > maxMidiBytes) {
      postError(
        request,
        "compute",
        "MIDI_SIZE_LIMIT",
        `MIDI input exceeds the ${maxMidiBytes / (1024 * 1024)} MiB browser limit.`,
        false,
      );
      return;
    }

    analysisRunning = true;
    try {
      const manifest = _manifest();
      const engineVersion = _engine_version(manifest);
      request.engineVersion = engineVersion;

      set_progress_callback((fraction: number, msg: string) => {
        postProgress(request, "compute", msg, fraction);
      });

      let rawResult: unknown;
      try {
        postProgress(request, "compute", "Rebuilding plans from the original MIDI and edited note identities.", 0.05);
        const options = {
          ...request.options,
          projectId: request.projectId,
          revision: request.revision,
          requestId: request.requestId,
          engineVersion: request.engineVersion,
          profile: request.profile,
          resource: request.resource,
          rawBaseline: request.rawBaseline,
        };
        rawResult = replan_document(
          new Uint8Array(request.midiBytes),
          request.document,
          request.fingeringPlan,
          options,
        );
      } finally {
        set_progress_callback(null);
      }

      const result = validateM1ReplanDocumentResultForRequest(request, {
        ...(rawResult as Record<string, unknown>),
        type: "replan-document-result",
        requestId: request.requestId,
        projectId: request.projectId,
        revision: request.revision,
        engineVersion: request.engineVersion,
      });

      activeSongContext = {
        projectId: request.projectId,
        revision: request.revision,
        midiBytes: new Uint8Array(request.midiBytes),
        document: result.document,
        fingeringPlan: result.fingeringPlan,
        profile: request.profile,
        keyStyle: request.options.keyStyle,
        keyboardRect: request.options.keyboardRect,
      };

      workerScope.postMessage(result);
    } catch (error) {
      postError(request, "compute", "REPLAN_FAILED", errorMessage(error), false, error);
    } finally {
      analysisRunning = false;
    }
    return;
  }

  if (parsed.data.type === "sample-motion") {
    const request = M1SampleMotionRequestSchema.parse(parsed.data);
    if (analysisRunning) {
      postError(request, "compute", "WORKER_BUSY", "The analysis worker already has an active job.", true);
      return;
    }

    analysisRunning = true;
    try {
      const manifest = _manifest();
      const engineVersion = _engine_version(manifest);
      request.engineVersion = engineVersion;

      const matching =
        activeSongContext?.projectId === request.projectId && activeSongContext.revision === request.revision
          ? activeSongContext
          : undefined;

      const options = {
        projectId: request.projectId,
        revision: request.revision,
        requestId: request.requestId,
        engineVersion: request.engineVersion,
        maxPoses: request.maxPoses,
        ...(matching?.profile ? { profile: matching.profile } : {}),
        ...(matching?.keyStyle ? { keyStyle: matching.keyStyle } : {}),
        ...(matching?.keyboardRect ? { keyboardRect: matching.keyboardRect } : {}),
      };

      const rawResult = sample_motion_window(
        matching?.midiBytes ?? new Uint8Array(0),
        matching?.document ?? null,
        matching?.fingeringPlan ?? null,
        request.startTimeSeconds,
        request.endTimeSeconds,
        options,
      );

      const result = M1SampleMotionResultSchema.parse({
        ...(rawResult as Record<string, unknown>),
        type: "sample-motion-result",
        requestId: request.requestId,
        projectId: request.projectId,
        revision: request.revision,
        engineVersion: request.engineVersion,
      });

      workerScope.postMessage(result);
    } catch (error) {
      postError(request, "compute", "SAMPLE_MOTION_FAILED", errorMessage(error), false, error);
    } finally {
      analysisRunning = false;
    }
    return;
  }

  if (parsed.data.type !== "analyze-midi") return;
  const request = M1AnalyzeMidiRequestSchema.parse(parsed.data);
  if (analysisRunning) {
    postError(request, "compute", "WORKER_BUSY", "The analysis worker already has an active job.", true);
    return;
  }
  if (request.midiBytes.byteLength > maxMidiBytes) {
    postError(
      request,
      "compute",
      "MIDI_SIZE_LIMIT",
      `MIDI input exceeds the ${maxMidiBytes / (1024 * 1024)} MiB browser limit.`,
      false,
    );
    return;
  }

  analysisRunning = true;
  try {
    const manifest = _manifest();
    const engineVersion = _engine_version(manifest);
    request.engineVersion = engineVersion;

    postProgress(request, "compute", "Starting pure TypeScript analysis in the Worker.", 0.05);
    const options = {
      ...request.options,
      fixtureId: request.options.fixtureId ?? "imported-midi",
      projectId: request.projectId,
      revision: request.revision,
      requestId: request.requestId,
      engineVersion: request.engineVersion,
      sampleDense:
        request.options.sampleDense ??
        (request.options.fixtureId === "imported-midi" ||
          request.options.fixtureId === undefined ||
          request.options.fixtureId.startsWith("builtin-")),
      ...(request.profile ? { profile: request.profile } : {}),
    };

    set_progress_callback((fraction: number, msg: string) => {
      postProgress(request, "compute", msg, fraction);
    });

    let rawResult: unknown;
    try {
      rawResult = analyze_midi(new Uint8Array(request.midiBytes), options);
    } finally {
      set_progress_callback(null);
    }

    const result = validateM1AnalyzeMidiResultForRequest(request, {
      ...(rawResult as Record<string, unknown>),
      type: "analysis-result",
    });

    activeSongContext = {
      projectId: request.projectId,
      revision: request.revision,
      midiBytes: new Uint8Array(request.midiBytes),
      document: result.document,
      fingeringPlan: result.fingeringPlan,
      profile: result.profile,
      keyStyle: request.options.keyStyle,
      keyboardRect: request.options.keyboardRect,
    };

    workerScope.postMessage(result);
  } catch (error) {
    postError(request, "compute", "ANALYSIS_FAILED", errorMessage(error), false, error);
  } finally {
    analysisRunning = false;
  }
}

function postProgress(
  identity: { requestId: string; projectId: string; revision: number; engineVersion: string },
  stage: M1EngineStage,
  message: string,
  progress?: number,
): void {
  workerScope.postMessage(
    M1EngineProgressSchema.parse({
      requestId: identity.requestId,
      projectId: identity.projectId,
      revision: identity.revision,
      engineVersion: identity.engineVersion,
      type: "progress",
      stage,
      message,
      ...(typeof progress === "number" ? { progress: Math.max(0, Math.min(1, progress)) } : {}),
    }),
  );
}

function postError(
  identity: { requestId: string; projectId: string; revision: number; engineVersion: string },
  stage: M1EngineStage,
  code: string,
  message: string,
  retryable: boolean,
  cause?: unknown,
): void {
  workerScope.postMessage(
    M1EngineErrorSchema.parse({
      requestId: identity.requestId,
      projectId: identity.projectId,
      revision: identity.revision,
      engineVersion: identity.engineVersion,
      type: "worker-error",
      stage,
      error: { code, message, retryable, ...(cause instanceof Error && cause.stack ? { stack: cause.stack.slice(0, 8_000) } : {}) },
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
