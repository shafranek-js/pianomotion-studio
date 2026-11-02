import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, HandModelSchema, TestingHandMaterialSchema, TestingThumbStrengthSchema, sanitizeSettings, SettingsSchema } from "./types";

describe("hand model settings compatibility", () => {
  it("uses Rigged hands as the default and migrates legacy model IDs to Rigged hands", () => {
    expect(DEFAULT_SETTINGS.handModel).toBe("rigged-experimental");
    expect(SettingsSchema.parse({}).handModel).toBe("rigged-experimental");
    expect(sanitizeSettings({ language: "cs" }).handModel).toBe("rigged-experimental");
    expect(sanitizeSettings({ handModel: "anatomical" }).handModel).toBe("rigged-experimental");
    expect(sanitizeSettings({ handModel: "anatomical-improved" }).handModel).toBe("rigged-experimental");
    expect(sanitizeSettings({ handModel: "testing" }).handModel).toBe("rigged-experimental");
    expect(sanitizeSettings({ handModel: "testing2" }).handModel).toBe("rigged-experimental");
  });

  it("accepts and preserves Rigged hands and WebXR through schema and sanitization", () => {
    expect(HandModelSchema.parse("rigged-experimental")).toBe("rigged-experimental");
    expect(HandModelSchema.parse("webxr")).toBe("webxr");
    expect(sanitizeSettings({ handModel: "rigged-experimental" }).handModel).toBe("rigged-experimental");
    expect(sanitizeSettings({ handModel: "webxr" }).handModel).toBe("webxr");
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

  it("keeps bind-alignment overlay opt-in and persists explicit enable/disable", () => {
    expect(DEFAULT_SETTINGS.testingShowBindAlignment).toBe(false);
    expect(SettingsSchema.parse({}).testingShowBindAlignment).toBe(false);
    expect(sanitizeSettings({ testingShowBindAlignment: true }).testingShowBindAlignment).toBe(true);
    expect(sanitizeSettings({ testingShowBindAlignment: false }).testingShowBindAlignment).toBe(false);
    expect(sanitizeSettings({ testingShowBindAlignment: "true" }).testingShowBindAlignment).toBe(false);
    expect(SettingsSchema.safeParse({ testingShowBindAlignment: "true" }).success).toBe(false);
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
