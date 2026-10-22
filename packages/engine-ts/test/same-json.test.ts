import { describe, expect, it } from "vitest";
import { _same_json } from "../src/api.ts";

describe("ENG-14h replan DTO equality", () => {
  it("uses exact scalar equality like Python", () => {
    expect(_same_json(0.3, 0.3)).toBe(true);
    expect(_same_json(0.1 + 0.2, 0.3)).toBe(false);
    expect(_same_json(1, 1 + 1e-8)).toBe(false);
  });

  it("ignores object insertion order but not array order", () => {
    expect(_same_json({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(_same_json([1, 2], [2, 1])).toBe(false);
    expect(_same_json({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
  });
});
