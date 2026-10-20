/**
 * pianist.ts - Pianists: a name, hand colour, hand anatomy (the lengths of the
 * 19 bones of the hand) and technique preferences.
 *
 * Anatomy is stored in the hand model's own units (see hands.ts; one unit is
 * about 1.09 cm on the drawn keyboard's real scale).
 */

import { pyMod, pyRound } from "./pythonCompat.ts";

export const DEFAULT_ID = "default";

export const FINGER_WORD: Readonly<Record<number, string>> = {
  1: "Thumb",
  2: "Index",
  3: "Middle",
  4: "Ring",
  5: "Little",
};

export const BONE_WORD: Readonly<Record<string, string>> = {
  mc: "metacarpal",
  pp: "proximal phalanx",
  mp: "middle phalanx",
  dp: "distal phalanx",
};

export type BoneKind = "mc" | "pp" | "mp" | "dp";

export const BONES: ReadonlyArray<readonly [string, number, BoneKind]> = (() => {
  const list: Array<readonly [string, number, BoneKind]> = [
    ["mc1", 1, "mc"],
    ["pp1", 1, "pp"],
    ["dp1", 1, "dp"],
  ];
  for (let f = 2; f <= 5; f += 1) {
    list.push(
      [`mc${f}`, f, "mc"],
      [`pp${f}`, f, "pp"],
      [`mp${f}`, f, "mp"],
      [`dp${f}`, f, "dp"],
    );
  }
  return list;
})();

export const BONE_IDS: readonly string[] = BONES.map((b) => b[0]);

export const BONE_INFO: Readonly<Record<string, readonly [number, BoneKind]>> =
  Object.fromEntries(BONES.map((b) => [b[0], [b[1], b[2]] as const]));

export const METACARPALS: readonly string[] = BONE_IDS.filter((b) =>
  b.startsWith("mc"),
);
export const PHALANGES: readonly string[] = BONE_IDS.filter(
  (b) => !b.startsWith("mc"),
);

export const DEFAULT_ANATOMY: Readonly<Record<string, number>> = {
  mc1: 4.7,
  pp1: 3.3,
  dp1: 2.8,
  mc2: 6.684,
  pp2: 4.0,
  mp2: 2.3,
  dp2: 1.8,
  mc3: 6.626,
  pp3: 4.5,
  mp3: 2.7,
  dp3: 1.9,
  mc4: 6.332,
  pp4: 4.2,
  mp4: 2.6,
  dp4: 1.9,
  mc5: 5.974,
  pp5: 3.3,
  mp5: 1.8,
  dp5: 1.7,
};

export const BONE_MIN = 0.7;
export const BONE_MAX = 2.5;
export const METACARPAL_MAX = 2.5;

export const WRIST = "wrist";
export const WRIST_MIN = 0.75;
export const WRIST_MAX = 2.0;

export function clampWrist(v: number): number {
  return Math.max(WRIST_MIN, Math.min(WRIST_MAX, Number(v)));
}

export const clamp_wrist = clampWrist;

export function boneMax(bid: string): number {
  const info = BONE_INFO[bid];
  return info && info[1] === "mc" ? METACARPAL_MAX : BONE_MAX;
}

export const bone_max = boneMax;

export function boneName(bid: string): string {
  const info = BONE_INFO[bid];
  if (!info) {
    return bid;
  }
  const [f, kind] = info;
  return `${FINGER_WORD[f] ?? f} ${BONE_WORD[kind] ?? kind}`;
}

export const bone_name = boneName;

export function clampBone(bid: string, v: number): number {
  const d = DEFAULT_ANATOMY[bid] ?? 1.0;
  return Math.max(d * BONE_MIN, Math.min(d * boneMax(bid), Number(v)));
}

export const clamp_bone = clampBone;

function _pct(v: number): string {
  return `${Math.trunc(pyRound(v * 100))}%`;
}
function _ms(v: number): string {
  return `${Math.trunc(pyRound(v * 1000))} ms`;
}
function _deg(v: number): string {
  return `${Math.trunc(pyRound(v))}°`;
}
function _mps(v: number): string {
  return `${v.toFixed(1)} m/s`;
}
function _sec(v: number): string {
  return `${v.toFixed(2)} s`;
}
function _notes(v: number): string {
  return `${Math.trunc(pyRound(v))} notes`;
}

