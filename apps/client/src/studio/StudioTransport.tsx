import { PRACTICE_MIN_LOOP_SECONDS, type PracticeLoop } from "@handthesia/contracts";
import { AudioLines, ChevronLeft, ChevronRight, Gauge, ListMusic, Metronome, Music, Pause, Play, Repeat, SkipBack, Square, Timer, Volume2 } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import type { AccompanimentTrackInfo } from "../audio/accompaniment";
import "./workspace.css";

export interface TransportBookmarkPin {
  id: string;
  name: string;
  timeSeconds: number;
}

export interface StudioTransportProps {
  playing: boolean;
  currentTime: number;
  duration: number;
  leadInSeconds: number;
  speed: number;
  volume: number;
  onTogglePlay(): void;
  onStop(): void;
  onSeek(time: number): void;
  onSpeedChange(speed: number): void;
  onVolumeChange(volume: number): void;
  disabled?: boolean;
  playDisabled?: boolean;
  countInBeat?: number | null;
  onFirstNote?(): void;
  onPrevBar?(): void;
  onNextBar?(): void;
  currentBar?: number;
  totalBars?: number;
  bpm?: number;
  beatsPerBar?: number;
  countInEnabled?: boolean;
  onToggleCountIn?(): void;
  metronomeEnabled?: boolean;
  onToggleMetronome?(): void;
  chordsEnabled?: boolean;
  onToggleChords?(): void;
  staffEnabled?: boolean;
  onToggleStaff?(): void;
  practiceLoop?: PracticeLoop | null;
  practiceBookmarks?: readonly TransportBookmarkPin[];
  onLoopChange?(startSeconds: number, endSeconds: number, enabled: boolean): void;
  onToggleLoop?(): void;
  onJumpToBookmark?(bookmarkId: string): void;
  accompanimentTracks?: readonly AccompanimentTrackInfo[];
  accompanimentEnabled?: boolean;
  accompanimentVolume?: number;
  onToggleAccompaniment?(): void;
  onAccompanimentVolumeChange?(volume: number): void;
}

export interface LoopOverlayMetrics {
  startSeconds: number;
  endSeconds: number;
  enabled: boolean;
  startPercent: number;
  endPercent: number;
  widthPercent: number;
}

