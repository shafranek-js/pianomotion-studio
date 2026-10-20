/**
 * fingering.ts - Piano fingering for any MIDI input.
 *
 * Ported 1-to-1 from python-core/handthesia_core/fingering.py.
 */

import {
  type FigureSuggestion,
  HybridNoteMap,
  type NoteGroup,
  type NoteLike,
  DEFAULT_PREFS as FIG_DEFAULT_PREFS,
  PREFS as FIG_PREFS,
  _BASE_W as FIG_BASE_W,
  detect as detectFigures,
  getFigureWeight,
  mod,
  objId,
  resetFigureWeights,
  setFigureWeight,
} from "./figures.ts";

export { HybridNoteMap, type NoteGroup, type NoteLike, objId };

export const MIRROR_SUM = 2 * 62; // reflect about D4: 124 - p

const _BLACK: ReadonlySet<number> = new Set([1, 3, 6, 8, 10]);
const _WHITE_IDX: Record<number, number> = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
const _BLACK_POS: Record<number, number> = {
  1: 1 - 0.072,
  3: 2 + 0.072,
  6: 4 - 0.084,
  8: 5.0,
  10: 6 + 0.084,
};
const _OFF: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4 };

/**
 * Map for finger pairs (a, b) that supports `.get([a, b])`, `.get("a,b")`, `.get("a:b")`,
 * and property access `map["a,b"]` / `map["a:b"]`.
 */
export class PairMap extends Map<string, number> {
  [key: string]: unknown;

  constructor(entries?: ReadonlyArray<[[number, number] | string, number]>) {
    super();
    if (entries) {
      for (const [k, v] of entries) {
        if (Array.isArray(k)) {
          this.setPair(k[0], k[1], v);
        } else {
          this.set(k, v);
        }
      }
    }
  }

  private normalizeKey(k: unknown): string {
    if (Array.isArray(k) && k.length >= 2) {
      return `${k[0]},${k[1]}`;
    }
    if (typeof k === "string") {
      return k.replace(":", ",");
    }
    return String(k);
  }

  setPair(a: number, b: number, val: number): this {
    const k1 = `${a},${b}`;
    const k2 = `${a}:${b}`;
    super.set(k1, val);
    (this as Record<string, unknown>)[k1] = val;
    (this as Record<string, unknown>)[k2] = val;
    return this;
  }

  getPair(a: number, b: number, fallback?: number): number {
    const v = super.get(`${a},${b}`);
    return v !== undefined ? v : (fallback as number);
  }

  override get(key: unknown): number | undefined {
    return super.get(this.normalizeKey(key));
  }

  override has(key: unknown): boolean {
    return super.has(this.normalizeKey(key));
  }

  override set(key: unknown, value: number): this {
    const nk = this.normalizeKey(key);
    const parts = nk.split(",");
    if (parts.length === 2) {
      return this.setPair(Number(parts[0]), Number(parts[1]), value);
    }
    super.set(nk, value);
    (this as Record<string, unknown>)[nk] = value;
    return this;
  }

  override clear(): void {
    for (const k of this.keys()) {
      delete (this as Record<string, unknown>)[k];
      delete (this as Record<string, unknown>)[k.replace(",", ":")];
    }
    super.clear();
  }

  updateFrom(other: PairMap | Record<string, number>): void {
    if (other instanceof Map) {
      for (const [k, v] of other.entries()) {
        this.set(k, v);
      }
    } else {
      for (const [k, v] of Object.entries(other)) {
        this.set(k, v);
      }
    }
  }
}

const INITIAL_MAX_SPAN: ReadonlyArray<[[number, number], number]> = [
  [[1, 2], 5.5],
  [[1, 3], 6.5],
  [[1, 4], 7.2],
  [[1, 5], 8.3],
  [[2, 3], 2.7],
  [[2, 4], 4.6],
  [[2, 5], 6.0],
  [[3, 4], 2.4],
  [[3, 5], 4.3],
  [[4, 5], 2.6],
];

export const MAX_SPAN = new PairMap(INITIAL_MAX_SPAN);
export const BASE_MAX_SPAN = new PairMap(INITIAL_MAX_SPAN);

export const WHITE_KEY_M = (6.5 / 7) * 0.0254;
export const PEAK_RATIO = 1.875;
export const DEFAULT_MAX_SPEED = 3.0;
export let MAX_SPEED = DEFAULT_MAX_SPEED;
export const HAND_SLACK = 1.5;
export const MOVE_SHARE = 0.75;

export function travel_time(dist_wk: number, max_speed: number | null = null): number {
  let speed = max_speed || MAX_SPEED;
  if (!Number.isFinite(speed) || speed <= 0) {
    speed = DEFAULT_MAX_SPEED;
  }
  return (PEAK_RATIO * Math.abs(dist_wk) * WHITE_KEY_M) / speed;
}
export const travelTime = travel_time;

const _RANGE_CACHE = new Map<string, [number, number]>();

export function hand_range(ps: readonly number[], st: readonly number[]): [number, number] {
  const key = `${ps.join(",")}|${st.join(",")}`;
  let r = _RANGE_CACHE.get(key);
  if (r === undefined) {
    if (_RANGE_CACHE.size > 200000) {
      _RANGE_CACHE.clear();
    }
    r = _hand_range(ps, st);
    _RANGE_CACHE.set(key, r);
  }
  return r;
}
export const handRange = hand_range;

function _hand_range(ps: readonly number[], st: readonly number[]): [number, number] {
  let lo = -Infinity;
  let hi = Infinity;
  for (let i = 0; i < ps.length; i++) {
    const kp = key_pos(ps[i]!);
    const off = _OFF[st[i]!]!;
    lo = Math.max(lo, kp - off - HAND_SLACK);
    hi = Math.min(hi, kp - off + HAND_SLACK);
  }
  if (lo > hi) {
    const pairs: Array<[number, number]> = ps.map((p, i) => [p, st[i]!]);
    if (shape_cost(pairs) < IMPOSSIBLE) {
      [lo, hi] = [hi, lo];
    } else {
      const mid = (lo + hi) / 2;
      lo = mid;
      hi = mid;
    }
  }
  return [lo, hi];
}

export function range_gap(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.max(0.0, b[0] - a[1], a[0] - b[1]);
}
export const rangeGap = range_gap;

export const CHORD_TOL = 0.03;
export const BEAM = 32;
export const IMPOSSIBLE = 60.0;

export const W_TEXTBOOK: Record<string, number> = {
  stretch: 0.35,
  cramp: 0.5,
  leap: 4.0,
  leap_dist: 0.15,
  cross: 3.2,
  cross_2: 0.6,
  cross_4: 0.8,
  cross_wide: 0.8,
  cross_max: 4.0,
  cross_thumb_black: 2.4,
  awkward: 9.6,
  same_finger: 3.0,
  same_finger_dist: 0.4,
  same_key_new_finger: 0.8,
  repeat_fast: 0.6,
  repeat_t: 0.2,
  repeat_very_fast: 8.0,
  thumb_black: 1.92,
  pinky_black: 0.96,
  finger_4: 0.12,
  finger_5: 0.05,
  chord_stretch: 0.4,
  chord_cramp: 0.4,
  chord_stretch_adj: 1.2,
  figure: 1.0,
  thumb_double: 15.0,
  pinky_double: 16.0,
  same_shape: 1.5,
  shape_shift: 0.5,
  octave_4_white: 1.5,
  same_finger_t: 0.35,
  same_finger_fast: 6.0,
  shift_base: 1.0,
  shift_cross: 3.5,
  shift_speed: 8.0,
  shift_cost: 1.2,
  steal: 1.5,
  held_tol: 0.06,
  velocity: 0.05,
  too_fast: 40.0,
  inner_room: 12.0,
  inner_finger: 4.0,
};

export const LEARNED_W: Record<string, number> = {
  cramp: 0.125,
  leap_dist: 0.3,
  cross: 6.4,
  cross_2: 0.3,
  cross_4: 3.2,
  cross_wide: 1.6,
  same_finger: 6.0,
  same_finger_dist: 0.2,
  same_key_new_finger: 4.8,
  repeat_fast: 0.3,
  thumb_black: 0.24,
  pinky_black: 1.152,
  finger_4: 0.24,
  chord_stretch: 1.6,
  chord_stretch_adj: 5.76,
  octave_4_white: 3.0,
  shift_base: 2.0,
  shift_speed: 2.0,
  shift_cost: 2.4,
  steal: 12.0,
  velocity: 0.1,
};

