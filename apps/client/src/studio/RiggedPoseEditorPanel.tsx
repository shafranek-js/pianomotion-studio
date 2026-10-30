import type {
  RiggedPoseEditAvailability,
  RiggedPoseEditFingerFilter,
  RiggedPoseEditSampleSource,
  RiggedPoseEditSide,
  RiggedPoseEditTimepoint,
  RiggedPoseEditTransformMode,
} from "../render3d/pianoScene3d";
import styles from "./RiggedPoseEditorPanel.module.css";

export interface RiggedPoseEditorPresetSummary {
  presetId: string;
  name: string;
  createdAtUnixMs: number;
}

export interface RiggedPoseEditorPanelProps {
  active: boolean;
  canEnter: boolean;
  is3DMode: boolean;
  modelMatches: boolean;
  entryMessage?: string | null;
  busy: boolean;
  timepoints: readonly RiggedPoseEditTimepoint[];
  availabilityById: Readonly<Record<string, RiggedPoseEditAvailability>>;
  selectedTimepointId: string | null;
  positionLabel?: string;
  selectedSide: RiggedPoseEditSide;
  selectedBoneName: string | null;
  fingerFilter: RiggedPoseEditFingerFilter;
  transformMode: RiggedPoseEditTransformMode;
  undoAvailable: boolean;
  draftCount: number;
  sampleSources: Readonly<Record<RiggedPoseEditSide, RiggedPoseEditSampleSource | null>>;
  sourceHashesVerified: boolean;
  presets: readonly RiggedPoseEditorPresetSummary[];
  selectedPresetId: string;
  presetName: string;
  status: string | null;
  error: string | null;
  onEnter(): void;
  onCancel(): void;
  onSeek(index: number): void;
  onSideChange(side: RiggedPoseEditSide): void;
  onSelectWholeHand(): void;
  onFingerFilterChange(filter: RiggedPoseEditFingerFilter): void;
  onTransformModeChange(mode: RiggedPoseEditTransformMode): void;
  onUndo(): void;
  onReset(): void;
  onPresetNameChange(name: string): void;
  onPresetChange(presetId: string): void;
  renamePresetName: string;
  onRenamePresetNameChange(name: string): void;
  onSavePreset(): void;
  onApplyPreset(): void;
  onExportPreset(): void;
  onImportPresetFile(file: File): Promise<void>;
  onRenamePreset(): void;
  onReplacePreset(): void;
  onDeletePreset(): void;
}

