import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(repoRoot, "docs", "evidence", "audit-repair-2026-10-15", "motion-benchmark.json");
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.PIANOMOTION_BASE_URL || "http://127.0.0.1:4173",
    timeoutMs: Number(process.env.PIANOMOTION_MOTION_TIMEOUT_MS || 120_000),
    noteCounts: [2_000, 10_000, 50_000],
    output: defaultOutput,
    overwrite: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      console.log("Usage: node tools/benchmark-motion.mjs [--base-url URL] [--timeout-ms N] [--notes 2000,10000,50000] [--output PATH] [--overwrite]");
      process.exit(0);
    }
    if (value === "--overwrite") { options.overwrite = true; continue; }
    const next = argv[index + 1];
    if (!next) throw new Error(`Missing value after ${value}`);
    if (value === "--base-url") options.baseUrl = next;
    else if (value === "--timeout-ms") options.timeoutMs = Number(next);
    else if (value === "--notes") options.noteCounts = next.split(",").map(Number);
    else if (value === "--output") options.output = path.resolve(next);
    else throw new Error(`Unknown argument: ${value}`);
    index += 1;
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) throw new Error("--timeout-ms must be an integer >= 1000");
  if (options.noteCounts.length === 0 || options.noteCounts.some(count => !Number.isInteger(count) || count < 1)) {
    throw new Error("--notes must be comma-separated positive integers");
  }
  return options;
}

function encodeVariableLength(value) {
  const bytes = [value & 0x7f];
  while ((value >>= 7) > 0) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

/** Create a sequential, deterministic type-0 MIDI with the requested note count. */
function makeStressMidi(noteCount) {
  const track = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]; // 500,000 us per quarter note
  let lastTick = 0;
  for (let index = 0; index < noteCount; index += 1) {
    const note = 48 + (index % 36);
    const onset = index * 60;
    const release = onset + 30;
    track.push(...encodeVariableLength(onset - lastTick), 0x90, note, 0x60);
    lastTick = onset;
    track.push(...encodeVariableLength(release - lastTick), 0x80, note, 0x00);
    lastTick = release;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 0x78]); // 120 PPQ
  const trackHeader = Buffer.alloc(8);
  trackHeader.write("MTrk", 0, "ascii");
  trackHeader.writeUInt32BE(track.length, 4);
  return Buffer.concat([header, trackHeader, Buffer.from(track)]);
}