export const BASE_W: Record<string, number> = { ...W_TEXTBOOK, ...LEARNED_W };
export const W: Record<string, number> = { ...BASE_W };

export const BASE_RELAXED: Record<number, number> = {
  1: -2.97,
  2: -1.19,
  3: 0.0,
  4: 1.19,
  5: 2.38,
};
export const RELAXED: Record<number, number> = { ...BASE_RELAXED };

export const BASE_STRENGTH: Record<number, number> = {
  1: 1.1,
  2: 1.0,
  3: 1.1,
  4: 0.9,
  5: 0.8,
};
export const FINGER_STRENGTH: Record<number, number> = { ...BASE_STRENGTH };

export const BASE_BLACK_EASE: Record<number, number> = {
  1: 0.3,
  2: 1.0,
  3: 1.1,
  4: 0.8,
  5: 0.7,
};
export const BLACK_EASE: Record<number, number> = { ...BASE_BLACK_EASE };

export const FINE_TUNE: ReadonlyArray<[string, string, string, string]> = [
  ["stretch", "Consecutive notes", "Stretch", "Per white key two fingers are spread wider than their natural spacing."],
  ["cramp", "Consecutive notes", "Cramp", "Per white key two fingers are squeezed narrower than their natural spacing."],
  ["leap", "Consecutive notes", "Leap", "Going beyond a finger pair's maximum stretch: the hand has to leap."],
  ["leap_dist", "Consecutive notes", "Leap distance", "Added to a leap per white key travelled."],
  ["cross", "Consecutive notes", "Crossing", "The thumb passing under, or a finger passing over the thumb."],
  ["cross_2", "Consecutive notes", "Crossing with 2", "Extra for a crossing with the index finger (3 is the natural one)."],
  ["cross_4", "Consecutive notes", "Crossing with 4", "Extra for a crossing with the ring finger."],
  ["cross_wide", "Consecutive notes", "Wide crossing", "Per white key a crossing spans beyond 2."],
  ["cross_max", "Consecutive notes", "Widest crossing", "White keys: a crossing wider than this counts as a leap."],
  ["cross_thumb_black", "Consecutive notes", "Thumb crossing onto black", "A crossing that lands the thumb on a black key."],
  ["awkward", "Consecutive notes", "Awkward crossing", "Any other crossing (e.g. 4 over 5), plus 1 per key."],
  ["same_finger", "Consecutive notes", "Same finger, new key", "One finger playing two different keys in a row."],
  ["same_finger_dist", "Consecutive notes", "Same finger distance", "Added per key the repeated finger has to move."],
  ["same_key_new_finger", "Consecutive notes", "Same key, new finger", "Changing finger on a repeated key."],
  ["repeat_fast", "Consecutive notes", "Quick re-strike", "The same finger re-striking a key quickly."],
  ["repeat_t", "Consecutive notes", "Re-strike time", "Seconds: re-striking with the same finger faster than this gets hard..."],
  ["repeat_very_fast", "Consecutive notes", "Very quick re-strike", "...costing up to this much extra (and changing finger less)."],
  ["thumb_black", "Fingers", "Thumb on black", "The thumb playing a black key."],
  ["pinky_black", "Fingers", "Little finger on black", "The little finger playing a black key."],
  ["finger_4", "Fingers", "Ring finger", "Using the weak ring finger, when fingerings are otherwise equal."],
  ["finger_5", "Fingers", "Little finger", "Using the weak little finger, when fingerings are otherwise equal."],
  ["strength:1", "Fingers", "Thumb strength", "How easily the thumb moves far quickly (economy of motion)."],
  ["strength:2", "Fingers", "Index strength", "How easily the index finger moves far quickly."],
  ["strength:3", "Fingers", "Middle strength", "How easily the middle finger moves far quickly."],
  ["strength:4", "Fingers", "Ring strength", "How easily the ring finger moves far quickly."],
  ["strength:5", "Fingers", "Little strength", "How easily the little finger moves far quickly."],
  ["black_ease:1", "Fingers", "Thumb black-key ease", "How easily the thumb reaches up onto black keys."],
  ["black_ease:2", "Fingers", "Index black-key ease", "How easily the index finger reaches up onto black keys."],
  ["black_ease:3", "Fingers", "Middle black-key ease", "How easily the middle finger reaches up onto black keys."],
  ["black_ease:4", "Fingers", "Ring black-key ease", "How easily the ring finger reaches up onto black keys."],
  ["black_ease:5", "Fingers", "Little black-key ease", "How easily the little finger reaches up onto black keys."],
  ["chord_stretch", "Chords", "Chord stretch", "Per white key a chord spreads two fingers wider than natural."],
  ["chord_cramp", "Chords", "Chord cramp", "Per white key a chord squeezes two fingers narrower than natural."],
  ["chord_stretch_adj", "Chords", "Neighbour stretch", "Stretch between neighbouring fingers in a chord."],
  ["thumb_double", "Chords", "Thumb on two keys", "The thumb covering two neighbouring keys in a chord."],
  ["pinky_double", "Chords", "Little finger on two keys", "The little finger covering two neighbouring white keys."],
  ["same_shape", "Chords", "Same shape fingers", "Not keeping the same fingers on a chord shape that moves by step (4-2, 4-2...)."],
  ["shape_shift", "Chords", "Shape shift", "Moving a whole chord shape with the same fingers."],
  ["octave_4_white", "Chords", "Octave 4 on white", "An octave's top note taken with 4 on a white key."],
  ["inner_room", "Chords", "Room for an inner note", "An octave on 1-4 with an inner note held between them (1-5 leaves room)."],
  ["inner_finger", "Chords", "Inner note finger", "An inner note on another finger than the one lying over it."],
  ["same_finger_t", "Movement and time", "Finger travel time", "Seconds a finger needs to reach a new key."],
  ["same_finger_fast", "Movement and time", "Same finger too fast", "The same finger asked to move to a new key in less time than that."],
  ["shift_base", "Movement and time", "Free hand shift", "White keys the hand may shift between two notes at no cost..."],
  ["shift_cross", "Movement and time", "Free shift with crossing", "...or through a thumb crossing..."],
  ["shift_speed", "Movement and time", "Shift per second", "...plus this many white keys per second between the notes."],
  ["shift_cost", "Movement and time", "Shift cost", "Per white key the hand shifts beyond that."],
  ["steal", "Movement and time", "Early release", "Letting a held key go early to reuse its finger."],
  ["held_tol", "Movement and time", "Held tolerance", "Seconds: a key released this soon after a new note isn't counted as held."],
  ["velocity", "Movement and time", "Economy of motion", "How fast the fingers must travel from a relaxed hand."],
  ["too_fast", "Movement and time", "Too fast", "Per 100% over the time a move needs at the pianist's top speed."],
  ["figure", "Figures", "Figure loyalty", "Times each figure's weight below: leaving a recognised figure's standard fingering."],
  ["fig:W_SCALE", "Figures", "Scales", "Keeping a short scale passage's standard fingering."],
  ["fig:W_SCALE_LONG", "Figures", "Long scales", "Keeping a long scale's (9+ notes one way) standard fingering."],
  ["fig:W_CHROM", "Figures", "Chromatic scales", "Keeping the chosen chromatic fingering."],
  ["fig:W_ARP", "Figures", "Arpeggios", "Keeping an arpeggio's standard fingering."],
  ["fig:W_OCT", "Figures", "Octaves", "Keeping the chosen octave fingering."],
  ["fig:W_THIRDS", "Figures", "Thirds", "Keeping the standard fingering of a run in thirds."],
  ["fig:W_SIXTHS", "Figures", "Sixths and fourths", "Keeping the standard fingering of sixths and fourths."],
  ["fig:W_REP", "Figures", "Repeated notes", "Changing fingers on quick repeated notes."],
  ["fig:W_REP_RUN", "Figures", "Repeated runs", "The chosen fingering for runs of 3+ quick repeats."],
  ["fig:W_REP_LEAP", "Figures", "Repeat then leap", "A quick repeated pair before an outward leap: 2-1, then 5."],
  ["fig:W_TRILL", "Figures", "Trills", "Keeping the chosen trill fingering."],
];
export const FINE_TUNE_IDS: readonly string[] = FINE_TUNE.map((t) => t[0]);
export const TUNE_DEFAULTS: Record<string, number> = {};

// --------------------------------------------------------------------------- #
// Minimal compatible Pianist / Hand reach helpers (matching hands.py & pianist.py)
// --------------------------------------------------------------------------- #
export interface PianistLike {
  anatomy?: Record<string, number> | null;
  behavior?: Record<string, unknown> | null;
  weights?: Record<string, number> | null;
  b?: (key: string) => unknown;
}

