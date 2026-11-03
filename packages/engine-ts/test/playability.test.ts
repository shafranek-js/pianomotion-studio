import { describe, expect, it } from "vitest";
import {
  checkPianoPlayability,
  repairPianoHandSplit,
} from "../src/playability.ts";

describe("playability", () => {
  it("keeps playable chords untouched and reports zero issues", () => {
    const notes = [
      { noteId: "n1", pitch: 48, startSeconds: 0, endSeconds: 1, hand: "left" as const },
      { noteId: "n2", pitch: 55, startSeconds: 0, endSeconds: 1, hand: "left" as const },
      { noteId: "n3", pitch: 60, startSeconds: 0, endSeconds: 1, hand: "right" as const },
      { noteId: "n4", pitch: 64, startSeconds: 0, endSeconds: 1, hand: "right" as const },
      { noteId: "n5", pitch: 67, startSeconds: 0, endSeconds: 1, hand: "right" as const },
    ];
    const res = repairPianoHandSplit(notes);
    expect(res.summary.flagged).toBe(0);
    expect(res.summary.moved).toBe(0);
    expect(res.summary.unplayable).toBe(0);
    expect(res.summary.warnings).toBe(0);
    expect(res.reassignedByIndex.size).toBe(0);
  });

  it("repairs a 6-note chord assigned to a single hand by partitioning across LH and RH", () => {
    const notes: Array<{ noteId: string; pitch: number; startSeconds: number; endSeconds: number; hand: "left" | "right" }> = [
      { noteId: "n1", pitch: 48, startSeconds: 0, endSeconds: 1, hand: "right" },
      { noteId: "n2", pitch: 52, startSeconds: 0, endSeconds: 1, hand: "right" },
      { noteId: "n3", pitch: 55, startSeconds: 0, endSeconds: 1, hand: "right" },
      { noteId: "n4", pitch: 60, startSeconds: 0, endSeconds: 1, hand: "right" },
      { noteId: "n5", pitch: 64, startSeconds: 0, endSeconds: 1, hand: "right" },
      { noteId: "n6", pitch: 67, startSeconds: 0, endSeconds: 1, hand: "right" },
    ];
    const res = repairPianoHandSplit(notes);
    expect(res.summary.flagged).toBe(1);
    expect(res.summary.moved).toBeGreaterThan(0);
    expect(res.summary.unplayable).toBe(0);
    const leftCount = res.notes.filter((n) => n.hand === "left").length;
    const rightCount = res.notes.filter((n) => n.hand === "right").length;
    expect(leftCount).toBeGreaterThanOrEqual(2);
    expect(rightCount).toBeGreaterThanOrEqual(2);
  });

  it("flags rapid leaps > 24 semitones in < 0.12s as jump warnings", () => {
    const summary = checkPianoPlayability({
      notes: [
        { noteId: "n1", pitch: 48, startSeconds: 0.0, endSeconds: 0.05, hand: "right" },
        { noteId: "n2", pitch: 84, startSeconds: 0.08, endSeconds: 0.5, hand: "right" },
      ],
    });
    expect(summary.warnings).toBeGreaterThanOrEqual(1);
    expect(summary.issues.some((i) => i.kind === "jump")).toBe(true);
  });
});
