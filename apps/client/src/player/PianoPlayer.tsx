import {
  M1AnalyzeMidiResultSchema,
  M1ReplanDocumentRequestSchema,
  validateM1ReplanDocumentResultForRequest,
  type FingeringPlan,
  type M1AnalyzeMidiResult,
  type M1KeyStyle,
} from "@handthesia/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Transport,
  decodeAudioRecording,
  getAudioContext,
  getMasterGain,
  SyncedAudioSource,
  type DecodedAudioRecording,
} from "../audio";
import { FingeringEditor, materializeEditedDocument, WaveformCanvas } from "../editor";
import { postM1ReplanDocumentRequest, postM1ExportMidiRequest } from "../m1WorkerClient";
import { PianoScene, MotionBuffer } from "../render";
import { downloadProjectPackage, saveProject, createAutosaveService, type SavedProject, type SessionSnapshot } from "../storage";
import { ProfileModal, type PianistProfile } from "../profiles";
import { SettingsModal, getSettings, type AppSettings } from "../settings";
import { VideoExportModal } from "../export";
import { runWorkerJob } from "./workerJob";

export interface PianoPlayerProps {
  result: M1AnalyzeMidiResult;
  projectName?: string;
  rawMidiBytes?: ArrayBuffer | null;
  engineVersion?: string;
  initialSession?: SessionSnapshot | null;
  onProjectSaved?: (projectId: string) => void;
}

declare global {
  interface Window {
    __playerSnapshot?: {
      result: M1AnalyzeMidiResult;
      draftPlan: FingeringPlan;
      keyStyle: M1KeyStyle;
      pending: boolean;
      profile: PianistProfile;
      viewMode: "performance" | "editor" | "split";
    };
  }
}

function displayDocument(result: M1AnalyzeMidiResult) {
  const assignments = new Map(result.fingeringPlan!.assignments.map(assignment => [assignment.noteId, assignment]));
  return {...result.document!, notes: result.document!.notes.map(note => {
    const assignment = assignments.get(note.noteId)!;
    return {...note, hand: assignment.hand, finger: assignment.finger};
  })};
}

