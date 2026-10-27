import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, HandModelSchema, TestingHandMaterialSchema, TestingThumbStrengthSchema, sanitizeSettings, SettingsSchema } from "./types";

describe("hand model settings compatibility", () => {
  it("keeps anatomical as the default for new and legacy settings", () => {
    expect(DEFAULT_SETTINGS.handModel).toBe("anatomical");
    expect(SettingsSchema.parse({}).handModel).toBe("anatomical");
    expect(sanitizeSettings({ language: "cs" }).handModel).toBe("anatomical");
    expect(sanitizeSettings({ handModel: "anatomical" }).handModel).toBe("anatomical");
  });

  it("accepts and preserves the improved ID through schema and sanitization", () => {
    expect(HandModelSchema.parse("anatomical-improved")).toBe("anatomical-improved");
    expect(HandModelSchema.parse("testing")).toBe("testing");
    expect(sanitizeSettings({ handModel: "testing" }).handModel).toBe("testing");
    expect(SettingsSchema.parse({ handModel: "anatomical-improved" }).handModel).toBe("anatomical-improved");
    expect(sanitizeSettings({ handModel: "anatomical-improved" }).handModel).toBe("anatomical-improved");
  });

  it("preserves WebXR and falls back safely for unknown imported IDs", () => {
    expect(sanitizeSettings({ handModel: "webxr" }).handModel).toBe("webxr");
    expect(sanitizeSettings({ handModel: "future-model" }).handModel).toBe(DEFAULT_SETTINGS.handModel);
    expect(SettingsSchema.safeParse({ handModel: "future-model" }).success).toBe(false);
  });
  it("persists only known Testing material diagnostics and defaults to original", () => {
    expect(SettingsSchema.parse({}).testingHandMaterial).toBe("original");
    expect(sanitizeSettings({ handModel: "testing" }).testingHandMaterial).toBe("original");
    for (const mode of ["original", "no-normal", "no-albedo", "clay"] as const) {
      expect(TestingHandMaterialSchema.parse(mode)).toBe(mode);
      expect(sanitizeSettings({ handModel: "testing", testingHandMaterial: mode }).testingHandMaterial).toBe(mode);
    }
    expect(sanitizeSettings({ testingHandMaterial: "invalid" }).testingHandMaterial).toBe("original");
    expect(SettingsSchema.safeParse({ testingHandMaterial: "invalid" }).success).toBe(false);
  });

  it("enables opt-out Testing-only key contact correction with a persisted setting", () => {
    expect(DEFAULT_SETTINGS.testingKeyContact).toBe(true);
    expect(SettingsSchema.parse({}).testingKeyContact).toBe(true);
    expect(sanitizeSettings({ testingKeyContact: false }).testingKeyContact).toBe(false);
    expect(sanitizeSettings({ testingKeyContact: true }).testingKeyContact).toBe(true);
    expect(sanitizeSettings({ testingKeyContact: "false" }).testingKeyContact).toBe(true);
    expect(SettingsSchema.safeParse({ testingKeyContact: "false" }).success).toBe(false);
  });

  it("defaults to unmodified Testing thumb weights and rejects unsanctioned strengths", () => {
    expect(DEFAULT_SETTINGS.testingThumbStrength).toBe(0);
    expect(SettingsSchema.parse({}).testingThumbStrength).toBe(0);
    for (const strength of [0, 0.25, 0.5, 0.75, 1] as const) {
      expect(TestingThumbStrengthSchema.parse(strength)).toBe(strength);
      expect(SettingsSchema.parse({ testingThumbStrength: strength }).testingThumbStrength).toBe(strength);
      expect(sanitizeSettings({ handModel: "testing", testingThumbStrength: strength }).testingThumbStrength).toBe(strength);
    }
    for (const invalid of [-1, 2, 0.333, "0.5", null]) {
      expect(TestingThumbStrengthSchema.safeParse(invalid).success).toBe(false);
      expect(sanitizeSettings({ testingThumbStrength: invalid }).testingThumbStrength).toBe(0);
    }
  });

});
