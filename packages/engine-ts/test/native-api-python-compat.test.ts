import { describe, expect, it } from "vitest";
import { pyEq, pyNotEq } from "../src/pythonCompat.ts";

describe("Python equality compatibility", () => {
  it("uses exact binary64 numeric equality and leaves NaN unequal", () => {
    expect(pyEq(1, 1)).toBe(true);
    expect(pyEq(0, -0)).toBe(true);
    expect(pyEq(1, 1 + 1e-8)).toBe(false);
    expect(pyNotEq(1, 1 + 1e-8)).toBe(true);
    expect(pyEq(Number.NaN, Number.NaN)).toBe(false);
    expect(pyNotEq(Number.NaN, Number.NaN)).toBe(true);
  });

  it("treats booleans as Python integers in scalar, sequence, and set equality", () => {
    expect(pyEq(true, 1)).toBe(true);
    expect(pyEq(false, 0)).toBe(true);
    expect(pyEq(true, 0)).toBe(false);
    expect(pyEq([1, 0], [true, false])).toBe(true);
    expect(pyEq(new Set([1, 0]), new Set([true, false]))).toBe(true);
    expect(pyEq(new Set([Number.NaN]), new Set([Number.NaN]))).toBe(false);
  });
});
