export type StagePreset = "concert" | "studio";
export type StageQuality = "auto" | "low" | "high";

export interface StageAppearance {
  preset: StagePreset;
  brightness: number;
  reflection: number;
  quality: StageQuality;
}

export const DEFAULT_STAGE_APPEARANCE: Readonly<StageAppearance> = Object.freeze({
  preset: "concert",
  brightness: 1,
  reflection: 0.28,
  quality: "auto",
});

export function normalizeStageAppearance(input: unknown): StageAppearance {
  const value = input && typeof input === "object" ? input as Partial<StageAppearance> : {};
  return {
    preset: value.preset === "studio" ? "studio" : "concert",
    brightness: typeof value.brightness === "number" && Number.isFinite(value.brightness)
      ? Math.min(1.5, Math.max(0.5, value.brightness)) : DEFAULT_STAGE_APPEARANCE.brightness,
    reflection: typeof value.reflection === "number" && Number.isFinite(value.reflection)
      ? Math.min(1, Math.max(0, value.reflection)) : DEFAULT_STAGE_APPEARANCE.reflection,
    quality: value.quality === "low" || value.quality === "high" ? value.quality : "auto",
  };
}
