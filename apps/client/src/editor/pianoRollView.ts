import type { FingeringAssignment, Note } from "@handthesia/contracts";
import {
  DEFAULT_PIANO_ROLL_THEME,
  type PianoRollTheme,
  type ViewportState,
} from "./types.ts";
import {
  DEFAULT_PIXELS_PER_SECOND,
  DEFAULT_PITCH_HEIGHT,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  TOTAL_PITCHES,
  PianoRollCanvasRenderer,
  getNotesInMarquee,
  hitTestNote,
  pitchToY,
  timeToX,
  type MarqueeState,
} from "./pianoRollCanvas.ts";

export interface PianoRollViewOptions {
  onSelect?: (noteIds: string[], isShiftOrCtrl: boolean) => void;
  onSeek?: (timeSeconds: number) => void;
  theme?: PianoRollTheme;
  initialPixelsPerSecond?: number;
  initialPitchHeight?: number;
  rulerHeight?: number;
  active?: boolean;
}

export function shouldCaptureSpaceForPanning(
  active: boolean,
  isSpacePressed: boolean,
  event: Pick<KeyboardEvent, "code" | "target">,
  canvas: HTMLCanvasElement,
  focusedElement: Element | null,
): boolean {
  return (
    active &&
    !isSpacePressed &&
    event.code === "Space" &&
    event.target === canvas &&
    focusedElement === canvas
  );
}

/**
 * Interactive controller managing Canvas events, zooming, panning,
 * hit-testing, and marquee selection for the Piano Roll.
 */
export class PianoRollView {
  public readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly renderer: PianoRollCanvasRenderer;
  private readonly options: PianoRollViewOptions;

  private viewport: ViewportState;
  private notes: Note[] = [];
  private assignments: Map<string, FingeringAssignment> = new Map();
  private selectedNoteIds: Set<string> = new Set();
  private transportTime = 0;

  private isPanning = false;
  private panStart: { x: number; y: number; scrollX: number; scrollY: number } | null = null;

  private isMarqueeSelecting = false;
  private selectionMarquee: MarqueeState | null = null;
  private mouseDownPos: { x: number; y: number } = { x: 0, y: 0 };
  private mouseDownNote: Note | null = null;

  private isSpacePressed = false;
  private renderPending = false;
  private rafId: number | null = null;
  private isDestroyed = false;
  private resizeObserver: ResizeObserver | null = null;
  private active: boolean;

