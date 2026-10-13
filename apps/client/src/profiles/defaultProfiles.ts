import {
  type PianistProfile,
  PianistProfileSchema,
  SCHEMA_VERSION,
} from "@handthesia/contracts";
import { DEFAULT_ANATOMY, DEFAULT_BEHAVIOR } from "./types.ts";

const DEFAULT_SKIN: Readonly<Record<string, unknown>> = Object.freeze({
  style: "gloves",
  colors: {
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
  },
  finger_width: 0.75,
  outline: 1.0,
  details: true,
  sleeve: true,
  shadow: true,
});

/**
 * Canonical default profile matching desktop pianists/default-copy.json.
 */
export const DEFAULT_PROFILE: PianistProfile = PianistProfileSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  profileId: "default",
  revision: 0,
  name: "Default copy",
  colorRgb: [12, 12, 14],
  anatomy: {
    ...DEFAULT_ANATOMY,
    wrist: 1.0,
  },
  behavior: {
    ...DEFAULT_BEHAVIOR,
  },
  skin: structuredClone(DEFAULT_SKIN),
  weights: {},
  createdAtUnixSeconds: 0,
  modifiedAtUnixSeconds: 0,
});

/**
 * Built-in profile for small hands / youth pianists:
 * - Bone lengths scaled between 0.75x and 0.85x
 * - stretch_bias: -0.4 (prefers shifting/crossing over wide stretches)
 * - weak_bias: 0.4 (protects 4th and 5th fingers)
 * - max_speed: 2.2 m/s
 */
export const SMALL_HANDS_PROFILE: PianistProfile = PianistProfileSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  profileId: "small-hands",
  revision: 0,
  name: "Small Hands / Youth",
  colorRgb: [76, 175, 80],
  anatomy: {
    mc1: 3.76,
    pp1: 2.64,
    dp1: 2.24,
    mc2: 5.3472,
    pp2: 3.2,
    mp2: 1.84,
    dp2: 1.44,
    mc3: 5.3008,
    pp3: 3.6,
    mp3: 2.16,
    dp3: 1.52,
    mc4: 5.0656,
    pp4: 3.36,
    mp4: 2.08,
    dp4: 1.52,
    mc5: 4.7792,
    pp5: 2.64,
    mp5: 1.44,
    dp5: 1.36,
    wrist: 0.85,
  },
  behavior: {
    ...DEFAULT_BEHAVIOR,
    stretch_bias: -0.4,
    weak_bias: 0.4,
    max_speed: 2.2,
    roll_speed: 0.042,
    cross_height: 0.38,
  },
  skin: {
    ...structuredClone(DEFAULT_SKIN),
    finger_width: 0.65,
  },
  weights: {},
  createdAtUnixSeconds: 0,
  modifiedAtUnixSeconds: 0,
});

/**
 * Built-in profile for virtuoso / large reach pianists:
 * - Bone lengths scaled 1.25x
 * - stretch_bias: 0.7 (comfortably stretches wide intervals)
 * - weak_bias: 0.15 (freely utilizes 4th and 5th fingers)
 * - max_speed: 4.5 m/s
 * - early_release: 0.15 ms
 */
export const VIRTUOSO_PROFILE: PianistProfile = PianistProfileSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  profileId: "virtuoso",
  revision: 0,
  name: "Virtuoso / Large Reach",
  colorRgb: [156, 39, 176],
  anatomy: {
    mc1: 5.875,
    pp1: 4.125,
    dp1: 3.5,
    mc2: 8.355,
    pp2: 5.0,
    mp2: 2.875,
    dp2: 2.25,
    mc3: 8.2825,
    pp3: 5.625,
    mp3: 3.375,
    dp3: 2.375,
    mc4: 7.915,
    pp4: 5.25,
    mp4: 3.25,
    dp4: 2.375,
    mc5: 7.4675,
    pp5: 4.125,
    mp5: 2.25,
    dp5: 2.125,
    wrist: 1.15,
  },
  behavior: {
    ...DEFAULT_BEHAVIOR,
    stretch_bias: 0.7,
    weak_bias: 0.15,
    max_speed: 4.5,
    early_release: 0.15,
    economy: 0.6,
  },
  skin: {
    ...structuredClone(DEFAULT_SKIN),
    finger_width: 0.85,
  },
  weights: {},
  createdAtUnixSeconds: 0,
  modifiedAtUnixSeconds: 0,
});

/**
 * Built-in profile configured for left-hand lead / dominance:
 * - Left hand bias in split decisions and fingering
 */
export const LEFT_DOMINANT_PROFILE: PianistProfile = PianistProfileSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  profileId: "left-dominant",
  revision: 0,
  name: "Left-Hand Lead",
  colorRgb: [33, 150, 243],
  anatomy: {
    ...DEFAULT_ANATOMY,
    wrist: 1.0,
  },
  behavior: {
    ...DEFAULT_BEHAVIOR,
    left_dominant: true,
    hand_dominance: "left",
    weak_bias: 0.2,
    stretch_bias: 0.1,
    economy: 0.55,
  },
  skin: structuredClone(DEFAULT_SKIN),
  weights: {},
  createdAtUnixSeconds: 0,
  modifiedAtUnixSeconds: 0,
});

/**
 * Returns a cloned array of canonical default profiles.
 */
export function getDefaultProfiles(): PianistProfile[] {
  return [
    structuredClone(DEFAULT_PROFILE),
    structuredClone(SMALL_HANDS_PROFILE),
    structuredClone(VIRTUOSO_PROFILE),
    structuredClone(LEFT_DOMINANT_PROFILE),
  ];
}

/**
 * Returns a clone of the default profile ("default").
 */
export function getDefaultProfile(): PianistProfile {
  return structuredClone(DEFAULT_PROFILE);
}