export function fingerLead(a: number): [number, number] {
  if (a >= 0) {
    return [0.4 + a, 0.9 - 0.6 * a];
  }
  return [0.4 + 0.35 * a, 0.9 - 0.1 * a];
}

export const finger_lead = fingerLead;

function _lead(v: number): string {
  return `${Math.trunc(pyRound(fingerLead(v)[0] * 1000))} ms ahead`;
}

function _bias(v: number): string {
  if (Math.abs(v) < 0.05) {
    return "neutral";
  }
  return `${Math.trunc(pyRound(Math.abs(v) * 100))}% toward ${
    v > 0 ? "stretching" : "shifting / crossing"
  }`;
}

export interface SliderBehaviorSpec {
  id: string;
  group: string;
  label: string;
  kind: "slider";
  min: number;
  max: number;
  default: number;
  step?: number;
  fmt: (v: number) => string;
  lo: string;
  hi: string;
  desc: string;
}

export interface OptionsBehaviorSpec {
  id: string;
  group: string;
  label: string;
  kind: "options";
  default: string;
  options: ReadonlyArray<readonly [string, string, string]>;
  desc: string;
}

export type BehaviorSpec = SliderBehaviorSpec | OptionsBehaviorSpec;

export const BEHAVIORS: readonly BehaviorSpec[] = [
  {
    id: "retraction",
    group: "Motion",
    label: "Retraction of unused fingers",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.1,
    fmt: _pct,
    lo: "Stay over the keys",
    hi: "Curl well back",
    desc: "How far fingers that aren't playing, and aren't about to, pull back and up toward the palm.",
  },
  {
    id: "finger_curve",
    group: "Motion",
    label: "Finger curvature",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.4,
    fmt: _pct,
    lo: "Flatter fingers",
    hi: "Strongly curved",
    desc: "How curved the fingers are while they press the keys: flatter fingers let the hand sit further back from the keys, curved fingers bring it forward over them.",
  },
  {
    id: "antic_hand",
    group: "Motion",
    label: "Anticipation speed (hand)",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    fmt: _pct,
    lo: "Last moment",
    hi: "Very early",
    desc: "How early the whole hand moves into position for the notes coming up.",
  },
  {
    id: "antic_fingers",
    group: "Motion",
    label: "Anticipation speed (fingers)",
    kind: "slider",
    min: -1.0,
    max: 1.0,
    default: 0.5,
    fmt: _lead,
    lo: "Just in time",
    hi: "Very early",
    desc: "How early each finger travels to its next key and waits there, ready to strike - a thumb passing under, say. The value is the longest head start; a finger never leaves before it has let go of its last key, and never so late that it would have to move faster than the top travel speed.",
  },
  {
    id: "tendon_link",
    group: "Motion",
    label: "Linked fingers (3, 4, 5)",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.6,
    fmt: _pct,
    lo: "Independent",
    hi: "Tightly linked",
    desc: "The tendons of the middle, ring and little fingers are joined: when the middle finger curves down the ring finger goes some way with it, and the other way round, and the little finger takes both with it - unless they're reaching for keys of their own.",
  },
  {
    id: "cross_height",
    group: "Motion",
    label: "Crossing height",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.33,
    fmt: _pct,
    lo: "Skim over",
    hi: "Arch high",
    desc: "How high a finger arches when it crosses over the thumb.",
  },
  {
    id: "lift_height",
    group: "Motion",
    label: "Finger lift height",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    fmt: _pct,
    lo: "Close to the keys",
    hi: "High lift",
    desc: "How high a finger rises above its key before striking it.",
  },
  {
    id: "wrist_bounce",
    group: "Motion",
    label: "Wrist bounce (repeated chords)",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    fmt: _pct,
    lo: "Still wrist",
    hi: "Big bounce",
    desc: "In repeated chords and octaves the hand plays from the wrist: it drops onto each chord and springs back up between them. This sets how high it springs.",
  },
  {
    id: "tremolo_rotation",
    group: "Motion",
    label: "Wrist rotation (tremolos)",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    fmt: _pct,
    lo: "Fingers only",
    hi: "Strong rotation",
    desc: "In tremolos and other quick alternations between the two sides of the hand, the forearm rotates, rocking the thumb side and the little-finger side down in turn.",
  },
  {
    id: "gesture_finger_action",
    group: "Motion",
    label: "Finger action in bounces & tremolos",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.25,
    fmt: _pct,
    lo: "Hand does it all",
    hi: "Fingers lift fully",
    desc: "How much the fingers still lift on their own when the wrist bounce or rotation is doing the playing (repeated chords, tremolos).",
  },
  {
    id: "cross_turn",
    group: "Motion",
    label: "Wrist turn for thumb crossings",
    kind: "slider",
    min: 0.0,
    max: 30.0,
    default: 14.0,
    fmt: _deg,
    lo: "Quiet wrist",
    hi: "Turns a lot",
    desc: "How far the hand turns toward the little finger while the thumb passes under (and back the other way when a finger crosses over).",
  },
  {
    id: "smoothness",
    group: "Motion",
    label: "Hand motion smoothness",
    kind: "slider",
    min: 0.02,
    max: 0.15,
    default: 0.07,
    fmt: _ms,
    lo: "Quick, direct",
    hi: "Smooth, flowing",
    desc: "How much the hand's movements are smoothed: shifts accelerate and settle over this long.",
  },
  {
    id: "early_release",
    group: "Motion",
    label: "Early release before a jump",
    kind: "slider",
    min: 0.05,
    max: 0.4,
    default: 0.22,
    fmt: _ms,
    lo: "Legato, late",
    hi: "Detached, early",
    desc: "How early a finger lets go of its key when it has to jump straight to another one. This changes what you hear (without the pedal).",
  },
  {
    id: "max_speed",
    group: "Motion",
    label: "Top travel speed",
    kind: "slider",
    min: 0.5,
    max: 5.0,
    default: 3.0,
    fmt: _mps,
    lo: "Unhurried",
    hi: "Virtuoso leaps",
    desc: "The fastest any part of the hand - wrist or fingertip - can travel across the keys. Fingerings and the split between the hands are chosen so the hands never need to move faster; when the music still asks for more, the key is let go earlier or struck late, and that is what you hear.",
  },
  {
    id: "key_area_near",
    group: "Motion",
    label: "Playing area on the keys: nearest the edge",
    kind: "slider",
    min: 0.0,
    max: 0.5,
    default: 0.0,
    fmt: _pct,
    lo: "Right at the edge",
    hi: "Well in",
    desc: "How close to a key's front edge a fingertip may play, as a share of the key's playable length (on white keys, up to just past the black keys). Loud notes are played near this end.",
  },
  {
    id: "key_area_far",
    group: "Motion",
    label: "Playing area on the keys: furthest up",
    kind: "slider",
    min: 0.3,
    max: 1.0,
    default: 1.0,
    fmt: _pct,
    lo: "Near the edge only",
    hi: "Up among the black keys",
    desc: "How far up a key a fingertip may play. Within this area the loudness decides: soft notes may use all of it, loud ones only the front part, where the key has more leverage.",
  },
  {
    id: "roll_speed",
    group: "Motion",
    label: "Rolled chord speed",
    kind: "slider",
    min: 0.015,
    max: 0.08,
    default: 0.035,
    fmt: _ms,
    lo: "Quick roll",
    hi: "Slow roll",
    desc: "Chords too wide for this hand are rolled from the bottom up; this is the time between the notes of the roll.",
  },
  {
    id: "glissando",
    group: "Glissandos",
    label: "Glissandos",
    kind: "options",
    default: "on",
    options: [
      [
        "on",
        "Detect and slide them",
        "A quick string of all-white or all-black keys going one way is played as a glissando: the backs of the fingers slide along the keys",
      ],
      [
        "off",
        "Finger every note",
        "Only glissandos marked in the file (fingering editor) are slid; everything else is fingered",
      ],
    ],
    desc: 'Whether this pianist spots glissandos and slides them. Glissandos marked in the file ("g" in the fingering editor) are always slid.',
  },
  {
    id: "gliss_gap",
    group: "Glissandos",
    label: "Glissando: longest gap between notes",
    kind: "slider",
    min: 0.025,
    max: 0.1,
    default: 0.05,
    step: 0.005,
    fmt: _ms,
    lo: "Only the fastest",
    hi: "Slower ones too",
    desc: "A string of keys counts as a glissando only if each note comes at most this long after the one before.",
  },
  {
    id: "gliss_min",
    group: "Glissandos",
    label: "Glissando: fewest notes",
    kind: "slider",
    min: 3,
    max: 16,
    default: 6,
    step: 1,
    fmt: _notes,
    lo: "Short flicks too",
    hi: "Only long sweeps",
    desc: "How many notes in a row a string needs to count as a glissando.",
  },
  {
    id: "gliss_merge",
    group: "Glissandos",
    label: "Glissando: stay in the pose between",
    kind: "slider",
    min: 0.25,
    max: 3.0,
    default: 1.0,
    step: 0.05,
    fmt: _sec,
    lo: "Only quick returns",
    hi: "Long breaks too",
    desc: "Glissandos closer together than this (with nothing else for the hand to play in between) are played without leaving the glissando pose - the hand just travels to the next one.",
  },
  {
    id: "fingering_model",
    group: "Fingering",
    label: "Fingering model",
    kind: "options",
    default: "learned",
    options: [
      [
        "learned",
        "Learned from pianists",
        "Weights fitted to how professional pianists finger real repertoire (the PIG dataset)",
      ],
      [
        "textbook",
        "Textbook (Hanon)",
        "The original weights, tuned to match Hanon's printed fingering, weak-finger training included",
      ],
    ],
    desc: "The overall cost model behind the fingering. Standard fingerings for scales, arpeggios, octaves and thirds apply either way; the other settings here adjust it.",
  },
  {
    id: "weak_bias",
    group: "Fingering",
    label: "Weak finger bias",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.25,
    fmt: _pct,
    lo: "Use 4 and 5 freely",
    hi: "Avoid 4 and 5",
    desc: "Bias against the weaker 4th and 5th fingers when stronger ones would do. Every note is still played.",
  },
  {
    id: "stretch_bias",
    group: "Fingering",
    label: "Stretch bias",
    kind: "slider",
    min: -1.0,
    max: 1.0,
    default: 0.0,
    fmt: _bias,
    lo: "Shift / cross",
    hi: "Stretch",
    desc: "Reach wide intervals by stretching the hand, or by shifting and crossing over/under. The reach itself comes from this pianist's anatomy.",
  },
  {
    id: "economy",
    group: "Fingering",
    label: "Economy of motion",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    fmt: _pct,
    lo: "Ignore finger travel",
    hi: "Minimise travel",
    desc: "How much to favour fingerings that keep the fingers close to where a relaxed hand already has them, weighing how far each finger must travel against the time it has.",
  },
  {
    id: "black_avoid",
    group: "Fingering",
    label: "Thumb and little finger on black keys",
    kind: "slider",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    fmt: _pct,
    lo: "Don't mind",
    hi: "Avoid strongly",
    desc: "How strongly to avoid putting the thumb (and, less so, the little finger) on black keys.",
  },
  {
    id: "chromatic",
    group: "Fingering",
    label: "Chromatic scale fingering",
    kind: "options",
    default: "13",
    options: [
      [
        "12",
        "1212123 12121 23…",
        "1-2: thumb on white keys, 2 on the black keys and on F / C",
      ],
      [
        "13",
        "1313123 13131 23…",
        "Traditional: thumb on white keys, 3 on the black keys, 2 on F / C",
      ],
      [
        "1234",
        "1234 123 1234 123…",
        "Groups of up to four fingers, thumbs on white keys",
      ],
      [
        "12345",
        "1234 12345 123…",
        "Thumb on C, E and A; groups of four, five and three",
      ],
      ["231", "231231 212341…", "Thumb on D, F, G and B"],
    ],
    desc: "Fingering for chromatic scales (shown for the right hand going up from C; the left hand mirrors it).",
  },
  {
    id: "repeated",
    group: "Fingering",
    label: "Repeated note fingering",
    kind: "options",
    default: "321",
    options: [
      [
        "321",
        "321321…",
        "Hanon's changing fingers 3-2-1 (4-3-2-1 in fours)",
      ],
      ["12", "121212…", ""],
      ["13", "131313…", ""],
      ["123", "123123…", ""],
      ["1234", "12341234…", ""],
    ],
    desc: "Fingers for quickly repeated notes on one key.",
  },
  {
    id: "trill",
    group: "Fingering",
    label: "Trill fingering",
    kind: "options",
    default: "auto",
    options: [
      [
        "auto",
        "Automatic",
        "Any strong pair (1-2, 1-3, 2-3, 2-4), never 4-5",
      ],
      ["12", "121212…", ""],
      ["23", "232323…", ""],
      ["13", "131313…", ""],
      ["14", "141414…", ""],
      ["1423", "14231423…", ""],
    ],
    desc: "Fingers for trills (the lower note takes the lower finger numbers).",
  },
  {
    id: "octaves",
    group: "Fingering",
    label: "Octave fingering",
    kind: "options",
    default: "4black",
    options: [
      [
        "4black",
        "1-5, 4 on black keys",
        "Hanon: 4 on the black keys in octave passages",
      ],
      ["5", "1-5 always", "Thumb and little finger for every octave"],
    ],
    desc: "Fingers for octaves (the right hand's; the left hand mirrors it).",
  },
];