export function PianoPlayer({result, projectName = "Untitled Piano Piece", rawMidiBytes, engineVersion, initialSession, onProjectSaved}: PianoPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<PianoScene | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const motionBufferRef = useRef<MotionBuffer | null>(null);
  const [analysis, setAnalysis] = useState(result);
  const [draftPlan, setDraftPlan] = useState<FingeringPlan>(() => initialSession?.draftFingeringPlan ?? result.fingeringPlan!);
  const [activeProfile, setActiveProfileState] = useState<PianistProfile>(() => initialSession?.profile ?? result.profile);
  const [settings, setSettings] = useState<AppSettings>(() => getSettings());
  const [keyStyle, setKeyStyle] = useState<M1KeyStyle>(() => initialSession?.keyStyle ?? result.rawBaseline.provenance?.keyStyle ?? getSettings().keyStyle);
  const [appliedKeyStyle, setAppliedKeyStyle] = useState<M1KeyStyle>(() => initialSession?.keyStyle ?? result.rawBaseline.provenance?.keyStyle ?? getSettings().keyStyle);
  const [viewMode, setViewMode] = useState<"performance" | "editor" | "split">(() => initialSession?.viewMode ?? "performance");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(getSettings().leadInSeconds);
  const [speed, setSpeed] = useState(getSettings().playbackSpeed);
  const [volume, setVolume] = useState(getSettings().masterVolume);
  const [audioRecording, setAudioRecording] = useState<DecodedAudioRecording | null>(null);
  const [audioOffset, setAudioOffset] = useState<number>(0);
  const syncedAudioRef = useRef<SyncedAudioSource | null>(null);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [rebuildStatus, setRebuildStatus] = useState<string | null>(null);
  const [forceReplan, setForceReplan] = useState(() => initialSession?.plansState === "recompute-required" || result.engineVersion !== engineVersion ? 1 : 0);
  const [fps, setFps] = useState(0);
  const settingsRef = useRef(settings);
  const replanAbortRef = useRef<AbortController | null>(null);
  const jobsRef = useRef(new Set<AbortController>());
  const generationRef = useRef(0);
  const autosaveService = useMemo(() => createAutosaveService({delayMs: 400, onError: (error) => setSaveStatus(`Autosave failed: ${error.message}`)}), []);
  const fingeringPlan = draftPlan;
  const performancePlan = analysis.performancePlan;
  const motionPlan = analysis.motionPlan;
  const duration = analysis.document?.durationSeconds ?? 0;
  const document = useMemo(() => materializeEditedDocument({...analysis.document!, revision: draftPlan.inputRevision}, draftPlan), [analysis.document, draftPlan]);
  const exportDataSource = useMemo(() => {
    if (!document || !analysis.performancePlan) return null;
    return {
      document,
      performancePlan: analysis.performancePlan,
      keyStyle,
      profile: activeProfile,
      settings,
      audioRecording,
      audioOffset,
    };
  }, [document, analysis.performancePlan, keyStyle, activeProfile, settings, audioRecording, audioOffset]);
  const needsReplan = forceReplan > 0 || draftPlan.inputRevision !== analysis.document?.revision ||
    activeProfile.profileId !== analysis.profile.profileId || activeProfile.revision !== analysis.profile.revision ||
    keyStyle !== appliedKeyStyle || analysis.engineVersion !== engineVersion;
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => {
    window.__playerSnapshot = {result: analysis, draftPlan, keyStyle, pending: needsReplan, profile: activeProfile, viewMode};
    return () => { delete window.__playerSnapshot; };
  }, [analysis, draftPlan, keyStyle, needsReplan, activeProfile, viewMode]);

  useEffect(() => {
    if (!rawMidiBytes || !engineVersion || !needsReplan) return;
    const generation = ++generationRef.current;
    const abort = new AbortController();
    replanAbortRef.current = abort;
    const timer = window.setTimeout(() => {
      setRebuildStatus("Calculating updated performance…");
      void (async () => {
        try {
          const profilePlan = {...draftPlan, engineVersion, profileId: activeProfile.profileId, profileRevision: activeProfile.revision};
          const request = M1ReplanDocumentRequestSchema.parse({
            type: "replan-document", requestId: crypto.randomUUID(), projectId: document.projectId,
            revision: document.revision, engineVersion, midiBytes: rawMidiBytes, document,
            fingeringPlan: profilePlan, profile: activeProfile, resource: analysis.resource,
            rawBaseline: analysis.rawBaseline, options: {fixtureId: analysis.rawBaseline.fixtureId, keyStyle},
          });
          const response = await runWorkerJob(request, worker => postM1ReplanDocumentRequest(worker, request),
            message => message.type === "replan-document-result" ? validateM1ReplanDocumentResultForRequest(request, message) : undefined,
            abort.signal, message => { if (generation === generationRef.current) setRebuildStatus(message); });
          if (abort.signal.aborted || generation !== generationRef.current) return;
          const {keyStyle: calculatedStyle, ...envelope} = response;
          const next = M1AnalyzeMidiResultSchema.parse({...envelope, type: "analysis-result"});
          transportRef.current?.updatePlan(next.performancePlan!, next.document!.durationSeconds);
          sceneRef.current?.setPerformancePlan(next.performancePlan!, displayDocument(next));
          sceneRef.current?.setKeyStyle(calculatedStyle);
          sceneRef.current?.setMotionPlan(next.motionPlan);
          motionBufferRef.current?.invalidate();
          if (next.motionPlan?.poses) {
            motionBufferRef.current?.addPoses(next.motionPlan.poses);
          }
          setAnalysis(next);
          setDraftPlan(next.fingeringPlan!);
          setAppliedKeyStyle(calculatedStyle);
          setForceReplan(0);
          setRebuildStatus(null);
        } catch (error) {
          if (!abort.signal.aborted && generation === generationRef.current) setRebuildStatus(`Calculation failed: ${error instanceof Error ? error.message : String(error)}. Edits are retained; retry the calculation.`);
        }
      })();
    }, 300);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [document, draftPlan, activeProfile, keyStyle, engineVersion, rawMidiBytes, analysis.resource, analysis.rawBaseline, needsReplan, forceReplan]);

  useEffect(() => {
    if (!rawMidiBytes) return;
    autosaveService.schedule({
      projectId: analysis.projectId, updatedAt: Date.now(), document, fingeringPlan: draftPlan,
      result: analysis, rawMidiBytes, activeProfileId: activeProfile.profileId, profile: activeProfile,
      draftFingeringPlan: draftPlan, plansState: needsReplan ? "recompute-required" : "valid", keyStyle, viewMode,
    });
  }, [analysis, document, draftPlan, rawMidiBytes, activeProfile, keyStyle, viewMode, needsReplan, autosaveService]);

  useEffect(() => () => {
    replanAbortRef.current?.abort();
    for (const job of jobsRef.current) job.abort();
    void autosaveService.flush();
  }, [autosaveService]);

  useEffect(() => {
    let active = true;
    const transport = new Transport({leadInSeconds: Math.abs(settingsRef.current.leadInSeconds)});
    transportRef.current = transport;
    transport.loadPlan(result.performancePlan!, result.document!.durationSeconds);
    transport.setSpeed(settingsRef.current.playbackSpeed);
    transport.setVolume(settingsRef.current.masterVolume);
    transport.getSampler().setTimbre(settingsRef.current.soundTimbre);
    const unsubscribe = transport.subscribeState(state => setIsPlaying(state === "playing"));
    const container = containerRef.current;
    if (container) void PianoScene.create({target: container, song: displayDocument(result), motionPlan: result.motionPlan, performancePlan: result.performancePlan, keyStyle, pixelsPerSecond: 180})
      .then(scene => {
        if (!active) {scene.destroy(); return;}
        sceneRef.current = scene;
        const latest = window.__playerSnapshot?.result ?? result;
        const motionBuffer = new MotionBuffer({ windowAheadSeconds: 4.0, windowBehindSeconds: 1.0 });
        if (latest.motionPlan?.poses) {
          motionBuffer.addPoses(latest.motionPlan.poses);
        }
        scene.setMotionBuffer(motionBuffer);
        motionBufferRef.current = motionBuffer;
        scene.setPerformancePlan(latest.performancePlan!, displayDocument(latest));
        scene.setMotionPlan(latest.motionPlan);
        scene.setDisplaySettings(settingsRef.current);
        scene.update(transport.getCurrentTime());
      }).catch(error => {if (active) setSaveStatus(`Scene initialization failed: ${String(error)}`);});
    return () => {
      active = false; unsubscribe();
      if (syncedAudioRef.current) {
        syncedAudioRef.current.dispose();
        syncedAudioRef.current = null;
      }
      transport.dispose(); transportRef.current = null;
      motionBufferRef.current = null;
      sceneRef.current?.destroy(); sceneRef.current = null;
    };
    // A player owns one source session; App remounts it when a new input is analyzed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sceneRef.current?.setDisplaySettings(settings);
    transportRef.current?.setLeadInSeconds(Math.abs(settings.leadInSeconds));
    transportRef.current?.getSampler().setTimbre(settings.soundTimbre);
  }, [settings]);

  useEffect(() => {
    let raf = 0, lastRender = -Infinity, fpsStart = performance.now(), frames = 0;
    const render = (now: number) => {
      const cap = settingsRef.current.renderCapFps;
      if (cap === 0 || now - lastRender >= 1000 / cap - 0.5) {
        lastRender = now;
        const t = transportRef.current?.getCurrentTime() ?? settingsRef.current.leadInSeconds;
        setCurrentTime(t); sceneRef.current?.update(t); frames++;
        if (now - fpsStart >= 1000) {setFps(Math.round(frames * 1000 / (now - fpsStart))); fpsStart = now; frames = 0;}
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onFingeringPlanChange = (plan: FingeringPlan) => {setDraftPlan(plan); setRebuildStatus("Scheduling updated performance…");};
  const handleProfileChanged = (profile: PianistProfile) => {
    setRebuildStatus("Scheduling updated performance…");
    setActiveProfileState(profile);
    setDraftPlan(plan => ({...plan, inputRevision: plan.inputRevision + 1, profileId: profile.profileId, profileRevision: profile.revision, engineVersion: engineVersion!}));
  };
  const handleSettingsChanged = (next: AppSettings) => {
    if (next.keyStyle !== keyStyle) setDraftPlan(plan => ({...plan, inputRevision: plan.inputRevision + 1}));
    setSettings(next); setKeyStyle(next.keyStyle); setSpeed(next.playbackSpeed); setVolume(next.masterVolume);
    transportRef.current?.setSpeed(next.playbackSpeed); transportRef.current?.setVolume(next.masterVolume);
  };
  const handleKeyStyleChange = (style: M1KeyStyle) => {
    if (style === keyStyle) return;
    setRebuildStatus("Scheduling updated performance…");
    setKeyStyle(style); setDraftPlan(plan => ({...plan, inputRevision: plan.inputRevision + 1}));
  };
  const togglePlay = async () => {
    try {if (isPlaying) transportRef.current?.pause(); else await transportRef.current?.play();}
    catch (error) {setSaveStatus(`Playback failed: ${String(error)}`);}
  };
  const handleStop = () => {
    transportRef.current?.stop();
    motionBufferRef.current?.invalidate();
    if (analysis.motionPlan?.poses) {
      motionBufferRef.current?.addPoses(analysis.motionPlan.poses);
    }
    setCurrentTime(settings.leadInSeconds);
  };
  const handleSeek = (time: number) => {
    transportRef.current?.seek(time);
    motionBufferRef.current?.invalidate();
    if (analysis.motionPlan?.poses) {
      motionBufferRef.current?.addPoses(analysis.motionPlan.poses);
    }
    setCurrentTime(transportRef.current?.getCurrentTime() ?? time);
    sceneRef.current?.update(time);
  };
  const handleSpeedChange = (value: number) => {setSpeed(value); transportRef.current?.setSpeed(value);};
  const handleVolumeChange = (value: number) => {
    setVolume(value);
    transportRef.current?.setVolume(value);
    syncedAudioRef.current?.setVolume(value);
  };

  const handleAudioTrackUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setSaveStatus("Decoding audio file…");
      const ctx = getAudioContext();
      const decoded = await decodeAudioRecording(file, ctx);
      setAudioRecording(decoded);
      setAudioOffset(0);

      let synced = syncedAudioRef.current;
      if (!synced) {
        synced = new SyncedAudioSource(0, volume);
        syncedAudioRef.current = synced;
      }
      synced.attach(decoded, ctx, getMasterGain());
      transportRef.current?.setSyncedAudio(synced);
      setSaveStatus(`Audio loaded: ${file.name} (${formatSongTime(decoded.durationSeconds)})`);
    } catch (err) {
      setSaveStatus(`Audio decode failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      event.target.value = "";
    }
  };

  const handleClearAudioTrack = () => {
    if (syncedAudioRef.current) {
      syncedAudioRef.current.dispose();
      syncedAudioRef.current = null;
    }
    transportRef.current?.setSyncedAudio(null);
    setAudioRecording(null);
    setAudioOffset(0);
    setSaveStatus("Audio track removed.");
  };

  const handleAudioOffsetChange = (newOffset: number) => {
    setAudioOffset(newOffset);
    syncedAudioRef.current?.setOffset(newOffset, currentTime, speed);
  };
  const savedProject = (): SavedProject => ({
    projectId: analysis.projectId, name: projectName, updatedAt: Date.now(), document: analysis.document!,
    fingeringPlan: analysis.fingeringPlan, performancePlan, motionPlan, rawMidiBytes, profile: analysis.profile, resources: [analysis.resource],
  });
  const handleSaveToDb = async () => {
    try {await saveProject(savedProject()); setSaveStatus("Project saved to IndexedDB."); onProjectSaved?.(analysis.projectId);}
    catch (error) {setSaveStatus(`Failed to save: ${String(error)}`);}
  };
  const handleExportPackage = async () => {
    try {await downloadProjectPackage(savedProject(), {profiles: [analysis.profile], resources: [analysis.resource]}); setSaveStatus("Package JSON exported.");}
    catch (error) {setSaveStatus(`Failed to export: ${String(error)}`);}
  };
  const handleExportFingeredMidi = async () => {
    if (needsReplan || !rawMidiBytes || !engineVersion) return;
    const abort = new AbortController(); jobsRef.current.add(abort);
    setSaveStatus("Exporting fingered MIDI…");
    try {
      const request = {type: "export-midi" as const, requestId: crypto.randomUUID(), projectId: analysis.projectId,
        revision: analysis.document!.revision, engineVersion, midiBytes: rawMidiBytes, document: analysis.document!, fingeringPlan: analysis.fingeringPlan!};
      const response = await runWorkerJob(request, worker => postM1ExportMidiRequest(worker, request), message => message.type === "export-midi-result" ? message : undefined, abort.signal);
      const blob = new Blob([response.exportedBytes], {type: "audio/midi"});
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      const baseName = projectName.replace(/\.mid(i)?$/i, "");
      anchor.href = url; anchor.download = `${baseName}.fingered.mid`; anchor.click(); URL.revokeObjectURL(url);
      setSaveStatus(`Exported ${response.markedCount} fingered notes to ${anchor.download}!`);
    } catch (error) {if (!abort.signal.aborted) setSaveStatus(`Export failed: ${String(error)}`);}
    finally {jobsRef.current.delete(abort);}
  };

  return (
    <section className="player-card" aria-label="Piano Player">
      <div className="player-header">
        <div>
          <span className="section-kicker">Interactive Web Player</span>
          <h2 className="player-title">{projectName}</h2>
        </div>
        <div className="view-mode-tabs" role="tablist" aria-label="View Mode">
          <button
            id="tab-btn-performance"
            type="button"
            className={`tab-btn ${viewMode === "performance" ? "is-active" : ""}`}
            onClick={() => setViewMode("performance")}
          >
            🎹 Performance
          </button>
          <button
            id="tab-btn-editor"
            type="button"
            className={`tab-btn ${viewMode === "editor" ? "is-active" : ""}`}
            onClick={() => setViewMode("editor")}
          >
            ✎ Fingering Editor
          </button>
          <button
            id="tab-btn-split"
            type="button"
            className={`tab-btn ${viewMode === "split" ? "is-active" : ""}`}
            onClick={() => setViewMode("split")}
          >
            ◫ Split View
          </button>
        </div>
        <div className="player-quick-actions" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            id="profile-modal-btn"
            type="button"
            className="button-secondary"
            onClick={() => setIsProfileModalOpen(true)}
            title="Pianist Profile & Anatomy Settings"
            style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "0.3rem" }}
          >
            <span>👤</span>
            <span className="profile-name-label">{activeProfile.name}</span>
          </button>
          <button
            id="settings-modal-btn"
            type="button"
            className="button-secondary"
            onClick={() => setIsSettingsModalOpen(true)}
            title="Application & Visual Settings"
            style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem" }}
          >
            ⚙ Settings
          </button>
          <label
            id="audio-track-upload-label"
            className="button-secondary"
            title="Upload external audio recording (.wav, .mp3, .ogg, .flac)"
            style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
          >
            <span>🎵</span>
            <span>{audioRecording ? "Replace Audio" : "Sync Audio"}</span>
            <input
              id="audio-track-file-input"
              type="file"
              accept=".wav,.mp3,.ogg,.flac,audio/*"
              style={{ display: "none" }}
              onChange={(e) => void handleAudioTrackUpload(e)}
            />
          </label>
          {audioRecording && (
            <button
              id="audio-track-clear-btn"
              type="button"
              className="button-secondary"
              onClick={handleClearAudioTrack}
              title="Remove synced audio track"
              style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem" }}
            >
              ✕ Audio
            </button>
          )}
        </div>
        <div className="player-badges">
          <span className="badge">{document.notes.length} notes</span>
          <span className="badge">{(motionPlan ?? result.motionPlan)?.poses.length ?? 0} poses</span>
          <span className="badge">{settings.soundOutput === "soundfont" ? "SoundFont SF2" : settings.soundOutput === "webmidi" ? "Web MIDI" : "Web Audio Synth"}</span>
          {settings.showFpsOverlay && <span className="badge" data-testid="fps-overlay">{fps} FPS</span>}
        </div>
      </div>

      {/* Milestone M6 Synced Audio Waveform */}
      {audioRecording && (
        <div id="audio-waveform-container" style={{ margin: "0.5rem 0" }}>
          <WaveformCanvas
            recording={audioRecording}
            offsetSeconds={audioOffset}
            songDuration={duration}
            pixelsPerSecond={180}
            scrollX={0}
            onOffsetChange={handleAudioOffsetChange}
            speed={speed}
            currentTime={currentTime}
          />
        </div>
      )}

      {/* PixiJS Canvas Viewport */}
      <div
        id="piano-canvas-container"
        ref={containerRef}
        className="piano-canvas-container"
        data-testid="piano-canvas"
        style={{ display: viewMode === "editor" ? "none" : "block" }}
      />

      {/* Milestone M4 Fingering Editor */}
      <div style={{display: viewMode === "performance" ? "none" : "block"}}>
        <FingeringEditor
          document={document}
          initialFingeringPlan={fingeringPlan}
          active={viewMode !== "performance"}
          transportTime={currentTime}
          onSeek={handleSeek}
          onFingeringPlanChange={onFingeringPlanChange}
        />
      </div>
      {rebuildStatus && <p role="status" data-testid="rebuild-status">{rebuildStatus}</p>}
      {needsReplan && rebuildStatus?.startsWith("Calculation failed") && <button type="button" onClick={() => setForceReplan(value => value + 1)}>Retry calculation</button>}

      {/* Transport Controls Bar */}
      <div className="transport-bar">
        <div className="transport-buttons">
          <button
            id="player-play-button"
            type="button"
            className="transport-btn play-btn"
            onClick={() => void togglePlay()}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? "❚❚ Pause" : "▶ Play"}
          </button>

          <button
            id="player-stop-button"
            type="button"
            className="transport-btn stop-btn"
            onClick={handleStop}
            aria-label="Stop"
          >
            ◼ Stop
          </button>
        </div>

        {/* Scrubber & Time */}
        <div className="scrubber-wrapper">
          <span className="time-display">{formatSongTime(currentTime)}</span>
          <input
            id="player-seek-slider"
            type="range"
            className="scrubber-slider"
            min={settings.leadInSeconds}
            max={Math.max(1, duration)}
            step={0.05}
            value={currentTime}
            onChange={(e) => handleSeek(parseFloat(e.target.value))}
            aria-label="Seek position"
          />
          <span className="time-display duration">{formatSongTime(duration)}</span>
        </div>

        {/* Speed & Volume & Style Controls */}
        <div className="transport-extra-controls">
          <label className="extra-label">
            <span>Speed</span>
            <select
              id="player-speed-select"
              value={speed}
              onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
            >
              <option value="0.5">0.5x</option>
              <option value="0.75">0.75x</option>
              <option value="1">1.0x</option>
              <option value="1.25">1.25x</option>
              <option value="1.5">1.5x</option>
            </select>
          </label>

          <label className="extra-label">
            <span>Vol</span>
            <input
              id="player-volume-slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
              aria-label="Volume"
            />
          </label>

          <label className="extra-label">
            <span>Keys</span>
            <select
              id="player-keystyle-select"
              value={keyStyle}
              onChange={(e) => handleKeyStyleChange(e.target.value as M1KeyStyle)}
            >
              <option value="realistic">Realistic</option>
              <option value="equal">Equal</option>
            </select>
          </label>
        </div>
      </div>

      {/* Persistence Bar */}
      <div className="persistence-bar">
        <button
          id="player-save-db-button"
          type="button"
          className="button-secondary"
          disabled={needsReplan || !rawMidiBytes}
          onClick={() => void handleSaveToDb()}
        >
          💾 Save to IndexedDB
        </button>

        <button
          id="player-export-json-button"
          type="button"
          className="button-secondary"
          disabled={needsReplan || !rawMidiBytes}
          onClick={() => void handleExportPackage()}
        >
          ⬇ Export Package (.json)
        </button>

        <button
          id="player-export-midi-button"
          type="button"
          className="button-secondary"
          disabled={needsReplan || !rawMidiBytes}
          onClick={() => void handleExportFingeredMidi()}
        >
          ⬇ Export Fingered MIDI (.mid)
        </button>

        <button
          id="player-export-video-button"
          type="button"
          className="button-secondary"
          disabled={needsReplan || !document}
          onClick={() => setIsExportModalOpen(true)}
        >
          🎥 Export Video (.webm)
        </button>

        {saveStatus && <span className="save-status-msg">{saveStatus}</span>}
      </div>

      <ProfileModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        onProfileChanged={handleProfileChanged}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        onSettingsChanged={handleSettingsChanged}
      />

      <VideoExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        dataSource={exportDataSource}
      />
    </section>
  );
}

function formatSongTime(seconds: number): string {
  const isNeg = seconds < 0;
  const absSec = Math.abs(seconds);
  const mins = Math.floor(absSec / 60);
  const secs = Math.floor(absSec % 60);
  const tenths = Math.floor((absSec % 1) * 10);
  const prefix = isNeg ? "-" : "";
  return `${prefix}${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}.${tenths}`;
}
