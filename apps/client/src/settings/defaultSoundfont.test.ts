import { describe, expect, it } from "vitest";
import { BUILTIN_SOUNDFONT_ID } from "../audio/soundfont/builtinSoundfont.ts";
import { DEFAULT_SETTINGS, SettingsSchema, sanitizeSettings } from "./types.ts";

describe("included piano defaults and existing preferences", () => {
  it("selects the bundled content identity for a new settings record", () => {
    expect(DEFAULT_SETTINGS.soundOutput).toBe("soundfont");
    expect(DEFAULT_SETTINGS.soundfontAssetId).toBe(BUILTIN_SOUNDFONT_ID);
    expect(sanitizeSettings({}).soundfontAssetId).toBe(BUILTIN_SOUNDFONT_ID);
    expect(SettingsSchema.parse({}).soundOutput).toBe("soundfont");
  });
  it("preserves explicit synth, MIDI and custom bank choices", () => {
    expect(sanitizeSettings({ soundOutput: "synth" }).soundOutput).toBe("synth");
    expect(sanitizeSettings({ soundOutput: "webmidi", webMidiDeviceId: "piano" }).soundOutput).toBe("webmidi");
    const previous = sanitizeSettings({ soundOutput: "soundfont", soundfontAssetId: "existing-bank" });
    expect(previous.soundfontAssetId).toBe("existing-bank");
  });
  it("uses the included piano when no user bank was selected", () => {
    expect(sanitizeSettings({ soundOutput: "soundfont", soundfontAssetId: null }).soundfontAssetId).toBe(BUILTIN_SOUNDFONT_ID);
  });
});
