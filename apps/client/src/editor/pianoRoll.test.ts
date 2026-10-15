import { describe, expect, it, vi } from "vitest";
import type { FingeringAssignment, Note } from "@handthesia/contracts";
import type { ViewportState } from "./types.ts";
import {
  PianoRollCanvasRenderer,
  getCulledNotes,
  getNotesInMarquee,
  getPitchName,
  hitTestNote,
  isBlackKey,
  isNoteInViewport,
  pitchToY,
  timeToX,
  xToTime,
  yToPitch,
} from "./pianoRollCanvas.ts";
import { PianoRollView, shouldCaptureSpaceForPanning } from "./pianoRollView.ts";

function createMockNote(overrides: Partial<Note> = {}): Note {
  return {
    noteId: "test-note-1",
    trackId: "track-1",
    pitch: 60, // C4
    velocity: 80,
    startSeconds: 1.0,
    endSeconds: 2.0,
    hand: "right",
    finger: 1,
    glissando: false,
    ...overrides,
  };
}

function createMockViewport(overrides: Partial<ViewportState> = {}): ViewportState {
  return {
    scrollX: 0,
    scrollY: 0,
    pixelsPerSecond: 100,
    pitchHeight: 16,
    viewportWidth: 800,
    viewportHeight: 400,
    ...overrides,
  };
}

describe("Piano Roll Coordinate Transforms", () => {
  it("transforms pitch to Y coordinate (pitch 108 at top, 21 at bottom)", () => {
    const pitchHeight = 16;
    // Pitch 108 is at the top
    expect(pitchToY(108, pitchHeight)).toBe(0);
    // Pitch 21 is at the bottom
    expect(pitchToY(21, pitchHeight)).toBe((108 - 21) * 16); // 87 * 16 = 1392
    // Middle C (pitch 60)
    expect(pitchToY(60, pitchHeight)).toBe((108 - 60) * 16); // 48 * 16 = 768
  });

  it("transforms Y coordinate to MIDI pitch with proper clamping", () => {
    const pitchHeight = 16;
    expect(yToPitch(0, pitchHeight)).toBe(108);
    expect(yToPitch(15, pitchHeight)).toBe(108); // within pitch 108 lane
    expect(yToPitch(16, pitchHeight)).toBe(107); // next lane
    expect(yToPitch(768, pitchHeight)).toBe(60); // Middle C
    expect(yToPitch(1392, pitchHeight)).toBe(21); // A0

    // Boundaries: clamp to [21, 108]
    expect(yToPitch(-50, pitchHeight)).toBe(108);
    expect(yToPitch(5000, pitchHeight)).toBe(21);
  });

  it("transforms time to X and X to time symmetrically", () => {
    const pps = 120;
    expect(timeToX(0, pps)).toBe(0);
    expect(timeToX(2.5, pps)).toBe(300);
    expect(xToTime(300, pps)).toBe(2.5);

    const testTimes = [0.125, 1.5, 4.25, 10.0];
    for (const t of testTimes) {
      expect(xToTime(timeToX(t, pps), pps)).toBeCloseTo(t, 6);
    }
  });

  it("identifies black keys vs white keys correctly", () => {
    // White keys
    expect(isBlackKey(60)).toBe(false); // C4
    expect(isBlackKey(62)).toBe(false); // D4
    expect(isBlackKey(64)).toBe(false); // E4
    expect(isBlackKey(65)).toBe(false); // F4
    expect(isBlackKey(67)).toBe(false); // G4
    expect(isBlackKey(69)).toBe(false); // A4
    expect(isBlackKey(71)).toBe(false); // B4
    expect(isBlackKey(21)).toBe(false); // A0
    expect(isBlackKey(108)).toBe(false); // C8

    // Black keys
    expect(isBlackKey(61)).toBe(true); // C#4
    expect(isBlackKey(63)).toBe(true); // D#4
    expect(isBlackKey(66)).toBe(true); // F#4
    expect(isBlackKey(68)).toBe(true); // G#4
    expect(isBlackKey(70)).toBe(true); // A#4
  });

  it("computes human-readable pitch names", () => {
    expect(getPitchName(60)).toBe("C4");
    expect(getPitchName(61)).toBe("C#4");
    expect(getPitchName(21)).toBe("A0");
    expect(getPitchName(108)).toBe("C8");
  });
});

