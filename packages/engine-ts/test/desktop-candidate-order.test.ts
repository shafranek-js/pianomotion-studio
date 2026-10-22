import { describe, expect, it } from "vitest";
import { _compare_desktop_candidates } from "../src/api.ts";

function candidate(end: number, sourceInstrument: number, sourceOrdinal: number) {
  return { end, sourceInstrument, sourceOrdinal };
}

describe("ENG-14g desktop candidate ordering", () => {
  it("compares end times as numbers while preserving Python's reverse sort", () => {
    const ten = candidate(10, 0, 0);
    const nine = candidate(9, 0, 0);

    // Python sorts [end, ...] with reverse=True: 10 sorts before 9. String
    // coercion would put "9" before "10".
    expect(_compare_desktop_candidates(ten, nine)).toBeLessThan(0);
    expect(_compare_desktop_candidates(nine, ten)).toBeGreaterThan(0);
  });

  it("breaks ties with the numeric negated instrument and ordinal, like Python", () => {
    const instrumentTwo = candidate(2, 2, 0);
    const instrumentTen = candidate(2, 10, 0);

    // Reverse sort on -instrument puts instrument 2 (-2) before 10 (-10).
    expect(_compare_desktop_candidates(instrumentTwo, instrumentTen)).toBeLessThan(0);
    expect(_compare_desktop_candidates(instrumentTen, instrumentTwo)).toBeGreaterThan(0);
    expect(_compare_desktop_candidates(instrumentTwo, candidate(2, 2, 0))).toBe(0);
  });
});
