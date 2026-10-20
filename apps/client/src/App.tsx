import { inferProjectFixtureId, type M1AnalyzeMidiResult, type M1KeyStyle, type ProjectSourceContext, type PianistProfile } from "@handthesia/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { PianoPlayer } from "./player";
import { analyzeSavedProjectCandidate, prepareSourceCandidate } from "./player/controller";
import { StudioShell, StudioReleaseDetails } from "./studio/StudioShell";
import { StudioDialog } from "./studio/StudioDialog";
import { ProjectsPanel } from "./studio/ProjectsPanel";
import { BuiltinMelodiesDialog } from "./melodies/BuiltinMelodiesDialog";
import { loadBuiltinMelodies, loadBuiltinMelodyBytes, lookupBuiltinMelody, type BuiltinMelodyEntry } from "./melodies/catalog";
import { normalizeStudioView, type StudioStatus, type StudioView } from "./studio/types";
import { ProfileModal } from "./profiles";
import { SettingsModal } from "./settings";
import {
  assessSessionSnapshot,
  addRecentProjectId,
  createAutosaveService,
  getProject,
  inspectLegacyProjectPackageFile,
  importProjectPackageFile,
  initializeAppPersistence,
  loadSessionSnapshot,
  projectPackageToSavedProject,
  validateMidiFile,
  type SavedProject,
  type SessionSnapshot,
} from "./storage";
import { getSettings } from "./settings";
import { skipWaiting, releaseAssetUrl, getCurrentServiceWorkerRegistration } from "./pwa";
import type { SaveSession } from "./player/saveResult";
import { isCommittedSaveCurrent } from "./player/saveResult";
import { applyGuardedStudioUpdate } from "./studio/updateGuard";
import { recordDiagnostic } from "./diagnostics/eventLog";
import { DiagnosticLogControls } from "./diagnostics/DiagnosticLogControls";
import { useI18n } from "./i18n";
import { SessionOperationLifecycle, type SessionOperation } from "./sessionOperation";
import { MusicalLoading } from "./studio/MusicalLoading";
import { phaseFromWorkerProgress, measuredProgress, type LoadingExperienceState, type LoadingPhase } from "./studio/loadingExperience";
import type { PlaybackBlocker } from "./player/playbackReadiness";

type FixtureEntry = { fixturePath: string; fixtureSha256: string; scenarios?: string[] };
type FixtureManifest = { fixtureSources: Record<string, FixtureEntry> };
type StartupRuntime = { fixtureManifest: FixtureManifest; engineVersion: string; melodies: BuiltinMelodyEntry[] };
type ActiveSession = {
  result: M1AnalyzeMidiResult;
  rawMidiBytes: ArrayBuffer;
  sourceContext: ProjectSourceContext;
  session: SessionSnapshot | null;
  projectName: string;
  savedProject?: SavedProject;
  unsaved: boolean;
  analysisWorker: Worker;
};
type SaveHandler = SaveSession;

class InvalidFixtureCandidateError extends Error {
  constructor(readonly result: M1AnalyzeMidiResult) {
    super("This fixture produced an invalid MIDI analysis result.");
  }
}

const DEMO_FIXTURE_ID = "tracked-demo-song";
export const DEFAULT_BUILTIN_MELODY_TITLE = "Гімн України";

declare global {
  interface Window {
    __m1LastResult?: M1AnalyzeMidiResult | null;
    __m1LastError?: string | null;
  }
}