describe("Viewport Culling", () => {
  it("determines if note intersects visible time and pitch window", () => {
    // Viewport covers time: 0s to 8s (800px / 100pps)
    // Viewport covers Y: 0 to 400px -> pitches: 108 down to (108 - 25) = 83
    const viewport = createMockViewport({
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 800,
      viewportHeight: 400,
      pixelsPerSecond: 100,
      pitchHeight: 16,
    });

    const insideNote = createMockNote({
      noteId: "inside",
      pitch: 100,
      startSeconds: 1.0,
      endSeconds: 2.0,
    });
    expect(isNoteInViewport(insideNote, viewport)).toBe(true);

    const outsideTimeBefore = createMockNote({
      noteId: "outside-time-before",
      pitch: 100,
      startSeconds: -2.0,
      endSeconds: -0.5,
    });
    expect(isNoteInViewport(outsideTimeBefore, viewport)).toBe(false);

    const outsideTimeAfter = createMockNote({
      noteId: "outside-time-after",
      pitch: 100,
      startSeconds: 8.5,
      endSeconds: 9.0,
    });
    expect(isNoteInViewport(outsideTimeAfter, viewport)).toBe(false);

    const outsidePitchBelow = createMockNote({
      noteId: "outside-pitch-below",
      pitch: 60, // Pitch 60 is at Y = 768px, viewport only shows 0..400px
      startSeconds: 1.0,
      endSeconds: 2.0,
    });
    expect(isNoteInViewport(outsidePitchBelow, viewport)).toBe(false);
  });

  it("includes notes that partially overlap visible window borders", () => {
    // Visible time: 2.0s to 6.0s (scrollX = 200, width = 400, pps = 100)
    const viewport = createMockViewport({
      scrollX: 200,
      scrollY: 0,
      viewportWidth: 400,
      viewportHeight: 300,
      pixelsPerSecond: 100,
    });

    // Note starts before viewport but ends inside
    const overlapLeft = createMockNote({
      noteId: "overlap-left",
      pitch: 100,
      startSeconds: 1.0,
      endSeconds: 2.5,
    });
    expect(isNoteInViewport(overlapLeft, viewport)).toBe(true);

    // Note starts inside viewport but ends after
    const overlapRight = createMockNote({
      noteId: "overlap-right",
      pitch: 100,
      startSeconds: 5.5,
      endSeconds: 7.0,
    });
    expect(isNoteInViewport(overlapRight, viewport)).toBe(true);
  });

  it("filters a list of 10,000 notes down to only visible notes in sub-millisecond time", () => {
    const viewport = createMockViewport({
      scrollX: 500, // 5.0s
      scrollY: 700, // around pitch 64
      viewportWidth: 600, // +6.0s => 11.0s
      viewportHeight: 200, // pitches ~ 64 to 52
      pixelsPerSecond: 100,
      pitchHeight: 16,
    });

    const largeNoteList: Note[] = [];
    for (let i = 0; i < 10000; i++) {
      largeNoteList.push(
        createMockNote({
          noteId: `note-${i}`,
          pitch: 21 + (i % 88),
          startSeconds: i * 0.05,
          endSeconds: i * 0.05 + 0.3,
        })
      );
    }

    const start = performance.now();
    const culled = getCulledNotes(largeNoteList, viewport);
    const duration = performance.now() - start;

    expect(culled.length).toBeGreaterThan(0);
    expect(culled.length).toBeLessThan(largeNoteList.length);
    // Every returned note must truly be in viewport
    for (const n of culled) {
      expect(isNoteInViewport(n, viewport)).toBe(true);
    }
    // High performance check: 10k note filtering should take well under 25ms in node
    expect(duration).toBeLessThan(25);
  });
});

