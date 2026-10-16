import { describe, expect, it } from "vitest";
import { motionPlaybackWindow } from "./motionPlaybackPolicy";

describe("motion playback reserve", () => {
  it("prepares during negative lead-in with distinct pause, resume and request reserves", () => {
    expect(motionPlaybackWindow(-2, 60, 1)).toEqual({ start: 0, guardEnd: 0.1, resumeEnd: 2, prefetchEnd: 8 });
    // A 200ms sliver must not authorize a restart that immediately buffers again.
    expect(motionPlaybackWindow(12, 60, 1).resumeEnd).toBeGreaterThan(12.2);
  });
  it("preserves real-time reserve at double speed and grows it for measured slow workers", () => {
    expect(motionPlaybackWindow(4, 100, 2)).toEqual({ start: 4, guardEnd: 4.2, resumeEnd: 8, prefetchEnd: 20 });
    const slow = motionPlaybackWindow(4, 100, 1, 4000);
    expect(slow.resumeEnd).toBe(8.5);
    expect(slow.prefetchEnd).toBe(18);
    expect(motionPlaybackWindow(4, 100, 2, 20000).prefetchEnd).toBe(28);
  });
  it("clamps every reserve to the song end so short pieces and tails do not deadlock", () => {
    expect(motionPlaybackWindow(9.9, 10, 2, 10000)).toEqual({ start: 9.9, guardEnd: 10, resumeEnd: 10, prefetchEnd: 10 });
    expect(motionPlaybackWindow(0, 0, 1).prefetchEnd).toBe(0);
  });
});
