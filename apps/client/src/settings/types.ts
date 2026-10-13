import { z } from "zod";
import { M1KeyStyleSchema, type M1KeyStyle } from "@handthesia/contracts";

export const SETTINGS_STORAGE_KEY = "handthesia:settings";

export const KeyStyleSchema = M1KeyStyleSchema;
export type KeyStyle = M1KeyStyle;

export const SoundTimbreSchema = z.enum(["acoustic", "bright", "warm"]);
export type SoundTimbre = z.infer<typeof SoundTimbreSchema>;

export const RenderCapFpsSchema = z.union([
  z.literal(0),
  z.literal(30),
  z.literal(60),
  z.literal(120),
]);
export type RenderCapFps = z.infer<typeof RenderCapFpsSchema>;

export const SkinStyleSchema = z.enum([
  "cartoon",
  "gloves",
  "robot",
  "skeleton",
  "realistic",
  "photo-segmented",
  "photo-mesh",
  "photo-3d",
]);
export type SkinStyleSetting = z.infer<typeof SkinStyleSchema>;

export const SoundOutputSchema = z.enum(["synth", "soundfont", "webmidi"]);
export type SoundOutputSetting = z.infer<typeof SoundOutputSchema>;

export interface Settings {
  keyStyle: "realistic" | "equal";
  playbackSpeed: number;
  masterVolume: number;
  leadInSeconds: number;
  showFpsOverlay: boolean;
  showFingerLabels: boolean;
  showNoteNames: boolean;
  soundTimbre: "acoustic" | "bright" | "warm";
  renderCapFps: number;
  skinStyle:
    | "cartoon"
    | "gloves"
    | "robot"
    | "skeleton"
    | "realistic"
    | "photo-segmented"
    | "photo-mesh"
    | "photo-3d";
  showHandShadow: boolean;
  soundOutput: "synth" | "soundfont" | "webmidi";
}
export type AppSettings = Settings;

export const SettingsSchema = z.object({
  keyStyle: KeyStyleSchema.default("realistic"),
  playbackSpeed: z.number().min(0.25).max(2.0).default(1.0),
  masterVolume: z.number().min(0.0).max(1.0).default(0.8),
  leadInSeconds: z.number().min(-2.0).max(0.0).default(-2.0),
  showFpsOverlay: z.boolean().default(false),
  showFingerLabels: z.boolean().default(true),
  showNoteNames: z.boolean().default(false),
  soundTimbre: SoundTimbreSchema.default("acoustic"),
  renderCapFps: z
    .number()
    .refine((fps) => [0, 30, 60, 120].includes(fps), {
      message: "renderCapFps must be 0, 30, 60, or 120",
    })
    .default(60),
  skinStyle: SkinStyleSchema.default("photo-segmented"),
  showHandShadow: z.boolean().default(true),
  soundOutput: SoundOutputSchema.default("synth"),
});

export const DEFAULT_SETTINGS: Settings = {
  keyStyle: "realistic",
  playbackSpeed: 1.0,
  masterVolume: 0.8,
  leadInSeconds: -2.0,
  showFpsOverlay: false,
  showFingerLabels: true,
  showNoteNames: false,
  soundTimbre: "acoustic",
  renderCapFps: 60,
  skinStyle: "photo-segmented",
  showHandShadow: true,
  soundOutput: "synth",
};

export type SettingsListener = (settings: Settings) => void;

/**
 * Sanitizes and clamps partial settings input against valid domain bounds.
 */
export function sanitizeSettings(input: Partial<Settings> | unknown): Settings {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_SETTINGS };
  }
  const raw = input as Partial<Settings>;

  const keyStyle: "realistic" | "equal" =
    raw.keyStyle === "equal" || raw.keyStyle === "realistic"
      ? raw.keyStyle
      : DEFAULT_SETTINGS.keyStyle;

  const playbackSpeed =
    typeof raw.playbackSpeed === "number" && Number.isFinite(raw.playbackSpeed)
      ? Math.min(2.0, Math.max(0.25, raw.playbackSpeed))
      : DEFAULT_SETTINGS.playbackSpeed;

  const masterVolume =
    typeof raw.masterVolume === "number" && Number.isFinite(raw.masterVolume)
      ? Math.min(1.0, Math.max(0.0, raw.masterVolume))
      : DEFAULT_SETTINGS.masterVolume;

  const leadInSeconds =
    typeof raw.leadInSeconds === "number" && Number.isFinite(raw.leadInSeconds)
      ? Math.min(0.0, Math.max(-2.0, raw.leadInSeconds))
      : DEFAULT_SETTINGS.leadInSeconds;

  const showFpsOverlay =
    typeof raw.showFpsOverlay === "boolean"
      ? raw.showFpsOverlay
      : DEFAULT_SETTINGS.showFpsOverlay;

  const showFingerLabels =
    typeof raw.showFingerLabels === "boolean"
      ? raw.showFingerLabels
      : DEFAULT_SETTINGS.showFingerLabels;

  const showNoteNames =
    typeof raw.showNoteNames === "boolean"
      ? raw.showNoteNames
      : DEFAULT_SETTINGS.showNoteNames;

  const soundTimbre: "acoustic" | "bright" | "warm" =
    raw.soundTimbre === "acoustic" || raw.soundTimbre === "bright" || raw.soundTimbre === "warm"
      ? raw.soundTimbre
      : DEFAULT_SETTINGS.soundTimbre;

  const validFps = [0, 30, 60, 120];
  const renderCapFps =
    typeof raw.renderCapFps === "number" && validFps.includes(raw.renderCapFps)
      ? raw.renderCapFps
      : DEFAULT_SETTINGS.renderCapFps;

  const VALID_SKIN_STYLES = [
    "cartoon",
    "gloves",
    "robot",
    "skeleton",
    "realistic",
    "photo-segmented",
    "photo-mesh",
    "photo-3d",
  ] as const;

  const skinStyle: (typeof VALID_SKIN_STYLES)[number] =
    typeof raw.skinStyle === "string" && (VALID_SKIN_STYLES as readonly string[]).includes(raw.skinStyle)
      ? (raw.skinStyle as (typeof VALID_SKIN_STYLES)[number])
      : DEFAULT_SETTINGS.skinStyle;

  const showHandShadow =
    typeof raw.showHandShadow === "boolean"
      ? raw.showHandShadow
      : DEFAULT_SETTINGS.showHandShadow;

  const soundOutput: "synth" | "soundfont" | "webmidi" =
    raw.soundOutput === "synth" || raw.soundOutput === "soundfont" || raw.soundOutput === "webmidi"
      ? raw.soundOutput
      : DEFAULT_SETTINGS.soundOutput;

  return {
    keyStyle,
    playbackSpeed,
    masterVolume,
    leadInSeconds,
    showFpsOverlay,
    showFingerLabels,
    showNoteNames,
    soundTimbre,
    renderCapFps,
    skinStyle,
    showHandShadow,
    soundOutput,
  };
}