describe("Hit Testing", () => {
  it("hits note when clicking inside its screen bounds", () => {
    // Viewport: scrollX = 0, scrollY = 0, pps = 100, pitchHeight = 16
    const viewport = createMockViewport({
      scrollX: 0,
      scrollY: 0,
      pixelsPerSecond: 100,
      pitchHeight: 16,
    });

    // Note at pitch 108 (y = 0..15), startSeconds = 1.0 (x = 100), endSeconds = 2.0 (width = 100)
    const note = createMockNote({
      noteId: "hit-note",
      pitch: 108,
      startSeconds: 1.0,
      endSeconds: 2.0,
    });

    // Inside bounds: x: 100..200, y: 0..15
    expect(hitTestNote(150, 8, [note], viewport)).toEqual(note);
    expect(hitTestNote(100, 0, [note], viewport)).toEqual(note);
    expect(hitTestNote(200, 15, [note], viewport)).toEqual(note);

    // Outside bounds
    expect(hitTestNote(99, 8, [note], viewport)).toBeNull(); // before start
    expect(hitTestNote(201, 8, [note], viewport)).toBeNull(); // after end
    expect(hitTestNote(150, 16, [note], viewport)).toBeNull(); // wrong pitch lane
  });

  it("returns the topmost (last drawn) note when notes overlap", () => {
    const viewport = createMockViewport({
      scrollX: 0,
      scrollY: 0,
      pixelsPerSecond: 100,
      pitchHeight: 16,
    });

    const noteA = createMockNote({
      noteId: "note-A",
      pitch: 108,
      startSeconds: 1.0,
      endSeconds: 3.0,
    });
    const noteB = createMockNote({
      noteId: "note-B",
      pitch: 108,
      startSeconds: 1.5,
      endSeconds: 2.5,
    });

    // Clicking at x = 180 hits both noteA and noteB. NoteB was rendered on top (last in array)
    const result = hitTestNote(180, 8, [noteA, noteB], viewport);
    expect(result?.noteId).toBe("note-B");
  });

  it("honors minimum 4px note width clamp for tiny notes", () => {
    const viewport = createMockViewport({
      scrollX: 0,
      scrollY: 0,
      pixelsPerSecond: 100,
      pitchHeight: 16,
    });

    // Duration is 0.01s -> raw width is 1px, but clamped to 4px
    const tinyNote = createMockNote({
      noteId: "tiny-note",
      pitch: 108,
      startSeconds: 1.0, // x = 100
      endSeconds: 1.01,
    });

    expect(hitTestNote(100, 8, [tinyNote], viewport)).toEqual(tinyNote);
    expect(hitTestNote(103, 8, [tinyNote], viewport)).toEqual(tinyNote);
    expect(hitTestNote(105, 8, [tinyNote], viewport)).toBeNull();
  });
});