const DEFAULT_ANATOMY_REF: Record<string, number> = {
  mc1: 4.7, pp1: 3.3, dp1: 2.8,
  mc2: 6.684, pp2: 4.0, mp2: 2.3, dp2: 1.8,
  mc3: 6.626, pp3: 4.5, mp3: 2.7, dp3: 1.9,
  mc4: 6.332, pp4: 4.2, mp4: 2.6, dp4: 1.9,
  mc5: 5.974, pp5: 3.3, mp5: 1.8, dp5: 1.7,
};

const DEFAULT_BEHAVIOR_REF: Record<string, unknown> = {
  retraction: 0.1,
  finger_curve: 0.4,
  antic_hand: 0.5,
  antic_fingers: 0.5,
  tendon_link: 0.6,
  cross_height: 0.33,
  lift_height: 0.5,
  wrist_bounce: 0.5,
  tremolo_rotation: 0.5,
  gesture_finger_action: 0.25,
  cross_turn: 14.0,
  smoothness: 0.07,
  early_release: 0.22,
  max_speed: 3.0,
  key_area_near: 0.0,
  key_area_far: 1.0,
  roll_speed: 0.035,
  glissando: "on",
  gliss_gap: 0.05,
  gliss_min: 6,
  gliss_merge: 1.0,
  fingering_model: "learned",
  weak_bias: 0.25,
  stretch_bias: 0.0,
  economy: 0.5,
  black_avoid: 0.5,
  chromatic: "13",
  repeated: "321",
  trill: "auto",
  octaves: "4black",
};

export function getPianistBehavior<T = unknown>(p: PianistLike | null | undefined, key: string): T {
  if (p && typeof p.b === "function") {
    return p.b(key) as T;
  }
  if (p && p.behavior && key in p.behavior && p.behavior[key] !== undefined) {
    return p.behavior[key] as T;
  }
  return DEFAULT_BEHAVIOR_REF[key] as T;
}

const OCTAVE_IN = 6.5;
const WHITE_KEY_IN = OCTAVE_IN / 7.0;
const HAND_SPAN_IN = 8 * WHITE_KEY_IN;
const WRIST_Z = 3.4;
const KNUCKLE_Z = 4.2;
const THUMB_CMC: [number, number, number] = [-2.5, 1.6, WRIST_Z - 0.7];
const MC_BASE: Record<number, [number, number, number]> = {
  2: [-1.4, 1.9, WRIST_Z + 0.5],
  3: [-0.3, 2.0, WRIST_Z + 0.6],
  4: [0.9, 1.8, WRIST_Z + 0.5],
  5: [1.9, 1.4, WRIST_Z + 0.3],
};
const MCP_REF: Record<number, [number, number, number]> = {
  2: [-2.9, 8.4, KNUCKLE_Z + 0.1],
  3: [-0.7, 8.6, KNUCKLE_Z + 0.3],
  4: [1.4, 8.1, KNUCKLE_Z + 0.1],
  5: [3.3, 7.2, KNUCKLE_Z - 0.3],
};
const BONES_REF: Record<number, [number, number, number]> = {
  1: [4.7, 3.3, 2.8],
  2: [4.0, 2.3, 1.8],
  3: [4.5, 2.7, 1.9],
  4: [4.2, 2.6, 1.9],
  5: [3.3, 1.8, 1.7],
};
const _THUMB_MAX_ABD = (72 * Math.PI) / 180;
const _PINKY_MAX_ABD = (45 * Math.PI) / 180;
const SPLAY_LIMIT_DEG: Record<number, [number, number]> = {
  1: [-85, 34],
  2: [-36, 14],
  3: [-26, 26],
  4: [-22, 24],
  5: [-12, 55],
};
const REACH_COMFORT: Record<number, number> = { 1: 0.97, 2: 0.98, 3: 0.98, 4: 0.98, 5: 0.98 };

function sum3(t: readonly [number, number, number]): number {
  return t[0] + t[1] + t[2];
}

function _model_span(): number {
  const tx = THUMB_CMC[0] - sum3(BONES_REF[1]!) * Math.sin(_THUMB_MAX_ABD);
  const ty = THUMB_CMC[1] + sum3(BONES_REF[1]!) * Math.cos(_THUMB_MAX_ABD);
  const px = MCP_REF[5]![0] + sum3(BONES_REF[5]!) * Math.sin(_PINKY_MAX_ABD);
  const py = MCP_REF[5]![1] + sum3(BONES_REF[5]!) * Math.cos(_PINKY_MAX_ABD);
  return Math.hypot(px - tx, py - ty);
}

const INCHES_PER_UNIT = HAND_SPAN_IN / _model_span();

function computeGeometry(anatomy?: Record<string, number> | null) {
  const a: Record<string, number> = { ...DEFAULT_ANATOMY_REF, ...(anatomy ?? {}) };
  const mcp: Record<number, [number, number, number]> = {};
  for (let f = 2; f <= 5; f++) {
    const base = MC_BASE[f]!;
    const ref = MCP_REF[f]!;
    const dx = ref[0] - base[0];
    const dy = ref[1] - base[1];
    const dz = ref[2] - base[2];
    const norm = Math.hypot(dx, dy, dz);
    const scale = a[`mc${f}`]! / norm;
    mcp[f] = [base[0] + dx * scale, base[1] + dy * scale, base[2] + dz * scale];
  }
  const bones: Record<number, [number, number, number]> = {
    1: [a["mc1"]!, a["pp1"]!, a["dp1"]!],
  };
  for (let f = 2; f <= 5; f++) {
    bones[f] = [a[`pp${f}`]!, a[`mp${f}`]!, a[`dp${f}`]!];
  }
  function baseOf(f: number): [number, number, number] {
    return f === 1 ? THUMB_CMC : mcp[f]!;
  }
  function spanUnits(): number {
    const tx = THUMB_CMC[0] - sum3(bones[1]!) * Math.sin(_THUMB_MAX_ABD);
    const ty = THUMB_CMC[1] + sum3(bones[1]!) * Math.cos(_THUMB_MAX_ABD);
    const px = mcp[5]![0] + sum3(bones[5]!) * Math.sin(_PINKY_MAX_ABD);
    const py = mcp[5]![1] + sum3(bones[5]!) * Math.cos(_PINKY_MAX_ABD);
    return Math.hypot(px - tx, py - ty);
  }
  function pairReach(fa: number, fb: number): number {
    function tip(f: number, outward: boolean): [number, number] {
      let ang: number;
      if (f === 1) {
        ang = -_THUMB_MAX_ABD;
      } else if (f === 5 && outward) {
        ang = _PINKY_MAX_ABD;
      } else {
        const [lo, hi] = SPLAY_LIMIT_DEG[f]!;
        ang = ((outward ? hi : lo) * Math.PI) / 180;
      }
      const L = sum3(bones[f]!) * REACH_COMFORT[f]!;
      const [bx, by] = baseOf(f);
      return [bx + L * Math.sin(ang), by + L * Math.cos(ang)];
    }
    const [ax, ay] = tip(fa, false);
    const [bx, by] = tip(fb, true);
    return Math.hypot(bx - ax, by - ay);
  }
  return { spanUnits, pairReach };
}

export function hand_span_inches(anatomy?: Record<string, number> | null): number {
  return computeGeometry(anatomy).spanUnits() * INCHES_PER_UNIT;
}
export const handSpanInches = hand_span_inches;

const _REACH_CACHE = new Map<string, PairMap>();

