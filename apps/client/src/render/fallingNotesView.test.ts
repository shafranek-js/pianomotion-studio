import type { Note, PerformancePlan } from "@handthesia/contracts";
import { Graphics } from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FallingNotesView } from "./fallingNotesView";
import { KeyboardLayout } from "./keyboardView";

function makeNote(noteId: string, pitch: number, startSeconds: number, endSeconds: number): Note {
  return {
    noteId,
    trackId: "track-1",
    pitch,
    velocity: 88,
    startSeconds,
    endSeconds,
    hand: "right",
    finger: 3,
    glissando: false,
  };
}

function makePlan(events: PerformancePlan["events"]): PerformancePlan {
  return {
    schemaVersion: 1,
    planId: "render-performance-plan",
    projectId: "render-project",
    inputRevision: 1,
    profileId: "render-profile",
    profileRevision: 1,
    engineVersion: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    diagnostics: [],
    kind: "performance",
    fingeringPlanId: "render-fingering-plan",
    events,
  };
}

describe("FallingNotesView performance timing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("draws rolled notes at performed durations in realistic and equal keyboard layouts", () => {
    const earlySource = makeNote("early-release", 60, 0.5, 2.8);
    const rolledSource = makeNote("rolled-note", 88, 0.75, 2.2);
    const unplayableSource = makeNote("unplayable", 67, 0.5, 3.0);
    const plan = makePlan([
      { type: "press", timeSeconds: 0.75, noteId: "early-release", pitch: 60, velocity: 88 },
      { type: "press", timeSeconds: 1.25, noteId: "rolled-note", pitch: 88, velocity: 88 },
      { type: "release", timeSeconds: 1.55, noteId: "rolled-note" },
      { type: "release", timeSeconds: 1.75, noteId: "early-release" },
    ]);

    for (const style of ["realistic", "equal"] as const) {
      const layout = new KeyboardLayout();
      layout.compute({ x: 0, y: 100, width: 1000, height: 100 }, style);
      const view = new FallingNotesView({ pixelsPerSecond: 100 });
      view.setLayout({
        hitLineY: 100,
        viewportTop: 0,
        viewportBottom: 100,
        keyboardLayout: layout,
      });
      view.setNotes([earlySource, rolledSource, unplayableSource]);
      view.setPerformancePlan(plan);

      const timings = view.getRenderedNoteTimings();
      expect(timings.map((note) => [note.noteId, note.startSeconds, note.endSeconds])).toEqual([
        ["early-release", 0.75, 1.75],
        ["rolled-note", 1.25, 1.55],
      ]);
      expect(timings[0]?.sourceNote).toBe(earlySource);
      expect(timings.some((note) => note.noteId === "unplayable")).toBe(false);

      const notesGraphics = (view as unknown as { notesGraphics: Graphics }).notesGraphics;
      const bodySpy = vi.spyOn(notesGraphics, "roundRect");
      view.update(1.25);

      // The first bar is 100px tall from the performed 1.0s interval. The
      // second rolled note starts at the boundary and is 30px tall.
      expect(bodySpy.mock.calls.map((call) => call[3])).toEqual([100, 30]);
      expect(bodySpy.mock.calls.map((call) => call[1])).toEqual([50, 70]);
      view.destroy();
    }
  });
});