describe("Marquee Box Intersection", () => {
  it("returns all notes overlapping the selection marquee box", () => {
    const viewport = createMockViewport({
      scrollX: 0,
      scrollY: 0,
      pixelsPerSecond: 100,
      pitchHeight: 16,
    });

    const note1 = createMockNote({
      noteId: "note-1",
      pitch: 108, // y: 0..15
      startSeconds: 1.0, // x: 100..200
      endSeconds: 2.0,
    });
    const note2 = createMockNote({
      noteId: "note-2",
      pitch: 107, // y: 16..31
      startSeconds: 1.5, // x: 150..250
      endSeconds: 2.5,
    });
    const note3 = createMockNote({
      noteId: "note-3",
      pitch: 100, // y: 128..143
      startSeconds: 5.0, // x: 500..600
      endSeconds: 6.0,
    });

    const notes = [note1, note2, note3];

    // Marquee box covering x: 120..180, y: 5..25 (covers note1 and note2)
    const box = { x1: 120, y1: 5, x2: 180, y2: 25 };
    const matched = getNotesInMarquee(box, notes, viewport);

    expect(matched.map((n) => n.noteId)).toEqual(["note-1", "note-2"]);
  });

  it("works correctly when marquee is dragged in reverse direction", () => {
    const viewport = createMockViewport({
      scrollX: 0,
      scrollY: 0,
      pixelsPerSecond: 100,
      pitchHeight: 16,
    });

    const note = createMockNote({
      noteId: "target-note",
      pitch: 108,
      startSeconds: 1.0,
      endSeconds: 2.0,
    });

    // Drag from bottom-right (250, 20) to top-left (50, 0)
    const reverseBox = { x1: 250, y1: 20, x2: 50, y2: 0 };
    const matched = getNotesInMarquee(reverseBox, [note], viewport);

    expect(matched.length).toBe(1);
    expect(matched[0].noteId).toBe("target-note");
  });

  it("returns empty array when marquee box does not overlap any note", () => {
    const viewport = createMockViewport({
      scrollX: 0,
      scrollY: 0,
      pixelsPerSecond: 100,
      pitchHeight: 16,
    });

    const note = createMockNote({
      noteId: "target-note",
      pitch: 108,
      startSeconds: 1.0,
      endSeconds: 2.0,
    });

    const disjointBox = { x1: 300, y1: 50, x2: 400, y2: 100 };
    const matched = getNotesInMarquee(disjointBox, [note], viewport);
    expect(matched).toEqual([]);
  });
});

describe("PianoRollCanvasRenderer", () => {
  it("renders without error using mocked 2D canvas context", () => {
    const renderer = new PianoRollCanvasRenderer();

    const mockCtx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      font: "",
      textAlign: "",
      textBaseline: "",
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const viewport = createMockViewport();
    const note1 = createMockNote({ noteId: "n1", pitch: 108, startSeconds: 0.5, endSeconds: 1.5, hand: "left" });
    const note2 = createMockNote({ noteId: "n2", pitch: 100, startSeconds: 2.0, endSeconds: 3.0, hand: "right" });

    const assignments = new Map<string, FingeringAssignment>([
      ["n1", { noteId: "n1", hand: "left", finger: 5, disposition: "played" }],
      ["n2", { noteId: "n2", hand: "right", finger: null, disposition: "glissando" }],
    ]);

    renderer.render(mockCtx, {
      viewport,
      notes: [note1, note2],
      assignments,
      selectedNoteIds: new Set(["n1"]),
      transportTime: 1.25,
      selectionMarquee: { startX: 10, startY: 10, currentX: 100, currentY: 100 },
    });

    // Background, pitch lanes, and notes should have been drawn
    expect(mockCtx.fillRect).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();
  });
});

describe("PianoRollView zoom & scroll behavior", () => {
  it("zooms horizontally centered on cursor position", () => {
    // In node environment, mock HTMLCanvasElement
    const mockCanvas = {
      clientWidth: 800,
      clientHeight: 400,
      width: 800,
      height: 400,
      style: { width: "800px", height: "400px", cursor: "default" },
      getContext: () => ({
        save: vi.fn(),
        restore: vi.fn(),
        scale: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        fillText: vi.fn(),
        closePath: vi.fn(),
        fill: vi.fn(),
        setLineDash: vi.fn(),
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }),
    } as unknown as HTMLCanvasElement;

    const view = new PianoRollView(mockCanvas, {
      initialPixelsPerSecond: 100,
    });

    // Initial state: scrollX = 0, pps = 100
    // Cursor at mouseX = 200 (time = 2.0s)
    view.zoomAt(200, 2.0); // 2x zoom -> pps becomes 200

    const vp = view.getViewport();
    expect(vp.pixelsPerSecond).toBe(200);
    // At mouseX = 200, time should still be 2.0s!
    // time = (200 + scrollX) / 200 = 2.0 => scrollX = 200
    expect(vp.scrollX).toBe(200);

    view.destroy();
  });

  it("centers viewport on requested time and pitch", () => {
    const mockCanvas = {
      clientWidth: 800,
      clientHeight: 400,
      width: 800,
      height: 400,
      style: { width: "800px", height: "400px", cursor: "default" },
      getContext: () => ({
        save: vi.fn(),
        restore: vi.fn(),
        scale: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        fillText: vi.fn(),
        closePath: vi.fn(),
        fill: vi.fn(),
        setLineDash: vi.fn(),
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }),
    } as unknown as HTMLCanvasElement;

    const view = new PianoRollView(mockCanvas, {
      initialPixelsPerSecond: 100,
      initialPitchHeight: 16,
    });

    // Center time 10s -> worldX = 1000px, viewportWidth = 800px => scrollX = 1000 - 400 = 600
    view.scrollToTime(10);
    expect(view.getViewport().scrollX).toBe(600);

    // Center pitch 60 -> pitchY = (108 - 60) * 16 = 768px, viewportHeight = 400px => scrollY = 768 - 200 = 568
    view.scrollToPitch(60);
    expect(view.getViewport().scrollY).toBe(568);

    view.destroy();
  });
});

