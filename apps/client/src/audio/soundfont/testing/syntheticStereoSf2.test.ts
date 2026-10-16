import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSf2, parseSf2Async } from "../sf2Parser.ts";
import { createSyntheticStereoSf2 } from "./syntheticStereoSf2.ts";

afterEach(() => vi.unstubAllGlobals());

describe("synthetic linked stereo SF2 fixture", () => {
  it("parses linked channels, per-channel pan, and loops through the sync parser", () => {
    const parsed = parseSf2(createSyntheticStereoSf2());

    expect(parsed.samples.slice(0, 2).map(({ sampleType, sampleLink }) => ({ sampleType, sampleLink }))).toEqual([
      { sampleType: 4, sampleLink: 1 },
      { sampleType: 2, sampleLink: 0 },
    ]);
    expect(parsed.presets[0]?.zones.map(({ sampleIndex, instrumentId, sampleModes, pan }) => ({
      sampleIndex,
      instrumentId,
      sampleModes,
      pan,
    }))).toEqual([
      { sampleIndex: 0, instrumentId: 0, sampleModes: 3, pan: -500 },
      { sampleIndex: 1, instrumentId: 0, sampleModes: 3, pan: 500 },
    ]);
    expect(parsed.rawSampleData?.length).toBeGreaterThan(0);
  });

  it("parses the same fixture from a Blob without materializing its PCM", async () => {
    vi.stubGlobal("Worker", undefined);
    const blob = new Blob([new Uint8Array(createSyntheticStereoSf2()).buffer]);
    const parsed = await parseSf2Async(blob);

    expect(parsed.rawSampleData).toBeUndefined();
    expect(parsed.sampleSource?.blob).toBe(blob);
    expect(parsed.sampleSource?.sampleCount).toBeGreaterThan(0);
    expect(parsed.presets[0]?.zones.map(({ sampleIndex, pan }) => ({ sampleIndex, pan }))).toEqual([
      { sampleIndex: 0, pan: -500 },
      { sampleIndex: 1, pan: 500 },
    ]);
  });
});
