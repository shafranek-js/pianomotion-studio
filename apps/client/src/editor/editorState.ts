import type {
  FingeringPlan,
  SongDocument,
} from "@handthesia/contracts";
import {
  createAssignFingerCommand,
  createAssignHandCommand,
  createClearFingeringCommand,
  createMarkUnplayableCommand,
  createToggleGlissandoCommand,
} from "./commands";
import type { EditorAction, Hand } from "./types";

export const MAX_HISTORY_STEPS = 50;

export interface EditorStateOptions {
  initialPlan: FingeringPlan;
  document?: SongDocument | null;
  stepEntryMode?: boolean;
}

export type EditorStateChangeKind = "edit" | "external" | "view";
export type StateChangeListener = (plan: FingeringPlan, kind: EditorStateChangeKind) => void;

function samePlanContent(left: FingeringPlan, right: FingeringPlan): boolean {
  return JSON.stringify({ ...left, inputRevision: 0 }) === JSON.stringify({ ...right, inputRevision: 0 });
}

function samePlan(left: FingeringPlan, right: FingeringPlan): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Editor history & state container.
 *
 * Manages:
 * - Current fingering plan
 * - 50-step undo / redo history stack
 * - Active note selection (Set<string>)
 * - Sequential step-entry mode (auto-advance upon note edit)
 * - Keyboard shortcut routing
 */
export class EditorStateManager {
  private _currentPlan: FingeringPlan;
  private _past: FingeringPlan[] = [];
  private _future: FingeringPlan[] = [];
  private _selectedNoteIds: Set<string> = new Set();
  private _stepEntryMode: boolean = false;
  private _document: SongDocument | null = null;
  private _listeners: Set<StateChangeListener> = new Set();
  private _revision: number;

  public constructor(options: EditorStateOptions) {
    this._currentPlan = options.initialPlan;
    this._revision = options.initialPlan.inputRevision;
    this._document = options.document ?? null;
    this._stepEntryMode = options.stepEntryMode ?? false;
  }

  // --- Getters ---

  public get currentPlan(): FingeringPlan {
    return this._currentPlan;
  }

  public get past(): readonly FingeringPlan[] {
    return this._past;
  }

  public get future(): readonly FingeringPlan[] {
    return this._future;
  }

  public get selectedNoteIds(): ReadonlySet<string> {
    return this._selectedNoteIds;
  }

  public get stepEntryMode(): boolean {
    return this._stepEntryMode;
  }

  public get document(): SongDocument | null {
    return this._document;
  }

  public get canUndo(): boolean {
    return this._past.length > 0;
  }

  public get canRedo(): boolean {
    return this._future.length > 0;
  }

  // --- Subscriptions ---