export const BEHAVIOR: Readonly<Record<string, BehaviorSpec>> =
  Object.fromEntries(BEHAVIORS.map((b) => [b.id, b]));

export const DEFAULT_BEHAVIOR: Readonly<Record<string, number | string>> =
  Object.fromEntries(BEHAVIORS.map((b) => [b.id, b.default]));

export interface NormalizeBehaviorOptions {
  strict?: boolean;
}

/**
 * A behavior mapping checked against BEHAVIORS.
 *
 * Slider values are coerced to numbers and clamped to their spec range, so a
 * profile can never install an out-of-range speed, smoothing time or other
 * constant that the rest of the model divides by. Option values must be one of
 * the spec's options; anything else keeps the default. Unknown keys are
 * ignored. With strict, a malformed value throws instead of falling back.
 */
export function normalizeBehavior(
  values: unknown,
  options: NormalizeBehaviorOptions = {},
): Record<string, number | string> {
  const strict = options.strict === true;
  const behavior: Record<string, number | string> = { ...DEFAULT_BEHAVIOR };
  if (values === null || values === undefined) {
    return behavior;
  }
  if (typeof values !== "object" || Array.isArray(values)) {
    throw new Error("profile behavior must be an object");
  }
  for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
    const spec = BEHAVIOR[key];
    if (spec === undefined) {
      continue;
    }
    if (spec.kind === "slider") {
      const malformed =
        typeof raw === "boolean" ||
        raw === null ||
        raw === undefined ||
        (typeof raw === "string" && raw.trim() === "");
      const number = malformed ? Number.NaN : Number(raw);
      if (!Number.isFinite(number)) {
        if (strict) {
          throw new Error(`profile.behavior.${key} must be a finite number`);
        }
        continue;
      }
      behavior[key] = Math.min(spec.max, Math.max(spec.min, number));
    } else {
      const allowed = spec.options.map((option) => option[0]);
      if (typeof raw === "string" && allowed.includes(raw)) {
        behavior[key] = raw;
      } else if (strict) {
        throw new Error(`profile.behavior.${key} must be one of: ${allowed.join(", ")}`);
      }
    }
  }
  return behavior;
}

