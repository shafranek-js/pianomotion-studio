import { z } from "zod";
import { BUILTIN_SOUNDFONT_ID } from "../audio/soundfont/builtinSoundfont.ts";
import { M1KeyStyleSchema, type M1KeyStyle } from "@handthesia/contracts";
import { normalizeStageAppearance, type StageAppearance } from "./stageAppearance";

export const SETTINGS_STORAGE_KEY = "handthesia:settings";

export type AppLanguage = "en" | "cs" | "uk" | "de" | "es" | "it";
export const AppLanguageSchema = z.enum(["en", "cs", "uk", "de", "es", "it"]);

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

export const CalculationEngineSchema = z.enum(["python", "typescript"]);
export type CalculationEngine = z.infer<typeof CalculationEngineSchema>;

export const HandModelSchema = z.enum(["anatomical", "anatomical-improved", "webxr", "testing"]);
export type HandModel = z.infer<typeof HandModelSchema>;

export const TestingHandMaterialSchema = z.enum(["original", "no-normal", "no-albedo", "clay"]);
export type TestingHandMaterial = z.infer<typeof TestingHandMaterialSchema>;
/** Research-only, never applied to WebXR or Anatomical Improved. */
export const TestingThumbStrengthSchema = z.union([
  z.literal(0), z.literal(0.25), z.literal(0.5), z.literal(0.75), z.literal(1),
]);
export type TestingThumbStrength = z.infer<typeof TestingThumbStrengthSchema>;

export interface Settings {
  /** Visual environment preference; absent in settings saved by older versions. */
  stageAppearance?: StageAppearance;
  language: AppLanguage;
  keyStyle: "realistic" | "equal";
  calculationEngine: "python" | "typescript";
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
  handModel: HandModel;
  testingHandMaterial: TestingHandMaterial;
  testingThumbStrength: TestingThumbStrength;
  testingKeyContact: boolean;
  testingShowBindAlignment: boolean;
  showHandShadow: boolean;
  soundOutput: "synth" | "soundfont" | "webmidi";
  soundfontAssetId?: string | null;
  webMidiDeviceId?: string | null;
  /** MIDI wire channel 0..15; the UI displays 1..16. */
  webMidiChannel?: number;
}
export type AppSettings = Settings;

export const SettingsSchema = z.object({
  stageAppearance: z.unknown().transform(normalizeStageAppearance).default(() => normalizeStageAppearance(undefined)),
  language: AppLanguageSchema.default("en"),
  keyStyle: KeyStyleSchema.default("realistic"),
  calculationEngine: CalculationEngineSchema.default("typescript"),
  playbackSpeed: z.number().min(0.25).max(2.0).default(1.0),
  masterVolume: z.number().min(0.0).max(1.0).default(0.8),
  leadInSeconds: z.number().min(-2.0).max(0.0).default(-2.0),
  showFpsOverlay: z.boolean().default(false),
  showFingerLabels: z.boolean().default(false),
  showNoteNames: z.boolean().default(false),
  soundTimbre: SoundTimbreSchema.default("acoustic"),
  renderCapFps: z
    .number()
    .refine((fps) => [0, 30, 60, 120].includes(fps), {
      message: "renderCapFps must be 0, 30, 60, or 120",
    })
    .default(60),
  skinStyle: SkinStyleSchema.default("realistic"),
  handModel: HandModelSchema.default("anatomical"),
  testingHandMaterial: TestingHandMaterialSchema.default("original"),
  testingThumbStrength: TestingThumbStrengthSchema.default(0),
  testingKeyContact: z.boolean().default(true),
  testingShowBindAlignment: z.boolean().default(false),
  showHandShadow: z.boolean().default(true),
  soundOutput: SoundOutputSchema.default("soundfont"),
  soundfontAssetId: z.string().nullable().default(BUILTIN_SOUNDFONT_ID),
  webMidiDeviceId: z.string().nullable().optional(),
  webMidiChannel: z.number().int().min(0).max(15).default(0),
});

export const DEFAULT_SETTINGS: Settings = {
  stageAppearance: normalizeStageAppearance(undefined),
  language: "en",
  keyStyle: "realistic",
  calculationEngine: "typescript",
  playbackSpeed: 1.0,
  masterVolume: 0.8,
  leadInSeconds: -2.0,
  showFpsOverlay: false,
  showFingerLabels: false,
  showNoteNames: false,
  soundTimbre: "acoustic",
  renderCapFps: 60,
  skinStyle: "realistic",
  handModel: "anatomical",
  testingHandMaterial: "original",
  testingThumbStrength: 0,
  testingKeyContact: true,
  testingShowBindAlignment: false,
  showHandShadow: true,
  soundOutput: "soundfont",
  soundfontAssetId: BUILTIN_SOUNDFONT_ID,
  webMidiDeviceId: null,
  webMidiChannel: 0,
};