export function roundLoopSeconds(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function computeLoopOverlayMetrics(
  loop: PracticeLoop | null | undefined,
  duration: number,
  seekMin: number,
  seekMax: number,
): LoopOverlayMetrics {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const span = Math.max(0.01, seekMax - seekMin);
  const startSeconds = Math.max(0, Math.min(safeDuration, loop?.startSeconds ?? 0));
  const endSeconds = Math.max(startSeconds, Math.min(safeDuration, loop?.endSeconds ?? safeDuration));
  const startPercent = Math.max(0, Math.min(100, ((startSeconds - seekMin) / span) * 100));
  const endPercent = Math.max(startPercent, Math.min(100, ((endSeconds - seekMin) / span) * 100));
  return {
    startSeconds,
    endSeconds,
    enabled: Boolean(loop?.enabled),
    startPercent,
    endPercent,
    widthPercent: Math.max(0, endPercent - startPercent),
  };
}

export function clampDraggedLoopRange(
  handle: "start" | "end",
  candidateSeconds: number,
  currentStartSeconds: number,
  currentEndSeconds: number,
  durationSeconds: number,
): { startSeconds: number; endSeconds: number } {
  const safeDuration = Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0);
  const minGap = Math.min(PRACTICE_MIN_LOOP_SECONDS, safeDuration);
  if (handle === "start") {
    const maxStart = Math.max(0, currentEndSeconds - minGap);
    const startSeconds = roundLoopSeconds(Math.max(0, Math.min(maxStart, candidateSeconds)));
    return {
      startSeconds,
      endSeconds: roundLoopSeconds(Math.max(startSeconds + minGap, currentEndSeconds)),
    };
  }
  const minEnd = Math.min(safeDuration, currentStartSeconds + minGap);
  const endSeconds = roundLoopSeconds(Math.max(minEnd, Math.min(safeDuration, candidateSeconds)));
  return {
    startSeconds: roundLoopSeconds(Math.min(currentStartSeconds, endSeconds - minGap)),
    endSeconds,
  };
}

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const sign = seconds < 0 ? "−" : "";
  const safeSeconds = Math.floor(Math.abs(seconds));
  return `${sign}${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
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

// Render outside the scrolling transport and clipped studio shell. Coordinates stay
// in the viewport coordinate system used by getBoundingClientRect().
function LoopHandleTooltip({ anchorRef, label, positionPercent }: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  label: string;
  positionPercent: number;
}) {
  const tooltipRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) return;

    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      const { width, height } = tooltip.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - width / 2, viewportWidth - width - margin));
      const above = rect.top - height - gap;
      const top = Math.max(margin, Math.min(above >= margin ? above : rect.bottom + gap, viewportHeight - height - margin));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      tooltip.style.visibility = "visible";
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    const observer = new ResizeObserver(updatePosition);
    observer.observe(anchor);
    observer.observe(tooltip);
    // The timeline can resize while the handle itself keeps the same dimensions.
    if (anchor.parentElement) observer.observe(anchor.parentElement);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      observer.disconnect();
    };
  }, [anchorRef, label, positionPercent]);

  return createPortal(
    <span ref={tooltipRef} className="studio-transport-controls__loop-tooltip" aria-hidden="true">{label}</span>,
    document.body,
  );
}

export function StudioTransport({
  playing,
  currentTime,
  duration,
  leadInSeconds,
  speed,
  volume,
  onTogglePlay,
  onStop,
  onSeek,
  onSpeedChange,
  onVolumeChange,
  disabled = false,
  playDisabled = false,
  countInBeat = null,
  onFirstNote,
  onPrevBar,
  onNextBar,
  currentBar,
  totalBars,
  bpm,
  beatsPerBar = 4,
  countInEnabled = false,
  onToggleCountIn,
  metronomeEnabled = false,
  onToggleMetronome,
  chordsEnabled = false,
  onToggleChords,
  staffEnabled = false,
  onToggleStaff,
  practiceLoop = null,
  practiceBookmarks = [],
  onLoopChange,
  onToggleLoop,
  onJumpToBookmark,
  accompanimentTracks = [],
  accompanimentEnabled = true,
  accompanimentVolume = 0.65,
  onToggleAccompaniment,
  onAccompanimentVolumeChange,
}: StudioTransportProps) {
  const { dict } = useI18n();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const startHandleRef = useRef<HTMLButtonElement | null>(null);
  const endHandleRef = useRef<HTMLButtonElement | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<"start" | "end" | null>(null);
  const [hoveredHandle, setHoveredHandle] = useState<"start" | "end" | null>(null);
  const [focusedHandle, setFocusedHandle] = useState<"start" | "end" | null>(null);
  const tooltipHandle = draggingHandle ?? hoveredHandle ?? focusedHandle;

  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const seekMin = Number.isFinite(leadInSeconds) ? leadInSeconds : 0;
  const seekMax = Math.max(safeDuration, seekMin + 0.01);
  const seekSpan = Math.max(0.01, seekMax - seekMin);
  const seekValue = Math.max(seekMin, Math.min(seekMax, Number.isFinite(currentTime) ? currentTime : seekMin));
  const selectedSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const speedOptions = SPEED_OPTIONS.includes(selectedSpeed)
    ? SPEED_OPTIONS
    : [...SPEED_OPTIONS, selectedSpeed].sort((a, b) => a - b);
  const selectedVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.8;
  const isCountingIn = countInBeat !== null && countInBeat > 0;

  const canEditLoop = Boolean(onLoopChange) && !disabled && safeDuration >= PRACTICE_MIN_LOOP_SECONDS;
  const loopMetrics = computeLoopOverlayMetrics(practiceLoop, safeDuration, seekMin, seekMax);
  const hasCustomLoopBounds = Boolean(
    practiceLoop && (practiceLoop.startSeconds > 0.01 || practiceLoop.endSeconds < safeDuration - 0.01 || practiceLoop.enabled),
  );

  const clientXToSeconds = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const rawTime = seekMin + ratio * seekSpan;
    return Math.max(0, Math.min(safeDuration, rawTime));
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
    const step = event.shiftKey ? 1.0 : 0.25;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      const base = handle === "start" ? loopMetrics.startSeconds : loopMetrics.endSeconds;
      applyHandleDrag(handle, base - step);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      const base = handle === "start" ? loopMetrics.startSeconds : loopMetrics.endSeconds;
      applyHandleDrag(handle, base + step);
    }
  };

  return (
    <section className={`studio-transport-controls studio-transport-controls--compact ${accompanimentTracks.length > 0 ? "has-accompaniment" : ""}`} aria-label={dict.playback.controls}>
      {tooltipHandle && canEditLoop && (
        <LoopHandleTooltip
          key={tooltipHandle}
          anchorRef={tooltipHandle === "start" ? startHandleRef : endHandleRef}
          label={`${tooltipHandle === "start" ? "A" : "B"} · ${formatPreciseLoopTime(tooltipHandle === "start" ? loopMetrics.startSeconds : loopMetrics.endSeconds, bpm, beatsPerBar)}`}
          positionPercent={tooltipHandle === "start" ? loopMetrics.startPercent : loopMetrics.endPercent}
        />
      )}
      <div className="studio-transport-controls__buttons">
        <button
          id="player-play-button"
          className="studio-transport-controls__button studio-transport-controls__play"
          type="button"
          onClick={onTogglePlay}
          disabled={disabled || playDisabled}
          aria-label={playing || isCountingIn ? dict.playback.pause : dict.playback.play}
          title={playing || isCountingIn ? dict.playback.pause : dict.playback.play}
        >
          {playing || isCountingIn ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {isCountingIn && <span className="studio-transport-controls__count-in-beat" aria-live="polite">{countInBeat}</span>}
        </button>
        <button
          id="player-stop-button"
          className="studio-transport-controls__button studio-transport-controls__stop"
          type="button"
          onClick={onStop}
          disabled={disabled}
          aria-label={dict.playback.stop}
          title={dict.playback.stop}
        >
          <Square aria-hidden="true" />
        </button>
        {onFirstNote && (
          <button
            id="player-first-note-button"
            className="studio-transport-controls__icon-btn"
            type="button"
            onClick={onFirstNote}
            disabled={disabled}
            aria-label="Go to first note"
            title="Go to first note"
          >
            <SkipBack size={15} aria-hidden="true" />
          </button>
        )}
        {onPrevBar && onNextBar && (
          <div className="studio-transport-controls__bar-stepper" role="group" aria-label="Bar navigation">
            <button
              id="player-prev-bar-button"
              className="studio-transport-controls__icon-btn"
              type="button"
              onClick={onPrevBar}
              disabled={disabled || (currentBar !== undefined && currentBar <= 1)}
              aria-label="Previous bar"
              title="Previous bar"
            >
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            {currentBar !== undefined && totalBars !== undefined && totalBars > 0 && (
              <span className="studio-transport-controls__bar-readout" data-testid="transport-bar-readout">
                Bar {currentBar}/{totalBars}
              </span>
            )}
            <button
              id="player-next-bar-button"
              className="studio-transport-controls__icon-btn"
              type="button"
              onClick={onNextBar}
              disabled={disabled || (currentBar !== undefined && totalBars !== undefined && currentBar >= totalBars)}
              aria-label="Next bar"
              title="Next bar"
            >
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <div className="studio-transport-controls__seek">
        <span className="studio-transport-controls__time" aria-label={`${dict.playback.currentTime} ${formatTime(currentTime)}`}>
          {formatTime(currentTime)}
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
                ref={startHandleRef}
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
                onFocus={() => setFocusedHandle("start")}
                onBlur={() => setFocusedHandle((prev) => (prev === "start" ? null : prev))}
                data-testid="transport-loop-handle-start"
              >
                <span className="studio-transport-controls__loop-bracket" aria-hidden="true">[</span>
              </button>
              <button
                type="button"
                role="slider"
                ref={endHandleRef}
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
                onFocus={() => setFocusedHandle("end")}
                onBlur={() => setFocusedHandle((prev) => (prev === "end" ? null : prev))}
                data-testid="transport-loop-handle-end"
              >
                <span className="studio-transport-controls__loop-bracket" aria-hidden="true">]</span>
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
                    disabled={disabled}
                    aria-label={`Jump to bookmark ${bm.name} (${formatTime(bm.timeSeconds)})`}
                    title={`Bookmark: ${bm.name} (${formatTime(bm.timeSeconds)})`}
                    data-testid="transport-bookmark-pin"
                  />
                );
              })}
            </div>
          )}
          <input
            id="player-seek-slider"
            title={dict.playback.seekPosition}
            type="range"
            min={seekMin}
            max={seekMax}
            step={0.05}
            value={seekValue}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onSeek(Number(event.currentTarget.value))}
            disabled={disabled}
            aria-label={dict.playback.seekPosition}
          />
        </div>
        <span className="studio-transport-controls__time" aria-label={`${dict.playback.duration} ${formatTime(duration)}`}>
          {formatTime(duration)}
        </span>
      </div>

      <div className="studio-transport-controls__options">
        {onToggleLoop && (
          <button
            id="player-loop-toggle"
            aria-label="Loop"
            type="button"
            className={`studio-transport-controls__toggle-btn ${loopMetrics.enabled ? "is-active" : ""}`}
            aria-pressed={loopMetrics.enabled}
            onClick={onToggleLoop}
            disabled={disabled || safeDuration < PRACTICE_MIN_LOOP_SECONDS}
            title="Toggle A–B practice loop (drag [ and ] on timeline to adjust)"
          >
            <Repeat size={14} aria-hidden="true" />
          </button>
        )}
        {onToggleCountIn && (
          <button
            id="player-countin-toggle"
            aria-label="Count-in"
            type="button"
            className={`studio-transport-controls__toggle-btn ${countInEnabled ? "is-active" : ""}`}
            aria-pressed={countInEnabled}
            onClick={onToggleCountIn}
            disabled={disabled}
            title="Count-in 1 bar before playback starts"
          >
            <Timer size={14} aria-hidden="true" />
          </button>
        )}
        {onToggleMetronome && (
          <button
            id="player-metronome-toggle"
            aria-label="Metronome"
            type="button"
            className={`studio-transport-controls__toggle-btn ${metronomeEnabled ? "is-active" : ""}`}
            aria-pressed={metronomeEnabled}
            onClick={onToggleMetronome}
            disabled={disabled}
            title="Toggle metronome click during playback"
          >
            <Metronome size={16} aria-hidden="true" />
          </button>
        )}
        {onToggleChords && (
          <button
            id="player-chords-toggle"
            aria-label="Chords"
            type="button"
            className={`studio-transport-controls__toggle-btn ${chordsEnabled ? "is-active" : ""}`}
            aria-pressed={chordsEnabled}
            onClick={onToggleChords}
            disabled={disabled}
            title="Show or hide the real-time chord timeline bar"
          >
            <Music size={14} aria-hidden="true" />
          </button>
        )}
        {onToggleStaff && (
          <button
            id="player-staff-toggle"
            aria-label="Staff"
            type="button"
            className={`studio-transport-controls__toggle-btn ${staffEnabled ? "is-active" : ""}`}
            aria-pressed={staffEnabled}
            onClick={onToggleStaff}
            disabled={disabled}
            title="Show or hide the horizontal grand-staff notation bar"
          >
            <ListMusic size={14} aria-hidden="true" />
          </button>
        )}
        <label className="studio-transport-controls__field" title={dict.playback.speed}>
          <Gauge size={16} aria-hidden="true" />
          <select
            id="player-speed-select"
            title={dict.playback.speed}
            value={selectedSpeed}
            onChange={(event) => onSpeedChange(Number(event.currentTarget.value))}
            disabled={disabled}
            aria-label={dict.playback.speed}
          >
            {speedOptions.map((option) => (
              <option value={option} key={option}>{option.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×</option>
            ))}
          </select>
        </label>
        <label className="studio-transport-controls__volume" title={`${dict.playback.volume}: ${Math.round(selectedVolume * 100)}%`}>
          <Volume2 size={16} aria-hidden="true" />
          <input
            id="player-volume-slider"
            title={`${dict.playback.volume}: ${Math.round(selectedVolume * 100)}%`}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={selectedVolume}
            onChange={(event) => onVolumeChange(Number(event.currentTarget.value))}
            disabled={disabled}
            aria-label={dict.playback.volume}
          />
        </label>
        {accompanimentTracks.length > 0 && (
          <div className="studio-transport-controls__accompaniment" data-testid="transport-accompaniment-controls">
            {onToggleAccompaniment && (
              <button
                id="player-accompaniment-toggle"
                type="button"
                className={`studio-transport-controls__toggle-btn ${accompanimentEnabled ? "is-active" : ""}`}
                aria-pressed={accompanimentEnabled}
                onClick={onToggleAccompaniment}
                disabled={disabled}
                aria-label={`Accompaniment (${accompanimentTracks.map((t) => t.name).join(", ")})`}
                title={`Accompaniment (${accompanimentTracks.map((t) => t.name).join(", ")})`}
              >
                <AudioLines size={16} aria-hidden="true" />
              </button>
            )}
            {onAccompanimentVolumeChange && (
              <label
                className="studio-transport-controls__volume"
                title={`Backing volume: ${Math.round(accompanimentVolume * 100)}% (${accompanimentTracks.map((t) => t.name).join(", ")})`}
              >
                <span className="studio-transport-controls__volume-readout" aria-hidden="true">{Math.round(accompanimentVolume * 100)}%</span>
                <input
                  id="player-accompaniment-volume-slider"
                  title={`Backing volume: ${Math.round(accompanimentVolume * 100)}%`}
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(Math.max(0, Math.min(1, accompanimentVolume)) * 100)}
                  onChange={(event) => onAccompanimentVolumeChange(Number(event.currentTarget.value) / 100)}
                  disabled={disabled || !accompanimentEnabled}
                  aria-label="Accompaniment volume"
                  aria-valuetext={`${Math.round(accompanimentVolume * 100)} percent`}
                />
              </label>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
