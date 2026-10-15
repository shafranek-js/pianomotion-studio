import type { FingeringPlan, SongDocument } from "@handthesia/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calculateDifficulty } from "./difficulty";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { EditorStateManager } from "./editorState";
import { FingeringToolbar } from "./FingeringToolbar";
import { PianoRollView } from "./pianoRollView";
import { DEFAULT_PIANO_ROLL_THEME, type DifficultyReport, type PianoRollTheme } from "./types";

export interface FingeringEditorDiagnosticsReport {
  difficulty: DifficultyReport;
  diagnostics: FingeringPlan["diagnostics"];
}

/** Selection and plan bridge for the single shared PianoScene canvas. */
export interface FingeringEditorSceneBridge {
  plan: FingeringPlan;
  selectedNoteIds: ReadonlySet<string>;
  selectNote(noteId: string, toggle?: boolean): void;
  setSelection(noteIds: Iterable<string>): void;
  clearSelection(): void;
  selectAll(): void;
}

export interface FingeringEditorProps {
  document: SongDocument;
  initialFingeringPlan: FingeringPlan;
  active?: boolean;
  transportTime?: number;
  onFingeringPlanChange?: (plan: FingeringPlan) => void;
  onSeek?: (timeSeconds: number) => void;
  showDiagnostics?: boolean;
  onDiagnosticsChange?: (report: FingeringEditorDiagnosticsReport) => void;
  assignmentControlsHost?: HTMLElement | null;
  /** Reuse the host PianoScene for notes and selection instead of creating PianoRollView. */
  externalScene?: boolean;
  onSceneBridgeChange?: (bridge: FingeringEditorSceneBridge | null) => void;
  theme?: Partial<PianoRollTheme>;
}

function editorIdentity(document: SongDocument): string {
  const trackIds = [...document.tracks.map((track) => track.trackId)].sort();
  const noteIds = [...document.notes.map((note) => note.noteId)].sort();
  const sourceIdentity = document.sourceMidiResourceId ?? `${document.title}/${document.durationSeconds}`;
  return JSON.stringify([document.projectId, sourceIdentity, trackIds, noteIds]);
}

export function FingeringEditor(props: FingeringEditorProps) {
  return <FingeringEditorSession key={editorIdentity(props.document)} {...props} />;
}

