import { describe, expect, it } from "vitest";
import { PRACTICE_MIN_LOOP_SECONDS } from "@handthesia/contracts";
import { clampDraggedLoopRange, computeLoopOverlayMetrics } from "./StudioTransport";

describe("StudioTransport DAW A–B loop overlay helpers", () => {
  it("maps loop start/end seconds onto the timeline percentage span accounting for lead-in", () => {
    // Lead-in = -2s, Duration = 18s => total span = 20s
    const metrics = computeLoopOverlayMetrics(
      { startSeconds: 3, endSeconds: 8, enabled: true },
      18,
      -2,
      18,
    );

    // 3s is 5s after -2s => 5 / 20 = 25%
    expect(metrics.startPercent).toBeCloseTo(25, 5);
    // 8s is 10s after -2s => 10 / 20 = 50%
    expect(metrics.endPercent).toBeCloseTo(50, 5);
    expect(metrics.widthPercent).toBeCloseTo(25, 5);
    expect(metrics.enabled).toBe(true);
  });

  it("defaults to [0, duration] with enabled=false when practiceLoop is null", () => {
    const metrics = computeLoopOverlayMetrics(null, 40, -2, 40);
    expect(metrics.startSeconds).toBe(0);
    expect(metrics.endSeconds).toBe(40);
    expect(metrics.enabled).toBe(false);
    expect(metrics.startPercent).toBeCloseTo((2 / 42) * 100, 4);
    expect(metrics.endPercent).toBeCloseTo(100, 4);
  });

  it("clamps dragged start handle so it cannot cross the end handle minus PRACTICE_MIN_LOOP_SECONDS", () => {
    const clamped = clampDraggedLoopRange("start", 14.95, 2, 15, 30);
    expect(clamped.endSeconds).toBe(15);
    expect(clamped.startSeconds).toBeCloseTo(15 - PRACTICE_MIN_LOOP_SECONDS, 2);
  });

  it("clamps dragged end handle so it cannot cross below start handle plus PRACTICE_MIN_LOOP_SECONDS", () => {
    const clamped = clampDraggedLoopRange("end", 4.02, 4, 20, 30);
    expect(clamped.startSeconds).toBe(4);
    expect(clamped.endSeconds).toBeCloseTo(4 + PRACTICE_MIN_LOOP_SECONDS, 2);
  });
});
