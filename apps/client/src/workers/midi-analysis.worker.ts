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
import pyodidePins from "../../../../tools/pyodide-runtime-manifest.json";
import { releaseAssetUrl } from "../pwa/urls";

type PyodideInstance = {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
  };
  globals: {
    get(name: string): unknown;
    set(name: string, value: unknown): void;
    delete(name: string): boolean;
  };
  loadPackage(packages: string[], options?: { checkIntegrity?: boolean }): Promise<void>;
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
};

type CoreManifest = {
  engineVersion: string;
  files: Record<string, string>;
};

type RuntimeState = {
  pyodide: PyodideInstance;
  runtimeVersion: string;
  engineVersion: string;
  pythonVersion: string;
  packageVersions: Record<string, string>;
};

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

let runtimePromise: Promise<RuntimeState> | undefined;
let analysisRunning = false;
let activeSongContext: ActiveSongContext | undefined;
let operationQueue: Promise<void> = Promise.resolve();

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  // One interpreter owns shared Python globals and the active song context.
  // Serialize operations even when the UI supersedes a previous request.
  operationQueue = operationQueue.then(() => handleMessage(message)).catch(error => {
    const request = M1EngineMessageSchema.safeParse(message);
    if (request.success) postError(request.data, "compute", "WORKER_OPERATION_FAILED", errorMessage(error), true, error);
  });
});