export const normalize_behavior = normalizeBehavior;


const FINE_TUNE_ID_SET = new Set<string>([
  "stretch",
  "cramp",
  "leap",
  "leap_dist",
  "cross",
  "cross_2",
  "cross_4",
  "cross_wide",
  "cross_max",
  "cross_thumb_black",
  "awkward",
  "same_finger",
  "same_finger_dist",
  "same_key_new_finger",
  "repeat_fast",
  "repeat_t",
  "repeat_very_fast",
  "thumb_black",
  "pinky_black",
  "finger_4",
  "finger_5",
  "strength:1",
  "strength:2",
  "strength:3",
  "strength:4",
  "strength:5",
  "black_ease:1",
  "black_ease:2",
  "black_ease:3",
  "black_ease:4",
  "black_ease:5",
  "chord_stretch",
  "chord_cramp",
  "chord_stretch_adj",
  "thumb_double",
  "pinky_double",
  "same_shape",
  "shape_shift",
  "octave_4_white",
  "inner_room",
  "inner_finger",
  "same_finger_t",
  "same_finger_fast",
  "shift_base",
  "shift_cross",
  "shift_speed",
  "shift_cost",
  "steal",
  "held_tol",
  "velocity",
  "too_fast",
  "figure",
  "fig:W_SCALE",
  "fig:W_SCALE_LONG",
  "fig:W_CHROM",
  "fig:W_ARP",
  "fig:W_OCT",
  "fig:W_THIRDS",
  "fig:W_SIXTHS",
  "fig:W_REP",
  "fig:W_REP_RUN",
  "fig:W_REP_LEAP",
  "fig:W_TRILL",
]);

