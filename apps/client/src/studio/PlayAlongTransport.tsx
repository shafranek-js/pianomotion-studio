import { Check, Music, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import type { PlayAlongHandMode, PlayAlongState, PlayAlongStep } from "../player/playAlongEngine";
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
}

const PITCH_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

function pitchToName(pitch: number): string {
  const name = PITCH_NAMES[pitch % 12] ?? "C";
  const octave = Math.floor(pitch / 12) - 1;
  return `${name}${octave}`;
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
}: PlayAlongTransportProps) {
  const progressPercent = totalSteps > 0 ? Math.round(((currentStepIndex + 1) / totalSteps) * 100) : 0;

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
      </div>

      {/* 3. Hand Mode Selector & MIDI Input Status */}
      <div className="studio-transport-controls__options" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
        {/* Hand practice mode */}
        <div style={{ display: "inline-flex", borderRadius: "6px", background: "#1c2127", border: "1px solid #374151", padding: "2px" }}>
          {(["both", "right", "left"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onHandModeChange(mode)}
              style={{
                padding: "2px 8px",
                fontSize: "11px",
                fontWeight: handMode === mode ? 600 : 400,
                color: handMode === mode ? "#ffffff" : "var(--studio-muted)",
                background: handMode === mode ? "#374151" : "transparent",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
              }}
              title={mode === "both" ? "Practice both hands" : mode === "right" ? "Practice right hand only" : "Practice left hand only"}
            >
              {mode === "both" ? "Both hands" : mode === "right" ? "Right hand" : "Left hand"}
            </button>
          ))}
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
