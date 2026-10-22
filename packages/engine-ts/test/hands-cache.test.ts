import { describe, expect, it } from "vitest";
import { _cap_cache } from "../src/hands.ts";

function cacheWith(size: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: size }, (_, index) => [`key-${index}`, index]));
}

describe("ENG-8 hand animation cache cap", () => {
  it("keeps a cache at the 20k boundary and clears it above the boundary", () => {
    const atLimit = cacheWith(20_000);
    _cap_cache(atLimit);
    expect(Object.keys(atLimit)).toHaveLength(20_000);

    const overLimit = cacheWith(20_001);
    _cap_cache(overLimit);
    expect(Object.keys(overLimit)).toHaveLength(0);
  });
});