// Constants from hands.py for span calculation without circular dependency
const _OCTAVE_IN = 6.5;
const _WHITE_KEY_IN = _OCTAVE_IN / 7.0;
const _HAND_SPAN_IN = 8 * _WHITE_KEY_IN;
const _WRIST_Z = 3.4;
const _KNUCKLE_Z = 4.2;
const _THUMB_CMC: readonly [number, number, number] = [-2.5, 1.6, _WRIST_Z - 0.7];
const _MC_BASE_5: readonly [number, number, number] = [1.9, 1.4, _WRIST_Z + 0.3];
const _MCP_5: readonly [number, number, number] = [3.3, 7.2, _KNUCKLE_Z - 0.3];
const _THUMB_MAX_ABD = (72 * Math.PI) / 180;
const _PINKY_MAX_ABD = (45 * Math.PI) / 180;

function _spanUnitsForAnatomy(anatomy?: Record<string, number> | null): number {
  const a = { ...DEFAULT_ANATOMY, ...(anatomy ?? {}) };
  const b1 = (a.mc1 ?? 4.7) + (a.pp1 ?? 3.3) + (a.dp1 ?? 2.8);
  const b5 = (a.pp5 ?? 3.3) + (a.mp5 ?? 1.8) + (a.dp5 ?? 1.7);
  const dx5 = _MCP_5[0] - _MC_BASE_5[0];
  const dy5 = _MCP_5[1] - _MC_BASE_5[1];
  const dz5 = _MCP_5[2] - _MC_BASE_5[2];
  const norm5 = Math.sqrt(dx5 * dx5 + dy5 * dy5 + dz5 * dz5);
  const scale5 = (a.mc5 ?? 5.974) / norm5;
  const mcp5x = _MC_BASE_5[0] + dx5 * scale5;
  const mcp5y = _MC_BASE_5[1] + dy5 * scale5;
  const tx = _THUMB_CMC[0] - b1 * Math.sin(_THUMB_MAX_ABD);
  const ty = _THUMB_CMC[1] + b1 * Math.cos(_THUMB_MAX_ABD);
  const px = mcp5x + b5 * Math.sin(_PINKY_MAX_ABD);
  const py = mcp5y + b5 * Math.cos(_PINKY_MAX_ABD);
  return Math.hypot(px - tx, py - ty);
}

