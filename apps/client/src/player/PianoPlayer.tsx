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
  PracticeLoopSchema,
  validatePracticeStateForProject,
  type PracticeLoop,
  type PracticeState,
} from "@handthesia/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { debugGlobalsEnabled } from "../debugGlobals";
import {
  Transport,
  decodeAudioRecording,
  getAudioContext,
  getMasterGain,
  SyncedAudioSource,
  parseSf2Async,
  prepareSoundFontPerformanceOutput,
  loadSoundFontAsset,
  computeSha256Hex,
  WebMidiPerformanceOutput,
  type DecodedAudioRecording,
} from "../audio";
import { BUILTIN_SOUNDFONT_ID, BUILTIN_SOUNDFONT_NAME, loadBuiltinSoundFont } from "../audio/soundfont/builtinSoundfont.ts";
import { WebMidiOutputManager, getSharedWebMidiOutputManager } from "../midi/webMidiOutput";
import {
  FingeringEditor,
  materializeEditedDocument,
  WaveformCanvas,
  type FingeringEditorDiagnosticsReport,
  type FingeringEditorSceneBridge,
} from "../editor";
import { postM1ExportMidiRequest, postM1ReplanDocumentRequest, createM1AnalysisWorker, getM1AnalysisWorkerEngine } from "../m1WorkerClient";
import { recordDiagnostic } from "../diagnostics/eventLog";
import { subscribeProfileEvents, type ProfileStoreEvent } from "../profiles/profileStore";
import { PianoScene, MotionBuffer, type Camera3DPreset } from "../render";
import {
  type RiggedPoseEditFingerFilter,
  type RiggedPoseEditPair,
  type RiggedPoseEditSampleSource,
  type RiggedPoseEditSide,
  type RiggedPoseEditTimepoint,
  type RiggedPoseEditTransformMode,
} from "../render3d/pianoScene3d";
import { RIGGED_EXPERIMENTAL_HAND_MODEL_ID } from "../render3d/improvedHandRuntime";
import {
  createRiggedHandPosePreset,
  deleteRiggedHandPosePreset,
  exportRiggedHandPosePresetJson,
  importRiggedHandPosePresetJson,
  listRiggedHandPosePresets,
  loadRiggedHandPosePreset,
  replaceRiggedHandPosePreset,
  saveRiggedHandPosePreset,
  RiggedHandPosePresetError,
  RIGGED_HAND_POSE_PRESET_MAX_JSON_LENGTH,
  type RiggedHandPoseEditorProvenance,
  type RiggedHandPosePreset,
  type RiggedHandPoseSourceHashes,
} from "../render3d/riggedHandPosePreset";
import {
  downloadFile,
  exportProjectPackageJson,
  saveProject,
  type AutosaveService,
  type SavedProject,
  type SessionSnapshot,
} from "../storage";
import type { AppSettings, CalculationEngine, SkinStyleSetting } from "../settings";
import { normalizeStageAppearance, type StageAppearance } from "../settings/stageAppearance";
import {
  getSettings,
  subscribeSettings,
  updateSettingsPersisted,
} from "../settings/settingsStore";
import { ProjectsPanel } from "../studio/ProjectsPanel";
import { StudioInspector } from "../studio/StudioInspector";
import type { RiggedPoseEditorPanelProps } from "../studio/RiggedPoseEditorPanel";
import { StudioReleaseDetails, StudioShell } from "../studio/StudioShell";
import { StudioTransport } from "../studio/StudioTransport";
import { type InspectorTab, type StudioStatus, type StudioView, normalizeStudioView } from "../studio/types";
import { StudioWorkspace } from "../studio/StudioWorkspace";
import { useI18n } from "../i18n";
import { runWorkerJob } from "./workerJob";
import type { SaveResult, SaveSession } from "./saveResult";
import { MotionStreamController, type MotionStreamFlight } from "./motionStreamController";
import { motionPlaybackWindow, MOTION_REQUEST_SECONDS, MOTION_RETENTION_AHEAD_SECONDS } from "./motionPlaybackPolicy";
import { VideoExportModal, type ExportSceneDataSource } from "../export";
import { getSharedWebMidiInputManager, type WebMidiInputStatus } from "../midi";
import { PlayAlongEngine, type PlayAlongHandMode, type PlayAlongState, type PlayAlongStep } from "./playAlongEngine";
import { PlayAlongTransport } from "../studio/PlayAlongTransport";
import { PracticePanel } from "../studio/PracticePanel";
import type { KeyPressInfo } from "../render/keyboardView";
import { buildRecoverySnapshot } from "./recoverySnapshot";
import { fingeredMidiExportStatus } from "./exportStatus";
import { ExportOperationScope, runScopedExport } from "./exportScope";
import { playbackBlocker, type PlaybackBlocker } from "./playbackReadiness";

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
  onOpenBuiltinMelodies?(): void;
  libraryOpen?: boolean;
  onOpenPackage(): void;
  onOpenPreferences(): void;
  onOpenPianist(): void;
  onOpenProject(projectId: string): void;
  onDeleteProject?(projectId: string): void;
  onRegisterSaveHandler(handler: SaveSession | null): void;
  /** Reports when transport can actually start playback, after audio and plan preparation. */
  onPlaybackReadinessChange?(requestId: string, blocker: PlaybackBlocker | null): void;
  onProjectSaved?(projectId: string, saveEpoch: number): void;
  onBeginProjectSave?(projectId: string): number;
  onProfileStateChange?(profile: PianistProfile): void;
  analysisWorker?: Worker;
  footerAddon?: ReactNode;
}

/** Returns the profile changes that should affect this project session. */
export function profileFromStoreEvent(
  event: ProfileStoreEvent,
  currentProfile: PianistProfile,
): PianistProfile | null {
  if (event.type === "active-selection") {
    return event.profile.profileId === currentProfile.profileId &&
      event.profile.revision === currentProfile.revision
      ? null
      : event.profile;
  }
  if (event.type === "profile-updated" &&
      event.profile.profileId === currentProfile.profileId &&
      event.profile.revision !== currentProfile.revision) {
    return event.profile;
  }
  return null;
}

interface MotionBufferPauseSnapshot {
  time: number;
  guardEnd: number;
  left: ReturnType<MotionBuffer["getHandCoverageIntervals"]>;
  right: ReturnType<MotionBuffer["getHandCoverageIntervals"]>;
  inFlight: MotionStreamFlight | null;
}

