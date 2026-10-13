import type { FingeringAssignment, Note } from "@handthesia/contracts";
import {
  DEFAULT_PIANO_ROLL_THEME,
  type PianoRollTheme,
  type ViewportState,
} from "./types.ts";

export const MIN_PITCH = 21; // A0
export const MAX_PITCH = 108; // C8
export const TOTAL_PITCHES = 88; // 108 - 21 + 1

export const DEFAULT_PIXELS_PER_SECOND = 120;
export const MIN_PIXELS_PER_SECOND = 40;
export const MAX_PIXELS_PER_SECOND = 600;
export const DEFAULT_PITCH_HEIGHT = 16;
export const MIN_NOTE_WIDTH_PX = 4;
export const BADGE_MIN_WIDTH_PX = 12;

const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/**
 * Converts a MIDI pitch (21..108) to world Y coordinate.
 * Pitch 108 (C8) is at the top (y = 0), pitch 21 (A0) is at the bottom.
 */
export function pitchToY(pitch: number, pitchHeight: number): number {
  return (MAX_PITCH - pitch) * pitchHeight;
}

/**
 * Converts world Y coordinate to MIDI pitch (clamped to 21..108).
 */
export function yToPitch(y: number, pitchHeight: number): number {
  const pitch = MAX_PITCH - Math.floor(y / pitchHeight);
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch));
}

/**
 * Converts song time in seconds to world X coordinate in pixels.
 */
export function timeToX(timeSeconds: number, pixelsPerSecond: number): number {
  return timeSeconds * pixelsPerSecond;
}

/**
 * Converts world X coordinate in pixels to song time in seconds.
 */
export function xToTime(x: number, pixelsPerSecond: number): number {
  return x / pixelsPerSecond;
}

/**
 * Checks if a MIDI pitch corresponds to a black piano key.
 */
export function isBlackKey(pitch: number): boolean {
  const semitone = ((pitch % 12) + 12) % 12;
  return semitone === 1 || semitone === 3 || semitone === 6 || semitone === 8 || semitone === 10;
}

/**
 * Returns the note name and octave for a given MIDI pitch (e.g. 60 -> "C4").
 */
export function getPitchName(pitch: number): string {
  const semitone = ((pitch % 12) + 12) % 12;
  const octave = Math.floor(pitch / 12) - 1;
  return `${PITCH_NAMES[semitone]}${octave}`;
}

export interface NoteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Computes the screen-space rectangle of a note given the current viewport state.
 */
export function getNoteRect(note: Note, viewport: ViewportState): NoteRect {
  const x = timeToX(note.startSeconds, viewport.pixelsPerSecond) - viewport.scrollX;
  const rawWidth = (note.endSeconds - note.startSeconds) * viewport.pixelsPerSecond;
  const width = Math.max(MIN_NOTE_WIDTH_PX, rawWidth);
  const y = pitchToY(note.pitch, viewport.pitchHeight) - viewport.scrollY;
  const height = viewport.pitchHeight - 1;
  return { x, y, width, height };
}

/**
 * Checks if a note intersects the visible viewport window in both time and pitch.
 */
export function isNoteInViewport(note: Note, viewport: ViewportState): boolean {
  // Pitch range in view:
  const topPitch = MAX_PITCH - Math.floor(viewport.scrollY / viewport.pitchHeight);
  const bottomPitch = MAX_PITCH - Math.floor((viewport.scrollY + viewport.viewportHeight) / viewport.pitchHeight);
  const minPitchInView = Math.max(MIN_PITCH, bottomPitch);
  const maxPitchInView = Math.min(MAX_PITCH, topPitch);

  if (note.pitch < minPitchInView || note.pitch > maxPitchInView) {
    return false;
  }

  // Time range in view:
  const leftTime = viewport.scrollX / viewport.pixelsPerSecond;
  const rightTime = (viewport.scrollX + viewport.viewportWidth) / viewport.pixelsPerSecond;

  const minDuration = MIN_NOTE_WIDTH_PX / viewport.pixelsPerSecond;
  const effectiveEnd = Math.max(note.endSeconds, note.startSeconds + minDuration);

  if (effectiveEnd < leftTime || note.startSeconds > rightTime) {
    return false;
  }

  return true;
}

/**
 * Filters the notes list to only those intersecting the visible viewport.
 */
export function getCulledNotes(notes: readonly Note[], viewport: ViewportState): Note[] {
  return notes.filter((note) => isNoteInViewport(note, viewport));
}

/**
 * Hit tests notes at given screen coordinates (mouseX, mouseY).
 * Iterates in reverse to return the topmost drawn note.
 */
