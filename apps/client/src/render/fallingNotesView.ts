import type { FingeringAssignment, FingeringPlan, Note, PerformancePlan } from "@handthesia/contracts";
import { Container, Graphics, Text } from "pixi.js";
import { isBlackKey, type KeyboardLayout } from "./keyboardView";

export interface FallingNotesViewOptions {
  pixelsPerSecond?: number;
  hitLineY?: number;
  viewportTop?: number;
  viewportBottom?: number;
}

export interface RenderedNoteTiming {
  noteId: string;
  pitch: number;
  startSeconds: number;
  endSeconds: number;
  hand: "left" | "right";
  finger: number | null;
  sourceNote: Note | null;
  assignment?: FingeringAssignment;
}

export interface PaintedNoteGeometry {
  noteId: string;
  pitch: number;
  hand: "left" | "right";
  finger: number | null;
  startSeconds: number;
  endSeconds: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visibleRect: { x: number; y: number; width: number; height: number };
  glissando: boolean;
  unplayable: boolean;
}

export interface FallingNotesProjectionOptions {
  pixelsPerSecond: number;
  hitLineY: number;
  viewportTop: number;
  viewportBottom: number;
}

/** Shared by drawing, point hit testing, marquee selection, and scene snapshots. */
export function projectFallingNoteGeometry(
  note: RenderedNoteTiming,
  layout: KeyboardLayout,
  options: FallingNotesProjectionOptions,
  viewTime: number,
): PaintedNoteGeometry | null {
  const pps = Math.max(10, options.pixelsPerSecond);
  const duration = Math.max(0.01, note.endSeconds - note.startSeconds);
  const height = Math.max(4, Math.round(duration * pps));
  const bottomY = Math.round(options.hitLineY - (note.startSeconds - viewTime) * pps);
  const topY = bottomY - height;
  if (topY >= options.hitLineY || bottomY < options.viewportTop || topY > options.viewportBottom) return null;
  const lane = layout.getLane(note.pitch);
  if (lane.width <= 0) return null;
  const visibleTop = Math.max(topY, options.viewportTop);
  const visibleBottom = Math.min(bottomY, options.viewportBottom, options.hitLineY);
  if (visibleBottom <= visibleTop) return null;

  return {
    noteId: note.noteId,
    pitch: note.pitch,
    hand: note.hand,
    finger: note.finger,
    startSeconds: note.startSeconds,
    endSeconds: note.endSeconds,
    x: lane.x,
    y: topY,
    width: lane.width,
    height,
    visibleRect: { x: lane.x, y: visibleTop, width: lane.width, height: visibleBottom - visibleTop },
    glissando: note.assignment?.disposition === "glissando" || note.sourceNote?.glissando === true,
    unplayable: note.assignment?.disposition === "unplayable",
  };
}

export class FallingNotesView extends Container {
  private sourceNotes: Note[] = [];
  private performancePlan: PerformancePlan | null = null;
  private renderedNotes: RenderedNoteTiming[] = [];
  private currentViewTime = 0;
  private selectedNoteIds = new Set<string>();
  private selectionMarquee: { x: number; y: number; width: number; height: number } | null = null;
  private pixelsPerSecond = 200;
  private hitLineY = 0;
  private viewportTop = 0;
  private viewportBottom = 0;
  private keyboardLayout: KeyboardLayout | null = null;

  private readonly notesGraphics = new Graphics();
  private readonly labelsContainer = new Container();
  private labelTextPool: Text[] = [];
  private showFingerLabels = true;
  private showNoteNames = false;

  public constructor(options?: FallingNotesViewOptions) {
    super();
    if (options?.pixelsPerSecond !== undefined) this.pixelsPerSecond = options.pixelsPerSecond;
    if (options?.hitLineY !== undefined) this.hitLineY = options.hitLineY;
    if (options?.viewportTop !== undefined) this.viewportTop = options.viewportTop;
    if (options?.viewportBottom !== undefined) this.viewportBottom = options.viewportBottom;

    this.addChild(this.notesGraphics);
    this.addChild(this.labelsContainer);
  }

  public setNotes(notes: Note[]): void {
    this.sourceNotes = [...notes];
    this.rebuildRenderedNotes();
  }

  /** Uses performed press/release times while retaining source notes for labels and hand metadata. */
  public setPerformancePlan(plan: PerformancePlan | null, sourceNotes?: Note[]): void {
    if (sourceNotes) this.sourceNotes = [...sourceNotes];
    this.performancePlan = plan;
    this.rebuildRenderedNotes();
  }

