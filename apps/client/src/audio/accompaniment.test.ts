import { describe, expect, it } from "vitest";
import { extractAccompanimentPlan } from "./accompaniment.ts";

function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return bytes;
}

function track(name: string, channel: number, pitch: number, start: number, duration: number): number[] {
  const nameBytes = Array.from(new TextEncoder().encode(name));
  const events = [
    0, 0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes,
    0, 0xc0 | channel, 0,
    ...vlq(start), 0x90 | channel, pitch, 90,
    ...vlq(duration), 0x80 | channel, pitch, 0,
    0, 0xff, 0x2f, 0,
  ];
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(events.length), ...events];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function multiTrackMidi(): Uint8Array {
  const tracks = [
    track("Piano", 0, 60, 0, 480),
    track("Singstimme", 1, 10, 240, 480),
    track("Drums", 9, 36, 0, 480),
  ];
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1, 0, tracks.length, 1, 0xe0,
    ...tracks.flat(),
  ]);
}

function midiWithDelayedPiano(): Uint8Array {
  const tracks = [
    track("Piano", 0, 60, 240, 480),
    track("Violin", 1, 67, 0, 480),
  ];
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1, 0, tracks.length, 1, 0xe0,
    ...tracks.flat(),
  ]);
}

describe("extractAccompanimentPlan", () => {
  it("keeps multilingual non-piano pitched tracks, excludes drums, and preserves full MIDI pitch range", () => {
    const plan = extractAccompanimentPlan(multiTrackMidi());

    expect(plan.tracks).toHaveLength(1);
    expect(plan.tracks[0]).toMatchObject({ name: "Singstimme", program: 0, noteCount: 1 });
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toMatchObject({ pitch: 10, startSeconds: 0.25, endSeconds: 0.75 });
    expect(plan.events.map(({ type }) => type)).toEqual(["press", "release"]);
  });

  it("does not create an accompaniment plan for piano-only MIDI", () => {
    const pianoOnly = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, 1, 0xe0,
      ...track("Piano", 0, 60, 0, 480),
    ]);
    expect(extractAccompanimentPlan(pianoOnly)).toMatchObject({ tracks: [], notes: [], events: [] });
  });

  it("keeps accompaniment at t=0 when the piano enters later without positive offset normalization", () => {
    const plan = extractAccompanimentPlan(midiWithDelayedPiano());
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]?.startSeconds).toBe(0);
  });

  it("returns an empty plan for malformed MIDI bytes", () => {
    expect(extractAccompanimentPlan(new Uint8Array(16))).toMatchObject({
      tracks: [], notes: [], events: [],
    });
  });
});