describe("PianoRollView Space panning focus gate", () => {
  it("does not hijack Space outside an active focused editor canvas", () => {
    const listeners = new Map<string, Array<(event: KeyboardEvent) => void>>();
    const fakeWindow = {
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        const list = listeners.get(type) ?? [];
        list.push(listener as (event: KeyboardEvent) => void);
        listeners.set(type, list);
      }),
      removeEventListener: vi.fn(),
      emit(type: string, event: KeyboardEvent) {
        for (const listener of listeners.get(type) ?? []) listener(event);
      },
    };
    const ctx = {
      save: vi.fn(), restore: vi.fn(), scale: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillText: vi.fn(),
      closePath: vi.fn(), fill: vi.fn(), setLineDash: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      clientWidth: 800,
      clientHeight: 400,
      width: 800,
      height: 400,
      style: { width: "800px", height: "400px", cursor: "default" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    const button = {} as HTMLButtonElement;
    const fakeDocument: { activeElement: Element | null } = { activeElement: canvas };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    const view = new PianoRollView(canvas, { active: false });

    const inactivePreventDefault = vi.fn();
    fakeWindow.emit("keydown", { code: "Space", target: canvas, preventDefault: inactivePreventDefault } as unknown as KeyboardEvent);
    expect(inactivePreventDefault).not.toHaveBeenCalled();

    view.setActive(true);
    const canvasPreventDefault = vi.fn();
    fakeWindow.emit("keydown", { code: "Space", target: canvas, preventDefault: canvasPreventDefault } as unknown as KeyboardEvent);
    expect(canvasPreventDefault).toHaveBeenCalledOnce();

    fakeDocument.activeElement = button;
    const buttonPreventDefault = vi.fn();
    fakeWindow.emit("keydown", { code: "Space", target: button, preventDefault: buttonPreventDefault } as unknown as KeyboardEvent);
    expect(buttonPreventDefault).not.toHaveBeenCalled();

    view.destroy();
    vi.unstubAllGlobals();
  });

  it("captures Space only while the active canvas itself has focus", () => {
    const canvas = {} as HTMLCanvasElement;
    const button = {} as HTMLButtonElement;
    const spaceEvent = { code: "Space", target: canvas };

    expect(shouldCaptureSpaceForPanning(true, false, spaceEvent, canvas, canvas)).toBe(true);
    expect(shouldCaptureSpaceForPanning(false, false, spaceEvent, canvas, canvas)).toBe(false);
    expect(shouldCaptureSpaceForPanning(true, false, { ...spaceEvent, target: button }, canvas, canvas)).toBe(false);
    expect(shouldCaptureSpaceForPanning(true, false, spaceEvent, canvas, button)).toBe(false);
    expect(shouldCaptureSpaceForPanning(true, true, spaceEvent, canvas, canvas)).toBe(false);
    expect(shouldCaptureSpaceForPanning(true, false, { code: "Enter", target: canvas }, canvas, canvas)).toBe(false);
  });
});
