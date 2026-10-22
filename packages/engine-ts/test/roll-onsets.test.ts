import { describe, expect, it } from "vitest";
import { _roll_onsets } from "../src/hands.ts";

const notes = [{ start: 0 }, { start: 0 }, { start: 0 }];

describe("ENG-14d rolled-chord onsets", () => {
  it("keeps the natural roll when there is room", () => {
    const onsets = _roll_onsets(notes, 0.1);
    expect(onsets).toHaveLength(3);
    onsets.forEach((value, index) => expect(value).toBeCloseTo(index * 0.1, 9));
  });

  it("compresses the roll to the next chord boundary", () => {
    const onsets = _roll_onsets(notes, 0.1, 0.15);
    expect(onsets[0]).toBeCloseTo(0, 9);
    expect(onsets[1]).toBeCloseTo(0.1, 9);
    expect(onsets[2]).toBeCloseTo(0.15, 9);
    expect(Math.max(...onsets)).toBeLessThanOrEqual(0.15 + 1e-9);
  });

  it("does not move a note that already starts after the boundary", () => {
    const late = [{ start: 0.3 }, { start: 0.3 }];
    expect(_roll_onsets(late, 0.1, 0.1)).toEqual([0.3, 0.3]);
  });
});
