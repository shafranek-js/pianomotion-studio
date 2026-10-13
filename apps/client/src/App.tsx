import {
  M1EngineMessageSchema,
  validateM1AnalyzeMidiResultForRequest,
  type M1AnalyzeMidiRequest,
  type M1AnalyzeMidiResult,
  type M1EngineStage,
} from "@handthesia/contracts";
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { createM1AnalysisWorker, isCurrentM1WorkerMessage, postM1AnalyzeMidiRequest } from "./m1WorkerClient";
import { PianoPlayer } from "./player";
import { extractMidiFileFromDrop, initializeAppPersistence, loadSessionSnapshot, assessSessionSnapshot, type SessionSnapshot } from "./storage";
import { getActiveProfile } from "./profiles";
import { getSettings } from "./settings";

type FixtureEntry = {
  fixturePath: string;
  fixtureSha256: string;
  scenarios?: string[];
};

type FixtureManifest = {
  fixtureSources: Record<string, FixtureEntry>;
};

type SourceManifest = {
  engineVersion: string;
};

type DiagnosticStatus = {
  tone: "neutral" | "working" | "success" | "warning" | "error";
  message: string;
  stage?: M1EngineStage;
};

const maxMidiBytes = 16 * 1024 * 1024;
const analysisTimeoutMs = 180_000;
const appBaseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);

declare global {
  interface Window {
    __m1LastResult?: M1AnalyzeMidiResult | null;
    __m1LastError?: string | null;
  }
}