async function readWindowsProcessMemory(pids) {
  const numericPids = [...new Set(pids.map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  if (process.platform !== "win32" || numericPids.length === 0) {
    return { status: "unavailable", requestedPids: numericPids };
  }
  // PIDs come only from SystemInfo.getProcessInfo for the Chromium instance
  // launched by this harness. Interpolation is limited to validated integers.
  const powershell = `$pids = @(${numericPids.join(",")}); $rows = @(Get-Process -Id $pids -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = [int]$_.Id; privateBytes = [long]$_.PrivateMemorySize64; workingSetBytes = [long]$_.WorkingSet64 } }); ConvertTo-Json -InputObject $rows -Compress`;
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershell,
  ], { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const requested = new Set(numericPids);
  const processes = rows
    .filter(row => requested.has(Number(row.pid)))
    .map(row => ({
      pid: Number(row.pid),
      privateBytes: Number(row.privateBytes),
      workingSetBytes: Number(row.workingSetBytes),
    }));
  return {
    status: "measured",
    requestedProcessCount: numericPids.length,
    sampledProcessCount: processes.length,
    privateBytes: processes.reduce((sum, item) => sum + item.privateBytes, 0),
    workingSetBytes: processes.reduce((sum, item) => sum + item.workingSetBytes, 0),
    processes,
  };
}

async function createBrowserProcessMemorySampler(browser) {
  if (process.platform !== "win32" || typeof browser.newBrowserCDPSession !== "function") {
    return {
      startCase: async () => {},
      stopCase: async () => ({ status: "unavailable", reason: "Windows Chromium CDP process sampling is unavailable." }),
      dispose: async () => {},
    };
  }

  const cdp = await browser.newBrowserCDPSession();
  let timer = null;
  let sampling = false;
  let before = null;
  let after = null;
  let peakPrivate = null;
  let peakWorkingSet = null;
  let peakSnapshot = null;
  let sampleCount = 0;
  let errors = [];

  async function sample(stage) {
    if (sampling) return null;
    sampling = true;
    try {
      const { processInfo = [] } = await cdp.send("SystemInfo.getProcessInfo");
      const processTypes = {};
      for (const processInfoItem of processInfo) {
        processTypes[processInfoItem.type] = (processTypes[processInfoItem.type] ?? 0) + 1;
      }
      const memory = await readWindowsProcessMemory(processInfo.map(processInfoItem => processInfoItem.id));
      const snapshot = { stage, sampledAt: new Date().toISOString(), processTypes, ...memory };
      sampleCount += 1;
      if (stage === "before") before = snapshot;
      if (stage === "after") after = snapshot;
      if (memory.status === "measured") {
        if (peakPrivate === null || memory.privateBytes > peakPrivate) {
          peakPrivate = memory.privateBytes;
          peakSnapshot = snapshot;
        }
        if (peakWorkingSet === null || memory.workingSetBytes > peakWorkingSet) {
          peakWorkingSet = memory.workingSetBytes;
        }
      }
      return snapshot;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      sampling = false;
    }
  }

  return {
    async startCase() {
      before = null;
      after = null;
      peakPrivate = null;
      peakWorkingSet = null;
      peakSnapshot = null;
      sampleCount = 0;
      errors = [];
      await sample("before");
      timer = setInterval(() => { void sample("during"); }, 1_000);
    },
    async stopCase() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      while (sampling) await new Promise(resolve => setTimeout(resolve, 10));
      await sample("after");
      const status = errors.length > 0 && before === null && after === null ? "unavailable" : "measured";
      return {
        status,
        measurementScope: "sum of PrivateMemorySize64 and WorkingSet64 for PIDs reported by this launched Chromium CDP session",
        includesWorkerAndWasmButDoesNotIsolateWorker: true,
        before,
        peakPrivateBytes: peakPrivate,
        peakPrivateMiB: peakPrivate === null ? null : Number((peakPrivate / (1024 * 1024)).toFixed(1)),
        peakWorkingSetBytes: peakWorkingSet,
        peakWorkingSetMiB: peakWorkingSet === null ? null : Number((peakWorkingSet / (1024 * 1024)).toFixed(1)),
        peakSnapshot,
        afterWorkerTermination: after,
        sampleCount,
        errors,
      };
    },
    async dispose() {
      if (timer !== null) clearInterval(timer);
      await cdp.detach();
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (fs.existsSync(options.output) && !options.overwrite) {
    throw new Error(`Refusing to overwrite existing evidence: ${options.output} (pass --overwrite explicitly)`);
  }
  const health = await fetch(new URL("/python-core/source_manifest.json", options.baseUrl));
  if (!health.ok) throw new Error(`No packaged Python source manifest at ${options.baseUrl}: HTTP ${health.status}`);
  const sourceManifest = await health.json();
  if (!/^[a-f0-9]{64}$/.test(sourceManifest.engineVersion ?? "")) {
    throw new Error("Packaged Python source manifest has no valid engineVersion");
  }

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PIANOMOTION_BROWSER_CHANNEL ? { channel: process.env.PIANOMOTION_BROWSER_CHANNEL } : {}),
  });
  const browserVersion = browser.version();
  const browserMemorySampler = await createBrowserProcessMemorySampler(browser);
  const page = await browser.newPage();
  const cases = [];
  try {
    await page.goto(new URL("/manifest.webmanifest", options.baseUrl).href);
    for (const noteCount of options.noteCounts) {
      const generationStartedAt = performance.now();
      const midi = makeStressMidi(noteCount);
      const generationMs = Number((performance.now() - generationStartedAt).toFixed(2));
      await browserMemorySampler.startCase();
      let sample;
      try {
        sample = await page.evaluate(async ({ midiBase64, requestedNotes, timeoutMs }) => {
        const importBrowserModule = (url) => import(new URL(url, globalThis.location.origin).href);
        const client = await importBrowserModule("/src/m1WorkerClient.ts");
        const sourceResponse = await fetch("/python-core/source_manifest.json", { cache: "no-store" });
        if (!sourceResponse.ok) throw new Error(`Python source manifest returned ${sourceResponse.status}`);
        const sourceManifest = await sourceResponse.json();
        const bytes = Uint8Array.from(atob(midiBase64), character => character.charCodeAt(0));
        const midiBytes = bytes.buffer;
        const projectId = `motion-benchmark-${requestedNotes}-${crypto.randomUUID()}`;
        const request = {
          type: "analyze-midi",
          requestId: `motion-benchmark-${crypto.randomUUID()}`,
          projectId,
          revision: 1,
          engineVersion: sourceManifest.engineVersion,
          midiBytes,
          options: { fixtureId: "imported-midi", keyStyle: "realistic", sampleDense: false },
        };
        const memoryApi = performance.measureUserAgentSpecificMemory;
        let lastMemoryError = null;
        async function readMemory() {
          if (typeof memoryApi === "function") {
            try {
              const measurement = await memoryApi.call(performance);
              return { bytes: measurement.bytes, scope: "user-agent-specific" };
            } catch (error) {
              lastMemoryError = String(error);
            }
          }
          const pageMemory = performance.memory;
          return pageMemory && Number.isFinite(pageMemory.usedJSHeapSize)
            ? { bytes: pageMemory.usedJSHeapSize, scope: "main-realm-js-heap-only" }
            : { bytes: null, scope: "unavailable" };
        }

        let heartbeatTicks = 0;
        let rafFrames = 0;
        let maxHeartbeatGapMs = 0;
        let maxFrameGapMs = 0;
        let lastHeartbeat = performance.now();
        let lastFrame = lastHeartbeat;
        let peakMemory = null;
        let samplingMemory = false;
        const samplePeak = async () => {
          if (samplingMemory) return;
          samplingMemory = true;
          try {
            const current = await readMemory();
            if (current.bytes !== null && (peakMemory === null || current.bytes > peakMemory.bytes)) peakMemory = current;
          } finally {
            samplingMemory = false;
          }
        };
        const interval = setInterval(() => {
          const now = performance.now();
          heartbeatTicks += 1;
          maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - lastHeartbeat);
          lastHeartbeat = now;
        }, 50);
        let rafId = 0;
        const tickFrame = () => {
          const now = performance.now();
          rafFrames += 1;
          maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame);
          lastFrame = now;
          rafId = globalThis.requestAnimationFrame(tickFrame);
        };
        rafId = globalThis.requestAnimationFrame(tickFrame);
        const memoryBefore = await readMemory();
        const memoryInterval = setInterval(() => { void samplePeak(); }, 1_000);
        if (memoryBefore.bytes !== null) peakMemory = memoryBefore;
        const worker = client.createM1AnalysisWorker();
        const startedAt = performance.now();

        const outcome = await new Promise(resolve => {
          let settled = false;
          const finish = async (status, detail = {}) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            worker.removeEventListener("messageerror", onMessageError);
            const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
            if (status === "timeout_unsupported") worker.terminate();
            const memoryAtTerminal = await readMemory();
            worker.terminate();
            await new Promise(resolveFrame => setTimeout(resolveFrame, 100));
            const memoryAfterTermination = await readMemory();
            clearInterval(interval);
            clearInterval(memoryInterval);
            globalThis.cancelAnimationFrame(rafId);
            resolve({
              status,
              requestedNotes,
              midiBytes: midiBytes.byteLength,
              elapsedMs,
              heartbeatIntervalMs: 50,
              heartbeatTicks,
              expectedHeartbeatTicks: Number((elapsedMs / 50).toFixed(1)),
              heartbeatRatio: elapsedMs > 0 ? Number((heartbeatTicks / (elapsedMs / 50)).toFixed(3)) : null,
              maxHeartbeatGapMs: Number(maxHeartbeatGapMs.toFixed(2)),
              animationFrames: rafFrames,
              maxAnimationFrameGapMs: Number(maxFrameGapMs.toFixed(2)),
              memory: {
                measurementScope: memoryBefore.scope,
                beforeBytes: memoryBefore.bytes,
                peakBytes: peakMemory?.bytes ?? null,
                atTerminalBytes: memoryAtTerminal.bytes,
                afterTerminationBytes: memoryAfterTermination.bytes,
                fallbackScopeExcludesWorkerHeap: memoryBefore.scope === "main-realm-js-heap-only",
                measurementError: lastMemoryError,
              },
              ...detail,
            });
          };
          const timer = setTimeout(() => {
            void finish("timeout_unsupported", { reason: `Worker analysis exceeded the ${timeoutMs}ms bounded timeout and was terminated.` });
          }, timeoutMs);
          const onMessage = event => {
            const message = event.data;
            if (message?.requestId !== request.requestId || message?.projectId !== request.projectId ||
                message?.revision !== request.revision) return;
            if (message.type === "analysis-result") {
              const result = message;
              void finish(result.status === "loaded" || result.status === "repaired" ? "completed" : "invalid_result", {
                resultStatus: result.status,
                normalizedNoteCount: result.document?.notes?.length ?? null,
                sparseDiagnosticPoseCount: result.rawBaseline?.selectedPoses?.length ?? null,
                initialMotionPoseCount: result.initialMotionWindow?.poses?.length ?? 0,
                initialMotionEndSeconds: result.initialMotionWindow?.endTimeSeconds ?? null,
                initialMotionTruncated: result.initialMotionWindow?.truncated ?? null,
                diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : [],
                rawBaselineStatus: result.rawBaseline?.status ?? null,
                sourceParseErrors: Array.isArray(result.rawBaseline?.sourceParseErrors)
                  ? result.rawBaseline.sourceParseErrors
                  : [],
              });
            } else if (message.type === "worker-error") {
              void finish("worker_error", { errorCode: message.error.code, errorMessage: message.error.message, retryable: message.error.retryable });
            }
          };
          const onError = event => { void finish("worker_error", { errorMessage: event.message || "Worker crashed" }); };
          const onMessageError = () => { void finish("worker_error", { errorMessage: "Worker message could not be decoded" }); };
          worker.addEventListener("message", onMessage);
          worker.addEventListener("error", onError);
          worker.addEventListener("messageerror", onMessageError);
          try { client.postM1AnalyzeMidiRequest(worker, request); }
          catch (error) { void finish("worker_error", { errorMessage: error instanceof Error ? error.message : String(error) }); }
        });

        return outcome;
        }, { midiBase64: midi.toString("base64"), requestedNotes: noteCount, timeoutMs: options.timeoutMs });
      } finally {
        sample = { ...(sample ?? { status: "worker_error", requestedNotes: noteCount }), browserProcessMemory: await browserMemorySampler.stopCase() };
      }
      cases.push({ ...sample, midiGenerationMs: generationMs });
      console.log(JSON.stringify(cases[cases.length - 1]));
    }
  } finally {
    await page.close();
    await browserMemorySampler.dispose();
    await browser.close();
  }

  const hasTimeouts = cases.some(testCase => testCase.status === "timeout_unsupported");
  const hasNonTimeoutFailures = cases.some(testCase => testCase.status !== "completed" && testCase.status !== "timeout_unsupported");
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    browserVersion,
    runtimeEngineVersion: sourceManifest.engineVersion,
    timeoutMsPerCase: options.timeoutMs,
    noteCounts: options.noteCounts,
    sourceMidi: "deterministic sequential note-on/off events, type 0, 120 PPQ, 120 BPM; 250 ms note-on spacing, 125 ms note duration",
    workloadScope: "Worker analyze-midi only, with a blank manifest page main-thread heartbeat and requestAnimationFrame probe; does not render the full Pixi/editor/player UI.",
    measurementNotes: [
      "Worker analysis timing includes runtime initialization for each fresh Worker.",
      "Heartbeat and animation-frame gaps measure responsiveness of the blank manifest page while work runs in a separate real Worker; they do not establish full-UI responsiveness at these note counts.",
      "User-agent-specific memory is preferred; the performance.memory fallback only describes the page realm and does not claim Worker heap usage.",
      "Windows process memory sums PrivateMemorySize64 and WorkingSet64 for only the PIDs reported by the launched Chromium instance's CDP SystemInfo.getProcessInfo; this includes Worker/WASM but is aggregate browser-process memory, not an isolated Worker measurement.",
      ...(hasTimeouts ? ["Timed-out note loads are labeled timeout_unsupported, terminated at the configured bound, and are not a pass or scalability claim."] : []),
    ],
    status: hasTimeouts && hasNonTimeoutFailures ? "incomplete_timeout_and_worker_error_or_invalid"
      : hasTimeouts ? "incomplete_timeout_unsupported"
        : hasNonTimeoutFailures ? "incomplete_worker_error_or_invalid" : "completed_all_cases",
    cases,
  };
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: options.overwrite ? "w" : "wx" });
  console.log(`Wrote motion benchmark evidence: ${options.output}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
