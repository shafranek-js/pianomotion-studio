import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ban, Eraser, Keyboard, Redo2, Undo2, Waves, X } from "lucide-react";
import type { Hand } from "./types";

export interface FingeringToolbarProps {
  canUndo?: boolean;
  canRedo?: boolean;
  stepEntryMode?: boolean;
  isRebuilding?: boolean;
  selectedHand?: Hand | null;
  selectedFinger?: number | null;
  onAssignHand?: (hand: Hand) => void;
  onAssignFinger?: (finger: number | null) => void;
  onToggleGlissando?: () => void;
  onClearFingering?: () => void;
  onMarkUnplayable?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onToggleStepEntry?: () => void;
  assignmentControlsHost?: HTMLElement | null;
  active?: boolean;
  className?: string;
}

const SHORTCUTS_LIST = [
  { key: "1 – 5", desc: "Assign finger (1: Thumb, 5: Pinky)" },
  { key: "0", desc: "Clear manual finger; replan automatically" },
  { key: "Del / Backspace", desc: "Mark note unplayable" },
  { key: "L / R", desc: "Assign Left / Right hand" },
  { key: "G", desc: "Toggle glissando run" },
  { key: "Ctrl + Z", desc: "Undo last edit" },
  { key: "Ctrl + Y", desc: "Redo last undone edit (also Ctrl+Shift+Z)" },
  { key: "← / →", desc: "Select previous / next note chronologically" },
];

/**
 * Responsive editor toolbar for piano fingering inspection and editing.
 */
