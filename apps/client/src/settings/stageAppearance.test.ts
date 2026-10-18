import { describe, expect, it } from "vitest";
import { DEFAULT_STAGE_APPEARANCE, normalizeStageAppearance } from "./stageAppearance";
import { sanitizeSettings, SettingsSchema } from "./types";

describe("stage preference compatibility", () => {
  it("upgrades old settings without losing unrelated preferences", () => {
    const migrated = sanitizeSettings({ language: "uk", masterVolume: 0.35 });
    expect(migrated.stageAppearance).toEqual(DEFAULT_STAGE_APPEARANCE);
    expect(migrated.language).toBe("uk");
    expect(migrated.masterVolume).toBe(0.35);
    expect(SettingsSchema.parse({}).stageAppearance).toEqual(DEFAULT_STAGE_APPEARANCE);
  });

  it("clamps unsafe render inputs and preserves valid preset and quality", () => {
    expect(normalizeStageAppearance({ preset: "studio", quality: "high", brightness: 100, reflection: -1 }))
      .toEqual({ preset: "studio", quality: "high", brightness: 1.5, reflection: 0 });
    expect(normalizeStageAppearance({ brightness: NaN, reflection: Infinity, quality: "unbounded", preset: null }))
      .toEqual(DEFAULT_STAGE_APPEARANCE);
  });

  it("returns independent snapshots for nested stage values", () => {
    const first = sanitizeSettings(null);
    first.stageAppearance!.brightness = 1.5;
    expect(sanitizeSettings(null).stageAppearance!.brightness).toBe(1);
    const copy = normalizeStageAppearance(first.stageAppearance);
    copy.reflection = 0;
    expect(first.stageAppearance!.reflection).toBe(DEFAULT_STAGE_APPEARANCE.reflection);
  });
});
