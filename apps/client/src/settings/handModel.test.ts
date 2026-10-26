import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, HandModelSchema, sanitizeSettings, SettingsSchema } from "./types";

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
});
