export type SkinStyle = "skeleton" | "cartoon" | "gloves" | "robot";

export interface CartoonColorSlots {
  skin: [number, number, number];
  line: [number, number, number];
  sleeve: [number, number, number];
  nail: [number, number, number];
}

export interface GlovesColorSlots {
  glove: [number, number, number];
  line: [number, number, number];
  arm: [number, number, number];
}

export interface RobotColorSlots {
  shell: [number, number, number];
  joint: [number, number, number];
  tip: [number, number, number];
}

export interface SkeletonColorSlots {
  bone: [number, number, number];
}

export interface SkinColorSlots {
  cartoon: CartoonColorSlots;
  gloves: GlovesColorSlots;
  robot: RobotColorSlots;
  skeleton: SkeletonColorSlots;
}

export interface SkinSettings {
  style: SkinStyle;
  colors: Record<SkinStyle, Record<string, [number, number, number]>>;
  finger_width: number;
  outline: number;
  details: boolean;
  sleeve: boolean;
  shadow: boolean;
}

export const FINGER_WIDTH_RANGE: [number, number] = [0.5, 1.2];
export const OUTLINE_RANGE: [number, number] = [0.0, 2.5];

export const DEFAULT_SKIN_COLORS: Record<SkinStyle, Record<string, [number, number, number]>> = {
  skeleton: {
    bone: [12, 12, 14],
  },
  cartoon: {
    skin: [247, 197, 152],
    line: [205, 128, 78],
    sleeve: [37, 178, 122],
    nail: [252, 223, 199],
  },
  gloves: {
    glove: [250, 250, 250],
    line: [20, 20, 22],
    arm: [20, 20, 22],
  },
  robot: {
    shell: [232, 231, 228],
    joint: [62, 64, 70],
    tip: [58, 58, 62],
  },
};

export const DEFAULT_SKIN_SETTINGS: SkinSettings = {
  style: "cartoon",
  colors: {
    skeleton: { bone: [12, 12, 14] },
    cartoon: {
      skin: [247, 197, 152],
      line: [205, 128, 78],
      sleeve: [37, 178, 122],
      nail: [252, 223, 199],
    },
    gloves: {
      glove: [250, 250, 250],
      line: [20, 20, 22],
      arm: [20, 20, 22],
    },
    robot: {
      shell: [232, 231, 228],
      joint: [62, 64, 70],
      tip: [58, 58, 62],
    },
  },
  finger_width: 0.75,
  outline: 1.0,
  details: true,
  sleeve: true,
  shadow: true,
};

const VALID_STYLES: readonly SkinStyle[] = ["skeleton", "cartoon", "gloves", "robot"] as const;

function isSkinStyle(val: unknown): val is SkinStyle {
  return typeof val === "string" && (VALID_STYLES as readonly string[]).includes(val);
}

function clampColorChannel(val: unknown): number {
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function clampRgb(val: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(val) || val.length < 3) return [...fallback];
  return [
    clampColorChannel(val[0]),
    clampColorChannel(val[1]),
    clampColorChannel(val[2]),
  ];
}

export type PartialSkinSettings = Partial<Omit<SkinSettings, "colors">> & {
  colors?: Partial<{
    [K in SkinStyle]: Partial<Record<string, [number, number, number]>>;
  }>;
};

/**
 * Normalizes skin settings:
 * - Sets default values for missing fields
 * - Validates and clamps style to allowed styles
 * - Clamps color slots to [0, 255] RGB values
 * - Clamps finger_width to [0.5, 1.2]
 * - Clamps outline to [0.0, 2.5]
 * - Converts boolean flags
 */
