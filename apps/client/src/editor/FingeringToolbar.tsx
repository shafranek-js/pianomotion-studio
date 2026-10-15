import { createPortal } from "react-dom";
import { Ban, Eraser, Waves } from "lucide-react";
import type { Hand } from "./types";

export interface FingeringToolbarProps {
  stepEntryMode?: boolean;
  selectedHand?: Hand | null;
  selectedFinger?: number | null;
  onAssignHand?: (hand: Hand) => void;
  onAssignFinger?: (finger: number | null) => void;
  onToggleGlissando?: () => void;
  onClearFingering?: () => void;
  onMarkUnplayable?: () => void;
  onToggleStepEntry?: () => void;
  assignmentControlsHost?: HTMLElement | null;
  active?: boolean;
  className?: string;
}

/** Fingering actions hosted in the studio header while the editor stays mounted. */
export function FingeringToolbar({
  stepEntryMode = false,
  selectedHand = null,
  selectedFinger = null,
  onAssignHand,
  onAssignFinger,
  onToggleGlissando,
  onClearFingering,
  onMarkUnplayable,
  onToggleStepEntry,
  assignmentControlsHost,
  active = true,
  className = "",
}: FingeringToolbarProps) {
  const assignmentControls = (
    <div className="fingering-assignment-controls">
      <div className="fingering-assignment-controls__groups">
        <div className="fingering-control-group" role="group" aria-label="Hand selection">
          <button
            type="button"
            aria-pressed={selectedHand === "left"}
            onClick={() => onAssignHand?.("left")}
            title="Assign Left Hand (Shortcut: L)"
            className={`fingering-control-button fingering-hand-button fingering-hand-button--left${selectedHand === "left" ? " is-selected" : ""}`}
          >Left Hand (L)</button>
          <button
            type="button"
            aria-pressed={selectedHand === "right"}
            onClick={() => onAssignHand?.("right")}
            title="Assign Right Hand (Shortcut: R)"
            className={`fingering-control-button fingering-hand-button fingering-hand-button--right${selectedHand === "right" ? " is-selected" : ""}`}
          >Right Hand (R)</button>
        </div>

        <div className="fingering-control-group fingering-control-group--actions" role="group" aria-label="Finger assignment">
          {[1, 2, 3, 4, 5].map((finger) => (
            <button
              key={finger}
              type="button"
              aria-label={`Finger ${finger}`}
              aria-pressed={selectedFinger === finger}
              onClick={() => onAssignFinger?.(finger)}
              title={`Assign Finger ${finger} (Shortcut: ${finger})`}
              className={`fingering-control-button fingering-finger-button${selectedFinger === finger ? " is-selected" : ""}`}
            >{finger}</button>
          ))}
          <button
            type="button"
            onClick={() => onClearFingering ? onClearFingering() : onAssignFinger?.(null)}
            title="Clear manual fingering and replan automatically (Shortcut: 0)"
            className="fingering-control-button fingering-action-button fingering-action-button--clear"
          ><Eraser aria-hidden="true" size={14} /> Clear (0)</button>
          <button
            type="button"
            onClick={() => onMarkUnplayable?.()}
            title="Omit selected notes from the performance (Shortcut: Delete or Backspace)"
            className="fingering-control-button fingering-action-button fingering-action-button--unplayable"
          ><Ban aria-hidden="true" size={14} /> Unplayable (Del)</button>
          <button
            type="button"
            onClick={() => onToggleGlissando?.()}
            title="Toggle glissando disposition (Shortcut: G)"
            className="fingering-control-button fingering-action-button fingering-action-button--glissando"
          ><Waves aria-hidden="true" size={14} /> Gliss (G)</button>
        </div>
      </div>

      <button
        type="button"
        aria-pressed={stepEntryMode}
        onClick={() => onToggleStepEntry?.()}
        title="After assigning a finger, automatically select the next note."
        className={`fingering-control-button fingering-auto-advance${stepEntryMode ? " is-enabled" : ""}`}
      >Auto-advance: {stepEntryMode ? "On" : "Off"}</button>
    </div>
  );

  return (
    <div className={`fingering-toolbar ${className}`}>
      {assignmentControlsHost && active
        ? createPortal(assignmentControls, assignmentControlsHost)
        : assignmentControlsHost === undefined && assignmentControls}
    </div>
  );
}
