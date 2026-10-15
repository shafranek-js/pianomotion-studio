import {
  M1AnalyzeMidiResultSchema,
  M1ExportMidiRequestSchema,
  M1ExportMidiResultSchema,
  M1ReplanDocumentRequestSchema,
  validateM1ReplanDocumentResultForRequest,
  type FingeringPlan,
  type M1AnalyzeMidiResult,
  type M1KeyStyle,
  type PianistProfile,
  type ProjectSourceContext,
  type SongDocument,
} from "@handthesia/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  Transport,
  decodeAudioRecording,
  getAudioContext,
  getMasterGain,
  SyncedAudioSource,
  parseSf2Async,
  prepareSoundFontPerformanceOutput,
  loadSoundFontAsset,
  WebMidiPerformanceOutput,
  type DecodedAudioRecording,
} from "../audio";
import { WebMidiOutputManager, getSharedWebMidiOutputManager } from "../midi/webMidiOutput";
import {
  FingeringEditor,
  materializeEditedDocument,
  WaveformCanvas,
  type FingeringEditorDiagnosticsReport,
  type FingeringEditorSceneBridge,
} from "../editor";
import { postM1ExportMidiRequest, postM1ReplanDocumentRequest, createM1AnalysisWorker } from "../m1WorkerClient";
import { getActiveProfile, subscribeProfiles } from "../profiles/profileStore";
import { PianoScene, MotionBuffer } from "../render";
import {
  downloadProjectPackage,
  saveProject,
  type AutosaveService,
  type SavedProject,
  type SessionSnapshot,
} from "../storage";
import type { AppSettings, SkinStyleSetting } from "../settings";
import {
  getSettings,
  subscribeSettings,
  updateSettingsPersisted,
} from "../settings/settingsStore";
import { ProjectsPanel } from "../studio/ProjectsPanel";
import { StudioInspector } from "../studio/StudioInspector";
import { StudioReleaseDetails, StudioShell } from "../studio/StudioShell";
import { StudioTransport } from "../studio/StudioTransport";
import { type InspectorTab, type StudioStatus, type StudioView, normalizeStudioView } from "../studio/types";
import { StudioWorkspace } from "../studio/StudioWorkspace";
import { runWorkerJob } from "./workerJob";
import type { SaveResult, SaveSession } from "./saveResult";
import { MotionStreamController } from "./motionStreamController";
import { VideoExportModal, type ExportSceneDataSource } from "../export";

export interface PianoPlayerProps {
  result: M1AnalyzeMidiResult;
  projectName: string;
  rawMidiBytes: ArrayBuffer | null;
  sourceContext: ProjectSourceContext;
  engineVersion: string;
  initialSession?: SessionSnapshot | null;
  initialViewMode?: StudioView;
  isDirty?: boolean;
  status: StudioStatus;
  busy?: boolean;
  autosaveService: AutosaveService;
  developerTools?: ReactNode;
  dialogs?: ReactNode;
  onViewModeChange(view: StudioView): void;
  onStatusChange(status: StudioStatus): void;
  onDirtyChange(dirty: boolean): void;
  onOpenMidi(): void;
  onOpenPackage(): void;
  onOpenPreferences(): void;
  onOpenPianist(): void;
  onOpenProject(projectId: string): void;
  onRegisterSaveHandler(handler: SaveSession | null): void;
  onProjectSaved?(projectId: string): void;
  onProfileStateChange?(profile: PianistProfile): void;
  analysisWorker?: Worker;
  footerAddon?: ReactNode;
}

declare global {
  interface Window {
    __playerSnapshot?: {
      result: M1AnalyzeMidiResult;
      draftPlan: FingeringPlan;
      keyStyle: M1KeyStyle;
      pending: boolean;
      profile: PianistProfile;
      viewMode: StudioView;
      scene?: ReturnType<PianoScene["getGeometrySnapshot"]>;
      editorSelectedNoteIds?: string[];
      editorViewTime?: number | null;
    };
  }
}

/** Display-only assignments; the editable/source document stays unchanged. */
function sceneDocument(document: SongDocument, plan: FingeringPlan): SongDocument {
  const assignments = new Map(plan.assignments.map(assignment => [assignment.noteId, assignment]));
  return {...document, notes:document.notes.map(note => {
    const assignment = assignments.get(note.noteId);
    return assignment ? {...note, hand:assignment.hand, finger:assignment.finger} : note;
  })};
}

function createPlaybackMotionBuffer(analysis: M1AnalyzeMidiResult): MotionBuffer {
  const handByNote = new Map(analysis.fingeringPlan?.assignments.map(a => [a.noteId, a.hand]) ?? []);
  const requiredAnchors = (analysis.performancePlan?.events ?? []).flatMap(event => {
    if (event.type === "pedal") return [];
    const hand = handByNote.get(event.noteId);
    return hand === "left" || hand === "right" ? [{ hand, timeSeconds: event.timeSeconds }] : [];
  });
  const buffer = new MotionBuffer({
    windowAheadSeconds: 4, windowBehindSeconds: 1,
    expectedHands: [...new Set(requiredAnchors.map(anchor => anchor.hand))], requiredAnchors,
  });
  if (analysis.motionPlan?.poses) buffer.addPoses(analysis.motionPlan.poses);
  if (analysis.initialMotionWindow) buffer.addInitialMotionWindow(analysis.initialMotionWindow);
  return buffer;
}