export default function App() {
  const [fixtureManifest, setFixtureManifest] = useState<FixtureManifest | null>(null);
  const [engineVersion, setEngineVersion] = useState("");
  const [manifestError, setManifestError] = useState("");
  const [selectedFixtureId, setSelectedFixtureId] = useState("tracked-right-hand");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [keyStyle, setKeyStyle] = useState<"realistic" | "equal">(() => getSettings().keyStyle);
  const [restoredSession, setRestoredSession] = useState<SessionSnapshot | null>(null);
  const [persistenceNotice, setPersistenceNotice] = useState("");
  const [status, setStatus] = useState<DiagnosticStatus>({
    tone: "neutral",
    message: "Pyodide stays idle until you start an analysis.",
  });
  const [result, setResult] = useState<M1AnalyzeMidiResult | null>(null);
  const [rawMidiBytes, setRawMidiBytes] = useState<ArrayBuffer | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [projectId, setProjectId] = useState<string>(() => crypto.randomUUID());

  const revisionRef = useRef(0);
  const requestCounterRef = useRef(0);
  const activeTokenRef = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  const activeRequestRef = useRef<M1AnalyzeMidiRequest | null>(null);
  const activeTimeoutRef = useRef<number | null>(null);
  const sourceAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      fetchJson(new URL("m1-fixtures/manifest.json", appBaseUrl)),
      fetchJson(new URL(`python-core/source_manifest.json?t=${Date.now()}`, appBaseUrl)),
    ]).then(async ([fixtures, core]) => {
      if (disposed) return;
      const parsedFixtures = fixtures as FixtureManifest;
      const parsedCore = core as SourceManifest;
      if (!parsedFixtures.fixtureSources || !/^[a-f0-9]{64}$/.test(parsedCore.engineVersion)) {
        throw new Error("The packaged fixture or Python-core manifest is invalid.");
      }
      try {
        await initializeAppPersistence();
        if (disposed) return;
        setKeyStyle(getSettings().keyStyle);
        const snapshot = await loadSessionSnapshot();
        if (snapshot) {
          const assessed = await assessSessionSnapshot(snapshot, parsedCore.engineVersion);
          if (disposed) return;
          if ((assessed.status === "compatible" || assessed.status === "recompute-required") && snapshot.result && snapshot.rawMidiBytes) {
            const session = {...snapshot, plansState: assessed.status === "compatible" ? "valid" as const : "recompute-required" as const};
            setRestoredSession(session);
            setResult(snapshot.result);
            setRawMidiBytes(snapshot.rawMidiBytes);
            setProjectId(snapshot.result.projectId);
            const restoredRevision = snapshot.draftFingeringPlan?.inputRevision ?? snapshot.result.revision;
            revisionRef.current = restoredRevision;
            setRevision(restoredRevision);
            setKeyStyle(snapshot.keyStyle ?? getSettings().keyStyle);
            const restoredFixtureId = snapshot.result.rawBaseline.fixtureId ?? "imported-midi";
            setSelectedFixtureId(parsedFixtures.fixtureSources[restoredFixtureId] ? restoredFixtureId : "custom-file");
            window.__m1LastResult = snapshot.result;
            setPersistenceNotice(assessed.status === "compatible" ? "Previous session restored, including its original MIDI." : "Previous edits restored; recalculating for the current engine.");
          } else setPersistenceNotice(`Saved session could not be restored: ${assessed.reasons.join("; ") || assessed.status}. It has been retained.`);
        }
      } catch (error) {
        if (!disposed) setPersistenceNotice(`Local persistence unavailable: ${errorMessage(error)}. You can continue without durable saving.`);
      }
      if (disposed) return;
      setFixtureManifest(parsedFixtures);
      setEngineVersion(parsedCore.engineVersion);
    }).catch((error: unknown) => {
      if (!disposed) setManifestError(errorMessage(error));
    });
    return () => {
      disposed = true;
      if (activeTimeoutRef.current !== null) window.clearTimeout(activeTimeoutRef.current);
      sourceAbortRef.current?.abort();
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const fixtureIds = Object.keys(fixtureManifest?.fixtureSources ?? {}).sort();
  const isCustomFile = selectedFixtureId === "custom-file";
  const currentFixture = fixtureManifest?.fixtureSources[selectedFixtureId];

  function changeSource(fixtureId: string) {
    cancelActiveJob("Source changed. The previous request was discarded.", false);
    setResult(null);
    setRestoredSession(null);
    setRawMidiBytes(null);
    bumpRevision();
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setSelectedFixtureId(fixtureId);
    setStatus({ tone: "neutral", message: "Source changed. The engine remains idle until analysis starts." });
  }

  function onFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    cancelActiveJob("Source changed. The previous request was discarded.", false);
    setResult(null);
    setRestoredSession(null);
    setRawMidiBytes(null);
    bumpRevision();
    setSelectedFile(file);
    setSelectedFixtureId("custom-file");
    if (file.size > maxMidiBytes) {
      setStatus({ tone: "error", message: `This file is ${(file.size / (1024 * 1024)).toFixed(1)} MiB. The browser diagnostic limit is 16 MiB.` });
    } else {
      setStatus({ tone: "neutral", message: `Selected ${file.name}. The original file remains available while its bytes are analyzed.` });
    }
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    const valResult = extractMidiFileFromDrop(event.nativeEvent);
    if (!valResult.valid) {
      setStatus({ tone: "error", message: valResult.error });
      return;
    }
    const file = valResult.file as File;
    cancelActiveJob("Source changed via drag-and-drop.", false);
    setResult(null);
    setRestoredSession(null);
    setRawMidiBytes(null);
    bumpRevision();
    setSelectedFile(file);
    setSelectedFixtureId("custom-file");
    setStatus({
      tone: "neutral",
      message: `Dropped ${valResult.filename} (${(valResult.sizeBytes / 1024).toFixed(1)} KiB). Ready for analysis.`,
    });
  }

  function changeKeyStyle(value: "realistic" | "equal") {
    if (value === keyStyle) return;
    cancelActiveJob("Keyboard geometry changed. The previous request was discarded.", false);
    bumpRevision();
    setResult(null);
    setRestoredSession(null);
    setKeyStyle(value);
    setStatus({ tone: "neutral", message: "Keyboard geometry changed. Run analysis to recalculate the plans." });
  }

  async function analyze() {
    if (!fixtureManifest || !engineVersion) return;
    if (isCustomFile && !selectedFile) {
      setStatus({ tone: "warning", message: "Choose a local MIDI file first." });
      return;
    }
    if (selectedFile && selectedFile.size > maxMidiBytes) {
      setStatus({ tone: "error", message: `The browser diagnostic limit is 16 MiB; this file is ${(selectedFile.size / (1024 * 1024)).toFixed(1)} MiB.` });
      return;
    }

    cancelActiveJob("Replacing the previous request.", false);
    const token = ++activeTokenRef.current;
    const requestId = `m1-${++requestCounterRef.current}-${crypto.randomUUID()}`;
    const currentRevision = revisionRef.current;
    setIsBusy(true);
    setResult(null);
    setRestoredSession(null);
    window.__m1LastResult = null;
    window.__m1LastError = null;
    setStatus({ tone: "working", stage: "load", message: "Reading the selected MIDI bytes." });
    const abortController = new AbortController();
    sourceAbortRef.current = abortController;

    let bytes: ArrayBuffer;
    let fixtureId: string;
    let fileName: string;
    try {
      if (selectedFile) {
        bytes = await selectedFile.arrayBuffer();
        fixtureId = "imported-midi";
        fileName = selectedFile.name;
      } else {
        const fixture = fixtureManifest.fixtureSources[selectedFixtureId];
        if (!fixture) throw new Error("The selected fixture is missing from the packaged manifest.");
        fixtureId = selectedFixtureId;
        fileName = fixture.fixturePath.split(/[\\/]/).at(-1) ?? fixtureId;
        const url = new URL(`m1-fixtures/${fixture.fixturePath}`, appBaseUrl);
        const response = await fetch(url, { signal: abortController.signal });
        if (!response.ok) throw new Error(`Could not load ${fileName}: HTTP ${response.status}.`);
        bytes = await response.arrayBuffer();
        const actualHash = await sha256(bytes);
        if (actualHash !== fixture.fixtureSha256) throw new Error(`Fixture checksum failed for ${fixtureId}.`);
      }
    } catch (error) {
      if (token !== activeTokenRef.current) return;
      sourceAbortRef.current = null;
      setIsBusy(false);
      setStatus({ tone: "error", message: `Input could not be read: ${errorMessage(error)}` });
      return;
    }
    sourceAbortRef.current = null;
    if (token !== activeTokenRef.current) return;

    setRawMidiBytes(bytes);

    const request = {
      type: "analyze-midi" as const,
      requestId,
      projectId,
      revision: currentRevision,
      engineVersion,
      midiBytes: bytes,
      profile: getActiveProfile(),
      options: {
        fixtureId,
        keyStyle,
        sampleDense: true,
      },
    } satisfies M1AnalyzeMidiRequest;
    activeRequestRef.current = request;

    const worker = workerRef.current ?? createM1AnalysisWorker();
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (token !== activeTokenRef.current || activeRequestRef.current?.requestId !== requestId) return;
      const parsed = M1EngineMessageSchema.safeParse(event.data);
      if (!parsed.success) {
        finishWithError(worker, requestId, token, `Worker returned an invalid protocol message: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
        return;
      }
      const message = parsed.data;
      if (!isCurrentM1WorkerMessage(message, request)) return;

      if (message.type === "progress") {
        setStatus({ tone: "working", stage: message.stage, message: message.message ?? stageLabel(message.stage) });
        return;
      }
      if (message.type === "engine-loaded") {
        setStatus({ tone: "working", stage: "compute", message: `Pyodide ${message.runtimeVersion} initialized; analyzing ${fileName}.` });
        return;
      }
      if (message.type === "worker-error") {
        clearActiveTimeout();
        activeRequestRef.current = null;
        setIsBusy(false);
        window.__m1LastError = `${message.error.code}: ${message.error.message}`;
        setStatus({ tone: "error", stage: message.stage, message: `${message.error.code}: ${message.error.message}` });
        return;
      }
      if (message.type === "cancelled") {
        clearActiveTimeout();
        activeRequestRef.current = null;
        setIsBusy(false);
        setStatus({ tone: "neutral", message: message.reason ?? "Analysis canceled." });
        return;
      }
      if (message.type === "analysis-result") {
        try {
          const matchingRequest: M1AnalyzeMidiRequest = {
            ...request,
            engineVersion: message.engineVersion,
          };
          const validated = validateM1AnalyzeMidiResultForRequest(matchingRequest, message);
          clearActiveTimeout();
          activeRequestRef.current = null;
          setIsBusy(false);
          setResult(validated);
          setEngineVersion(validated.engineVersion);
          window.__m1LastResult = validated;
          setStatus(validated.status === "invalid"
            ? { tone: "warning", message: `MIDI input rejected after real Python execution (${fileName}).` }
            : { tone: "success", message: `Python analysis finished for ${fileName}.` });
        } catch (error) {
          window.__m1LastError = errorMessage(error);
          finishWithError(worker, requestId, token, `Analysis result failed contract validation: ${errorMessage(error)}`);
        }
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      if (token !== activeTokenRef.current) return;
      worker.terminate();
      workerRef.current = null;
      finishWithError(null, requestId, token, `Worker crashed: ${event.message || "unknown worker error"}`);
    };

    try {
      postM1AnalyzeMidiRequest(worker, request);
      activeTimeoutRef.current = window.setTimeout(() => {
        if (token !== activeTokenRef.current || activeRequestRef.current?.requestId !== requestId) return;
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
        activeRequestRef.current = null;
        setIsBusy(false);
        setStatus({ tone: "error", message: "Analysis exceeded the 180-second resource limit. The Worker was terminated; retry to create a fresh runtime." });
      }, analysisTimeoutMs);
      setStatus({ tone: "working", stage: "load", message: `Sent ${fileName} to the local analysis Worker.` });
    } catch (error) {
      finishWithError(worker, requestId, token, `Could not start analysis: ${errorMessage(error)}`);
    }
  }

  function finishWithError(worker: Worker | null, requestId: string, token: number, message: string) {
    if (token !== activeTokenRef.current || activeRequestRef.current?.requestId !== requestId) return;
    clearActiveTimeout();
    activeRequestRef.current = null;
    if (worker && workerRef.current !== worker) worker.terminate();
    setIsBusy(false);
    window.__m1LastError = message;
    setStatus({ tone: "error", message });
  }

  function cancelActiveJob(message = "Analysis canceled. The Worker was terminated.", announce = true) {
    const hadWork = activeRequestRef.current !== null || sourceAbortRef.current !== null;
    if (!hadWork) return;
    activeTokenRef.current += 1;
    sourceAbortRef.current?.abort();
    sourceAbortRef.current = null;
    clearActiveTimeout();
    workerRef.current?.terminate();
    workerRef.current = null;
    activeRequestRef.current = null;
    setIsBusy(false);
    setRawMidiBytes(null);
    window.__m1LastResult = null;
    if (announce) setStatus({ tone: "neutral", message });
  }

  function clearActiveTimeout() {
    if (activeTimeoutRef.current !== null) window.clearTimeout(activeTimeoutRef.current);
    activeTimeoutRef.current = null;
  }

  function bumpRevision() {
    revisionRef.current += 1;
    setRevision(revisionRef.current);
  }

  const noteCount = result?.document?.notes.length ?? 0;
  const trackCount = result?.document?.tracks.length ?? 0;
  const fingerCount = result?.fingeringPlan?.assignments.length ?? 0;
  const performanceCount = result?.performancePlan?.events.length ?? 0;
  const poseCount = result?.motionPlan?.poses.length ?? 0;
  const sourceNoteCount = result?.rawBaseline.sourceNotes.length ?? 0;

  return (
    <main className="page-shell" onDragOver={handleDragOver} onDrop={handleDrop}>
      <header className="masthead">
        <div className="brand-mark" aria-hidden="true">P</div>
        <div>
          <p className="eyebrow">PianoMotion Studio · Browser workspace</p>
          <h1 id="page-title">MIDI analysis diagnostics</h1>
        </div>
        <span className="milestone-badge">v1.0 · Full Studio</span>
      </header>

      <section className="workspace-grid" aria-labelledby="page-title">
        <div className="control-card">
          <div className="card-heading">
            <div>
              <p className="section-kicker">Local Python engine</p>
              <h2>Run a diagnostic</h2>
            </div>
            <span className={`engine-indicator ${isBusy ? "is-busy" : engineVersion ? "is-ready" : ""}`}>
              <span aria-hidden="true" />
              {isBusy ? "Working" : engineVersion ? "Idle · lazy load" : "Preparing assets"}
            </span>
          </div>

          <p className="intro-copy">
            Analyze a tracked fixture or drop a MIDI file. Pyodide and the Python core load only after you start.
          </p>

          <div className="form-fields">
            <label className="field-label" htmlFor="fixture-select">MIDI source</label>
            <select
              id="fixture-select"
              value={selectedFixtureId}
              disabled={!fixtureManifest || isBusy}
              onChange={(event) => changeSource(event.currentTarget.value)}
            >
              {fixtureIds.map((fixtureId) => (
                <option key={fixtureId} value={fixtureId}>{fixtureId}</option>
              ))}
              <option value="custom-file">Local MIDI file…</option>
            </select>
            {currentFixture && !selectedFile && (
              <p className="field-hint">{currentFixture.scenarios?.join(" · ") || currentFixture.fixturePath}</p>
            )}

            <label className="field-label" htmlFor="midi-file">Or choose a local MIDI file</label>
            <input
              id="midi-file"
              ref={fileInputRef}
              type="file"
              accept=".mid,.midi,audio/midi,audio/x-midi"
              disabled={isBusy}
              onChange={onFileSelected}
            />
            <p className="field-hint">
              Up to 16 MiB. Drag and drop any .mid file anywhere on this page.
              {selectedFile ? ` Selected: ${selectedFile.name}` : ""}
            </p>

            <label className="field-label" htmlFor="key-style">Keyboard geometry</label>
            <select id="key-style" value={keyStyle} disabled={isBusy} onChange={(event) => changeKeyStyle(event.currentTarget.value as "realistic" | "equal")}>
              <option value="realistic">Realistic key widths</option>
              <option value="equal">Equal key widths</option>
            </select>
          </div>

          {manifestError && <p className="inline-error" role="alert">Asset preparation failed: {manifestError}</p>}

          <div className="actions">
            <button
              id="analyze-button"
              className="button-primary"
              type="button"
              onClick={() => void analyze()}
              disabled={!fixtureManifest || !engineVersion || isBusy || Boolean(manifestError)}
            >
              {isBusy ? "Analyzing…" : "Analyze MIDI"}
            </button>
            <button
              id="cancel-button"
              className="button-secondary"
              type="button"
              onClick={() => cancelActiveJob()}
              disabled={!isBusy}
            >
              Cancel
            </button>
          </div>
          <p className="privacy-note">Input bytes stay in this browser session. No upload or network service receives the MIDI.</p>
        </div>

        <div className="results-column">
          <section className={`status-card tone-${status.tone}`} role="status" aria-live="polite" aria-atomic="true">
            <div className="status-symbol" aria-hidden="true">{status.tone === "success" ? "✓" : status.tone === "error" ? "!" : status.tone === "working" ? "…" : "·"}</div>
            <div>
              <p className="section-kicker">{status.stage ? `${status.stage} stage` : "Engine status"}</p>
              <h2>{status.message}</h2>
              {result && <p className="result-state">Input status: <strong>{result.status}</strong></p>}
            </div>
          </section>

          <section className="result-card" aria-labelledby="result-title">
            <div className="card-heading">
              <div>
                <p className="section-kicker">Typed result</p>
                <h2 id="result-title">Analysis output</h2>
              </div>
              <span className="revision-tag">revision {revision}</span>
            </div>
            {result ? (
              <>
                <div className="metrics-grid">
                  <Metric label="Normalized notes" value={noteCount} />
                  <Metric label="Source notes" value={sourceNoteCount} />
                  <Metric label="Tracks" value={trackCount} />
                  <Metric label="Fingering assignments" value={fingerCount} />
                  <Metric label="Performance events" value={performanceCount} />
                  <Metric label="Sampled poses" value={poseCount} />
                </div>
                <div className="identity-strip">
                  <span>Profile <strong>{result.profile.profileId} · r{result.profile.revision}</strong></span>
                  <span>Engine <strong>{result.engineVersion.slice(0, 12)}…</strong></span>
                  <span>Source <strong>{formatBytes(result.resource.byteLength)}</strong></span>
                </div>
                <DiagnosticList diagnostics={result.diagnostics} />
              </>
            ) : (
              <div className="empty-result">
                <span className="empty-icon" aria-hidden="true">⌁</span>
                <p>Results, note counts, and Python diagnostics will appear here after analysis.</p>
              </div>
            )}
          </section>

          <aside className="milestone-note">
            <span className="note-mark" aria-hidden="true">v1.0</span>
            <p><strong>PianoMotion Studio v1.0.</strong> Complete studio release (M1–M8): procedural 3D/2D hand kinematics with dense strike sampling, 4 procedural hand skins (Cartoon, Gloves, Robot, Skeleton) with drop shadows, interactive piano roll fingering editor, custom pianist profiles, audio recording sync, SoundFont synthesizer, WebM/MP4 video export, and offline PWA.</p>
          </aside>
        </div>
      </section>

      {persistenceNotice && <p className="save-status-msg" data-testid="session-restore-notice">{persistenceNotice}</p>}
      {/* A new source session owns its editor history, calculations and transport. */}
      {result && result.document && result.performancePlan && (
        <PianoPlayer
          key={result.requestId}
          result={result}
          projectName={restoredSession ? result.document.title : selectedFile?.name ?? selectedFixtureId}
          rawMidiBytes={rawMidiBytes}
          engineVersion={engineVersion}
          initialSession={restoredSession}
          analysisWorker={workerRef.current}
        />
      )}

      <footer className="page-footer">
        <span>Self-hosted Pyodide 314.0.7</span>
        <span>Engine {engineVersion ? engineVersion.slice(0, 12) : "loading manifest"}</span>
      </footer>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="metric"><strong>{value.toLocaleString()}</strong><span>{label}</span></div>;
}

function DiagnosticList({ diagnostics }: { diagnostics: M1AnalyzeMidiResult["diagnostics"] }) {
  return (
    <div className="diagnostic-list">
      <h3>Diagnostics <span>{diagnostics.length}</span></h3>
      {diagnostics.length === 0 ? (
        <p className="no-diagnostics">No input or planning diagnostics.</p>
      ) : (
        <ul>
          {diagnostics.map((diagnostic, index) => (
            <li className={`diagnostic-${diagnostic.severity}`} key={`${diagnostic.code}-${index}`}>
              <span className="diagnostic-severity">{diagnostic.severity}</span>
              <div><strong>{diagnostic.code}</strong><p>{diagnostic.message}</p></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function stageLabel(stage: M1EngineStage): string {
  if (stage === "load") return "Loading the pinned local runtime.";
  if (stage === "init") return "Initializing Python packages and core.";
  return "Running synchronous Python analysis.";
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.pathname}`);
  return response.json() as Promise<unknown>;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