export default function App() {
  const { dict, t, language } = useI18n();
  const [fixtureManifest, setFixtureManifest] = useState<FixtureManifest | null>(null);
  const [engineVersion, setEngineVersion] = useState("");
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [sessionProfile, setSessionProfile] = useState<PianistProfile | null>(null);
  const [status, setStatus] = useState<StudioStatus>({ kind: "loading", message: "Preparing the local studio…" });
  const [busy, setBusy] = useState(false);
  const [loadingExperience, setLoadingExperience] = useState<LoadingExperienceState | null>({
    generation: 0, phase: "startup", detail: "Preparing the local studio…",
  });
  // Keep the full-screen score visible until the first actual playable session.
  const [hasPlayedReadySession, setHasPlayedReadySession] = useState(false);
  const [playbackReadiness, setPlaybackReadiness] = useState<{
    requestId: string;
    blocker: PlaybackBlocker | null;
  } | null>(null);
  const handlePlaybackReadinessChange = useCallback((requestId: string, blocker: PlaybackBlocker | null) => {
    setPlaybackReadiness(previous => previous?.requestId === requestId && previous.blocker === blocker
      ? previous : { requestId, blocker });
    if (blocker === null) setHasPlayedReadySession(true);
  }, []);
  const [builtinMelodiesOpen, setBuiltinMelodiesOpen] = useState(false);
  const openBuiltinMelodies = useCallback(() => setBuiltinMelodiesOpen(true), []);
  const [dirty, setDirty] = useState(false);
  const [pendingCandidate, setPendingCandidate] = useState<ActiveSession | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [legacyResolution, setLegacyResolution] = useState<
    | { kind: "package"; file: File; fixtureId: string }
    | { kind: "saved"; project: SavedProject; fixtureId: string }
    | null
  >(null);
  const [legacyKeyStyle, setLegacyKeyStyle] = useState<M1KeyStyle | null>(null);
  const [developerFixtureId, setDeveloperFixtureId] = useState(DEMO_FIXTURE_ID);
  const [viewMode, setViewMode] = useState<StudioView>("performance");
  const [manifestError, setManifestError] = useState("");
  const [fullScreenDialog, setFullScreenDialog] = useState<"preferences" | "pianist" | null>(null);
  const midiInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const saveHandlerRef = useRef<SaveHandler | null>(null);
  const updateApplyingRef = useRef(false);
  const dirtyRef = useRef(false);
  const activeRef = useRef<ActiveSession | null>(null);
  const preparedRef = useRef<ActiveSession | null>(null);
  const preparedGenerationRef = useRef<number | null>(null);
  const operationLifecycleRef = useRef(new SessionOperationLifecycle());
  const startupRuntimePromiseRef = useRef<Promise<StartupRuntime> | null>(null);
  /** Ignore late Worker progress from canceled/superseded operations. */
  const reportLoading = useCallback((generation: number, detail: string, phase?: LoadingPhase, progress?: number) => {
    setLoadingExperience(previous => previous?.generation === generation
      ? { ...previous, phase: phase ?? phaseFromWorkerProgress(detail, previous.phase), detail, progress: measuredProgress(progress) }
      : previous);
  }, []);
  const autosaveService = useMemo(() => createAutosaveService({
    delayMs: 400,
    onError: (error) => setStatus({ kind: "error", message: `Session recovery could not be saved: ${error.message}` }),
  }), []);

  const [swUpdateRegistration, setSwUpdateRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    recordDiagnostic("studio.status", { kind: status.kind, message: status.message, details: status.details,
      projectId: active?.result.projectId, openedRevision: active?.result.revision }, status.kind === "error" ? "error" : "info");
  }, [status, active?.result.projectId, active?.result.revision]);

  useEffect(() => {
    const onUpdateAvailable = (e: Event) => {
      const reg = (e as CustomEvent<{ registration: ServiceWorkerRegistration }>).detail?.registration;
      if (reg) {
        setSwUpdateRegistration(reg);
      }
    };
    window.addEventListener("sw-update-available", onUpdateAvailable);
    const registration = getCurrentServiceWorkerRegistration();
    let active = true;
    queueMicrotask(() => {
      if (active && registration?.waiting) setSwUpdateRegistration(registration);
    });
    return () => {
      active = false;
      window.removeEventListener("sw-update-available", onUpdateAvailable);
    };
  }, []);

  const handleApplyUpdate = useCallback(async () => {
    if (!swUpdateRegistration?.waiting || updateApplyingRef.current) return;
    updateApplyingRef.current = true;
    try {
      if (operationLifecycleRef.current.isPending() || preparedRef.current) throw new Error("Finish opening the project before applying the update.");
      setStatus({ kind: "saving", message: "Saving project before applying studio update…" });
      await applyGuardedStudioUpdate({
        getSession: () => saveHandlerRef.current,
        hasProject: () => activeRef.current !== null,
        flushRecovery: () => autosaveService.flush({ throwOnError: true }),
        activate: () => {
          if (operationLifecycleRef.current.isPending() || preparedRef.current) throw new Error("A project is being opened. Finish or cancel it before updating.");
          if (!swUpdateRegistration.waiting) throw new Error("The prepared update is no longer available.");
          const savedSession = saveHandlerRef.current;
          const savedIdentity = savedSession?.getState();
          const projectGeneration = operationLifecycleRef.current.getGeneration();
          setStatus({ kind: "loading", message: "Activating updated studio…" });
          navigator.serviceWorker.addEventListener("controllerchange", () => {
            void (async () => {
              try {
                await autosaveService.flush({ throwOnError: true });
                if (operationLifecycleRef.current.getGeneration() !== projectGeneration || operationLifecycleRef.current.isPending() || preparedRef.current ||
                    saveHandlerRef.current !== savedSession ||
                    (savedSession && savedIdentity && !isCommittedSaveCurrent(savedSession, { status: "committed", identity: savedIdentity }))) {
                  throw new Error("The project changed during update activation. The studio was kept open; save the latest changes before reloading.");
                }
                window.location.reload();
              } catch (error) {
                setSwUpdateRegistration(null);
                setStatus({ kind: "error", message: `Update activated without reloading: ${errorMessage(error)}` });
              }
            })();
          }, { once: true });
          skipWaiting(swUpdateRegistration);
        },
      });
    } catch (error) {
      setStatus({ kind: "error", message: `Update could not be applied: ${errorMessage(error)}` });
    } finally {
      updateApplyingRef.current = false;
    }
  }, [swUpdateRegistration, autosaveService]);

  useEffect(() => { document.title = "PianoMotion Studio"; }, []);

  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  useEffect(() => {
    const lifecycle = operationLifecycleRef.current;
    const operation = lifecycle.begin("bootstrap");
    const isCurrent = () => lifecycle.isCurrent(operation);
    queueMicrotask(() => { if (isCurrent()) setLoadingExperience({
      generation: operation.generation, phase: "startup", detail: "Loading local studio manifests…",
    }); });
    let disposed = false;
    const cacheBust = import.meta.env.DEV ? `?t=${Date.now()}` : "";
    const runtimePromise = Promise.all([
      fetchJson(releaseAssetUrl(`m1-fixtures/manifest.json${cacheBust}`)),
      fetchJson(releaseAssetUrl(`python-core/source_manifest.json${cacheBust}`)),
      loadBuiltinMelodies().catch(() => [] as BuiltinMelodyEntry[]),
    ]).then(async ([fixturesUnknown, coreUnknown, melodiesUnknown]) => {
      const fixtures = fixturesUnknown as FixtureManifest;
      const core = coreUnknown as { engineVersion?: unknown };
      if (!fixtures.fixtureSources || typeof core.engineVersion !== "string" || !/^[a-f0-9]{64}$/.test(core.engineVersion)) {
        throw new Error("The packaged fixture or Python core manifest is invalid.");
      }
      await initializeAppPersistence();
      const runtime = {
        fixtureManifest: fixtures,
        engineVersion: core.engineVersion,
        melodies: Array.isArray(melodiesUnknown) ? melodiesUnknown as BuiltinMelodyEntry[] : [],
      };
      if (!disposed) {
        setFixtureManifest(runtime.fixtureManifest);
        setEngineVersion(runtime.engineVersion);
      }
      return runtime;
    });
    startupRuntimePromiseRef.current = runtimePromise;
    const bootstrap = async () => {
      try {
        const { engineVersion: coreEngineVersion, melodies } = await runtimePromise;
        if (!isCurrent()) return;

        const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
        const forceEmpty = urlParams?.has("empty");

        reportLoading(operation.generation, "Checking the saved session…", "restoring");
        const snapshot = await loadSessionSnapshot();
        if (!isCurrent()) return;
        if (!snapshot) {
          if (!forceEmpty) {
            const defaultEntry = melodies.find(
              (m) => m.title === DEFAULT_BUILTIN_MELODY_TITLE ||
                     m.title.toLowerCase().includes("гімн україни") ||
                     m.fileName.toLowerCase().includes("гімн україни")
            );
            if (defaultEntry) {
              setStatus({ kind: "loading", message: `Loading ${defaultEntry.title}…` });
              reportLoading(operation.generation, `Reading ${defaultEntry.title}…`, "reading");
              const midiBytes = await loadBuiltinMelodyBytes(defaultEntry, operation.signal);
              if (!isCurrent()) return;
              const sourceContext: ProjectSourceContext = {
                fixtureId: `builtin-${defaultEntry.id}`,
                keyStyle: getSettings().keyStyle,
              };
              const { result, analysisWorker } = await prepareSourceCandidate({
                midiBytes,
                projectId: crypto.randomUUID(),
                revision: 0,
                engineVersion: coreEngineVersion,
                sourceContext,
                signal: operation.signal,
                onProgress: (msg, progress) => { if (isCurrent()) { setStatus({ kind: "calculating", message: msg, progress: measuredProgress(progress) }); reportLoading(operation.generation, msg, undefined, progress); } },
              });
              if (!isCurrent()) {
                analysisWorker.terminate();
                return;
              }
              const initialSession: ActiveSession = {
                result,
                rawMidiBytes: midiBytes,
                sourceContext,
                session: null,
                projectName: defaultEntry.title,
                unsaved: false,
                analysisWorker,
              };
              activeRef.current = initialSession;
              setActive(initialSession);
              setSessionProfile(result.profile);
              setViewMode("performance");
              dirtyRef.current = false;
              setDirty(false);
              window.__m1LastResult = result;
              window.__m1LastError = null;
              setStatus({ kind: "saved", message: `Loaded ${defaultEntry.title}.` });
              return;
            }
          }
          if (isCurrent()) setStatus({ kind: "idle", message: "Open a MIDI file, a saved project, or the demo song to begin." });
          return;
        }
        reportLoading(operation.generation, "Verifying saved project identity…", "restoring");
        const assessed = await assessSessionSnapshot(snapshot, coreEngineVersion);
        if (!isCurrent()) return;
        if (!snapshot.result || !snapshot.rawMidiBytes || (assessed.status !== "compatible" && assessed.status !== "recompute-required")) {
          setStatus({ kind: "error", message: `Saved session could not be restored: ${assessed.reasons.join("; ") || assessed.status}. The saved data was retained.` });
          return;
        }
        const snapshotDocument = snapshot.document ?? snapshot.result.document!;
        const restoredSourceContext = snapshot.sourceContext ?? (
          snapshot.keyStyle && inferProjectFixtureId(snapshotDocument)
            ? { fixtureId: inferProjectFixtureId(snapshotDocument)!, keyStyle: snapshot.keyStyle }
            : null
        );
        if (!restoredSourceContext) {
          setStatus({ kind: "error", message: "The saved session has no verified source namespace and keyboard geometry. It was retained; open the source again or choose geometry in the Projects panel." });
          return;
        }
        const savedProject = snapshotToSavedProject(snapshot, restoredSourceContext);
        const rebuilt = await analyzeSavedProjectCandidate(savedProject, coreEngineVersion, operation.signal,
          (msg, progress) => { if (isCurrent()) { setStatus({ kind: "calculating", message: msg, progress: measuredProgress(progress) }); reportLoading(operation.generation, msg, undefined, progress); } },
          restoredSourceContext);
        if (!isCurrent()) { rebuilt.analysisWorker.terminate(); return; }
        const restored: ActiveSession = {
          result: rebuilt.result,
          rawMidiBytes: rebuilt.session.rawMidiBytes!,
          sourceContext: rebuilt.sourceContext,
          session: { ...rebuilt.session, viewMode: normalizeStudioView(snapshot.viewMode), sceneView: snapshot.sceneView },
          projectName: savedProject.name,
          savedProject: rebuilt.project,
          unsaved: false,
          analysisWorker: rebuilt.analysisWorker,
        };
        activeRef.current = restored;
        setActive(restored);
        setViewMode(normalizeStudioView(snapshot.viewMode));
        setSessionProfile(rebuilt.result.profile);
        dirtyRef.current = false;
        setDirty(false);
        window.__m1LastResult = rebuilt.result;
        window.__m1LastError = null;
        setStatus({ kind: "saved", message: assessed.status === "compatible" ? "Previous project restored and checked against its original MIDI." : "Previous edits restored; rebuilding plans with the current engine." });
      } catch (error) {
        if (isCurrent()) {
          const message = errorMessage(error);
          setManifestError(message);
          setStatus({ kind: "error", message: `Studio startup failed: ${message}` });
        }
      } finally {
        if (isCurrent()) setLoadingExperience(null);
        lifecycle.finish(operation);
      }
    };
    void bootstrap();
    return () => {
      disposed = true;
      lifecycle.cancel();
      preparedRef.current?.analysisWorker.terminate();
      preparedRef.current = null;
      preparedGenerationRef.current = null;
    };
  }, [reportLoading]);

  const fixtureIds = useMemo(() => Object.keys(fixtureManifest?.fixtureSources ?? {}).sort(), [fixtureManifest]);

  const markDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);

  const registerSaveHandler = useCallback((handler: SaveHandler | null) => {
    saveHandlerRef.current = handler;
  }, []);

  const commitCandidate = useCallback((candidate: ActiveSession) => {
    preparedRef.current = null;
    preparedGenerationRef.current = null;
    activeRef.current = candidate;
    setActive(candidate);
    setSessionProfile(candidate.result.profile);
    setFullScreenDialog(null);
    setViewMode(candidate.session ? normalizeStudioView(candidate.session.viewMode) : "performance");
    markDirty(candidate.unsaved);
    setPendingCandidate(null);
    setConfirmReplace(false);
    setStatus({ kind: candidate.unsaved ? "modified" : "saved", message: candidate.unsaved ? "Project opened. Save it to keep this version in your project list." : `Opened ${candidate.projectName}.` });
    if (!candidate.unsaved && candidate.savedProject) {
      addRecentProjectId(candidate.savedProject.projectId);
      window.dispatchEvent(new Event("studio-projects-changed"));
    }
    window.__m1LastResult = candidate.result;
    window.__m1LastError = null;
  }, [markDirty]);

  const runCandidate = useCallback(async (
    description: string,
    prepare: (signal: AbortSignal, progress: (message: string, progress?: number) => void, engineVersion: string) => Promise<ActiveSession>,
    operation: SessionOperation = operationLifecycleRef.current.begin("open"),
  ) => {
    const lifecycle = operationLifecycleRef.current;
    if (!lifecycle.isCurrent(operation)) return;
    preparedRef.current?.analysisWorker.terminate();
    preparedRef.current = null;
    preparedGenerationRef.current = null;
    const { signal } = operation;
    setBusy(true);
    setLoadingExperience({ generation: operation.generation,
      phase: description === "saved project" ? "restoring" : "reading",
      detail: `Opening ${description}…` });
    setPendingCandidate(null);
    setConfirmReplace(false);
    setStatus({ kind: "calculating", message: `Validating ${description}…` });
    window.__m1LastError = null;
    try {
      const runtimePromise = startupRuntimePromiseRef.current;
      if (!runtimePromise) throw new Error("The studio startup manifest is not ready.");
      const runtime = await runtimePromise;
      if (!lifecycle.isCurrent(operation)) return;
      const candidate = await prepare(signal, (message, progress) => {
        if (lifecycle.isCurrent(operation)) {
          setStatus({ kind: "calculating", message, progress: measuredProgress(progress) });
          reportLoading(operation.generation, message, undefined, progress);
        }
      }, runtime.engineVersion);
      if (!lifecycle.isCurrent(operation)) {candidate.analysisWorker.terminate(); return;}
      if (dirtyRef.current && activeRef.current) {
        preparedRef.current = candidate;
        preparedGenerationRef.current = operation.generation;
        setPendingCandidate(candidate);
        setConfirmReplace(true);
        setStatus({ kind: "modified", message: "The new project is ready. Save or discard your unsaved changes before switching." });
      } else commitCandidate(candidate);
    } catch (error) {
      if (!lifecycle.isCurrent(operation)) return;
      if (error instanceof InvalidFixtureCandidateError) {
        window.__m1LastResult = error.result;
        window.__m1LastError = null;
        setPendingCandidate(null);
        setConfirmReplace(false);
        setStatus({ kind: "error", message: "Fixture analysis returned an invalid MIDI result. The open project was left unchanged." });
        return;
      }
      const message = errorMessage(error);
      window.__m1LastError = message;
      setPendingCandidate(null);
      setConfirmReplace(false);
      setStatus({ kind: "error", message: `${description} was not opened: ${message}` });
    } finally {
      if (lifecycle.isCurrent(operation)) {
        setLoadingExperience(null);
        lifecycle.finish(operation);
        setBusy(false);
      }
    }
  }, [commitCandidate, reportLoading]);

  const openMidiFile = useCallback(async (file: File) => {
    await runCandidate(file.name, async (signal, progress, runtimeEngineVersion) => {
      const validated = validateMidiFile(file);
      if (!validated.valid) throw new Error(validated.error);
      progress(`Reading ${file.name}…`);
      const midiBytes = await file.arrayBuffer();
      if (signal.aborted) throw new DOMException("Open canceled", "AbortError");
      const sourceContext: ProjectSourceContext = { fixtureId: "imported-midi", keyStyle: getSettings().keyStyle };
      const {result, analysisWorker} = await prepareSourceCandidate({
        midiBytes,
        projectId: crypto.randomUUID(),
        revision: 0,
        engineVersion: runtimeEngineVersion,
        sourceContext,
        signal,
        onProgress: progress,
      });
      return {
        result,
        rawMidiBytes: midiBytes,
        sourceContext,
        session: null,
        projectName: file.name,
        unsaved: true,
        analysisWorker,
      };
    });
  }, [runCandidate]);

  const openBuiltinMelody = useCallback(async (entry: BuiltinMelodyEntry) => {
    setBuiltinMelodiesOpen(false);
    await runCandidate(entry.title, async (signal, progress, runtimeEngineVersion) => {
      progress(`Loading ${entry.title}…`);
      const midiBytes = await loadBuiltinMelodyBytes(entry, signal);
      const sourceContext: ProjectSourceContext = {
        fixtureId: `builtin-${entry.id}`, keyStyle: getSettings().keyStyle,
      };
      const { result, analysisWorker } = await prepareSourceCandidate({
        midiBytes, projectId: crypto.randomUUID(), revision: 0, engineVersion: runtimeEngineVersion,
        sourceContext, signal, onProgress: progress,
      });
      return { result, rawMidiBytes: midiBytes, sourceContext, session: null,
        projectName: entry.title, unsaved: true, analysisWorker };
    });
  }, [runCandidate]);

  const openFixture = useCallback(async (fixtureId: string) => {
    const operation = operationLifecycleRef.current.begin("open");
    const fixture = fixtureManifest?.fixtureSources[fixtureId];
    if (!fixture || !engineVersion) {
      setStatus({ kind: "error", message: "The selected demo fixture is not available." });
      operationLifecycleRef.current.finish(operation);
      return;
    }
    await runCandidate(fixtureId, async (signal, progress, runtimeEngineVersion) => {
      progress(`Loading ${fixtureId}…`);
      const response = await fetch(releaseAssetUrl(`m1-fixtures/${fixture.fixturePath}`), { signal });
      if (!response.ok) throw new Error(`Could not load demo MIDI (HTTP ${response.status}).`);
      const midiBytes = await response.arrayBuffer();
      if (await sha256(midiBytes) !== fixture.fixtureSha256) throw new Error("Demo MIDI checksum verification failed.");
      const sourceContext: ProjectSourceContext = { fixtureId, keyStyle: getSettings().keyStyle };
      const {result, analysisWorker} = await prepareSourceCandidate({
        midiBytes,
        projectId: crypto.randomUUID(),
        revision: 0,
        engineVersion: runtimeEngineVersion,
        sourceContext,
        signal,
        onProgress: progress,
        allowInvalidResult: true,
      });
      if (result.status === "invalid") {analysisWorker.terminate(); throw new InvalidFixtureCandidateError(result);}
      return { result, rawMidiBytes: midiBytes, sourceContext, session: null, projectName: fixtureId, unsaved: true, analysisWorker };
    }, operation);
  }, [engineVersion, fixtureManifest, runCandidate]);

  const cancelCandidate = useCallback(() => {
    operationLifecycleRef.current.cancel();
    preparedRef.current?.analysisWorker.terminate();
    preparedRef.current = null;
    preparedGenerationRef.current = null;
    setBusy(false);
    setLoadingExperience(null);
    setPendingCandidate(null);
    setConfirmReplace(false);
    window.__m1LastError = null;
    setStatus({ kind: dirtyRef.current ? "modified" : activeRef.current ? "saved" : "idle", message: activeRef.current ? "Open operation canceled. The current project remains available." : "Open operation canceled." });
  }, []);

  const runSavedProject = useCallback(async (
    project: SavedProject,
    sourceContextOverride?: ProjectSourceContext,
    operation?: SessionOperation,
  ) => {
    await runCandidate("saved project", async (signal, progress, runtimeEngineVersion) => {
      progress("Loading saved project…");
      const rebuilt = await analyzeSavedProjectCandidate(project, runtimeEngineVersion, signal, progress, sourceContextOverride);
      return {
        result: rebuilt.result,
        rawMidiBytes: rebuilt.session.rawMidiBytes!,
        sourceContext: rebuilt.sourceContext,
        session: rebuilt.session,
        savedProject: rebuilt.project,
        projectName: rebuilt.project.name,
        unsaved: false,
        analysisWorker: rebuilt.analysisWorker,
      };
    }, operation);
  }, [runCandidate]);

  const openSavedProject = useCallback(async (projectId: string) => {
    const operation = operationLifecycleRef.current.begin("open");
    try {
      const project = await getProject(projectId);
      if (!operationLifecycleRef.current.isCurrent(operation)) return;
      if (!project) throw new Error("That saved project no longer exists in this browser.");
      if (!project.sourceContext) {
        const fixtureId = inferProjectFixtureId(project.document);
        if (!fixtureId) throw new Error("Saved project source IDs are ambiguous; the original MIDI cannot be matched safely.");
        setLegacyResolution({ kind: "saved", project, fixtureId });
        setLegacyKeyStyle(null);
        setStatus({ kind: "modified", message: "This older project does not record keyboard geometry. Choose its original geometry to continue." });
        operationLifecycleRef.current.finish(operation);
        return;
      }
      await runSavedProject(project, undefined, operation);
    } catch (error) {
      if (operationLifecycleRef.current.isCurrent(operation)) {
        setStatus({ kind: "error", message: "Saved project was not opened: " + errorMessage(error) });
        operationLifecycleRef.current.finish(operation);
      }
    }
  }, [runSavedProject]);

  const runOpenPackageFile = useCallback(async (
    file: File,
    legacySourceContext?: ProjectSourceContext,
    operation?: SessionOperation,
  ) => {
    await runCandidate(file.name, async (signal, progress, runtimeEngineVersion) => {
      progress(`Validating project package ${file.name}…`);
      const pkg = await importProjectPackageFile(file, legacySourceContext);
      if (signal.aborted) throw new DOMException("Project open canceled", "AbortError");
      const project = projectPackageToSavedProject(pkg);
      const existing = await getProject(project.projectId);
      if (existing) {
        const newProjectId = crypto.randomUUID();
        const document = { ...project.document, projectId: newProjectId };
        const fingeringPlan = project.fingeringPlan ? { ...project.fingeringPlan, projectId: newProjectId } : project.fingeringPlan;
        project.projectId = newProjectId;
        project.document = document;
        project.fingeringPlan = fingeringPlan;
        project.performancePlan = project.performancePlan ? { ...project.performancePlan, projectId: newProjectId } : project.performancePlan;
        project.motionPlan = project.motionPlan ? { ...project.motionPlan, projectId: newProjectId } : project.motionPlan;
      }
      const rebuilt = await analyzeSavedProjectCandidate(project, runtimeEngineVersion, signal, progress, legacySourceContext);
      return {
        result: rebuilt.result,
        rawMidiBytes: rebuilt.session.rawMidiBytes!,
        sourceContext: rebuilt.sourceContext,
        session: rebuilt.session,
        savedProject: rebuilt.project,
        projectName: rebuilt.project.name,
        unsaved: true,
        analysisWorker: rebuilt.analysisWorker,
      };
    }, operation);
  }, [runCandidate]);

  const openPackageFile = useCallback(async (file: File) => {
    const operation = operationLifecycleRef.current.begin("open");
    try {
      const fixtureId = await inspectLegacyProjectPackageFile(file);
      if (!operationLifecycleRef.current.isCurrent(operation)) return;
      if (fixtureId !== undefined) {
        if (!fixtureId) throw new Error("Legacy project source IDs are ambiguous; source context cannot be recovered safely.");
        setLegacyResolution({ kind: "package", file, fixtureId });
        setLegacyKeyStyle(null);
        setStatus({ kind: "modified", message: "This older package does not record keyboard geometry. Choose its original geometry before opening it." });
        operationLifecycleRef.current.finish(operation);
        return;
      }
      await runOpenPackageFile(file, undefined, operation);
    } catch (error) {
      if (operationLifecycleRef.current.isCurrent(operation)) {
        setStatus({ kind: "error", message: "Project package was not opened: " + errorMessage(error) });
        operationLifecycleRef.current.finish(operation);
      }
    }
  }, [runOpenPackageFile]);

  const continueLegacyOpen = useCallback(() => {
    const legacy = legacyResolution;
    if (!legacy || !legacyKeyStyle) return;
    const sourceContext: ProjectSourceContext = { fixtureId: legacy.fixtureId, keyStyle: legacyKeyStyle };
    setLegacyResolution(null);
    setLegacyKeyStyle(null);
    if (legacy.kind === "package") void runOpenPackageFile(legacy.file, sourceContext);
    else void runSavedProject(legacy.project, sourceContext);
  }, [legacyKeyStyle, legacyResolution, runOpenPackageFile, runSavedProject]);

  const chooseReplace = useCallback(async (choice: "save" | "discard" | "cancel") => {
    const candidate = pendingCandidate;
    const candidateGeneration = preparedGenerationRef.current;
    const lifecycle = operationLifecycleRef.current;
    if (!candidate || candidateGeneration === null || candidateGeneration !== lifecycle.getGeneration() || preparedRef.current !== candidate) return;
    if (choice === "cancel") {
      candidate.analysisWorker.terminate();
      preparedRef.current = null;
      preparedGenerationRef.current = null;
      setPendingCandidate(null);
      setConfirmReplace(false);
      setStatus({ kind: "modified", message: "The current project remains open with its unsaved changes." });
      return;
    }
    if (choice === "save") {
      const save = saveHandlerRef.current;
      if (!save) {
        setStatus({ kind: "error", message: "The current project could not be saved; it remains open." });
        return;
      }
      setStatus({ kind: "saving", message: "Saving the current project before switching…" });
      try {
        const saved = await save.save();
        if (candidateGeneration !== lifecycle.getGeneration() || preparedRef.current !== candidate) return;
        if (saveHandlerRef.current !== save || !isCommittedSaveCurrent(save, saved)) {
          setStatus({ kind: "error", message: saved.status === "committed"
            ? "New changes were made while saving. The current project remains open."
            : saved.reason });
          return;
        }
      } catch (error) {
        if (candidateGeneration !== lifecycle.getGeneration() || preparedRef.current !== candidate) return;
        setStatus({ kind: "error", message: `Save failed: ${errorMessage(error)}` });
        return;
      }
      markDirty(false);
    }
    commitCandidate(candidate);
  }, [commitCandidate, markDirty, pendingCandidate]);

  const onMidiInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (file) void openMidiFile(file);
  }, [openMidiFile]);
  const onPackageInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (file) void openPackageFile(file);
  }, [openPackageFile]);

  const developerTools = (
    <div className="studio-developer-tools">
      {manifestError && <p role="alert">{manifestError}</p>}
      <label htmlFor="fixture-select">Tracked MIDI fixture</label>
      <select id="fixture-select" value={developerFixtureId} disabled={!fixtureManifest || busy} onChange={(event) => setDeveloperFixtureId(event.currentTarget.value)}>
        {fixtureIds.map((fixtureId) => <option key={fixtureId} value={fixtureId}>{fixtureId}</option>)}
      </select>
      <button id="analyze-button" type="button" disabled={!engineVersion || busy} onClick={() => void openFixture(developerFixtureId)}>
        {busy ? "Analyzing…" : "Analyze fixture"}
      </button>
      <button id="cancel-button" type="button" disabled={!busy} onClick={cancelCandidate}>Cancel</button>
      <p>Engine hash: {engineVersion || "loading"}</p>
    </div>
  );

  const inspector = (tab: "scene" | "pianist" | "audio" | "diagnostics") => {
    if (tab === "diagnostics") return <section aria-label="Diagnostics"><h2>Diagnostics</h2><p>{status.message}</p><DiagnosticLogControls /><details><summary>Developer tools</summary>{developerTools}</details></section>;
    return <section aria-label={tab}><h2>{tab === "scene" ? "Scene" : tab === "pianist" ? "Pianist" : "Audio"}</h2><p>Open a MIDI project to edit its studio settings.</p></section>;
  };

  const dialogs = <>
    <BuiltinMelodiesDialog open={builtinMelodiesOpen} onClose={() => setBuiltinMelodiesOpen(false)}
      onChoose={entry => { void openBuiltinMelody(entry); }} busy={busy || !engineVersion} />
    {confirmReplace && pendingCandidate && <StudioDialog
      title={dict.dialogs.unsavedTitle} titleId="replace-project-title"
      description={t("dialogs.unsavedDescription", { name: pendingCandidate.projectName })}
      onClose={() => {void chooseReplace("cancel");}}
    >
        <div className="studio-confirm-actions">
          <button type="button" onClick={() => void chooseReplace("save")}>{dict.dialogs.saveAndOpen}</button>
          <button type="button" onClick={() => void chooseReplace("discard")}>{dict.dialogs.discardAndOpen}</button>
          <button type="button" onClick={() => void chooseReplace("cancel")}>{dict.common.cancel}</button>
        </div>
    </StudioDialog>}
    {legacyResolution && <StudioDialog
      title={dict.dialogs.legacyTitle} titleId="legacy-geometry-title"
      description={dict.dialogs.legacyDescription}
      onClose={() => {setLegacyResolution(null); setLegacyKeyStyle(null);}}
    >
        <fieldset>
          <legend>{dict.settings.keyStyle}</legend>
          <label><input type="radio" name="legacy-key-style" value="realistic" checked={legacyKeyStyle === "realistic"} onChange={() => setLegacyKeyStyle("realistic")} /> {dict.settings.realisticKeys}</label>
          <label><input type="radio" name="legacy-key-style" value="equal" checked={legacyKeyStyle === "equal"} onChange={() => setLegacyKeyStyle("equal")} /> {dict.settings.equalKeys}</label>
        </fieldset>
        <div className="studio-confirm-actions">
          <button type="button" disabled={!legacyKeyStyle} onClick={continueLegacyOpen}>{dict.dialogs.verifyAndOpen}</button>
          <button type="button" onClick={() => { setLegacyResolution(null); setLegacyKeyStyle(null); }}>{dict.common.cancel}</button>
        </div>
    </StudioDialog>}
    {fullScreenDialog === "preferences" && <StudioDialog screen title={dict.header.preferences} description={dict.settings.title} onClose={() => setFullScreenDialog(null)}>
      <SettingsModal presentation="workspace" isOpen onClose={() => setFullScreenDialog(null)} />
    </StudioDialog>}
    {fullScreenDialog === "pianist" && <StudioDialog screen title={dict.pianist.title} description={dict.pianist.subtitle} onClose={() => setFullScreenDialog(null)}>
      <ProfileModal presentation="workspace" initialProfile={active ? sessionProfile ?? active.result.profile : undefined} isOpen onClose={() => setFullScreenDialog(null)} />
    </StudioDialog>}
  </>;

  const emptyWorkspace = <div className="studio-welcome" data-testid="studio-welcome">
    <p className="studio-welcome__eyebrow">{dict.welcome.eyebrow}</p>
    <h1>{dict.welcome.title}</h1>
    <p>{dict.welcome.subtitle}</p>
    <div className="studio-welcome__actions">
      <button type="button" onClick={() => midiInputRef.current?.click()}>{dict.welcome.openMidi}</button>
      <button type="button" onClick={openBuiltinMelodies}>{dict.welcome.browseMelodies}</button>
      <button type="button" onClick={() => projectInputRef.current?.click()}>{dict.welcome.openProject}</button>
      <button type="button" disabled={!fixtureManifest || busy} onClick={() => void openFixture(DEMO_FIXTURE_ID)}>{dict.welcome.playDemo}</button>
    </div>
  </div>;

  // Player-local operations (such as editing/replanning or preparing audio)
  // have their own genuine StudioStatus, separate from App's source-open lifecycle.
  const stageLoading: LoadingExperienceState | null = active &&
    (status.kind === "loading" || status.kind === "calculating")
    ? { generation: -1, phase: phaseFromWorkerProgress(status.message, "analysis"), detail: status.message, progress: measuredProgress(status.progress) }
    : null;
  // A finished MIDI analysis is NOT equivalent to playback readiness: the
  // newly mounted player still decodes and prepares its selected SoundFont.
  // Match the session identity so a prior player's "ready" cannot dismiss the
  // current source's indicator during a switch.
  const readinessBlocker: PlaybackBlocker | null = active
    ? playbackReadiness?.requestId === active.result.requestId
      ? playbackReadiness.blocker
      : "audio"
    : null;
  const awaitingPlayback: LoadingExperienceState | null = active && readinessBlocker && status.kind !== "error"
    ? {
      generation: -2,
      phase: readinessBlocker,
      detail: readinessBlocker === "audio" ? "Preparing the selected audio output…"
        : readinessBlocker === "analysis" ? "Preparing the playback plan…"
          : "Opening your project…",
    }
    : null;
  const displayedLoading = loadingExperience ?? stageLoading ?? awaitingPlayback;
  const shellStatus: StudioStatus = active ? status : (busy ? { kind: "calculating", message: status.message } : status);

  const studioFooterAddon = (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
      {swUpdateRegistration && (
        <button
          type="button"
          className="studio-update-button"
          onClick={() => void handleApplyUpdate()}
          title={dict.dialogs.updateDescription}
          style={{
            background: "#22c55e",
            color: "#0a0c0d",
            fontWeight: 600,
            fontSize: "11px",
            padding: "2px 8px",
            borderRadius: "4px",
            border: "none",
            cursor: "pointer",
          }}
        >
          {dict.dialogs.updateReady}
        </button>
      )}
      <StudioReleaseDetails description="0.1.0-dev.22 preview: Practice panel with A/B repeat across playback and PlayAlong, plus named time bookmarks saved, recoverable, and JSON-bound to the source SHA; menu/library fixes and the 3D stage are retained." />
    </div>
  );

  return <>
    <input ref={midiInputRef} id="midi-file" type="file" accept=".mid,.midi,audio/midi,audio/x-midi" hidden onChange={onMidiInput} />
    <input ref={projectInputRef} id="project-file" type="file" accept=".json,application/json" hidden onChange={onPackageInput} />
    {active ? <PianoPlayer
      key={active.result.requestId}
      result={active.result}
      analysisWorker={active.analysisWorker}
      projectName={active.projectName}
      rawMidiBytes={active.rawMidiBytes}
      sourceContext={active.sourceContext}
      engineVersion={engineVersion}
      initialSession={active.session}
      initialViewMode={viewMode}
      isDirty={dirty}
      status={status}
      busy={busy}
      autosaveService={autosaveService}
      onViewModeChange={setViewMode}
      onStatusChange={setStatus}
      onPlaybackReadinessChange={handlePlaybackReadinessChange}
      onOpenMidi={() => midiInputRef.current?.click()}
      onOpenBuiltinMelodies={openBuiltinMelodies}
      onOpenPackage={() => projectInputRef.current?.click()}
      onOpenPreferences={() => setFullScreenDialog("preferences")}
      onOpenPianist={() => setFullScreenDialog("pianist")}
      onOpenProject={openSavedProject}
      onRegisterSaveHandler={registerSaveHandler}
      onDirtyChange={markDirty}
      onProfileStateChange={setSessionProfile}
      developerTools={developerTools}
      dialogs={dialogs}
      footerAddon={studioFooterAddon}
        onProjectSaved={(projectId: string) => {
          addRecentProjectId(projectId);
          window.dispatchEvent(new Event("studio-projects-changed"));
          markDirty(false);
          setStatus({ kind: "saved", message: "Project saved to this browser." });
        }}
    /> : <StudioShell
      projectName="Untitled project"
      hasProject={false}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      status={shellStatus}
      busy={busy}
      onOpenMidi={() => midiInputRef.current?.click()}
      onOpenBuiltinMelodies={openBuiltinMelodies}
      onOpenPackage={() => projectInputRef.current?.click()}
      onOpenPreferences={() => setFullScreenDialog("preferences")}
      onOpenPianist={() => setFullScreenDialog("pianist")}
      projectsPanel={<ProjectsPanel onOpenProject={(id) => void openSavedProject(id)} onOpenBuiltinMelodies={openBuiltinMelodies} />}
      inspector={inspector}
      workspace={emptyWorkspace}
      footerAddon={studioFooterAddon}
      dialogs={dialogs}
    />}
    {displayedLoading && <MusicalLoading key={displayedLoading.generation}
      loading={displayedLoading} language={language}
      prominent={!active || (!hasPlayedReadySession && Boolean(awaitingPlayback))}
      immediate={Boolean(awaitingPlayback)} />}
  </>;
}

