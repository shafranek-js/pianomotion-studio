import { describe, expect, it } from "vitest";

import {
  DEFAULT_ANATOMY,
  DEFAULT_BEHAVIOR,
  fromProfileDto,
  normalizeBehavior,
} from "../src/pianist.ts";
import { apply_pianist, getPianistBehavior, reset_context, travel_time } from "../src/fingering.ts";
import { _resolve_profile } from "../src/api.ts";

describe("profile behavior normalization", () => {
  it("clamps slider values into their spec range", () => {
    const behavior = normalizeBehavior({ max_speed: 0, smoothness: 1e9, retraction: -4 });
    expect(behavior.max_speed).toBe(0.5);
    expect(behavior.smoothness).toBe(0.15);
    expect(behavior.retraction).toBe(0);
  });

  it("keeps valid options, ignores unknown keys and drops junk", () => {
    const behavior = normalizeBehavior({
      octaves: "5",
      not_a_setting: 1,
      max_speed: "fast",
    });
    expect(behavior.octaves).toBe("5");
    expect(behavior.max_speed).toBe(DEFAULT_BEHAVIOR.max_speed);
    expect("not_a_setting" in behavior).toBe(false);
  });

  it("rejects malformed values in strict mode but accepts out-of-range numbers", () => {
    expect(() => normalizeBehavior({ max_speed: "fast" }, { strict: true })).toThrow(/max_speed/);
    expect(() => normalizeBehavior({ octaves: "nonsense" }, { strict: true })).toThrow(/octaves/);
    expect(() => normalizeBehavior({ max_speed: 0 }, { strict: true })).not.toThrow();
    expect(() => normalizeBehavior({ smoothness: Number.NaN }, { strict: true })).toThrow(/smoothness/);
  });

  it("normalizes a profile DTO before it reaches the model", () => {
    const p = fromProfileDto({
      profileId: "zero-speed",
      behavior: { max_speed: 0, smoothness: 1e9 },
    });
    expect(getPianistBehavior(p, "max_speed")).toBe(0.5);
    expect(getPianistBehavior(p, "smoothness")).toBe(0.15);
  });

  it("never divides by zero even for a hand-built pianist", () => {
    apply_pianist({ anatomy: { ...DEFAULT_ANATOMY }, behavior: { max_speed: 0 }, weights: {} });
    const seconds = travel_time(1);
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeGreaterThan(0);
    reset_context(null);
  });

  it("clamps behavior at the API boundary", () => {
    const base = _resolve_profile(null)[0];
    const [resolved] = _resolve_profile({
      ...base,
      behavior: { ...base.behavior, max_speed: 0, smoothness: 1e9 },
    });
    expect(resolved.behavior.max_speed).toBe(0.5);
    expect(resolved.behavior.smoothness).toBe(0.15);
  });

  it("reports malformed behavior at the API boundary", () => {
    const base = _resolve_profile(null)[0];
    expect(() =>
      _resolve_profile({ ...base, behavior: { ...base.behavior, max_speed: "fast" } }),
    ).toThrow(/max_speed/);
    expect(() =>
      _resolve_profile({ ...base, behavior: { ...base.behavior, octaves: "nonsense" } }),
    ).toThrow(/octaves/);
  });
});