export function PianoPlayer({
  result,
  projectName,
  rawMidiBytes,
  sourceContext: initialSourceContext,
  engineVersion,
  initialSession,
  initialViewMode,
  isDirty = false,
  status,
  busy = false,
  autosaveService,
  developerTools,
  dialogs,
  onViewModeChange,
  onStatusChange,
  onDirtyChange,
  onProfileStateChange,
  analysisWorker,
  onOpenMidi,
  onOpenPackage,
  onOpenPreferences,
  onOpenPianist,
  onOpenProject,
  onRegisterSaveHandler,
  onProjectSaved,
  footerAddon,
}: PianoPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<PianoScene | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const webMidiManagerRef = useRef<WebMidiOutputManager | null>(null);
  const motionBufferRef = useRef<MotionBuffer | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const workerIdentityRef = useRef<{ projectId: string; revision: number; engineVersion: string } | null>(null);
  const editorBridgeRef = useRef<FingeringEditorSceneBridge | null>(null);
  const syncedAudioRef = useRef<SyncedAudioSource | null>(null);
  const recordingGenerationRef = useRef(0);
  const generationRef = useRef(0);
  const needsReplanRef = useRef(true);
  const motionStreamRef = useRef<MotionStreamController | null>(null);
  const motionErrorRef = useRef<string | null>(null);
  const seekEpochRef = useRef(0);
  const bufferingPausedRef = useRef(false);
  const playIntentRef = useRef(false);
  const latestStateRef = useRef({ analysis: result, draftPlan: initialSession?.draftFingeringPlan ?? result.fingeringPlan!, profile: initialSession?.profile ?? result.profile });
  const dirtyRef = useRef(isDirty);
  const editVersionRef = useRef(0);
  const sourceContextRef = useRef(initialSourceContext);
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  const settingsAtStart = getSettings();
  const [analysis, setAnalysis] = useState(result);
  const [draftPlan, setDraftPlan] = useState<FingeringPlan>(() => initialSession?.draftFingeringPlan ?? initialSession?.fingeringPlan ?? result.fingeringPlan!);
  const [activeProfile, setActiveProfile] = useState<PianistProfile>(() => initialSession?.profile ?? result.profile);
  const [settings, setSettings] = useState<AppSettings>(settingsAtStart);
  const [keyStyle, setKeyStyle] = useState<M1KeyStyle>(() => initialSession?.keyStyle ?? initialSourceContext.keyStyle ?? result.rawBaseline.provenance?.keyStyle ?? settingsAtStart.keyStyle);
  const [appliedKeyStyle, setAppliedKeyStyle] = useState<M1KeyStyle>(() => initialSession?.keyStyle ?? initialSourceContext.keyStyle ?? result.rawBaseline.provenance?.keyStyle ?? settingsAtStart.keyStyle);
  const [sourceContext, setSourceContext] = useState<ProjectSourceContext>(initialSourceContext);
  const [viewMode, setViewMode] = useState<StudioView>(() => normalizeStudioView(initialViewMode ?? initialSession?.viewMode));
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [activeOutputId, setActiveOutputId] = useState<"synth" | "soundfont" | "webmidi">("synth");
  const [activeSoundfontAssetId, setActiveSoundfontAssetId] = useState<string | null>(null);
  const [activeSoundfontAssetBytes, setActiveSoundfontAssetBytes] = useState<ArrayBuffer | null>(null);
  const [preparingOutput, setPreparingOutput] = useState(false);
  const [outputEpoch, setOutputEpoch] = useState(0);
  const [currentTime, setCurrentTime] = useState(settingsAtStart.leadInSeconds);
  const [speed, setSpeed] = useState(settingsAtStart.playbackSpeed);
  const [volume, setVolume] = useState(settingsAtStart.masterVolume);
  const [audioRecording, setAudioRecording] = useState<DecodedAudioRecording | null>(null);
  const [audioOffset, setAudioOffset] = useState(0);
  const [editorBridge, setEditorBridge] = useState<FingeringEditorSceneBridge | null>(null);
  const [editorReport, setEditorReport] = useState<FingeringEditorDiagnosticsReport | null>(null);
  const [editorViewTime, setEditorViewTime] = useState<number | null>(null);
  const [assignmentControlsHost, setAssignmentControlsHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => { onProfileStateChange?.(activeProfile); }, [activeProfile, onProfileStateChange]);
  const [sceneRevision, setSceneRevision] = useState(0);
  const [forceReplan, setForceReplan] = useState(() => analysisWorker ? 0 : 1);
  const [workerEpoch, setWorkerEpoch] = useState(0);
  const [rebuildMessage, setRebuildMessage] = useState("");
  const [isVideoExportOpen, setIsVideoExportOpen] = useState(false);

  const document = useMemo(() => {
    if (!analysis.document) return null;
    return materializeEditedDocument({ ...analysis.document, revision: draftPlan.inputRevision }, draftPlan);
  }, [analysis.document, draftPlan]);
  const needsReplan = Boolean(
    forceReplan > 0 || !document || draftPlan.inputRevision !== analysis.document?.revision ||
    activeProfile.profileId !== analysis.profile.profileId || activeProfile.revision !== analysis.profile.revision ||
    keyStyle !== appliedKeyStyle || analysis.engineVersion !== engineVersion,
  );

  useEffect(() => { needsReplanRef.current = needsReplan; }, [needsReplan]);
  useEffect(() => { dirtyRef.current = isDirty; }, [isDirty]);
  useEffect(() => { sourceContextRef.current = sourceContext; }, [sourceContext]);
  useEffect(() => {
    latestStateRef.current = { analysis, draftPlan, profile: activeProfile };
  }, [analysis, draftPlan, activeProfile]);

  const markModified = useCallback((message = "Unsaved project changes.") => {
    editVersionRef.current += 1;
    dirtyRef.current = true;
    onDirtyChange(true);
    onStatusChange({ kind: "modified", message });
  }, [onDirtyChange, onStatusChange]);

  const handlePlanChange = useCallback((plan: FingeringPlan) => {
    setDraftPlan(plan);
    markModified("Fingering changes are not saved yet.");
  }, [markModified]);

  const handleKeyStyleChange = useCallback((style: M1KeyStyle) => {
    if (style === keyStyle) return;
    setKeyStyle(style);
    setSourceContext(current => ({ ...current, keyStyle: style }));
    sourceContextRef.current = { ...sourceContextRef.current, keyStyle: style };
    setDraftPlan(plan => ({ ...plan, inputRevision: plan.inputRevision + 1 }));
    setRebuildMessage("Scheduling updated performance…");
    markModified("Keyboard geometry changed. Recalculate and save the project.");
    void updateSettingsPersisted({ keyStyle: style }).catch(error => {
      onStatusChange({ kind: "error", message: `Keyboard geometry preference was not saved: ${errorMessage(error)}` });
    });
  }, [keyStyle, markModified, onStatusChange]);

  const handleSettingsChanged = useCallback((next: AppSettings) => {
    setSettings(next);
    setSpeed(next.playbackSpeed);
    setVolume(next.masterVolume);
    transportRef.current?.setSpeed(next.playbackSpeed);
    transportRef.current?.setVolume(next.masterVolume);
    sceneRef.current?.setDisplaySettings({
      showFingerLabels: next.showFingerLabels,
      showNoteNames: next.showNoteNames,
      skinStyle: next.skinStyle,
      showHandShadow: next.showHandShadow,
      renderCapFps: next.renderCapFps,
    });
    transportRef.current?.setLeadInSeconds(Math.abs(next.leadInSeconds));
    if (next.keyStyle !== sourceContextRef.current.keyStyle) handleKeyStyleChange(next.keyStyle);
  }, [handleKeyStyleChange]);

  const handleProfileChanged = useCallback((profile: PianistProfile) => {
    const current = latestStateRef.current.profile;
    if (current.profileId === profile.profileId && current.revision === profile.revision) return;
    setActiveProfile(profile);
    setDraftPlan(plan => ({
      ...plan,
      inputRevision: plan.inputRevision + 1,
      profileId: profile.profileId,
      profileRevision: profile.revision,
      engineVersion,
    }));
    setRebuildMessage("Scheduling updated performance…");
    markModified("Pianist profile changed. Recalculate and save the project.");
  }, [engineVersion, markModified]);

  const onSceneBridgeChange = useCallback((bridge: FingeringEditorSceneBridge | null) => {
    editorBridgeRef.current = bridge;
    setEditorBridge(bridge);
  }, []);

  useEffect(() => subscribeSettings(handleSettingsChanged), [handleSettingsChanged]);
  useEffect(() => subscribeProfiles(() => handleProfileChanged(getActiveProfile())), [handleProfileChanged]);

  useEffect(() => {
    const hasPreparedContext = workerEpoch === 0 && Boolean(analysisWorker);
    const worker = hasPreparedContext ? analysisWorker! : createM1AnalysisWorker();
    workerRef.current = worker;
    workerReadyRef.current = hasPreparedContext;
    workerIdentityRef.current = hasPreparedContext ? {projectId:result.projectId, revision:result.revision, engineVersion:result.engineVersion} : null;
    const motionStream = new MotionStreamController({
      worker,
      identity: { projectId: result.projectId, revision: result.revision, engineVersion: result.engineVersion },
      onResult: (message, flight) => {
        if (needsReplanRef.current || flight.seekEpoch !== seekEpochRef.current) return false;
        const buffer = motionBufferRef.current;
        if (!buffer) return false;
        const transport = transportRef.current;
        const curTime = Math.max(0, transport?.getCurrentTime() ?? 0);
        const duration = latestStateRef.current.analysis.document?.durationSeconds ?? 0;
        buffer.addSampleMotionResult(message, curTime);
        if (bufferingPausedRef.current && playIntentRef.current &&
            buffer.hasCoverage(curTime, Math.min(duration, curTime + 0.2))) {
          bufferingPausedRef.current = false;
          setIsBuffering(false);
          onStatusChangeRef.current({ kind: dirtyRef.current ? "modified" : "saved", message: "Animation is ready." });
          void transport?.play().catch(error => {
            playIntentRef.current = false;
            onStatusChangeRef.current({ kind: "error", message: `Playback failed: ${errorMessage(error)}` });
          });
        }
        return !buffer.hasCoverage(curTime, Math.min(duration, flight.demandEndTimeSeconds));
      },
      onError: (error) => {
        motionErrorRef.current = errorMessage(error);
        bufferingPausedRef.current = false;
        playIntentRef.current = false;
        setIsBuffering(false);
        transportRef.current?.pause();
        onStatusChangeRef.current({ kind: "error", message: "Animation calculation failed. Your project is retained.", details: errorMessage(error) });
      },
    });
    motionStreamRef.current = motionStream;
    const onError = (event: ErrorEvent) => {
      if (workerRef.current !== worker) return;
      workerReadyRef.current = false;
      workerIdentityRef.current = null;
      setRebuildMessage(`Calculation Worker stopped: ${event.message || "unknown error"}. Rebuilding the source context…`);
      setWorkerEpoch(value => value + 1);
      setForceReplan(value => value + 1);
    };
    worker.addEventListener("error", onError);
    return () => {
      motionStream.dispose();
      if (motionStreamRef.current === motionStream) motionStreamRef.current = null;
      worker.removeEventListener("error", onError);
      if (workerRef.current === worker) workerRef.current = null;
      // StrictMode immediately replays setup with the leased Worker. Release
      // only if the next setup did not reacquire this exact live context.
      queueMicrotask(() => {
        if (workerRef.current !== worker) worker.terminate();
      });
    };
    // The prepared source identity is immutable for this keyed player session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerEpoch, analysisWorker]);

  useEffect(() => {
    let live = true;
    const transport = new Transport({ leadInSeconds: Math.abs(settings.leadInSeconds) });
    transportRef.current = transport;
    transport.loadPlan(result.performancePlan!, result.document!.durationSeconds);
    transport.setSpeed(speed);
    transport.setVolume(volume);
    transport.getSampler().setTimbre(settings.soundTimbre);
    const unsubscribe = transport.subscribeState(state => setIsPlaying(state === "playing"));
    const unsubscribeEnded = transport.subscribeEnded(() => {
      playIntentRef.current = false;
      bufferingPausedRef.current = false;
      setIsBuffering(false);
    });
    const unsubscribeOutputError = transport.subscribeOutputError(error => {
      setPlaybackError(errorMessage(error));
      playIntentRef.current = false;
      bufferingPausedRef.current = false;
      setIsBuffering(false);
      onStatusChangeRef.current({ kind: "error", message: "Audio playback stopped. Check the audio output or recording before retrying.", details: errorMessage(error) });
    });
    const target = containerRef.current;
    if (target) {
      void PianoScene.create({
        target,
        song: sceneDocument(result.document!, result.fingeringPlan!),
        motionPlan: result.motionPlan,
        performancePlan: result.performancePlan,
        keyStyle,
        pixelsPerSecond: 180,
        displaySettings: {
          showFingerLabels: settings.showFingerLabels,
          showNoteNames: settings.showNoteNames,
          skinStyle: settings.skinStyle,
          showHandShadow: settings.showHandShadow,
          renderCapFps: settings.renderCapFps,
        },
      }).then(scene => {
        if (!live) { scene.destroy(); return; }
        sceneRef.current = scene;
        const motionBuffer = createPlaybackMotionBuffer(result);
        motionBufferRef.current = motionBuffer;
        scene.setMotionBuffer(motionBuffer);
        scene.setPerformancePlan(result.performancePlan!, document ?? result.document!);
        scene.setMotionPlan(result.motionPlan);
        scene.setDisplaySettings({
          showFingerLabels: settings.showFingerLabels,
          showNoteNames: settings.showNoteNames,
          skinStyle: settings.skinStyle,
          showHandShadow: settings.showHandShadow,
          renderCapFps: settings.renderCapFps,
        });
        scene.update(transport.getCurrentTime());
        setSceneRevision(value => value + 1);
      }).catch(error => {
        if (live) onStatusChange({ kind: "error", message: `Piano scene could not be initialized: ${errorMessage(error)}` });
      });
    }
    return () => {
      live = false;
      unsubscribe();
      unsubscribeEnded();
      unsubscribeOutputError();
      recordingGenerationRef.current += 1;
      syncedAudioRef.current?.dispose();
      syncedAudioRef.current = null;
      webMidiManagerRef.current = null;
      transport.dispose();
      transportRef.current = null;
      sceneRef.current?.destroy();
      sceneRef.current = null;
      motionBufferRef.current = null;
    };
    // The Player owns one source. App keys it only after a candidate is fully prepared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setPerformancePlan(analysis.performancePlan ?? null, document ? sceneDocument(document, analysis.fingeringPlan!) : undefined);
    scene.setMotionPlan(analysis.motionPlan ?? null);
    scene.setKeyStyle(keyStyle);
    const buffer = createPlaybackMotionBuffer(analysis);
    motionBufferRef.current = buffer;
    scene.setMotionBuffer(buffer);
    motionStreamRef.current?.reset({ projectId: analysis.projectId, revision: analysis.revision, engineVersion: analysis.engineVersion }, seekEpochRef.current);
    motionErrorRef.current = null;
  }, [analysis, document, keyStyle]);

  useEffect(() => {
    sceneRef.current?.setDisplaySettings({
      showFingerLabels: settings.showFingerLabels,
      showNoteNames: settings.showNoteNames,
      skinStyle: settings.skinStyle,
      showHandShadow: settings.showHandShadow,
      renderCapFps: settings.renderCapFps,
    });
    transportRef.current?.setLeadInSeconds(Math.abs(settings.leadInSeconds));
  }, [settings]);

  useEffect(() => {
    if (settings.soundOutput !== "webmidi") return;
    const manager = getSharedWebMidiOutputManager();
    const signature = () => {
      const state = manager.getStatus();
      return JSON.stringify([state.permission, state.activeDeviceId, state.devices.map(device => [device.id, device.state])]);
    };
    let previous = signature();
    return manager.subscribe(() => {
      const next = signature();
      if (next !== previous) { previous = next; setOutputEpoch(value => value + 1); }
    });
  }, [settings.soundOutput]);

  useEffect(() => {
    const transport = transportRef.current;
    if (!transport) return;

    let live = true;

    async function syncOutputEngine() {
      const activeTransport = transportRef.current;
      if (!activeTransport) return;
      setPreparingOutput(true);

      try {
      if (settings.soundOutput === "soundfont") {
        try {
          if (!settings.soundfontAssetId) {
            throw new Error("No SoundFont selected. Please upload or choose an SF2 file in Settings.");
          }
          const asset = await loadSoundFontAsset(settings.soundfontAssetId);
          if (!asset) {
            throw new Error("Selected SoundFont was not found in local storage.");
          }
          if (!live || !transportRef.current) return;

          const sf = await parseSf2Async(asset.data);
          if (!live) return;
          const sfOutput = await prepareSoundFontPerformanceOutput(sf, {
            audioContext: getAudioContext(), destinationNode: getMasterGain(),
          });
          if (!live || !transportRef.current) { sfOutput.dispose(); return; }
          transportRef.current.setOutput(sfOutput);
          setActiveOutputId(transportRef.current.getOutputId());
          setActiveSoundfontAssetId(settings.soundfontAssetId);
          setActiveSoundfontAssetBytes(asset.data);
        } catch (err: unknown) {
          if (!live) return;
          onStatusChange({
            kind: "error",
            message: `SoundFont was not activated: ${errorMessage(err)}. The previous output remains active.`,
          });
        }
      } else if (settings.soundOutput === "webmidi") {
        try {
          let manager = webMidiManagerRef.current;
          if (!manager) {
            manager = getSharedWebMidiOutputManager();
            webMidiManagerRef.current = manager;
          }
          const status = await manager.init();
          if (!live || !transportRef.current) return;

          if (status.permission === "prompt") return;
          if (status.permission !== "granted" || status.devices.length === 0) {
            const reason =
              status.permission === "denied"
                ? "MIDI permission denied"
                : status.permission === "unsupported"
                  ? "Web MIDI unsupported"
                  : "no connected MIDI devices";
            throw new Error(`Web MIDI unavailable (${reason})`);
          }

          if (!manager.selectDevice(settings.webMidiDeviceId ?? status.devices[0]?.id ?? null)) {
            throw new Error("The selected MIDI output is not connected.");
          }
          const midiOutput = new WebMidiPerformanceOutput(manager, getAudioContext(), settings.webMidiChannel ?? 0);
          transportRef.current?.setOutput(midiOutput);
          setActiveOutputId(transportRef.current!.getOutputId());
          setActiveSoundfontAssetId(null);
          setActiveSoundfontAssetBytes(null);
        } catch (err: unknown) {
          if (!live) return;
          onStatusChange({
            kind: "error",
            message: `Web MIDI was not activated: ${errorMessage(err)}. The previous output remains active.`,
          });
        }
      } else {
        transportRef.current?.setOutput(null);
        transportRef.current?.getSampler().setTimbre(settings.soundTimbre);
        setActiveOutputId("synth");
        setActiveSoundfontAssetId(null);
        setActiveSoundfontAssetBytes(null);
      }
      } finally { if (live) setPreparingOutput(false); }
    }

    void syncOutputEngine();

    return () => {
      live = false;
    };
  }, [settings.soundOutput, settings.soundfontAssetId, settings.webMidiDeviceId, settings.webMidiChannel, settings.soundTimbre, outputEpoch, onStatusChange]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setFingeringEditor({
      active: viewMode === "editor",
      playing: isPlaying,
      plan: editorBridge?.plan ?? draftPlan,
      selectedNoteIds: editorBridge?.selectedNoteIds ?? new Set<string>(),
      onSelectionChange: ids => editorBridgeRef.current?.setSelection(ids),
      onPauseForScroll: () => {
        playIntentRef.current = false;
        bufferingPausedRef.current = false;
        setIsBuffering(false);
        transportRef.current?.pause();
      },
      onEditorViewTimeChange: setEditorViewTime,
    });
  }, [viewMode, isPlaying, editorBridge, draftPlan, sceneRevision]);

  useEffect(() => {
    if (!rawMidiBytes || !engineVersion || !needsReplan || !document) return;
    const generation = ++generationRef.current;
    const abort = new AbortController();
    workerReadyRef.current = false;
    workerIdentityRef.current = null;
    motionStreamRef.current?.cancel();
    const timer = window.setTimeout(() => {
      setRebuildMessage("Calculating updated performance…");
      onStatusChange({ kind: "calculating", message: "Calculating the current fingering and performance…" });
      void (async () => {
        try {
          const worker = workerRef.current;
          if (!worker) {
            setWorkerEpoch(value => value + 1);
            throw new Error("Calculation Worker is restarting. Retry the update in a moment.");
          }
          const profilePlan = {
            ...draftPlan,
            engineVersion,
            profileId: activeProfile.profileId,
            profileRevision: activeProfile.revision,
          };
          const request = M1ReplanDocumentRequestSchema.parse({
            type: "replan-document",
            requestId: crypto.randomUUID(),
            projectId: document.projectId,
            revision: document.revision,
            engineVersion,
            midiBytes: rawMidiBytes,
            document,
            fingeringPlan: profilePlan,
            profile: activeProfile,
            resource: analysis.resource,
            rawBaseline: analysis.rawBaseline,
            options: { fixtureId: sourceContext.fixtureId, keyStyle },
          });
          const response = await runWorkerJob(
            request,
            currentWorker => postM1ReplanDocumentRequest(currentWorker, request),
            message => message.type === "replan-document-result"
              ? validateM1ReplanDocumentResultForRequest(request, message)
              : undefined,
            abort.signal,
            message => { if (generation === generationRef.current) setRebuildMessage(message); },
            { worker, terminateOnComplete: false },
          );
          if (abort.signal.aborted || generation !== generationRef.current) return;
          const { keyStyle: returnedKeyStyle, ...envelope } = response;
          const next = M1AnalyzeMidiResultSchema.parse({ ...envelope, type: "analysis-result" });
          if (returnedKeyStyle !== sourceContext.keyStyle || next.status === "invalid" ||
              !next.document || !next.fingeringPlan || !next.performancePlan) {
            throw new Error("The updated project did not produce a complete playable plan.");
          }
          transportRef.current?.updatePlan(next.performancePlan, next.document.durationSeconds);
          sceneRef.current?.setPerformancePlan(next.performancePlan, sceneDocument(next.document, next.fingeringPlan));
          sceneRef.current?.setMotionPlan(next.motionPlan);
          sceneRef.current?.setKeyStyle(returnedKeyStyle);
          const nextBuffer = createPlaybackMotionBuffer(next);
          motionBufferRef.current = nextBuffer;
          sceneRef.current?.setMotionBuffer(nextBuffer);
          motionStreamRef.current?.reset({ projectId: next.projectId, revision: next.revision, engineVersion: next.engineVersion }, seekEpochRef.current);
          motionErrorRef.current = null;
          setAnalysis(next);
          setDraftPlan(next.fingeringPlan);
          setAppliedKeyStyle(returnedKeyStyle);
          setForceReplan(0);
          workerReadyRef.current = true;
          workerIdentityRef.current = { projectId: next.projectId, revision: next.revision, engineVersion: next.engineVersion };
          setRebuildMessage("");
          onStatusChange(dirtyRef.current
            ? { kind: "modified", message: "Performance recalculated. Save the project to keep these changes." }
            : { kind: "saved", message: "Project is ready." });
        } catch (error) {
          if (abort.signal.aborted || generation !== generationRef.current) return;
          const message = errorMessage(error);
          setRebuildMessage("");
          const worker = workerRef.current;
          if (worker && /crash|decode|exceeded 180 seconds/i.test(message)) {
            workerReadyRef.current = false;
            workerIdentityRef.current = null;
            setWorkerEpoch(value => value + 1);
          }
          onStatusChange({
            kind: "error",
            message: "Calculation failed. Your edits are retained.",
            details: message,
          });
        }
      })();
    }, 220);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [analysis, activeProfile, draftPlan, engineVersion, keyStyle, needsReplan, rawMidiBytes, document, sourceContext, workerEpoch, onStatusChange]);

  useEffect(() => {
    if (!rawMidiBytes || !document) return;
    autosaveService.schedule({
      projectId: analysis.projectId,
      updatedAt: Date.now(),
      document,
      fingeringPlan: draftPlan,
      result: analysis,
      rawMidiBytes,
      activeProfileId: activeProfile.profileId,
      profile: activeProfile,
      draftFingeringPlan: draftPlan,
      plansState: needsReplan ? "recompute-required" : "valid",
      keyStyle,
      sourceContext,
      sourceDescriptor: analysis.resource,
      viewMode,
    });
  }, [analysis, document, draftPlan, rawMidiBytes, activeProfile, keyStyle, sourceContext, viewMode, needsReplan, autosaveService]);

  useEffect(() => {
    let raf = 0;
    let lastUiUpdate = 0;
    const render = (now: number) => {
      const transport = transportRef.current;
      const time = transport?.getCurrentTime() ?? settings.leadInSeconds;
      sceneRef.current?.update(time);
      const snapshot = window.__playerSnapshot;
      if (snapshot) {
        snapshot.scene = sceneRef.current?.getGeometrySnapshot();
        snapshot.editorSelectedNoteIds = [...(editorBridgeRef.current?.selectedNoteIds ?? [])];
        snapshot.editorViewTime = sceneRef.current?.getEditorViewTime() ?? null;
      }
      if (now - lastUiUpdate >= 70) {
        lastUiUpdate = now;
        setCurrentTime(time);
      }

      const buffer = motionBufferRef.current;
      const worker = workerRef.current;
      const identity = workerIdentityRef.current;
      const songEnd = analysis.document?.durationSeconds ?? 0;
      if (bufferingPausedRef.current && playIntentRef.current && buffer &&
          buffer.hasCoverage(Math.max(0, time), Math.min(songEnd, Math.max(0, time) + 0.2))) {
        bufferingPausedRef.current = false;
        setIsBuffering(false);
        void transport?.play().catch(error => {
          playIntentRef.current = false;
          onStatusChangeRef.current({ kind: "error", message: `Playback failed: ${errorMessage(error)}` });
        });
      }

      // Check if playback needs to pause for buffering
      if (transport?.getState() === "playing" && buffer && time >= 0 && time < (analysis.document?.durationSeconds ?? 0)) {
        const lookaheadNeeded = Math.min(0.2, (analysis.document?.durationSeconds ?? 0) - time);
        if (!buffer.hasCoverage(time, time + lookaheadNeeded)) {
          transport.pause();
          bufferingPausedRef.current = true;
          setIsBuffering(true);
          onStatusChangeRef.current({
            kind: "calculating",
            message: "Buffering animation poses...",
          });
        }
      }

      if (worker && workerReadyRef.current && buffer && identity && !needsReplanRef.current &&
          !motionErrorRef.current && !motionStreamRef.current?.inFlightRequest && identity.projectId === analysis.projectId &&
          identity.revision === draftPlan.inputRevision && time >= 0 && time < (analysis.document?.durationSeconds ?? 0) &&
          !buffer.hasCoverage(time, Math.min(songEnd, time + 1.5))) {
        const missing = buffer.getMissingWindow(time);
        const start = Math.max(0, missing.start);
        const end = Math.min(songEnd, missing.end);
        if (end > start) motionStreamRef.current?.requestWindow(start, end, 200);
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [analysis, draftPlan, settings.leadInSeconds]);

  useEffect(() => {
    window.__playerSnapshot = {
      result: analysis,
      draftPlan,
      keyStyle,
      pending: needsReplan,
      profile: activeProfile,
      viewMode,
      scene: sceneRef.current?.getGeometrySnapshot(),
      editorSelectedNoteIds: [...(editorBridge?.selectedNoteIds ?? [])],
      editorViewTime: sceneRef.current?.getEditorViewTime() ?? null,
    };
    return () => { delete window.__playerSnapshot; };
  }, [analysis, draftPlan, keyStyle, needsReplan, activeProfile, viewMode, editorBridge, sceneRevision]);

  const handleViewModeChange = useCallback((next: StudioView) => {
    const normalized = normalizeStudioView(next);
    setViewMode(normalized);
    onViewModeChange(normalized);
  }, [onViewModeChange]);

  const togglePlay = useCallback(async () => {
    try {
      if (playIntentRef.current || isPlaying || bufferingPausedRef.current) {
        playIntentRef.current = false;
        bufferingPausedRef.current = false;
        setIsBuffering(false);
        transportRef.current?.pause();
      } else {
        if (motionErrorRef.current) throw new Error("Retry animation calculation in Diagnostics before playing.");
        playIntentRef.current = true;
        await transportRef.current?.play();
        setPlaybackError(null);
      }
    } catch (error) {
      playIntentRef.current = false;
      onStatusChange({ kind: "error", message: `Playback failed: ${errorMessage(error)}` });
    }
  }, [isPlaying, onStatusChange]);

  const handleStop = useCallback(() => {
    playIntentRef.current = false;
    bufferingPausedRef.current = false;
    setIsBuffering(false);
    seekEpochRef.current += 1;
    transportRef.current?.stop();
    const buffer = createPlaybackMotionBuffer(analysis);
    motionBufferRef.current = buffer;
    sceneRef.current?.setMotionBuffer(buffer);
    motionStreamRef.current?.reset({ projectId: analysis.projectId, revision: analysis.revision, engineVersion: analysis.engineVersion }, seekEpochRef.current);
    setCurrentTime(settings.leadInSeconds);
  }, [analysis, settings.leadInSeconds]);

  const handleSeek = useCallback((time: number) => {
    const resumeWhenReady = bufferingPausedRef.current && playIntentRef.current;
    seekEpochRef.current += 1;
    bufferingPausedRef.current = resumeWhenReady;
    setIsBuffering(resumeWhenReady);
    transportRef.current?.seek(time);
    const buffer = createPlaybackMotionBuffer(analysis);
    motionBufferRef.current = buffer;
    sceneRef.current?.setMotionBuffer(buffer);
    motionStreamRef.current?.reset({ projectId: analysis.projectId, revision: analysis.revision, engineVersion: analysis.engineVersion }, seekEpochRef.current);
    setCurrentTime(transportRef.current?.getCurrentTime() ?? time);
    sceneRef.current?.update(time);
  }, [analysis]);

  const handleSpeedChange = useCallback((value: number) => {
    setSpeed(value);
    transportRef.current?.setSpeed(value);
  }, []);

  const handleVolumeChange = useCallback((value: number) => {
    setVolume(value);
    transportRef.current?.setVolume(value);
  }, []);

  const handleAudioFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const generation = ++recordingGenerationRef.current;
    let candidate: SyncedAudioSource | null = null;
    try {
      onStatusChange({ kind: "loading", message: `Decoding ${file.name}…` });
      const context = getAudioContext();
      const decoded = await decodeAudioRecording(file, context);
      if (generation !== recordingGenerationRef.current) return;
      candidate = new SyncedAudioSource(0, 1.0);
      await candidate.attach(decoded, context, getMasterGain());
      if (generation !== recordingGenerationRef.current) { candidate.dispose(); return; }
      const previous = syncedAudioRef.current;
      syncedAudioRef.current = candidate;
      transportRef.current?.setSyncedAudio(candidate);
      previous?.dispose();
      setAudioRecording(decoded);
      setAudioOffset(0);
      onStatusChange({ kind: dirtyRef.current ? "modified" : "saved", message: `Audio recording ready: ${file.name}.` });
    } catch (error) {
      candidate?.dispose();
      if (generation === recordingGenerationRef.current) {
        onStatusChange({ kind: "error", message: `Recording was not replaced: ${errorMessage(error)}` });
      }
    } finally {
      input.value = "";
    }
  }, [onStatusChange]);

  const handleClearAudio = useCallback(() => {
    recordingGenerationRef.current += 1;
    syncedAudioRef.current?.dispose();
    syncedAudioRef.current = null;
    transportRef.current?.setSyncedAudio(null);
    setAudioRecording(null);
    setAudioOffset(0);
    onStatusChange({ kind: dirtyRef.current ? "modified" : "saved", message: "Audio recording removed." });
  }, [onStatusChange]);

  const handleAudioOffsetChange = useCallback((offset: number) => {
    if (!Number.isFinite(offset)) return;
    const bounded = Math.max(-30, Math.min(30, offset));
    setAudioOffset(bounded);
    syncedAudioRef.current?.setOffset(bounded, currentTime, speed);
  }, [currentTime, speed]);

  const savedProject = useCallback((): SavedProject => {
    if (!document || !analysis.performancePlan || !rawMidiBytes) throw new Error("Project source data is not ready to save.");
    return {
      projectId: analysis.projectId,
      name: projectName,
      updatedAt: Date.now(),
      document,
      fingeringPlan: draftPlan,
      performancePlan: analysis.performancePlan,
      motionPlan: analysis.motionPlan,
      rawMidiBytes,
      profile: activeProfile,
      resources: [analysis.resource],
      sourceContext,
    };
  }, [document, analysis, rawMidiBytes, projectName, draftPlan, activeProfile, sourceContext]);

  const saveToDatabase = useCallback(async (): Promise<SaveResult> => {
    const identity = { projectId: analysis.projectId, revision: draftPlan.inputRevision, changeToken: editVersionRef.current };
    if (needsReplanRef.current || !rawMidiBytes) {
      return { status: "blocked", reason: "Wait for the current calculation before saving the project.", identity };
    }
    let projectCommitted = false;
    onStatusChange({ kind: "saving", message: "Saving project to this browser…" });
    try {
      const project = savedProject();
      await saveProject(project);
      projectCommitted = true;
      if (editVersionRef.current !== identity.changeToken || needsReplanRef.current ||
          latestStateRef.current.draftPlan.inputRevision !== identity.revision) {
        const reason = "The previous revision was saved, but newer changes still need to be saved.";
        onStatusChange({ kind: "modified", message: reason });
        return { status: "blocked", reason, identity };
      }
      // A restart after an update restores this exact committed session, never an older autosave.
      autosaveService.schedule({
        projectId: project.projectId, updatedAt: Date.now(), document: project.document,
        fingeringPlan: draftPlan, draftFingeringPlan: draftPlan, result: analysis, rawMidiBytes,
        activeProfileId: activeProfile.profileId, profile: activeProfile, plansState: "valid",
        keyStyle, sourceContext, sourceDescriptor: analysis.resource, viewMode,
      });
      await autosaveService.flush({ throwOnError: true });
      if (editVersionRef.current !== identity.changeToken || needsReplanRef.current) {
        const reason = "New changes were made while saving. Save the latest revision before continuing.";
        onStatusChange({ kind: "modified", message: reason });
        return { status: "blocked", reason, identity };
      }
      dirtyRef.current = false;
      onDirtyChange(false);
      onProjectSaved?.(project.projectId);
      onStatusChange({ kind: "saved", message: "Project saved to this browser." });
      return { status: "committed", identity };
    } catch (error) {
      const reason = `${projectCommitted ? "Project saved, but recovery was not committed" : "Project was not saved"}: ${errorMessage(error)}`;
      onStatusChange({ kind: "error", message: reason });
      return { status: "failed", reason, identity };
    }
  }, [rawMidiBytes, savedProject, onDirtyChange, onProjectSaved, onStatusChange, analysis, draftPlan,
    autosaveService, activeProfile, keyStyle, sourceContext, viewMode]);

  const saveToDatabaseRef = useRef(saveToDatabase);
  useEffect(() => { saveToDatabaseRef.current = saveToDatabase; }, [saveToDatabase]);
  useEffect(() => {
    onRegisterSaveHandler({
      save: () => saveToDatabaseRef.current(),
      getState: () => ({
        projectId: latestStateRef.current.analysis.projectId,
        revision: latestStateRef.current.draftPlan.inputRevision,
        changeToken: editVersionRef.current,
        dirty: dirtyRef.current,
        pending: needsReplanRef.current,
      }),
    });
    return () => onRegisterSaveHandler(null);
  }, [onRegisterSaveHandler]);

  const handleExportPackage = useCallback(async () => {
    if (needsReplan || !rawMidiBytes) return;
    try {
      await downloadProjectPackage(savedProject(), {
        profiles: [activeProfile],
        resources: [analysis.resource],
        sourceContext,
        filename: `${projectName.replace(/\.mid(i)?$/i, "")}.pianomotion.json`,
      });
      onStatusChange({ kind: dirtyRef.current ? "modified" : "saved", message: "Project package exported." });
    } catch (error) {
      onStatusChange({ kind: "error", message: `Project package export failed: ${errorMessage(error)}` });
    }
  }, [needsReplan, rawMidiBytes, savedProject, activeProfile, analysis.resource, sourceContext, projectName, onStatusChange]);

  const handleExportMidi = useCallback(async () => {
    if (needsReplan || !rawMidiBytes || !document || !workerReadyRef.current) return;
    const worker = workerRef.current;
    if (!worker) return;
    const abort = new AbortController();
    onStatusChange({ kind: "loading", message: "Exporting fingered MIDI…" });
    try {
      const request = M1ExportMidiRequestSchema.parse({
        type: "export-midi",
        requestId: crypto.randomUUID(),
        projectId: analysis.projectId,
        revision: document.revision,
        engineVersion,
        midiBytes: rawMidiBytes,
        document,
        fingeringPlan: draftPlan,
      });
      const response = await runWorkerJob(
        request,
        currentWorker => postM1ExportMidiRequest(currentWorker, request),
        message => message.type === "export-midi-result" ? M1ExportMidiResultSchema.parse(message) : undefined,
        abort.signal,
        undefined,
        { worker, terminateOnComplete: false },
      );
      const blob = new Blob([response.exportedBytes], { type: "audio/midi" });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = `${projectName.replace(/\.mid(i)?$/i, "")}.fingered.mid`;
      anchor.click();
      URL.revokeObjectURL(url);
      onStatusChange({ kind: dirtyRef.current ? "modified" : "saved", message: `Exported ${response.markedCount} fingered notes.` });
    } catch (error) {
      onStatusChange({ kind: "error", message: `Fingered MIDI export failed: ${errorMessage(error)}` });
    }
  }, [needsReplan, rawMidiBytes, document, analysis.projectId, engineVersion, draftPlan, projectName, onStatusChange]);

  const handleDiagnosticNote = useCallback((noteId: string) => {
    const note = document?.notes.find(candidate => candidate.noteId === noteId);
    if (!note) return;
    editorBridgeRef.current?.setSelection([noteId]);
    playIntentRef.current = false;
    bufferingPausedRef.current = false;
    setIsBuffering(false);
    transportRef.current?.pause();
    sceneRef.current?.setEditorViewTime(note.startSeconds);
    handleViewModeChange("editor");
  }, [document, handleViewModeChange]);

  const handleReturnToPlayhead = useCallback(() => sceneRef.current?.setEditorViewTime(null), []);
  const handleRetryCalculation = useCallback(() => {
    motionErrorRef.current = null;
    playIntentRef.current = false;
    bufferingPausedRef.current = false;
    setIsBuffering(false);
    setForceReplan(value => value + 1);
    setWorkerEpoch(value => value + 1);
    setRebuildMessage("Retrying calculation…");
    onStatusChange({ kind: "calculating", message: "Retrying the current fingering and performance…" });
  }, [onStatusChange]);

  const inspector = useCallback((tab: InspectorTab) => (
    <StudioInspector
      tab={tab}
      result={analysis}
      profile={activeProfile}
      settings={settings}
      keyStyle={keyStyle}
      audioRecording={audioRecording}
      audioOffset={audioOffset}
      audioOutputLabel={playbackError ? `Playback unavailable: ${playbackError}` : `${preparingOutput ? "Preparing selected output; currently active: " : "Active output: "}${activeOutputId === "synth" ? "Built-in synthesizer" : activeOutputId === "soundfont" ? "Local SoundFont" : "External MIDI device"}`}
      sourceName={projectName}
      busy={needsReplan}
      developerTools={developerTools}
      difficultyReport={editorReport?.difficulty}
      planDiagnostics={editorReport?.diagnostics}
      calculationError={status.kind === "error" ? status.details ?? status.message : undefined}
      canRetryCalculation={status.kind === "error" && (needsReplan || Boolean(motionErrorRef.current))}
      onRetryCalculation={handleRetryCalculation}
      onSelectNote={handleDiagnosticNote}
      onKeyStyleChange={handleKeyStyleChange}
      onSkinStyleChange={(style: SkinStyleSetting) => {
        void updateSettingsPersisted({ skinStyle: style }).catch(error => {
          onStatusChange({ kind: "error", message: `Hand style preference was not saved: ${errorMessage(error)}` });
        });
      }}
      onOpenPianist={onOpenPianist}
      onAudioFileChange={event => void handleAudioFileChange(event)}
      onClearAudio={handleClearAudio}
      onAudioOffsetChange={handleAudioOffsetChange}
    />
  ), [analysis, activeProfile, settings, keyStyle, audioRecording, audioOffset, projectName, needsReplan, developerTools,
    editorReport, handleDiagnosticNote, handleKeyStyleChange, onOpenPianist, handleAudioFileChange, handleClearAudio,
    handleAudioOffsetChange, handleRetryCalculation, onStatusChange, status, preparingOutput, activeOutputId, playbackError]);

  const editorToolbar = <FingeringEditor
    document={document ?? result.document!}
    initialFingeringPlan={draftPlan}
    active={viewMode === "editor"}
    transportTime={currentTime}
    showDiagnostics={false}
    externalScene
    assignmentControlsHost={assignmentControlsHost}
    onFingeringPlanChange={handlePlanChange}
    onDiagnosticsChange={setEditorReport}
    onSceneBridgeChange={onSceneBridgeChange}
  />;
  const scene = <div id="piano-canvas-container" ref={containerRef} className="piano-canvas-container" data-testid="piano-canvas" />;
  const workspace = ({ effectiveView }: { effectiveView: StudioView; focusMode: boolean }) => (
    <StudioWorkspace
      viewMode={effectiveView}
      scene={scene}
      editorToolbar={editorToolbar}
      editorViewTime={editorViewTime}
      transportTime={currentTime}
      onReturnToPlayhead={handleReturnToPlayhead}
      waveform={audioRecording ? <div id="audio-waveform-container">
        <WaveformCanvas
          recording={audioRecording}
          offsetSeconds={audioOffset}
          songDuration={document?.durationSeconds ?? 0}
          pixelsPerSecond={180}
          scrollX={0}
          onOffsetChange={handleAudioOffsetChange}
          speed={speed}
          currentTime={currentTime}
        />
      </div> : undefined}
    />
  );

  const transport = <StudioTransport
    playing={isPlaying || isBuffering}
    currentTime={currentTime}
    duration={document?.durationSeconds ?? 0}
    leadInSeconds={settings.leadInSeconds}
    speed={speed}
    volume={volume}
    onTogglePlay={() => { void togglePlay(); }}
    onStop={handleStop}
    onSeek={handleSeek}
    onSpeedChange={handleSpeedChange}
    onVolumeChange={handleVolumeChange}
    disabled={busy || needsReplan}
  />;

  const exportSceneDataSource = useMemo<ExportSceneDataSource | null>(() => {
    if (!document || !analysis.performancePlan || !analysis.fingeringPlan || !rawMidiBytes || needsReplan) return null;
    return {
      sourceIdentity: {
        projectId: analysis.projectId,
        revision: analysis.revision,
        engineVersion: analysis.engineVersion,
        originalMidiBytes: rawMidiBytes,
        fingeringPlan: analysis.fingeringPlan,
        rawBaseline: analysis.rawBaseline,
        sourceContext,
        resource: analysis.resource,
        activeOutputId,
        soundFontAssetId: activeSoundfontAssetId,
        soundFontAssetBytes: activeSoundfontAssetBytes,
      },
      document,
      performancePlan: analysis.performancePlan,
      motionPlan: analysis.motionPlan ?? null,
      keyStyle,
      profile: activeProfile,
      settings,
      audioRecording: audioRecording ?? null,
      audioOffset,
    };
  }, [document, analysis, keyStyle, activeProfile, settings, audioRecording, audioOffset, rawMidiBytes, needsReplan, sourceContext, activeOutputId, activeSoundfontAssetId, activeSoundfontAssetBytes]);

  return <StudioShell
    projectName={projectName}
    hasProject
    viewMode={viewMode}
    onViewModeChange={handleViewModeChange}
    status={status.kind === "error" ? status : needsReplan && rebuildMessage ? { kind: "calculating", message: rebuildMessage } : status}
    busy={busy || needsReplan}
    onOpenMidi={onOpenMidi}
    onOpenPackage={onOpenPackage}
    onSave={() => { void saveToDatabase(); }}
    onExportMidi={() => { void handleExportMidi(); }}
    onExportPackage={() => { void handleExportPackage(); }}
    onExportVideo={() => setIsVideoExportOpen(true)}
    canSave={!needsReplan && Boolean(rawMidiBytes)}
    canExport={!needsReplan && Boolean(rawMidiBytes)}
    onOpenPreferences={onOpenPreferences}
    onOpenPianist={onOpenPianist}
    projectsPanel={<ProjectsPanel onOpenProject={onOpenProject} activeProjectId={analysis.projectId} />}
    inspector={inspector}
    workspace={workspace}
    transport={transport}
    headerAddon={viewMode === "editor" ? <div ref={setAssignmentControlsHost} className="studio-fingering-assignment-host" /> : undefined}
    footerAddon={footerAddon ?? <StudioReleaseDetails description="0.1.0-dev.3 preview: fingering assignments in the contextual header, protected saves and offline updates, bounded animation streaming, pitch-preserving recording playback, local SF2/MIDI outputs and MP4/WebM export. Physical device and listening acceptance remains separate." />}
    dialogs={<>
      {dialogs}
      <VideoExportModal
        isOpen={isVideoExportOpen}
        onClose={() => setIsVideoExportOpen(false)}
        dataSource={exportSceneDataSource}
      />
    </>}
  />;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