export function hitTestNote(
  mouseX: number,
  mouseY: number,
  notes: readonly Note[],
  viewport: ViewportState
): Note | null {
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i];
    const rect = getNoteRect(note, viewport);
    if (
      mouseX >= rect.x &&
      mouseX <= rect.x + rect.width &&
      mouseY >= rect.y &&
      mouseY <= rect.y + rect.height
    ) {
      return note;
    }
  }
  return null;
}

export interface MarqueeBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Returns all notes whose screen rectangles intersect the given marquee box.
 */
export function getNotesInMarquee(
  box: MarqueeBox,
  notes: readonly Note[],
  viewport: ViewportState
): Note[] {
  const minX = Math.min(box.x1, box.x2);
  const maxX = Math.max(box.x1, box.x2);
  const minY = Math.min(box.y1, box.y2);
  const maxY = Math.max(box.y1, box.y2);

  const matched: Note[] = [];
  for (const note of notes) {
    const rect = getNoteRect(note, viewport);
    const overlaps =
      rect.x + rect.width >= minX &&
      rect.x <= maxX &&
      rect.y + rect.height >= minY &&
      rect.y <= maxY;
    if (overlaps) {
      matched.push(note);
    }
  }
  return matched;
}

export interface MarqueeState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

export interface PianoRollCanvasRenderOptions {
  viewport: ViewportState;
  notes: readonly Note[];
  assignments?: ReadonlyMap<string, FingeringAssignment>;
  selectedNoteIds?: ReadonlySet<string>;
  transportTime?: number;
  selectionMarquee?: MarqueeState | null;
  theme?: PianoRollTheme;
}

/**
 * HTML5 2D Canvas renderer for the Piano Roll.
 */
export class PianoRollCanvasRenderer {
  public render(ctx: CanvasRenderingContext2D, options: PianoRollCanvasRenderOptions): void {
    const {
      viewport,
      notes,
      assignments,
      selectedNoteIds,
      transportTime,
      selectionMarquee,
      theme = DEFAULT_PIANO_ROLL_THEME,
    } = options;

    const width = viewport.viewportWidth;
    const height = viewport.viewportHeight;

    if (width <= 0 || height <= 0) {
      return;
    }

    // 1. Clear background
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);

    // 2. Render pitch rows (lanes)
    this.renderPitchLanes(ctx, viewport, theme);

    // 3. Render vertical time grid lines
    this.renderTimeGrid(ctx, viewport, theme);

    // 4. Render notes with viewport culling
    this.renderNotes(ctx, viewport, notes, assignments, selectedNoteIds, theme);

    // 5. Render playhead
    if (transportTime !== undefined && transportTime !== null) {
      this.renderPlayhead(ctx, viewport, transportTime, theme);
    }

