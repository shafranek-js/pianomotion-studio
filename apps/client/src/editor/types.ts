import type {
  FingeringPlan,
  Note,
} from "@handthesia/contracts";

export type Hand = "left" | "right";

export interface ViewportState {
  /** Horizontal scroll offset in pixels (time * pixelsPerSecond) */
  scrollX: number;
  /** Vertical scroll offset in pixels */
  scrollY: number;
  /** Pixels per second along the time axis (zoom level) */
  pixelsPerSecond: number;
  /** Height of a single semitone pitch lane in pixels */
  pitchHeight: number;
  /** Width of the viewport in pixels */
  viewportWidth: number;
  /** Height of the viewport in pixels */
  viewportHeight: number;
}

export interface PianoRollTheme {
  bg: string;
  whiteKeyLane: string;
  blackKeyLane: string;
  gridLineMeasure: string;
  gridLineBeat: string;
  leftHandColor: string;
  leftHandSelected: string;
  rightHandColor: string;
  rightHandSelected: string;
  unplayableBorder: string;
  playheadColor: string;
  selectionBoxBg: string;
  selectionBoxBorder: string;
  textColor: string;
}

export const DEFAULT_PIANO_ROLL_THEME: PianoRollTheme = {
  bg: "#111418",
  whiteKeyLane: "#181d24",
  blackKeyLane: "#12161c",
  gridLineMeasure: "#2e3846",
  gridLineBeat: "#1f2630",
  leftHandColor: "#3b82f6",
  leftHandSelected: "#60a5fa",
  rightHandColor: "#10b981",
  rightHandSelected: "#34d399",
  unplayableBorder: "#ef4444",
  playheadColor: "#f43f5e",
  selectionBoxBg: "rgba(59, 130, 246, 0.15)",
  selectionBoxBorder: "#3b82f6",
  textColor: "#ffffff",
};

export interface EditorNoteViewModel {
  note: Note;
  hand: Hand;
  finger: number | null;
  glissando: boolean;
  unplayable: boolean;
  selected: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DifficultyReport {
  overallScore: number; // 1 to 10
  tier: "Beginner" | "Intermediate" | "Advanced" | "Virtuoso";
  maxStretchSemitones: number;
  maxSpeedNotesPerSec: number;
  handCrossingsCount: number;
  awkwardFingeringCount: number;
  summary: string;
}

export interface EditorAction {
  type:
    | "ASSIGN_HAND"
    | "ASSIGN_FINGER"
    | "TOGGLE_GLISSANDO"
    | "CLEAR_FINGERING"
    | "MARK_UNPLAYABLE"
    | "SET_SELECTION"
    | "BATCH_ASSIGN";
  description: string;
  fingerAssignment?: {
    noteIds: readonly string[];
    finger: number | null;
  };
  apply(plan: FingeringPlan): FingeringPlan;
}