const _MODEL_SPAN_DEFAULT = _spanUnitsForAnatomy(null);
const _INCHES_PER_UNIT = _HAND_SPAN_IN / _MODEL_SPAN_DEFAULT;

export function handSpanInches(anatomy?: Record<string, number> | null): number {
  return _spanUnitsForAnatomy(anatomy) * _INCHES_PER_UNIT;
}

export const hand_span_inches = handSpanInches;

function _ordinal(n: number): string {
  if (n === 1) return "unison";
  if (n === 8) return "octave";
  const mod100 = pyMod(n, 100);
  const mod10 = pyMod(n, 10);
  const suffix =
    mod100 >= 10 && mod100 <= 20
      ? "th"
      : mod10 === 1
        ? "st"
        : mod10 === 2
          ? "nd"
          : mod10 === 3
            ? "rd"
            : "th";
  return `${n}${suffix}`;
}

export function intervalName(whites: number): string {
  const n = Math.trunc(Math.floor(whites + 0.15)) + 1;
  return _ordinal(n);
}

export const interval_name = intervalName;

export interface PianistInit {
  name: string;
  id?: string;
  color?: readonly [number, number, number] | readonly number[];
  anatomy?: Record<string, number>;
  behavior?: Record<string, number | string>;
  created?: number;
  modified?: number;
  skin?: Record<string, unknown>;
  weights?: Record<string, number>;
}

export class Pianist {
  name: string;
  id: string;
  color: [number, number, number];
  anatomy: Record<string, number>;
  behavior: Record<string, number | string>;
  created: number;
  modified: number;
  skin: Record<string, unknown>;
  weights: Record<string, number>;

