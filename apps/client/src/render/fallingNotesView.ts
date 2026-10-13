import type { Note, PerformancePlan } from "@handthesia/contracts";
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
}

export class FallingNotesView extends Container {
  private sourceNotes: Note[] = [];
  private performancePlan: PerformancePlan | null = null;
  private renderedNotes: RenderedNoteTiming[] = [];
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

  public setDisplaySettings(settings: { showFingerLabels?: boolean; showNoteNames?: boolean }): void {
    if (settings.showFingerLabels !== undefined) this.showFingerLabels = settings.showFingerLabels;
    if (settings.showNoteNames !== undefined) this.showNoteNames = settings.showNoteNames;
  }

  public getRenderedNoteTimings(): readonly RenderedNoteTiming[] {
    return this.renderedNotes;
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
    this.notesGraphics.clear();

    for (const text of this.labelTextPool) {
      text.visible = false;
    }
    let labelIndex = 0;

    if (!this.keyboardLayout || this.renderedNotes.length === 0) return;

    const pps = this.pixelsPerSecond;
    const hitY = this.hitLineY;
    const vTop = this.viewportTop;
    const vBottom = this.viewportBottom;

    // Fast time-based bounds for viewport culling
    const minStartSeconds = transportTime - (vBottom - hitY) / pps;
    const maxEndSeconds = transportTime + (hitY - vTop) / pps;

    for (const note of this.renderedNotes) {
      // If note finished before reaching viewport top or hasn't entered viewport bottom
      if (note.endSeconds < minStartSeconds) continue;
      if (note.startSeconds > maxEndSeconds) continue;

      const duration = Math.max(0.01, note.endSeconds - note.startSeconds);
      const height = Math.max(4, Math.round(duration * pps));
      const bottomY = Math.round(hitY - (note.startSeconds - transportTime) * pps);
      const topY = bottomY - height;

      // If note has completely entered the strike line and finished, skip
      if (topY >= hitY) continue;

      // Exact pixel viewport culling
      if (bottomY < vTop || topY > vBottom) continue;

      const lane = this.keyboardLayout.getLane(note.pitch);
      const x = lane.x;
      const width = lane.width;
      const black = isBlackKey(note.pitch);

      let fillColor: number;
      let strokeColor: number;
      let highlightColor: number;

      if (note.hand === "left") {
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
