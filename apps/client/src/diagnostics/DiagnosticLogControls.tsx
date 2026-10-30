import { useEffect, useRef, useState } from "react";
import { clearDiagnosticLog, downloadDiagnosticLog } from "./eventLog";
import {
  saveFinalTestingHandSegment,
  flushTestingHandSegments,
  readTestingHandProvenance,
  startTestingHandCapture,
  stopTestingHandCapture,
  snapshotTestingPianistProfile,
  testingHandCapture,
  testingHandSegmentStatus,
  setTestingHandCaptureSettingsSubscription,
  updateTestingHandCaptureConfiguration,
  type TestingHandCapturePayload,
  type TestingHandCaptureStatus,
} from "./testingHandCapture";
import styles from "../studio/StudioInspector.module.css";
import { getSettings, subscribeSettings, type Settings } from "../settings";
import type { PianistProfile } from "../profiles";

function captureConfiguration(settings: Settings): Record<string, unknown> {
  return {
    handModel: settings.handModel,
    riggedExperimentalFrameSchemaVersion: 2,
  };
}

export function DiagnosticLogControls({ appliedProfile }: { appliedProfile?: PianistProfile | null }) {
  const [handModel, setHandModel] = useState(() => getSettings().handModel);
  const [captureStatus, setCaptureStatus] = useState<TestingHandCaptureStatus>(() => testingHandCapture.status());
  const [segmentStatus, setSegmentStatus] = useState(() => testingHandSegmentStatus());
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);
  const appliedProfileRef = useRef(appliedProfile);
  const [pendingCapture, setPendingCapture] = useState<TestingHandCapturePayload | null>(null);
  const [saveState, setSaveState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; savedSegments: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    appliedProfileRef.current = appliedProfile;
  }, [appliedProfile]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const syncSettings = (settings: Settings) => {
      setHandModel(settings.handModel);
      updateTestingHandCaptureConfiguration(captureConfiguration(settings));
    };
    syncSettings(getSettings());
    return subscribeSettings(syncSettings);
  }, []);
  useEffect(() => {
    if (!captureStatus.active) return;
    const timer = window.setInterval(() => { setCaptureStatus(testingHandCapture.status()); setSegmentStatus(testingHandSegmentStatus()); }, 250);
    return () => window.clearInterval(timer);
  }, [captureStatus.active]);

  const startCapture = async () => {
    setStarting(true);
    setPendingCapture(null);
    setSaveState({ kind: "idle" });
    const provenance = await readTestingHandProvenance();
    if (!mounted.current) return;
    const settings = getSettings();
    if (settings.handModel !== "rigged-experimental") {
      setSaveState({ kind: "error", message: "Select Rigged Experimental before starting a frame capture." });
      setStarting(false);
      return;
    }
    // The applied profile belongs to the current analysis, not necessarily the
    // newly selected profile while a replan is pending. Each frame also carries
    // its motion-plan identity, so later profile changes cannot be mistaken for
    // this start-of-capture snapshot.
    const profileAtCaptureStart = snapshotTestingPianistProfile(appliedProfileRef.current);
    const started = startTestingHandCapture(captureConfiguration(settings), {
      ...(provenance ?? {}),
      pianistProfileAtCaptureStart: profileAtCaptureStart,
    });
    setCaptureStatus(started);
    setStarting(false);
    if (started.active) {
      setTestingHandCaptureSettingsSubscription(subscribeSettings(next => updateTestingHandCaptureConfiguration(captureConfiguration(next))));
    }
  };

  const saveCapture = async (payload: TestingHandCapturePayload) => {
    setSaveState({ kind: "saving" });
    try {
      await saveFinalTestingHandSegment(payload);
      const savedSegments = testingHandSegmentStatus().saved;
      setSegmentStatus(testingHandSegmentStatus());
      setPendingCapture(null);
      setSaveState({ kind: "saved", savedSegments });
    } catch (error) {
      setPendingCapture(payload);
      setSaveState({ kind: "error", message: error instanceof Error ? error.message : "Could not save local hand frame diagnostics." });
    }
  };

  const stopCapture = () => {
    const payload = stopTestingHandCapture();
    setCaptureStatus(testingHandCapture.status());
    if (!payload) return;
    if (payload.records.length === 0 && payload.segmentIndex === 0) {
      setSaveState({ kind: "error", message: "No Rigged Experimental frames were recorded. Select the model, wait for it to load, then record again." });
      return;
    }
    void saveCapture(payload);
  };

  return <div role="group" aria-label="Diagnostic log">
    <h3 className={styles.heading}>Diagnostic log</h3>
    <p className={styles.hint}>Recent local events survive reloads. Includes Worker timing, motion coverage and errors; excludes MIDI bytes and audio. Keeps up to 2,000 events within a bounded history.</p>
    <button className={styles.secondaryButton} type="button" onClick={downloadDiagnosticLog}>Download diagnostic log</button>
    <button className={styles.secondaryButton} type="button" onClick={clearDiagnosticLog}>Clear diagnostic log</button>
    {import.meta.env.DEV && <div aria-label="Rigged Experimental frame capture">
      <h3 className={styles.heading}>Rigged Experimental frame capture</h3>
      <p className={styles.hint}>
        Opt-in local trace, sampled every 250 ms per hand and at observed note boundaries. Identical paused frames are skipped and summarized with their elapsed hold interval; pose, transport, profile, settings, targets, and forced boundary changes remain recorded. Records the displayed transport time, sampled MotionPose, profile identity, actual Rigged Experimental bone world transforms, and fixed post-skin distal surface samples from the loaded GLB. Active notes include key bounds and sparse key-top height references; these skin samples are not validated anatomical pads, and collisions are not computed. No project, file, MIDI, or audio payloads are included.
      </p>
      <p className={styles.hint}>
        {handModel === "rigged-experimental" ? "Rigged Experimental is selected." : "Select Rigged Experimental in Settings before starting a capture."}
        {captureStatus.active ? ` Recording ${captureStatus.recordCount}/${captureStatus.maxRecords} frames for ${captureStatus.captureModel === "rigged-experimental" ? "Rigged Experimental" : "the selected hand model"} (${captureStatus.throttledSamples} rate-limited updates${captureStatus.captureModel === "rigged-experimental" ? `; ${captureStatus.duplicateSamples} identical Rigged frames skipped` : ""}).` : ""}
        {captureStatus.truncated ? " Capture reached its local size or record limit; stop and save the partial log." : ""}
        {` Saved segments: ${segmentStatus.saved}; awaiting save: ${segmentStatus.pending}.`}
      </p>
      {segmentStatus.error && <p role="alert" className={styles.hint}>Segment save failed: {segmentStatus.error}. Stop and retry to save buffered segments.</p>}
      {captureStatus.active
        ? <button className={styles.secondaryButton} type="button" onClick={stopCapture} disabled={saveState.kind === "saving"}>Stop and save Rigged Experimental capture</button>
        : <button className={styles.secondaryButton} type="button" onClick={() => void startCapture()} disabled={starting || handModel !== "rigged-experimental" || saveState.kind === "saving" || pendingCapture !== null || segmentStatus.pending > 0}>{starting ? "Preparing capture…" : "Start Rigged Experimental capture"}</button>}
      {pendingCapture && <button className={styles.secondaryButton} type="button" onClick={() => void saveCapture(pendingCapture)} disabled={saveState.kind === "saving"}>Retry save</button>}
      {!captureStatus.active && !pendingCapture && segmentStatus.pending > 0 && <button className={styles.secondaryButton} type="button" onClick={() => void flushTestingHandSegments().then(() => setSegmentStatus(testingHandSegmentStatus())).catch(() => setSegmentStatus(testingHandSegmentStatus()))}>Retry saving segments</button>}
      {saveState.kind === "saving" && <p role="status" className={styles.hint}>Saving the capture to the local development server…</p>}
      {saveState.kind === "saved" && <p role="status" className={styles.hint}>
        Saved {saveState.savedSegments} segment(s) to <code>apps/client/.local-diagnostics/rigged-experimental-hand/</code>.
      </p>}
      {saveState.kind === "error" && <p role="alert" className={styles.hint}>{saveState.message}</p>}
      <p className={styles.hint}>Storage is capped at 20 JSON files and 20 MB. Captures keep the existing per-file and per-session byte limits. Each part shares a capture ID and has an ordered segment index; if saving fails, at most three parts remain in memory and the capture stops accepting new frames.</p>
    </div>}
  </div>;
}