    // 6. Render selection marquee
    if (selectionMarquee) {
      this.renderMarquee(ctx, selectionMarquee, theme);
    }
  }

  private renderPitchLanes(
    ctx: CanvasRenderingContext2D,
    viewport: ViewportState,
    theme: PianoRollTheme
  ): void {
    const topPitch = MAX_PITCH - Math.floor(viewport.scrollY / viewport.pitchHeight);
    const bottomPitch = MAX_PITCH - Math.floor((viewport.scrollY + viewport.viewportHeight) / viewport.pitchHeight);
    const minPitch = Math.max(MIN_PITCH, bottomPitch);
    const maxPitch = Math.min(MAX_PITCH, topPitch);

    for (let pitch = minPitch; pitch <= maxPitch; pitch++) {
      const y = pitchToY(pitch, viewport.pitchHeight) - viewport.scrollY;
      const isBlack = isBlackKey(pitch);

      ctx.fillStyle = isBlack ? theme.blackKeyLane : theme.whiteKeyLane;
      ctx.fillRect(0, y, viewport.viewportWidth, viewport.pitchHeight);

      // Separator line
      const isC = pitch % 12 === 0;
      ctx.strokeStyle = isC ? "rgba(255, 255, 255, 0.15)" : "rgba(255, 255, 255, 0.04)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + viewport.pitchHeight - 0.5);
      ctx.lineTo(viewport.viewportWidth, y + viewport.pitchHeight - 0.5);
      ctx.stroke();

      // Pitch label on C keys and lowest key
      if (isC || pitch === MIN_PITCH) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
        ctx.font = "10px Inter, system-ui, -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(getPitchName(pitch), 4, y + viewport.pitchHeight / 2);
      }
    }
  }

  private renderTimeGrid(
    ctx: CanvasRenderingContext2D,
    viewport: ViewportState,
    theme: PianoRollTheme
  ): void {
    const minTime = Math.max(0, viewport.scrollX / viewport.pixelsPerSecond);
    const maxTime = (viewport.scrollX + viewport.viewportWidth) / viewport.pixelsPerSecond;

    // Adaptive grid interval based on zoom level
    let step = 1.0;
    if (viewport.pixelsPerSecond >= 300) {
      step = 0.25;
    } else if (viewport.pixelsPerSecond >= 150) {
      step = 0.5;
    } else if (viewport.pixelsPerSecond < 60) {
      step = 2.0;
    }

    const firstLineTime = Math.floor(minTime / step) * step;

    for (let t = firstLineTime; t <= maxTime; t += step) {
      const x = Math.round(timeToX(t, viewport.pixelsPerSecond) - viewport.scrollX);
      const isMajor = Math.abs(t % (step * 4)) < 1e-6 || Math.abs(t % 1) < 1e-6;

      ctx.strokeStyle = isMajor ? theme.gridLineMeasure : theme.gridLineBeat;
      ctx.lineWidth = isMajor ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, viewport.viewportHeight);
      ctx.stroke();
    }
  }

  private renderNotes(
    ctx: CanvasRenderingContext2D,
    viewport: ViewportState,
    notes: readonly Note[],
    assignments?: ReadonlyMap<string, FingeringAssignment>,
    selectedNoteIds?: ReadonlySet<string>,
    theme: PianoRollTheme = DEFAULT_PIANO_ROLL_THEME
  ): void {
    const visibleNotes = getCulledNotes(notes, viewport);

    for (const note of visibleNotes) {
      const rect = getNoteRect(note, viewport);
      const assignment = assignments?.get(note.noteId);
      const hand = assignment?.hand ?? note.hand;
      const isSelected = selectedNoteIds?.has(note.noteId) ?? false;
      const isUnplayable = assignment?.disposition === "unplayable";
      const isGlissando = assignment?.disposition === "glissando" || note.glissando;
      const finger = assignment ? assignment.finger : note.finger;

      // Note body fill
      if (isSelected) {
        ctx.save();
        ctx.shadowColor = hand === "left" ? theme.leftHandSelected : theme.rightHandSelected;
        ctx.shadowBlur = 6;
        ctx.fillStyle = hand === "left" ? theme.leftHandSelected : theme.rightHandSelected;
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
      } else {
        ctx.fillStyle = hand === "left" ? theme.leftHandColor : theme.rightHandColor;
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      }

      // Note border
      if (isUnplayable) {
        ctx.save();
        ctx.strokeStyle = theme.unplayableBorder;
        ctx.setLineDash([3, 2]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
        ctx.restore();
      } else if (isSelected) {
        ctx.save();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
      } else {
        ctx.save();
        ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
        ctx.lineWidth = 1;
        ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
        ctx.restore();
      }

      // Text/Badge inside note: draw finger number (1..5), "g" for glissando, or "" if unassigned
      if (rect.width >= BADGE_MIN_WIDTH_PX && rect.height >= 8) {
        let badge = "";
        if (isGlissando) {
          badge = "g";
        } else if (finger !== null && finger !== undefined) {
          badge = String(finger);
        }

        if (badge.length > 0) {
          ctx.save();
          ctx.fillStyle = theme.textColor;
          const fontSize = Math.min(11, Math.max(8, Math.floor(rect.height * 0.75)));
          ctx.font = `bold ${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const cx = rect.x + Math.min(rect.width / 2, 8);
          const cy = rect.y + rect.height / 2;
          ctx.fillText(badge, cx, cy);
          ctx.restore();
        }
      }
    }
  }

  private renderPlayhead(
    ctx: CanvasRenderingContext2D,
    viewport: ViewportState,
    transportTime: number,
    theme: PianoRollTheme
  ): void {
    const playheadX = Math.round(timeToX(transportTime, viewport.pixelsPerSecond) - viewport.scrollX);

    if (playheadX < -5 || playheadX > viewport.viewportWidth + 5) {
      return;
    }

    ctx.save();
    ctx.strokeStyle = theme.playheadColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX + 0.5, 0);
    ctx.lineTo(playheadX + 0.5, viewport.viewportHeight);
    ctx.stroke();

    // Small triangle cap at top
    ctx.fillStyle = theme.playheadColor;
    ctx.beginPath();
    ctx.moveTo(playheadX - 5, 0);
    ctx.lineTo(playheadX + 5, 0);
    ctx.lineTo(playheadX, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private renderMarquee(
    ctx: CanvasRenderingContext2D,
    marquee: MarqueeState,
    theme: PianoRollTheme
  ): void {
    const x = Math.min(marquee.startX, marquee.currentX);
    const y = Math.min(marquee.startY, marquee.currentY);
    const w = Math.abs(marquee.currentX - marquee.startX);
    const h = Math.abs(marquee.currentY - marquee.startY);

    if (w <= 0 || h <= 0) {
      return;
    }

    ctx.save();
    ctx.fillStyle = theme.selectionBoxBg;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = theme.selectionBoxBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
  }
}
