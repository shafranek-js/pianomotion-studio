import { PRACTICE_MIN_LOOP_SECONDS, type PracticeLoop } from "@handthesia/contracts";
import { Check, Hand, ListMusic, Music, Repeat, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { PlayAlongHandMode, PlayAlongState, PlayAlongStep } from "../player/playAlongEngine";
import { clampDraggedLoopRange, computeLoopOverlayMetrics, roundLoopSeconds, type TransportBookmarkPin } from "./StudioTransport";
import "./workspace.css";

export interface PlayAlongTransportProps {
  currentStepIndex: number;
  totalSteps: number;
  step: PlayAlongStep | null;
  state: PlayAlongState;
  handMode: PlayAlongHandMode;
  heldUserPitches: ReadonlySet<number>;
  completedPitchesInStep: ReadonlySet<number>;
  onHandModeChange: (mode: PlayAlongHandMode) => void;
  onPreviousStep: () => void;
  onNextStep: () => void;
  onRestart: () => void;
  midiConnected: boolean;
  midiDeviceName?: string;
  midiPermission?: "prompt" | "granted" | "denied" | "unsupported";
  onConnectMidi?: () => void;
  autoPlayOtherHand: boolean;
  onAutoPlayOtherHandChange: (enabled: boolean) => void;
  currentTime?: number;
  duration?: number;
  bpm?: number;
  beatsPerBar?: number;
  onSeekTime?: (timeSeconds: number) => void;
  practiceLoop?: PracticeLoop | null;
  practiceBookmarks?: readonly TransportBookmarkPin[];
  onLoopChange?: (startSeconds: number, endSeconds: number, enabled: boolean) => void;
  onToggleLoop?: () => void;
  onJumpToBookmark?: (bookmarkId: string) => void;
  chordsEnabled?: boolean;
  onToggleChords?: () => void;
  staffEnabled?: boolean;
  onToggleStaff?: () => void;
}

const PITCH_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

function pitchToName(pitch: number): string {
  const name = PITCH_NAMES[pitch % 12] ?? "C";
  const octave = Math.floor(pitch / 12) - 1;
  return `${name}${octave}`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const safeSeconds = Math.floor(Math.max(0, seconds));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

function formatPreciseLoopTime(seconds: number, bpm?: number, beatsPerBar = 4): string {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const clamped = Math.max(0, seconds);
  const mins = Math.floor(clamped / 60);
  const secs = (clamped % 60).toFixed(1).padStart(4, "0");
  if (bpm && bpm > 0) {
    const barDuration = (60 / bpm) * beatsPerBar;
    const barNum = Math.floor(clamped / barDuration) + 1;
    return `${mins}:${secs} · Bar ${barNum}`;
  }
  return `${mins}:${secs}`;
}

export function PlayAlongTransport({
  currentStepIndex,
  totalSteps,
  step,
  state,
  handMode,
  heldUserPitches,
  completedPitchesInStep,
  onHandModeChange,
  onPreviousStep,
  onNextStep,
  onRestart,
  midiConnected,
  midiDeviceName,
  midiPermission,
  onConnectMidi,
  autoPlayOtherHand,
  onAutoPlayOtherHandChange,
  currentTime = 0,
  duration = 0,
  bpm,
  beatsPerBar = 4,
  onSeekTime,
  practiceLoop = null,
  practiceBookmarks = [],
  onLoopChange,
  onToggleLoop,
  onJumpToBookmark,
  chordsEnabled = false,
  onToggleChords,
  staffEnabled = false,
  onToggleStaff,
}: PlayAlongTransportProps) {
  const progressPercent = totalSteps > 0 ? Math.round(((currentStepIndex + 1) / totalSteps) * 100) : 0;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<"start" | "end" | null>(null);
  const [hoveredHandle, setHoveredHandle] = useState<"start" | "end" | null>(null);

  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const seekMin = 0;
  const seekMax = Math.max(safeDuration, 0.01);
  const seekSpan = Math.max(0.01, seekMax - seekMin);
  const effectiveTime = step?.timeSeconds ?? currentTime;
  const seekValue = Math.max(seekMin, Math.min(seekMax, Number.isFinite(effectiveTime) ? effectiveTime : 0));

  const canEditLoop = Boolean(onLoopChange) && safeDuration >= PRACTICE_MIN_LOOP_SECONDS;
  const loopMetrics = computeLoopOverlayMetrics(practiceLoop, safeDuration, seekMin, seekMax);
  const hasCustomLoopBounds = Boolean(
    practiceLoop && (practiceLoop.startSeconds > 0.01 || practiceLoop.endSeconds < safeDuration - 0.01 || practiceLoop.enabled),
  );

  const clientXToSeconds = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.max(0, Math.min(safeDuration, ratio * seekSpan));
  };

  const applyHandleDrag = (handle: "start" | "end", candidateSeconds: number) => {
    if (!canEditLoop || !onLoopChange) return;
    const clamped = clampDraggedLoopRange(
      handle,
      candidateSeconds,
      loopMetrics.startSeconds,
      loopMetrics.endSeconds,
      safeDuration,
    );
    const shouldEnable = practiceLoop ? practiceLoop.enabled || !hasCustomLoopBounds : true;
    onLoopChange(clamped.startSeconds, clamped.endSeconds, shouldEnable);
  };

  const handleBracketPointerDown = (handle: "start" | "end", event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canEditLoop) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingHandle(handle);
    applyHandleDrag(handle, clientXToSeconds(event.clientX));
  };

  const handleBracketPointerMove = (handle: "start" | "end", event: ReactPointerEvent<HTMLButtonElement>) => {
    if (draggingHandle !== handle || !canEditLoop) return;
    event.preventDefault();
    event.stopPropagation();
    applyHandleDrag(handle, clientXToSeconds(event.clientX));
  };

  const handleBracketPointerUp = (handle: "start" | "end", event: ReactPointerEvent<HTMLButtonElement>) => {
    if (draggingHandle !== handle) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingHandle(null);
  };

  const handleBracketKeyDown = (handle: "start" | "end", event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!canEditLoop) return;
    const stepSec = event.shiftKey ? 1.0 : 0.25;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      const base = handle === "start" ? loopMetrics.startSeconds : loopMetrics.endSeconds;
      applyHandleDrag(handle, base - stepSec);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      const base = handle === "start" ? loopMetrics.startSeconds : loopMetrics.endSeconds;
      applyHandleDrag(handle, base + stepSec);
    }
  };

  return (
    <section className="studio-transport-controls studio-play-along-controls" aria-label="Play along practice controls">
      {/* 1. Step Navigation Buttons */}
      <div className="studio-transport-controls__buttons">
        <button
          className="studio-transport-controls__button"
          type="button"
          onClick={onRestart}
          title="Restart from beginning (Step 1)"
          aria-label="Restart from beginning"
        >
          <RotateCcw size={16} aria-hidden="true" />
          <span>Restart</span>
        </button>

        <button
          className="studio-transport-controls__button"
          type="button"
          onClick={onPreviousStep}
          disabled={currentStepIndex <= 0}
          title="Previous chord step"
          aria-label="Previous step"
        >
          <SkipBack size={16} aria-hidden="true" />
          <span>Prev</span>
        </button>

        <button
          className="studio-transport-controls__button"
          type="button"
          onClick={onNextStep}
          disabled={currentStepIndex >= totalSteps - 1}
          title="Next chord step"
          aria-label="Next step"
        >
          <SkipForward size={16} aria-hidden="true" />
          <span>Next</span>
        </button>
      </div>

      {/* 2. Step Counter & Target Notes Display */}
      <div className="studio-play-along-center" style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", whiteSpace: "nowrap" }}>
          <span style={{ fontSize: "11px", color: "var(--studio-muted)", fontWeight: 600 }}>
            Step {totalSteps > 0 ? currentStepIndex + 1 : 0} of {totalSteps} ({progressPercent}%)
          </span>
          <div style={{ width: "100px", height: "4px", background: "#2a3038", borderRadius: "2px", overflow: "hidden" }}>
            <div style={{ width: `${progressPercent}%`, height: "100%", background: "var(--studio-accent)", transition: "width 150ms ease" }} />
          </div>
        </div>

        {/* Target Notes Badges */}
        <div
          className="studio-play-along-targets"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            overflowX: "auto",
            padding: "2px 4px",
          }}
          aria-live="polite"
        >
          {state === "completed" ? (
            <span style={{ color: "#34d399", fontWeight: 600, fontSize: "12px" }}>
              🎉 Piece completed! Great job!
            </span>
          ) : step && step.activePitches.size > 0 ? (
            step.notes
              .filter((note) => step.activePitches.has(note.pitch))
              .map((note) => {
                const isHeld = heldUserPitches.has(note.pitch);
                const isHit = completedPitchesInStep.has(note.pitch);
                const handColor = note.hand === "left" ? "#60a5fa" : "#34d399";
                const activeBg = isHeld
                  ? note.hand === "left" ? "#1e3a8a" : "#064e3b"
                  : isHit
                    ? note.hand === "left" ? "#1e293b" : "#06281e"
                    : "#1c2127";
                const border = isHeld
                  ? `2px solid ${handColor}`
                  : isHit
                    ? `1px solid ${handColor}`
                    : "1px solid #374151";

                return (
                  <span
                    key={note.noteId}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "2px 8px",
                      borderRadius: "6px",
                      background: activeBg,
                      border,
                      color: isHeld ? "#ffffff" : isHit ? handColor : "#e5e7eb",
                      fontSize: "12px",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                    title={`${note.hand === "left" ? "Left hand" : "Right hand"} finger ${note.finger ?? "any"}`}
                  >
                    {isHeld && <Check size={12} strokeWidth={3} aria-hidden="true" />}
                    <span>{pitchToName(note.pitch)}</span>
                    <span style={{ fontSize: "10px", opacity: 0.8, color: handColor }}>
                      {note.hand === "left" ? "LH" : "RH"}{note.finger ? ` ${note.finger}` : ""}
                    </span>
                  </span>
                );
              })
          ) : (
            <span style={{ color: "var(--studio-muted)", fontSize: "12px" }}>
              Waiting...
            </span>
          )}
        </div>

        {/* Interactive DAW Timeline with [ and ] A–B Loop Handles */}
        {safeDuration > 0 && (
          <div className="studio-transport-controls__seek" style={{ flex: "1 1 220px", minWidth: "180px" }}>
            <span className="studio-transport-controls__time">
              {formatTime(effectiveTime)}
            </span>
            <div
              ref={trackRef}
              className={`studio-transport-controls__seek-track ${loopMetrics.enabled ? "has-active-loop" : ""} ${draggingHandle ? "is-dragging-loop" : ""}`}
            >
              {onLoopChange && safeDuration >= PRACTICE_MIN_LOOP_SECONDS && (
                <div className="studio-transport-controls__loop-overlay" aria-hidden="false">
                  <div
                    className={`studio-transport-controls__loop-range ${loopMetrics.enabled ? "is-enabled" : hasCustomLoopBounds ? "is-draft" : "is-idle"}`}
                    style={{
                      left: `${loopMetrics.startPercent}%`,
                      width: `${loopMetrics.widthPercent}%`,
                    }}
                    onDoubleClick={() => onToggleLoop?.()}
                    title={loopMetrics.enabled ? "Active A–B loop (double-click to toggle)" : "A–B loop range (double-click to enable)"}
                    data-testid="transport-loop-range"
                  />
                  <button
                    type="button"
                    role="slider"
                    aria-label="Loop start (A)"
                    aria-valuemin={0}
                    aria-valuemax={roundLoopSeconds(Math.max(0, loopMetrics.endSeconds - PRACTICE_MIN_LOOP_SECONDS))}
                    aria-valuenow={roundLoopSeconds(loopMetrics.startSeconds)}
                    aria-valuetext={`A: ${formatPreciseLoopTime(loopMetrics.startSeconds, bpm, beatsPerBar)}`}
                    disabled={!canEditLoop}
                    className={`studio-transport-controls__loop-handle studio-transport-controls__loop-handle--start ${
                      loopMetrics.enabled ? "is-enabled" : hasCustomLoopBounds ? "is-draft" : ""
                    } ${draggingHandle === "start" ? "is-dragging" : ""}`}
                    style={{ left: `${loopMetrics.startPercent}%` }}
                    onPointerDown={(e) => handleBracketPointerDown("start", e)}
                    onPointerMove={(e) => handleBracketPointerMove("start", e)}
                    onPointerUp={(e) => handleBracketPointerUp("start", e)}
                    onPointerCancel={(e) => handleBracketPointerUp("start", e)}
                    onKeyDown={(e) => handleBracketKeyDown("start", e)}
                    onMouseEnter={() => setHoveredHandle("start")}
                    onMouseLeave={() => setHoveredHandle((prev) => (prev === "start" ? null : prev))}
                    title={`Drag [ to set Loop Start A (${formatPreciseLoopTime(loopMetrics.startSeconds, bpm, beatsPerBar)})`}
                    data-testid="transport-loop-handle-start"
                  >
                    <span className="studio-transport-controls__loop-bracket" aria-hidden="true">[</span>
                    {(draggingHandle === "start" || hoveredHandle === "start") && (
                      <span className="studio-transport-controls__loop-tooltip" aria-hidden="true">
                        A · {formatPreciseLoopTime(loopMetrics.startSeconds, bpm, beatsPerBar)}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    role="slider"
                    aria-label="Loop end (B)"
                    aria-valuemin={roundLoopSeconds(Math.min(safeDuration, loopMetrics.startSeconds + PRACTICE_MIN_LOOP_SECONDS))}
                    aria-valuemax={roundLoopSeconds(safeDuration)}
                    aria-valuenow={roundLoopSeconds(loopMetrics.endSeconds)}
                    aria-valuetext={`B: ${formatPreciseLoopTime(loopMetrics.endSeconds, bpm, beatsPerBar)}`}
                    disabled={!canEditLoop}
                    className={`studio-transport-controls__loop-handle studio-transport-controls__loop-handle--end ${
                      loopMetrics.enabled ? "is-enabled" : hasCustomLoopBounds ? "is-draft" : ""
                    } ${draggingHandle === "end" ? "is-dragging" : ""}`}
                    style={{ left: `${loopMetrics.endPercent}%` }}
                    onPointerDown={(e) => handleBracketPointerDown("end", e)}
                    onPointerMove={(e) => handleBracketPointerMove("end", e)}
                    onPointerUp={(e) => handleBracketPointerUp("end", e)}
                    onPointerCancel={(e) => handleBracketPointerUp("end", e)}
                    onKeyDown={(e) => handleBracketKeyDown("end", e)}
                    onMouseEnter={() => setHoveredHandle("end")}
                    onMouseLeave={() => setHoveredHandle((prev) => (prev === "end" ? null : prev))}
                    title={`Drag ] to set Loop End B (${formatPreciseLoopTime(loopMetrics.endSeconds, bpm, beatsPerBar)})`}
                    data-testid="transport-loop-handle-end"
                  >
                    <span className="studio-transport-controls__loop-bracket" aria-hidden="true">]</span>
                    {(draggingHandle === "end" || hoveredHandle === "end") && (
                      <span className="studio-transport-controls__loop-tooltip" aria-hidden="true">
                        B · {formatPreciseLoopTime(loopMetrics.endSeconds, bpm, beatsPerBar)}
                      </span>
                    )}
                  </button>
                  {practiceBookmarks.map((bm) => {
                    const pct = Math.max(0, Math.min(100, ((bm.timeSeconds - seekMin) / seekSpan) * 100));
                    return (
                      <button
                        key={bm.id}
                        type="button"
                        className="studio-transport-controls__bookmark-pin"
                        style={{ left: `${pct}%` }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onJumpToBookmark?.(bm.id);
                        }}
                        aria-label={`Jump to bookmark ${bm.name} (${formatTime(bm.timeSeconds)})`}
                        title={`Bookmark: ${bm.name} (${formatTime(bm.timeSeconds)})`}
                        data-testid="transport-bookmark-pin"
                      />
                    );
                  })}
                </div>
              )}
              <input
                id="play-along-seek-slider"
                type="range"
                min={seekMin}
                max={seekMax}
                step={0.05}
                value={seekValue}
                onChange={(event: ChangeEvent<HTMLInputElement>) => onSeekTime?.(Number(event.currentTarget.value))}
                aria-label="Play-along timeline position"
              />
            </div>
            <span className="studio-transport-controls__time">
              {formatTime(safeDuration)}
            </span>
          </div>
        )}
      </div>

      {/* 3. Hand Mode Selector & MIDI Input Status */}
      <div className="studio-transport-controls__options" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
        {onToggleLoop && (
          <button
            id="play-along-loop-toggle"
            type="button"
            className={`studio-transport-controls__toggle-btn ${loopMetrics.enabled ? "is-active" : ""}`}
            aria-pressed={loopMetrics.enabled}
            onClick={onToggleLoop}
            disabled={safeDuration < PRACTICE_MIN_LOOP_SECONDS}
            title="Toggle A–B practice loop (drag [ and ] on timeline to adjust)"
          >
            <Repeat size={14} aria-hidden="true" />
            <span>Loop</span>
          </button>
        )}
        {onToggleChords && (
          <button
            type="button"
            className={`studio-transport-controls__toggle-btn ${chordsEnabled ? "is-active" : ""}`}
            aria-pressed={chordsEnabled}
            onClick={onToggleChords}
            title="Show or hide the real-time chord timeline bar"
          >
            <Music size={14} aria-hidden="true" />
            <span>Chords</span>
          </button>
        )}
        {onToggleStaff && (
          <button
            type="button"
            className={`studio-transport-controls__toggle-btn ${staffEnabled ? "is-active" : ""}`}
            aria-pressed={staffEnabled}
            onClick={onToggleStaff}
            title="Show or hide the horizontal grand-staff notation bar"
          >
            <ListMusic size={14} aria-hidden="true" />
            <span>Staff</span>
          </button>
        )}
        {/* Hand practice mode: Left | Both | Right */}
        <div
          role="group"
          aria-label="Hand practice mode"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "2px",
            borderRadius: "6px",
            background: "#1c2127",
            border: "1px solid #374151",
            padding: "2px",
          }}
        >
          {(["left", "both", "right"] as const).map((mode) => {
            const active = handMode === mode;
            const label =
              mode === "left" ? "Left hand" : mode === "both" ? "Both hands" : "Right hand";
            const tooltip =
              mode === "left"
                ? "Practice left hand only"
                : mode === "both"
                  ? "Practice both hands"
                  : "Practice right hand only";

            return (
              <button
                key={mode}
                type="button"
                aria-label={label}
                aria-pressed={active}
                onClick={() => onHandModeChange(mode)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "4px",
                  padding: "3px 8px",
                  fontSize: "11px",
                  fontWeight: active ? 600 : 500,
                  color: active ? "#ffffff" : "var(--studio-muted)",
                  background: active ? "#374151" : "transparent",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  lineHeight: 1,
                }}
                title={tooltip}
              >
                {mode === "left" && (
                  <>
                    <Hand
                      size={14}
                      aria-hidden="true"
                      style={{
                        transform: "scaleX(-1)",
                        color: active ? "#60a5fa" : "currentColor",
                      }}
                    />
                    <span style={{ fontSize: "10px", opacity: active ? 1 : 0.8 }}>L</span>
                  </>
                )}
                {mode === "both" && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
                    <Hand
                      size={14}
                      aria-hidden="true"
                      style={{
                        transform: "scaleX(-1)",
                        color: active ? "#60a5fa" : "currentColor",
                      }}
                    />
                    <Hand
                      size={14}
                      aria-hidden="true"
                      style={{
                        color: active ? "#34d399" : "currentColor",
                      }}
                    />
                  </span>
                )}
                {mode === "right" && (
                  <>
                    <span style={{ fontSize: "10px", opacity: active ? 1 : 0.8 }}>R</span>
                    <Hand
                      size={14}
                      aria-hidden="true"
                      style={{
                        color: active ? "#34d399" : "currentColor",
                      }}
                    />
                  </>
                )}
              </button>
            );
          })}
        </div>

        {/* Auto play other hand when isolated */}
        {handMode !== "both" && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "var(--studio-muted)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={autoPlayOtherHand}
              onChange={(e) => onAutoPlayOtherHandChange(e.target.checked)}
            />
            Auto-play other hand
          </label>
        )}

        {/* MIDI Connection Indicator / Button */}
        {midiConnected ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "2px 8px",
              background: "#06281e",
              border: "1px solid #059669",
              borderRadius: "4px",
              fontSize: "11px",
              color: "#34d399",
              fontWeight: 600,
            }}
            title={`Connected to ${midiDeviceName || "MIDI Input"}`}
          >
            <Music size={12} aria-hidden="true" />
            <span>MIDI: {midiDeviceName ? (midiDeviceName.length > 16 ? midiDeviceName.slice(0, 14) + "…" : midiDeviceName) : "Connected"}</span>
          </span>
        ) : (
          <button
            type="button"
            onClick={onConnectMidi}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "2px 8px",
              background: "#1c2127",
              border: "1px solid #4b5563",
              borderRadius: "4px",
              fontSize: "11px",
              color: "var(--studio-muted)",
              cursor: "pointer",
            }}
            title={
              midiPermission === "granted"
                ? "MIDI access granted. Turn on or plug in your keyboard, or click to re-scan."
                : "Connect USB/Bluetooth MIDI keyboard"
            }
          >
            <Music size={12} aria-hidden="true" />
            <span>{midiPermission === "granted" ? "Rescan MIDI" : "Connect MIDI"}</span>
          </button>
        )}
      </div>
    </section>
  );
}
