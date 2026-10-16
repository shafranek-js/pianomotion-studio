import { describe, expect, it } from "vitest";
import { _rounded } from "../src/api.ts";

describe("native numerical output boundary", () => {
  it("rejects invalid numerical results instead of serializing a fictitious origin", () => {
    for (const value of [NaN, Infinity, -Infinity, undefined]) {
      expect(() => _rounded(value)).toThrow(/non-finite/);
    }
    expect(_rounded(-0)).toBe(0);
    expect(_rounded(12.345678901)).toBe(12.3456789);
  });
});