  constructor(
    nameOrInit: string | PianistInit,
    id = "",
    color: readonly number[] = [12, 12, 14],
    anatomy?: Record<string, number>,
    behavior?: Record<string, number | string>,
    created = 0.0,
    modified = 0.0,
    skin?: Record<string, unknown>,
    weights?: Record<string, number>,
  ) {
    if (typeof nameOrInit === "object" && nameOrInit !== null) {
      this.name = nameOrInit.name;
      this.id = nameOrInit.id ?? "";
      const c = nameOrInit.color ?? [12, 12, 14];
      this.color = [c[0] ?? 12, c[1] ?? 12, c[2] ?? 14];
      this.anatomy = nameOrInit.anatomy
        ? { ...nameOrInit.anatomy }
        : { ...DEFAULT_ANATOMY };
      this.behavior = nameOrInit.behavior
        ? { ...nameOrInit.behavior }
        : { ...DEFAULT_BEHAVIOR };
      this.created = nameOrInit.created ?? 0.0;
      this.modified = nameOrInit.modified ?? 0.0;
      this.skin = nameOrInit.skin ? { ...nameOrInit.skin } : {};
      this.weights = nameOrInit.weights ? { ...nameOrInit.weights } : {};
    } else {
      this.name = nameOrInit;
      this.id = id;
      this.color = [color[0] ?? 12, color[1] ?? 12, color[2] ?? 14];
      this.anatomy = anatomy ? { ...anatomy } : { ...DEFAULT_ANATOMY };
      this.behavior = behavior ? { ...behavior } : { ...DEFAULT_BEHAVIOR };
      this.created = created;
      this.modified = modified;
      this.skin = skin ? { ...skin } : {};
      this.weights = weights ? { ...weights } : {};
    }
  }

  get builtin(): boolean {
    return this.id === DEFAULT_ID;
  }

  copy(): Pianist {
    return new Pianist(
      this.name,
      this.id,
      [...this.color],
      { ...this.anatomy },
      { ...this.behavior },
      this.created,
      this.modified,
      JSON.parse(JSON.stringify(this.skin_settings())) as Record<string, unknown>,
      { ...this.weights },
    );
  }

  skin_settings(): Record<string, unknown> {
    const skin: Record<string, unknown> = { ...(this.skin ?? {}) };
    const rawColors =
      typeof skin.colors === "object" && skin.colors !== null
        ? (skin.colors as Record<string, unknown>)
        : {};
    const colors: Record<string, unknown> = { ...rawColors };
    const rawSkeleton =
      typeof colors.skeleton === "object" && colors.skeleton !== null
        ? (colors.skeleton as Record<string, unknown>)
        : {};
    const skeleton: Record<string, unknown> = { ...rawSkeleton };
    if (skeleton.bone === undefined) {
      skeleton.bone = [...this.color];
    }
    colors.skeleton = skeleton;
    skin.colors = colors;
    return skin;
  }

  skinSettings(): Record<string, unknown> {
    return this.skin_settings();
  }

  get badge_color(): [number, number, number] {
    return [...this.color];
  }

  get badgeColor(): [number, number, number] {
    return [...this.color];
  }

  b<T extends number | string = any>(key: string): T {
    const val = this.behavior[key];
    return (val !== undefined ? val : DEFAULT_BEHAVIOR[key]) as T;
  }

  to_json(): Record<string, unknown> {
    return {
      name: this.name,
      color: [...this.color],
      anatomy: this.anatomy,
      behavior: this.behavior,
      created: this.created,
      modified: this.modified,
      skin: this.skin_settings(),
      weights: this.weights,
    };
  }

  toJson(): Record<string, unknown> {
    return this.to_json();
  }