async function handleMessage(message: unknown): Promise<void> {
  const parsed = M1EngineMessageSchema.safeParse(message);
  if (!parsed.success) return;

  if (parsed.data.type === "engine-load") {
    try {
      const runtime = await ensureRuntime(parsed.data, postProgress);
      workerScope.postMessage(M1EngineLoadResultSchema.parse({
        ...parsed.data,
        type: "engine-loaded",
        runtime: "pyodide",
        runtimeVersion: runtime.runtimeVersion,
        pythonVersion: runtime.pythonVersion,
        packageVersions: runtime.packageVersions,
      }));
    } catch (error) {
      postError(parsed.data, "init", "RUNTIME_INITIALIZATION_FAILED", errorMessage(error), true, error);
    }
    return;
  }

  if (parsed.data.type === "export-midi") {
    const request = M1ExportMidiRequestSchema.parse(parsed.data);
    try {
      const runtime = await ensureRuntime(request, postProgress);
      const inputPath = `/tmp/export-${crypto.randomUUID()}.mid`;
      runtime.pyodide.FS.writeFile(inputPath, new Uint8Array(request.midiBytes));
      runtime.pyodide.globals.set("__export_input_path", inputPath);
      runtime.pyodide.globals.set("__export_doc_json", JSON.stringify(request.document));
      runtime.pyodide.globals.set("__export_plan_json", JSON.stringify(request.fingeringPlan));

      try {
        await runtime.pyodide.runPythonAsync(`
import json
from handthesia_core.api import export_fingered_midi

with open(__export_input_path, "rb") as __f:
    __raw_bytes = __f.read()
__res = export_fingered_midi(__raw_bytes, json.loads(__export_doc_json), json.loads(__export_plan_json))
__export_out_bytes = __res["exportedBytes"]
__export_marked_count = __res["markedCount"]
__export_diagnostics_json = json.dumps(__res.get("diagnostics", []))
`);
        const pyBytes = runtime.pyodide.globals.get("__export_out_bytes") as { toJs(): Uint8Array };
        const exportedUint8 = pyBytes.toJs();
        const markedCount = Number(runtime.pyodide.globals.get("__export_marked_count"));
        const diagnostics = JSON.parse(
          String(runtime.pyodide.globals.get("__export_diagnostics_json") ?? "[]"),
        ) as unknown[];

        const responseBuffer = exportedUint8.buffer.slice(
          exportedUint8.byteOffset,
          exportedUint8.byteOffset + exportedUint8.byteLength,
        );

        const result = M1ExportMidiResultSchema.parse({
          type: "export-midi-result",
          requestId: request.requestId,
          projectId: request.projectId,
          revision: request.revision,
          engineVersion: request.engineVersion,
          exportedBytes: responseBuffer,
          markedCount,
          diagnostics,
        });
        workerScope.postMessage(result, [responseBuffer]);
      } finally {
        runtime.pyodide.FS.unlink(inputPath);
        runtime.pyodide.globals.delete("__export_input_path");
        runtime.pyodide.globals.delete("__export_doc_json");
        runtime.pyodide.globals.delete("__export_plan_json");
        try {
          runtime.pyodide.runPython("globals().pop('__raw_bytes', None); globals().pop('__res', None); globals().pop('__export_out_bytes', None); globals().pop('__export_marked_count', None); globals().pop('__export_diagnostics_json', None)");
        } catch {
          // ignore
        }
      }
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
      postError(request, "compute", "MIDI_SIZE_LIMIT", `MIDI input exceeds the ${maxMidiBytes / (1024 * 1024)} MiB browser limit.`, false);
      return;
    }

    analysisRunning = true;
    try {
      postProgress(request, "load", "Checking the pinned local runtime assets for a typed document replan.");
      const runtime = await ensureRuntime(request, postProgress);
      if (runtime.engineVersion !== request.engineVersion) {
        request.engineVersion = runtime.engineVersion;
      }

      const inputPath = `/tmp/replan-${crypto.randomUUID()}.mid`;
      runtime.pyodide.FS.writeFile(inputPath, new Uint8Array(request.midiBytes));
      runtime.pyodide.globals.set("__m1_replan_input_path", inputPath);
      runtime.pyodide.globals.set("__m1_replan_document_json", JSON.stringify(request.document));
      runtime.pyodide.globals.set("__m1_replan_fingering_json", JSON.stringify(request.fingeringPlan));
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
      runtime.pyodide.globals.set("__m1_replan_options_json", JSON.stringify(options));
      runtime.pyodide.globals.set("__m1_progress_cb", (fraction: number, message: string) => {
        postProgress(request, "compute", message, fraction);
      });

      let responseJson: string;
      try {
        postProgress(request, "compute", "Rebuilding plans from the original MIDI and edited note identities.", 0.05);
        responseJson = String(await runtime.pyodide.runPythonAsync(`
import json
import handthesia_core.api
from handthesia_core.api import replan_document

handthesia_core.api.set_progress_callback(__m1_progress_cb)

with open(__m1_replan_input_path, "rb") as __m1_replan_file:
    __m1_replan_bytes = __m1_replan_file.read()
__m1_replan_result = replan_document(
    __m1_replan_bytes,
    json.loads(__m1_replan_document_json),
    json.loads(__m1_replan_fingering_json),
    json.loads(__m1_replan_options_json),
)
json.dumps(__m1_replan_result, separators=(",", ":"), allow_nan=False)
`));
      } finally {
        try {
          runtime.pyodide.runPython("import handthesia_core.api; handthesia_core.api.set_progress_callback(None)");
        } catch {
          // ignore
        }
        runtime.pyodide.globals.delete("__m1_progress_cb");
        runtime.pyodide.FS.unlink(inputPath);
        runtime.pyodide.globals.delete("__m1_replan_input_path");
        runtime.pyodide.globals.delete("__m1_replan_document_json");
        runtime.pyodide.globals.delete("__m1_replan_fingering_json");
        runtime.pyodide.globals.delete("__m1_replan_options_json");
        try {
          runtime.pyodide.runPython("globals().pop('__m1_replan_file', None); globals().pop('__m1_replan_bytes', None); globals().pop('__m1_replan_result', None)");
        } catch {
          // Temporary Python names are best-effort cleanup; the input file and JS globals are always removed above.
        }
      }

      const pythonResult = JSON.parse(responseJson) as Record<string, unknown>;
      const result = validateM1ReplanDocumentResultForRequest(request, {
        ...pythonResult,
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
      const stage = error instanceof WorkerStageError ? error.stage : "compute";
      const code = error instanceof WorkerStageError ? error.code : "REPLAN_FAILED";
      postError(request, stage, code, errorMessage(error), error instanceof WorkerStageError ? error.retryable : false, error);
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
      const runtime = await ensureRuntime(request, postProgress);
      if (runtime.engineVersion !== request.engineVersion) {
        request.engineVersion = runtime.engineVersion;
      }

      const matching = activeSongContext?.projectId === request.projectId && activeSongContext.revision === request.revision
        ? activeSongContext
        : undefined;

      let inputPath = "";
      if (matching?.midiBytes) {
        inputPath = `/tmp/sm-${crypto.randomUUID()}.mid`;
        runtime.pyodide.FS.writeFile(inputPath, matching.midiBytes);
        runtime.pyodide.globals.set("__sm_input_path", inputPath);
        runtime.pyodide.globals.set("__sm_doc_json", JSON.stringify(matching.document ?? null));
        runtime.pyodide.globals.set("__sm_plan_json", JSON.stringify(matching.fingeringPlan ?? null));
      } else {
        runtime.pyodide.globals.set("__sm_input_path", "");
        runtime.pyodide.globals.set("__sm_doc_json", "");
        runtime.pyodide.globals.set("__sm_plan_json", "");
      }

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
      runtime.pyodide.globals.set("__sm_options_json", JSON.stringify(options));
      runtime.pyodide.globals.set("__sm_start", request.startTimeSeconds);
      runtime.pyodide.globals.set("__sm_end", request.endTimeSeconds);

      let responseJson: string;
      try {
        responseJson = String(await runtime.pyodide.runPythonAsync(`
import json
from handthesia_core.api import sample_motion_window

__sm_raw_bytes = b""
if __sm_input_path:
    with open(__sm_input_path, "rb") as __sm_f:
        __sm_raw_bytes = __sm_f.read()

__sm_doc = json.loads(__sm_doc_json) if __sm_doc_json else None
__sm_plan = json.loads(__sm_plan_json) if __sm_plan_json else None
__sm_options = json.loads(__sm_options_json) if __sm_options_json else {}

__sm_result = sample_motion_window(
    __sm_raw_bytes,
    __sm_doc,
    __sm_plan,
    float(__sm_start),
    float(__sm_end),
    __sm_options,
)
json.dumps(__sm_result, separators=(",", ":"), allow_nan=False)
`));
      } finally {
        if (inputPath) {
          try {
            runtime.pyodide.FS.unlink(inputPath);
          } catch {
            // best-effort cleanup
          }
        }
        runtime.pyodide.globals.delete("__sm_input_path");
        runtime.pyodide.globals.delete("__sm_doc_json");
        runtime.pyodide.globals.delete("__sm_plan_json");
        runtime.pyodide.globals.delete("__sm_options_json");
        runtime.pyodide.globals.delete("__sm_start");
        runtime.pyodide.globals.delete("__sm_end");
        try {
          runtime.pyodide.runPython("globals().pop('__sm_raw_bytes', None); globals().pop('__sm_doc', None); globals().pop('__sm_plan', None); globals().pop('__sm_options', None); globals().pop('__sm_result', None)");
        } catch {
          // ignore
        }
      }

      const pythonResult = JSON.parse(responseJson) as Record<string, unknown>;
      const result = M1SampleMotionResultSchema.parse({
        ...pythonResult,
        type: "sample-motion-result",
        requestId: request.requestId,
        projectId: request.projectId,
        revision: request.revision,
        engineVersion: request.engineVersion,
      });
      workerScope.postMessage(result);
    } catch (error) {
      const stage = error instanceof WorkerStageError ? error.stage : "compute";
      const code = error instanceof WorkerStageError ? error.code : "SAMPLE_MOTION_FAILED";
      postError(request, stage, code, errorMessage(error), error instanceof WorkerStageError ? error.retryable : false, error);
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
    postError(request, "compute", "MIDI_SIZE_LIMIT", `MIDI input exceeds the ${maxMidiBytes / (1024 * 1024)} MiB browser limit.`, false);
    return;
  }

  analysisRunning = true;
  try {
    postProgress(request, "load", "Checking the pinned local runtime assets.");
    const runtime = await ensureRuntime(request, postProgress);
    if (runtime.engineVersion !== request.engineVersion) {
      request.engineVersion = runtime.engineVersion;
    }

    postProgress(request, "compute", "Starting Python analysis in the Worker.", 0.05);
    const inputPath = `/tmp/m1-${crypto.randomUUID()}.mid`;
    const options = {
      ...request.options,
      fixtureId: request.options.fixtureId ?? "imported-midi",
      projectId: request.projectId,
      revision: request.revision,
      requestId: request.requestId,
      engineVersion: runtime.engineVersion,
      sampleDense:
        request.options.sampleDense ??
        (request.options.fixtureId === "imported-midi" ||
          request.options.fixtureId === undefined ||
          request.options.fixtureId.startsWith("builtin-")),
      ...(request.profile ? { profile: request.profile } : {}),
    };
    runtime.pyodide.FS.writeFile(inputPath, new Uint8Array(request.midiBytes));
    runtime.pyodide.globals.set("__m1_request_options_json", JSON.stringify(options));
    runtime.pyodide.globals.set("__m1_input_path", inputPath);
    runtime.pyodide.globals.set("__m1_progress_cb", (fraction: number, message: string) => {
      postProgress(request, "compute", message, fraction);
    });

    let responseJson: string;
    try {
      responseJson = String(await runtime.pyodide.runPythonAsync(`
import json
import handthesia_core.api
from handthesia_core.api import analyze_midi

handthesia_core.api.set_progress_callback(__m1_progress_cb)

with open(__m1_input_path, "rb") as __m1_input_file:
    __m1_midi_bytes = __m1_input_file.read()
__m1_analysis_result = analyze_midi(__m1_midi_bytes, json.loads(__m1_request_options_json))
json.dumps(__m1_analysis_result, separators=(",", ":"), allow_nan=False)
`));
    } finally {
      try {
        runtime.pyodide.runPython("import handthesia_core.api; handthesia_core.api.set_progress_callback(None)");
      } catch {
        // ignore
      }
      runtime.pyodide.globals.delete("__m1_progress_cb");
      runtime.pyodide.FS.unlink(inputPath);
      runtime.pyodide.globals.delete("__m1_request_options_json");
      runtime.pyodide.globals.delete("__m1_input_path");
      try {
        runtime.pyodide.runPython("globals().pop('__m1_input_file', None); globals().pop('__m1_midi_bytes', None); globals().pop('__m1_analysis_result', None)");
      } catch {
        // Temporary Python names are best-effort cleanup; the input file and JS globals are always removed above.
      }
    }

    const pythonResult: unknown = JSON.parse(responseJson);
    const result = validateM1AnalyzeMidiResultForRequest(request, {
      ...pythonResult as Record<string, unknown>,
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
    const stage = error instanceof WorkerStageError ? error.stage : "compute";
    const code = error instanceof WorkerStageError ? error.code : "ANALYSIS_FAILED";
    postError(request, stage, code, errorMessage(error), error instanceof WorkerStageError ? error.retryable : false, error);
  } finally {
    analysisRunning = false;
  }
}

async function ensureRuntime(
  identity: { requestId: string; projectId: string; revision: number; engineVersion: string },
  report: typeof postProgress,
): Promise<RuntimeState> {
  if (runtimePromise) {
    report(identity, "init", "Using the initialized local Pyodide runtime.");
    return runtimePromise;
  }

  runtimePromise = initializeRuntime(identity, report);
  try {
    return await runtimePromise;
  } catch (error) {
    runtimePromise = undefined;
    throw error;
  }
}

async function initializeRuntime(
  identity: { requestId: string; projectId: string; revision: number; engineVersion: string },
  report: typeof postProgress,
): Promise<RuntimeState> {
  report(identity, "load", "Loading self-hosted Pyodide 314.0.7.");
  const runtimeBaseUrl = releaseAssetUrl("pyodide/");
  const assetManifest = await fetchJson(new URL("asset-manifest.json", runtimeBaseUrl)) as {
    runtime?: { version?: string; pythonVersion?: string; abiVersion?: string; platform?: string };
    files?: Array<{ path: string; sha256: string }>;
    purePythonWheels?: Array<{ name: string; file: string; sha256: string }>;
  };
  if (assetManifest.runtime?.version !== pyodidePins.runtime.version ||
      assetManifest.runtime.pythonVersion !== pyodidePins.runtime.pythonVersion ||
      assetManifest.runtime.abiVersion !== pyodidePins.runtime.abiVersion ||
      assetManifest.runtime.platform !== pyodidePins.runtime.platform) {
    throw new WorkerStageError("load", "RUNTIME_MANIFEST_MISMATCH", "The local Pyodide assets do not match the pinned runtime manifest.");
  }

  const wheelManifestByName = new Map((assetManifest.purePythonWheels ?? []).map((wheel) => [wheel.name, wheel]));
  const wheelPaths: string[] = [];
  const pyodideModule = await loadPyodideModule(new URL("pyodide.mjs", runtimeBaseUrl));
  if (pyodideModule.version !== pyodidePins.runtime.version) {
    throw new WorkerStageError("load", "RUNTIME_VERSION_MISMATCH", "The loaded Pyodide module does not match the pinned runtime version.");
  }
  const pyodide = await pyodideModule.loadPyodide({ indexURL: runtimeBaseUrl.href }) as PyodideInstance;

  report(identity, "init", "Loading Pyodide catalog packages and pinned pure-Python wheels.");
  await pyodide.loadPackage(pyodidePins.catalogPackages.map((pkg) => pkg.name), { checkIntegrity: true });
  pyodide.FS.mkdirTree("/m1-wheels");

  for (const wheel of pyodidePins.purePythonWheels) {
    const builtWheel = wheelManifestByName.get(wheel.name);
    if (!builtWheel || builtWheel.file !== wheel.file || builtWheel.sha256 !== wheel.sha256) {
      throw new WorkerStageError("init", "WHEEL_MANIFEST_MISMATCH", `The staged ${wheel.name} wheel does not match its source pin.`);
    }
    const wheelUrl = releaseAssetUrl(`pyodide/wheels/${wheel.file}`);
    const bytes = await fetchBytes(wheelUrl);
    if (await sha256(bytes) !== wheel.sha256) {
      throw new WorkerStageError("init", "WHEEL_CHECKSUM_MISMATCH", `SHA-256 verification failed for ${wheel.file}.`);
    }
    const emfsPath = `/m1-wheels/${wheel.file}`;
    pyodide.FS.writeFile(emfsPath, new Uint8Array(bytes));
    wheelPaths.push(`emfs:${emfsPath}`);
  }

  pyodide.globals.set("__m1_wheel_paths_json", JSON.stringify(wheelPaths));
  try {
    await pyodide.runPythonAsync(`
import json
import micropip
await micropip.install(json.loads(__m1_wheel_paths_json), deps=False)
`);
  } finally {
    pyodide.globals.delete("__m1_wheel_paths_json");
  }

  const coreManifest = await fetchJson(releaseAssetUrl("python-core/source_manifest.json")) as CoreManifest;
  const files = validateCoreManifest(coreManifest);
  const canonicalFilesJson = JSON.stringify({ files: Object.fromEntries(files) });
  const computedEngineVersion = await sha256(new TextEncoder().encode(canonicalFilesJson));
  if (computedEngineVersion !== coreManifest.engineVersion) {
    throw new WorkerStageError("init", "CORE_MANIFEST_CHECKSUM_MISMATCH", "The packaged Python-core manifest hash is invalid.");
  }
  if (identity.engineVersion && identity.engineVersion !== computedEngineVersion) {
    report(identity, "init", `Reconciling engine version: requested ${identity.engineVersion.slice(0, 8)}, packaged core is ${computedEngineVersion.slice(0, 8)}.`);
  }

  report(identity, "init", `Verifying ${files.length} packaged Python-core source files.`);
  pyodide.FS.mkdirTree("/python-core");
  for (const [relativePath, expectedHash] of files) {
    const sourceUrl = releaseAssetUrl(`python-core/${relativePath}`);
    const bytes = await fetchBytes(sourceUrl);
    if (await sha256(bytes) !== expectedHash) {
      throw new WorkerStageError("init", "CORE_SOURCE_CHECKSUM_MISMATCH", `SHA-256 verification failed for ${relativePath}.`);
    }
    const destinationPath = `/python-core/${relativePath}`;
    const parentDirectory = destinationPath.slice(0, destinationPath.lastIndexOf("/"));
    pyodide.FS.mkdirTree(parentDirectory);
    pyodide.FS.writeFile(destinationPath, new Uint8Array(bytes));
  }

  const manifestBytes = new TextEncoder().encode(JSON.stringify(coreManifest));
  pyodide.FS.writeFile("/python-core/handthesia_core/source_manifest.json", manifestBytes);

  await pyodide.runPythonAsync(`
import sys
sys.path.insert(0, "/python-core")
import handthesia_core.api
`);
  const details = JSON.parse(String(pyodide.runPython(`
import importlib.metadata
import json
import sys
json.dumps({
    "pythonVersion": sys.version.split()[0],
    "packageVersions": {
        "numpy": importlib.metadata.version("numpy"),
        "packaging": importlib.metadata.version("packaging"),
        "pretty_midi": importlib.metadata.version("pretty-midi"),
        "mido": importlib.metadata.version("mido"),
        "importlib_resources": importlib.metadata.version("importlib-resources"),
    },
}, separators=(",", ":"))
`)));
  return {
    pyodide,
    runtimeVersion: pyodideModule.version,
    engineVersion: computedEngineVersion,
    pythonVersion: details.pythonVersion as string,
    packageVersions: details.packageVersions as Record<string, string>,
  };
}

function validateCoreManifest(manifest: CoreManifest): Array<[string, string]> {
  if (!manifest || typeof manifest.engineVersion !== "string" || !/^[a-f0-9]{64}$/.test(manifest.engineVersion) ||
      !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new WorkerStageError("init", "CORE_MANIFEST_INVALID", "The packaged Python-core manifest has an invalid shape.");
  }
  const entries = Object.entries(manifest.files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (entries.length === 0) {
    throw new WorkerStageError("init", "CORE_MANIFEST_EMPTY", "The packaged Python-core manifest contains no source files.");
  }
  for (const [relativePath, hash] of entries) {
    const segments = relativePath.replaceAll("\\", "/").split("/");
    if (relativePath.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..") ||
        !/^[a-f0-9]{64}$/.test(hash)) {
      throw new WorkerStageError("init", "CORE_MANIFEST_INVALID", `The Python-core manifest has an unsafe entry: ${relativePath}.`);
    }
  }
  return entries;
}

async function loadPyodideModule(url: URL): Promise<{ version: string; loadPyodide(options: { indexURL: string }): Promise<PyodideInstance> }> {
  return import(/* @vite-ignore */ url.href) as Promise<{ version: string; loadPyodide(options: { indexURL: string }): Promise<PyodideInstance> }>;
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new WorkerStageError("load", "LOCAL_ASSET_FETCH_FAILED", `Could not load local asset ${url.pathname}: HTTP ${response.status}.`);
  return response.json() as Promise<unknown>;
}

async function fetchBytes(url: URL): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new WorkerStageError("init", "LOCAL_ASSET_FETCH_FAILED", `Could not load local asset ${url.pathname}: HTTP ${response.status}.`);
  return response.arrayBuffer();
}

async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const input = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function postProgress(
  identity: { requestId: string; projectId: string; revision: number; engineVersion: string },
  stage: M1EngineStage,
  message: string,
  progress?: number,
): void {
  workerScope.postMessage(M1EngineProgressSchema.parse({
    requestId: identity.requestId,
    projectId: identity.projectId,
    revision: identity.revision,
    engineVersion: identity.engineVersion,
    type: "progress",
    stage,
    message,
    ...(typeof progress === "number" ? { progress: Math.max(0, Math.min(1, progress)) } : {}),
  }));
}

function postError(
  identity: { requestId: string; projectId: string; revision: number; engineVersion: string },
  stage: M1EngineStage,
  code: string,
  message: string,
  retryable: boolean,
  cause?: unknown,
): void {
  workerScope.postMessage(M1EngineErrorSchema.parse({
    requestId: identity.requestId,
    projectId: identity.projectId,
    revision: identity.revision,
    engineVersion: identity.engineVersion,
    type: "worker-error",
    stage,
    error: { code, message, retryable, ...(cause instanceof Error && cause.stack ? { stack: cause.stack.slice(0, 8_000) } : {}) },
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class WorkerStageError extends Error {
  constructor(
    readonly stage: M1EngineStage,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WorkerStageError";
  }
}
