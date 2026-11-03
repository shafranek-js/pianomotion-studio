import { ChevronLeft, ChevronRight, Music, Pause, Play, SkipBack, Square, Timer, Volume2 } from "lucide-react";
import type { ChangeEvent } from "react";
import { useI18n } from "../i18n";
import "./workspace.css";

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
  countInEnabled?: boolean;
  onToggleCountIn?(): void;
  metronomeEnabled?: boolean;
  onToggleMetronome?(): void;
  chordsEnabled?: boolean;
  onToggleChords?(): void;
}

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const sign = seconds < 0 ? "−" : "";
  const safeSeconds = Math.floor(Math.abs(seconds));
  return `${sign}${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
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
  countInEnabled = false,
  onToggleCountIn,
  metronomeEnabled = false,
  onToggleMetronome,
  chordsEnabled = true,
  onToggleChords,
}: StudioTransportProps) {
  const { dict } = useI18n();
  const seekMin = Number.isFinite(leadInSeconds) ? leadInSeconds : 0;
  const seekMax = Math.max(Number.isFinite(duration) ? duration : 0, seekMin + 0.01);
  const seekValue = Math.max(seekMin, Math.min(seekMax, Number.isFinite(currentTime) ? currentTime : seekMin));
  const selectedSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const speedOptions = SPEED_OPTIONS.includes(selectedSpeed)
    ? SPEED_OPTIONS
    : [...SPEED_OPTIONS, selectedSpeed].sort((a, b) => a - b);
  const selectedVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.8;
  const isCountingIn = countInBeat !== null && countInBeat > 0;

  return (
    <section className="studio-transport-controls" aria-label={dict.playback.controls}>
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
          <span>{isCountingIn ? `${countInBeat}…` : playing ? dict.playback.pause : dict.playback.play}</span>
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
          <span>{dict.playback.stop}</span>
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
        <input
          id="player-seek-slider"
          type="range"
          min={seekMin}
          max={seekMax}
          step={0.05}
          value={seekValue}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onSeek(Number(event.currentTarget.value))}
          disabled={disabled}
          aria-label={dict.playback.seekPosition}
        />
        <span className="studio-transport-controls__time" aria-label={`${dict.playback.duration} ${formatTime(duration)}`}>
          {formatTime(duration)}
        </span>
      </div>

      <div className="studio-transport-controls__options">
        {onToggleCountIn && (
          <button
            id="player-countin-toggle"
            type="button"
            className={`studio-transport-controls__toggle-btn ${countInEnabled ? "is-active" : ""}`}
            aria-pressed={countInEnabled}
            onClick={onToggleCountIn}
            disabled={disabled}
            title="Count-in 1 bar before playback starts"
          >
            <Timer size={14} aria-hidden="true" />
            <span>Count-in</span>
          </button>
        )}
        {onToggleMetronome && (
          <button
            id="player-metronome-toggle"
            type="button"
            className={`studio-transport-controls__toggle-btn ${metronomeEnabled ? "is-active" : ""}`}
            aria-pressed={metronomeEnabled}
            onClick={onToggleMetronome}
            disabled={disabled}
            title="Toggle metronome click during playback"
          >
            <Volume2 size={14} aria-hidden="true" />
            <span>Metronome</span>
          </button>
        )}
        {onToggleChords && (
          <button
            id="player-chords-toggle"
            type="button"
            className={`studio-transport-controls__toggle-btn ${chordsEnabled ? "is-active" : ""}`}
            aria-pressed={chordsEnabled}
            onClick={onToggleChords}
            disabled={disabled}
            title="Show or hide the real-time chord timeline bar"
          >
            <Music size={14} aria-hidden="true" />
            <span>Chords</span>
          </button>
        )}
        <label className="studio-transport-controls__field">
          <span>{dict.playback.speed}</span>
          <select
            id="player-speed-select"
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
        <label className="studio-transport-controls__volume">
          <span>{dict.playback.volume}</span>
          <input
            id="player-volume-slider"
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
      </div>
    </section>
  );
}