  static from_json(pid: string, d: Record<string, unknown>): Pianist {
    const anatomy: Record<string, number> = { ...DEFAULT_ANATOMY };
    const rawAnatomy =
      typeof d.anatomy === "object" && d.anatomy !== null
        ? (d.anatomy as Record<string, unknown>)
        : {};
    for (const [k, v] of Object.entries(rawAnatomy)) {
      if (k in anatomy) {
        anatomy[k] = clampBone(k, Number(v));
      } else if (k === WRIST) {
        const num = Number(v);
        if (!Number.isNaN(num)) {
          anatomy[WRIST] = clampWrist(num);
        }
      }
    }

    const behavior: Record<string, number | string> = { ...DEFAULT_BEHAVIOR };
    const rawBehavior =
      typeof d.behavior === "object" && d.behavior !== null
        ? (d.behavior as Record<string, unknown>)
        : {};
    for (const [k, v] of Object.entries(rawBehavior)) {
      const spec = BEHAVIOR[k];
      if (!spec) {
        continue;
      }
      if (spec.kind === "slider") {
        behavior[k] = Math.max(spec.min, Math.min(spec.max, Number(v)));
      } else if (spec.options.some((o) => o[0] === v)) {
        behavior[k] = v as string;
      }
    }

    const rawColor = Array.isArray(d.color) ? d.color : [12, 12, 14];
    const color: [number, number, number] = [
      Math.max(0, Math.min(255, Math.trunc(Number(rawColor[0] ?? 12)))),
      Math.max(0, Math.min(255, Math.trunc(Number(rawColor[1] ?? 12)))),
      Math.max(0, Math.min(255, Math.trunc(Number(rawColor[2] ?? 14)))),
    ];

    const skin: Record<string, unknown> =
      typeof d.skin === "object" && d.skin !== null
        ? { ...(d.skin as Record<string, unknown>) }
        : {};

    const weights: Record<string, number> = {};
    const rawWeights =
      typeof d.weights === "object" && d.weights !== null
        ? (d.weights as Record<string, unknown>)
        : {};
    for (const [k, v] of Object.entries(rawWeights)) {
      if (FINE_TUNE_ID_SET.has(k)) {
        const num = Number(v);
        if (!Number.isNaN(num)) {
          weights[k] = Math.max(0.0, num);
        }
      }
    }

    return new Pianist(
      String((d.name as string | undefined) || pid),
      pid,
      color,
      anatomy,
      behavior,
      Number(d.created ?? 0),
      Number(d.modified ?? 0),
      skin,
      weights,
    );
  }

  static fromJson(pid: string, d: Record<string, unknown>): Pianist {
    return Pianist.from_json(pid, d);
  }

  span_whites(): number {
    return handSpanInches(this.anatomy) / _WHITE_KEY_IN;
  }

  spanWhites(): number {
    return this.span_whites();
  }

  span_semitones(): number {
    return (this.span_whites() * 12.0) / 7.0;
  }

  spanSemitones(): number {
    return this.span_semitones();
  }

  span_label(): string {
    return `${intervalName(this.span_whites())}  ·  ${(
      handSpanInches(this.anatomy) * 2.54
    ).toFixed(1)} cm`;
  }

  spanLabel(): string {
    return this.span_label();
  }

  size_class(): "Small" | "Medium" | "Large" {
    const w = this.span_whites();
    return w < 7.6 ? "Small" : w < 8.6 ? "Medium" : "Large";
  }

  sizeClass(): "Small" | "Medium" | "Large" {
    return this.size_class();
  }
}

export function defaultPianist(): Pianist {
  return new Pianist({
    name: "Default",
    id: DEFAULT_ID,
    created: 0.0,
    modified: 0.0,
    skin: {
      style: "cartoon",
      colors: { skeleton: { bone: [12, 12, 14] } },
    },
  });
}

export const default_pianist = defaultPianist;

let _activePianist: Pianist | null = null;

export function active(): Pianist {
  return _activePianist ?? defaultPianist();
}

export function use<T>(pianist: Pianist | null | undefined, fn: () => T): T;
export function use(pianist: Pianist | null | undefined): { close(): void };
export function use<T>(
  pianist: Pianist | null | undefined,
  fn?: () => T,
): T | { close(): void } {
  const prev = _activePianist;
  _activePianist = pianist ?? defaultPianist();
  if (typeof fn === "function") {
    try {
      return fn();
    } finally {
      _activePianist = prev;
    }
  }
  return {
    close(): void {
      _activePianist = prev;
    },
  };
}

export function fromProfileDto(profile: Record<string, any> | null | undefined): Pianist {
  if (profile === null || profile === undefined) {
    return defaultPianist();
  }
  const colorRgb = Array.isArray(profile.colorRgb)
    ? profile.colorRgb
    : [12, 12, 14];
  return new Pianist(
    String(profile.name || profile.profileId || DEFAULT_ID),
    String(profile.profileId || DEFAULT_ID),
    [
      Number(colorRgb[0] ?? 12),
      Number(colorRgb[1] ?? 12),
      Number(colorRgb[2] ?? 14),
    ],
    profile.anatomy ? { ...profile.anatomy } : { ...DEFAULT_ANATOMY },
    normalizeBehavior(profile.behavior),
    Number(profile.createdAtUnixSeconds ?? 0.0),
    Number(profile.modifiedAtUnixSeconds ?? 0.0),
    profile.skin ? { ...profile.skin } : { style: "cartoon" },
    profile.weights ? { ...profile.weights } : {},
  );
}

export const from_profile_dto = fromProfileDto;
