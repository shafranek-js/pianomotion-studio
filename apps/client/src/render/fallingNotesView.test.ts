import type { FingeringPlan, Note, PerformancePlan } from "@handthesia/contracts";
import { describe, expect, it } from "vitest";
import { FallingNotesView } from "./fallingNotesView";
import { KeyboardLayout } from "./keyboardView";

function note(noteId: string, overrides: Partial<Note> = {}): Note {
  return {
    noteId,
    trackId: "track-1",
    pitch: 60,
    velocity: 90,
    startSeconds: 1,
    endSeconds: 1.5,
    hand: "right",
    finger: 1,
    glissando: false,
    ...overrides,
  };
}

describe("FallingNotesView painted geometry", () => {
  it("uses the drawn lane and visible clipped rectangle for hit testing and marquee selection", () => {
    const keyboard = new KeyboardLayout();
    keyboard.compute({ x: 0, y: 220, width: 1040, height: 70 }, "realistic");
    const view = new FallingNotesView({ pixelsPerSecond: 100 });
    view.setLayout({ hitLineY: 220, viewportTop: 0, viewportBottom: 220, keyboardLayout: keyboard });
    view.setNotes([note("overlap-a"), note("overlap-b")]);
    view.update(1.25);

    const [first, second] = view.getPaintedNoteGeometries();
    expect(first?.x).toBe(keyboard.getLane(60).x);
    expect(first?.width).toBe(keyboard.getLane(60).width);
    expect(first?.y).toBe(195);
    expect(first?.height).toBe(50);
    expect(first?.visibleRect).toEqual({
      x: first?.x,
      y: 195,
      width: first?.width,
      height: 25,
    });
    expect(second?.visibleRect).toEqual(first?.visibleRect);

    const x = first!.x + first!.width / 2;
    expect(view.getNoteAtPoint(x, 208)).toBe("overlap-b");
    expect(view.getNoteAtPoint(x, 228)).toBeNull();
    expect(view.getNoteIdsInRect({ x: x - 1, y: 205, width: 2, height: 5 })).toEqual([
      "overlap-a",
      "overlap-b",
    ]);

    view.destroy({ children: true });
  });

  it("projects source-time notes at the independent view anchor without changing timing", () => {
    const keyboard = new KeyboardLayout();
    keyboard.compute({ x: 0, y: 300, width: 880, height: 70 }, "realistic");
    const view = new FallingNotesView({ pixelsPerSecond: 120 });
    view.setLayout({ hitLineY: 300, viewportTop: 0, viewportBottom: 300, keyboardLayout: keyboard });
    view.setNotes([note("source-time", { startSeconds: 4, endSeconds: 4.5 })]);
    const performed: PerformancePlan = {
      schemaVersion: 1,
      kind: "performance",
      planId: "performance-1",
      projectId: "project-1",
      inputRevision: 1,
      profileId: "profile-1",
      profileRevision: 1,
      engineVersion: "test",
      fingeringPlanId: "fingering-1",
      diagnostics: [],
      events: [
        { type: "press", timeSeconds: 5, noteId: "source-time", pitch: 60, velocity: 90 },
        { type: "release", timeSeconds: 5.5, noteId: "source-time" },
      ],
    };
    const fingering: FingeringPlan = {
      schemaVersion: 1,
      kind: "fingering",
      planId: "fingering-1",
      projectId: "project-1",
      inputRevision: 1,
      profileId: "profile-1",
      profileRevision: 1,
      engineVersion: "test",
      diagnostics: [],
      assignments: [
        { noteId: "source-time", hand: "left", finger: 4, disposition: "played" },
      ],
    };
    view.setPerformancePlan(performed);
    expect(view.getRenderedNoteTimings()[0]?.startSeconds).toBe(5);
    view.setFingeringPlan(fingering);
    view.update(4);

    const geometry = view.getPaintedNoteGeometries(3.5)[0];
    expect(view.getRenderedNoteTimings()[0]?.startSeconds).toBe(4);
    expect(view.getRenderedNoteTimings()[0]?.hand).toBe("left");
    expect(view.getRenderedNoteTimings()[0]?.finger).toBe(4);
    expect(geometry?.y).toBe(180);
    expect(geometry?.visibleRect.height).toBe(60);

    view.destroy({ children: true });
  });
});
