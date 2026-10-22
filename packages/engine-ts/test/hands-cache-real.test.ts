import { describe, expect, it } from "vitest";
import { HandAnimator, _cap_cache } from "../src/hands.ts";

function animatorStub(): any {
  const animator = Object.create(HandAnimator.prototype) as any;
  animator._cache = {};
  animator._idle_cache = {};
  animator._items_at = () => [];
  animator._run_w = () => [];
  animator._low = () => 0;
  animator._solve_hand = () => ({});
  animator._idle_shift_parts = () => [0, 0, 0];
  return animator;
}

describe("ENG-8 4k hand caches", () => {
  it("evicts the real grid-pose cache", () => {
    const animator = animatorStub();
    for (let key = 0; key < 5000; key += 1) animator._grid_pose(key);
    expect(Object.keys(animator._cache).length).toBeLessThan(5000);
    expect(Object.keys(animator._cache).length).toBeLessThanOrEqual(4001);
  });

  it("evicts the real idle-cache path", () => {
    const animator = animatorStub();
    for (let key = 0; key < 5000; key += 1) animator._idle_cached(key);
    expect(Object.keys(animator._idle_cache).length).toBeLessThan(5000);
    expect(Object.keys(animator._idle_cache).length).toBeLessThanOrEqual(4001);
  });

  it("supports the 4k threshold through the shared helper", () => {
    const cache: Record<string, number> = Object.fromEntries(Array.from({ length: 4001 }, (_, i) => [`k${i}`, i]));
    _cap_cache(cache, 4000);
    expect(Object.keys(cache)).toHaveLength(0);
  });
});
