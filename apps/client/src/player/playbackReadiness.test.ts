import { describe, expect, it } from "vitest";
import { playbackBlocker } from "./playbackReadiness";

const ready = {
  busy: false,
  needsReplan: false,
  preparingOutput: false,
  isPlaying: false,
  isBuffering: false,
};

describe("transport playback readiness", () => {
  it("keeps Play blocked while opening a source", () => {
    expect(playbackBlocker({ ...ready, busy: true })).toBe("reading");
  });

  it("keeps Play blocked while a performance plan is being recalculated", () => {
    expect(playbackBlocker({ ...ready, needsReplan: true })).toBe("analysis");
  });

  it("keeps Play blocked while the selected audio bank is being prepared", () => {
    expect(playbackBlocker({ ...ready, preparingOutput: true })).toBe("audio");
  });

  it("unblocks Play only when source, plan, and output are ready", () => {
    expect(playbackBlocker(ready)).toBeNull();
  });

  it("does not disable Pause when audio output changes during playback or buffering", () => {
    expect(playbackBlocker({ ...ready, preparingOutput: true, isPlaying: true })).toBeNull();
    expect(playbackBlocker({ ...ready, preparingOutput: true, isBuffering: true })).toBeNull();
  });

  it("prioritizes the active source operation over other readiness blockers", () => {
    expect(playbackBlocker({ ...ready, busy: true, needsReplan: true, preparingOutput: true })).toBe("reading");
  });
});