function FingeringEditorSession({
  document,
  initialFingeringPlan,
  active = true,
  transportTime = -2.0,
  onFingeringPlanChange,
  onSeek,
  showDiagnostics = true,
  onDiagnosticsChange,
  assignmentControlsHost,
  externalScene = false,
  onSceneBridgeChange,
  theme,
}: FingeringEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pianoRollViewRef = useRef<PianoRollView | null>(null);
  const onSeekRef = useRef(onSeek);
  const onPlanChangeRef = useRef(onFingeringPlanChange);
  const onDiagnosticsChangeRef = useRef(onDiagnosticsChange);
  const onSceneBridgeChangeRef = useRef(onSceneBridgeChange);

  // The wrapper keys this session by stable project/source/note identity, so
  // reference or revision refreshes keep this history manager alive.
  const [stateManager] = useState(
    () => new EditorStateManager({ initialPlan: initialFingeringPlan, document }),
  );

  const [currentPlan, setCurrentPlan] = useState<FingeringPlan>(stateManager.currentPlan);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set(stateManager.selectedNoteIds));
  const [canUndo, setCanUndo] = useState(stateManager.canUndo);
  const [canRedo, setCanRedo] = useState(stateManager.canRedo);
  const [stepEntryMode, setStepEntryMode] = useState(stateManager.stepEntryMode);

  useEffect(() => {
    onSeekRef.current = onSeek;
  }, [onSeek]);

  useEffect(() => {
    onPlanChangeRef.current = onFingeringPlanChange;
  }, [onFingeringPlanChange]);

  useEffect(() => {
    onDiagnosticsChangeRef.current = onDiagnosticsChange;
  }, [onDiagnosticsChange]);

  useEffect(() => {
    onSceneBridgeChangeRef.current = onSceneBridgeChange;
  }, [onSceneBridgeChange]);

  useEffect(() => {
    const unsubscribe = stateManager.subscribe((plan, kind) => {
      setCurrentPlan(plan);
      setSelectedNoteIds(new Set(stateManager.selectedNoteIds));
      setCanUndo(stateManager.canUndo);
      setCanRedo(stateManager.canRedo);
      setStepEntryMode(stateManager.stepEntryMode);

      // Selection, navigation, toolbar mode, and parent reconciliation are
      // view changes. Only actual source edits enter the parent/export flow.
      if (kind === "edit") onPlanChangeRef.current?.(plan);
    });
    return unsubscribe;
  }, [stateManager]);

  useEffect(() => {
    stateManager.setDocument(document);
    stateManager.reconcileExternalPlan(initialFingeringPlan);
  }, [document, initialFingeringPlan, stateManager]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || externalScene) return;

    container.replaceChildren();
    const mergedTheme = { ...DEFAULT_PIANO_ROLL_THEME, ...theme };
    const view = new PianoRollView(container, {
      theme: mergedTheme,
      onSelect: (noteIds, isMulti) => {
        if (isMulti) {
          for (const id of noteIds) stateManager.selectNote(id, true);
        } else {
          stateManager.setSelection(noteIds);
        }
      },
      onSeek: (timeSeconds) => onSeekRef.current?.(timeSeconds),
    });

    pianoRollViewRef.current = view;
    return () => {
      view.destroy();
      pianoRollViewRef.current = null;
    };
  }, [externalScene, theme, stateManager]);

  useEffect(() => {
    const view = pianoRollViewRef.current;
    if (!view) return;
    const assignmentMap = new Map(currentPlan.assignments.map((assignment) => [assignment.noteId, assignment]));
    view.setNotes(document.notes, assignmentMap);
    view.setSelectedNoteIds(selectedNoteIds);
  }, [currentPlan, selectedNoteIds, document.notes]);

  useEffect(() => {
    pianoRollViewRef.current?.setActive(active);
  }, [active]);

  useEffect(() => {
    pianoRollViewRef.current?.setPlayheadTime(transportTime);
  }, [transportTime]);

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isKeyboardShortcutSuppressed(event.target, event)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        stateManager.setSelection(document.notes.map((note) => note.noteId));
        return;
      }
      if (event.key === "Escape") {
        if (stateManager.selectedNoteIds.size > 0) {
          event.preventDefault();
          stateManager.clearSelection();
        }
        return;
      }
      stateManager.handleKeyDown(event);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, document.notes, stateManager]);

  const difficultyReport = useMemo(
    () => calculateDifficulty(document, currentPlan),
    [document, currentPlan],
  );

  useEffect(() => {
    onDiagnosticsChangeRef.current?.({
      difficulty: difficultyReport,
      diagnostics: currentPlan.diagnostics,
    });
  }, [currentPlan.diagnostics, difficultyReport]);

  const sceneBridge = useMemo<FingeringEditorSceneBridge>(() => ({
    plan: currentPlan,
    selectedNoteIds,
    selectNote: (noteId, toggle = false) => {
      if (!document.notes.some((note) => note.noteId === noteId)) return;
      if (toggle) stateManager.toggleNoteSelection(noteId);
      else stateManager.selectNote(noteId);
    },
    setSelection: (noteIds) => {
      const validIds = new Set(document.notes.map((note) => note.noteId));
      stateManager.setSelection([...noteIds].filter((noteId) => validIds.has(noteId)));
    },
    clearSelection: () => stateManager.clearSelection(),
    selectAll: () => stateManager.setSelection(document.notes.map((note) => note.noteId)),
  }), [currentPlan, document.notes, selectedNoteIds, stateManager]);

  useEffect(() => {
    if (externalScene) onSceneBridgeChangeRef.current?.(sceneBridge);
  }, [externalScene, sceneBridge]);

  useEffect(() => () => onSceneBridgeChangeRef.current?.(null), []);

  const activeAssignment = useMemo(() => {
    const firstId = selectedNoteIds.values().next().value as string | undefined;
    return firstId ? currentPlan.assignments.find((assignment) => assignment.noteId === firstId) : undefined;
  }, [selectedNoteIds, currentPlan]);

  const handleSelectNoteFromDiagnostic = useCallback((noteId: string) => {
    stateManager.setSelection([noteId]);
    const note = document.notes.find((candidate) => candidate.noteId === noteId);
    if (note) {
      pianoRollViewRef.current?.scrollToTime(note.startSeconds);
      pianoRollViewRef.current?.scrollToPitch(note.pitch);
    }
  }, [stateManager, document.notes]);

  return (
    <div className={`fingering-editor-container${externalScene ? " fingering-editor-container--external-scene" : ""}`} data-testid="fingering-editor">
      <FingeringToolbar
        selectedHand={activeAssignment?.hand ?? null}
        selectedFinger={activeAssignment?.finger ?? null}
        canUndo={canUndo}
        canRedo={canRedo}
        stepEntryMode={stepEntryMode}
        onAssignHand={(hand) => stateManager.assignHand(hand)}
        onAssignFinger={(finger) => stateManager.assignFinger(finger)}
        onToggleGlissando={() => stateManager.toggleGlissando()}
        onClearFingering={() => stateManager.clearFingering()}
        onMarkUnplayable={() => stateManager.markUnplayable()}
        onUndo={() => stateManager.undo()}
        onRedo={() => stateManager.redo()}
        onToggleStepEntry={() => stateManager.toggleStepEntryMode()}
        assignmentControlsHost={assignmentControlsHost}
        active={active}
      />

      {!externalScene && (
        <div className="editor-workspace">
          <div ref={containerRef} className="piano-roll-viewport" data-testid="piano-roll-viewport" />
          {showDiagnostics && (
            <div className="editor-sidebar">
              <DiagnosticsPanel
                difficulty={difficultyReport}
                diagnostics={currentPlan.diagnostics}
                onSelectNote={handleSelectNoteFromDiagnostic}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function isKeyboardShortcutSuppressed(target: EventTarget | null, event: KeyboardEvent): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.isContentEditable ||
    target.closest("input, textarea, select, [role='dialog'], [aria-modal='true'], dialog[open]")
  ) {
    return true;
  }
  // History shortcuts remain useful after clicking an assignment button;
  // ordinary button keys (especially Space) keep their native behavior.
  if (target.closest("button")) {
    return !((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase()));
  }
  return false;
}
