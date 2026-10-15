import type { ReactNode } from "react";
import type { StudioView } from "./types";
import "./workspace.css";

export interface StudioWorkspaceProps {
  viewMode: StudioView;
  /** The single persistent Pixi scene containing notes, piano, and hands. */
  scene: ReactNode;
  /** Persistent editor state host, kept mounted without adding a visible row. */
  editorState?: ReactNode;
  editorViewTime?: number | null;
  transportTime?: number;
  onReturnToPlayhead?(): void;
  waveform?: ReactNode;
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
        {scene}
      </div>
      {waveform && <div className="studio-workspace-layout__waveform">{waveform}</div>}
    </section>
  );
}