export function normalizeSkinSettings(
  skin?: PartialSkinSettings | Partial<SkinSettings> | null,
): SkinSettings {
  const out: SkinSettings = {
    style: DEFAULT_SKIN_SETTINGS.style,
    colors: {
      skeleton: { ...DEFAULT_SKIN_COLORS.skeleton },
      cartoon: { ...DEFAULT_SKIN_COLORS.cartoon },
      gloves: { ...DEFAULT_SKIN_COLORS.gloves },
      robot: { ...DEFAULT_SKIN_COLORS.robot },
    },
    finger_width: DEFAULT_SKIN_SETTINGS.finger_width,
    outline: DEFAULT_SKIN_SETTINGS.outline,
    details: DEFAULT_SKIN_SETTINGS.details,
    sleeve: DEFAULT_SKIN_SETTINGS.sleeve,
    shadow: DEFAULT_SKIN_SETTINGS.shadow,
  };

  if (!skin || typeof skin !== "object") {
    return out;
  }

  if (isSkinStyle(skin.style)) {
    out.style = skin.style;
  }

  if (skin.colors && typeof skin.colors === "object") {
    for (const style of VALID_STYLES) {
      const styleCols = skin.colors[style];
      if (styleCols && typeof styleCols === "object") {
        for (const [slot, defaultCol] of Object.entries(DEFAULT_SKIN_COLORS[style])) {
          if (slot in styleCols) {
            out.colors[style][slot] = clampRgb(styleCols[slot], defaultCol);
          }
        }
      }
    }
  }

  if (typeof skin.finger_width === "number" && Number.isFinite(skin.finger_width)) {
    out.finger_width = Math.max(FINGER_WIDTH_RANGE[0], Math.min(FINGER_WIDTH_RANGE[1], skin.finger_width));
  }

  if (typeof skin.outline === "number" && Number.isFinite(skin.outline)) {
    out.outline = Math.max(OUTLINE_RANGE[0], Math.min(OUTLINE_RANGE[1], skin.outline));
  }

  if (typeof skin.details === "boolean") {
    out.details = skin.details;
  }

  if (typeof skin.sleeve === "boolean") {
    out.sleeve = skin.sleeve;
  }

  if (typeof skin.shadow === "boolean") {
    out.shadow = skin.shadow;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Procedural skin formulas
// ---------------------------------------------------------------------------

/** Proximal phalanx widths in inches per finger (1: thumb, 2..5: index..little) */
export const FINGER_W_IN: Record<number, number> = {
  1: 0.82,
  2: 0.70,
  3: 0.72,
  4: 0.68,
  5: 0.60,
};

/** Phalanx tapering factors: proximal, middle, distal */
export const SEG_TAPER: [number, number, number] = [1.0, 0.9, 0.84];

/** Depth scaling from hand height in inches (max(0.85, min(1.45, 1.0 + 0.25 * zIn))) */
export function depthScale(zIn: number): number {
  return Math.max(0.85, Math.min(1.45, 1.0 + 0.25 * zIn));
}

/** Compute segment radius in pixels */
export function computeFingerRadius(
  finger: number,
  segmentIndex: number,
  fingerWidth: number,
  zIn: number,
  ppi: number,
): number {
  const baseW = FINGER_W_IN[finger] ?? 0.70;
  const base = (baseW * fingerWidth * ppi) / 2;
  const taper =
    finger === 1
      ? segmentIndex === 0
        ? 1.22
        : segmentIndex === 1
          ? 1.0
          : 0.9
      : (SEG_TAPER[segmentIndex] ?? 0.84);
  return base * taper * depthScale(zIn);
}

/** Shadow projection offset in screen pixels: dx = 0.15 * zIn * ppi, dy = 0.25 * zIn * ppi */
export function computeShadowOffset(zIn: number, ppi: number): { dx: number; dy: number } {
  return {
    dx: 0.15 * zIn * ppi,
    dy: 0.25 * zIn * ppi,
  };
}

/** Soft shadow alpha attenuation: scales inversely with hand height from 0.35 down to 0.10 */
export function computeShadowAlpha(zIn: number): number {
  const baseAlpha = 0.35;
  const minAlpha = 0.10;
  const attenuation = Math.max(0, Math.min(1, Math.max(0, zIn) / 1.5));
  return baseAlpha - attenuation * (baseAlpha - minAlpha);
}

/** Convert [r, g, b] integer array to 24-bit hex color number */
export function rgbToHex(rgb: [number, number, number]): number {
  return ((rgb[0] & 0xff) << 16) | ((rgb[1] & 0xff) << 8) | (rgb[2] & 0xff);
}

/** Linearly mix two RGB colors */
export function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  const clampedT = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * clampedT),
    Math.round(a[1] + (b[1] - a[1]) * clampedT),
    Math.round(a[2] + (b[2] - a[2]) * clampedT),
  ];
}
