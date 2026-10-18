import { createPortal } from "react-dom";
import { Ban, Eraser, Waves } from "lucide-react";
import type { Hand } from "./types";
import { useI18n } from "../i18n";

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
  const { dict } = useI18n();

  const getFingerTitle = (finger: number): string => {
    switch (finger) {
      case 1: return dict.editor.finger1;
      case 2: return dict.editor.finger2;
      case 3: return dict.editor.finger3;
      case 4: return dict.editor.finger4;
      case 5: return dict.editor.finger5;
      default: return `Finger ${finger}`;
    }
  };

  const leftHandLabel = dict.editor.leftHand === "Left hand" ? "Left Hand (L)" : `${dict.editor.leftHand} (L)`;
  const rightHandLabel = dict.editor.rightHand === "Right hand" ? "Right Hand (R)" : `${dict.editor.rightHand} (R)`;

  const assignmentControls = (
    <div className="fingering-assignment-controls">
      <div className="fingering-assignment-controls__groups">
        <div className="fingering-control-group" role="group" aria-label={dict.editor.handAssignment}>
          <button
            type="button"
            aria-pressed={selectedHand === "left"}
            onClick={() => onAssignHand?.("left")}
            title={`${dict.editor.leftHand} (Shortcut: L)`}
            className={`fingering-control-button fingering-hand-button fingering-hand-button--left${selectedHand === "left" ? " is-selected" : ""}`}
          >{leftHandLabel}</button>
          <button
            type="button"
            aria-pressed={selectedHand === "right"}
            onClick={() => onAssignHand?.("right")}
            title={`${dict.editor.rightHand} (Shortcut: R)`}
            className={`fingering-control-button fingering-hand-button fingering-hand-button--right${selectedHand === "right" ? " is-selected" : ""}`}
          >{rightHandLabel}</button>
        </div>

        <div className="fingering-control-group fingering-control-group--actions" role="group" aria-label={dict.editor.fingerAssignment}>
          {[1, 2, 3, 4, 5].map((finger) => (
            <button
              key={finger}
              type="button"
              aria-label={`Finger ${finger}`}
              aria-pressed={selectedFinger === finger}
              onClick={() => onAssignFinger?.(finger)}
              title={`${getFingerTitle(finger)} (Shortcut: ${finger})`}
              className={`fingering-control-button fingering-finger-button${selectedFinger === finger ? " is-selected" : ""}`}
            >{finger}</button>
          ))}
          <button
            type="button"
            aria-label="Clear (0)"
            onClick={() => onClearFingering ? onClearFingering() : onAssignFinger?.(null)}
            title={`${dict.editor.clearFinger} (Shortcut: 0)`}
            className="fingering-control-button fingering-action-button fingering-action-button--clear"
          ><Eraser aria-hidden="true" size={16} /></button>
          <button
            type="button"
            aria-label="Unplayable (Del)"
            onClick={() => onMarkUnplayable?.()}
            title={`${dict.editor.unplayable} (Shortcut: Delete or Backspace)`}
            className="fingering-control-button fingering-action-button fingering-action-button--unplayable"
          ><Ban aria-hidden="true" size={16} /></button>
          <button
            type="button"
            aria-label="Gliss (G)"
            onClick={() => onToggleGlissando?.()}
            title={`${dict.editor.glissando} (Shortcut: G)`}
            className="fingering-control-button fingering-action-button fingering-action-button--glissando"
          ><Waves aria-hidden="true" size={16} /></button>
        </div>
      </div>

      <button
        type="button"
        aria-pressed={stepEntryMode}
        onClick={() => onToggleStepEntry?.()}
        title={dict.editor.autoAdvance}
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