  /** Uses source note times plus the draft fingering assignments for editor view. */
  public setFingeringPlan(plan: FingeringPlan | null): void {
    const assignments = new Map((plan?.assignments ?? []).map((item) => [item.noteId, item]));
    this.renderedNotes = this.sourceNotes
      .map((note) => {
        const assignment = assignments.get(note.noteId);
        return {
          noteId: note.noteId,
          pitch: note.pitch,
          startSeconds: note.startSeconds,
          endSeconds: note.endSeconds,
          hand: assignment?.hand ?? note.hand,
          finger: assignment ? assignment.finger : note.finger,
          sourceNote: note,
          assignment,
        };
      })
      .sort(compareRenderedNotes);
    this.update(this.currentViewTime);
  }

  public setDisplaySettings(settings: { showFingerLabels?: boolean; showNoteNames?: boolean }): void {
    if (settings.showFingerLabels !== undefined) this.showFingerLabels = settings.showFingerLabels;
    if (settings.showNoteNames !== undefined) this.showNoteNames = settings.showNoteNames;
  }

  public getRenderedNoteTimings(): readonly RenderedNoteTiming[] {
    return this.renderedNotes;
  }

  public setSelectedNoteIds(noteIds: Iterable<string>): void {
    this.selectedNoteIds = new Set(noteIds);
    this.update(this.currentViewTime);
  }

  public setSelectionMarquee(rect: { x: number; y: number; width: number; height: number } | null): void {
    this.selectionMarquee = rect;
    this.update(this.currentViewTime);
  }

  public getPaintedNoteGeometries(viewTime = this.currentViewTime): PaintedNoteGeometry[] {
    if (!this.keyboardLayout) return [];
    const options = this.getProjectionOptions();
    return this.renderedNotes.flatMap((note) => {
      const geometry = projectFallingNoteGeometry(note, this.keyboardLayout!, options, viewTime);
      return geometry ? [geometry] : [];
    });
  }