interface RiggedPoseEditDraft {
  hands: RiggedPoseEditPair;
  sourceHashes: Readonly<{ left: string | null; right: string | null }>;
  editorProvenance: RiggedHandPoseEditorProvenance;
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
      practiceState?: PracticeState;
      currentTimeSeconds?: number;
      motionStreaming?: { buffering: boolean; pauseCount: number; requestCount: number; roundTripMs: number; lastPause: MotionBufferPauseSnapshot | null };
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

function formatPoseEditorTime(seconds: number): string {
  const sign = seconds < 0 ? "−" : "";
  const absolute = Math.abs(seconds);
  const minutes = Math.floor(absolute / 60);
  const remainder = absolute - minutes * 60;
  return `${sign}${minutes}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function poseEditorPositionLabel(timepoint: RiggedPoseEditTimepoint, zeroBasedIndex: number, total: number): string {
  return timepoint.kind === "lead-in-held"
    ? `Lead-in / ${formatPoseEditorTime(timepoint.displayedTransportTimeSeconds)} (first pose held)`
    : `Sampled pose ${zeroBasedIndex + 1} of ${total}`;
}

function createPoseEditDraft(
  scene: PianoScene,
  timepoint: RiggedPoseEditTimepoint,
  positionIndex: number,
  totalPositions: number,
): RiggedPoseEditDraft {
  const sourcePoseTimeSeconds: Partial<Record<RiggedPoseEditSide, number>> = {};
  for (const side of ["left", "right"] as const) {
    const source = scene.getPoseEditSampleSource(timepoint, side);
    if (source.sourcePoseTimeSeconds !== null && Number.isFinite(source.sourcePoseTimeSeconds)) {
      sourcePoseTimeSeconds[side] = source.sourcePoseTimeSeconds;
    }
  }
  return {
    hands: scene.exportPoseEditPair(),
    sourceHashes: scene.getPoseEditSourceHashes(),
    editorProvenance: {
      displayedTransportTimeSeconds: timepoint.displayedTransportTimeSeconds,
      ...(Object.keys(sourcePoseTimeSeconds).length > 0 ? { sourcePoseTimeSeconds } : {}),
      positionIndex,
      positionLabel: poseEditorPositionLabel(timepoint, positionIndex, totalPositions),
    },
  };
}

function hasVerifiedPoseSourceHashes(value: Readonly<{ left: string | null; right: string | null }>): value is RiggedHandPoseSourceHashes {
  return [value.left, value.right].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash));
}

function poseDraftMatchesSourceHashes(
  draft: RiggedPoseEditDraft,
  expected: Readonly<{ left: string | null; right: string | null }>,
): boolean {
  return draft.sourceHashes.left !== null && draft.sourceHashes.right !== null &&
    draft.sourceHashes.left.toLowerCase() === expected.left?.toLowerCase() &&
    draft.sourceHashes.right.toLowerCase() === expected.right?.toLowerCase();
}

function createPlaybackMotionBuffer(analysis: M1AnalyzeMidiResult): MotionBuffer {
  const handByNote = new Map(analysis.fingeringPlan?.assignments.map(a => [a.noteId, a.hand]) ?? []);
  const requiredAnchors = (analysis.performancePlan?.events ?? []).flatMap(event => {
    if (event.type === "pedal") return [];
    const hand = handByNote.get(event.noteId);
    return hand === "left" || hand === "right" ? [{ hand, timeSeconds: event.timeSeconds }] : [];
  });
  const buffer = new MotionBuffer({
    windowAheadSeconds: MOTION_RETENTION_AHEAD_SECONDS, windowBehindSeconds: 15,
    expectedHands: [...new Set(requiredAnchors.map(anchor => anchor.hand))], requiredAnchors,
  });
  if (analysis.motionPlan?.poses) buffer.addPoses(analysis.motionPlan.poses);
  if (analysis.initialMotionWindow) buffer.addInitialMotionWindow(analysis.initialMotionWindow);
  return buffer;
}

function createFreshPracticeState(sourceMidiSha256: string): PracticeState {
  return { schemaVersion: 1, sourceMidiSha256, loop: null, bookmarks: [] };
}

function restorePracticeState(
  initialSession: SessionSnapshot | null | undefined,
  result: M1AnalyzeMidiResult,
): { practiceState: PracticeState; discarded: boolean } {
  const fresh = createFreshPracticeState(result.resource.sha256);
  if (!initialSession || initialSession.practiceState === undefined) {
    return { practiceState: fresh, discarded: false };
  }
  try {
    if (!result.document) throw new Error("Current project document is unavailable.");
    return {
      practiceState: validatePracticeStateForProject(initialSession.practiceState, result.document, result.resource),
      discarded: false,
    };
  } catch {
    return { practiceState: fresh, discarded: true };
  }
}

function createBookmarkId(existing: readonly PracticeState["bookmarks"][number][]): string {
  let id = crypto.randomUUID();
  while (existing.some((bookmark) => bookmark.id === id)) id = crypto.randomUUID();
  return id;
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
  onOpenBuiltinMelodies,
  libraryOpen = false,
  onOpenPackage,
  onOpenPreferences,
  onOpenPianist,
  onOpenProject,
  onDeleteProject,
  onRegisterSaveHandler,
  onPlaybackReadinessChange,
  onProjectSaved,
  onBeginProjectSave,
  footerAddon,
}: PianoPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<PianoScene | null>(null);
  const poseEditDraftsRef = useRef(new Map<string, RiggedPoseEditDraft>());
  const poseEditSessionRef = useRef<{ timepointId: string; positionIndex: number; timepoint: RiggedPoseEditTimepoint; totalPositions: number } | null>(null);
  const stageDraftRef = useRef<StageAppearance | null>(null);
  const stageSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const motionRoundTripMsRef = useRef(0);
  const motionPauseCountRef = useRef(0);
  const motionLastPauseRef = useRef<MotionBufferPauseSnapshot | null>(null);
  const motionRequestCountRef = useRef(0);
  const playIntentRef = useRef(false);
  const exportScopeRef = useRef(new ExportOperationScope());
  const [initialPractice] = useState(() => restorePracticeState(initialSession, result));
  const [practiceState, setPracticeState] = useState<PracticeState>(initialPractice.practiceState);
  const practiceStateRef = useRef(practiceState);
  const lastPracticeAutosaveRef = useRef(practiceState);
  const latestStateRef = useRef({
    analysis: result,
    draftPlan: initialSession?.draftFingeringPlan ?? result.fingeringPlan!,
    profile: initialSession?.profile ?? result.profile,
    document: initialSession?.document ?? result.document ?? null,
    projectName,
    rawMidiBytes,
    keyStyle: initialSession?.keyStyle ?? initialSourceContext.keyStyle,
    sourceContext: initialSourceContext,
    viewMode: normalizeStudioView(initialViewMode ?? initialSession?.viewMode),
    sceneView: {
      dimension: initialSession?.sceneView?.dimension ?? "3d",
      cameraPreset: initialSession?.sceneView?.cameraPreset ?? "concert",
    } as { dimension: "2d" | "3d"; cameraPreset: Camera3DPreset },
    practiceState: initialPractice.practiceState,
  });
  const dirtyRef = useRef(isDirty);
  const editVersionRef = useRef(0);
  const sourceContextRef = useRef(initialSourceContext);
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  const { dict, t } = useI18n();
  const settingsAtStart = getSettings();
  const calculationEngineRef = useRef<CalculationEngine>(settingsAtStart.calculationEngine);
  const [activeCalculationEngine, setActiveCalculationEngine] = useState<CalculationEngine>(
    () => getM1AnalysisWorkerEngine(analysisWorker) ?? settingsAtStart.calculationEngine,
  );
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
  const [activeSoundfontAssetBlob, setActiveSoundfontAssetBlob] = useState<Blob | null>(null);
  const [preparingOutput, setPreparingOutput] = useState(true);
  const [preparingSamples, setPreparingSamples] = useState(false);
  const [outputEpoch, setOutputEpoch] = useState(0);
  const [currentTime, setCurrentTime] = useState(settingsAtStart.leadInSeconds);
  const [poseEditActive, setPoseEditActive] = useState(false);
  const [poseEditBusy, setPoseEditBusy] = useState(false);
  const [poseEditTimepoints, setPoseEditTimepoints] = useState<RiggedPoseEditTimepoint[]>([]);
  const [poseEditTimepointId, setPoseEditTimepointId] = useState<string | null>(null);
  const [poseEditSide, setPoseEditSide] = useState<RiggedPoseEditSide>("right");
  const [poseEditBoneName, setPoseEditBoneName] = useState<string | null>(null);
  const [poseEditFingerFilter, setPoseEditFingerFilter] = useState<RiggedPoseEditFingerFilter>("all");
  const [poseEditTransformMode, setPoseEditTransformMode] = useState<RiggedPoseEditTransformMode>("rotate");
  const [poseEditUndoAvailable, setPoseEditUndoAvailable] = useState(false);
  const [poseEditDraftRevision, setPoseEditDraftRevision] = useState(0);
  const [poseEditStatus, setPoseEditStatus] = useState<string | null>(null);
  const [poseEditError, setPoseEditError] = useState<string | null>(null);
  const [poseEditPresetName, setPoseEditPresetName] = useState("");
  const [poseEditRenamePresetName, setPoseEditRenamePresetName] = useState("");
  const [poseEditPresets, setPoseEditPresets] = useState<RiggedHandPosePreset[]>([]);
  const [poseEditPresetId, setPoseEditPresetId] = useState("");
  const [poseEditPresetBusy, setPoseEditPresetBusy] = useState(false);
  const [speed, setSpeed] = useState(settingsAtStart.playbackSpeed);
  const [volume, setVolume] = useState(settingsAtStart.masterVolume);
  const [audioRecording, setAudioRecording] = useState<DecodedAudioRecording | null>(null);
  const [audioOffset, setAudioOffset] = useState(0);
  const [editorBridge, setEditorBridge] = useState<FingeringEditorSceneBridge | null>(null);
  const [editorReport, setEditorReport] = useState<FingeringEditorDiagnosticsReport | null>(null);
  const [editorViewTime, setEditorViewTime] = useState<number | null>(null);
  const [assignmentControlsHost, setAssignmentControlsHost] = useState<HTMLDivElement | null>(null);
  const [sceneRevision, setSceneRevision] = useState(0);
  const [forceReplan, setForceReplan] = useState(() => analysisWorker ? 0 : 1);

  const refreshPoseEditTimepoints = useCallback(() => {
    const points = sceneRef.current?.getPoseEditTimepoints(-Math.abs(settings.leadInSeconds)) ?? [];
    setPoseEditTimepoints(points);
    return points;
  }, [settings.leadInSeconds]);

  const saveCurrentPoseEditDraft = useCallback(() => {
    const scene = sceneRef.current;
    const session = poseEditSessionRef.current;
    if (!scene || !session || !scene.isPoseEditMode()) return null;
    try {
      const draft = createPoseEditDraft(scene, session.timepoint, session.positionIndex, session.totalPositions);
      poseEditDraftsRef.current.set(session.timepointId, draft);
      setPoseEditDraftRevision(value => value + 1);
      return draft;
    } catch (error) {
      setPoseEditError(`Could not keep the current pose draft: ${errorMessage(error)}`);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshPoseEditTimepoints();
  }, [refreshPoseEditTimepoints, sceneRevision, analysis.motionPlan]);

  const playAlongEngineRef = useRef<PlayAlongEngine | null>(null);
  const [playAlongStep, setPlayAlongStep] = useState<PlayAlongStep | null>(null);
  const [playAlongTotalSteps, setPlayAlongTotalSteps] = useState(0);
  const [playAlongStepTimes, setPlayAlongStepTimes] = useState<number[]>([]);
  const [playAlongState, setPlayAlongState] = useState<PlayAlongState>("idle");
  const playAlongStepRef = useRef(playAlongStep);
  const playAlongStateRef = useRef(playAlongState);
  useLayoutEffect(() => {
    playAlongStepRef.current = playAlongStep;
    playAlongStateRef.current = playAlongState;
  }, [playAlongStep, playAlongState]);
  const playAlongLibrarySuspensionRef = useRef<{ stepIndex: number; state: PlayAlongState } | null>(null);
  const skipNextPlayAlongViewStartRef = useRef(false);
  const [playAlongLoopAvailable, setPlayAlongLoopAvailable] = useState(true);
  const [playAlongHandMode, setPlayAlongHandMode] = useState<PlayAlongHandMode>("both");
  const [playAlongHeldPitches, setPlayAlongHeldPitches] = useState<ReadonlySet<number>>(new Set());
  const [playAlongCompletedPitches, setPlayAlongCompletedPitches] = useState<ReadonlySet<number>>(new Set());
  const [autoPlayOtherHand, setAutoPlayOtherHand] = useState(true);
  const wrongPitchesRef = useRef<Set<number>>(new Set());
  const [midiInputStatus, setMidiInputStatus] = useState<WebMidiInputStatus | null>(null);
  const viewModeRef = useRef<StudioView>(viewMode);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  const libraryOpenRef = useRef(libraryOpen);
  useLayoutEffect(() => { libraryOpenRef.current = libraryOpen; }, [libraryOpen]);
  const currentTimeRef = useRef(currentTime);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
  const playAlongTimeRef = useRef(0);
  const playAlongProjectIdRef = useRef<string | null>(null);
  const [workerEpoch, setWorkerEpoch] = useState(0);
  const [rebuildMessage, setRebuildMessage] = useState("");
  const [isVideoExportOpen, setIsVideoExportOpen] = useState(false);
  const [is3DView, setIs3DView] = useState(initialSession?.sceneView?.dimension !== "2d");
  const [camera3DPreset, setCamera3DPreset] = useState<Camera3DPreset>(initialSession?.sceneView?.cameraPreset ?? "concert");
  const is3DViewRef = useRef(is3DView);
  useEffect(() => { is3DViewRef.current = is3DView; }, [is3DView]);
  const camera3DPresetRef = useRef<Camera3DPreset>(camera3DPreset);
  useEffect(() => { camera3DPresetRef.current = camera3DPreset; }, [camera3DPreset]);

  const baseDocument = useMemo(
    () => initialSession?.result?.document ?? initialSession?.document ?? result.document ?? null,
    [initialSession, result],
  );

  const document = useMemo(() => {
    const base = baseDocument ?? analysis.document;
    if (!base) return null;
    return materializeEditedDocument({ ...base, revision: draftPlan.inputRevision }, draftPlan);
  }, [baseDocument, analysis.document, draftPlan]);
  const activePlayAlongLoop = useMemo(() => practiceState.loop?.enabled
    ? { startSeconds: practiceState.loop.startSeconds, endSeconds: practiceState.loop.endSeconds }
    : null, [practiceState.loop]);
  const needsReplan = Boolean(
    forceReplan > 0 || !document || draftPlan.inputRevision !== analysis.document?.revision ||
    activeProfile.profileId !== analysis.profile.profileId || activeProfile.revision !== analysis.profile.revision ||
    keyStyle !== appliedKeyStyle || analysis.engineVersion !== engineVersion,
  );
  const transportBlocker = playbackBlocker({ busy, needsReplan, preparingOutput, isPlaying, isBuffering });
  const poseEditAvailabilityById = useMemo(() => {
    const scene = sceneRef.current;
    if (scene) return scene.getPoseEditAvailabilityForTimepoints(poseEditTimepoints);
    return Object.fromEntries(poseEditTimepoints.map(timepoint => [timepoint.id, {
      available: false,
      leftAvailable: false,
      rightAvailable: false,
      reason: "no-3d-scene" as const,
    }]));
  }, [poseEditTimepoints, sceneRevision, is3DView, viewMode, settings.handModel]);
  const poseEditSelectedIndex = poseEditTimepoints.findIndex(point => point.id === poseEditTimepointId);
  const poseEditSelectedTimepoint = poseEditSelectedIndex >= 0 ? poseEditTimepoints[poseEditSelectedIndex]! : null;
  const poseEditModelMatches = settings.handModel === RIGGED_EXPERIMENTAL_HAND_MODEL_ID;
  const poseEdit3DActive = is3DView && viewMode !== "editor" && (sceneRef.current?.is3DMode() ?? false);
  const poseEditCanEnter = poseEditModelMatches && poseEdit3DActive && viewMode === "performance" && !needsReplan &&
    poseEditTimepoints.some(timepoint => {
      const availability = poseEditAvailabilityById[timepoint.id];
      return Boolean(availability?.leftAvailable && availability.rightAvailable && availability.reason !== "sample-unavailable" && availability.reason !== "no-3d-scene" && availability.reason !== "model-mismatch");
    });
  const poseEditEntryMessage = !poseEditActive && poseEditModelMatches
    ? viewMode !== "performance"
      ? "Switch to Performance view before editing a hand."
      : needsReplan
        ? "Wait for the current calculation to finish before editing a hand."
        : poseEditTimepoints.length > 0 && !poseEditTimepoints.some(timepoint => poseEditAvailabilityById[timepoint.id]?.available)
          ? "No sampled time is available for both loaded hands yet. Confirm both hands are loaded and wait for motion coverage."
          : null
    : null;
  const poseEditSourceHashes = sceneRef.current?.getPoseEditSourceHashes() ?? { left: null, right: null };
  const poseEditSourceHashesVerified = [poseEditSourceHashes.left, poseEditSourceHashes.right].every(value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value));
  const poseEditSampleSources: Record<RiggedPoseEditSide, RiggedPoseEditSampleSource | null> = useMemo(() => poseEditSelectedTimepoint
    ? {
        left: sceneRef.current?.getPoseEditSampleSource(poseEditSelectedTimepoint, "left") ?? null,
        right: sceneRef.current?.getPoseEditSampleSource(poseEditSelectedTimepoint, "right") ?? null,
      }
    : { left: null, right: null }, [poseEditSelectedTimepoint, poseEditTimepoints, sceneRevision]);
  useEffect(() => {
    onPlaybackReadinessChange?.(result.requestId, transportBlocker);
  }, [onPlaybackReadinessChange, result.requestId, transportBlocker]);

  useEffect(() => { needsReplanRef.current = needsReplan; }, [needsReplan]);
  useEffect(() => { dirtyRef.current = isDirty; }, [isDirty]);
  useEffect(() => { sourceContextRef.current = sourceContext; }, [sourceContext]);
  const currentSceneView = useMemo(() => ({
    dimension: is3DView ? "3d" : "2d",
    cameraPreset: camera3DPreset,
  } as const), [is3DView, camera3DPreset]);
  useLayoutEffect(() => {
    latestStateRef.current = {
      analysis,
      draftPlan,
      profile: activeProfile,
      document,
      projectName,
      rawMidiBytes,
      keyStyle,
      sourceContext,
      viewMode,
      sceneView: { dimension: is3DView ? "3d" : "2d", cameraPreset: camera3DPreset },
      practiceState,
    };
  }, [analysis, draftPlan, activeProfile, document, projectName, rawMidiBytes, keyStyle, sourceContext, viewMode, is3DView, camera3DPreset, practiceState]);

  const markModified = useCallback((message = "Unsaved project changes.") => {
    editVersionRef.current += 1;
    dirtyRef.current = true;
    onDirtyChange(true);
    onStatusChange({ kind: "modified", message });
  }, [onDirtyChange, onStatusChange]);

  const updatePracticeState = useCallback((next: PracticeState) => {
    if (next === practiceStateRef.current) return;
    practiceStateRef.current = next;
    latestStateRef.current = { ...latestStateRef.current, practiceState: next };
    setPracticeState(next);
    markModified(dict.practice.unsavedChanges);
  }, [dict.practice.unsavedChanges, markModified]);

  useEffect(() => {
    if (initialPractice.discarded) {
      onStatusChange({ kind: "error", message: dict.practice.invalidSavedState });
    }
  }, [dict.practice.invalidSavedState, initialPractice.discarded, onStatusChange]);

  useEffect(() => {
    if (!document) return;
    const duration = Math.max(0, document.durationSeconds);
    const current = practiceStateRef.current;
    let loop = current.loop;
    let changed = false;
    if (loop && (loop.startSeconds > duration || loop.endSeconds > duration)) {
      const candidate = {
        ...loop,
        startSeconds: Math.min(duration, loop.startSeconds),
        endSeconds: Math.min(duration, loop.endSeconds),
      };
      const parsed = PracticeLoopSchema.safeParse(candidate);
      loop = parsed.success ? parsed.data : null;
      changed = true;
    }
    const bookmarks = current.bookmarks.map((bookmark) => {
      if (bookmark.timeSeconds <= duration) return bookmark;
      changed = true;
      return { ...bookmark, timeSeconds: duration };
    });
    if (changed) updatePracticeState({ ...current, loop, bookmarks });
  }, [document, updatePracticeState]);

  const practiceDuration = document?.durationSeconds ?? analysis.document?.durationSeconds ?? 0;
  const commitPracticeLoop = useCallback((loop: PracticeLoop | null) => {
    updatePracticeState({ ...practiceStateRef.current, loop });
  }, [updatePracticeState]);
  const setPracticeLoopPoint = useCallback((point: "startSeconds" | "endSeconds", requestedTime: number) => {
    if (!Number.isFinite(requestedTime)) {
      onStatusChange({ kind: "error", message: dict.practice.invalidLoopTime });
      return;
    }
    const time = Math.min(practiceDuration, Math.max(0, requestedTime));
    const current = practiceStateRef.current.loop ?? {
      startSeconds: 0,
      endSeconds: practiceDuration,
      enabled: false,
    };
    const candidate = { ...current, [point]: time };
    if (candidate.startSeconds > practiceDuration || candidate.endSeconds > practiceDuration) {
      onStatusChange({ kind: "error", message: dict.practice.loopPointOutsideDuration });
      return;
    }
    const parsed = PracticeLoopSchema.safeParse(candidate);
    if (!parsed.success) {
      const outsideDuration = candidate.startSeconds > practiceDuration || candidate.endSeconds > practiceDuration;
      onStatusChange({
        kind: "error",
        message: outsideDuration ? dict.practice.loopPointOutsideDuration : dict.practice.invalidLoopRange,
      });
      return;
    }
    commitPracticeLoop(parsed.data);
  }, [commitPracticeLoop, dict.practice.invalidLoopRange, dict.practice.invalidLoopTime,
    dict.practice.loopPointOutsideDuration, onStatusChange, practiceDuration]);
  const handleLoopEnabledChange = useCallback((enabled: boolean) => {
    const current = practiceStateRef.current.loop ?? {
      startSeconds: 0,
      endSeconds: practiceDuration,
      enabled: false,
    };
    if (current.startSeconds > practiceDuration || current.endSeconds > practiceDuration) {
      onStatusChange({ kind: "error", message: dict.practice.loopPointOutsideDuration });
      return;
    }
    const parsed = PracticeLoopSchema.safeParse({ ...current, enabled });
    if (!parsed.success) {
      onStatusChange({ kind: "error", message: dict.practice.invalidLoopRange });
      return;
    }
    commitPracticeLoop(parsed.data);
  }, [commitPracticeLoop, dict.practice.invalidLoopRange, dict.practice.loopPointOutsideDuration, onStatusChange, practiceDuration]);
  const handleAddBookmark = useCallback((requestedName: string, requestedTime: number) => {
    const current = practiceStateRef.current;
    const name = requestedName.trim().slice(0, 120) || t("practice.defaultBookmarkName", { number: current.bookmarks.length + 1 });
    const timeSeconds = Number.isFinite(requestedTime)
      ? Math.min(practiceDuration, Math.max(0, requestedTime))
      : 0;
    const bookmark = { id: createBookmarkId(current.bookmarks), name, timeSeconds };
    updatePracticeState({ ...current, bookmarks: [...current.bookmarks, bookmark] });
  }, [practiceDuration, t, updatePracticeState]);
  const handleRenameBookmark = useCallback((id: string, requestedName: string) => {
    const name = requestedName.trim().slice(0, 120);
    if (!name) {
      onStatusChange({ kind: "error", message: dict.practice.bookmarkNameRequired });
      return;
    }
    const current = practiceStateRef.current;
    if (!current.bookmarks.some((bookmark) => bookmark.id === id)) return;
    updatePracticeState({
      ...current,
      bookmarks: current.bookmarks.map((bookmark) => bookmark.id === id ? { ...bookmark, name } : bookmark),
    });
  }, [dict.practice.bookmarkNameRequired, onStatusChange, updatePracticeState]);
  const handleDeleteBookmark = useCallback((id: string) => {
    const current = practiceStateRef.current;
    const bookmarks = current.bookmarks.filter((bookmark) => bookmark.id !== id);
    if (bookmarks.length === current.bookmarks.length) return;
    updatePracticeState({ ...current, bookmarks });
  }, [updatePracticeState]);

  const persistPracticeRecovery = useCallback(async (nextPracticeState: PracticeState) => {
    const current = latestStateRef.current;
    if (!current.document || !current.rawMidiBytes) return;
    autosaveService.schedule(buildRecoverySnapshot({
      projectName: current.projectName,
      updatedAt: Date.now(),
      document: current.document,
      draftFingeringPlan: current.draftPlan,
      result: current.analysis,
      rawMidiBytes: current.rawMidiBytes,
      profile: current.profile,
      plansState: needsReplanRef.current ? "recompute-required" : "valid",
      keyStyle: current.keyStyle,
      sourceContext: current.sourceContext,
      viewMode: current.viewMode,
      sceneView: current.sceneView,
      practiceState: nextPracticeState,
    }));
    await autosaveService.flush({ throwOnError: true });
  }, [autosaveService]);

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
    // A committed older slider value must not overwrite a newer local preview.
    if (stageDraftRef.current) next = { ...next, stageAppearance: stageDraftRef.current };
    if (poseEditActive && next.handModel !== RIGGED_EXPERIMENTAL_HAND_MODEL_ID) {
      saveCurrentPoseEditDraft();
      void sceneRef.current?.setPoseEditMode(false);
      sceneRef.current?.setPoseEditSelectionListener(undefined);
      sceneRef.current?.setPoseEditChangeListener(undefined);
      poseEditSessionRef.current = null;
      setPoseEditActive(false);
      setPoseEditUndoAvailable(false);
      setPoseEditStatus("The hand model changed. The unsaved pose was kept as an in-memory draft.");
    }
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
      stageAppearance: next.stageAppearance,
      handModel: next.handModel,
      testingHandMaterial: next.testingHandMaterial,
      testingThumbStrength: next.testingThumbStrength,
      testingKeyContact: next.testingKeyContact,
      testingShowBindAlignment: next.testingShowBindAlignment,
    });
    sceneRef.current?.setLeadInDurationSeconds(Math.abs(next.leadInSeconds));
    transportRef.current?.setLeadInSeconds(Math.abs(next.leadInSeconds));
    if (next.keyStyle !== sourceContextRef.current.keyStyle) handleKeyStyleChange(next.keyStyle);
    if (next.calculationEngine !== calculationEngineRef.current) {
      calculationEngineRef.current = next.calculationEngine;
      setRebuildMessage(`Switching to ${next.calculationEngine === "typescript" ? "TypeScript (Native)" : "Python (Pyodide)"} calculation engine…`);
      setWorkerEpoch(value => value + 1);
      setForceReplan(value => value + 1);
    }
  }, [handleKeyStyleChange, poseEditActive, saveCurrentPoseEditDraft]);

  const handleStageAppearanceChange = useCallback((value: StageAppearance) => {
    const next = normalizeStageAppearance(value);
    stageDraftRef.current = next;
    setSettings(previous => ({ ...previous, stageAppearance: next }));
    if (stageSaveTimerRef.current) clearTimeout(stageSaveTimerRef.current);
    stageSaveTimerRef.current = setTimeout(() => {
      stageSaveTimerRef.current = null;
      void updateSettingsPersisted({ stageAppearance: next }).then(() => {
        if (stageDraftRef.current === next) stageDraftRef.current = null;
      }).catch(error => {
        if (stageDraftRef.current === next) stageDraftRef.current = null;
        onStatusChange({ kind: "error", message: `Stage preference was not saved: ${errorMessage(error)}` });
      });
    }, 160);
  }, [onStatusChange]);

  useEffect(() => () => {
    if (stageSaveTimerRef.current) clearTimeout(stageSaveTimerRef.current);
    const pending = stageDraftRef.current;
    if (pending && stageSaveTimerRef.current) {
      void updateSettingsPersisted({ stageAppearance: pending }).catch(error => {
        console.warn("Stage preference could not be saved while closing the player", error);
      });
    }
  }, []);

  const handleProfileChanged = useCallback((profile: PianistProfile) => {
    const latest = latestStateRef.current;
    const current = latest.profile;
    if (current.profileId === profile.profileId && current.revision === profile.revision) return;
    // Store events may repeat before React commits the previous update.
    latestStateRef.current = { ...latest, profile };
    setActiveProfile(profile);
    onProfileStateChange?.(profile);
    setDraftPlan(plan => ({
      ...plan,
      inputRevision: plan.inputRevision + 1,
      profileId: profile.profileId,
      profileRevision: profile.revision,
      engineVersion,
    }));
    setRebuildMessage("Scheduling updated performance…");
    markModified("Pianist profile changed. Recalculate and save the project.");
  }, [engineVersion, markModified, onProfileStateChange]);

  const onSceneBridgeChange = useCallback((bridge: FingeringEditorSceneBridge | null) => {
    editorBridgeRef.current = bridge;
    setEditorBridge(bridge);
  }, []);

  useEffect(() => subscribeSettings(handleSettingsChanged), [handleSettingsChanged]);
  useEffect(() => subscribeProfileEvents((event) => {
    const profile = profileFromStoreEvent(event, latestStateRef.current.profile);
    if (profile) handleProfileChanged(profile);
  }), [handleProfileChanged]);

  useEffect(() => {
    const hasPreparedContext = workerEpoch === 0 && Boolean(analysisWorker);
    const worker = hasPreparedContext ? analysisWorker! : createM1AnalysisWorker(settings.calculationEngine);
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
        const isPlayAlong = viewModeRef.current === "play_along";
        const curTime = Math.max(0, isPlayAlong ? playAlongTimeRef.current : (transport?.getCurrentTime() ?? 0));
        const duration = latestStateRef.current.analysis.document?.durationSeconds ?? 0;
        buffer.addSampleMotionResult(message, curTime);
        const poseScene = sceneRef.current;
        if (poseScene) setPoseEditTimepoints(poseScene.getPoseEditTimepoints(-Math.abs(settingsAtStart.leadInSeconds)));
        motionRoundTripMsRef.current = Math.max(motionRoundTripMsRef.current * 0.85, Date.now() - flight.startedAt);
        const playbackWindow = motionPlaybackWindow(
          curTime,
          duration,
          isPlayAlong ? 1 : (transport?.getSpeed() ?? 1),
          motionRoundTripMsRef.current,
        );
        if (isPlayAlong) {
          sceneRef.current?.update(playAlongTimeRef.current);
        } else if (bufferingPausedRef.current && playIntentRef.current &&
            buffer.hasCoverage(playbackWindow.start, playbackWindow.resumeEnd)) {
          recordDiagnostic("motion.ready", { projectId: message.projectId, revision: message.revision,
            timeSeconds: curTime, resumeEnd: playbackWindow.resumeEnd, roundTripMs: motionRoundTripMsRef.current });
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
      onError: (error, _flight, retryable) => {
        if (retryable && error.code === "WORKER_BUSY") {
          onStatusChangeRef.current({ kind: "calculating", message: "Animation Worker is busy; preparing the next window…" });
          return;
        }
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
    let wasPreparingSamples = false;
    const unsubscribePreparation = transport.subscribePreparingOutput(preparing => {
      setPreparingSamples(preparing);
      if (preparing) onStatusChangeRef.current({ kind: "loading", message: "Preparing SoundFont samples…" });
      else if (wasPreparingSamples) onStatusChangeRef.current({
        kind: dirtyRef.current ? "modified" : "idle", message: "SoundFont preparation finished.",
      });
      wasPreparingSamples = preparing;
    });
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
        leadInDurationSeconds: Math.abs(settings.leadInSeconds),
        keyStyle,
        pixelsPerSecond: 180,
        displaySettings: {
          showFingerLabels: settings.showFingerLabels,
          showNoteNames: settings.showNoteNames,
          skinStyle: settings.skinStyle,
          showHandShadow: settings.showHandShadow,
          renderCapFps: settings.renderCapFps,
          stageAppearance: settings.stageAppearance,
          handModel: settings.handModel,
          testingHandMaterial: settings.testingHandMaterial,
          testingThumbStrength: settings.testingThumbStrength,
          testingKeyContact: settings.testingKeyContact,
          testingShowBindAlignment: settings.testingShowBindAlignment,
        },
        onContextLost: (error) => {
          if (live) onStatusChangeRef.current({
            kind: "error",
            message: "Graphics context was lost. Reload the page if the workspace does not recover.",
            details: errorMessage(error),
          });
        },
        onContextRestored: () => {
          if (live) onStatusChangeRef.current({ kind: "warning", message: "Graphics context restored." });
        },
      }).then(scene => {
        if (!live) { scene.destroy(); return; }
        sceneRef.current = scene;
        const motionBuffer = createPlaybackMotionBuffer(result);
        motionBufferRef.current = motionBuffer;
        scene.setMotionBuffer(motionBuffer);
        scene.setPerformancePlan(result.performancePlan!, sceneDocument(result.document!, result.fingeringPlan!));
        scene.setMotionPlan(result.motionPlan);
        scene.setDisplaySettings({
          showFingerLabels: settings.showFingerLabels,
          showNoteNames: settings.showNoteNames,
          skinStyle: settings.skinStyle,
          showHandShadow: settings.showHandShadow,
          renderCapFps: settings.renderCapFps,
          handModel: settings.handModel,
          testingHandMaterial: settings.testingHandMaterial,
          testingThumbStrength: settings.testingThumbStrength,
          testingKeyContact: settings.testingKeyContact,
          testingShowBindAlignment: settings.testingShowBindAlignment,
        });
        scene.setPianoKeyListeners(
          (pitch) => {
            if (libraryOpenRef.current) return;
            sceneRef.current?.setLivePhysicalPitch(pitch, true);
            if (viewModeRef.current === "play_along") {
              playAlongEngineRef.current?.noteOn(pitch, 90);
            } else {
              try {
                transportRef.current?.getOutput()?.noteOn(`mouse-${pitch}`, pitch, 90, 0);
              } catch {
                // ignore
              }
            }
          },
          (pitch) => {
            if (libraryOpenRef.current) return;
            sceneRef.current?.setLivePhysicalPitch(pitch, false);
            if (viewModeRef.current === "play_along") {
              playAlongEngineRef.current?.noteOff(pitch);
            } else {
              try {
                transportRef.current?.getOutput()?.noteOff(`mouse-${pitch}`, pitch, 0);
              } catch {
                // ignore
              }
            }
          }
        );
        if (viewModeRef.current === "play_along" && playAlongEngineRef.current) {
          const step = playAlongEngineRef.current.getCurrentStep();
          const completed = playAlongEngineRef.current.getCompletedPitchesInStep();
          const held = playAlongEngineRef.current.getHeldUserPitches();
          const targetMap = new Map<number, KeyPressInfo>();
          if (step) {
            for (const n of step.notes) {
              if (step.activePitches.has(n.pitch) && (!completed.has(n.pitch) || held.has(n.pitch))) {
                targetMap.set(n.pitch, { hand: n.hand, finger: n.finger });
              }
            }
          }
          scene.setPlayAlongState(targetMap, wrongPitchesRef.current.size > 0 ? new Set(wrongPitchesRef.current) : null);
          scene.update(playAlongTimeRef.current);
        } else {
          scene.update(transport.getCurrentTime());
        }
        scene.setCamera3DPreset(camera3DPresetRef.current);
        try {
          scene.set3DMode(is3DViewRef.current && viewModeRef.current !== "editor");
        } catch (error) {
          is3DViewRef.current = false;
          setIs3DView(false);
          onStatusChange({ kind: "error", message: `3D is unavailable; the 2D workspace remains active. ${errorMessage(error)}` });
        }
        setSceneRevision(value => value + 1);
      }).catch(error => {
        if (live) onStatusChange({ kind: "error", message: `Piano scene could not be initialized: ${errorMessage(error)}` });
      });
    }
    return () => {
      live = false;
      unsubscribe();
      unsubscribePreparation();
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
  }, [analysis, document, keyStyle, sceneRevision]);

  useEffect(() => {
    const transport = transportRef.current;
    if (!transport) return;
    try {
      transport.setLoop(activePlayAlongLoop);
    } catch (error) {
      onStatusChange({ kind: "error", message: `${dict.practice.title}: ${errorMessage(error)}` });
    }
  }, [activePlayAlongLoop, dict.practice.title, onStatusChange]);

  useEffect(() => {
    const transport = transportRef.current;
    if (!transport) return;
    return transport.subscribeLoop((timeSeconds) => {
      seekEpochRef.current += 1;
      const current = latestStateRef.current.analysis;
      const buffer = createPlaybackMotionBuffer(current);
      motionBufferRef.current = buffer;
      sceneRef.current?.setMotionBuffer(buffer);
      motionStreamRef.current?.reset(
        { projectId: current.projectId, revision: current.revision, engineVersion: current.engineVersion },
        seekEpochRef.current,
      );
      currentTimeRef.current = timeSeconds;
      setCurrentTime(timeSeconds);
      sceneRef.current?.update(timeSeconds);
    });
  }, []);

  useEffect(() => {
    if (poseEditActive && settings.handModel !== RIGGED_EXPERIMENTAL_HAND_MODEL_ID) {
      saveCurrentPoseEditDraft();
      void sceneRef.current?.setPoseEditMode(false);
      sceneRef.current?.setPoseEditSelectionListener(undefined);
      sceneRef.current?.setPoseEditChangeListener(undefined);
      poseEditSessionRef.current = null;
      setPoseEditActive(false);
      setPoseEditUndoAvailable(false);
      setPoseEditStatus("The hand model changed. The unsaved pose was kept as an in-memory draft.");
    }
    sceneRef.current?.setDisplaySettings({
      showFingerLabels: settings.showFingerLabels,
      showNoteNames: settings.showNoteNames,
      skinStyle: settings.skinStyle,
      showHandShadow: settings.showHandShadow,
      renderCapFps: settings.renderCapFps,
      stageAppearance: settings.stageAppearance,
      handModel: settings.handModel,
          testingHandMaterial: settings.testingHandMaterial,
          testingThumbStrength: settings.testingThumbStrength,
          testingKeyContact: settings.testingKeyContact,
          testingShowBindAlignment: settings.testingShowBindAlignment,
    });
    transportRef.current?.setLeadInSeconds(Math.abs(settings.leadInSeconds));
    sceneRef.current?.setLeadInDurationSeconds(Math.abs(settings.leadInSeconds));
    refreshPoseEditTimepoints();
  }, [settings, poseEditActive, saveCurrentPoseEditDraft, refreshPoseEditTimepoints]);

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
    const outputPreparation = new AbortController();

    async function syncOutputEngine() {
      const activeTransport = transportRef.current;
      if (!activeTransport) return;
      setPreparingOutput(true);

      try {
      if (settings.soundOutput === "soundfont") {
        try {
          if (!settings.soundfontAssetId) {
            throw new Error("No SoundFont selected. Please choose the included bank or an SF2/SF3 file in Settings.");
          }
          const asset = settings.soundfontAssetId === BUILTIN_SOUNDFONT_ID
            ? await loadBuiltinSoundFont({ signal: outputPreparation.signal })
            : await loadSoundFontAsset(settings.soundfontAssetId);
          if (!asset) {
            throw new Error("Selected SoundFont was not found in local storage.");
          }
          if (!live || !transportRef.current) return;

          const digest = await computeSha256Hex(asset.data, { signal: outputPreparation.signal });
          if (digest !== asset.id) throw new Error("Stored SoundFont content does not match its asset identity.");
          const sf = await parseSf2Async(asset.data, { signal: outputPreparation.signal });
          if (sf.sampleSource) sf.sampleSource.assetId = asset.id;
          if (!live) return;
          const sfOutput = await prepareSoundFontPerformanceOutput(sf, {
            audioContext: getAudioContext(), destinationNode: getMasterGain(),
            plan: latestStateRef.current.analysis.performancePlan ?? undefined,
            startSeconds: activeTransport.getCurrentTime(),
            signal: outputPreparation.signal,
          });
          try {
            // Playback/replan may advance while a candidate is decoded. Keep the
            // current output until the candidate covers the actual handover.
            while (live && transportRef.current) {
              const plan = latestStateRef.current.analysis.performancePlan;
              if (!plan) throw new Error("No performance plan is available for this SoundFont.");
              const position = transportRef.current.getCurrentTime();
              if (sfOutput.isWindowPrepared(plan, position, position + 0.2)) break;
              await sfOutput.prepareWindow(plan, position, position + 4, outputPreparation.signal);
            }
            if (!live || !transportRef.current) { sfOutput.dispose(); return; }
            transportRef.current.setOutput(sfOutput);
          } catch (error) {
            sfOutput.dispose();
            throw error;
          }
          setActiveOutputId(transportRef.current.getOutputId());
          setActiveSoundfontAssetId(settings.soundfontAssetId);
          setActiveSoundfontAssetBlob(asset.data);
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
          setActiveSoundfontAssetBlob(null);
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
        setActiveSoundfontAssetBlob(null);
      }
      } finally { if (live) setPreparingOutput(false); }
    }

    void syncOutputEngine();

    return () => {
      live = false;
      outputPreparation.abort();
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
          setActiveCalculationEngine(getM1AnalysisWorkerEngine(worker) ?? calculationEngineRef.current);
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
    autosaveService.schedule(buildRecoverySnapshot({
      projectName,
      updatedAt: Date.now(),
      document,
      draftFingeringPlan: draftPlan,
      result: analysis,
      rawMidiBytes,
      profile: activeProfile,
      plansState: needsReplan ? "recompute-required" : "valid",
      keyStyle,
      sourceContext,
      viewMode,
      sceneView: currentSceneView,
      practiceState,
    }));
  }, [analysis, document, draftPlan, rawMidiBytes, activeProfile, keyStyle, sourceContext, viewMode, currentSceneView, is3DView, camera3DPreset, needsReplan, autosaveService, projectName, practiceState]);

  useEffect(() => {
    if (lastPracticeAutosaveRef.current === practiceState) return;
    lastPracticeAutosaveRef.current = practiceState;
    void persistPracticeRecovery(practiceState).catch((error) => {
      onStatusChange({ kind: "error", message: `${dict.practice.title}: ${errorMessage(error)}` });
    });
  }, [dict.practice.title, onStatusChange, persistPracticeRecovery, practiceState]);

  useEffect(() => {
    if (libraryOpenRef.current) return;
    if (!document) return;
    const sameProject = playAlongProjectIdRef.current === analysis.projectId;
    const resumeTime = sameProject ? playAlongTimeRef.current : 0;
    if (!sameProject) playAlongTimeRef.current = 0;

    const buildStepTargetMap = (step: PlayAlongStep | null, eng: PlayAlongEngine): Map<number, KeyPressInfo> => {
      const targetMap = new Map<number, KeyPressInfo>();
      if (!step) return targetMap;
      const completed = eng.getCompletedPitchesInStep();
      const held = eng.getHeldUserPitches();
      for (const n of step.notes) {
        if (!step.activePitches.has(n.pitch)) continue;
        // If user already struck and released a note in a multi-note chord while other chord notes remain,
        // hide its target highlight so remaining unplayed chord notes stand out clearly.
        if (completed.has(n.pitch) && !held.has(n.pitch) && eng.getState() === "waiting") {
          continue;
        }
        targetMap.set(n.pitch, { hand: n.hand, finger: n.finger });
      }
      return targetMap;
    };

    const engine = new PlayAlongEngine({
      notes: document.notes,
      fingeringPlan: draftPlan,
      performancePlan: analysis.performancePlan,
      handMode: playAlongHandMode,
      autoPlayOtherHand,
      onStepChange: (step, state) => {
        setPlayAlongStep(step);
        setPlayAlongState(state);
        setPlayAlongHeldPitches(new Set(engine.getHeldUserPitches()));
        setPlayAlongCompletedPitches(new Set(engine.getCompletedPitchesInStep()));

        if (step) {
          transportRef.current?.prefetchWindowAt(step.timeSeconds, 8);
        }

        const targetMap = buildStepTargetMap(step, engine);
        sceneRef.current?.setPlayAlongState(
          targetMap,
          wrongPitchesRef.current.size > 0 ? new Set(wrongPitchesRef.current) : null,
        );
        if (state !== "transitioning") {
          const targetTime = step?.timeSeconds ?? playAlongTimeRef.current;
          playAlongTimeRef.current = targetTime;
          currentTimeRef.current = targetTime;
          setCurrentTime(targetTime);
          const buffer = motionBufferRef.current;
          const songEnd = analysis.document?.durationSeconds ?? 0;
          if (buffer && targetTime < songEnd && !buffer.hasCoverage(targetTime, Math.min(songEnd, targetTime + 0.5))) {
            seekEpochRef.current += 1;
            motionStreamRef.current?.reset(
              { projectId: analysis.projectId, revision: analysis.revision, engineVersion: analysis.engineVersion },
              seekEpochRef.current,
            );
          }
          sceneRef.current?.update(targetTime);
        }
      },
      onStateChange: (state) => {
        setPlayAlongState(state);
      },
      onTimeChange: (time) => {
        playAlongTimeRef.current = time;
        currentTimeRef.current = time;
        sceneRef.current?.update(time);
        setCurrentTime(time);
      },
      onPlayNote: (pitch, velocity, voiceId) => {
        if (libraryOpenRef.current) return;
        try {
          const output = transportRef.current?.getOutput();
          output?.noteOn(voiceId ?? `playalong-${pitch}`, pitch, velocity, 0);
        } catch {
          // resilient audio playback
        }
      },
      onStopNote: (pitch, voiceId) => {
        try {
          const output = transportRef.current?.getOutput();
          output?.noteOff(voiceId ?? `playalong-${pitch}`, pitch, 0);
        } catch {
          // resilient audio playback
        }
      },
      onWrongNote: (pitch) => {
        wrongPitchesRef.current.add(pitch);
        const step = engine.getCurrentStep();
        const targetMap = buildStepTargetMap(step, engine);
        sceneRef.current?.setPlayAlongState(targetMap, new Set(wrongPitchesRef.current));
        setTimeout(() => {
          wrongPitchesRef.current.delete(pitch);
          if (libraryOpenRef.current) return;
          const currentEngine = playAlongEngineRef.current;
          const currentStep = currentEngine?.getCurrentStep() ?? null;
          const currentTargetMap = currentEngine ? buildStepTargetMap(currentStep, currentEngine) : new Map<number, KeyPressInfo>();
          sceneRef.current?.setPlayAlongState(
            currentTargetMap,
            wrongPitchesRef.current.size > 0 ? new Set(wrongPitchesRef.current) : null,
          );
        }, 400);
      },
    });

    const savedLoop = practiceStateRef.current.loop;
    engine.setLoopRange(savedLoop?.enabled
      ? { startSeconds: savedLoop.startSeconds, endSeconds: savedLoop.endSeconds }
      : null);
    playAlongEngineRef.current = engine;
    setPlayAlongTotalSteps(engine.getSteps().length);
    setPlayAlongStepTimes(engine.getSteps().map((step) => step.timeSeconds));
    setPlayAlongLoopAvailable(engine.hasEligibleLoopSteps());
    if (viewModeRef.current === "play_along") {
      const suspended = playAlongLibrarySuspensionRef.current;
      if (suspended) {
        engine.seekToStep(suspended.stepIndex);
        if (suspended.state === "completed") engine.nextStep();
        playAlongLibrarySuspensionRef.current = null;
      } else {
        engine.start();
        // A replan recreates the engine; keep the play-along position instead of
        // snapping back to the first eligible step.
        if (resumeTime > 0) engine.seekToTime(resumeTime);
      }
    }
    playAlongProjectIdRef.current = analysis.projectId;
    return () => {
      engine.dispose();
      playAlongEngineRef.current = null;
      setPlayAlongTotalSteps(0);
      setPlayAlongStepTimes([]);
    };
  }, [document, draftPlan, analysis, playAlongHandMode, autoPlayOtherHand, libraryOpen]);

  useEffect(() => {
    const engine = playAlongEngineRef.current;
    if (!engine) return;
    engine.setLoopRange(activePlayAlongLoop);
    setPlayAlongLoopAvailable(engine.hasEligibleLoopSteps());
  }, [activePlayAlongLoop]);

  useEffect(() => {
    if (viewMode === "play_along") {
      if (transportRef.current?.getState() === "playing") {
        transportRef.current.pause();
      }
      if (libraryOpenRef.current) {
        playAlongEngineRef.current?.stop();
        return;
      }
      if (skipNextPlayAlongViewStartRef.current) {
        skipNextPlayAlongViewStartRef.current = false;
        return;
      }
      playAlongEngineRef.current?.start();
    } else {
      playAlongEngineRef.current?.stop();
      wrongPitchesRef.current.clear();
      sceneRef.current?.clearLivePhysicalPitches();
      sceneRef.current?.setPlayAlongState(null);
    }
  }, [viewMode, libraryOpen]);

  useEffect(() => {
    const inputManager = getSharedWebMidiInputManager();
    // Do not request MIDI access on mount: browsers may prompt immediately and
    // again after a refusal. The explicit "Connect MIDI" action requests it.
    const unsubStatus = inputManager.subscribeStatus(setMidiInputStatus);
    const unsubInput = inputManager.subscribeInput((event) => {
      if (libraryOpenRef.current) return;
      const isDown = event.type === "noteOn";
      sceneRef.current?.setLivePhysicalPitch(event.pitch, isDown);

      if (viewModeRef.current === "play_along") {
        if (isDown) {
          playAlongEngineRef.current?.noteOn(event.pitch, event.velocity);
        } else {
          playAlongEngineRef.current?.noteOff(event.pitch);
        }
      } else {
        const output = transportRef.current?.getOutput();
        try {
          if (isDown) {
            output?.noteOn(`live-${event.pitch}`, event.pitch, event.velocity, 0);
          } else {
            output?.noteOff(`live-${event.pitch}`, event.pitch, 0);
          }
        } catch {
          // ignore
        }
      }
    });

    return () => {
      unsubStatus();
      unsubInput();
    };
  }, []);

  useEffect(() => {
    if (viewMode !== "play_along") return;

    const keyToPitch: Record<string, number> = {
      a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72,
      A: 60, W: 61, S: 62, E: 63, D: 64, F: 65, T: 66, G: 67, Y: 68, H: 69, U: 70, J: 71, K: 72,
    };

    const heldKeys = new Set<string>();
    const isUiControl = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(
      'input, textarea, select, button, [contenteditable="true"], [role="button"], [role="dialog"], [role="menu"], [data-testid="practice-panel"]',
    ));

    const onKeyDown = (e: KeyboardEvent) => {
      if (libraryOpenRef.current) return;
      if (e.defaultPrevented || isUiControl(e.target)) return;
      if (e.repeat) return;

      if (e.key === " " || e.key === "ArrowRight") {
        e.preventDefault();
        playAlongEngineRef.current?.nextStep();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        playAlongEngineRef.current?.previousStep();
        return;
      }

      const pitch = keyToPitch[e.key];
      if (pitch !== undefined) {
        heldKeys.add(e.key);
        sceneRef.current?.setLivePhysicalPitch(pitch, true);
        playAlongEngineRef.current?.noteOn(pitch, 90);
        e.preventDefault();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const pitch = keyToPitch[e.key];
      if (libraryOpenRef.current) {
        if (pitch !== undefined && heldKeys.delete(e.key)) {
          sceneRef.current?.setLivePhysicalPitch(pitch, false);
        }
        return;
      }
      if (pitch !== undefined && heldKeys.has(e.key)) {
        heldKeys.delete(e.key);
        sceneRef.current?.setLivePhysicalPitch(pitch, false);
        playAlongEngineRef.current?.noteOff(pitch);
        e.preventDefault();
        return;
      }
      if (e.defaultPrevented || isUiControl(e.target)) return;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [viewMode]);

  useEffect(() => {
    let raf = 0;
    let lastUiUpdate = 0;
    const render = (now: number) => {
      const isPlayAlong = viewModeRef.current === "play_along";
      const transport = transportRef.current;
      const time = isPlayAlong ? playAlongTimeRef.current : (transport?.getCurrentTime() ?? settings.leadInSeconds);
      sceneRef.current?.update(time);

      const snapshot = window.__playerSnapshot;
      if (snapshot) {
        snapshot.motionStreaming = {
          buffering: bufferingPausedRef.current,
          pauseCount: motionPauseCountRef.current,
          requestCount: motionRequestCountRef.current,
          roundTripMs: motionRoundTripMsRef.current,
          lastPause: motionLastPauseRef.current,
        };
        if (!snapshot.scene || now - lastUiUpdate >= 70) {
          snapshot.scene = sceneRef.current?.getGeometrySnapshot();
          snapshot.editorSelectedNoteIds = [...(editorBridgeRef.current?.selectedNoteIds ?? [])];
          snapshot.editorViewTime = sceneRef.current?.getEditorViewTime() ?? null;
        }
      }
      if (now - lastUiUpdate >= 70) {
        lastUiUpdate = now;
        if (!isPlayAlong) {
          setCurrentTime(time);
        }
      }

      const buffer = motionBufferRef.current;
      const worker = workerRef.current;
      const identity = workerIdentityRef.current;
      const songEnd = analysis.document?.durationSeconds ?? 0;
      const playbackWindow = motionPlaybackWindow(time, songEnd, transport?.getSpeed() ?? 1, motionRoundTripMsRef.current);

      if (!isPlayAlong) {
        if (bufferingPausedRef.current && playIntentRef.current && buffer &&
            buffer.hasCoverage(playbackWindow.start, playbackWindow.resumeEnd)) {
          recordDiagnostic("motion.ready", { projectId: analysis.projectId, revision: analysis.revision,
            timeSeconds: time, resumeEnd: playbackWindow.resumeEnd });
          bufferingPausedRef.current = false;
          setIsBuffering(false);
          void transport?.play().catch(error => {
            playIntentRef.current = false;
            onStatusChangeRef.current({ kind: "error", message: `Playback failed: ${errorMessage(error)}` });
          });
        }

        // Check if playback needs to pause for buffering
        if (transport?.getState() === "playing" && buffer && time >= 0 && time < songEnd) {
          if (!buffer.hasCoverage(playbackWindow.start, playbackWindow.guardEnd)) {
            transport.pause();
            bufferingPausedRef.current = true;
            motionPauseCountRef.current += 1;
            motionLastPauseRef.current = { time, guardEnd: playbackWindow.guardEnd,
              left: buffer.getHandCoverageIntervals("left"), right: buffer.getHandCoverageIntervals("right"),
              inFlight: motionStreamRef.current?.inFlightRequest ?? null };
            recordDiagnostic("motion.buffering", { projectId: analysis.projectId, revision: analysis.revision,
              seekEpoch: seekEpochRef.current, ...motionLastPauseRef.current }, "warning");
            setIsBuffering(true);
            onStatusChangeRef.current({
              kind: "calculating",
              message: "Buffering animation poses...",
            });
          }
        }
      }

      // Continuously prefetch motion pose windows in both normal playback and Play Along mode
      if (worker && workerReadyRef.current && buffer && identity && !needsReplanRef.current &&
          !motionErrorRef.current && !motionStreamRef.current?.inFlightRequest && identity.projectId === analysis.projectId &&
          identity.revision === draftPlan.inputRevision && time < songEnd &&
          !buffer.hasCoverage(playbackWindow.start, playbackWindow.prefetchEnd)) {
        const missing = buffer.getMissingWindow(playbackWindow.start);
        const start = Math.max(0, missing.start);
        const end = Math.min(songEnd, missing.end, start + MOTION_REQUEST_SECONDS);
        if (end > start && motionStreamRef.current?.requestWindow(start, end, 200)) motionRequestCountRef.current += 1;
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [analysis, draftPlan, settings.leadInSeconds]);

  useEffect(() => {
    if (!debugGlobalsEnabled()) return;
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
      practiceState,
      currentTimeSeconds: currentTime,
    };
    return () => { delete window.__playerSnapshot; };
  }, [analysis, draftPlan, keyStyle, needsReplan, activeProfile, viewMode, editorBridge, sceneRevision, practiceState, currentTime]);

  const handleViewModeChange = useCallback((next: StudioView) => {
    const normalized = normalizeStudioView(next);
    if (poseEditActive && normalized !== "performance") {
      setPoseEditError("Cancel hand pose editing before leaving Performance view.");
      return;
    }
    recordDiagnostic("studio.mode", { projectId: analysis.projectId, view: normalized });
    // Header actions can change the workspace and dimension in the same event.
    // Keep the imperative scene in sync before React's effects run.
    viewModeRef.current = normalized;
    setViewMode(normalized);
    if (normalized === "editor") {
      sceneRef.current?.set3DMode(false);
    } else {
      sceneRef.current?.setFingeringEditor({
        active: false,
        playing: isPlaying,
        plan: editorBridge?.plan ?? draftPlan,
        selectedNoteIds: new Set<string>(),
      });
      sceneRef.current?.set3DMode(is3DViewRef.current);
    }
    onViewModeChange(normalized);
  }, [onViewModeChange, analysis.projectId, isPlaying, editorBridge, draftPlan, poseEditActive]);

  const togglePlay = useCallback(async () => {
    if (poseEditActive) {
      setPoseEditError("Cancel hand pose editing before starting playback.");
      return;
    }
    try {
      if (playIntentRef.current || isPlaying || bufferingPausedRef.current) {
        playIntentRef.current = false;
        bufferingPausedRef.current = false;
        setIsBuffering(false);
        transportRef.current?.pause();
      } else {
        if (preparingOutput) {
          onStatusChange({ kind: "calculating", message: "Preparing selected audio output…" });
          return;
        }
        if (motionErrorRef.current) throw new Error("Retry animation calculation in Diagnostics before playing.");
        playIntentRef.current = true;
        setPlaybackError(null);
        const transport = transportRef.current;
        const buffer = motionBufferRef.current;
        const window = motionPlaybackWindow(transport?.getCurrentTime() ?? 0,
          latestStateRef.current.analysis.document?.durationSeconds ?? 0, transport?.getSpeed() ?? 1, motionRoundTripMsRef.current);
        if (buffer && !buffer.hasCoverage(window.start, window.resumeEnd)) {
          bufferingPausedRef.current = true;
          setIsBuffering(true);
          onStatusChange({ kind: "calculating", message: "Preparing animation poses…" });
          return;
        }
        await transportRef.current?.play();
      }
    } catch (error) {
      playIntentRef.current = false;
      onStatusChange({ kind: "error", message: `Playback failed: ${errorMessage(error)}` });
    }
  }, [isPlaying, preparingOutput, onStatusChange, poseEditActive]);

  const previousLibraryOpenRef = useRef(false);
  useLayoutEffect(() => {
    const wasOpen = previousLibraryOpenRef.current;
    previousLibraryOpenRef.current = libraryOpen;
    if (libraryOpen && !wasOpen) {
      if (viewMode === "play_along") {
        const engine = playAlongEngineRef.current;
        playAlongLibrarySuspensionRef.current = {
          stepIndex: engine?.getCurrentStepIndex() ?? playAlongStepRef.current?.index ?? 0,
          state: engine?.getState() ?? playAlongStateRef.current,
        };
        engine?.stop();
        wrongPitchesRef.current.clear();
        sceneRef.current?.clearLivePhysicalPitches();
        sceneRef.current?.setPlayAlongState(null);
      }
    } else if (!libraryOpen && wasOpen) {
      if (viewMode === "play_along") {
        // The engine effect rebuilds while closing the library; its saved step
        // seek replaces the view-mode effect's usual first-step start.
        skipNextPlayAlongViewStartRef.current = true;
      } else {
        playAlongLibrarySuspensionRef.current = null;
        skipNextPlayAlongViewStartRef.current = false;
      }
    }
  }, [libraryOpen, viewMode]);

  const libraryResumeRef = useRef(false);
  const togglePlayForLibraryRef = useRef(togglePlay);
  useLayoutEffect(() => { togglePlayForLibraryRef.current = togglePlay; }, [togglePlay]);
  useEffect(() => {
    if (libraryOpen) {
      libraryResumeRef.current = playIntentRef.current || isPlaying || bufferingPausedRef.current;
      playIntentRef.current = false;
      bufferingPausedRef.current = false;
      // Reflect the external transport's suspension in its buffering indicator.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsBuffering(false);
      transportRef.current?.pause();
    } else if (libraryResumeRef.current) {
      libraryResumeRef.current = false;
      void togglePlayForLibraryRef.current();
    }
    // Only the library transition controls this effect; playback updates must
    // not overwrite the intent captured when the library opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryOpen]);

  const handleStop = useCallback(() => {
    if (poseEditActive) {
      setPoseEditError("Cancel hand pose editing before using Stop.");
      return;
    }
    playIntentRef.current = false;
    bufferingPausedRef.current = false;
    setIsBuffering(false);
    seekEpochRef.current += 1;
    transportRef.current?.stop();
    const buffer = createPlaybackMotionBuffer(analysis);
    motionBufferRef.current = buffer;
    sceneRef.current?.setMotionBuffer(buffer);
    refreshPoseEditTimepoints();
    motionStreamRef.current?.reset({ projectId: analysis.projectId, revision: analysis.revision, engineVersion: analysis.engineVersion }, seekEpochRef.current);
    setCurrentTime(transportRef.current?.getCurrentTime() ?? -Math.abs(settings.leadInSeconds));
  }, [analysis, settings.leadInSeconds, poseEditActive, refreshPoseEditTimepoints]);

  const handleSeek = useCallback((time: number) => {
    if (poseEditActive) {
      setPoseEditError("Use the sampled pose controls to change time while hand editing.");
      return;
    }
    const resumeWhenReady = bufferingPausedRef.current && playIntentRef.current;
    seekEpochRef.current += 1;
    bufferingPausedRef.current = resumeWhenReady;
    setIsBuffering(resumeWhenReady);
    transportRef.current?.seek(time);
    const buffer = createPlaybackMotionBuffer(analysis);
    motionBufferRef.current = buffer;
    sceneRef.current?.setMotionBuffer(buffer);
    refreshPoseEditTimepoints();
    motionStreamRef.current?.reset({ projectId: analysis.projectId, revision: analysis.revision, engineVersion: analysis.engineVersion }, seekEpochRef.current);
    setCurrentTime(transportRef.current?.getCurrentTime() ?? time);
    sceneRef.current?.update(time);
  }, [analysis, poseEditActive, refreshPoseEditTimepoints]);

  const refreshRiggedPosePresets = useCallback(async (hashes: RiggedHandPoseSourceHashes): Promise<boolean> => {
    setPoseEditPresetBusy(true);
    try {
      const presets = await listRiggedHandPosePresets(hashes);
      setPoseEditPresets(presets);
      const nextId = presets.some(preset => preset.presetId === poseEditPresetId)
        ? poseEditPresetId
        : presets[0]?.presetId ?? "";
      setPoseEditPresetId(nextId);
      setPoseEditRenamePresetName(presets.find(preset => preset.presetId === nextId)?.name ?? "");
      return true;
    } catch (error) {
      setPoseEditPresets([]);
      setPoseEditPresetId("");
      setPoseEditRenamePresetName("");
      setPoseEditError(`Saved pose presets could not be read: ${errorMessage(error)}`);
      return false;
    } finally {
      setPoseEditPresetBusy(false);
    }
  }, [poseEditPresetId]);

  const installRiggedPoseEditListeners = useCallback((scene: PianoScene) => {
    scene.setPoseEditSelectionListener((side, boneName) => {
      setPoseEditSide(side);
      setPoseEditBoneName(boneName);
      if (boneName !== null) setPoseEditTransformMode("rotate");
    });
    scene.setPoseEditChangeListener(() => {
      saveCurrentPoseEditDraft();
      setPoseEditUndoAvailable(scene.hasPoseEditUndo());
    });
  }, [saveCurrentPoseEditDraft]);

  const pauseTransportForPoseEdit = useCallback(() => {
    playIntentRef.current = false;
    bufferingPausedRef.current = false;
    setIsBuffering(false);
    transportRef.current?.pause();
    seekEpochRef.current += 1;
    motionStreamRef.current?.reset(
      { projectId: analysis.projectId, revision: analysis.revision, engineVersion: analysis.engineVersion },
      seekEpochRef.current,
    );
  }, [analysis.projectId, analysis.revision, analysis.engineVersion]);

  const seekToRiggedPoseTimepoint = useCallback((timepoint: RiggedPoseEditTimepoint) => {
    const transport = transportRef.current;
    if (!transport) throw new Error("The player transport is unavailable.");
    transport.seek(timepoint.displayedTransportTimeSeconds);
    const actualTime = transport.getCurrentTime();
    if (Math.abs(actualTime - timepoint.displayedTransportTimeSeconds) > 1e-4) {
      throw new Error(`Transport could not seek to the requested sampled time (${timepoint.displayedTransportTimeSeconds.toFixed(3)}s); it stopped at ${actualTime.toFixed(3)}s.`);
    }
    currentTimeRef.current = actualTime;
    setCurrentTime(actualTime);
    return actualTime;
  }, []);

  const handlePoseEditEnter = useCallback(async () => {
    const scene = sceneRef.current;
    if (!scene || !scene.is3DMode()) {
      setPoseEditError("The 3D piano scene is not active.");
      return;
    }
    if (settings.handModel !== RIGGED_EXPERIMENTAL_HAND_MODEL_ID) {
      setPoseEditError("Select Rigged hands as the hand model first.");
      return;
    }
    if (viewMode !== "performance" || needsReplan) {
      setPoseEditError("Finish the current calculation and switch to Performance view before editing a hand.");
      return;
    }
    const currentTransportTime = transportRef.current?.getCurrentTime() ?? currentTimeRef.current;
    setPoseEditBusy(true);
    setPoseEditError(null);
    setPoseEditStatus(null);
    pauseTransportForPoseEdit();
    try {
      await scene.waitForHandModelReady();
      const points = scene.getPoseEditTimepoints(-Math.abs(settings.leadInSeconds));
      const availability = scene.getPoseEditAvailabilityForTimepoints(points);
      const available = points
        .map((point, index) => ({ point, index, availability: availability[point.id] }))
        .filter(entry => entry.availability?.available);
      setPoseEditTimepoints(points);
      if (available.length === 0) throw new Error(points.length === 0
        ? "No sampled poses are available. The player needs a MotionPlan or a motion buffer."
        : "No sampled time is available for both loaded hands.");
      const selected = available.reduce((best, candidate) =>
        Math.abs(candidate.point.displayedTransportTimeSeconds - currentTransportTime) <
          Math.abs(best.point.displayedTransportTimeSeconds - currentTransportTime) ? candidate : best,
      available[0]!);
      const timepoint = selected.point;
      scene.setPoseEditTarget(poseEditSide, null);
      seekToRiggedPoseTimepoint(timepoint);
      scene.updatePoseEditAtTimepoint(timepoint);
      poseEditSessionRef.current = {
        timepointId: timepoint.id,
        positionIndex: selected.index,
        timepoint,
        totalPositions: points.length,
      };
      installRiggedPoseEditListeners(scene);
      await scene.setPoseEditMode(true);
      const hashes = scene.getPoseEditSourceHashes();
      const draft = poseEditDraftsRef.current.get(timepoint.id);
      if (draft && poseDraftMatchesSourceHashes(draft, hashes)) {
        scene.applyPoseEditPair(draft.hands);
        setPoseEditStatus("Restored the in-memory draft for this sampled time.");
      } else if (draft) {
        poseEditDraftsRef.current.delete(timepoint.id);
        setPoseEditDraftRevision(value => value + 1);
        setPoseEditStatus("A draft from a different GLB source was discarded and the animated sample was loaded.");
      }
      setPoseEditTimepointId(timepoint.id);
      setPoseEditUndoAvailable(scene.hasPoseEditUndo());
      setPoseEditActive(true);
      refreshPoseEditTimepoints();
      if (hasVerifiedPoseSourceHashes(hashes)) await refreshRiggedPosePresets(hashes);
    } catch (error) {
      if (scene.isPoseEditMode()) await scene.setPoseEditMode(false);
      scene.setPoseEditSelectionListener(undefined);
      scene.setPoseEditChangeListener(undefined);
      poseEditSessionRef.current = null;
      setPoseEditActive(false);
      setPoseEditError(errorMessage(error));
    } finally {
      setPoseEditBusy(false);
    }
  }, [settings.handModel, settings.leadInSeconds, viewMode, needsReplan, poseEditSide, pauseTransportForPoseEdit, seekToRiggedPoseTimepoint, installRiggedPoseEditListeners, refreshPoseEditTimepoints, refreshRiggedPosePresets]);

  const handlePoseEditSeek = useCallback(async (index: number) => {
    const scene = sceneRef.current;
    const timepoint = poseEditTimepoints[index];
    if (!scene || !poseEditActive || !timepoint) return;
    const availability = scene.getPoseEditAvailability(timepoint);
    if (!availability.available) {
      setPoseEditError(`That sampled time is unavailable: ${availability.reason ?? "sample-unavailable"}.`);
      return;
    }
    const previousSession = poseEditSessionRef.current;
    setPoseEditBusy(true);
    setPoseEditError(null);
    try {
      saveCurrentPoseEditDraft();
      pauseTransportForPoseEdit();
      await scene.setPoseEditMode(false);
      seekToRiggedPoseTimepoint(timepoint);
      scene.updatePoseEditAtTimepoint(timepoint);
      poseEditSessionRef.current = { timepointId: timepoint.id, positionIndex: index, timepoint, totalPositions: poseEditTimepoints.length };
      await scene.setPoseEditMode(true);
      const hashes = scene.getPoseEditSourceHashes();
      const draft = poseEditDraftsRef.current.get(timepoint.id);
      if (draft && poseDraftMatchesSourceHashes(draft, hashes)) {
        scene.applyPoseEditPair(draft.hands);
        setPoseEditStatus("Restored the in-memory draft for this sampled time.");
      } else if (draft) {
        poseEditDraftsRef.current.delete(timepoint.id);
        setPoseEditDraftRevision(value => value + 1);
        setPoseEditStatus("A draft from a different GLB source was discarded and the animated sample was loaded.");
      } else {
        setPoseEditStatus(null);
      }
      setPoseEditTimepointId(timepoint.id);
      setPoseEditUndoAvailable(scene.hasPoseEditUndo());
      refreshPoseEditTimepoints();
    } catch (error) {
      const seekError = errorMessage(error);
      if (previousSession) {
        try {
          await scene.setPoseEditMode(false);
          seekToRiggedPoseTimepoint(previousSession.timepoint);
          scene.updatePoseEditAtTimepoint(previousSession.timepoint);
          poseEditSessionRef.current = previousSession;
          await scene.setPoseEditMode(true);
          const hashes = scene.getPoseEditSourceHashes();
          const previousDraft = poseEditDraftsRef.current.get(previousSession.timepointId);
          if (previousDraft && poseDraftMatchesSourceHashes(previousDraft, hashes)) {
            scene.applyPoseEditPair(previousDraft.hands);
          }
          setPoseEditTimepointId(previousSession.timepointId);
          setPoseEditUndoAvailable(scene.hasPoseEditUndo());
          setPoseEditStatus("The requested sample could not be loaded. The previous sampled pose and its draft were restored.");
        } catch (restoreError) {
          await scene.setPoseEditMode(false).catch(() => undefined);
          poseEditSessionRef.current = null;
          setPoseEditActive(false);
          setPoseEditTimepointId(previousSession.timepointId);
          setPoseEditUndoAvailable(false);
          setPoseEditError(`${seekError} The previous edit session could not be restored: ${errorMessage(restoreError)}`);
        }
      } else {
        await scene.setPoseEditMode(false).catch(() => undefined);
        poseEditSessionRef.current = null;
        setPoseEditActive(false);
        setPoseEditError(seekError);
      }
    } finally {
      setPoseEditBusy(false);
    }
  }, [poseEditTimepoints, poseEditActive, saveCurrentPoseEditDraft, pauseTransportForPoseEdit, seekToRiggedPoseTimepoint, refreshPoseEditTimepoints]);

  const handlePoseEditSideChange = useCallback((side: RiggedPoseEditSide) => {
    const scene = sceneRef.current;
    if (!poseEditActive || !scene) return;
    try {
      scene.setPoseEditTarget(side, null);
      setPoseEditSide(side);
      setPoseEditBoneName(null);
      setPoseEditError(null);
    } catch (error) {
      setPoseEditError(errorMessage(error));
    }
  }, [poseEditActive]);

  const handlePoseEditSelectWholeHand = useCallback(() => {
    const scene = sceneRef.current;
    if (!poseEditActive || !scene) return;
    try {
      scene.setPoseEditTarget(poseEditSide, null);
      setPoseEditBoneName(null);
      setPoseEditError(null);
    } catch (error) {
      setPoseEditError(errorMessage(error));
    }
  }, [poseEditActive, poseEditSide]);

  const handlePoseEditFilterChange = useCallback((filter: RiggedPoseEditFingerFilter) => {
    sceneRef.current?.setPoseEditFingerFilter(filter);
    setPoseEditFingerFilter(filter);
  }, []);

  const handlePoseEditTransformModeChange = useCallback((mode: RiggedPoseEditTransformMode) => {
    sceneRef.current?.setPoseEditTransformMode(mode);
    setPoseEditTransformMode(mode);
  }, []);

  const handlePoseEditUndo = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene?.undoPoseEdit()) return;
    saveCurrentPoseEditDraft();
    setPoseEditUndoAvailable(scene.hasPoseEditUndo());
  }, [saveCurrentPoseEditDraft]);

  const handlePoseEditReset = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene || !poseEditActive) return;
    try {
      scene.resetPoseEditHand(poseEditSide);
      saveCurrentPoseEditDraft();
      setPoseEditUndoAvailable(scene.hasPoseEditUndo());
      setPoseEditError(null);
      setPoseEditStatus(`Reset the ${poseEditSide} hand to its animated sample at this time.`);
    } catch (error) {
      setPoseEditError(errorMessage(error));
    }
  }, [poseEditActive, poseEditSide, saveCurrentPoseEditDraft]);

  const handlePoseEditCancel = useCallback(async () => {
    const scene = sceneRef.current;
    setPoseEditBusy(true);
    pauseTransportForPoseEdit();
    try {
      if (scene) {
        await scene.setPoseEditMode(false);
        scene.setPoseEditSelectionListener(undefined);
        scene.setPoseEditChangeListener(undefined);
      }
      poseEditDraftsRef.current.clear();
      poseEditSessionRef.current = null;
      setPoseEditDraftRevision(value => value + 1);
      setPoseEditActive(false);
      setPoseEditUndoAvailable(false);
      setPoseEditStatus("Canceled. Unsaved hand pose drafts were discarded; the animated sample is restored.");
      setPoseEditError(null);
    } catch (error) {
      setPoseEditError(errorMessage(error));
    } finally {
      setPoseEditBusy(false);
    }
  }, [pauseTransportForPoseEdit]);

  const handlePoseEditPresetSave = useCallback(async () => {
    const scene = sceneRef.current;
    const timepoint = scene?.getPoseEditTimepoint();
    const session = poseEditSessionRef.current;
    if (!scene || !poseEditActive || !timepoint || !session) return;
    const availability = scene.getPoseEditAvailability(timepoint);
    if (!availability.available) {
      setPoseEditError(`This pose cannot be saved because it is unavailable: ${availability.reason ?? "sample-unavailable"}.`);
      return;
    }
    const hashes = scene.getPoseEditSourceHashes();
    if (!hasVerifiedPoseSourceHashes(hashes)) {
      setPoseEditError("Both loaded hand GLB files must provide verified SHA-256 values before saving.");
      return;
    }
    const name = poseEditPresetName.trim();
    if (!name) {
      setPoseEditError("Enter a name for the new pose preset.");
      return;
    }
    setPoseEditPresetBusy(true);
    setPoseEditError(null);
    try {
      const draft = createPoseEditDraft(scene, timepoint, session.positionIndex, session.totalPositions);
      const preset = createRiggedHandPosePreset({
        presetId: crypto.randomUUID(),
        name,
        createdAtUnixMs: Date.now(),
        sourceGlbSha256: hashes,
        hands: draft.hands,
        editorProvenance: draft.editorProvenance,
      });
      await saveRiggedHandPosePreset(preset);
      setPoseEditPresetName("");
      setPoseEditStatus(`Saved “${preset.name}” as a separate pose preset for the verified hand GLBs.`);
      await refreshRiggedPosePresets(hashes);
    } catch (error) {
      setPoseEditError(`Pose preset was not saved: ${errorMessage(error)}`);
    } finally {
      setPoseEditPresetBusy(false);
    }
  }, [poseEditActive, poseEditPresetName, refreshRiggedPosePresets]);

  const handlePoseEditPresetApply = useCallback(async () => {
    const scene = sceneRef.current;
    if (!scene || !poseEditActive || !poseEditPresetId) return;
    const hashes = scene.getPoseEditSourceHashes();
    if (!hasVerifiedPoseSourceHashes(hashes)) {
      setPoseEditError("Both loaded hand GLB files must provide verified SHA-256 values before applying a preset.");
      return;
    }
    setPoseEditPresetBusy(true);
    setPoseEditError(null);
    try {
      const preset = await loadRiggedHandPosePreset(poseEditPresetId, hashes);
      if (!preset) throw new Error("The selected pose preset was not found.");
      scene.applyPoseEditPair({ left: preset.hands.left, right: preset.hands.right });
      saveCurrentPoseEditDraft();
      setPoseEditUndoAvailable(scene.hasPoseEditUndo());
      setPoseEditStatus(`Applied “${preset.name}” to the current sampled pose.`);
    } catch (error) {
      setPoseEditError(`Pose preset could not be applied: ${errorMessage(error)}`);
    } finally {
      setPoseEditPresetBusy(false);
    }
  }, [poseEditActive, poseEditPresetId, saveCurrentPoseEditDraft]);

  const handlePoseEditPresetExport = useCallback(async () => {
    const scene = sceneRef.current;
    if (!scene || !poseEditActive || !poseEditPresetId) return;
    if (!poseEditPresets.some(preset => preset.presetId === poseEditPresetId)) {
      setPoseEditError("The selected saved pose preset is no longer available.");
      return;
    }
    const hashes = scene.getPoseEditSourceHashes();
    if (!hasVerifiedPoseSourceHashes(hashes)) {
      setPoseEditError("Both loaded hand GLB files must provide verified SHA-256 values before exporting.");
      return;
    }
    setPoseEditPresetBusy(true);
    setPoseEditError(null);
    setPoseEditStatus("Preparing the selected pose preset JSON…");
    try {
      const preset = await loadRiggedHandPosePreset(poseEditPresetId, hashes);
      if (!preset) throw new Error("The selected pose preset was not found.");
      const json = exportRiggedHandPosePresetJson(preset);
      const sanitizedName = Array.from(preset.name, character => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || /[\\/:*?"<>|]/.test(character) ? "_" : character;
      }).join("")
        .replace(/[. ]+$/g, "")
        .slice(0, 100) || "rigged-hand-pose";
      const safeName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:$|\.)/i.test(sanitizedName)
        ? `_${sanitizedName}`
        : sanitizedName;
      downloadFile(`${safeName}.rigged-hand-pose.json`, json, "application/json");
      setPoseEditStatus(`Downloaded “${preset.name}” as a JSON pose preset.`);
    } catch (error) {
      setPoseEditStatus(null);
      setPoseEditError(`Pose preset could not be exported: ${errorMessage(error)}`);
    } finally {
      setPoseEditPresetBusy(false);
    }
  }, [poseEditActive, poseEditPresetId, poseEditPresets]);

  const handlePoseEditPresetReplace = useCallback(async () => {
    const scene = sceneRef.current;
    const session = poseEditSessionRef.current;
    const selected = poseEditPresets.find(preset => preset.presetId === poseEditPresetId);
    if (!scene || !poseEditActive || !selected || !session || poseEditPresetBusy) return;
    if (session.timepointId !== poseEditTimepointId) {
      setPoseEditError("The selected pose session changed. Re-select the saved preset and try again.");
      return;
    }
    const timepoint = scene.getPoseEditTimepoint();
    if (!timepoint || timepoint.id !== session.timepointId) {
      setPoseEditError("The current sampled pose is no longer available for updating this preset.");
      return;
    }
    const availability = scene.getPoseEditAvailability(timepoint);
    if (!availability.available) {
      setPoseEditError(`The current pose cannot update this preset because it is unavailable: ${availability.reason ?? "sample-unavailable"}.`);
      return;
    }
    const hashes = scene.getPoseEditSourceHashes();
    if (!hasVerifiedPoseSourceHashes(hashes)) {
      setPoseEditError("Both loaded hand GLB files must provide verified SHA-256 values before updating a preset.");
      return;
    }
    setPoseEditPresetBusy(true);
    setPoseEditError(null);
    setPoseEditStatus(`Updating “${selected.name}” (ID: ${selected.presetId}) from the current pose…`);
    try {
      const saved = await loadRiggedHandPosePreset(selected.presetId, hashes);
      if (!saved) throw new Error("The selected pose preset was not found.");
      if (saved.name !== selected.name || saved.createdAtUnixMs !== selected.createdAtUnixMs) {
        throw new Error("The selected saved preset changed in another tab. Refresh the editor and confirm the updated record before replacing it.");
      }
      const latestSession = poseEditSessionRef.current;
      const latestTimepoint = scene.getPoseEditTimepoint();
      const latestHashes = scene.getPoseEditSourceHashes();
      if (sceneRef.current !== scene || !poseEditActive || latestSession?.timepointId !== session.timepointId ||
        latestTimepoint?.id !== timepoint.id || latestHashes.left !== hashes.left || latestHashes.right !== hashes.right) {
        throw new Error("The active pose or hand GLBs changed while the preset was being prepared. No preset was replaced.");
      }
      const draft = createPoseEditDraft(scene, timepoint, session.positionIndex, session.totalPositions);
      const updated = await replaceRiggedHandPosePreset(selected.presetId, {
        ...saved,
        sourceGlbSha256: hashes,
        hands: draft.hands,
        editorProvenance: draft.editorProvenance,
      });
      const refreshed = await refreshRiggedPosePresets(hashes);
      setPoseEditStatus(refreshed
        ? `Updated “${updated.name}” (ID: ${updated.presetId}) from the current pose. Its name and ID were preserved.`
        : `Updated “${updated.name}” (ID: ${updated.presetId}); the preset list could not be refreshed.`);
    } catch (error) {
      setPoseEditStatus(null);
      setPoseEditError(`Selected preset could not be updated: ${errorMessage(error)}`);
    } finally {
      setPoseEditPresetBusy(false);
    }
  }, [poseEditActive, poseEditPresetBusy, poseEditPresetId, poseEditPresets, poseEditTimepointId, refreshRiggedPosePresets]);

  const handlePoseEditPresetRename = useCallback(async () => {
    const scene = sceneRef.current;
    const selected = poseEditPresets.find(preset => preset.presetId === poseEditPresetId);
    if (!scene || !poseEditActive || !selected || poseEditPresetBusy) return;
    const requestedName = poseEditRenamePresetName.trim();
    if (!requestedName) {
      setPoseEditError("Enter a non-empty name for the selected preset.");
      return;
    }
    if (requestedName === selected.name) {
      setPoseEditStatus(`“${selected.name}” (ID: ${selected.presetId}) already has this name.`);
      setPoseEditError(null);
      setPoseEditRenamePresetName(selected.name);
      return;
    }
    const hashes = scene.getPoseEditSourceHashes();
    if (!hasVerifiedPoseSourceHashes(hashes)) {
      setPoseEditError("Both loaded hand GLB files must provide verified SHA-256 values before renaming a preset.");
      return;
    }
    setPoseEditPresetBusy(true);
    setPoseEditError(null);
    setPoseEditStatus(`Renaming “${selected.name}” (ID: ${selected.presetId})…`);
    try {
      const saved = await loadRiggedHandPosePreset(selected.presetId, hashes);
      if (!saved) throw new Error("The selected pose preset was not found.");
      if (saved.name !== selected.name || saved.createdAtUnixMs !== selected.createdAtUnixMs) {
        throw new Error("The selected saved preset changed in another tab. Refresh the editor and retry the rename.");
      }
      const renamed = await replaceRiggedHandPosePreset(selected.presetId, {
        ...saved,
        name: requestedName,
      });
      const refreshed = await refreshRiggedPosePresets(hashes);
      setPoseEditRenamePresetName(renamed.name);
      setPoseEditStatus(refreshed
        ? `Renamed preset ID ${renamed.presetId} to “${renamed.name}”. Its saved pose and creation time were preserved.`
        : `Renamed preset ID ${renamed.presetId} to “${renamed.name}”; the preset list could not be refreshed.`);
    } catch (error) {
      setPoseEditStatus(null);
      if (error instanceof RiggedHandPosePresetError && error.code === "preset-name-conflict") {
        setPoseEditError(`A saved preset already uses that normalized name. Choose a different name; no preset was changed. ${error.message}`);
      } else {
        setPoseEditError(`Selected preset could not be renamed: ${errorMessage(error)}`);
      }
    } finally {
      setPoseEditPresetBusy(false);
    }
  }, [poseEditActive, poseEditPresetBusy, poseEditPresetId, poseEditPresets, poseEditRenamePresetName, refreshRiggedPosePresets]);

  const handlePoseEditPresetDelete = useCallback(async () => {
    const scene = sceneRef.current;
    const selected = poseEditPresets.find(preset => preset.presetId === poseEditPresetId);
    if (!scene || !poseEditActive || !selected || poseEditPresetBusy) return;
    const hashes = scene.getPoseEditSourceHashes();
    if (!hasVerifiedPoseSourceHashes(hashes)) {
      setPoseEditError("Both loaded hand GLB files must provide verified SHA-256 values before deleting a preset.");
      return;
    }
    setPoseEditPresetBusy(true);
    setPoseEditError(null);
    setPoseEditStatus(`Deleting “${selected.name}” (ID: ${selected.presetId})…`);
    try {
      const saved = await loadRiggedHandPosePreset(selected.presetId, hashes);
      if (!saved) throw new Error("The selected pose preset was not found.");
      if (saved.name !== selected.name || saved.createdAtUnixMs !== selected.createdAtUnixMs) {
        throw new Error("The selected saved preset changed in another tab. Refresh the editor and confirm the updated record before deleting it.");
      }
      await deleteRiggedHandPosePreset(selected.presetId);
      const refreshed = await refreshRiggedPosePresets(hashes);
      setPoseEditStatus(refreshed
        ? `Deleted “${saved.name}” (ID: ${saved.presetId}). Other presets were left unchanged.`
        : `Deleted “${saved.name}” (ID: ${saved.presetId}); the preset list could not be refreshed.`);
    } catch (error) {
      setPoseEditStatus(null);
      setPoseEditError(`Selected preset could not be deleted: ${errorMessage(error)}`);
    } finally {
      setPoseEditPresetBusy(false);
    }
  }, [poseEditActive, poseEditPresetBusy, poseEditPresetId, poseEditPresets, refreshRiggedPosePresets]);

  const handlePoseEditPresetImportFile = useCallback(async (file: File) => {
    if (!poseEditActive || poseEditPresetBusy || poseEditBusy || needsReplan) return;
    const scene = sceneRef.current;
    if (!scene) {
      setPoseEditError("The 3D piano scene is not active for importing a hand pose preset.");
      return;
    }
    const hashes = scene.getPoseEditSourceHashes();
    if (!hasVerifiedPoseSourceHashes(hashes)) {
      setPoseEditError("Both loaded hand GLB files must provide verified SHA-256 values before importing.");
      return;
    }
    if (file.size > RIGGED_HAND_POSE_PRESET_MAX_JSON_LENGTH * 4) {
      setPoseEditError(`The selected JSON file exceeds the preset import size limit (${RIGGED_HAND_POSE_PRESET_MAX_JSON_LENGTH} characters).`);
      return;
    }
    setPoseEditPresetBusy(true);
    setPoseEditError(null);
    setPoseEditStatus(`Importing “${file.name || "pose preset JSON"}”…`);
    let importedPreset: RiggedHandPosePreset | null = null;
    try {
      const json = await file.text();
      importedPreset = importRiggedHandPosePresetJson(json, hashes);
      const existingPresets = await listRiggedHandPosePresets(hashes);
      const idConflict = existingPresets.some(preset => preset.presetId === importedPreset!.presetId);
      const normalizedName = importedPreset.name.normalize("NFC").trim().toLowerCase();
      const nameConflict = existingPresets.some(preset => preset.name.normalize("NFC").trim().toLowerCase() === normalizedName);
      if (idConflict || nameConflict) {
        const conflicts = [
          idConflict ? `ID “${importedPreset.presetId}”` : null,
          nameConflict ? `normalized name “${importedPreset.name}”` : null,
        ].filter((value): value is string => value !== null);
        throw new Error(`Import conflicts with an existing saved preset: ${conflicts.join(" and ")}. Change the conflicting ID and/or name in the JSON and try again. No presets were overwritten.`);
      }
      const saved = await saveRiggedHandPosePreset(importedPreset);
      const refreshed = await refreshRiggedPosePresets(hashes);
      if (refreshed) {
        setPoseEditPresetId(saved.presetId);
        setPoseEditRenamePresetName(saved.name);
        setPoseEditStatus(`Imported “${saved.name}” (ID: ${saved.presetId}) as a new saved preset.`);
      } else {
        setPoseEditStatus(`Imported “${saved.name}” (ID: ${saved.presetId}), but the preset list could not be refreshed.`);
      }
    } catch (error) {
      setPoseEditStatus(null);
      if (error instanceof RiggedHandPosePresetError && error.code === "preset-id-conflict") {
        setPoseEditError(`Preset ID “${importedPreset?.presetId ?? "from this file"}” already exists. Change the presetId in the JSON and import again; existing presets were not overwritten.`);
      } else if (error instanceof RiggedHandPosePresetError && error.code === "preset-name-conflict") {
        setPoseEditError(`A saved preset already uses the normalized name “${importedPreset?.name ?? "from this file"}”. Rename it in the JSON and import again; existing presets were not overwritten.`);
      } else {
        setPoseEditError(`Pose preset JSON could not be imported: ${errorMessage(error)}`);
      }
    } finally {
      setPoseEditPresetBusy(false);
    }
  }, [poseEditActive, poseEditBusy, poseEditPresetBusy, needsReplan, refreshRiggedPosePresets]);

  const handlePoseEditPresetChange = useCallback((presetId: string) => {
    setPoseEditPresetId(presetId);
    setPoseEditRenamePresetName(poseEditPresets.find(preset => preset.presetId === presetId)?.name ?? "");
    setPoseEditError(null);
  }, [poseEditPresets]);

  const handleJumpToBookmark = useCallback((id: string) => {
    const bookmark = practiceStateRef.current.bookmarks.find((candidate) => candidate.id === id);
    if (!bookmark) return;
    const currentLoop = practiceStateRef.current.loop;
    const outsideLoop = currentLoop?.enabled &&
      (bookmark.timeSeconds < currentLoop.startSeconds || bookmark.timeSeconds >= currentLoop.endSeconds);
    const jump = () => {
      if (viewModeRef.current === "play_along") {
        const engine = playAlongEngineRef.current;
        const eligible = engine?.getSteps()
          .map((step, index) => ({ step, index }))
          .filter(({ step }) => {
            const loop = practiceStateRef.current.loop;
            return !loop?.enabled || (step.timeSeconds >= loop.startSeconds && step.timeSeconds < loop.endSeconds);
          }) ?? [];
        if (eligible.length > 0) {
          const nearest = eligible.reduce((best, candidate) =>
            Math.abs(candidate.step.timeSeconds - bookmark.timeSeconds) < Math.abs(best.step.timeSeconds - bookmark.timeSeconds)
              ? candidate
              : best,
          eligible[0]!);
          engine?.seekToStep(nearest.index);
        } else {
          engine?.seekToStep(0);
        }
      } else {
        handleSeek(bookmark.timeSeconds);
      }
    };
    if (!outsideLoop) {
      jump();
      return;
    }

    const next = { ...practiceStateRef.current, loop: { ...currentLoop, enabled: false } };
    updatePracticeState(next);
    transportRef.current?.setLoop(null);
    playAlongEngineRef.current?.setLoopRange(null);
    setPlayAlongLoopAvailable(true);
    void persistPracticeRecovery(next).catch((error) => {
      onStatusChange({ kind: "error", message: `${dict.practice.title}: ${errorMessage(error)}` });
    }).finally(jump);
  }, [dict.practice.title, handleSeek, onStatusChange, persistPracticeRecovery, updatePracticeState]);

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
      practiceState,
    };
  }, [document, analysis, rawMidiBytes, projectName, draftPlan, activeProfile, sourceContext, practiceState]);

  const saveToDatabase = useCallback(async (): Promise<SaveResult> => {
    const identity = { projectId: analysis.projectId, revision: draftPlan.inputRevision, changeToken: editVersionRef.current };
    if (needsReplanRef.current || !rawMidiBytes) {
      return { status: "blocked", reason: "Wait for the current calculation before saving the project.", identity };
    }
    let projectCommitted = false;
    const saveEpoch = onBeginProjectSave?.(analysis.projectId) ?? 0;
    onStatusChange({ kind: "saving", message: dict.header.file === "File" ? "Saving project to this browser…" : "Ukládání projektu do prohlížeče…" });
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
      const current = latestStateRef.current;
      if (!current.document || !current.rawMidiBytes) {
        throw new Error("Current recovery data is not ready to save.");
      }
      autosaveService.schedule(buildRecoverySnapshot({
        projectName: current.projectName,
        updatedAt: Date.now(),
        document: current.document,
        draftFingeringPlan: current.draftPlan,
        result: current.analysis,
        rawMidiBytes: current.rawMidiBytes,
        profile: current.profile,
        plansState: "valid",
        keyStyle: current.keyStyle,
        sourceContext: current.sourceContext,
        viewMode: current.viewMode,
        sceneView: current.sceneView,
        practiceState: current.practiceState,
      }));
      await autosaveService.flush({ throwOnError: true });
      if (editVersionRef.current !== identity.changeToken || needsReplanRef.current) {
        const reason = "New changes were made while saving. Save the latest revision before continuing.";
        onStatusChange({ kind: "modified", message: reason });
        return { status: "blocked", reason, identity };
      }
      dirtyRef.current = false;
      onDirtyChange(false);
      onProjectSaved?.(project.projectId, saveEpoch);
      onStatusChange({ kind: "saved", message: dict.header.file === "File" ? "Project saved to this browser." : "Projekt byl uložen do prohlížeče." });
      return { status: "committed", identity };
    } catch (error) {
      const reason = `${projectCommitted ? "Project saved, but recovery was not committed" : "Project was not saved"}: ${errorMessage(error)}`;
      onStatusChange({ kind: "error", message: reason });
      return { status: "failed", reason, identity };
    }
  }, [rawMidiBytes, savedProject, onDirtyChange, onProjectSaved, onBeginProjectSave, onStatusChange, analysis, draftPlan,
    autosaveService, dict]);

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

  // A project/document change or unmount makes an in-flight export stale; its
  // result must not download or overwrite the current status.
  useEffect(() => () => {
    exportScopeRef.current.cancel();
  }, [analysis.projectId, analysis.revision, document?.revision, draftPlan.planId]);

  const handleExportPackage = useCallback(async () => {
    if (needsReplan || !rawMidiBytes) return;
    try {
      const committed = await runScopedExport(exportScopeRef.current, async () => {
        const json = await exportProjectPackageJson(savedProject(), {
          profiles: [activeProfile],
          resources: [analysis.resource],
          sourceContext,
          filename: `${projectName.replace(/\.mid(i)?$/i, "")}.pianomotion.json`,
        });
        const safeName = `${projectName.replace(/\.mid(i)?$/i, "")}.pianomotion.json`.replace(/[\\/:*?"<>|]/g, "_");
        return { json, safeName };
      }, ({ json, safeName }) => downloadFile(safeName, json, "application/json"));
      if (!committed) return;
      onStatusChange({ kind: dirtyRef.current ? "modified" : "saved", message: dict.header.file === "File" ? "Project package exported." : "Balíček projektu byl exportován." });
    } catch (error) {
      onStatusChange({ kind: "error", message: `Project package export failed: ${errorMessage(error)}` });
    }
  }, [needsReplan, rawMidiBytes, savedProject, activeProfile, analysis.resource, sourceContext, projectName, onStatusChange, dict]);

  const handleExportMidi = useCallback(async () => {
    if (needsReplan || !rawMidiBytes || !document || !workerReadyRef.current) return;
    const worker = workerRef.current;
    if (!worker) return;
    const scope = exportScopeRef.current;
    const { controller, isCurrent } = scope.begin();
    onStatusChange({ kind: "loading", message: dict.header.file === "File" ? "Exporting fingered MIDI…" : "Exportování MIDI s prstokladem…" });
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
        controller.signal,
        undefined,
        { worker, terminateOnComplete: false },
      );
      if (!isCurrent()) return;
      const blob = new Blob([response.exportedBytes], { type: "audio/midi" });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = `${projectName.replace(/\.mid(i)?$/i, "")}.fingered.mid`;
      anchor.click();
      URL.revokeObjectURL(url);
      onStatusChange(fingeredMidiExportStatus(response.markedCount, response.diagnostics, dirtyRef.current));
    } catch (error) {
      if (!isCurrent()) return;
      onStatusChange({ kind: "error", message: `Fingered MIDI export failed: ${errorMessage(error)}` });
    } finally {
      scope.finish(controller);
    }
  }, [needsReplan, rawMidiBytes, document, analysis.projectId, engineVersion, draftPlan, projectName, onStatusChange, dict]);

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

  const poseEditorPanelProps = useMemo<RiggedPoseEditorPanelProps>(() => ({
    active: poseEditActive,
    canEnter: poseEditCanEnter,
    is3DMode: poseEdit3DActive,
    modelMatches: poseEditModelMatches,
    entryMessage: poseEditEntryMessage,
    busy: poseEditBusy || poseEditPresetBusy || needsReplan,
    timepoints: poseEditTimepoints,
    availabilityById: poseEditAvailabilityById,
    selectedTimepointId: poseEditTimepointId,
    selectedSide: poseEditSide,
    selectedBoneName: poseEditBoneName,
    fingerFilter: poseEditFingerFilter,
    transformMode: poseEditTransformMode,
    undoAvailable: poseEditUndoAvailable,
    draftCount: poseEditDraftsRef.current.size,
    sampleSources: poseEditSampleSources,
    sourceHashesVerified: poseEditSourceHashesVerified,
    presets: poseEditPresets,
    selectedPresetId: poseEditPresetId,
    presetName: poseEditPresetName,
    renamePresetName: poseEditRenamePresetName,
    status: poseEditStatus,
    error: poseEditError,
    onEnter: () => { void handlePoseEditEnter(); },
    onCancel: () => { void handlePoseEditCancel(); },
    onSeek: index => { void handlePoseEditSeek(index); },
    onSideChange: handlePoseEditSideChange,
    onSelectWholeHand: handlePoseEditSelectWholeHand,
    onFingerFilterChange: handlePoseEditFilterChange,
    onTransformModeChange: handlePoseEditTransformModeChange,
    onUndo: handlePoseEditUndo,
    onReset: handlePoseEditReset,
    onPresetNameChange: setPoseEditPresetName,
    onPresetChange: handlePoseEditPresetChange,
    onRenamePresetNameChange: setPoseEditRenamePresetName,
    onSavePreset: () => { void handlePoseEditPresetSave(); },
    onApplyPreset: () => { void handlePoseEditPresetApply(); },
    onExportPreset: () => { void handlePoseEditPresetExport(); },
    onImportPresetFile: handlePoseEditPresetImportFile,
    onRenamePreset: () => { void handlePoseEditPresetRename(); },
    onReplacePreset: () => { void handlePoseEditPresetReplace(); },
    onDeletePreset: () => { void handlePoseEditPresetDelete(); },
  }), [poseEditActive, poseEditCanEnter, poseEdit3DActive, poseEditModelMatches, poseEditEntryMessage, poseEditBusy, poseEditPresetBusy, needsReplan,
    poseEditTimepoints, poseEditAvailabilityById, poseEditTimepointId, poseEditSide, poseEditBoneName, poseEditFingerFilter,
    poseEditTransformMode, poseEditUndoAvailable, poseEditDraftRevision, poseEditSampleSources, poseEditSourceHashesVerified,
    poseEditPresets, poseEditPresetId, poseEditPresetName, poseEditRenamePresetName, poseEditStatus, poseEditError, handlePoseEditEnter, handlePoseEditCancel,
    handlePoseEditSeek, handlePoseEditSideChange, handlePoseEditFilterChange, handlePoseEditTransformModeChange, handlePoseEditUndo,
    handlePoseEditSelectWholeHand, handlePoseEditPresetChange,
    handlePoseEditReset, handlePoseEditPresetSave, handlePoseEditPresetApply, handlePoseEditPresetExport, handlePoseEditPresetImportFile,
    handlePoseEditPresetRename, handlePoseEditPresetReplace, handlePoseEditPresetDelete]);

  const inspector = useCallback((tab: InspectorTab) => (
    <StudioInspector
      tab={tab}
      result={analysis}
      profile={activeProfile}
      settings={settings}
      keyStyle={keyStyle}
      audioRecording={audioRecording}
      audioOffset={audioOffset}
      poseEditor={poseEditModelMatches ? poseEditorPanelProps : undefined}
      audioOutputLabel={playbackError ? `Playback unavailable: ${playbackError}` : `${preparingSamples ? "Preparing SoundFont samples; currently active: " : preparingOutput ? "Preparing selected output; currently active: " : "Active output: "}${activeOutputId === "synth" ? "Built-in synthesizer" : activeOutputId === "soundfont" ? (activeSoundfontAssetId === BUILTIN_SOUNDFONT_ID ? BUILTIN_SOUNDFONT_NAME : "Local SoundFont") : "External MIDI device"}`}
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
      onStageAppearanceChange={handleStageAppearanceChange}
      onCalculationEngineChange={(engine: CalculationEngine) => {
        void updateSettingsPersisted({ calculationEngine: engine }).catch(error => {
          onStatusChange({ kind: "error", message: `Calculation engine preference was not saved: ${errorMessage(error)}` });
        });
      }}
      activeCalculationEngine={activeCalculationEngine}
      onOpenPianist={onOpenPianist}
      onAudioFileChange={event => void handleAudioFileChange(event)}
      onClearAudio={handleClearAudio}
      onAudioOffsetChange={handleAudioOffsetChange}
    />
  ), [analysis, activeProfile, settings, keyStyle, audioRecording, audioOffset, poseEditModelMatches, poseEditorPanelProps, projectName, needsReplan, developerTools,
    editorReport, handleDiagnosticNote, handleKeyStyleChange, onOpenPianist, handleAudioFileChange, handleClearAudio,
    handleAudioOffsetChange, handleRetryCalculation, handleStageAppearanceChange, onStatusChange, status, preparingOutput, preparingSamples, activeOutputId, activeSoundfontAssetId, activeCalculationEngine, playbackError]);

  const editorState = <FingeringEditor
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
  const editActions = editorBridge ? {
    canUndo: editorBridge.canUndo,
    canRedo: editorBridge.canRedo,
    undo: editorBridge.undo,
    redo: editorBridge.redo,
  } : undefined;
  const handleToggle3DView = useCallback((enabled: boolean) => {
    if (poseEditActive && !enabled) {
      setPoseEditError("Cancel hand pose editing before switching to the 2D piano view.");
      return;
    }
    try {
      if (enabled && viewModeRef.current === "editor") {
        viewModeRef.current = "performance";
        setViewMode("performance");
        onViewModeChange("performance");
        sceneRef.current?.setFingeringEditor({
          active: false,
          playing: isPlaying,
          plan: editorBridge?.plan ?? draftPlan,
          selectedNoteIds: new Set<string>(),
        });
      }
      is3DViewRef.current = enabled;
      setIs3DView(enabled);
      sceneRef.current?.set3DMode(enabled && viewModeRef.current !== "editor");
    } catch (error) {
      is3DViewRef.current = false;
      setIs3DView(false);
      onStatusChange({ kind: "error", message: `3D is unavailable; the 2D workspace remains active. ${errorMessage(error)}` });
    }
  }, [isPlaying, editorBridge, draftPlan, onViewModeChange, onStatusChange, poseEditActive]);

  const handleCamera3DPresetChange = useCallback((preset: Camera3DPreset) => {
    camera3DPresetRef.current = preset;
    setCamera3DPreset(preset);
    sceneRef.current?.setCamera3DPreset(preset);
  }, []);

  const scene = <div id="piano-canvas-container" ref={containerRef} className="piano-canvas-container" data-testid="piano-canvas" />;
  const workspace = ({ effectiveView }: { effectiveView: StudioView; focusMode: boolean }) => (
    <StudioWorkspace
      viewMode={effectiveView}
      scene={scene}
      editorState={editorState}
      editorViewTime={editorViewTime}
      transportTime={currentTime}
      onReturnToPlayhead={handleReturnToPlayhead}
      is3DView={is3DView}
      onToggle3DView={handleToggle3DView}
      camera3DPreset={camera3DPreset}
      onCamera3DPresetChange={handleCamera3DPresetChange}
      showCameraHud={false}
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

  const transport = viewMode === "play_along" ? (
    <PlayAlongTransport
      currentStepIndex={playAlongStep?.index ?? 0}
      totalSteps={playAlongTotalSteps}
      step={playAlongStep}
      state={playAlongState}
      handMode={playAlongHandMode}
      heldUserPitches={playAlongHeldPitches}
      completedPitchesInStep={playAlongCompletedPitches}
      onHandModeChange={(mode) => setPlayAlongHandMode(mode)}
      onPreviousStep={() => { if (!libraryOpenRef.current) playAlongEngineRef.current?.previousStep(); }}
      onNextStep={() => { if (!libraryOpenRef.current) playAlongEngineRef.current?.nextStep(); }}
      onRestart={() => { if (!libraryOpenRef.current) playAlongEngineRef.current?.seekToStep(0); }}
      midiConnected={midiInputStatus?.permission === "granted" && (midiInputStatus.devices.length > 0)}
      midiDeviceName={midiInputStatus?.devices.find(d => d.state === "connected")?.name ?? midiInputStatus?.devices[0]?.name}
      midiPermission={midiInputStatus?.permission}
      onConnectMidi={() => { void getSharedWebMidiInputManager().requestPermissionFromUserGesture(); }}
      autoPlayOtherHand={autoPlayOtherHand}
      onAutoPlayOtherHandChange={setAutoPlayOtherHand}
    />
  ) : (
    <StudioTransport
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
      disabled={transportBlocker === "reading" || transportBlocker === "analysis" || poseEditActive}
      playDisabled={transportBlocker === "audio" || poseEditActive}
    />
  );

  const practiceLoop = practiceState.loop;
  const loopHasPlayAlongStep = practiceLoop
    ? playAlongStepTimes.some((time) => time >= practiceLoop.startSeconds && time < practiceLoop.endSeconds)
    : playAlongLoopAvailable;
  const practicePanel = <PracticePanel
    currentTimeSeconds={currentTime}
    durationSeconds={document?.durationSeconds ?? 0}
    loop={practiceState.loop}
    bookmarks={practiceState.bookmarks}
    disabled={busy || needsReplan}
    loopAvailable={viewMode !== "play_along" || loopHasPlayAlongStep}
    onSetLoopStart={(seconds) => setPracticeLoopPoint("startSeconds", seconds)}
    onSetLoopEnd={(seconds) => setPracticeLoopPoint("endSeconds", seconds)}
    onLoopEnabledChange={handleLoopEnabledChange}
    onResetLoop={() => commitPracticeLoop(null)}
    onAddBookmark={handleAddBookmark}
    onJumpToBookmark={handleJumpToBookmark}
    onRenameBookmark={handleRenameBookmark}
    onDeleteBookmark={handleDeleteBookmark}
    onOpenPlayAlong={() => handleViewModeChange("play_along")}
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
        soundFontAssetBlob: activeSoundfontAssetBlob,
      },
      document,
      performancePlan: analysis.performancePlan,
      motionPlan: analysis.motionPlan ?? null,
      keyStyle,
      profile: activeProfile,
      settings: { ...settings, calculationEngine: activeCalculationEngine },
      audioRecording: audioRecording ?? null,
      audioOffset,
      sceneView: { dimension: is3DView && viewMode !== "editor" ? "3d" : "2d", cameraPreset: camera3DPreset },
    };
  }, [document, analysis, keyStyle, activeProfile, settings, activeCalculationEngine, audioRecording, audioOffset, rawMidiBytes, needsReplan, sourceContext, activeOutputId, activeSoundfontAssetId, activeSoundfontAssetBlob, is3DView, viewMode, camera3DPreset]);

  return <StudioShell
    projectName={projectName}
    hasProject
    viewMode={viewMode}
    onViewModeChange={handleViewModeChange}
    is3DView={is3DView}
    onToggle3DView={handleToggle3DView}
    camera3DPreset={camera3DPreset}
    onCamera3DPresetChange={handleCamera3DPresetChange}
    status={status.kind === "error" ? status : needsReplan && rebuildMessage ? { kind: "calculating", message: rebuildMessage } : status}
    busy={busy || needsReplan}
    onOpenMidi={onOpenMidi}
    onOpenBuiltinMelodies={onOpenBuiltinMelodies}
    onOpenPackage={onOpenPackage}
    onSave={() => { void saveToDatabase(); }}
    onExportMidi={() => { void handleExportMidi(); }}
    onExportPackage={() => { void handleExportPackage(); }}
    onExportVideo={() => setIsVideoExportOpen(true)}
    canSave={!needsReplan && Boolean(rawMidiBytes)}
    canExport={!needsReplan && Boolean(rawMidiBytes)}
    onOpenPreferences={onOpenPreferences}
    onOpenPianist={onOpenPianist}
    editActions={editActions}
    projectsPanel={<ProjectsPanel onOpenProject={onOpenProject} onDeleteProject={onDeleteProject} activeProjectId={analysis.projectId} onOpenBuiltinMelodies={onOpenBuiltinMelodies} />}
    inspector={inspector}
    practicePanel={practicePanel}
    workspace={workspace}
    transport={transport}
    headerAddon={<div ref={setAssignmentControlsHost} className="studio-fingering-assignment-host" />}
    footerAddon={footerAddon ?? <StudioReleaseDetails description="v2.0.0: Realistic 3D Rigged hands with anatomical fingering, proximity V-fanning collision solver, smooth key travel, multi-format score import (MIDI, KAR, MusicXML, MuseScore, Guitar Pro), and practice tools." />}
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