  public constructor(
    containerOrCanvas: HTMLElement | HTMLCanvasElement,
    options: PianoRollViewOptions = {}
  ) {
    this.options = options;
    this.active = options.active ?? true;
    this.renderer = new PianoRollCanvasRenderer();

    if (
      (typeof HTMLCanvasElement !== "undefined" && containerOrCanvas instanceof HTMLCanvasElement) ||
      (containerOrCanvas && typeof (containerOrCanvas as HTMLCanvasElement).getContext === "function")
    ) {
      this.canvas = containerOrCanvas as HTMLCanvasElement;
    } else {
      this.canvas = document.createElement("canvas");
      this.canvas.tabIndex = 0;
      this.canvas.style.display = "block";
      this.canvas.style.outline = "none";
      containerOrCanvas.appendChild(this.canvas);

      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const { width, height } = entry.contentRect;
            this.resize(width, height);
          }
        });
        this.resizeObserver.observe(containerOrCanvas);
      }
    }

    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to acquire 2D canvas rendering context");
    }
    this.ctx = ctx;

    const initialWidth = this.canvas.clientWidth || 800;
    const initialHeight = this.canvas.clientHeight || 400;
    const pitchHeight = options.initialPitchHeight ?? DEFAULT_PITCH_HEIGHT;
    const pixelsPerSecond = options.initialPixelsPerSecond ?? DEFAULT_PIXELS_PER_SECOND;

    this.viewport = {
      scrollX: 0,
      scrollY: Math.max(0, (TOTAL_PITCHES * pitchHeight - initialHeight) / 2),
      pixelsPerSecond,
      pitchHeight,
      viewportWidth: initialWidth,
      viewportHeight: initialHeight,
    };

    this.attachEventListeners();
    this.resize(initialWidth, initialHeight);
  }

  // --- Public API ---

  public getViewport(): ViewportState {
    return { ...this.viewport };
  }

  public setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.isSpacePressed = false;
      if (!this.isPanning) this.canvas.style.cursor = "default";
    }
  }

  public setNotes(notes: Note[], assignments?: Map<string, FingeringAssignment>): void {
    this.notes = [...notes];
    if (assignments) {
      this.assignments = new Map(assignments);
    }
    this.requestRender();
  }

  public setSelectedNoteIds(ids: Set<string>): void {
    this.selectedNoteIds = new Set(ids);
    this.requestRender();
  }

  public setPlayheadTime(time: number): void {
    this.transportTime = time;
    this.requestRender();
  }

  public scrollToTime(timeSeconds: number): void {
    const targetX = timeToX(timeSeconds, this.viewport.pixelsPerSecond);
    this.viewport.scrollX = Math.max(0, targetX - this.viewport.viewportWidth / 2);
    this.requestRender();
  }

  public scrollToPitch(pitch: number): void {
    const pitchY = pitchToY(pitch, this.viewport.pitchHeight);
    const maxScrollY = Math.max(0, TOTAL_PITCHES * this.viewport.pitchHeight - this.viewport.viewportHeight);
    this.viewport.scrollY = Math.max(0, Math.min(maxScrollY, pitchY - this.viewport.viewportHeight / 2));
    this.requestRender();
  }

  public resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;

    this.viewport.viewportWidth = width;
    this.viewport.viewportHeight = height;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    this.clampScroll();
    this.requestRender();
  }

  public hitTestNote(mouseX: number, mouseY: number): Note | null {
    return hitTestNote(mouseX, mouseY, this.notes, this.viewport);
  }

  /**
   * Horizontally zooms the view centered on the mouse cursor position.
   */
  public zoomAt(mouseX: number, zoomFactor: number): void {
    const oldPps = this.viewport.pixelsPerSecond;
    const newPps = Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, oldPps * zoomFactor));
    if (Math.abs(newPps - oldPps) < 1e-4) return;

    // Time at mouse cursor before zoom
    const cursorTime = (mouseX + this.viewport.scrollX) / oldPps;
    // New scrollX keeping the time at mouseX invariant
    const newScrollX = Math.max(0, cursorTime * newPps - mouseX);

    this.viewport.pixelsPerSecond = newPps;
    this.viewport.scrollX = newScrollX;
    this.requestRender();
  }

  public panBy(deltaX: number, deltaY: number): void {
    this.viewport.scrollX = Math.max(0, this.viewport.scrollX + deltaX);
    const maxScrollY = Math.max(0, TOTAL_PITCHES * this.viewport.pitchHeight - this.viewport.viewportHeight);
    this.viewport.scrollY = Math.max(0, Math.min(maxScrollY, this.viewport.scrollY + deltaY));
    this.requestRender();
  }

  public render(): void {
    if (this.isDestroyed) return;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    this.ctx.save();
    this.ctx.scale(dpr, dpr);

    this.renderer.render(this.ctx, {
      viewport: this.viewport,
      notes: this.notes,
      assignments: this.assignments,
      selectedNoteIds: this.selectedNoteIds,
      transportTime: this.transportTime,
      selectionMarquee: this.selectionMarquee,
      theme: this.options.theme ?? DEFAULT_PIANO_ROLL_THEME,
    });

    this.ctx.restore();
  }

  public requestRender(): void {
    if (this.renderPending || this.isDestroyed) return;
    this.renderPending = true;

    if (typeof requestAnimationFrame !== "undefined") {
      this.rafId = requestAnimationFrame(() => {
        this.renderPending = false;
        this.render();
      });
    } else {
      this.renderPending = false;
      this.render();
    }
  }

  public destroy(): void {
    this.isDestroyed = true;
    if (this.rafId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.detachEventListeners();
    if (this.canvas.parentElement) {
      this.canvas.remove();
    }
  }

  // --- Private Event Handlers ---

  private clampScroll(): void {
    this.viewport.scrollX = Math.max(0, this.viewport.scrollX);
    const maxScrollY = Math.max(0, TOTAL_PITCHES * this.viewport.pitchHeight - this.viewport.viewportHeight);
    this.viewport.scrollY = Math.max(0, Math.min(maxScrollY, this.viewport.scrollY));
  }

  private getCanvasPoint(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  private handleMouseDown = (e: MouseEvent): void => {
    const pt = this.getCanvasPoint(e);
    this.mouseDownPos = pt;

    // 1. Middle-click drag OR Space+Left-click drag -> Pan
    if (e.button === 1 || (this.isSpacePressed && e.button === 0)) {
      this.isPanning = true;
      this.panStart = {
        x: pt.x,
        y: pt.y,
        scrollX: this.viewport.scrollX,
        scrollY: this.viewport.scrollY,
      };
      this.canvas.style.cursor = "grabbing";
      e.preventDefault();
      return;
    }

    // 2. Left click actions
    if (e.button === 0) {
      // Timeline/ruler click or Alt-click -> seek
      if (e.altKey || (this.options.rulerHeight !== undefined && pt.y <= this.options.rulerHeight)) {
        const timeSeconds = Math.max(0, (pt.x + this.viewport.scrollX) / this.viewport.pixelsPerSecond);
        this.options.onSeek?.(timeSeconds);
        return;
      }

      // Hit test note
      const hit = this.hitTestNote(pt.x, pt.y);
      if (hit) {
        this.mouseDownNote = hit;
      } else {
        // Empty area -> Start marquee selection
        this.isMarqueeSelecting = true;
        this.selectionMarquee = {
          startX: pt.x,
          startY: pt.y,
          currentX: pt.x,
          currentY: pt.y,
        };
        this.requestRender();
      }
    }
  };

  private handleMouseMove = (e: MouseEvent): void => {
    const pt = this.getCanvasPoint(e);

    if (this.isPanning && this.panStart) {
      const dx = pt.x - this.panStart.x;
      const dy = pt.y - this.panStart.y;
      this.viewport.scrollX = Math.max(0, this.panStart.scrollX - dx);
      const maxScrollY = Math.max(0, TOTAL_PITCHES * this.viewport.pitchHeight - this.viewport.viewportHeight);
      this.viewport.scrollY = Math.max(0, Math.min(maxScrollY, this.panStart.scrollY - dy));
      this.requestRender();
      return;
    }

    if (this.isMarqueeSelecting && this.selectionMarquee) {
      this.selectionMarquee.currentX = pt.x;
      this.selectionMarquee.currentY = pt.y;
      this.requestRender();
      return;
    }

    // Hover cursor updates
    if (this.isSpacePressed) {
      this.canvas.style.cursor = "grab";
    } else {
      const hit = this.hitTestNote(pt.x, pt.y);
      this.canvas.style.cursor = hit ? "pointer" : "default";
    }
  };

  private handleMouseUp = (e: MouseEvent): void => {
    const pt = this.getCanvasPoint(e);

    if (this.isPanning) {
      this.isPanning = false;
      this.panStart = null;
      this.canvas.style.cursor = this.isSpacePressed ? "grab" : "default";
      return;
    }

    if (this.isMarqueeSelecting && this.selectionMarquee) {
      const dist = Math.hypot(pt.x - this.selectionMarquee.startX, pt.y - this.selectionMarquee.startY);
      const isShiftOrCtrl = e.shiftKey || e.ctrlKey || e.metaKey;

      if (dist > 3) {
        const notesInMarquee = getNotesInMarquee(
          {
            x1: this.selectionMarquee.startX,
            y1: this.selectionMarquee.startY,
            x2: pt.x,
            y2: pt.y,
          },
          this.notes,
          this.viewport
        );
        const ids = notesInMarquee.map((n) => n.noteId);
        this.options.onSelect?.(ids, isShiftOrCtrl);
      } else {
        // Simple click in empty space clears selection unless modifier held
        if (!isShiftOrCtrl) {
          this.options.onSelect?.([], false);
        }
      }

      this.isMarqueeSelecting = false;
      this.selectionMarquee = null;
      this.requestRender();
      return;
    }

    if (this.mouseDownNote) {
      const dist = Math.hypot(pt.x - this.mouseDownPos.x, pt.y - this.mouseDownPos.y);
      if (dist <= 3) {
        const isShiftOrCtrl = e.shiftKey || e.ctrlKey || e.metaKey;
        this.options.onSelect?.([this.mouseDownNote.noteId], isShiftOrCtrl);
      }
      this.mouseDownNote = null;
    }
  };

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const pt = this.getCanvasPoint(e);

    if (e.ctrlKey) {
      // Ctrl+Wheel -> Zoom centered on mouse cursor
      const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.zoomAt(pt.x, zoomFactor);
    } else if (e.shiftKey) {
      // Shift+Wheel -> Horizontal pan
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      this.panBy(delta, 0);
    } else {
      // Normal wheel -> Vertical pan & horizontal trackpad scroll
      this.panBy(e.deltaX, e.deltaY);
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (
      typeof document !== "undefined" &&
      shouldCaptureSpaceForPanning(this.active, this.isSpacePressed, e, this.canvas, document.activeElement)
    ) {
      this.isSpacePressed = true;
      if (!this.isPanning) {
        this.canvas.style.cursor = "grab";
      }
      e.preventDefault();
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Space" && this.isSpacePressed) {
      this.isSpacePressed = false;
      if (!this.isPanning) {
        this.canvas.style.cursor = "default";
      }
    }
  };

  private handleContextMenu = (e: MouseEvent): void => {
    if (this.isPanning) {
      e.preventDefault();
    }
  };

  private attachEventListeners(): void {
    this.canvas.addEventListener?.("mousedown", this.handleMouseDown);
    this.canvas.addEventListener?.("mousemove", this.handleMouseMove);
    this.canvas.addEventListener?.("mouseup", this.handleMouseUp);
    this.canvas.addEventListener?.("wheel", this.handleWheel, { passive: false });
    this.canvas.addEventListener?.("contextmenu", this.handleContextMenu);

    if (typeof window !== "undefined") {
      window.addEventListener("keydown", this.handleKeyDown);
      window.addEventListener("keyup", this.handleKeyUp);
      window.addEventListener("blur", this.handleWindowBlur);
    }
  }

  private detachEventListeners(): void {
    this.canvas.removeEventListener?.("mousedown", this.handleMouseDown);
    this.canvas.removeEventListener?.("mousemove", this.handleMouseMove);
    this.canvas.removeEventListener?.("mouseup", this.handleMouseUp);
    this.canvas.removeEventListener?.("wheel", this.handleWheel);
    this.canvas.removeEventListener?.("contextmenu", this.handleContextMenu);

    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", this.handleKeyDown);
      window.removeEventListener("keyup", this.handleKeyUp);
      window.removeEventListener("blur", this.handleWindowBlur);
    }
  }

  private handleWindowBlur = (): void => {
    this.isSpacePressed = false;
    this.isPanning = false;
    this.isMarqueeSelecting = false;
    this.selectionMarquee = null;
    this.mouseDownNote = null;
    this.canvas.style.cursor = "default";
    this.requestRender();
  };
}