  public getNoteAtPoint(x: number, y: number, viewTime = this.currentViewTime): string | null {
    const geometries = this.getPaintedNoteGeometries(viewTime);
    for (let index = geometries.length - 1; index >= 0; index -= 1) {
      const geometry = geometries[index]!;
      const rect = geometry.visibleRect;
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
        return geometry.noteId;
      }
    }
    return null;
  }

  public getNoteIdsInRect(rect: { x: number; y: number; width: number; height: number }, viewTime = this.currentViewTime): string[] {
    const left = Math.min(rect.x, rect.x + rect.width);
    const right = Math.max(rect.x, rect.x + rect.width);
    const top = Math.min(rect.y, rect.y + rect.height);
    const bottom = Math.max(rect.y, rect.y + rect.height);
    return this.getPaintedNoteGeometries(viewTime)
      .filter((note) => note.visibleRect.x <= right && note.visibleRect.x + note.visibleRect.width >= left && note.visibleRect.y <= bottom && note.visibleRect.y + note.visibleRect.height >= top)
      .map((note) => note.noteId);
  }

  private rebuildRenderedNotes(): void {
    const sourceById = new Map(this.sourceNotes.map((note) => [note.noteId, note]));
    if (!this.performancePlan) {
      this.renderedNotes = this.sourceNotes
        .map((note) => ({
          noteId: note.noteId,
          pitch: note.pitch,
          startSeconds: note.startSeconds,
          endSeconds: note.endSeconds,
          hand: note.hand,
          finger: note.finger,
          sourceNote: note,
        }))
        .sort(compareRenderedNotes);
      return;
    }

    const presses = new Map<string, Extract<PerformancePlan["events"][number], { type: "press" }>>();
    const releases = new Map<string, number>();
    for (const event of this.performancePlan.events) {
      if (event.type === "press") presses.set(event.noteId, event);
      else if (event.type === "release") releases.set(event.noteId, event.timeSeconds);
    }

    this.renderedNotes = [];
    for (const [noteId, press] of presses) {
      const endSeconds = releases.get(noteId);
      if (endSeconds === undefined || endSeconds <= press.timeSeconds) continue;
      const sourceNote = sourceById.get(noteId) ?? null;
      this.renderedNotes.push({
        noteId,
        pitch: press.pitch,
        startSeconds: press.timeSeconds,
        endSeconds,
        hand: sourceNote?.hand ?? (press.pitch < 60 ? "left" : "right"),
        finger: sourceNote?.finger ?? null,
        sourceNote,
      });
    }
    this.renderedNotes.sort(compareRenderedNotes);
  }

  private getNoteName(pitch: number): string {
    const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
    return `${names[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
  }

  public setKeyboardLayout(layout: KeyboardLayout): void {
    this.keyboardLayout = layout;
  }

  public setPixelsPerSecond(pps: number): void {
    this.pixelsPerSecond = Math.max(10, pps);
  }

  public setLayout(config: {
    hitLineY: number;
    viewportTop?: number;
    viewportBottom?: number;
    keyboardLayout?: KeyboardLayout;
  }): void {
    this.hitLineY = config.hitLineY;
    this.viewportTop = config.viewportTop ?? 0;
    this.viewportBottom = config.viewportBottom ?? config.hitLineY;
    if (config.keyboardLayout) {
      this.keyboardLayout = config.keyboardLayout;
    }
  }

  public update(transportTime: number): void {
    this.currentViewTime = transportTime;
    this.notesGraphics.clear();

    for (const text of this.labelTextPool) {
      text.visible = false;
    }
    let labelIndex = 0;

    if (!this.keyboardLayout || this.renderedNotes.length === 0) return;

    const hitY = this.hitLineY;
    const geometryById = new Map(this.getPaintedNoteGeometries(transportTime).map((geometry) => [geometry.noteId, geometry]));
    for (const note of this.renderedNotes) {
      const geometry = geometryById.get(note.noteId);
      if (!geometry) continue;
      const { x, y: topY, width, height } = geometry;
      const bottomY = topY + height;
      const black = isBlackKey(note.pitch);

      let fillColor: number;
      let strokeColor: number;
      let highlightColor: number;

      if (geometry.unplayable) {
        fillColor = 0x7f1d1d;
        strokeColor = 0xef4444;
        highlightColor = 0xf87171;
      } else if (note.hand === "left") {
        fillColor = black ? 0x2563eb : 0x3b82f6; // LH blue tone
        strokeColor = 0x1d4ed8;
        highlightColor = 0x60a5fa;
      } else {
        fillColor = black ? 0x059669 : 0x10b981; // RH green tone
        strokeColor = 0x047857;
        highlightColor = 0x34d399;
      }

      const radius = Math.min(4, Math.max(2, Math.floor(width / 4)));

      // Note body (clipped by fallingNotesMask at keyboard top edge in PianoScene)
      this.notesGraphics
        .roundRect(x, topY, width, height, radius)
        .fill(fillColor)
        .stroke({ width: 1, color: strokeColor });

      if (geometry.glissando) {
        this.notesGraphics.roundRect(x - 1, topY - 1, width + 2, height + 2, radius).stroke({ width: 1, color: 0xfbbf24 });
      }
      if (this.selectedNoteIds.has(note.noteId)) {
        this.notesGraphics.roundRect(x - 2, topY - 2, width + 4, height + 4, radius + 1).stroke({ width: 2, color: 0xf8fafc });
      }

      // Top edge highlight sheen if tall enough
      if (height > 6 && width > 4) {
        this.notesGraphics
          .moveTo(x + 2, topY + 2)
          .lineTo(x + width - 2, topY + 2)
          .stroke({ width: 1, color: highlightColor, alpha: 0.7 });
      }

      // Finger label on falling note
      const showFinger = this.showFingerLabels && note.finger !== null && note.finger >= 1 && note.finger <= 5;
      if ((showFinger || this.showNoteNames) && height >= 16 && width >= 12) {
        let label = this.labelTextPool[labelIndex];
        if (!label) {
          label = new Text({
            text: "",
            style: {
              fontFamily: "system-ui, sans-serif",
              fontSize: 10,
              fontWeight: "bold",
              fill: 0xffffff,
              align: "center",
            },
          });
          label.anchor.set(0.5, 0.5);
          this.labelsContainer.addChild(label);
          this.labelTextPool.push(label);
        }

        const labelFontSize = Math.min(12, Math.max(8, Math.round(width * 0.55)));
        label.style.fontSize = labelFontSize;
        const noteName = this.showNoteNames ? this.getNoteName(note.pitch) : "";
        label.text = showFinger ? `${noteName}${noteName ? " · " : ""}${note.finger}` : noteName;

        // Position near bottom of note if long, or center if short (clamped above keyboard)
        const rawLabelY = height > 24 ? bottomY - 9 : topY + height / 2;
        const labelY = Math.min(hitY - 10, Math.max(topY + 8, rawLabelY));
        label.position.set(x + width / 2, labelY);
        label.visible = true;
        labelIndex += 1;
      }
    }

    if (this.selectionMarquee) {
      const rect = this.selectionMarquee;
      this.notesGraphics.rect(rect.x, rect.y, rect.width, rect.height)
        .fill({ color: 0x60a5fa, alpha: 0.16 })
        .stroke({ width: 1, color: 0x93c5fd });
    }
  }

  private getProjectionOptions(): FallingNotesProjectionOptions {
    return {
      pixelsPerSecond: this.pixelsPerSecond,
      hitLineY: this.hitLineY,
      viewportTop: this.viewportTop,
      viewportBottom: this.viewportBottom,
    };
  }

  public override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    this.notesGraphics.destroy();
    for (const text of this.labelTextPool) {
      text.destroy();
    }
    this.labelsContainer.destroy();
    super.destroy(options);
  }
}

function compareRenderedNotes(a: RenderedNoteTiming, b: RenderedNoteTiming): number {
  return a.startSeconds - b.startSeconds || a.pitch - b.pitch || a.noteId.localeCompare(b.noteId);
}