function snapshotToSavedProject(snapshot: SessionSnapshot, sourceContext: ProjectSourceContext): SavedProject {
  const result = snapshot.result!;
  const document = snapshot.document ?? result.document!;
  const savedIntent = snapshot.draftFingeringPlan ?? snapshot.fingeringPlan ?? result.fingeringPlan;
  const profile = snapshot.profile ?? result.profile;
  const fingeringPlan = savedIntent ? {
    ...savedIntent,
    profileId: profile.profileId,
    profileRevision: profile.revision,
  } : null;
  // An autosave may contain a newer draft/profile and the last usable bundle.
  // Keep that manual intent, but never present the old derived plans as its plans.
  const hasCurrentDerivedPlans = snapshot.plansState !== "recompute-required" &&
    result.document?.revision === document.revision &&
    result.fingeringPlan?.planId === fingeringPlan?.planId &&
    result.profile.profileId === profile.profileId && result.profile.revision === profile.revision;
  let name = snapshot.projectName;
  if (!name || name.startsWith("builtin-") || /^[a-f0-9]{64}$/i.test(name)) {
    const candidateId = (name?.startsWith("builtin-") ? name.slice(8) : null) ??
      (sourceContext.fixtureId?.startsWith("builtin-") ? sourceContext.fixtureId.slice(8) : null);
    const catalogEntry = candidateId ? lookupBuiltinMelody(candidateId) : undefined;
    if (catalogEntry) {
      name = catalogEntry.title;
    } else if (name?.startsWith("builtin-")) {
      name = `Built-in #${name.slice(8, 14)}`;
    } else {
      name = document.title || snapshot.projectId;
    }
  }
  return {
    projectId: snapshot.projectId,
    name,
    updatedAt: snapshot.updatedAt,
    document,
    fingeringPlan: fingeringPlan ?? null,
    performancePlan: hasCurrentDerivedPlans ? result.performancePlan ?? null : null,
    motionPlan: hasCurrentDerivedPlans ? result.motionPlan ?? null : null,
    rawMidiBytes: snapshot.rawMidiBytes,
    profile,
    resources: [snapshot.sourceDescriptor ?? result.resource],
    sourceContext,
    ...(snapshot.practiceState ? { practiceState: snapshot.practiceState } : {}),
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