  public subscribe(listener: StateChangeListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private notify(kind: EditorStateChangeKind = "view"): void {
    for (const listener of this._listeners) {
      listener(this._currentPlan, kind);
    }
  }

  // --- Configuration & Document ---

  public setDocument(doc: SongDocument | null): void {
    this._document = doc;
    if (doc) {
      const noteIds = new Set(doc.notes.map((note) => note.noteId));
      const retainedSelection = new Set([...this._selectedNoteIds].filter((noteId) => noteIds.has(noteId)));
      const selectionChanged = retainedSelection.size !== this._selectedNoteIds.size;
      this._selectedNoteIds = retainedSelection;
      if (selectionChanged) this.notify("view");
    }
  }

  /** Accepts newer parent-computed plans without erasing local undo/redo state. */
  public reconcileExternalPlan(plan: FingeringPlan): boolean {
    if (!this._document || plan.projectId !== this._currentPlan.projectId ||
        plan.projectId !== this._document.projectId || plan.inputRevision < this._currentPlan.inputRevision) {
      return false;
    }
    const noteIds = new Set(this._document.notes.map((note) => note.noteId));
    if (plan.assignments.length !== noteIds.size ||
        plan.assignments.some((assignment) => !noteIds.has(assignment.noteId)) ||
        new Set(plan.assignments.map((assignment) => assignment.noteId)).size !== noteIds.size) {
      return false;
    }
    if (samePlan(this._currentPlan, plan)) return true;
    this._currentPlan = plan;
    this._revision = Math.max(this._revision, plan.inputRevision);
    this.notify("external");
    return true;
  }

  public setStepEntryMode(enabled: boolean): void {
    this._stepEntryMode = enabled;
    this.notify();
  }

  public toggleStepEntryMode(): boolean {
    this._stepEntryMode = !this._stepEntryMode;
    this.notify();
    return this._stepEntryMode;
  }

  // --- Selection Management ---

  public setSelection(noteIds: Iterable<string>): void {
    this._selectedNoteIds = new Set(noteIds);
    this.notify();
  }

  public selectNote(noteId: string, addToSelection: boolean = false): void {
    if (addToSelection) {
      this._selectedNoteIds.add(noteId);
    } else {
      this._selectedNoteIds = new Set([noteId]);
    }
    this.notify();
  }

  public toggleNoteSelection(noteId: string): void {
    if (this._selectedNoteIds.has(noteId)) {
      this._selectedNoteIds.delete(noteId);
    } else {
      this._selectedNoteIds.add(noteId);
    }
    this.notify();
  }

  public clearSelection(): void {
    this._selectedNoteIds.clear();
    this.notify();
  }

  // --- Navigation & Step-Entry ---

  /**
   * Returns a chronologically sorted array of notes in the song document.
   */
  public getChronologicalNotes() {
    if (!this._document?.notes) return [];
    return [...this._document.notes].sort(
      (a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch,
    );
  }

  /**
   * Advances selection to the next or previous note chronologically.
   * Returns the newly selected note ID, or null if navigation cannot proceed.
   */
  public advanceSelection(direction: "next" | "prev", publish = true): string | null {
    const notes = this.getChronologicalNotes();
    if (notes.length === 0) return null;

    if (this._selectedNoteIds.size === 0) {
      const targetNote = direction === "next" ? notes[0]! : notes[notes.length - 1]!;
      this._selectedNoteIds = new Set([targetNote.noteId]);
      if (publish) this.notify();
      return targetNote.noteId;
    }

    // Find note with highest/lowest index currently in selection
    let targetIndex = -1;
    if (direction === "next") {
      for (let i = notes.length - 1; i >= 0; i -= 1) {
        if (this._selectedNoteIds.has(notes[i]!.noteId)) {
          targetIndex = i + 1;
          break;
        }
      }
    } else {
      for (let i = 0; i < notes.length; i += 1) {
        if (this._selectedNoteIds.has(notes[i]!.noteId)) {
          targetIndex = i - 1;
          break;
        }
      }
    }

    if (targetIndex >= 0 && targetIndex < notes.length) {
      const nextNote = notes[targetIndex]!;
      this._selectedNoteIds = new Set([nextNote.noteId]);
      if (publish) this.notify();
      return nextNote.noteId;
    }

    return null;
  }

  // --- Command Execution & Undo/Redo ---

  /**
   * Executes a real fingering edit. Selection-only and no-op commands do not
   * enter history or publish an edit event to the host.
   */
  public executeCommand(cmd: EditorAction): FingeringPlan {
    const candidate = cmd.apply(this._currentPlan);
    if (samePlanContent(candidate, this._currentPlan)) {
      this.notify("view");
      return this._currentPlan;
    }

    // 1. Snapshot present into past
    this._past.push(this._currentPlan);
    if (this._past.length > MAX_HISTORY_STEPS) {
      this._past.shift();
    }

    // 2. Invalidate redo stack
    this._future = [];

    // 3. Apply command
    this._revision = Math.max(this._revision, this._currentPlan.inputRevision) + 1;
    this._currentPlan = { ...candidate, inputRevision: this._revision };

    // 4. Sequential step entry advancement
    if (
      this._stepEntryMode &&
      this._selectedNoteIds.size > 0 &&
      (cmd.type === "ASSIGN_FINGER" ||
        cmd.type === "ASSIGN_HAND" ||
        cmd.type === "CLEAR_FINGERING" ||
        cmd.type === "MARK_UNPLAYABLE")
    ) {
      this.advanceSelection("next", false);
    }
    this.notify("edit");

    return this._currentPlan;
  }

  /**
   * Undoes the last command:
   * - Pops past plan
   * - Pushes present plan to future stack
   * - Restores previous plan
   */
  public undo(): FingeringPlan | null {
    if (this._past.length === 0) return null;

    const previous = this._past.pop()!;
    this._future.push(this._currentPlan);
    this._revision = Math.max(this._revision, this._currentPlan.inputRevision) + 1;
    this._currentPlan = { ...previous, inputRevision: this._revision };

    this.notify("edit");
    return this._currentPlan;
  }

  /**
   * Redoes the last undone command:
   * - Pops future plan
   * - Pushes present plan to past stack
   * - Restores next plan
   */
  public redo(): FingeringPlan | null {
    if (this._future.length === 0) return null;

    const next = this._future.pop()!;
    this._past.push(this._currentPlan);
    this._revision = Math.max(this._revision, this._currentPlan.inputRevision) + 1;
    this._currentPlan = { ...next, inputRevision: this._revision };

    this.notify("edit");
    return this._currentPlan;
  }

  // --- Keyboard Shortcut Routing ---

  /**
   * Handles keyboard shortcuts:
   * - '1'..'5': Assign finger 1..5
   * - '0': Clear manual fingering and replan automatically
   * - 'Delete' / 'Backspace': Mark the note unplayable
   * - 'l' / 'L': Assign left hand
   * - 'r' / 'R': Assign right hand
   * - 'g' / 'G': Toggle glissando
   * - 'Ctrl+Z' / 'Cmd+Z' (no Shift): Undo
   * - 'Ctrl+Y' / 'Cmd+Y' / 'Ctrl+Shift+Z' / 'Cmd+Shift+Z': Redo
   * - 'ArrowLeft': Select previous note
   * - 'ArrowRight': Select next note
   *
   * Returns true if shortcut was handled, false otherwise.
   */
  public handleKeyDown(event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    preventDefault?: () => void;
  }): boolean {
    const isModifier = !!(event.ctrlKey || event.metaKey);
    const key = event.key;
    const selectedIds = Array.from(this._selectedNoteIds);

    // Undo / Redo
    if (isModifier) {
      if ((key === "z" || key === "Z") && !event.shiftKey) {
        event.preventDefault?.();
        this.undo();
        return true;
      }
      if (
        key === "y" ||
        key === "Y" ||
        ((key === "z" || key === "Z") && event.shiftKey)
      ) {
        event.preventDefault?.();
        this.redo();
        return true;
      }
      return false;
    }

    // Navigation
    if (key === "ArrowLeft") {
      event.preventDefault?.();
      this.advanceSelection("prev");
      return true;
    }
    if (key === "ArrowRight") {
      event.preventDefault?.();
      this.advanceSelection("next");
      return true;
    }

    // The remaining actions require selected note(s)
    if (selectedIds.length === 0) {
      return false;
    }

    // Finger assignments: '1'..'5'
    if (/^[1-5]$/.test(key)) {
      event.preventDefault?.();
      const finger = parseInt(key, 10);
      this.executeCommand(createAssignFingerCommand(selectedIds, finger));
      return true;
    }

    // Clear manual fingering to automatic: '0'
    if (key === "0") {
      event.preventDefault?.();
      this.executeCommand(createClearFingeringCommand(selectedIds));
      return true;
    }

    if (key === "Delete" || key === "Backspace") {
      event.preventDefault?.();
      this.executeCommand(createMarkUnplayableCommand(selectedIds));
      return true;
    }

    // Hand assignments: 'l'/'L', 'r'/'R'
    if (key === "l" || key === "L") {
      event.preventDefault?.();
      this.executeCommand(createAssignHandCommand(selectedIds, "left"));
      return true;
    }
    if (key === "r" || key === "R") {
      event.preventDefault?.();
      this.executeCommand(createAssignHandCommand(selectedIds, "right"));
      return true;
    }

    // Toggle glissando: 'g'/'G'
    if (key === "g" || key === "G") {
      event.preventDefault?.();
      this.executeCommand(createToggleGlissandoCommand(selectedIds));
      return true;
    }

    return false;
  }

  public assignHand(hand: Hand): FingeringPlan | null {
    if (this._selectedNoteIds.size === 0) return null;
    return this.executeCommand(createAssignHandCommand([...this._selectedNoteIds], hand));
  }

  public assignFinger(finger: number | null): FingeringPlan | null {
    if (this._selectedNoteIds.size === 0) return null;
    return this.executeCommand(createAssignFingerCommand([...this._selectedNoteIds], finger));
  }

  public toggleGlissando(): FingeringPlan | null {
    if (this._selectedNoteIds.size === 0) return null;
    return this.executeCommand(createToggleGlissandoCommand([...this._selectedNoteIds]));
  }

  public clearFingering(): FingeringPlan | null {
    if (this._selectedNoteIds.size === 0) return null;
    return this.executeCommand(createClearFingeringCommand([...this._selectedNoteIds]));
  }

  public markUnplayable(): FingeringPlan | null {
    if (this._selectedNoteIds.size === 0) return null;
    return this.executeCommand(createMarkUnplayableCommand([...this._selectedNoteIds]));
  }
}
