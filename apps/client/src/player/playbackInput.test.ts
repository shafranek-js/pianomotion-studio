import { describe, expect, it } from "vitest";
import { canUsePlaybackInput, isPlaybackToggleKey, shouldStartFromMidi } from "./playbackInput";
import type { MidiInputEvent } from "../midi/types";

const keyEvent = {
  key: " ", repeat: false, defaultPrevented: false, isComposing: false,
  altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
};
const note: MidiInputEvent = { type: "noteOn", pitch: 60, velocity: 90, timestampMs: 10 };

describe("playback input", () => {
  it("recognizes Space and Enter and leaves other piano shortcuts alone", () => {
    expect(isPlaybackToggleKey(keyEvent)).toBe(true);
    expect(isPlaybackToggleKey({ ...keyEvent, key: "Enter" })).toBe(true);
    for (const key of ["a", "ArrowRight", "Escape"]) expect(isPlaybackToggleKey({ ...keyEvent, key })).toBe(false);
  });

  it.each(["repeat", "defaultPrevented", "isComposing", "altKey", "ctrlKey", "metaKey", "shiftKey"] as const)(
    "does not capture a key with %s", flag => {
      expect(isPlaybackToggleKey({ ...keyEvent, [flag]: true })).toBe(false);
    },
  );

  it("protects the editor and Play Along clocks and blocked UI states", () => {
    expect(canUsePlaybackInput("performance", false)).toBe(true);
    expect(canUsePlaybackInput("play_along", false)).toBe(false);
    expect(canUsePlaybackInput("editor", false)).toBe(false);
    expect(canUsePlaybackInput("performance", true)).toBe(false);
  });

  it("only starts on a positive note-on while stopped or paused", () => {
    expect(shouldStartFromMidi(note, false)).toBe(true);
    expect(shouldStartFromMidi({ ...note, velocity: 0 }, false)).toBe(false);
    expect(shouldStartFromMidi({ ...note, type: "noteOff" }, false)).toBe(false);
    // Chords arriving during pending audio startup/count-in must never toggle off.
    expect(shouldStartFromMidi(note, true)).toBe(false);
  });
});