export function RiggedPoseEditorPanel(props: RiggedPoseEditorPanelProps) {
  const selectedIndex = props.timepoints.findIndex(point => point.id === props.selectedTimepointId);
  const selectedTimepoint = selectedIndex >= 0 ? props.timepoints[selectedIndex]! : null;
  const selectedAvailability = selectedTimepoint ? props.availabilityById[selectedTimepoint.id] : undefined;
  const canSave = props.active && props.sourceHashesVerified && props.presetName.trim().length > 0 && !props.busy;
  const selectedPreset = props.presets.find(preset => preset.presetId === props.selectedPresetId) ?? null;
  const canApply = props.active && selectedPreset !== null && !props.busy;
  const presetOptionLabels = new Map<string, string>(props.presets.map(preset => [preset.presetId, presetOptionLabel(preset, props.presets)] as const));
  const previousIndex = findAvailableIndex(props.timepoints, props.availabilityById, selectedIndex, -1);
  const nextIndex = findAvailableIndex(props.timepoints, props.availabilityById, selectedIndex, 1);
  const selectedSource = props.sampleSources[props.selectedSide];

  return (
    <section className={styles.panel} aria-label="Rigged Experimental hand pose editor" data-testid="rigged-pose-editor">
      <div className={styles.headingRow}>
        <h3>Edit hand</h3>
        {props.active && <span className={styles.liveBadge}>Paused</span>}
      </div>
      <p className={styles.description}>
        Edit the Rigged Experimental hand on the piano. Saved presets are separate reference poses; playback continues to use the MotionPlan.
      </p>

      {!props.is3DMode && <p className={styles.notice} role="status">Switch to the 3D piano view to edit a hand.</p>}
      {props.is3DMode && !props.modelMatches && <p className={styles.notice} role="status">Select Rigged Experimental as the hand model to use pose editing.</p>}
      {props.is3DMode && props.modelMatches && props.timepoints.length === 0 && (
        <p className={styles.notice} role="status">No sampled poses are available yet. A MotionPlan or motion buffer is required.</p>
      )}
      {!props.active && props.entryMessage && <p className={styles.notice} role="status">{props.entryMessage}</p>}
      {props.is3DMode && props.modelMatches && selectedTimepoint && selectedAvailability && !selectedAvailability.available && (
        <p className={styles.notice} role="status">This sampled time is unavailable for both hands: {availabilityText(selectedAvailability.reason)}.</p>
      )}

      {!props.active ? (
        <button className={styles.primaryButton} type="button" disabled={!props.canEnter || props.busy} onClick={props.onEnter}>
          {props.busy ? "Preparing hands…" : "Edit hand"}
        </button>
      ) : (
        <>
          <div className={styles.navigation}>
            <div className={styles.navigationTop}>
              <strong>{selectedTimepoint ? displayPosition(selectedTimepoint, selectedIndex, props.timepoints.length) : "No sampled pose selected"}</strong>
              <span>{selectedTimepoint ? formatPoseTime(selectedTimepoint.displayedTransportTimeSeconds) : "—"}</span>
            </div>
            <label className={styles.field} htmlFor="rigged-pose-position">
              <span>Sampled poses · {props.timepoints.length}</span>
              <select
                id="rigged-pose-position"
                value={props.selectedTimepointId ?? ""}
                disabled={props.busy || props.timepoints.length === 0}
                onChange={event => {
                  const index = props.timepoints.findIndex(point => point.id === event.currentTarget.value);
                  if (index >= 0 && props.availabilityById[props.timepoints[index]!.id]?.available) props.onSeek(index);
                }}
              >
                {props.timepoints.map((point, index) => {
                  const availability = props.availabilityById[point.id];
                  return <option key={point.id} value={point.id} disabled={!availability?.available}>
                    {displayPosition(point, index, props.timepoints.length)} · {formatPoseTime(point.displayedTransportTimeSeconds)}
                  </option>;
                })}
              </select>
            </label>
            <div className={styles.navigationButtons}>
              <button type="button" className={styles.secondaryButton} disabled={previousIndex < 0 || props.busy} onClick={() => props.onSeek(previousIndex)}>Previous</button>
              <button type="button" className={styles.secondaryButton} disabled={nextIndex < 0 || props.busy} onClick={() => props.onSeek(nextIndex)}>Next</button>
            </div>
            {selectedTimepoint?.kind === "lead-in-held" && (
              <p className={styles.sourceNote}>
                First pose held for lead-in. Source pose: {formatPoseTime(selectedTimepoint.sourcePoseTimeSeconds)}; this is not an engine keyframe.
              </p>
            )}
            {selectedTimepoint?.kind === "sampled" && (
              <p className={styles.sourceNote}>Displayed time is a sampled MotionPlan or motion-buffer time; no new keyframe is created.</p>
            )}
          </div>

          <div className={styles.fieldsRow}>
            <label className={styles.field} htmlFor="rigged-pose-side">
              <span>Hand</span>
              <select id="rigged-pose-side" value={props.selectedSide} disabled={props.busy} onChange={event => props.onSideChange(event.currentTarget.value as RiggedPoseEditSide)}>
                <option value="left">Left hand</option>
                <option value="right">Right hand</option>
              </select>
            </label>
            <label className={styles.field} htmlFor="rigged-pose-joints">
              <span>Joint markers</span>
              <select
                id="rigged-pose-joints"
                value={props.fingerFilter}
                disabled={props.busy}
                onChange={event => props.onFingerFilterChange(event.currentTarget.value === "all" ? "all" : Number(event.currentTarget.value) as RiggedPoseEditFingerFilter)}
              >
                <option value="all">All joints</option>
                <option value={1}>Thumb</option>
                <option value={2}>Index finger</option>
                <option value={3}>Middle finger</option>
                <option value={4}>Ring finger</option>
                <option value={5}>Little finger</option>
              </select>
            </label>
          </div>

          <div className={styles.selection}>
            <span>Selected target</span>
            <strong>{props.selectedBoneName ?? `${props.selectedSide} hand`}</strong>
            <span className={styles.hint}>{props.selectedBoneName ? "Bone rotation in local space" : "Hand group transform in local space"}</span>
            {props.selectedBoneName && (
              <button type="button" className={styles.secondaryButton} disabled={props.busy} onClick={props.onSelectWholeHand}>
                Select whole hand
              </button>
            )}
          </div>

          {!props.selectedBoneName && <div className={styles.modeButtons} role="group" aria-label="Hand transform mode">
            <button type="button" aria-pressed={props.transformMode === "translate"} className={props.transformMode === "translate" ? styles.selectedMode : styles.secondaryButton} disabled={props.busy} onClick={() => props.onTransformModeChange("translate")}>Move hand</button>
            <button type="button" aria-pressed={props.transformMode === "rotate"} className={props.transformMode === "rotate" ? styles.selectedMode : styles.secondaryButton} disabled={props.busy} onClick={() => props.onTransformModeChange("rotate")}>Rotate hand</button>
          </div>}

          <div className={styles.sourceGrid} aria-label="Pose source times">
            {(["left", "right"] as const).map(side => <div key={side}>
              <span>{side === "left" ? "Left source" : "Right source"}</span>
              <strong>{formatSource(props.sampleSources[side])}</strong>
            </div>)}
          </div>
          {selectedSource?.sampleMode === "unavailable" && <p className={styles.notice} role="status">Source pose timing is unavailable for the selected hand.</p>}
          <p className={styles.sourceNote}>Unsaved drafts: {props.draftCount}. {props.positionLabel ?? "Drafts are kept separately at each available time."}</p>

          <div className={styles.actionRow}>
            <button type="button" className={styles.secondaryButton} disabled={!props.undoAvailable || props.busy} onClick={props.onUndo}>Undo</button>
            <button type="button" className={styles.secondaryButton} disabled={props.busy} onClick={props.onReset}>Reset hand</button>
            <button type="button" className={styles.secondaryButton} disabled={props.busy} onClick={props.onCancel}>Cancel</button>
          </div>

          <div className={styles.presetSection}>
            <h4>Separate pose preset</h4>
            <p className={styles.sourceNote}>Presets are saved in this browser for the matching GLB files. Applying one changes this edit session only; it does not replace playback motion.</p>
            <label className={styles.field} htmlFor="rigged-pose-preset-name">
              <span>New preset name</span>
              <input id="rigged-pose-preset-name" type="text" maxLength={80} value={props.presetName} disabled={props.busy} onChange={event => props.onPresetNameChange(event.currentTarget.value)} />
            </label>
            {!props.sourceHashesVerified && <p className={styles.notice} role="status">Saving and importing are disabled until both loaded GLB files have verified SHA-256 values.</p>}
            <button className={styles.primaryButton} type="button" disabled={!canSave} onClick={props.onSavePreset}>Save new pose preset</button>
            {props.presets.length > 0 && <div className={styles.presetLoad}>
              <label className={styles.field} htmlFor="rigged-pose-preset-select">
                <span>Saved presets for these GLB files</span>
                <select id="rigged-pose-preset-select" value={props.selectedPresetId} disabled={props.busy} onChange={event => props.onPresetChange(event.currentTarget.value)}>
                  {props.presets.map(preset => <option key={preset.presetId} value={preset.presetId}>{presetOptionLabels.get(preset.presetId) ?? preset.name}</option>)}
                </select>
              </label>
              {selectedPreset && <div className={styles.presetIdentity} aria-label="Selected saved preset">
                <span>Selected saved preset</span>
                <strong>{selectedPreset.name}</strong>
                <code>ID: {selectedPreset.presetId}</code>
              </div>}
              {selectedPreset && <div className={styles.renamePreset}>
                <label className={styles.field} htmlFor="rigged-pose-preset-rename">
                  <span>Rename selected preset</span>
                  <input
                    id="rigged-pose-preset-rename"
                    type="text"
                    maxLength={120}
                    value={props.renamePresetName}
                    disabled={props.busy}
                    onChange={event => props.onRenamePresetNameChange(event.currentTarget.value)}
                  />
                </label>
                <button type="button" className={styles.secondaryButton} disabled={!canApply || props.renamePresetName.trim().length === 0} onClick={props.onRenamePreset}>Rename selected preset</button>
              </div>}
              <div className={styles.presetActions}>
                <button type="button" className={styles.secondaryButton} disabled={!canApply} onClick={props.onApplyPreset}>Apply preset to this pose</button>
                <button type="button" className={styles.secondaryButton} disabled={!canApply} onClick={props.onExportPreset}>Download preset as JSON</button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={!canApply}
                  onClick={() => {
                    if (selectedPreset && confirmPresetAction("update", selectedPreset)) props.onReplacePreset();
                  }}
                >Update selected preset from current pose</button>
                <button
                  type="button"
                  className={styles.dangerButton}
                  disabled={!canApply}
                  onClick={() => {
                    if (selectedPreset && confirmPresetAction("delete", selectedPreset)) props.onDeletePreset();
                  }}
                >Delete selected preset</button>
              </div>
            </div>}
            <label className={`${styles.field} ${styles.importPreset}`} htmlFor="rigged-pose-preset-import">
              <span>Import pose preset JSON · creates a new saved preset</span>
              <input
                id="rigged-pose-preset-import"
                type="file"
                accept=".json,application/json"
                disabled={props.busy || !props.sourceHashesVerified}
                onChange={event => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  input.value = "";
                  if (file) void props.onImportPresetFile(file);
                }}
              />
            </label>
          </div>
        </>
      )}

      {props.status && <p className={styles.status} role="status">{props.status}</p>}
      {props.error && <p className={styles.error} role="alert">{props.error}</p>}
    </section>
  );
}

