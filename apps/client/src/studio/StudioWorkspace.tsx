import type { ReactNode } from "react";
import type { Camera3DPreset } from "../render";
import { CAMERA_PRESETS, type StudioView } from "./types";
import "./workspace.css";

export interface StudioWorkspaceProps {
  viewMode: StudioView;
  /** The single persistent Pixi/Three scene containing notes, piano, and hands. */
  scene: ReactNode;
  /** Persistent editor state host, kept mounted without adding a visible row. */
  editorState?: ReactNode;
  editorViewTime?: number | null;
  transportTime?: number;
  onReturnToPlayhead?(): void;
  waveform?: ReactNode;
  is3DView?: boolean;
  onToggle3DView?: (enabled: boolean) => void;
  camera3DPreset?: Camera3DPreset;
  onCamera3DPresetChange?: (preset: Camera3DPreset) => void;
  showCameraHud?: boolean;
}

function formatAnchorTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const sign = seconds < 0 ? "−" : "";
  const value = Math.abs(seconds);
  return `${sign}${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}.${Math.floor((value % 1) * 10)}`;
}

export function StudioWorkspace({
  viewMode,
  scene,
  editorState,
  editorViewTime = null,
  transportTime = 0,
  onReturnToPlayhead,
  waveform,
  is3DView = false,
  onToggle3DView,
  camera3DPreset = "concert",
  onCamera3DPresetChange,
  showCameraHud = true,
}: StudioWorkspaceProps) {
  return (
    <section
      className={`studio-workspace-layout studio-workspace-layout--${viewMode}`}
      data-testid="studio-workspace"
      data-view={viewMode}
    >
      {editorState && (
        <div
          className="studio-workspace-layout__editor-state"
          data-testid="studio-editor-state"
          aria-hidden="true"
          hidden
        >
          {editorState}
        </div>
      )}
      <div
        className="studio-workspace-layout__scene-content"
        data-testid="studio-scene-pane"
        aria-label={viewMode === "editor" ? "Fingering workspace" : "Piano performance scene"}
      >
        {viewMode === "editor" && (
          <div className="studio-workspace-layout__time-anchor" data-testid="studio-time-anchor">
            <span>{editorViewTime === null ? "Following playhead" : `View ${formatAnchorTime(editorViewTime)}`}</span>
            <button type="button" onClick={onReturnToPlayhead} disabled={editorViewTime === null} aria-label="Return to playhead">
              Return to playhead
            </button>
            {editorViewTime !== null && editorViewTime !== transportTime && (
              <span className="studio-workspace-layout__playhead-time">Playhead {formatAnchorTime(transportTime)}</span>
            )}
          </div>
        )}
        {showCameraHud && viewMode !== "editor" && onToggle3DView && (
          <div
            className="studio-workspace-layout__camera-hud"
            data-testid="studio-camera-hud"
            role="toolbar"
            aria-label="Scene dimension and camera controls"
          >
            <div className="studio-camera-hud__mode-group" role="group" aria-label="Dimension mode">
              <button
                type="button"
                className={`studio-camera-hud__btn ${!is3DView ? "is-active" : ""}`}
                aria-pressed={!is3DView}
                onClick={() => onToggle3DView(false)}
                title="2D top-down view"
              >
                2D
              </button>
              <button
                type="button"
                className={`studio-camera-hud__btn ${is3DView ? "is-active" : ""}`}
                aria-pressed={is3DView}
                onClick={() => onToggle3DView(true)}
                title="3D realistic view (Three.js)"
              >
                3D
              </button>
            </div>
            {is3DView && onCamera3DPresetChange && (
              <div className="studio-camera-hud__preset-group" role="group" aria-label="3D camera presets">
                {CAMERA_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`studio-camera-hud__btn ${camera3DPreset === preset.id ? "is-active" : ""}`}
                    aria-pressed={camera3DPreset === preset.id}
                    onClick={() => onCamera3DPresetChange(preset.id)}
                    title={preset.title}
                  >
                    <span className="studio-camera-hud__btn-full">{preset.label}</span>
                    <span className="studio-camera-hud__btn-short">{preset.shortLabel}</span>
                  </button>
                ))}
              </div>
            )}
            {is3DView && onCamera3DPresetChange && (
              <label className="studio-camera-hud__mobile-preset">
                <span className="studio-sr-only">3D camera preset</span>
                <select
                  aria-label="3D camera preset"
                  value={camera3DPreset}
                  onChange={(event) => {
                    const preset = CAMERA_PRESETS.find(({ id }) => id === event.currentTarget.value)?.id;
                    if (preset) onCamera3DPresetChange(preset);
                  }}
                >
                  {CAMERA_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.label}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {scene}
      </div>
      {waveform && <div className="studio-workspace-layout__waveform">{waveform}</div>}
    </section>
  );
}

