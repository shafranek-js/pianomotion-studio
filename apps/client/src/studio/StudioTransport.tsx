import { Pause, Play, Square } from "lucide-react";
import type { ChangeEvent } from "react";
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
}: StudioTransportProps) {
  const seekMin = Number.isFinite(leadInSeconds) ? leadInSeconds : 0;
  const seekMax = Math.max(Number.isFinite(duration) ? duration : 0, seekMin + 0.01);
  const seekValue = Math.max(seekMin, Math.min(seekMax, Number.isFinite(currentTime) ? currentTime : seekMin));
  const selectedSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const speedOptions = SPEED_OPTIONS.includes(selectedSpeed)
    ? SPEED_OPTIONS
    : [...SPEED_OPTIONS, selectedSpeed].sort((a, b) => a - b);
  const selectedVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.8;

  return (
    <section className="studio-transport-controls" aria-label="Playback controls">
      <div className="studio-transport-controls__buttons">
        <button
          id="player-play-button"
          className="studio-transport-controls__button studio-transport-controls__play"
          type="button"
          onClick={onTogglePlay}
          disabled={disabled || playDisabled}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause playback" : "Start playback"}
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          <span>{playing ? "Pause" : "Play"}</span>
        </button>
        <button
          id="player-stop-button"
          className="studio-transport-controls__button studio-transport-controls__stop"
          type="button"
          onClick={onStop}
          disabled={disabled}
          aria-label="Stop"
          title="Stop playback and return to the start"
        >
          <Square aria-hidden="true" />
          <span>Stop</span>
        </button>
      </div>

      <div className="studio-transport-controls__seek">
        <span className="studio-transport-controls__time" aria-label={`Current time ${formatTime(currentTime)}`}>
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
          aria-label="Seek position"
        />
        <span className="studio-transport-controls__time" aria-label={`Duration ${formatTime(duration)}`}>
          {formatTime(duration)}
        </span>
      </div>

      <div className="studio-transport-controls__options">
        <label className="studio-transport-controls__field">
          <span>Speed</span>
          <select
            id="player-speed-select"
            value={selectedSpeed}
            onChange={(event) => onSpeedChange(Number(event.currentTarget.value))}
            disabled={disabled}
            aria-label="Speed"
          >
            {speedOptions.map((option) => (
              <option value={option} key={option}>{option.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×</option>
            ))}
          </select>
        </label>
        <label className="studio-transport-controls__volume">
          <span>Volume</span>
          <input
            id="player-volume-slider"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={selectedVolume}
            onChange={(event) => onVolumeChange(Number(event.currentTarget.value))}
            disabled={disabled}
            aria-label="Volume"
          />
        </label>
      </div>
    </section>
  );
}