function findAvailableIndex(
  timepoints: readonly RiggedPoseEditTimepoint[],
  availability: Readonly<Record<string, RiggedPoseEditAvailability>>,
  currentIndex: number,
  direction: -1 | 1,
): number {
  for (let index = currentIndex + direction; index >= 0 && index < timepoints.length; index += direction) {
    if (availability[timepoints[index]!.id]?.available) return index;
  }
  return -1;
}

function normalizePresetName(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

function presetOptionLabel(
  preset: RiggedPoseEditorPresetSummary,
  presets: readonly RiggedPoseEditorPresetSummary[],
): string {
  const sameName = presets.filter(candidate => normalizePresetName(candidate.name) === normalizePresetName(preset.name));
  if (sameName.length < 2) return preset.name;
  const dateTime = new Date(preset.createdAtUnixMs).toLocaleString();
  const shortId = uniqueShortPresetId(preset.presetId, sameName);
  return `${preset.name} · ${dateTime} · ${shortId}`;
}

function uniqueShortPresetId(presetId: string, sameName: readonly RiggedPoseEditorPresetSummary[]): string {
  let length = Math.min(8, presetId.length);
  while (length < presetId.length && sameName.some(candidate =>
    candidate.presetId !== presetId && candidate.presetId.slice(0, length) === presetId.slice(0, length))) {
    length += 1;
  }
  return presetId.slice(0, length);
}

function confirmPresetAction(action: "update" | "delete", preset: RiggedPoseEditorPresetSummary): boolean {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return false;
  const message = action === "update"
    ? `Update saved preset “${preset.name}” (ID: ${preset.presetId}) from the current hand pose? Its name and ID will stay the same.`
    : `Delete saved preset “${preset.name}” (ID: ${preset.presetId}) from this browser? This cannot be undone.`;
  return window.confirm(message);
}

function displayPosition(point: RiggedPoseEditTimepoint, index: number, total: number): string {
  return point.kind === "lead-in-held" ? "Lead-in · first pose held" : `Pose ${index + 1} of ${total}`;
}

function formatPoseTime(seconds: number): string {
  const sign = seconds < 0 ? "−" : "";
  const absolute = Math.abs(seconds);
  const minutes = Math.floor(absolute / 60);
  const remainder = absolute - minutes * 60;
  return `${sign}${minutes}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function formatSource(source: RiggedPoseEditSampleSource | null): string {
  if (!source || source.sampleMode === "unavailable") return "Unavailable";
  if (source.sampleMode === "held-first" && source.sourcePoseTimeSeconds !== null) {
    return `first held at ${formatPoseTime(source.sourcePoseTimeSeconds)}`;
  }
  if (source.sampleMode === "exact" && source.sourcePoseTimeSeconds !== null) {
    return formatPoseTime(source.sourcePoseTimeSeconds);
  }
  if (source.sourcePoseTimeStartSeconds !== null && source.sourcePoseTimeEndSeconds !== null) {
    return `${formatPoseTime(source.sourcePoseTimeStartSeconds)}–${formatPoseTime(source.sourcePoseTimeEndSeconds)} (interpolated)`;
  }
  return "Unavailable";
}

function availabilityText(reason: RiggedPoseEditAvailability["reason"]): string {
  switch (reason) {
    case "no-3d-scene": return "the 3D piano scene is not active";
    case "model-mismatch": return "Rigged Experimental is not selected";
    case "hand-not-ready": return "both Rigged Experimental hands are still loading";
    case "sample-unavailable": return "the MotionPlan or buffer has no sample for both hands";
    default: return "the sample is unavailable";
  }
}