export type SettingsListener = (settings: Settings) => void;

/**
 * Sanitizes and clamps partial settings input against valid domain bounds.
 */
export function sanitizeSettings(input: Partial<Settings> | unknown): Settings {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_SETTINGS, stageAppearance: normalizeStageAppearance(undefined) };
  }
  const raw = input as Partial<Settings>;

  const language: AppLanguage =
    raw.language && AppLanguageSchema.safeParse(raw.language).success
      ? (raw.language as AppLanguage)
      : DEFAULT_SETTINGS.language;

  const keyStyle: "realistic" | "equal" =
    raw.keyStyle === "equal" || raw.keyStyle === "realistic"
      ? raw.keyStyle
      : DEFAULT_SETTINGS.keyStyle;

  const calculationEngine: "python" | "typescript" =
    raw.calculationEngine === "typescript" || raw.calculationEngine === "python"
      ? raw.calculationEngine
      : DEFAULT_SETTINGS.calculationEngine;

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

  const storedSkinStyle: (typeof VALID_SKIN_STYLES)[number] =
    typeof raw.skinStyle === "string" && (VALID_SKIN_STYLES as readonly string[]).includes(raw.skinStyle)
      ? (raw.skinStyle as (typeof VALID_SKIN_STYLES)[number])
      : DEFAULT_SETTINGS.skinStyle;
  const skinStyle = storedSkinStyle === "photo-segmented" || storedSkinStyle === "photo-mesh"
    ? "realistic" : storedSkinStyle;

  const handModel: HandModel =
    raw.handModel === "webxr" || raw.handModel === "anatomical" || raw.handModel === "anatomical-improved" || raw.handModel === "testing"
      ? raw.handModel
      : DEFAULT_SETTINGS.handModel;

  const testingHandMaterial = TestingHandMaterialSchema.safeParse(raw.testingHandMaterial).success
    ? raw.testingHandMaterial as TestingHandMaterial
    : DEFAULT_SETTINGS.testingHandMaterial;

  const testingThumbStrength = TestingThumbStrengthSchema.safeParse(raw.testingThumbStrength).success
    ? raw.testingThumbStrength as TestingThumbStrength : DEFAULT_SETTINGS.testingThumbStrength;

  const testingKeyContact = typeof raw.testingKeyContact === "boolean"
    ? raw.testingKeyContact : DEFAULT_SETTINGS.testingKeyContact;

  const testingShowBindAlignment = typeof raw.testingShowBindAlignment === "boolean"
    ? raw.testingShowBindAlignment : DEFAULT_SETTINGS.testingShowBindAlignment;

  const showHandShadow =
    typeof raw.showHandShadow === "boolean"
      ? raw.showHandShadow
      : DEFAULT_SETTINGS.showHandShadow;

  const soundOutput: "synth" | "soundfont" | "webmidi" =
    raw.soundOutput === "synth" || raw.soundOutput === "soundfont" || raw.soundOutput === "webmidi"
      ? raw.soundOutput
      : DEFAULT_SETTINGS.soundOutput;

  const soundfontAssetId =
    typeof raw.soundfontAssetId === "string" && raw.soundfontAssetId.trim().length > 0
      ? raw.soundfontAssetId.trim()
      : BUILTIN_SOUNDFONT_ID;

  const webMidiDeviceId =
    typeof raw.webMidiDeviceId === "string" && raw.webMidiDeviceId.trim().length > 0
      ? raw.webMidiDeviceId.trim()
      : null;

  return {
    stageAppearance: normalizeStageAppearance(raw.stageAppearance),
    language,
    keyStyle,
    calculationEngine,
    playbackSpeed,
    masterVolume,
    leadInSeconds,
    showFpsOverlay,
    showFingerLabels,
    showNoteNames,
    soundTimbre,
    renderCapFps,
    skinStyle,
    handModel,
    testingHandMaterial,
    testingThumbStrength,
    testingKeyContact,
    testingShowBindAlignment,
    showHandShadow,
    soundOutput,
    soundfontAssetId,
    webMidiDeviceId,
    webMidiChannel: typeof raw.webMidiChannel === "number" && Number.isInteger(raw.webMidiChannel)
      ? Math.max(0, Math.min(15, raw.webMidiChannel)) : 0,
  };
}