export function reach_scale(anatomy?: Record<string, number> | null): PairMap {
  const entries = Object.entries(anatomy ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const key = entries.map(([k, v]) => `${k}:${v}`).join("|");
  let got = _REACH_CACHE.get(key);
  if (!got) {
    const g = computeGeometry(anatomy);
    const g0 = computeGeometry(null);
    got = new PairMap();
    for (let a = 1; a <= 5; a++) {
      for (let b = a + 1; b <= 5; b++) {
        got.setPair(a, b, g.pairReach(a, b) / g0.pairReach(a, b));
      }
    }
    _REACH_CACHE.set(key, got);
  }
  return got;
}
export const reachScale = reach_scale;

// --------------------------------------------------------------------------- #
// Fine-tuning & pianist profile application
// --------------------------------------------------------------------------- #
export function tune_value(tid: string): number {
  if (tid.startsWith("fig:")) {
    return Number(getFigureWeight(tid.slice(4)));
  }
  if (tid.startsWith("strength:")) {
    return Number(FINGER_STRENGTH[parseInt(tid.slice(9), 10)]);
  }
  if (tid.startsWith("black_ease:")) {
    return Number(BLACK_EASE[parseInt(tid.slice(11), 10)]);
  }
  return Number(W[tid]);
}
export const tuneValue = tune_value;

function _set_tune(tid: string, v: number): void {
  if (tid.startsWith("fig:")) {
    setFigureWeight(tid.slice(4), v);
  } else if (tid.startsWith("strength:")) {
    FINGER_STRENGTH[parseInt(tid.slice(9), 10)] = v;
  } else if (tid.startsWith("black_ease:")) {
    BLACK_EASE[parseInt(tid.slice(11), 10)] = v;
  } else {
    W[tid] = v;
  }
}

export function tune_range(tid: string): [number, number, number] {
  let ref: number;
  if (tid.startsWith("fig:")) {
    ref = FIG_BASE_W[tid.slice(4)]!;
  } else if (tid.startsWith("strength:")) {
    ref = BASE_STRENGTH[parseInt(tid.slice(9), 10)]!;
  } else if (tid.startsWith("black_ease:")) {
    ref = BASE_BLACK_EASE[parseInt(tid.slice(11), 10)]!;
  } else {
    ref = Math.max(W_TEXTBOOK[tid]!, BASE_W[tid]!);
  }
  let hi = Math.max(1.0, 3.0 * ref);
  const mag = 10 ** Math.floor(Math.log10(hi));
  hi = (Math.ceil((hi / mag) * 2) / 2) * mag;
  return [0.0, hi, hi / 200.0];
}
export const tuneRange = tune_range;

export function tuned_defaults(p: PianistLike | null = null): Record<string, number> {
  apply_pianist(p);
  return { ...TUNE_DEFAULTS };
}
export const tunedDefaults = tuned_defaults;

let _applied: string | null = null;
export const REACH_SCALE = new PairMap();

function serializePianistKey(
  p: PianistLike | null | undefined,
  tuned: Record<string, number>,
): string {
  if (!p) return "__default__";
  const aEntries = Object.entries(p.anatomy ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const bEntries = Object.entries(p.behavior ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const wEntries = Object.entries(tuned).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([aEntries, bEntries, wEntries]);
}

export function apply_pianist(p: PianistLike | null = null): void {
  const tuned: Record<string, number> =
    p && p.weights ? { ...p.weights } : {};
  const key = serializePianistKey(p, tuned);
  if (key === _applied) {
    return;
  }
  _applied = key;
  _RANGE_CACHE.clear();
  const base =
    p !== null && p !== undefined && getPianistBehavior<string>(p, "fingering_model") === "textbook"
      ? W_TEXTBOOK
      : BASE_W;
  for (const k of Object.keys(W)) {
    delete W[k];
  }
  Object.assign(W, base);
  MAX_SPAN.updateFrom(BASE_MAX_SPAN);
  REACH_SCALE.clear();
  Object.assign(FIG_PREFS, FIG_DEFAULT_PREFS);
  resetFigureWeights();
  Object.assign(FINGER_STRENGTH, BASE_STRENGTH);
  Object.assign(BLACK_EASE, BASE_BLACK_EASE);
  Object.assign(RELAXED, BASE_RELAXED);
  MAX_SPEED = DEFAULT_MAX_SPEED;
  if (p === null || p === undefined) {
    for (const tid of FINE_TUNE_IDS) {
      TUNE_DEFAULTS[tid] = tune_value(tid);
    }
    return;
  }
  _apply_preferences(p, base);
  for (const tid of FINE_TUNE_IDS) {
    TUNE_DEFAULTS[tid] = tune_value(tid);
  }
  for (const [tid, v] of Object.entries(tuned)) {
    if (tid in TUNE_DEFAULTS) {
      _set_tune(tid, Math.max(0.0, Number(v)));
    }
  }
}
export const applyPianist = apply_pianist;

export function reset_context(p: PianistLike | null = null): void {
  _applied = null;
  _RANGE_CACHE.clear();
  for (const k of Object.keys(W)) {
    delete W[k];
  }
  Object.assign(W, BASE_W);
  MAX_SPAN.updateFrom(BASE_MAX_SPAN);
  REACH_SCALE.clear();
  MAX_SPEED = DEFAULT_MAX_SPEED;
  for (const k of Object.keys(TUNE_DEFAULTS)) {
    delete TUNE_DEFAULTS[k];
  }
  apply_pianist(p);
}
export const resetContext = reset_context;

function _apply_preferences(p: PianistLike, base: Record<string, number>): void {
  const speed = Number(getPianistBehavior(p, "max_speed"));
  MAX_SPEED = Number.isFinite(speed) && speed > 0 ? speed : DEFAULT_MAX_SPEED;
  const kSpan = hand_span_inches(p.anatomy) / hand_span_inches(null);
  for (const [f, v] of Object.entries(BASE_RELAXED)) {
    RELAXED[Number(f)] = v * kSpan;
  }
  const stretch = Number(getPianistBehavior(p, "stretch_bias"));
  const scale = reach_scale(p.anatomy);
  REACH_SCALE.updateFrom(scale);
  for (const [pairKey, v] of BASE_MAX_SPAN.entries()) {
    const s = scale.get(pairKey) ?? 1.0;
    MAX_SPAN.set(pairKey, v * s * (1.0 + 0.06 * Math.min(0.0, stretch)));
  }
  const kWeak = Number(getPianistBehavior(p, "weak_bias")) / 0.25;
  W["finger_4"] = base["finger_4"]! * kWeak;
  W["finger_5"] = base["finger_5"]! * kWeak;
  for (const name of ["stretch", "chord_stretch", "chord_stretch_adj"]) {
    W[name] = base[name]! * (1.0 - 0.6 * stretch);
  }
  for (const name of ["cross", "leap", "shift_cost"]) {
    W[name] = base[name]! * (1.0 + 0.4 * stretch);
  }
  W["velocity"] = (base["velocity"]! * Number(getPianistBehavior(p, "economy"))) / 0.5;
  const b = Number(getPianistBehavior(p, "black_avoid")) / 0.5;
  W["thumb_black"] = base["thumb_black"]! * b;
  W["pinky_black"] = base["pinky_black"]! * b;
  W["cross_thumb_black"] = base["cross_thumb_black"]! * b;
  FIG_PREFS["chromatic"] = String(getPianistBehavior(p, "chromatic"));
  FIG_PREFS["repeated"] = String(getPianistBehavior(p, "repeated"));
  FIG_PREFS["trill"] = String(getPianistBehavior(p, "trill"));
  FIG_PREFS["octaves"] = String(getPianistBehavior(p, "octaves"));
}

export function comfy(dist: number, fa: number, fb: number): number {
  const lo = Math.min(fa, fb);
  const hi = Math.max(fa, fb);
  return dist / REACH_SCALE.getPair(lo, hi, 1.0);
}

export function is_black(pitch: number): boolean {
  return _BLACK.has(mod(pitch, 12));
}
export const isBlack = is_black;

function _key_pos(pitch: number): number {
  const octave = Math.floor(pitch / 12);
  const pc = mod(pitch, 12);
  return octave * 7 + (pc in _WHITE_IDX ? _WHITE_IDX[pc]! + 0.5 : _BLACK_POS[pc]!);
}

const _KEY_POS: readonly number[] = Array.from({ length: 384 }, (_, i) => _key_pos(i - 128));

export function key_pos(pitch: number): number {
  const idx = pitch + 128;
  if (Number.isInteger(idx) && idx >= 0 && idx < _KEY_POS.length) {
    return _KEY_POS[idx]!;
  }
  return _key_pos(pitch);
}
export const keyPos = key_pos;

export function mirror_pitch(pitch: number): number {
  return MIRROR_SUM - pitch;
}
export const mirrorPitch = mirror_pitch;

// --------------------------------------------------------------------------- #
// Pianist's cost model (right-hand frame)
// --------------------------------------------------------------------------- #
export function is_crossing(p1: number, f1: number, p2: number, f2: number): boolean {
  const d = key_pos(p2) - key_pos(p1);
  return (
    (d > 0 && f2 === 1 && (f1 === 2 || f1 === 3 || f1 === 4)) ||
    (d < 0 && f1 === 1 && (f2 === 2 || f2 === 3 || f2 === 4))
  );
}
export const isCrossing = is_crossing;

export function thumb_pair(aInput: number, bInput: number): boolean {
  const a = Math.min(aInput, bInput);
  const b = Math.max(aInput, bInput);
  if (a === b) {
    return false;
  }
  if (is_black(a) !== is_black(b)) {
    return false;
  }
  if (!is_black(a)) {
    return b - a <= 2 && Math.abs(key_pos(b) - key_pos(a) - 1.0) < 1e-6;
  }
  return b - a === 2 || b - a === 3;
}
export const thumbPair = thumb_pair;

export function pinky_pair(aInput: number, bInput: number): boolean {
  const a = Math.min(aInput, bInput);
  const b = Math.max(aInput, bInput);
  return (
    a !== b &&
    !is_black(a) &&
    !is_black(b) &&
    b - a <= 2 &&
    Math.abs(key_pos(b) - key_pos(a) - 1.0) < 1e-6
  );
}
export const pinkyPair = pinky_pair;

export function double_ok(p1: number, p2: number, f: number): boolean {
  return (f === 1 && thumb_pair(p1, p2)) || (f === 5 && pinky_pair(p1, p2));
}
export const doubleOk = double_ok;

export function thumb_bridge(a: number, b: number): boolean {
  return thumb_pair(a, b) && is_black(a) && is_black(b);
}
export const thumbBridge = thumb_bridge;

export function bridge_from(ps: readonly number[], fs: readonly number[], k: number): number {
  if (fs[k] === 1 && k > 0 && fs[k - 1] === 1 && thumb_bridge(ps[k - 1]!, ps[k]!)) {
    return ps[k - 1]!;
  }
  return ps[k]!;
}
export const bridgeFrom = bridge_from;

export function unary_cost(pitch: number, f: number): number {
  let c = f === 4 ? W["finger_4"]! : f === 5 ? W["finger_5"]! : 0.0;
  if (is_black(pitch)) {
    if (f === 1) {
      c += W["thumb_black"]!;
    } else if (f === 5) {
      c += W["pinky_black"]!;
    }
  }
  return c;
}
export const unaryCost = unary_cost;

export function leap_cost(d: number): number {
  return W["leap"]! + W["leap_dist"]! * Math.abs(d);
}
export const leapCost = leap_cost;

export function pair_cost(p1: number, f1: number, p2: number, f2: number): number {
  const d = key_pos(p2) - key_pos(p1);
  if (f1 === f2) {
    return p1 === p2 ? 0.0 : W["same_finger"]! + W["same_finger_dist"]! * Math.abs(d);
  }
  if (Math.abs(d) < 1e-9) {
    return W["same_key_new_finger"]!;
  }
  if (is_crossing(p1, f1, p2, f2)) {
    if (Math.abs(d) > W["cross_max"]!) {
      return leap_cost(d);
    }
    const other = f2 === 1 ? f1 : f2;
    const extra = other === 2 ? W["cross_2"]! : other === 4 ? W["cross_4"]! : 0.0;
    let c = W["cross"]! + extra;
    c += W["cross_wide"]! * Math.max(0.0, Math.abs(d) - 2.0);
    if (f2 === 1 && is_black(p2)) {
      c += W["cross_thumb_black"]!;
    }
    return c;
  }
  if (d > 0 === f2 > f1) {
    const rel = Math.abs(d);
    const nat = Math.abs(_OFF[f2]! - _OFF[f1]!);
    const c =
      W["stretch"]! * Math.max(0.0, comfy(rel, f1, f2) - nat) +
      W["cramp"]! * Math.max(0.0, nat - rel);
    const limit = MAX_SPAN.getPair(Math.min(f1, f2), Math.max(f1, f2));
    if (rel > limit) {
      return leap_cost(d);
    }
    return c;
  }
  return W["awkward"]! + Math.abs(d);
}
export const pairCost = pair_cost;

export function chord_pair_cost(pl: number, fl: number, ph: number, fh: number): number {
  const rel = key_pos(ph) - key_pos(pl);
  const nat = _OFF[fh]! - _OFF[fl]!;
  if (fl >= fh) {
    if (fl === fh && double_ok(pl, ph, fl)) {
      return fl === 1 ? W["thumb_double"]! : W["pinky_double"]!;
    }
    if (fl === fh) {
      return IMPOSSIBLE;
    }
    return (
      W["cross"]! * 2 +
      W["chord_stretch"]! * Math.abs(rel) +
      (rel > MAX_SPAN.getPair(fh, fl, 12) ? IMPOSSIBLE : 0.0)
    );
  }
  const spread = comfy(rel, fl, fh);
  let c =
    W["chord_stretch"]! * Math.max(0.0, spread - nat) +
    W["chord_cramp"]! * Math.max(0.0, nat - rel);
  if (fh - fl === 1 && fl !== 1) {
    c += W["chord_stretch_adj"]! * Math.max(0.0, spread - 1.2);
  }
  if (rel > MAX_SPAN.getPair(fl, fh)) {
    c += IMPOSSIBLE;
  }
  if (fl === 1 && fh === 4 && rel >= 6.0 && !is_black(ph)) {
    c += W["octave_4_white"]!;
  }
  return c;
}
export const chordPairCost = chord_pair_cost;

export const INNER_2_TOP = 0.5;
export const INNER_3_TOP = 0.72;

export function inner_room_cost(pairs: ReadonlyArray<readonly [number, number]>): number {
  const thumb: number[] = [];
  const top: Array<readonly [number, number]> = [];
  for (const pair of pairs) {
    if (pair[1] === 1) {
      thumb.push(pair[0]);
    } else if (pair[1] === 4 || pair[1] === 5) {
      top.push(pair);
    }
  }
  if (thumb.length === 0 || top.length === 0) {
    return 0.0;
  }
  const lo = Math.min(...thumb);
  let hi = top[0]![0];
  let fh = top[0]![1];
  for (let i = 1; i < top.length; i++) {
    const [p, f] = top[i]!;
    if (p > hi || (p === hi && f > fh)) {
      hi = p;
      fh = f;
    }
  }
  if (hi - lo < 11) {
    return 0.0;
  }
  const inner = pairs.filter(([p, f]) => lo < p && p < hi && f !== 1 && f !== fh);
  if (inner.length === 0) {
    return 0.0;
  }
  let c = fh === 4 ? W["inner_room"]! : 0.0;
  if (inner.length >= fh - 2) {
    return c;
  }
  const span = key_pos(hi) - key_pos(lo);
  for (const [p, f] of inner) {
    const r = (key_pos(p) - key_pos(lo)) / span;
    const want = r < INNER_2_TOP ? 2 : r < INNER_3_TOP ? 3 : 4;
    if (f !== want) {
      c += W["inner_finger"]!;
    }
  }
  return c;
}
export const innerRoomCost = inner_room_cost;

export function shape_cost(pairsInput: ReadonlyArray<readonly [number, number]>): number {
  const pairs = [...pairsInput].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const ps = pairs.map((x) => x[0]);
  const fs = pairs.map((x) => x[1]);
  let c = 0.0;
  for (let k = 0; k + 1 < pairs.length; k++) {
    let [p1, f1] = pairs[k]!;
    const [p2, f2] = pairs[k + 1]!;
    if (f1 === f2) {
      if (double_ok(p1, p2, f1)) {
        continue;
      }
      return IMPOSSIBLE;
    }
    p1 = bridge_from(ps, fs, k);
    if (f2 < f1) {
      if ((f1 === 1 || f2 === 1) && key_pos(p2) - key_pos(p1) <= 2.5) {
        c += 3.0;
        continue;
      }
      return IMPOSSIBLE;
    }
    if (key_pos(p2) - key_pos(p1) > MAX_SPAN.getPair(f1, f2)) {
      return IMPOSSIBLE;
    }
  }
  return c;
}
export const shapeCost = shape_cost;

// --------------------------------------------------------------------------- #
// Search
// --------------------------------------------------------------------------- #
export const RUN_SPLIT_T = 0.008;

function _next_in_run(group: readonly NoteLike[], n: NoteLike): boolean {
  if (group.length !== 1) {
    return false;
  }
  const prev = group[0]!;
  const d = Math.abs(n.pitch - prev.pitch);
  return n.start - prev.start >= RUN_SPLIT_T && d >= 1 && d <= 2;
}

export function group_notes<T extends NoteLike = NoteLike>(
  notes: readonly T[],
  vpitch: ((p: number) => number) | null = null,
  tolerance = CHORD_TOL,
): NoteGroup<T>[] {
  const vp = vpitch ?? ((p: number) => p);
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const groups: NoteGroup<T>[] = [];
  for (const n of sorted) {
    const last = groups[groups.length - 1];
    if (last && n.start - last[0] <= tolerance && !_next_in_run(last[1], n)) {
      last[1].push(n);
    } else {
      groups.push([n.start, [n]]);
    }
  }
  const out: NoteGroup<T>[] = [];
  for (const [start, nsRaw] of groups) {
    const ns = [...nsRaw].sort((a, b) => vp(a.pitch) - vp(b.pitch));
    const room = (arr: readonly T[]): number => {
      if (arr.length < 2) return 5;
      return (
        5 +
        (thumb_pair(vp(arr[0]!.pitch), vp(arr[1]!.pitch)) ? 1 : 0) +
        (pinky_pair(vp(arr[arr.length - 2]!.pitch), vp(arr[arr.length - 1]!.pitch)) ? 1 : 0)
      );
    };
    while (ns.length > room(ns)) {
      ns.splice(Math.floor(ns.length / 2), 1);
    }
    out.push([start, ns]);
  }
  return out;
}
export const groupNotes = group_notes;

function tupleEq(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function _transition(
  pps: readonly number[],
  pf: readonly number[],
  ps: readonly number[],
  st: readonly number[],
  dt: number,
): number {
  if (ps.length > 1 && pps.length === ps.length) {
    const moves = ps.map((b, i) => b - pps[i]!);
    if (Math.max(...moves) === Math.min(...moves) && moves[0] !== 0) {
      const d = Math.abs(key_pos(ps[0]!) - key_pos(pps[0]!));
      const over = d - (W["shift_base"]! + W["shift_speed"]! * dt);
      let c = W["shape_shift"]! + 0.1 * d + (over > 0 ? W["shift_cost"]! * over : 0.0);
      let diffFingers = 0;
      for (let i = 0; i < pf.length; i++) {
        if (pf[i] !== st[i]) diffFingers += 1;
      }
      c += 0.3 * diffFingers;
      if (tupleEq(st, pf) && ps[ps.length - 1]! - ps[0]! < 7 && Math.abs(moves[0]!) <= 2) {
        c += W["same_shape"]!;
      }
      return c + speed_cost(pps, pf, ps, st, dt);
    }
  }
  let c = 0.0;
  let cross = false;
  for (let i = 0; i < ps.length; i++) {
    const p2 = ps[i]!;
    const f2 = st[i]!;
    let j = 0;
    let bestDist = Math.abs(pps[0]! - p2);
    for (let k = 1; k < pps.length; k++) {
      const dist = Math.abs(pps[k]! - p2);
      if (dist < bestDist) {
        bestDist = dist;
        j = k;
      }
    }
    const p1 = pps[j]!;
    const f1 = pf[j]!;
    c += pair_cost(p1, f1, p2, f2);
    if (f1 === f2) {
      if (p1 !== p2 && dt < W["same_finger_t"]!) {
        c +=
          W["same_finger_fast"]! *
          (1.0 - dt / W["same_finger_t"]!) *
          (1 + 0.2 * Math.abs(p2 - p1));
      } else if (p1 === p2 && dt < 0.2) {
        c += W["repeat_fast"]!;
        if (dt < W["repeat_t"]!) {
          c += W["repeat_very_fast"]! * (1.0 - dt / W["repeat_t"]!);
        }
      }
    } else if (p1 === p2 && dt < W["repeat_t"]!) {
      c -= W["same_key_new_finger"]! * (1.0 - dt / W["repeat_t"]!);
    }
    if (!cross) {
      for (let k = 0; k < pps.length; k++) {
        if (is_crossing(pps[k]!, pf[k]!, p2, f2)) {
          cross = true;
          break;
        }
      }
    }
  }
  c = (c / ps.length) * (ps.length === 1 ? 1.0 : 1.3);
  if (W["velocity"]) {
    const a1 = key_pos(pps[0]!) - RELAXED[pf[0]!]!;
    let v = 0.0;
    for (let i = 0; i < ps.length; i++) {
      const p2 = ps[i]!;
      const f2 = st[i]!;
      let sp =
        Math.abs(key_pos(p2) - (a1 + RELAXED[f2]!)) /
        (dt + 0.1) /
        FINGER_STRENGTH[f2]!;
      if (is_black(p2)) {
        sp /= BLACK_EASE[f2]!;
      }
      v += sp;
    }
    c += (W["velocity"]! * v) / ps.length;
  }
  c += speed_cost(pps, pf, ps, st, dt);
  let sum1 = 0;
  for (let i = 0; i < pps.length; i++) {
    sum1 += key_pos(pps[i]!) - _OFF[pf[i]!]!;
  }
  let sum2 = 0;
  for (let i = 0; i < ps.length; i++) {
    sum2 += key_pos(ps[i]!) - _OFF[st[i]!]!;
  }
  const a1 = sum1 / pps.length;
  const a2 = sum2 / ps.length;
  const over =
    Math.abs(a2 - a1) -
    ((cross ? W["shift_cross"]! : W["shift_base"]!) + W["shift_speed"]! * dt);
  if (over > 0) {
    c += W["shift_cost"]! * over;
  }
  return c;
}
export const transition = _transition;

export function speed_cost(
  pps: readonly number[],
  pf: readonly number[],
  ps: readonly number[],
  st: readonly number[],
  dt: number,
): number {
  const avail = Math.max(1e-3, MOVE_SHARE * dt);
  let need = travel_time(range_gap(hand_range(pps, pf), hand_range(ps, st)));
  for (let i = 0; i < ps.length; i++) {
    const p2 = ps[i]!;
    const f2 = st[i]!;
    for (let j = 0; j < pps.length; j++) {
      const p1 = pps[j]!;
      const f1 = pf[j]!;
      if (f1 === f2 && p1 !== p2) {
        need = Math.max(need, travel_time(key_pos(p2) - key_pos(p1)));
      }
    }
  }
  return need > avail ? W["too_fast"]! * (need / avail - 1.0) : 0.0;
}
export const speedCost = speed_cost;

function combinations<T>(arr: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k < 0 || k > arr.length) return [];
  const out: T[][] = [];
  const cur: T[] = [];
  function walk(start: number): void {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    const rem = k - cur.length;
    for (let i = start; i <= arr.length - rem; i++) {
      cur.push(arr[i]!);
      walk(i + 1);
      cur.pop();
    }
  }
  walk(0);
  return out;
}

function productRepeat<T>(arr: readonly T[], repeat: number): T[][] {
  if (repeat === 0) return [[]];
  const out: T[][] = [];
  const cur: T[] = [];
  function walk(): void {
    if (cur.length === repeat) {
      out.push([...cur]);
      return;
    }
    for (const item of arr) {
      cur.push(item);
      walk();
      cur.pop();
    }
  }
  walk();
  return out;
}

export function _states(
  given: ReadonlyArray<number | null | undefined>,
  ps: readonly number[] | null = null,
): number[][] {
  const k = given.length;
  const f15 = [1, 2, 3, 4, 5];
  let states: number[][] = k <= 5 ? combinations(f15, k) : [];
  if (ps !== null && k >= 3) {
    const tp = thumb_pair(ps[0]!, ps[1]!);
    const pp = pinky_pair(ps[ps.length - 2]!, ps[ps.length - 1]!);
    if (tp) {
      for (const c of combinations([2, 3, 4, 5], k - 2)) {
        states.push([1, 1, ...c]);
      }
    }
    if (pp) {
      for (const c of combinations([1, 2, 3, 4], k - 2)) {
        states.push([...c, 5, 5]);
      }
    }
    if (tp && pp && k >= 5) {
      for (const c of combinations([2, 3, 4], k - 4)) {
        states.push([1, 1, ...c, 5, 5]);
      }
    }
  }
  if (states.length === 0) {
    states = [f15.slice(0, k)];
  }
  if (!given.some((g) => g !== null && g !== undefined && g !== 0)) {
    return states;
  }
  const fixed = states.filter((st) =>
    given.every((g, i) => g === null || g === undefined || g === st[i]),
  );
  if (fixed.length > 0) {
    return fixed;
  }
  const free: number[] = [];
  for (let i = 0; i < given.length; i++) {
    if (given[i] === null || given[i] === undefined) {
      free.push(i);
    }
  }
  const left = f15.filter((f) => !given.includes(f));
  const pools =
    left.length >= free.length
      ? combinations(left, free.length)
      : productRepeat(f15, free.length);
  const out: number[][] = [];
  for (const pool of pools) {
    const st = given.map((g) => g ?? 1);
    for (let idx = 0; idx < free.length; idx++) {
      st[free[idx]!] = pool[idx]!;
    }
    out.push(st);
  }
  return out.length > 0 ? out : [given.map((g) => g || 1)];
}
export const states = _states;

export type NoteLookup<V> =
  | ReadonlyMap<unknown, V>
  | Record<number | string, V | undefined>;

export function lookupNote<V>(
  map: NoteLookup<V> | null | undefined,
  note: NoteLike,
): V | undefined {
  if (!map) return undefined;
  const id = objId(note);
  if (map instanceof Map) {
    if (map.has(note)) return map.get(note);
    if (map.has(id)) return map.get(id);
    if (note.id !== undefined && map.has(note.id)) return map.get(note.id);
    if (note.noteId !== undefined && note.noteId !== null && map.has(note.noteId)) {
      return map.get(note.noteId);
    }
    return undefined;
  }
  const rec = map as Record<number | string, V | undefined>;
  if (id in rec) return rec[id];
  if (note.id !== undefined && note.id in rec) return rec[note.id];
  if (note.noteId !== undefined && note.noteId !== null && note.noteId in rec) {
    return rec[note.noteId];
  }
  return undefined;
}

export function hasNoteInLookup(
  map: NoteLookup<unknown> | null | undefined,
  note: NoteLike,
): boolean {
  return lookupNote(map, note) !== undefined;
}

function setNoteInSink<V>(
  sink: Map<unknown, V> | Record<number | string, V>,
  note: NoteLike,
  value: V,
): void {
  const id = objId(note);
  if (sink instanceof HybridNoteMap) {
    sink.setNote(note, value);
    return;
  }
  if (sink instanceof Map) {
    sink.set(note, value);
    (sink as unknown as Record<number | string, V>)[id] = value;
    if (note.id !== undefined) {
      (sink as unknown as Record<number | string, V>)[note.id] = value;
    }
    if (note.noteId !== undefined && note.noteId !== null) {
      (sink as unknown as Record<number | string, V>)[note.noteId] = value;
    }
    return;
  }
  sink[id] = value;
  if (note.id !== undefined) {
    sink[note.id] = value;
  }
  if (note.noteId !== undefined && note.noteId !== null) {
    sink[note.noteId] = value;
  }
}

const WRAPPED_SET_SYMBOL = Symbol.for("handthesia.engine.wrappedRepairedSet");

function addRepairedNote(repairedSet: Set<unknown>, note: NoteLike): void {
  const anySet = repairedSet as Set<unknown> & {
    [WRAPPED_SET_SYMBOL]?: Set<number | string>;
  };
  if (!anySet[WRAPPED_SET_SYMBOL]) {
    const keySet = new Set<number | string>();
    anySet[WRAPPED_SET_SYMBOL] = keySet;
    const origHas = repairedSet.has.bind(repairedSet);
    repairedSet.has = (val: unknown): boolean => {
      if (origHas(val)) return true;
      if (typeof val === "number" || typeof val === "string") {
        return keySet.has(val);
      }
      if (val !== null && typeof val === "object") {
        if (keySet.has(objId(val))) return true;
        const n = val as NoteLike;
        if (n.id !== undefined && keySet.has(n.id)) return true;
        if (n.noteId !== undefined && n.noteId !== null && keySet.has(n.noteId)) return true;
      }
      return false;
    };
  }
  const keySet = anySet[WRAPPED_SET_SYMBOL]!;
  repairedSet.add(note);
  keySet.add(objId(note));
  if (note.id !== undefined) keySet.add(note.id);
  if (note.noteId !== undefined && note.noteId !== null) keySet.add(note.noteId);
}

export interface PlanFingeringOptions<T extends NoteLike = NoteLike> {
  vpitch?: ((p: number) => number) | null;
  beam?: number;
  hand?: string | null;
  context?: readonly NoteLike[] | null;
  figures?: boolean;
  pianist?: PianistLike | null;
  fixed?: NoteLookup<number | null | undefined> | null;
  costs?: Map<T, number> | Record<number | string, number> | null;
  repair?: boolean;
  repaired?: Set<unknown> | null;
}

export function plan_fingering<T extends NoteLike = NoteLike>(
  groups: readonly NoteGroup<T>[],
  vpitchOrOpts: ((p: number) => number) | PlanFingeringOptions<T> | null = null,
  beamOrOpts: number | PlanFingeringOptions<T> = BEAM,
  handArg: string | null = null,
  contextArg: readonly NoteLike[] | null = null,
  figuresArg = true,
  pianistArg: PianistLike | null = null,
  fixedArg: NoteLookup<number | null | undefined> | null = null,
  costsArg: Map<T, number> | Record<number | string, number> | null = null,
  repairArg = false,
  repairedArg: Set<unknown> | null = null,
): HybridNoteMap<T, number> {
  let vpitch: ((p: number) => number) | null = null;
  let beam = BEAM;
  let hand: string | null = handArg;
  let context: readonly NoteLike[] | null = contextArg;
  let figures = figuresArg;
  let pianist: PianistLike | null = pianistArg;
  let fixed: NoteLookup<number | null | undefined> | null = fixedArg;
  let costs: Map<T, number> | Record<number | string, number> | null = costsArg;
  let repair = repairArg;
  let repaired: Set<unknown> | null = repairedArg;

  if (typeof vpitchOrOpts === "function") {
    vpitch = vpitchOrOpts;
  } else if (vpitchOrOpts !== null && typeof vpitchOrOpts === "object") {
    vpitch = vpitchOrOpts.vpitch ?? null;
    beam = vpitchOrOpts.beam ?? BEAM;
    hand = vpitchOrOpts.hand ?? null;
    context = vpitchOrOpts.context ?? null;
    figures = vpitchOrOpts.figures ?? true;
    pianist = vpitchOrOpts.pianist ?? null;
    fixed = vpitchOrOpts.fixed ?? null;
    costs = vpitchOrOpts.costs ?? null;
    repair = vpitchOrOpts.repair ?? false;
    repaired = vpitchOrOpts.repaired ?? null;
  }

  if (typeof beamOrOpts === "number") {
    if (vpitchOrOpts === null || typeof vpitchOrOpts === "function") {
      beam = beamOrOpts;
    }
  } else if (beamOrOpts !== null && typeof beamOrOpts === "object") {
    if (beamOrOpts.vpitch !== undefined) vpitch = beamOrOpts.vpitch;
    beam = beamOrOpts.beam ?? BEAM;
    hand = beamOrOpts.hand ?? hand;
    context = beamOrOpts.context ?? context;
    figures = beamOrOpts.figures ?? figures;
    pianist = beamOrOpts.pianist ?? pianist;
    fixed = beamOrOpts.fixed ?? fixed;
    costs = beamOrOpts.costs ?? costs;
    repair = beamOrOpts.repair ?? repair;
    repaired = beamOrOpts.repaired ?? repaired;
  }

  const result = new HybridNoteMap<T, number>();
  if (groups.length === 0) {
    return result;
  }
  apply_pianist(pianist);
  const vp = vpitch ?? ((p: number) => p);
  const held_tol = W["held_tol"]!;
  const steal = W["steal"]!;
  if (hand === null) {
    hand = vpitch !== null && vpitch(60) !== 60 ? "L" : "R";
  }
  let suggest: HybridNoteMap<T, FigureSuggestion> | null = null;
  if (figures) {
    suggest = detectFigures(groups, hand, context, vp);
  }

  type HeldEntry = [number, number, number]; // [end_time, vpitch, finger]
  interface BeamEntry {
    cost: number;
    pf: number[] | null;
    held: HeldEntry[];
    bi: number | null;
    si: number | null;
  }

  let beam_: BeamEntry[] = [{ cost: 0.0, pf: null, held: [], bi: null, si: null }];
  const history: Array<Array<[number, number[], number]>> = [];
  let prev_ps: number[] | null = null;
  let prev_start: number | null = null;

  for (let gi = 0; gi < groups.length; gi++) {
    const [start, ns] = groups[gi]!;
    const ps = ns.map((n) => vp(n.pitch));
    const given: Array<number | null | undefined> = ns.map((n) =>
      fixed !== null ? lookupNote(fixed, n) : (n.finger ?? null),
    );
    const sug: Array<FigureSuggestion | undefined> = ns.map((n) =>
      suggest ? suggest.get(n) : undefined,
    );

    const chord_costs = (statesList: readonly number[][]): number[] => {
      const local: number[] = [];
      for (const st of statesList) {
        let c = 0.0;
        for (let i = 0; i < ps.length; i++) {
          c += unary_cost(ps[i]!, st[i]!);
        }
        for (let i = 0; i < st.length; i++) {
          const s_ = sug[i];
          const f = st[i]!;
          if (s_) {
            const spec = s_[0];
            const disagrees = spec instanceof Set ? !spec.has(f) : spec !== f;
            if (disagrees) {
              c += W["figure"]! * s_[1];
            }
          }
        }
        for (let k = 1; k < st.length; k++) {
          c += chord_pair_cost(bridge_from(ps, st, k - 1), st[k - 1]!, ps[k]!, st[k]!);
        }
        const zipPsSt: Array<[number, number]> = ps.map((p, i) => [p, st[i]!]);
        c += inner_room_cost(zipPsSt);
        for (let i = 0; i < st.length; i++) {
          for (let j = i + 2; j < st.length; j++) {
            const fl = st[i]!;
            const fh = st[j]!;
            if (fl < fh && key_pos(ps[j]!) - key_pos(ps[i]!) > MAX_SPAN.getPair(fl, fh)) {
              c += IMPOSSIBLE;
            }
          }
        }
        local.push(c);
      }
      return local;
    };

    let statesList = _states(given, ps);
    let local = chord_costs(statesList);
    if (
      repair &&
      ns.length > 1 &&
      given.some((g) => g !== null && g !== undefined && g !== 0) &&
      Math.min(...local) >= IMPOSSIBLE
    ) {
      const idx: number[] = [];
      for (let i = 0; i < given.length; i++) {
        if (given[i]) idx.push(i);
      }
      for (let drop = 1; drop <= idx.length; drop++) {
        let best: [number, number[][], number[]] | null = null;
        for (const out of combinations(idx, drop)) {
          const outSet = new Set(out);
          const g2 = given.map((g, i) => (outSet.has(i) ? null : g));
          const st2 = _states(g2, ps);
          const loc2 = chord_costs(st2);
          const minLoc2 = Math.min(...loc2);
          if (minLoc2 < IMPOSSIBLE && (best === null || minLoc2 < best[0])) {
            best = [minLoc2, st2, loc2];
          }
        }
        if (best) {
          statesList = best[1];
          local = best[2];
          break;
        }
      }
    }

    const dt = prev_start !== null ? start - prev_start : 1.0;
    interface Cand {
      c: number;
      bi: number;
      si: number;
      keep: boolean;
    }
    const cand: Cand[] = [];
    const trans = new Map<string, number>();

    for (let bi = 0; bi < beam_.length; bi++) {
      const { cost, pf, held } = beam_[bi]!;
      const held_now = held.filter((h) => h[0] > start + held_tol);
      const held_map = new Map<number, Set<number>>();
      for (const h of held_now) {
        let s = held_map.get(h[2]);
        if (!s) {
          s = new Set<number>();
          held_map.set(h[2], s);
        }
        s.add(h[1]);
      }

      for (let si = 0; si < statesList.length; si++) {
        const st = statesList[si]!;
        let c = cost + local[si]!;
        let keep = true;
        if (held_now.length > 0) {
          let stolenCount = 0;
          for (let i = 0; i < st.length; i++) {
            const f = st[i]!;
            const p = ps[i]!;
            const hm = held_map.get(f);
            if (hm && !hm.has(p)) {
              stolenCount += 1;
            }
          }
          c += steal * stolenCount;
          const rest: Array<[number, number]> = [];
          for (const h of held_now) {
            if (!st.includes(h[2])) {
              rest.push([h[1], h[2]]);
            }
          }
          if (rest.length > 0) {
            const zipPsSt: Array<[number, number]> = ps.map((p, i) => [p, st[i]!]);
            const combined = [...rest, ...zipPsSt];
            let sc = shape_cost(combined) - shape_cost(zipPsSt);
            if (sc > steal * rest.length) {
              sc = steal * rest.length;
              keep = false;
            }
            c += Math.max(0.0, sc);
            if (keep) {
              c += inner_room_cost(combined) - inner_room_cost(zipPsSt);
            }
          }
        }
        if (pf !== null && prev_ps !== null) {
          const tKey = `${pf.join(",")}|${st.join(",")}`;
          let tc = trans.get(tKey);
          if (tc === undefined) {
            tc = _transition(prev_ps, pf, ps, st, dt);
            trans.set(tKey, tc);
          }
          c += tc;
        }
        cand.push({ c, bi, si, keep });
      }
    }

    cand.sort((a, b) => a.c - b.c);
    const nextBeam: BeamEntry[] = [];
    const seen = new Set<string>();
    for (const { c, bi, si, keep } of cand) {
      const { held } = beam_[bi]!;
      const st = statesList[si]!;
      const held_now = keep
        ? held.filter((h) => h[0] > start + held_tol && !st.includes(h[2]))
        : [];
      const sortedHeld = held_now
        .map((h) => [h[2], h[1]] as [number, number])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const key = `${st.join(",")}|${sortedHeld.map((x) => `${x[0]}:${x[1]}`).join(",")}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const nh: HeldEntry[] = [
        ...held_now,
        ...ns.map((n, idx) => [n.end, ps[idx]!, st[idx]!] as HeldEntry),
      ];
      nextBeam.push({ cost: c, pf: st, held: nh, bi, si });
      if (nextBeam.length >= beam) {
        break;
      }
    }
    history.push(nextBeam.map((e) => [e.bi!, e.pf!, e.cost]));
    beam_ = nextBeam;
    prev_ps = ps;
    prev_start = start;
  }

  let j = 0;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const [bi, st, c] = history[gi]![j]!;
    const ns = groups[gi]![1];
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i]!;
      const f = st[i]!;
      result.setNote(n, f);
      if (repaired !== null) {
        const g = fixed !== null ? lookupNote(fixed, n) : (n.finger ?? null);
        if (g && g !== f) {
          addRepairedNote(repaired, n);
        }
      }
    }
    if (costs !== null) {
      const prev = gi > 0 ? history[gi - 1]![bi]![2] : 0.0;
      const chordCost = Math.max(0.0, c - prev);
      for (const n of ns) {
        setNoteInSink(costs, n, chordCost);
      }
    }
    j = bi;
  }
  return result;
}
export const planFingering = plan_fingering;

export interface FingerHandOptions {
  left?: boolean;
  beam?: number;
  context?: readonly NoteLike[] | null;
  pianist?: PianistLike | null;
}

export function finger_hand<T extends NoteLike = NoteLike>(
  notes: readonly T[],
  leftOrOpts: boolean | FingerHandOptions = false,
  beamArg = BEAM,
  contextArg: readonly NoteLike[] | null = null,
  pianistArg: PianistLike | null = null,
): HybridNoteMap<T, number> {
  let left = false;
  let beam = beamArg;
  let context = contextArg;
  let pianist = pianistArg;
  if (typeof leftOrOpts === "boolean") {
    left = leftOrOpts;
  } else if (leftOrOpts !== null && typeof leftOrOpts === "object") {
    left = leftOrOpts.left ?? false;
    beam = leftOrOpts.beam ?? BEAM;
    context = leftOrOpts.context ?? null;
    pianist = leftOrOpts.pianist ?? null;
  }
  const vp = left ? mirror_pitch : null;
  return plan_fingering(group_notes(notes, vp), vp, beam, left ? "L" : "R", context, true, pianist);
}
export const fingerHand = finger_hand;

export interface ScoreFingeringOptions {
  vpitch?: ((p: number) => number) | null;
  hand?: string | null;
  context?: readonly NoteLike[] | null;
  pianist?: PianistLike | null;
}

export function score_fingering<T extends NoteLike = NoteLike>(
  groups: readonly NoteGroup<T>[],
  fingering: NoteLookup<number | null | undefined>,
  vpitchOrOpts: ((p: number) => number) | ScoreFingeringOptions | null = null,
  handArg: string | null = null,
  contextArg: readonly NoteLike[] | null = null,
  pianistArg: PianistLike | null = null,
): HybridNoteMap<T, number> {
  let vpitch: ((p: number) => number) | null = null;
  let hand = handArg;
  let context = contextArg;
  let pianist = pianistArg;
  if (typeof vpitchOrOpts === "function") {
    vpitch = vpitchOrOpts;
  } else if (vpitchOrOpts !== null && typeof vpitchOrOpts === "object") {
    vpitch = vpitchOrOpts.vpitch ?? null;
    hand = vpitchOrOpts.hand ?? null;
    context = vpitchOrOpts.context ?? null;
    pianist = vpitchOrOpts.pianist ?? null;
  }
  const costs = new HybridNoteMap<T, number>();
  plan_fingering(groups, vpitch, 4, hand, context, false, pianist, fingering, costs);
  return costs;
}
export const scoreFingering = score_fingering;