export function FingeringToolbar({
  canUndo = false,
  canRedo = false,
  stepEntryMode = false,
  isRebuilding = false,
  selectedHand = null,
  selectedFinger = null,
  onAssignHand,
  onAssignFinger,
  onToggleGlissando,
  onClearFingering,
  onMarkUnplayable,
  onUndo,
  onRedo,
  onToggleStepEntry,
  assignmentControlsHost,
  active = true,
  className = "",
}: FingeringToolbarProps) {
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState({ top: 12, left: 12 });
  const shortcutsButtonRef = useRef<HTMLButtonElement | null>(null);
  const shortcutsCloseRef = useRef<HTMLButtonElement | null>(null);

  const closeShortcuts = () => {
    setShowShortcutsModal(false);
    shortcutsButtonRef.current?.focus({ preventScroll: true });
  };

  const toggleShortcuts = () => {
    if (showShortcutsModal) {
      closeShortcuts();
      return;
    }
    if (shortcutsButtonRef.current && typeof window !== "undefined") {
      const bounds = shortcutsButtonRef.current.getBoundingClientRect();
      const width = Math.min(320, Math.max(0, window.innerWidth - 24));
      const height = Math.min(420, Math.max(0, window.innerHeight * 0.7));
      const left = Math.min(Math.max(12, bounds.right - width), Math.max(12, window.innerWidth - width - 12));
      const top = bounds.bottom + 8 + height <= window.innerHeight - 12
        ? bounds.bottom + 8
        : Math.max(12, bounds.top - height - 8);
      setPopoverPosition({ top, left });
    }
    setShowShortcutsModal(true);
  };

  useEffect(() => {
    if (!showShortcutsModal || typeof window === "undefined") return;
    const handleShortcutPopoverEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeShortcuts();
    };
    window.addEventListener("keydown", handleShortcutPopoverEscape, true);
    shortcutsCloseRef.current?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", handleShortcutPopoverEscape, true);
  }, [showShortcutsModal]);

  const assignmentControls = (
    <div className="fingering-assignment-controls">
      {/* Hands and finger assignment */}
      <div className="fingering-assignment-controls__groups">
        <div
          role="group"
          aria-label="Hand selection"
          style={{
            display: "inline-flex",
            background: "rgba(0, 0, 0, 0.25)",
            borderRadius: "0.4rem",
            padding: "0.15rem",
            border: "1px solid var(--border, #33423a)",
          }}
        >
          <button
            type="button"
            aria-pressed={selectedHand === "left"}
            onClick={() => onAssignHand?.("left")}
            style={{
              padding: "0.3rem 0.6rem",
              borderRadius: "0.3rem",
              border: "none",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "0.78rem",
              background: selectedHand === "left" ? "var(--left-hand, #3b82f6)" : "transparent",
              color: selectedHand === "left" ? "#ffffff" : "var(--muted, #9fac9f)",
              transition: "background 0.15s, color 0.15s",
            }}
            title="Assign Left Hand (Shortcut: L)"
          >
            Left Hand (L)
          </button>
          <button
            type="button"
            aria-pressed={selectedHand === "right"}
            onClick={() => onAssignHand?.("right")}
            style={{
              padding: "0.3rem 0.6rem",
              borderRadius: "0.3rem",
              border: "none",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "0.78rem",
              background: selectedHand === "right" ? "var(--right-hand, #10b981)" : "transparent",
              color: selectedHand === "right" ? "#ffffff" : "var(--muted, #9fac9f)",
              transition: "background 0.15s, color 0.15s",
            }}
            title="Assign Right Hand (Shortcut: R)"
          >
            Right Hand (R)
          </button>
        </div>

        <div
          role="group"
          aria-label="Finger assignment"
          style={{
            display: "inline-flex",
            background: "rgba(0, 0, 0, 0.25)",
            borderRadius: "0.4rem",
            padding: "0.15rem",
            border: "1px solid var(--border, #33423a)",
            gap: "0.15rem",
          }}
        >
          {[1, 2, 3, 4, 5].map((f) => {
            const isSelected = selectedFinger === f;
            return (
              <button
                key={f}
                type="button"
                aria-label={`Finger ${f}`}
                aria-pressed={isSelected}
                onClick={() => onAssignFinger?.(f)}
                style={{
                  width: "1.9rem",
                  height: "1.9rem",
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "0.3rem",
                  border: "none",
                  cursor: "pointer",
                  fontWeight: 700,
                  fontSize: "0.82rem",
                  background: isSelected ? "var(--mint, #a9d3bb)" : "rgba(255, 255, 255, 0.05)",
                  color: isSelected ? "#111714" : "#edf2ed",
                  transition: "background 0.15s, color 0.15s",
                }}
                title={`Assign Finger ${f} (Shortcut: ${f})`}
              >
                {f}
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => {
              if (onClearFingering) onClearFingering();
              else onAssignFinger?.(null);
            }}
            style={{
              padding: "0 0.5rem",
              height: "1.9rem",
              display: "flex",
              alignItems: "center",
              gap: "0.2rem",
              borderRadius: "0.3rem",
              border: "none",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "0.75rem",
              background: "rgba(239, 68, 68, 0.12)",
              color: "#f87171",
            }}
            title="Clear manual fingering and replan automatically (Shortcut: 0)"
          >
            <Eraser aria-hidden="true" size={14} /> Clear (0)
          </button>

          <button
            type="button"
            onClick={() => onMarkUnplayable?.()}
            style={{
              padding: "0 0.5rem",
              height: "1.9rem",
              display: "flex",
              alignItems: "center",
              gap: "0.2rem",
              borderRadius: "0.3rem",
              border: "1px solid rgba(248, 113, 113, 0.35)",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "0.75rem",
              background: "rgba(239, 68, 68, 0.06)",
              color: "#f87171",
            }}
            title="Omit selected notes from the performance (Shortcut: Delete or Backspace)"
          >
            <Ban aria-hidden="true" size={14} /> Unplayable (Del)
          </button>

          <button
            type="button"
            onClick={() => onToggleGlissando?.()}
            style={{
              padding: "0 0.55rem",
              height: "1.9rem",
              display: "flex",
              alignItems: "center",
              borderRadius: "0.3rem",
              border: "none",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "0.75rem",
              background: "rgba(245, 158, 11, 0.15)",
              color: "#fbbf24",
            }}
            title="Toggle glissando disposition (Shortcut: G)"
          >
            <Waves aria-hidden="true" size={14} /> Gliss (G)
          </button>
        </div>
      </div>
    </div>
  );

  const assignmentControlsPortal = assignmentControlsHost && active
    ? createPortal(assignmentControls, assignmentControlsHost)
    : null;

  return (
    <div
      className={`fingering-toolbar ${className}`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: assignmentControlsHost !== undefined ? "flex-end" : "space-between",
        flexWrap: "wrap",
        gap: "0.6rem",
        padding: "0.6rem 0.8rem",
        background: "var(--panel, #19211d)",
        border: "1px solid var(--border, #33423a)",
        borderRadius: "0.6rem",
        color: "#edf2ed",
        fontSize: "0.85rem",
        position: "relative",
      }}
    >
      {assignmentControlsPortal}
      {assignmentControlsHost === undefined && assignmentControls}

      {/* Middle/Right group: History, Step-entry, Rebuilding indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        {/* Undo / Redo */}
        <div
          role="group"
          aria-label="History actions"
          style={{
            display: "inline-flex",
            background: "rgba(0, 0, 0, 0.25)",
            borderRadius: "0.4rem",
            padding: "0.15rem",
            border: "1px solid var(--border, #33423a)",
            gap: "0.15rem",
          }}
        >
          <button
            type="button"
            disabled={!canUndo}
            onClick={() => onUndo?.()}
            style={{
              padding: "0.3rem 0.55rem",
              borderRadius: "0.3rem",
              border: "none",
              cursor: canUndo ? "pointer" : "not-allowed",
              fontWeight: 600,
              fontSize: "0.78rem",
              background: "transparent",
              color: canUndo ? "#edf2ed" : "rgba(255, 255, 255, 0.2)",
            }}
            title="Undo (Shortcut: Ctrl+Z)"
          >
            <Undo2 aria-hidden="true" size={15} /> Undo
          </button>
          <button
            type="button"
            disabled={!canRedo}
            onClick={() => onRedo?.()}
            style={{
              padding: "0.3rem 0.55rem",
              borderRadius: "0.3rem",
              border: "none",
              cursor: canRedo ? "pointer" : "not-allowed",
              fontWeight: 600,
              fontSize: "0.78rem",
              background: "transparent",
              color: canRedo ? "#edf2ed" : "rgba(255, 255, 255, 0.2)",
            }}
            title="Redo (Shortcut: Ctrl+Y)"
          >
            <Redo2 aria-hidden="true" size={15} /> Redo
          </button>
        </div>

        {/* Step-Entry Mode Toggle */}
        <button
          type="button"
          onClick={() => onToggleStepEntry?.()}
          style={{
            padding: "0.3rem 0.65rem",
            borderRadius: "0.4rem",
            border: `1px solid ${
              stepEntryMode ? "var(--orange, #f0bc7c)" : "var(--border, #33423a)"
            }`,
            cursor: "pointer",
            fontWeight: 600,
            fontSize: "0.78rem",
            background: stepEntryMode
              ? "rgba(240, 188, 124, 0.15)"
              : "rgba(0, 0, 0, 0.25)",
            color: stepEntryMode ? "var(--orange, #f0bc7c)" : "var(--muted, #9fac9f)",
          }}
          title="Sequential Step-Entry Mode (auto-advances to next note on edit)"
        >
          Step Entry: {stepEntryMode ? "ON" : "OFF"}
        </button>

        {/* Shortcuts cheat sheet trigger */}
        <button
          ref={shortcutsButtonRef}
          type="button"
          onClick={toggleShortcuts}
          aria-expanded={showShortcutsModal}
          aria-controls="fingering-shortcuts-popover"
          style={{
            padding: "0.3rem 0.55rem",
            borderRadius: "0.4rem",
            border: "1px solid var(--border, #33423a)",
            cursor: "pointer",
            fontWeight: 600,
            fontSize: "0.78rem",
            background: "rgba(0, 0, 0, 0.25)",
            color: "var(--muted, #9fac9f)",
          }}
          title="Keyboard shortcuts cheat sheet"
        >
          <Keyboard aria-hidden="true" size={15} /> Shortcuts
        </button>

        {/* Rebuilding motion indicator */}
        {isRebuilding && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.25rem 0.55rem",
              borderRadius: "0.4rem",
              background: "rgba(59, 130, 246, 0.15)",
              border: "1px solid rgba(59, 130, 246, 0.4)",
              color: "#60a5fa",
              fontSize: "0.75rem",
              fontWeight: 600,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "0.55rem",
                height: "0.55rem",
                borderRadius: "50%",
                background: "#60a5fa",
                animation: "pulse 1.2s infinite ease-in-out",
              }}
            />
            Rebuilding motion…
          </div>
        )}
      </div>

      {/* Shortcuts Modal / Popover */}
      {showShortcutsModal && (() => {
        const popover = (
        <div
          id="fingering-shortcuts-popover"
          role="region"
          aria-label="Keyboard shortcuts"
          style={{
            position: "fixed",
            top: `${popoverPosition.top}px`,
            left: `${popoverPosition.left}px`,
            zIndex: 100,
            background: "var(--panel-raised, #202b25)",
            border: "1px solid var(--border, #33423a)",
            borderRadius: "0.6rem",
            padding: "0.8rem 1rem",
            boxShadow: "0 10px 25px rgba(0, 0, 0, 0.5)",
            width: "min(320px, calc(100vw - 24px))",
            maxHeight: "min(70dvh, 420px)",
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: 700, fontSize: "0.85rem" }}>Keyboard Shortcuts</span>
            <button
              ref={shortcutsCloseRef}
              type="button"
              onClick={closeShortcuts}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--muted, #9fac9f)",
                cursor: "pointer",
                width: "44px",
                height: "44px",
                display: "grid",
                placeItems: "center",
              }}
              title="Close"
              aria-label="Close keyboard shortcuts"
            >
              <X aria-hidden="true" size={16} />
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {SHORTCUTS_LIST.map((sc) => (
              <div
                key={sc.key}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "0.76rem",
                  padding: "0.15rem 0",
                  borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
                }}
              >
                <code
                  style={{
                    background: "rgba(0, 0, 0, 0.4)",
                    padding: "0.15rem 0.35rem",
                    borderRadius: "0.25rem",
                    color: "var(--mint, #a9d3bb)",
                    fontFamily: "monospace",
                  }}
                >
                  {sc.key}
                </code>
                <span style={{ color: "var(--muted, #9fac9f)", textAlign: "right" }}>
                  {sc.desc}
                </span>
              </div>
            ))}
          </div>
        </div>
        );
        return typeof document !== "undefined" ? createPortal(popover, document.body) : popover;
      })()}
    </div>
  );
}
