/**
 * hands.ts - Procedural hand skeletons for Hand-thesia (both hands).
 *
 * Ported 1-to-1 from python-core/handthesia_core/hands.py.
 */

// @ts-nocheck
import { pyMod, pyRound, rounded, bisectLeft, bisectRight, pyGet, pyItems, pyValues, pyKeys, pyPop, pyClear, getattr, hasattr, pyIn, pyIter, bool, ValueError, KeyError, IndexError, pyUpdate, frozenset, next, map, iter, pyAugAdd, pyBitOr, pyBitAnd, pySetUnion, reversed, zip, enumerate, pySorted, pyRange, tuple, list, pySetDefault, pyMin, pyMax, min, max, pyEq, pyNotEq, pyAdd, pyMult, pyLen, pyCmp } from "./pythonCompat.ts";
import * as midi_loader from "./midiLoader.ts";
import { LEFT, RIGHT, is_black_key, Note, MidiSong } from "./midiLoader.ts";
import * as progress from "./progress.ts";
import { KEY_LEN_WW, KeyboardGeometry, NumericRect } from "./geometry.ts";
import { group_notes, is_crossing, key_pos, mirror_pitch, plan_fingering, double_ok, MAX_SPAN } from "./fingering.ts";
import type { Pianist } from "./pianist.ts";
import { DEFAULT_ANATOMY, WRIST, clamp_wrist } from "./pianist.ts";
import * as pianist_module from "./pianist.ts";
import * as glissando_module from "./glissando.ts";
import * as fingering_module from "./fingering.ts";

const pianists = pianist_module;
const glissando = glissando_module;
const fg = fingering_module;

// Runtime identity helpers
let _nextObjId = 1;
const _objIdMap = new WeakMap<object, number>();
export function pyId(obj: any): number {
  if (obj === null || obj === undefined || typeof obj !== 'object') return 0;
  let id = _objIdMap.get(obj);
  if (id === undefined) {
    id = _nextObjId++;
    _objIdMap.set(obj, id);
  }
  return id;
}

// 
// hands.py - Procedural hand skeletons for Hand-thesia (both hands).
// 
// The model is a right hand. The left hand is the same model on a mirrored
// keyboard: pitches are reflected about D4 (the keyboard is symmetric there),
// planned and posed as a right hand, and the finished skeleton is flipped back.
// 
// How it works
//   1. fingering.plan_fingering() picks a finger (1 = thumb ... 5 = little
//      finger) for every note that the file doesn't already finger: standard
//      fingerings for recognised figures (scales, arpeggios, octaves, thirds...,
//      see figures.py), a pianist's cost model and physical limits (hand span,
//      held keys, speed of shifts), searched over the whole piece.
//   2. HandAnimator.pose(t, keyboard) builds a 3D skeleton for time t:
//        - the palm is rigid; its position AND turn are solved for every
//          moment from the keys around it: keys being pressed must be reachable,
//          keys the fingers are heading for pull the hand toward them, keys just
//          let go of fade out. A finger that would need more splay than its
//          joint allows turns the hand at the wrist first (within the wrist's
//          range) and slides it second. The motion is smoothed over a short
//          window, so shifts accelerate and settle;
//        - every fingertip follows its own timeline: press, lift, travel to its
//          next key as soon as it is free (arriving early and hovering), strike.
//          Idle fingers fan out between their busy neighbours, so the whole
//          hand keeps changing shape with the notes;
//        - each fingertip is kept inside its finger's splay and reach range,
//          then solved with planar inverse kinematics. Fingers 2-5 flex downward
//          (DIP joint coupled to PIP), so seen from above their segments
//          accordion in and out as they curl. The thumb flexes on its side, so
//          its bend shows as a sideways curl.
//   3. draw_hands() projects the skeleton straight down onto the screen and draws
//      black bone segments, lowest bones first so crossings overlap correctly.
// 
// World coordinates used for posing are pixels:
//     X = screen x,  Y = distance up the screen from the keyboard's front edge,
//     Z = height above the key surface.
// Scale comes from the drawn keyboard (6.5 in per octave) and the hand is sized
// so a firm, comfortable thumb-to-little-finger stretch spans a 9th (C to the D
// an octave up); that makes it about 7.6 in from wrist to middle fingertip.
export let OCTAVE_IN: any = 6.5;
export let WHITE_KEY_IN: any = (OCTAVE_IN / 7.0);
export let HAND_SPAN_IN: any = pyMult(8, WHITE_KEY_IN);
export let KEY_TRAVEL_IN: any = 0.4;
export let WHITE_DEPTH_IN: any = { [1]: 0.35, [2]: 1.7, [3]: 1.95, [4]: 1.8, [5]: 0.9 };
export let BOUNCE_MAX_IN: any = 1.2;
export let ROLL_MAX_DEG: any = 40.0;
export let GESTURE_REPEAT_T: any = 0.45;
export let GESTURE_KEY_UP_T: any = 0.04;
export let GESTURE_TREMOLO_T: any = 0.3;
export let BLACK_DEPTH_IN: any = 0.35;
export let WHITE_SPAN_IN: any = [0.3, 0.45];
export let BLACK_SPAN_IN: any = [0.25, 1.6];
export let WHITE_UP_IN: any = 0.2;
export let VEL_SOFT: any = 50;
export let VEL_LOUD: any = 110;
export let LOUD_MARGIN_IN: any = [0.25, 0.8];
export let WHITE_UP_T: any = 0.3;
export let WHITE_UP_FADE_T: any = 0.6;
export let WRIST_Z: any = 3.4;
export let KNUCKLE_Z: any = 4.2;
export let WRIST_SIDES: any = [[(-2.2), 0.0, WRIST_Z], [2.2, 0.0, WRIST_Z]];
export let THUMB_CMC: any = [(-2.5), 1.6, (WRIST_Z - 0.7)];
export let MC_BASE: any = { [2]: [(-1.4), 1.9, pyAdd(WRIST_Z, 0.5)], [3]: [(-0.3), 2.0, pyAdd(WRIST_Z, 0.6)], [4]: [0.9, 1.8, pyAdd(WRIST_Z, 0.5)], [5]: [1.9, 1.4, pyAdd(WRIST_Z, 0.3)] };
export let MCP: any = { [2]: [(-2.9), 8.4, pyAdd(KNUCKLE_Z, 0.1)], [3]: [(-0.7), 8.6, pyAdd(KNUCKLE_Z, 0.3)], [4]: [1.4, 8.1, pyAdd(KNUCKLE_Z, 0.1)], [5]: [3.3, 7.2, (KNUCKLE_Z - 0.3)] };
export let BONES: any = { [1]: [4.7, 3.3, 2.8], [2]: [4.0, 2.3, 1.8], [3]: [4.5, 2.7, 1.9], [4]: [4.2, 2.6, 1.9], [5]: [3.3, 1.8, 1.7] };
export let _THUMB_MAX_ABD: any = ((72) * Math.PI / 180.0);
export let _PINKY_MAX_ABD: any = ((45) * Math.PI / 180.0);
export let HOVER: any = { [1]: 0.9, [2]: 1.4, [3]: 1.4, [4]: 1.4, [5]: 1.4 };
export let TENDON_FOLLOWERS: any = { [3]: [4], [4]: [3], [5]: [3, 4] };
export let TENDON_FLOOR_IN: any = 0.15;
export let THUMB_BRIDGE_LIFT_IN: any = 0.05;
export let THUMB_BRIDGE_DEPTH_IN: any = 1.4;
export let THUMB_BRIDGE_NEAR_IN: any = 0.3;
export let PREP: any = { [1]: 1.3, [2]: 2.6, [3]: 2.6, [4]: 2.6, [5]: 2.4 };
export let FINGER_COUPLING: any = 0.6;
export let FINGER_BEND_MAX: any = 1.7;
export let FINGER_LIFT_MAX: any = ((40) * Math.PI / 180.0);
export let STEEP_FORWARD: any = [0.5, 0.85, 2.0, 0.12];
export let TIP_BELOW_KNUCKLE: any = 0.12;
export let THUMB_COUPLING: any = 0.85;
export let THUMB_BEND_MAX: any = 1.2;
export let PRESS_T: any = 0.035;
export let RELEASE_T: any = 0.12;
export let STRIKE_T: any = 0.12;
export let LINGER_T: any = 0.06;
export let RETURN_T: any = 0.35;
export let FIT_WEIGHT: any = { [1]: 0.35, [2]: 1.0, [3]: 1.0, [4]: 1.0, [5]: 1.6 };
export let LEGATO_STEP_WK: any = 2.5;
export let LEGATO_LIFT_T: any = 0.03;
export let JUMP_WK: any = 6.0;
export let HAND_MOVE_TOL_WK: any = 0.25;
export let MIN_HOLD_T: any = 0.04;
export let STRIKE_MIN_T: any = 0.03;
export let MAX_DELAY_T: any = 0.25;
export let CROSS_LIFT_T: any = 0.07;
export let SPLAY_LIMIT_DEG: any = { [1]: [(-85), 34], [2]: [(-36), 14], [3]: [(-26), 26], [4]: [(-22), 24], [5]: [(-12), 55] };
export let SPLAY_COMFORT_DEG: any = { [1]: [(-64), 34], [2]: [(-24), 10], [3]: [(-18), 18], [4]: [(-15), 16], [5]: [(-8), 24] };
export let PRESS_SLACK_DEG: any = { [1]: 6, [2]: 6, [3]: 6, [4]: 6, [5]: 3 };
export let REACH_MIN: any = { [1]: 0.55, [2]: 0.32, [3]: 0.32, [4]: 0.32, [5]: 0.36 };
export let REACH_COMFORT: any = { [1]: 0.97, [2]: 0.98, [3]: 0.98, [4]: 0.98, [5]: 0.98 };
export let WRIST_DEV_DEG: any = [(-26), 8];
export let YAW_PRIOR: any = 0.25;
export let CROSS_TURN_DEG: any = 14;
export let CROSS_PRIOR: any = 4.0;
export let SOFT_K: any = 1.0;
export let LIMIT_K: any = 400.0;
export let GN_ITERS: any = 8;
export let GN_DAMPING: any = 0.05;
export let HAND_GRID_T: any = (1 / 120);
export let RELEASE_HOLD_T: any = 0.25;
export let ANTIC_HELD: any = 0.3;
export let RELEASE_NEED_T: any = 0.08;
export let RELEASE_NEED: any = 1.0;
export let VOTE_POWER: any = 16;
export let IDLE_W: any = 0.05;
export let IDLE_AFTER_T: any = 0.35;
export let IDLE_RAMP_T: any = 0.5;
export let IDLE_BEFORE_T: any = 1.1;
export let IDLE_READY_T: any = 0.35;
export let IDLE_CLEAR_SPAN: any = 0.8;
export let IDLE_FAR_SPAN: any = 1.5;
export let IDLE_TRAIL_T: any = 1.2;
export let IDLE_LOOK_T: any = 0.5;
export let IDLE_DRIFT_IN: any = 6.0;
export let IDLE_MEMORY_T: any = 8.0;
export let IDLE_TICK_T: any = 0.1;
export let IDLE_EDGE_IN: any = 1.5;
export let IDLE_GRID_T: any = (1 / 30);
export let IDLE_SMOOTH_T: any = 0.25;
export let KEY_FIX_T: any = 0.12;
export let KEY_FIX_RELEASE_T: any = 0.05;
export let KEY_FIX_K: any = 12.0;
export let ROLL_TURN_DEG: any = [(-40), 20];
export let ROLL_DEPTH_IN: any = 1.6;
export let ROLL_PLAN_SLACK_WK: any = 0.75;
export let ROLL_SUSPECT_WK: any = 0.4;
export let ROLL_MISS_WK: any = { [false]: 0.45, [true]: 0.22 };
export let ROLL_DEPTH_SLACK_WK: any = 0.15;
export let ROLL_FIT_WW: any = 30;
export let THUMB_BRIDGE_FIX_K: any = 0.15;
export let KEY_FIX_MARGIN_DEG: any = 1.0;
export let KEY_FIX_MARGIN: any = 0.02;
export let KEY_FIX_ITERS: any = 6;
export let KEY_SPOT_FIRM: any = [20.0, 0.03];
export let KEY_SPOT_SOFT: any = [4.0, 0.12];
export let TIP_ARM_IN: any = 7.0;
export let LIMIT_RESTART_T: any = 0.5;
export let LIMIT_GRID_T: any = (1 / 60);
export let LIMIT_SMOOTH_HAND: any = 3;
export let LIMIT_SMOOTH_HAND_ON: any = 1;
export let LIMIT_SMOOTH_TIPS: any = 3;
export let RUN_MIN_NOTES: any = 7;
export let RUN_GAP_T: any = 0.3;
export let RUN_RAMP_T: any = 0.15;
export let RUN_GLIDE_T: any = 0.25;
export let RUN_TURN_STIFF: any = 3.0;
export let TREM_MIN_NOTES: any = 6;
export let TREM_PERIOD: any = 4;
export let TREM_GAP_T: any = 0.3;
export let TREM_JUMP: any = 4;
export let TREM_REACH_EXTRA: any = 1.25;
export let TREM_HOLD_T: any = 0.5;
export let RUN_COMPRESS_DEG: any = { [1]: [0, 0], [2]: [0, 10], [3]: [6, 6], [4]: [8, 0], [5]: [10, 0] };
export let GLISS_RAMP_T: any = 0.15;
export let GLISS_SPEED_SHARE: any = 0.9;
export let GLISS_EASE_PEAK: any = 1.5;
export let GLISS_YAW_DEG: any = 70.0;
export let GLISS_ARM_SHARE: any = 0.6;
export let GLISS_ROLL_DEG: any = 180.0;
export let GLISS_PITCH_DEG: any = 8.0;
export let GLISS_SQUEEZE: any = 0.8;
export let GLISS_FINGER_DIR: any = [0.0, 1.0, (-0.12)];
export let GLISS_THUMB_TIP: any = [1.8, (-1.4), (-2.6)];
export let GLISS_CURL: any = [0.0, 1.4, (-3.6)];
export let GLISS_THUMB_DIR: any = [(-0.18), 1.0, (-0.3)];
export let GLISS_THUMB_PITCH_DEG: any = 4.0;
export let GLISS_WHITE_IN: any = 0.8;
export let GLISS_BLACK_IN: any = 0.5;
export let GLISS_TRAVEL_ACC: any = 40.0;
export let GLISS_TRAVEL_DT: any = (1 / 120);
export let GLISS_TRAVEL_MAX_T: any = 3.0;
export let WARM_AHEAD_T: any = 3.5;
export let GLISS_ARRIVE_T: any = 0.03;
export let GLISS_THUMB_ARM_DEG: any = 18.0;
export let GLISS_THUMB_IN: any = 2.0;
export let GLISS_FIST_CLEAR: any = 0.45;
export let FLAT_SPAN_WK: any = [4.5, 6.5];
export let FLAT_DROP: any = 0.6;
export let TIP_GAP_WK: any = 0.6;
export let TIP_GAP_MIN_WK: any = 0.4;
export let PREP_LOOKBACK_T: any = 2.0;
export let SHAPE_FALLOFF: any = 0.6;
export function _model_span(): any {
  let px: any, py: any, tx: any, ty: any;
  tx = (THUMB_CMC[0] - pyMult((BONES[1]).reduce((a: any, b: any) => a + b, 0), Math.sin(_THUMB_MAX_ABD)));
  ty = pyAdd(THUMB_CMC[1], pyMult((BONES[1]).reduce((a: any, b: any) => a + b, 0), Math.cos(_THUMB_MAX_ABD)));
  px = pyAdd(MCP[5][0], pyMult((BONES[5]).reduce((a: any, b: any) => a + b, 0), Math.sin(_PINKY_MAX_ABD)));
  py = pyAdd(MCP[5][1], pyMult((BONES[5]).reduce((a: any, b: any) => a + b, 0), Math.cos(_PINKY_MAX_ABD)));
  return Math.hypot((px - tx), (py - ty));
}
export let INCHES_PER_UNIT: any = (HAND_SPAN_IN / _model_span());
export function _add(a: any = null, b: any = null): any {
  return [pyAdd(a[0], b[0]), pyAdd(a[1], b[1]), pyAdd(a[2], b[2])];
}
export function _sub(a: any = null, b: any = null): any {
  return [(a[0] - b[0]), (a[1] - b[1]), (a[2] - b[2])];
}
export function _mul(a: any = null, s: any = null): any {
  return [pyMult(a[0], s), pyMult(a[1], s), pyMult(a[2], s)];
}
export function _dot(a: any = null, b: any = null): any {
  return pyAdd(pyAdd(pyMult(a[0], b[0]), pyMult(a[1], b[1])), pyMult(a[2], b[2]));
}
export function _norm(a: any = null): any {
  return Math.sqrt(_dot(a, a));
}
export function _lerp(a: any = null, b: any = null, s: any = null): any {
  return pyAdd(a, pyMult((b - a), s));
}
export function _gram(cols: any = null): any {
  let a00: any, a01: any, a02: any, a11: any, a12: any, a22: any;
  // J^T J for the three Jacobian columns (symmetric: each entry summed once).
  [a00, a01, a02] = [(map(((a: number, b: number) => a * b), cols[0], cols[0])).reduce((a: any, b: any) => a + b, 0), (map(((a: number, b: number) => a * b), cols[0], cols[1])).reduce((a: any, b: any) => a + b, 0), (map(((a: number, b: number) => a * b), cols[0], cols[2])).reduce((a: any, b: any) => a + b, 0)];
  [a11, a12, a22] = [(map(((a: number, b: number) => a * b), cols[1], cols[1])).reduce((a: any, b: any) => a + b, 0), (map(((a: number, b: number) => a * b), cols[1], cols[2])).reduce((a: any, b: any) => a + b, 0), (map(((a: number, b: number) => a * b), cols[2], cols[2])).reduce((a: any, b: any) => a + b, 0)];
  return [[a00, a01, a02], [a01, a11, a12], [a02, a12, a22]];
}
export function _clamp_apply(prep: any = null, x: any = null, y: any = null): any {
  let a: any, ac: any, bx: any, by: any, cn: any, cp: any, dx: any, dy: any, h: any, hi: any, hmax: any, hmin: any, lo: any, lx: any, ly: any, sn: any, sp: any, ux: any, uy: any;
  // _clamp_tip's clamp, from _clamp_prep's (base, rotations, splay and reach limits).
  [bx, by, cn, sn, cp, sp, lo, hi, hmin, hmax] = prep;
  [dx, dy] = [(x - bx), (y - by)];
  [lx, ly] = [(pyMult(dx, cn) - pyMult(dy, sn)), pyAdd(pyMult(dx, sn), pyMult(dy, cn))];
  [a, h] = [Math.atan2(lx, ly), Math.hypot(lx, ly)];
  ac = ((a < lo) ? lo : ((a > hi) ? hi : a));
  if ((pyNotEq(ac, a))) {
    h *= pyMax(0.0, Math.cos((a - ac)));
  }
  a = ac;
  h = ((h < hmin) ? hmin : ((h > hmax) ? hmax : h));
  [ux, uy] = [pyMult(h, Math.sin(a)), pyMult(h, Math.cos(a))];
  return [pyAdd(bx, (pyMult(ux, cp) - pyMult(uy, sp))), pyAdd(by, pyAdd(pyMult(ux, sp), pyMult(uy, cp)))];
}
export function _shift_pose(p: any = null, dx: any = null, dy: any = null, mirror: any = null): any {
  let out: any, psi: any, sh: any, st: any, wx: any, wy: any;
  // Pose p moved by (dx, dy) on screen (its working-frame wrist the other way round when mirrored).
  sh = ((q) => pyAdd([pyAdd(q[0], dx), pyAdd(q[1], dy)], [...q.slice(2)]));
  out = { ...p };
  out['bones'] = Array.from(pyIter(p['bones'])).map(([a, b, k]: any) => [sh(a), sh(b), k]);
  out['joints'] = Array.from(pyIter(p['joints'])).map(([q, k]: any) => [sh(q), k]);
  st = { ...p['struct'] };
  st['chains'] = Object.fromEntries(Array.from(pyIter(pyItems(st['chains']))).map(([f, c]: any) => [f, Array.from(pyIter(c)).map((q: any) => sh(q))]));
  st['wrist'] = [...Array.from(pyIter(st['wrist'])).map((q: any) => sh(q))];
  st['arm_end'] = sh(st['arm_end']);
  out['struct'] = st;
  [wx, wy, psi] = p['wrist'];
  out['wrist'] = [pyAdd(wx, (bool(mirror) ? (-dx) : dx)), pyAdd(wy, dy), psi];
  return out;
}
export function _lerp3(a: any = null, b: any = null, s: any = null): any {
  return [...Array.from(pyIter(zip(a, b))).map(([x, y]: any) => _lerp(x, y, s))];
}
export function _smooth(x: any = null): any {
  x = pyMin(1.0, pyMax(0.0, x));
  return pyMult(pyMult(pyMult(x, x), x), pyAdd(pyMult(x, (pyMult(x, 6) - 15)), 10));
}
export function loudness(velocity: any = null): any {
  // 0 (soft, VEL_SOFT and below) .. 1 (loud, VEL_LOUD and above).
  return pyMin(1.0, pyMax(0.0, ((velocity - VEL_SOFT) / (VEL_LOUD - VEL_SOFT))));
}
export function busy_spans(intervals: any = null): any {
  let a: any, b: any, out: any;
  // Sorted, merged (start, end) spans in which a hand is holding keys.
  out = [];
  for ([a, b] of pyIter(pySorted(intervals, null, false))) {
    if ((bool(out) && ((a <= out[out.length - 1][1])))) {
      out[out.length - 1] = [out[out.length - 1][0], pyMax(out[out.length - 1][1], b)];
    } else {
      out.push([a, b]);
    }
  }
  return out;
}
export function idle_weight(spans: any = null, starts: any = null, t: any = null): any {
  let a: any, b: any, i: any, last: any, nxt: any;
  // 
  //     0..1 how idle a hand is at t: 0 while it holds a key or is about to play
  //     (from IDLE_READY_T before its next note), 1 once it has been free for
  //     IDLE_AFTER_T + IDLE_RAMP_T and has nothing coming within IDLE_BEFORE_T.
  //     `starts` is [s for s, _ in spans].
  //     
  i = (bisectRight(starts, t) - 1);
  if ((((i >= 0)) && ((t < spans[i][1])))) {
    return 0.0;
  }
  last = ((i >= 0) ? spans[i][1] : (-Infinity));
  nxt = ((pyAdd(i, 1) < (spans).length) ? spans[pyAdd(i, 1)][0] : Infinity);
  a = _smooth((((t - last) - IDLE_AFTER_T) / IDLE_RAMP_T));
  b = _smooth((((nxt - t) - IDLE_READY_T) / (IDLE_BEFORE_T - IDLE_READY_T)));
  return pyMult(a, b);
}
export function prepare_hands(animators: any = null, t: any = null, kb: any = null, budget: any = null): any {
  let a: any, anims: any, end: any, i: any, left: any;
  // Share `budget` seconds of a frame's spare time among the hands' work ahead (HandAnimator.prepare).
  anims = [...animators];
  end = pyAdd(time.perf_counter(), budget);
  for ([i, a] of pyIter(enumerate(anims))) {
    left = (end - time.perf_counter());
    if ((left <= 0)) {
      break;
    }
    a.prepare(t, kb, (left / ((anims).length - i)));
  }
}
export function build_hands(song: any = null, kw: any = {}): any {
  let counts: any, done: any, h: any, out: any, total: any;
  // {hand: HandAnimator} for each hand that has notes, paired (pair_hands); `kw` goes to each animator.
  counts = Object.fromEntries(Array.from(pyIter([RIGHT, LEFT])).map((h: any) => [h, (Array.from(pyIter(song.notes)).filter((n: any) => (pyEq(n.hand, h))).map((n: any) => 1)).reduce((a: any, b: any) => a + b, 0)]));
  total = (bool((pyValues(counts)).reduce((a: any, b: any) => a + b, 0)) ? ((pyValues(counts)).reduce((a: any, b: any) => a + b, 0)) : (1));
  [out, done] = [{  }, 0];
  for (h of pyIter([RIGHT, LEFT])) {
    if (bool(counts[h])) {
      out[h] = new HandAnimator(song, h, kw);
      done = pyAugAdd(done, counts[h]);
    }
  }
  pair_hands(pyValues(out));
  return out;
}
export function load_with_hands(path_or_song: any = null, kw: any = {}): any {
  let song: any;
  // (song, hands.build_hands(song, **kw)) for a MIDI/PIG path or a song; reports progress (progress.py).
  song = path_or_song;
  if (bool((typeof path_or_song === 'string'))) {
    song = midi_loader.load_song(path_or_song);
  }
  return [song, build_hands(song, kw)];
}
export function pair_hands(animators: any = null): any {
  let a: any, anims: any;
  // Let two hands (HandAnimators) know about each other, so an idle one keeps out of the other's way.
  anims = [...animators];
  for (a of pyIter(anims)) {
    a.partner = next(Array.from(pyIter(anims)).filter((b: any) => (((b !== a)) && ((pyNotEq(b.hand, a.hand))))).map((b: any) => b), null);
    [a._idle_cache, a._clear_cache, a._path_cache] = [{  }, {  }, {  }];
    [a._limit_cache, a._tip_limit_cache] = [{  }, {  }];
    [a._smooth_hand_cache, a._smooth_tip_cache] = [{  }, {  }];
  }
}
export function _blend_pose(a: any = null, b: any = null, w: any = null): any {
  let L: any, out: any, sa: any, sb: any;
  // Pose a moved toward pose b by w (0..1): every point of the skeleton, the wrist and the hand's structure.
  L = ((p, q) => [...Array.from(pyIter(zip(p, q))).map(([x, y]: any) => pyAdd(x, pyMult((y - x), w)))]);
  out = { ...a };
  out['bones'] = Array.from(pyIter(zip(a['bones'], b['bones']))).map(([[p, q, k], [p2, q2, _0]]: any) => [L(p, p2), L(q, q2), k]);
  out['joints'] = Array.from(pyIter(zip(a['joints'], b['joints']))).map(([[p, k], [p2, _0]]: any) => [L(p, p2), k]);
  out['wrist'] = L(a['wrist'], b['wrist']);
  [sa, sb] = [a['struct'], b['struct']];
  out['struct'] = { ['chains']: Object.fromEntries(Array.from(pyIter(sa['chains'])).map((f: any) => [f, Array.from(pyIter(zip(sa['chains'][f], sb['chains'][f]))).map(([p, q]: any) => L(p, q))])), ['wrist']: [...Array.from(pyIter(zip(sa['wrist'], sb['wrist']))).map(([p, q]: any) => L(p, q))], ['arm_end']: L(sa['arm_end'], sb['arm_end']), ['mirror']: sa['mirror'], ['nail_hide']: [...pySorted(pyBitOr(new Set(pyGet(sa, 'nail_hide', [])), ((w > 0.33) ? new Set(pyGet(sb, 'nail_hide', [])) : new Set())), null, false)], ['palm_up']: pyGet(((w > 0.5) ? sb : sa), 'palm_up', false), ['flush']: _lerp(pyGet(sa, 'flush', 0.0), pyGet(sb, 'flush', 0.0), w), ['thumb_edge']: _lerp(pyGet(sa, 'thumb_edge', 0.0), pyGet(sb, 'thumb_edge', 0.0), w) };
  return out;
}
export function _ease_out(x: any = null): any {
  x = pyMin(1.0, pyMax(0.0, x));
  return (1 - pyMult((1 - x), (1 - x)));
}
export class HandGeometry {
  [key: string]: any;
  // 
  //     The hand model with a pianist's anatomy (pianist.DEFAULT_ANATOMY ids ->
  //     lengths in model units). The wrist and the bases of the metacarpals stay
  //     where they are; each knuckle moves along its metacarpal to match its
  //     length, and the phalanges take their lengths directly.
  //     
  constructor(anatomy: any = null) {
    let a: any, d: any, f: any;

    a = { ...DEFAULT_ANATOMY };
    pyUpdate(a, (bool(anatomy) ? (anatomy) : ({  })));
    this.anatomy = a;
    this.thumb_cmc = THUMB_CMC;
    this.mc_base = MC_BASE;

    this.wrist_scale = clamp_wrist(pyGet(a, WRIST, 1.0));
    this.wrist_sides = [...Array.from(pyIter(WRIST_SIDES)).map(([x, y, z]: any) => [pyMult(x, this.wrist_scale), y, z])];
    this.mcp = {  };
    for (f = 2; f < 6; f += 1) {
      d = _sub(MCP[f], MC_BASE[f]);
      this.mcp[f] = _add(MC_BASE[f], _mul(d, (a[`mc${f}`] / _norm(d))));
    }
    this.bones = { [1]: [a['mc1'], a['pp1'], a['dp1']] };
    for (f = 2; f < 6; f += 1) {
      this.bones[f] = [a[`pp${f}`], a[`mp${f}`], a[`dp${f}`]];
    }
    this.rest_reach = (pyMult(4.2, (this.bones[3]).reduce((a: any, b: any) => a + b, 0)) / (BONES[3]).reduce((a: any, b: any) => a + b, 0));
  }
  base(f: any = null): any {
    return ((pyEq(f, 1)) ? this.thumb_cmc : this.mcp[f]);
  }
  span_units(): any {
    let px: any, py: any, tx: any, ty: any;
    // Comfortable thumb-to-little-finger stretch (the 9th of the default hand).
    tx = (THUMB_CMC[0] - pyMult((this.bones[1]).reduce((a: any, b: any) => a + b, 0), Math.sin(_THUMB_MAX_ABD)));
    ty = pyAdd(THUMB_CMC[1], pyMult((this.bones[1]).reduce((a: any, b: any) => a + b, 0), Math.cos(_THUMB_MAX_ABD)));
    px = pyAdd(this.mcp[5][0], pyMult((this.bones[5]).reduce((a: any, b: any) => a + b, 0), Math.sin(_PINKY_MAX_ABD)));
    py = pyAdd(this.mcp[5][1], pyMult((this.bones[5]).reduce((a: any, b: any) => a + b, 0), Math.cos(_PINKY_MAX_ABD)));
    return Math.hypot((px - tx), (py - ty));
  }
  pair_reach(a: any = null, b: any = null): any {
    let ax: any, ay: any, bx: any, by: any;
    // How far apart fingertips a < b can comfortably get (model units, flat hand).
    const tip = (f: any = null, outward: any = null): any => {
      let L: any, _: any, ang: any, bx: any, by: any, hi: any, lo: any;
      if ((pyEq(f, 1))) {
        ang = (-_THUMB_MAX_ABD);
      } else {
        if ((((pyEq(f, 5))) && bool(outward))) {
          ang = _PINKY_MAX_ABD;
        } else {
          [lo, hi] = SPLAY_LIMIT_DEG[f];
          ang = (((bool(outward) ? hi : lo)) * Math.PI / 180.0);
        }
      }
      L = pyMult((this.bones[f]).reduce((a: any, b: any) => a + b, 0), REACH_COMFORT[f]);
      [bx, by, _] = this.base(f);
      return [pyAdd(bx, pyMult(L, Math.sin(ang))), pyAdd(by, pyMult(L, Math.cos(ang)))];
    };
    [[ax, ay], [bx, by]] = [tip(a, false), tip(b, true)];
    return Math.hypot((bx - ax), (by - ay));
  }
}
export function curl_factor(pianist: any = null): any {
  let c: any;
  // 
  //     How far in front of the knuckles the fingertips sit, relative to the
  //     original model, from the pianist's "Finger curvature". Sampled from the
  //     author's hand playing scales (video, 2026-10-03): at the default 40% a
  //     pressed middle fingertip is 2.4 in in front of its knuckle and 1.8 in
  //     below it - the first phalanx sloping down ~25 deg, the middle ~45, the
  //     last ~55, a long, gently arched finger. 100% is the original, curved
  //     model (1.0); 0% nearly straight (2.16).
  //     
  c = ((pianist !== null) ? pianist.b('finger_curve') : 0.4);
  return pyAdd(1.0, pyMult(1.16, (1.0 - c)));
}
export function hand_span_inches(anatomy: any = null): any {
  return pyMult(new HandGeometry(anatomy).span_units(), INCHES_PER_UNIT);
}
export let _REACH_CACHE: any = {  };
export function reach_scale(anatomy: any = null): any {
  let g: any, g0: any, got: any, key: any;
  // {(a, b): this hand's reach between fingers a and b / the default hand's}.
  key = [...pySorted(pyItems((bool(anatomy) ? (anatomy) : ({  }))), null, false)];
  got = pyGet(_REACH_CACHE, key, null);
  if ((got === null)) {
    [g, g0] = [new HandGeometry(anatomy), new HandGeometry()];
    got = Object.fromEntries(Array.from(pyIter(pyRange(1, 6))).flatMap((a: any) => Array.from(pyIter(pyRange(pyAdd(a, 1), 6))).map((b: any) => [[a, b], (g.pair_reach(a, b) / g0.pair_reach(a, b))])));
    _REACH_CACHE[key] = got;
  }
  return got;
}
export function solve_chain(base: any = null, target: any = null, lengths: any = null, bulge: any = null, coupling: any = null, bend_max: any = null, lift_max: any = null, forward: any = null): any {
  let L: any, L1: any, L2: any, L3: any, _: any, acc: any, ang: any, b: any, bend: any, d: any, e1: any, e2: any, hi: any, hl: any, hx: any, hy: any, k: any, lean: any, lo: any, mid: any, n: any, off: any, out: any, p: any, pts: any, q: any, r: any, side: any, span: any, steep: any, total: any, ux: any, uy: any, w: any, x: any, y: any;
  // 
  //     Three-bone planar chain from `base` toward `target`.
  // 
  //     The chain lies in the plane containing base->target and the `bulge`
  //     direction, and its joints bow out toward `bulge` (for a finger that's up,
  //     so the knuckles arch while the tip curls down). Joint 2 bends by b and
  //     joint 3 by coupling*b; b is found so the tip lands on the target. Returns
  //     [base, joint1, joint2, tip]. Out-of-reach targets give a straight chain
  //     pointing at the target.
  // 
  //     lift_max (rad): the first bone rises at most this steeply above the
  //     horizontal - a target close in would otherwise fold the chain back on
  //     itself with the knuckle reared up (_lower_knuckle).
  // 
  //     forward (horizontal unit vector, the hand's forward; with an upward
  //     bulge, a finger): the chain stays in a vertical plane - seen from above
  //     a finger never bends sideways at its middle joints. For a target steeply
  //     below the base that plane, through the target, is ill-defined and swung
  //     about with the target's slightest offset (the finger folded out sideways
  //     for a frame), so there it turns toward the hand's forward
  //     (STEEP_FORWARD), the joints bowing forward: the finger curls forward and
  //     down. The little the target is then off the plane is made up along the
  //     finger, a share at each joint by its distance along it.
  //     
  [L1, L2, L3] = lengths;
  d = _sub(target, base);
  r = _norm(d);
  if ((r < 1e-06)) {
    [d, r] = [[0.0, 1e-06, 0.0], 1e-06];
  }
  [side, off] = [null, 0.0];
  if ((forward !== null)) {
    steep = _smooth(((((-d[2]) / r) - STEEP_FORWARD[0]) / (STEEP_FORWARD[1] - STEEP_FORWARD[0])));
    lean = pyMult(STEEP_FORWARD[2], steep);
    span = pyAdd(pyAdd(L1, L2), L3);
    w = pyMult(pyMult(pyMult(STEEP_FORWARD[3], span), steep), pyMax(0.0, (1.0 - (Math.hypot(d[0], d[1]) / pyMult(pyMult(2, STEEP_FORWARD[3]), span)))));
    [hx, hy] = [pyAdd(d[0], pyMult(forward[0], w)), pyAdd(d[1], pyMult(forward[1], w))];
    hl = Math.hypot(hx, hy);
    [ux, uy] = ((hl > 1e-09) ? [(hx / hl), (hy / hl)] : forward);
    side = [(-uy), ux, 0.0];
    off = _dot(d, side);
    d = _sub(d, _mul(side, off));
    r = pyMax(1e-06, _norm(d));
    bulge = [pyMult(ux, lean), pyMult(uy, lean), 1.0];
  }
  e1 = _mul(d, (1.0 / r));
  e2 = _sub(bulge, _mul(e1, _dot(bulge, e1)));
  n = _norm(e2);
  if ((n < 1e-06)) {
    e2 = ((Math.abs(e1[2]) < 0.9) ? [0.0, 0.0, 1.0] : [1.0, 0.0, 0.0]);
    e2 = _sub(e2, _mul(e1, _dot(e2, e1)));
    n = _norm(e2);
  }
  e2 = _mul(e2, (1.0 / n));
  k = pyAdd(1.0, coupling);
  const reach = (b: any = null): any => {
    let x: any, y: any;
    x = pyAdd(pyAdd(L1, pyMult(L2, Math.cos(b))), pyMult(L3, Math.cos(pyMult(b, k))));
    y = (pyMult((-L2), Math.sin(b)) - pyMult(L3, Math.sin(pyMult(b, k))));
    return [x, y];
  };
  if ((r >= pyAdd(pyAdd(L1, L2), L3))) {
    b = 0.0;
  } else {
    if ((Math.hypot(...reach(bend_max)) >= r)) {
      b = bend_max;
    } else {
      [lo, hi] = [0.0, bend_max];
      for (_ = 0; _ < 22; _ += 1) {
        mid = pyMult(pyAdd(lo, hi), 0.5);
        if ((Math.hypot(...reach(mid)) > r)) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      b = pyMult(pyAdd(lo, hi), 0.5);
    }
  }
  [x, y] = reach(b);
  ang = (-Math.atan2(y, x));
  pts = [base];
  p = base;
  for ([L, bend] of pyIter([[L1, 0.0], [L2, b], [L3, pyMult(b, coupling)]])) {
    ang -= bend;
    p = _add(p, _add(_mul(e1, pyMult(L, Math.cos(ang))), _mul(e2, pyMult(L, Math.sin(ang)))));
    pts.push(p);
  }
  if ((((lift_max !== null)) && ((r < pyAdd(pyAdd(L1, L2), L3))))) {
    pts = _lower_knuckle(pts, r, lengths, e1, e2, lift_max, bend_max);
  }
  if (bool(off)) {
    [acc, total] = [0.0, Number(pyAdd(pyAdd(L1, L2), L3))];
    out = [pts[0]];
    for ([p, q, L] of pyIter(zip(pts, pts.slice(1), lengths))) {
      acc = pyAugAdd(acc, L);
      out.push(_add(q, _mul(side, (pyMult(off, acc) / total))));
    }
    pts = out;
  }
  return pts;
}
export function _lower_knuckle(pts: any = null, r: any = null, lengths: any = null, e1: any = null, e2: any = null, lift_max: any = null, bend_max: any = null): any {
  let L1: any, L2: any, L3: any, _: any, a: any, b2: any, b3: any, base: any, cap: any, d1: any, d2: any, d3: any, dx: any, dy: any, h: any, hi: any, j1: any, j2: any, k: any, lo: any, mid: any, phi: any, phi0: any, r2: any, sgn: any, u: any, ux: any, uy: any, world: any;
  // 
  //     solve_chain's chain with its first bone no steeper than lift_max: the
  //     first bone tipped down (as little as it takes, in the chain's plane) and
  //     the other two bent to the target as a two-bone chain, curling the same
  //     way. The chain unchanged if no such shape is found.
  //     
  [L1, L2, L3] = lengths;
  base = pts[0];
  u = _mul(_sub(pts[1], base), (1.0 / L1));
  cap = Math.sin(lift_max);
  if ((u[2] <= cap)) {
    return pts;
  }
  phi0 = Math.atan2(_dot(u, e2), _dot(u, e1));
  const rise = (phi: any = null): any => {
    return pyAdd(pyMult(Math.cos(phi), e1[2]), pyMult(Math.sin(phi), e2[2]));
  };
  [lo, hi] = [pyMin(0.0, phi0), phi0];
  if ((rise(lo) > cap)) {
    return pts;
  }
  for (_ = 0; _ < 24; _ += 1) {
    mid = pyMult(0.5, pyAdd(lo, hi));
    [lo, hi] = ((rise(mid) <= cap) ? [mid, hi] : [lo, mid]);
  }
  for (k = 0; k < 9; k += 1) {
    phi = pyAdd(lo, (pyMult((phi0 - lo), k) / 8));
    j1 = [pyMult(L1, Math.cos(phi)), pyMult(L1, Math.sin(phi))];
    [dx, dy] = [(r - j1[0]), (-j1[1])];
    r2 = Math.hypot(dx, dy);
    if (bool((!((pyAdd(Math.abs((L2 - L3)), 1e-06) < r2) && (r2 < (pyAdd(L2, L3) - 1e-06)))))) {
      continue;
    }
    a = (pyAdd((pyMult(L2, L2) - pyMult(L3, L3)), pyMult(r2, r2)) / pyMult(2, r2));
    h = Math.sqrt(pyMax(0.0, (pyMult(L2, L2) - pyMult(a, a))));
    [ux, uy] = [(dx / r2), (dy / r2)];
    for (sgn of pyIter([1.0, (-1.0)])) {
      j2 = [(pyAdd(j1[0], pyMult(a, ux)) - pyMult(pyMult(sgn, h), uy)), pyAdd(pyAdd(j1[1], pyMult(a, uy)), pyMult(pyMult(sgn, h), ux))];
      d1 = [Math.cos(phi), Math.sin(phi)];
      d2 = [((j2[0] - j1[0]) / L2), ((j2[1] - j1[1]) / L2)];
      d3 = [((r - j2[0]) / L3), ((-j2[1]) / L3)];
      b2 = (-Math.atan2((pyMult(d1[0], d2[1]) - pyMult(d1[1], d2[0])), pyAdd(pyMult(d1[0], d2[0]), pyMult(d1[1], d2[1]))));
      b3 = (-Math.atan2((pyMult(d2[0], d3[1]) - pyMult(d2[1], d3[0])), pyAdd(pyMult(d2[0], d3[0]), pyMult(d2[1], d3[1]))));
      if ((((((-1e-06) <= b2) && (b2 <= pyAdd(bend_max, 0.35)))) && ((((-1e-06) <= b3) && (b3 <= bend_max))))) {
        world = ((q) => _add(base, _add(_mul(e1, q[0]), _mul(e2, q[1]))));
        return [base, world(j1), world(j2), world([r, 0.0])];
      }
    }
  }
  return pts;
}
export function drawn_reach(geo: any = null, lift_in: any = null, fa: any = null, fb: any = null): any {
  let A: any, B: any, ax: any, ay: any, best: any, bx: any, bx_: any, by: any, by_: any, bz: any, c: any, dz: any, f: any, full: any, hi: any, hmax: any, hmin: any, k: any, lo: any, psi: any, pts: any, s: any, sl: any, u: any;
  // 
  //     How far apart (white keys, centre to centre) fingers fa < fb of the drawn
  //     hand can hold keys down: each fingertip anywhere in its splay and reach
  //     range while pressing (its pressing slack included), the hand turned
  //     anywhere in the wrist's range, the two tips no more than ROLL_DEPTH_IN
  //     apart along the keys. A quick, cautious bound (it leaves out the hand
  //     flattening over wide chords): a chord near or past it for some pair is
  //     checked properly by HandAnimator._chord_fits.
  //     
  u = INCHES_PER_UNIT;
  pts = {  };
  for (f of pyIter([fa, fb])) {
    [bx, by, bz] = Array.from(pyIter(geo.base(f))).map((c: any) => pyMult(c, u));
    full = pyMult((geo.bones[f]).reduce((a: any, b: any) => a + b, 0), u);
    dz = pyAdd(pyAdd(bz, lift_in), KEY_TRAVEL_IN);
    hmax = Math.sqrt(pyMax(0.0, (Math.pow(pyMult(0.99, full), 2) - pyMult(dz, dz))));
    hmin = pyMin(pyMult(REACH_MIN[f], full), hmax);
    sl = PRESS_SLACK_DEG[f];
    [lo, hi] = [(((SPLAY_LIMIT_DEG[f][0] - sl)) * Math.PI / 180.0), ((pyAdd(SPLAY_LIMIT_DEG[f][1], sl)) * Math.PI / 180.0)];
    pts[f] = Array.from(pyIter(pyRange(17))).flatMap((i: any) => Array.from(pyIter(Array.from(pyIter(pyRange(7))).map((j: any) => pyAdd(hmin, (pyMult((hmax - hmin), j) / 6))))).map((h: any) => [pyAdd(bx, pyMult(h, Math.sin(pyAdd(lo, (pyMult((hi - lo), i) / 16))))), pyAdd(by, pyMult(h, Math.cos(pyAdd(lo, (pyMult((hi - lo), i) / 16)))))]));
  }
  best = 0.0;
  for (k = 0; k < 25; k += 1) {
    psi = ((pyAdd(ROLL_TURN_DEG[0], (pyMult((ROLL_TURN_DEG[1] - ROLL_TURN_DEG[0]), k) / 24))) * Math.PI / 180.0);
    [c, s] = [Math.cos(psi), Math.sin(psi)];
    A = Array.from(pyIter(pts[fa])).map(([x, y]: any) => [(pyMult(x, c) - pyMult(y, s)), pyAdd(pyMult(x, s), pyMult(y, c))]);
    B = Array.from(pyIter(pts[fb])).map(([x, y]: any) => [(pyMult(x, c) - pyMult(y, s)), pyAdd(pyMult(x, s), pyMult(y, c))]);
    for ([ax, ay] of pyIter(A)) {
      for ([bx_, by_] of pyIter(B)) {
        if (((((bx_ - ax) > best)) && ((Math.abs((by_ - ay)) <= ROLL_DEPTH_IN)))) {
          best = (bx_ - ax);
        }
      }
    }
  }
  return (best / WHITE_KEY_IN);
}
export function _clamp(x: any = null, lo: any = null, hi: any = null): any {
  return ((x < lo) ? lo : ((x > hi) ? hi : x));
}
export function _solve3(A: any = null, b: any = null): any {
  let d: any, i: any, m: any, out: any, r: any;
  // Solve a 3x3 linear system (Cramer's rule).
  const det = (m: any = null): any => {
    return pyAdd((pyMult(m[0][0], (pyMult(m[1][1], m[2][2]) - pyMult(m[1][2], m[2][1]))) - pyMult(m[0][1], (pyMult(m[1][0], m[2][2]) - pyMult(m[1][2], m[2][0])))), pyMult(m[0][2], (pyMult(m[1][0], m[2][1]) - pyMult(m[1][1], m[2][0]))));
  };
  d = det(A);
  if ((Math.abs(d) < 1e-12)) {
    return [0.0, 0.0, 0.0];
  }
  out = [];
  for (i = 0; i < 3; i += 1) {
    m = Array.from(pyIter(A)).map((row: any) => row.slice(0));
    for (r = 0; r < 3; r += 1) {
      m[r][i] = b[r];
    }
    out.push((det(m) / d));
  }
  return out;
}
export class HandAnimator {
  [key: string]: any;
  // 
  //     The pose is solved fresh for every frame from what the hand has to do
  //     around that moment, so the whole hand keeps adapting instead of jumping
  //     between fixed keyframes:
  // 
  //       * every finger's current key (pressing, weight 1), the key it just let
  //         go of (fading out) and the key it plays next (fading in over self.antic_t)
  //         become weighted targets;
  //       * the wrist position AND its turn are fit to those targets (a weighted
  //         rigid fit with the forearm's natural turn as a prior), then corrected
  //         until every finger can reach its key without going past its joint
  //         limits - an out-of-range finger turns the hand about its knuckle
  //         first (wrist rotation, within WRIST_DEV_DEG) and slides it second;
  //       * each fingertip then follows its own timeline (press, lift, travel to
  //         the next key, strike). Fingers with nothing to do fan out between
  //         their busy neighbours, so the hand's shape follows the notes;
  //       * finally every fingertip is clamped to its finger's splay/reach range
  //         before the bones are solved, so no finger ever bends out of the hand.
  //     
  constructor(song: any = null, hand: any = null, fingering: any = null, pianist: any = null, repair: any = null, key_style: any = null) {
    let _: any, a: any, b: any, e: any, ends: any, eo: any, f: any, g: any, gi: any, i: any, j: any, lift: any, m: any, n: any, notes: any, ns: any, nx: any, pk: any, s0: any, s1: any, sm: any, so: any, starts: any, vm: any, vn: any;
    if (fingering && typeof fingering === 'object' && !Array.isArray(fingering) && ('pianist' in fingering || 'key_style' in fingering || 'repair' in fingering)) {
      pianist = fingering.pianist ?? pianist;
      key_style = fingering.key_style ?? key_style;
      repair = fingering.repair ?? repair;
      fingering = fingering.fingering ?? null;
    }

    this.pianist = (bool(pianist) ? (pianist) : (pianists.active()));
    this.geo = new HandGeometry(this.pianist.anatomy);
    this.skin = this.pianist.skin_settings();
    this.color = [...this.skin['colors']['skeleton']['bone']];
    this._set_behavior(this.pianist);
    this.hand = hand;
    this.key_style = ((pyIn(key_style, ['realistic', 'equal'])) ? key_style : 'realistic');
    this.song = song;
    this.mirror = (pyNotEq(hand, RIGHT));
    this.vp = (bool(this.mirror) ? mirror_pitch : ((p) => p));
    this._bias = 0.0;
    notes = Array.from(pyIter(song.notes)).filter((n: any) => (pyEq(n.hand, hand))).map((n: any) => n);

    this.gliss_runs = glissando.find(notes, this.pianist);
    this.gliss_ids = new Set(Array.from(pyIter(this.gliss_runs)).flatMap((r: any) => Array.from(pyIter(r)).map((n: any) => pyId(n))));
    this.gliss_eps = glissando.episodes(this.gliss_runs, notes, Number(this.pianist.b('gliss_merge')));
    this.gliss_start = this._gliss_schedule();
    notes = Array.from(pyIter(notes)).filter((n: any) => ((!pyIn(pyId(n), this.gliss_ids)))).map((n: any) => n);
    this.groups = group_notes(notes, this.vp);
    this.repaired = new Set();
    if ((fingering === null)) {
      fingering = plan_fingering(this.groups, this.vp, 32, hand, song.notes, true, this.pianist, null, null, repair, this.repaired);
    }
    this.fingering = Object.fromEntries(Array.from(pyIter(this.groups)).flatMap(([_0, ns]: any) => Array.from(pyIter(ns)).filter((n: any) => pyGet(fingering, pyId(n), null)).map((n: any) => [pyId(n), fingering[pyId(n)]])));
    this.groups = Array.from(pyIter(this.groups)).map(([t, ns]: any) => [t, Array.from(pyIter(ns)).filter((n: any) => (pyIn(pyId(n), this.fingering))).map((n: any) => n)]);
    this.groups = Array.from(pyIter(this.groups)).filter((g: any) => g[1]).map((g: any) => g);

    this.pair_key = {  };
    for ([_, ns] of pyIter(this.groups)) {
      for ([a, b] of pyIter(zip(ns, ns.slice(1)))) {
        f = this.fingering[pyId(a)];
        if ((((pyEq(f, this.fingering[pyId(b)]))) && bool(double_ok(this.vp(a.pitch), this.vp(b.pitch), f)))) {
          pk = [pyMin(a.pitch, b.pitch), pyMax(a.pitch, b.pitch)];
          this.pair_key[pyId(a)] = this.pair_key[pyId(b)] = pk;
        }
      }
    }
    this.by_finger = Object.fromEntries(Array.from(pyIter(pyRange(1, 6))).map((f: any) => [f, []]));
    for ([_, ns] of pyIter(this.groups)) {
      for (n of pyIter(ns)) {
        this.by_finger[this.fingering[pyId(n)]].push(n);
      }
    }
    so = Object.fromEntries(Array.from(pyIter(this.groups)).flatMap(([_0, ns]: any) => Array.from(pyIter(ns)).map((n: any) => [pyId(n), n.start])));
    this.start_of = so;
    eo = Object.fromEntries(Array.from(pyIter(this.groups)).flatMap(([_0, ns]: any) => Array.from(pyIter(ns)).map((n: any) => [pyId(n), n.end])));
    this.end_of = eo;
    this.rolled = 0;
    this._ref_kb = null;
    this._layout_sig = null;
    this._roll_wide_chords();
    for (f of pyIter(this.by_finger)) {
      this.by_finger[f].sort((a: any, b: any) => { const ka = ((n) => so[pyId(n)]) ? (((n) => so[pyId(n)]))(a) : a; const kb = ((n) => so[pyId(n)]) ? (((n) => so[pyId(n)]))(b) : b; return ka < kb ? (false ? 1 : -1) : (ka > kb ? (false ? -1 : 1) : 0); });
    }
    this.finger_starts = Object.fromEntries(Array.from(pyIter(pyItems(this.by_finger))).map(([f, ns]: any) => [f, Array.from(pyIter(ns)).map((n: any) => so[pyId(n)])]));
    this.finger_ends = {  };
    for ([f, ns] of pyIter(pyItems(this.by_finger))) {
      ends = [];
      for ([i, n] of pyIter(enumerate(ns))) {
        [e, s0] = [eo[pyId(n)], so[pyId(n)]];
        j = pyAdd(i, 1);
        while ((((j < (ns).length)) && (((so[pyId(ns[j])] - s0) < 0.01)))) {
          j = pyAugAdd(j, 1);
        }
        if ((j < (ns).length)) {
          nx = ns[j];
          s1 = so[pyId(nx)];
          e = pyMin(e, s1);
          if ((pyNotEq(nx.pitch, n.pitch))) {
            e = pyMin(e, pyMax(pyAdd(s0, pyMult(0.5, (s1 - s0))), (s1 - this._jump_lift(n, nx))));
          }
        }
        ends.push(pyMax(e, pyAdd(s0, 0.001)));
      }
      this.finger_ends[f] = ends;
    }

    starts = Array.from(pyIter(this.groups)).map((g: any) => g[0]);
    for ([f, ns] of pyIter(pyItems(this.by_finger))) {
      for ([i, n] of pyIter(enumerate(ns))) {
        s0 = so[pyId(n)];
        gi = bisectRight(starts, pyAdd(n.start, 1e-06));
        while ((((gi < (this.groups).length)) && ((starts[gi] <= pyAdd(this.finger_ends[f][i], 0.1))))) {
          for (m of pyIter(this.groups[gi][1])) {
            g = this.fingering[pyId(m)];
            if ((bool((pyEq(g, f))) ? ((pyEq(g, f))) : ((pyEq(m.pitch, n.pitch))))) {
              continue;
            }
            [vn, vm] = [this.vp(n.pitch), this.vp(m.pitch)];
            if ((Math.abs((key_pos(vm) - key_pos(vn))) > pyAdd(MAX_SPAN[[pyMin(f, g), pyMax(f, g)]], 0.5))) {
              lift = this.early_lift;
            } else {
              if ((pyIn(1, [f, g]))) {
                if ((bool(is_crossing(vn, f, vm, g)) && ((Math.abs((key_pos(vm) - key_pos(vn))) > 2.0)))) {
                  lift = CROSS_LIFT_T;
                } else {
                  continue;
                }
              } else {
                if ((pyNotEq((g > f), (vm > vn)))) {
                  lift = this.early_lift;
                } else {
                  continue;
                }
              }
            }
            sm = so[pyId(m)];
            e = pyMax(pyAdd(s0, pyMult(0.5, (sm - s0))), (sm - lift));
            this.finger_ends[f][i] = pyMax(pyAdd(s0, 0.001), pyMin(this.finger_ends[f][i], e));
          }
          gi = pyAugAdd(gi, 1);
        }
      }
    }
    this._speed_schedule();
    this.white_up = this._white_up();
    this.performance = Array.from(pyIter(pyItems(this.by_finger))).flatMap(([f, ns]: any) => Array.from(pyIter(enumerate(ns))).map(([i, n]: any) => [this.finger_starts[f][i], this.finger_ends[f][i], n]));
    this.performance = pyAugAdd(this.performance, this._gliss_performance());
    this.spans = busy_spans(Array.from(pyIter(this.performance)).map(([s0, e, _0]: any) => [s0, e]));
    this.span_starts = Array.from(pyIter(this.spans)).map(([a, _0]: any) => a);
    this.partner = null;
    [this._idle_cache, this._clear_cache, this._path_cache] = [{  }, {  }, {  }];
    this._find_gestures();
    this._gliss_cache = null;
    this._gliss_follow_cache = {  };
    this._follow_jobs = {  };
    this._warm_k = null;
    this._strike_list = null;
    this._prep_cache = {  };
    this._gliss_starts = Array.from(pyIter(this.gliss_eps)).map((ep: any) => this.gliss_start[pyId(ep[0][0])]);
    this.runs = this._find_runs();
    this.run_starts = Array.from(pyIter(this.runs)).map(([a, _0]: any) => a);
    this.trems = this._find_tremolos();
    this._group_ts = Array.from(pyIter(this.groups)).map(([t, _0]: any) => t);
    this.trem_starts = Array.from(pyIter(this.trems)).map(([a, _0]: any) => a);
    this._layout_sig = null;
  }
  _find_runs(): any {
    let cur: any, d: any, ds: any, ns: any, prev: any, ps: any, runs: any, step: any, t: any;
    // 
    //         [(start, end)] of this hand's scale runs: RUN_MIN_NOTES or more single
    //         notes in a row, each a step (1-2 semitones, or a harmonic minor's
    //         augmented second after a step) from the one before and at most
    //         RUN_GAP_T after it - or as many octaves (or other double notes) in a
    //         row, all their notes moving together by the same step (chromatic
    //         octaves: the hand glides, not turning for each 4 and 5). Arpeggios
    //         (thirds and wider) never qualify.
    //         
    [runs, cur] = [[], []];
    const close = (): any => {
      if (((cur).length >= RUN_MIN_NOTES)) {
        runs.push([cur[0][0], cur[cur.length - 1][2]]);
      }
    };
    for ([t, ns] of pyIter(this.groups)) {
      ps = pySorted(Array.from(pyIter(ns)).map((n: any) => n.pitch), null, false);
      if (bool(cur)) {
        prev = cur[cur.length - 1][1];
        if ((((pyEq((ps).length, 1))) && ((pyEq((prev).length, 1))))) {
          d = Math.abs((ps[0] - prev[0]));
          step = (bool(((1 <= d) && (d <= 2))) ? (((1 <= d) && (d <= 2))) : ((((pyEq(d, 3))) && (((cur).length > 1)) && ((pyEq((cur[cur.length - 2][1]).length, 1))) && (((1 <= Math.abs((prev[0] - cur[cur.length - 2][1][0]))) && (Math.abs((prev[0] - cur[cur.length - 2][1][0])) <= 2))))));
        } else {
          ds = ((pyEq((ps).length, (prev).length)) ? new Set(Array.from(pyIter(zip(ps, prev))).map(([a, b]: any) => (a - b))) : new Set());
          step = (((pyEq((ds).length, 1))) && (((1 <= Math.abs(next(iter(ds)))) && (Math.abs(next(iter(ds))) <= 2))));
        }
        if ((bool((!bool(step))) ? ((!bool(step))) : (((t - cur[cur.length - 1][0]) > RUN_GAP_T)))) {
          close();
          cur = [];
        }
      }
      if (((ps).length > 2)) {
        close();
        cur = [];
        continue;
      }
      cur.push([t, ps, pyMin(pyMax(Array.from(pyIter(ns)).map((n: any) => n.end)), pyAdd(t, RUN_GAP_T))]);
    }
    close();
    return runs;
  }
  _find_tremolos(): any {
    let a0: any, a1: any, b0: any, b1: any, groups: any, hi: any, i: any, kp: any, lo: any, merged: any, n: any, ns: any, ok: any, out: any, p: any, pieces: any, reach: any, sets: any, spans: any, start: any, t1: any;
    // 
    //         [(start, end)] of this hand's tremolos and trills: TREM_MIN_NOTES or
    //         more strikes in a row, at most TREM_GAP_T apart, repeating with one
    //         period p (2 to TREM_PERIOD strikes): every key or chord is struck
    //         again p strikes later or was p strikes before (so a key that moves
    //         on, the tremolo's middle note going up a semitone, keeps it going),
    //         at least two different ones. Played from one place: the wrist holds
    //         still and each finger stays over its key - so each cycle's keys must
    //         be within the hand's reach (a repeated broken chord wider than that,
    //         Chopin's Op. 25 No. 12, is played moving).
    //         

    reach = pyAdd(pyMult(fg.BASE_MAX_SPAN[[1, 5]], reach_scale(this.pianist.anatomy)[[1, 5]]), TREM_REACH_EXTRA);
    groups = this.groups;
    n = (groups).length;
    sets = Array.from(pyIter(groups)).map(([_0, ns]: any) => frozenset(Array.from(pyIter(ns)).map((m: any) => m.pitch)));
    spans = [];
    for (p = 2; p < pyAdd(TREM_PERIOD, 1); p += 1) {
      ok = Array.from(pyIter(pyRange(n))).map((i: any) => (bool((((i >= p)) && ((pyEq(sets[i], sets[(i - p)]))))) ? ((((i >= p)) && ((pyEq(sets[i], sets[(i - p)]))))) : ((((pyAdd(i, p) < n)) && ((pyEq(sets[i], sets[pyAdd(i, p)])))))));
      lo = null;
      for (i = 0; i < pyAdd(n, 1); i += 1) {
        if ((((i < n)) && bool(ok[i]) && ((bool((lo === null)) ? ((lo === null)) : (((groups[i][0] - groups[(i - 1)][0]) <= TREM_GAP_T)))))) {
          if ((lo === null)) {
            lo = i;
          }
          continue;
        }
        if ((((lo !== null)) && (((i - lo) >= TREM_MIN_NOTES)) && (((new Set(sets.slice(lo, i))).length >= 2)))) {
          spans.push([lo, (i - 1)]);
        }
        lo = ((((i < n)) && bool(ok[i])) ? i : null);
      }
    }
    merged = [];
    for ([lo, hi] of pyIter(pySorted(spans, null, false))) {
      if ((bool(merged) && (((groups[lo][0] - groups[merged[merged.length - 1][1]][0]) <= TREM_GAP_T)) && ((lo <= pyAdd(merged[merged.length - 1][1], TREM_PERIOD))))) {
        merged[merged.length - 1] = [merged[merged.length - 1][0], pyMax(merged[merged.length - 1][1], hi)];
      } else {
        merged.push([lo, hi]);
      }
    }
    pieces = [];
    for ([lo, hi] of pyIter(merged)) {
      const rng = (i: any = null): any => {
        let ps: any;
        ps = Array.from(pyIter(sets.slice(pyMax(start, pyAdd((i - TREM_PERIOD), 1)), pyAdd(i, 1)))).flatMap((s_: any) => Array.from(pyIter(s_)).map((p: any) => p));
        return [pyMin(ps), pyMax(ps)];
      };
      start = lo;
      for (i = pyAdd(lo, TREM_PERIOD); i < pyAdd(hi, 1); i += 1) {
        if (((i - start) < TREM_PERIOD)) {
          continue;
        }
        [[a0, b0], [a1, b1]] = [rng((i - 1)), rng(i)];
        if ((bool((Math.abs((a1 - a0)) > TREM_JUMP)) ? ((Math.abs((a1 - a0)) > TREM_JUMP)) : ((Math.abs((b1 - b0)) > TREM_JUMP)))) {
          pieces.push([start, (i - 1)]);
          start = i;
        }
      }
      pieces.push([start, hi]);
    }
    out = [];
    for ([lo, hi] of pyIter(pieces)) {
      if ((bool((pyAdd((hi - lo), 1) < TREM_MIN_NOTES)) ? ((pyAdd((hi - lo), 1) < TREM_MIN_NOTES)) : (((new Set(sets.slice(lo, pyAdd(hi, 1)))).length < 2)))) {
        continue;
      }
      kp = Array.from(pyIter(sets.slice(lo, pyAdd(hi, 1)))).map((s_: any) => Array.from(pyIter(s_)).map((p: any) => key_pos(this.vp(p))));
      if (bool(Array.from(Array.from(pyIter(pyRange(pyMax(1, pyAdd(((kp).length - TREM_PERIOD), 1))))).map((i: any) => ((pyMax(Array.from(pyIter(kp.slice(i, pyAdd(i, TREM_PERIOD)))).map((c: any) => pyMax(c))) - pyMin(Array.from(pyIter(kp.slice(i, pyAdd(i, TREM_PERIOD)))).map((c: any) => pyMin(c)))) > reach))).some(Boolean))) {
        continue;
      }
      [t1, ns] = groups[hi];
      out.push([groups[lo][0], pyMin(pyMax(Array.from(pyIter(ns)).map((m: any) => m.end)), pyAdd(t1, TREM_GAP_T))]);
    }
    return out;
  }
  _trem_span(t: any = null): any {
    let i: any;
    // The tremolo (start, end) covering t, or None.
    i = (bisectRight(this.trem_starts, t) - 1);
    if ((((i >= 0)) && ((t < this.trems[i][1])))) {
      return this.trems[i];
    }
    return null;
  }
  _trem_w(t: any = null): any {
    let a: any, b: any, r: any, ramp: any;
    // (0..1 how much t is inside a tremolo, eased in and out over RUN_RAMP_T; that tremolo or None).
    r = this._trem_span(t);
    if ((r === null)) {
      return [0.0, null];
    }
    [a, b] = r;
    ramp = pyMin(RUN_RAMP_T, ((b - a) / 3));
    return [_smooth(pyMin(((t - a) / ramp), ((b - t) / ramp), 1.0)), r];
  }
  _trem_note(f: any = null, t: any = null, r: any = null): any {
    let a: any, b: any, g: any, gts: any, i: any, last: any, nxt: any, starts: any;
    // 
    //         Finger f's key in tremolo r at t: the one it played last, or its next
    //         - whichever is nearer in time when they differ (a finger the tremolo
    //         moves on to a new key goes with it).
    //         
    [a, b] = r;
    gts = this._group_ts;
    g = bisectRight(gts, t);
    a = pyMax(a, (bool(gts) ? gts[pyMax(0, (g - TREM_PERIOD))] : a));
    b = pyMin(b, (bool(gts) ? gts[pyMin(((gts).length - 1), (pyAdd(g, TREM_PERIOD) - 1))] : b));
    starts = this.finger_starts[f];
    i = (bisectRight(starts, t) - 1);
    last = ((((i >= 0)) && ((starts[i] >= (a - 1e-06)))) ? this.by_finger[f][i] : null);
    nxt = ((((pyAdd(i, 1) < (starts).length)) && ((starts[pyAdd(i, 1)] <= pyAdd(b, 1e-06)))) ? this.by_finger[f][pyAdd(i, 1)] : null);
    if ((bool((last === null)) ? ((last === null)) : ((bool((nxt === null)) ? ((nxt === null)) : ((pyEq(last.pitch, nxt.pitch))))))) {
      return (bool(last) ? (last) : (nxt));
    }
    return (((t - starts[i]) <= (starts[pyAdd(i, 1)] - t)) ? last : nxt);
  }
  _run_span(t: any = null): any {
    let i: any;
    // The run (start, end) whose eased reach covers t, or None.
    i = (bisectRight(this.run_starts, pyAdd(t, RUN_RAMP_T)) - 1);
    if ((((i >= 0)) && ((t < pyAdd(this.runs[i][1], RUN_RAMP_T))))) {
      return this.runs[i];
    }
    return null;
  }
  _run_w(t: any = null): any {
    let a: any, b: any, r: any;
    // 0..1 how much t is inside a scale run (eased in and out over RUN_RAMP_T).
    r = this._run_span(t);
    if ((r === null)) {
      return 0.0;
    }
    [a, b] = r;
    return _smooth(pyMin(pyAdd(((t - a) / RUN_RAMP_T), 1.0), pyAdd(((b - t) / RUN_RAMP_T), 1.0), 1.0));
  }
  _low(t: any = null): any {
    let f: any, flat: any, n: any, span: any, w: any, w0: any, w1: any, x0: any, x1: any, xs: any;
    // 
    //         How high the hand is (1 = its usual height): stretched over a wide
    //         chord (an octave) a pianist flattens the hand and drops the knuckles,
    //         so the thumb and little finger reach further across the keys.
    //         
    xs = [];
    for (f = 1; f < 6; f += 1) {
      [w, n] = this._key_weight(f, t);
      if ((((n !== null)) && ((w > 0.01)) && bool(this._has_key(this._pk(n))))) {
        xs.push([this.key_target(this._pk(n), f, n)[0], w]);
      }
    }
    if (((xs).length < 2)) {
      return 1.0;
    }
    [[x0, w0], [x1, w1]] = [pyMin(xs), pyMax(xs)];
    span = ((x1 - x0) / this.kb.white_w);
    flat = pyMult(_smooth(((span - FLAT_SPAN_WK[0]) / (FLAT_SPAN_WK[1] - FLAT_SPAN_WK[0]))), pyMin(w0, w1));
    return (1.0 - pyMult(FLAT_DROP, flat));
  }
  _splay_at(f: any = null, comp: any = null, stretch: any = null): any {
    let chi: any, clo: any, ehi: any, elo: any, hi: any, lo: any;
    // 
    //         Finger f's splay limits (rad): its full stretch (`stretch` 1, for a key
    //         it holds or strikes) or its comfortable spread in the air (0), widened
    //         toward the hand's middle by `comp` (a run).
    //         
    [lo, hi] = this.splay[f];
    if ((stretch < 1.0)) {
      [clo, chi] = this.splay_comfort[f];
      [lo, hi] = [_lerp(clo, lo, stretch), _lerp(chi, hi, stretch)];
    }
    if ((comp > 0)) {
      [elo, ehi] = RUN_COMPRESS_DEG[f];
      [lo, hi] = [(lo - pyMult(((elo) * Math.PI / 180.0), comp)), pyAdd(hi, pyMult(((ehi) * Math.PI / 180.0), comp))];
    }
    return [lo, hi];
  }
  _separate(tips: any = null, wx: any = null, wy: any = null, psi: any = null, t: any = null, comp: any = null): any {
    let _: any, a: any, apart: any, b: any, d: any, f: any, fixed: any, free: any, fs: any, fx: any, g_ab: any, gap: any, held: any, k: any, loc: any, m: any, mob: any, moved: any, out: any, ox: any, oy: any, oz: any, pair_gap: any, rot: any, x: any, y: any;
    // 
    //         In a run, fingertips 2-5 that would come closer than TIP_GAP_WK (or
    //         pass each other) are pushed apart across the hand - a finger on its
    //         key stays put - blended in by `comp`: compressed, never overlapping.
    //         Each of a pair gives way by its mobility: none while on its key, then
    //         growing as the key no longer needs reaching (1 - _key_weight: eased
    //         out after the release, in before the strike) - not all at once at the
    //         release, which made the neighbours jump in chromatic scales.
    //         
    if ((comp <= 0)) {
      return tips;
    }
    [rot, gap] = [this._rot, pyMult(TIP_GAP_WK, this.kb.white_w)];
    fs = Array.from(pyIter([2, 3, 4, 5])).filter((f: any) => (pyIn(f, tips))).map((f: any) => f);
    loc = Object.fromEntries(Array.from(pyIter(fs)).map((f: any) => [f, [...rot((tips[f][0] - wx), (tips[f][1] - wy), (-psi))]]));
    mob = Object.fromEntries(Array.from(pyIter(fs)).map((f: any) => [f, (bool(this._pressing(f, t)) ? 0.0 : (1.0 - this._key_weight(f, t)[0]))]));
    pair_gap = {  };
    for ([a, b] of pyIter(zip(fs, fs.slice(1)))) {
      g_ab = gap;
      for ([fixed, free] of pyIter([[a, b], [b, a]])) {
        if ((bool((mob[fixed] > 0.001)) ? ((mob[fixed] > 0.001)) : ((mob[free] <= 0.001)))) {
          continue;
        }
        held = this._key_weight(fixed, t)[1];
        if ((held === null)) {
          continue;
        }
        k = this._key_x_across(held, fixed, tips[fixed][1], wx, wy, psi);
        for (fx of pyIter(this._near_keys_x(free, t, tips[free][1], wx, wy, psi))) {
          apart = ((pyEq(free, b)) ? (fx - k) : (k - fx));
          if ((apart > 0)) {
            g_ab = pyMin(g_ab, pyMax(pyMult(TIP_GAP_MIN_WK, this.kb.white_w), apart));
          }
        }
      }
      pair_gap[a] = g_ab;
    }
    for (_ = 0; _ < 12; _ += 1) {
      moved = false;
      for ([a, b] of pyIter(zip(fs, fs.slice(1)))) {
        d = (pair_gap[a] - (loc[b][0] - loc[a][0]));
        m = pyAdd(mob[a], mob[b]);
        if ((bool((d <= 1e-06)) ? ((d <= 1e-06)) : ((m <= 0.001)))) {
          continue;
        }
        moved = true;
        loc[a][0] -= (pyMult(d, mob[a]) / m);
        loc[b][0] = pyAugAdd(loc[b][0], (pyMult(d, mob[b]) / m));
      }
      if (bool((!bool(moved)))) {
        break;
      }
    }
    out = { ...tips };
    k = pyMin(1.0, pyMult(3.0, comp));
    for (f of pyIter(fs)) {
      [x, y] = rot(loc[f][0], loc[f][1], psi);
      [ox, oy, oz] = tips[f];
      out[f] = [_lerp(ox, pyAdd(wx, x), k), _lerp(oy, pyAdd(wy, y), k), oz];
    }
    return out;
  }
  _near_keys_x(f: any = null, t: any = null, y: any = null, wx: any = null, wy: any = null, psi: any = null): any {
    let i: any, starts: any;
    // Across the hand (as _separate measures), finger f's keys: the one it is on or last left, and its next.
    starts = this.finger_starts[f];
    i = (bisectRight(starts, t) - 1);
    return Array.from(pyIter([i, pyAdd(i, 1)])).filter((j: any) => ((0 <= j) && (j < (starts).length))).map((j: any) => this._key_x_across(this.by_finger[f][j], f, y, wx, wy, psi));
  }
  _key_x_across(n: any = null, f: any = null, y: any = null, wx: any = null, wy: any = null, psi: any = null): any {
    let _: any, x: any;
    [x, _] = this.key_target(n.pitch, f, n);
    return this._rot((x - wx), (y - wy), (-psi))[0];
  }
  _find_gestures(): any {
    let _: any, a: any, amp: any, b: any, cut: any, f: any, g: any, gi: any, gs: any, hi: any, i: any, j: any, k: any, m: any, merged: any, n: any, ns: any, r: any, releases: any, rep: any, run: any, runs: any, sd: any, sep: any, so: any, strikes: any, t0: any, ts: any;
    // 
    //         Passages the wrist plays rather than the fingers:
    // 
    //         - repeated chords (two or more keys struck again, identically, within
    //           GESTURE_REPEAT_T): the hand drops onto each chord and springs back up
    //           between them (wrist bounce), the fingers staying close to the keys;
    //         - tremolos (two different key sets - notes or chords - alternating
    //           quickly, A B A B..., at least four strikes, their centres 3+
    //           semitones apart): the forearm rotates, the side that strikes going
    //           down each time.
    // 
    //         Kept as runs of strike times; `_gesture_at` turns them into the hand's
    //         lift, roll and how much the fingers still act on their own.
    //         
    so = this.start_of;
    gs = Array.from(pyIter(this.groups)).map(([_0, ns]: any) => [pyMin(Array.from(pyIter(ns)).map((n: any) => so[pyId(n)])), [...pySorted(Array.from(pyIter(ns)).map((n: any) => n.pitch), null, false)], ns]);
    [this.bounce_runs, this.roll_runs] = [[], []];
    rep = pyMult([false], (gs).length);
    for (i = 1; i < (gs).length; i += 1) {
      if (((((gs[i][1]).length >= 2)) && ((pyEq(gs[i][1], gs[(i - 1)][1]))) && (((gs[i][0] - gs[(i - 1)][0]) < GESTURE_REPEAT_T)))) {
        rep[i] = rep[(i - 1)] = true;
      }
    }
    run = [];
    for ([i, g] of pyIter(enumerate(gs))) {
      if ((bool(rep[i]) && bool(run) && (((g[0] - gs[run[run.length - 1]][0]) < GESTURE_REPEAT_T)))) {
        run.push(i);
      } else {
        if (((run).length >= 3)) {
          this.bounce_runs.push(run);
        }
        run = (bool(rep[i]) ? [i] : []);
      }
    }
    if (((run).length >= 3)) {
      this.bounce_runs.push(run);
    }
    const centre = (ps: any = null): any => {
      return ((Array.from(pyIter(ps)).map((p: any) => this.vp(p))).reduce((a: any, b: any) => a + b, 0) / (ps).length);
    };
    i = 0;
    while ((pyAdd(i, 3) < (gs).length)) {
      [a, b] = [gs[i][1], gs[pyAdd(i, 1)][1]];
      if ((((pyNotEq(a, b))) && ((!bool(pyBitAnd(new Set(a), new Set(b))))) && ((Math.abs((centre(a) - centre(b))) >= 3)) && (((gs[pyAdd(i, 1)][0] - gs[i][0]) < GESTURE_TREMOLO_T)))) {
        j = pyAdd(i, 1);
        while ((((pyAdd(j, 1) < (gs).length)) && ((pyEq(gs[pyAdd(j, 1)][1], gs[(j - 1)][1]))) && (((gs[pyAdd(j, 1)][0] - gs[j][0]) < GESTURE_TREMOLO_T)))) {
          j = pyAugAdd(j, 1);
        }
        if ((pyAdd((j - i), 1) >= 4)) {
          hi = ((centre(a) > centre(b)) ? a : b);
          sep = Math.abs((centre(a) - centre(b)));
          amp = pyAdd(0.55, pyMult(0.45, pyMin(1.0, (sep / 12.0))));
          this.roll_runs.push([Array.from(pyIter(pyRange(i, pyAdd(j, 1)))).map((k: any) => gs[k][0]), Array.from(pyIter(pyRange(i, pyAdd(j, 1)))).map((k: any) => ((pyEq(gs[k][1], hi)) ? 1.0 : (-1.0))), amp]);
          i = pyAdd(j, 1);
          continue;
        }
      }
      i = pyAugAdd(i, 1);
    }
    merged = [];
    for (r of pyIter(this.roll_runs)) {
      if ((bool(merged) && (((r[0][0] - merged[merged.length - 1][0][merged[merged.length - 1][0].length - 1]) < GESTURE_TREMOLO_T)))) {
        [ts, sd, amp] = merged[merged.length - 1];
        merged[merged.length - 1] = [pyAdd(ts, r[0]), pyAdd(sd, r[1]), pyMax(amp, r[2])];
      } else {
        merged.push(r);
      }
    }
    this.roll_runs = merged;
    merged = [];
    for (r of pyIter(this.bounce_runs)) {
      if ((bool(merged) && (((gs[r[0]][0] - gs[merged[merged.length - 1][merged[merged.length - 1].length - 1]][0]) < GESTURE_REPEAT_T)))) {
        merged[merged.length - 1] = pyAdd(merged[merged.length - 1], r);
      } else {
        merged.push(r);
      }
    }
    runs = [];
    for (r of pyIter(merged)) {
      [strikes, releases] = [[], []];
      for ([k, gi] of pyIter(enumerate(r))) {
        [t0, _, ns] = gs[gi];
        if ((pyAdd(k, 1) < (r).length)) {
          cut = pyAdd(t0, pyMult(this.bounce_release, (gs[r[pyAdd(k, 1)]][0] - t0)));
          for (n of pyIter(ns)) {
            f = this.fingering[pyId(n)];
            for ([j, m] of pyIter(enumerate(this.by_finger[f]))) {
              if ((m === n)) {
                this.finger_ends[f][j] = pyMax(pyAdd(this.finger_starts[f][j], 0.001), pyMin(this.finger_ends[f][j], cut));
                break;
              }
            }
          }
        }
        strikes.push(t0);
        releases.push(pyMin(Array.from(pyIter(ns)).map((n: any) => this.finger_ends[this.fingering[pyId(n)]][next(Array.from(pyIter(enumerate(this.by_finger[this.fingering[pyId(n)]]))).filter(([j, m]: any) => (m === n)).map(([j, m]: any) => j))])));
      }
      runs.push([strikes, releases]);
    }
    this.bounce_runs = runs;
    if (bool(runs)) {
      this.performance = Array.from(pyIter(pyItems(this.by_finger))).flatMap(([f, ns]: any) => Array.from(pyIter(enumerate(ns))).map(([i, n]: any) => [this.finger_starts[f][i], this.finger_ends[f][i], n]));
      this.performance = pyAugAdd(this.performance, this._gliss_performance());
    }
    this._bounce_starts = Array.from(pyIter(this.bounce_runs)).map((r: any) => r[0][0]);
    this._roll_starts = Array.from(pyIter(this.roll_runs)).map((r: any) => r[0][0]);
  }
  _gesture_at(t: any = null): any {
    let k: any, kk: any, l_: any, lift: any, r_: any, roll: any, w: any, w_: any;
    // (lift in pixels, roll in radians (+: little-finger side down), 0..1 how much the wrist is playing).
    [lift, roll, w] = [0.0, 0.0, 0.0];
    if ((bool(this.bounce_runs) && ((this.bounce_in > 0)))) {
      k = (bisectRight(this._bounce_starts, pyAdd(t, 0.3)) - 1);
      for (kk of pyIter([(k - 1), k])) {
        if ((kk < 0)) {
          continue;
        }
        [l_, w_] = this._bounce_one(this.bounce_runs[kk], t);
        lift = pyAugAdd(lift, l_);
        w = pyMax(w, w_);
      }
    }
    if ((bool(this.roll_runs) && ((this.roll_max > 0)))) {
      k = (bisectRight(this._roll_starts, pyAdd(t, 0.25)) - 1);
      for (kk of pyIter([(k - 1), k])) {
        if ((kk < 0)) {
          continue;
        }
        [r_, w_] = this._roll_one(this.roll_runs[kk], t);
        roll = pyAugAdd(roll, r_);
        w = pyMax(w, w_);
      }
    }
    return [lift, roll, pyMin(1.0, w)];
  }
  _bounce_one(run: any = null, t: any = null): any {
    let age: any, gap: any, i: any, rel: any, top: any, ts: any, v: any, w: any, x: any;
    // (lift px, weight): the hand springs up once a chord is let go and drops onto the next.
    [ts, rel] = run;
    if (bool((!(((ts[0] - 0.3) <= t) && (t <= pyAdd(rel[rel.length - 1], 0.45)))))) {
      return [0.0, 0.0];
    }
    i = (bisectRight(ts, t) - 1);
    top = ((gap) => pyMult(pyMult(this.bounce_in, this.ppi), pyMin(1.0, pyAdd(0.25, (gap / 0.12)))));
    if ((i < 0)) {
      gap = pyMax(0.05, (((ts).length < 2) ? (rel[0] - ts[0]) : (ts[1] - rel[0])));
      x = pyMin(1.0, ((ts[0] - t) / gap));
      w = _smooth((1.0 - ((ts[0] - t) / 0.3)));
      return [pyMult(pyMult(top(gap), Math.sin(pyMult(pyMult(0.5, Math.PI), x))), w), w];
    }
    if ((t < rel[i])) {
      return [0.0, 1.0];
    }
    if ((i >= ((ts).length - 1))) {
      age = (t - rel[rel.length - 1]);
      w = (1.0 - _smooth((age / 0.45)));
      gap = (((ts).length > 1) ? pyMax(0.05, (ts[ts.length - 1] - rel[rel.length - 2])) : 0.1);
      return [pyMult(pyMult(top(gap), Math.sin(pyMult(Math.PI, pyMin(0.5, (age / gap))))), w), w];
    }
    gap = pyMax(0.001, (ts[pyAdd(i, 1)] - rel[i]));
    v = ((t - rel[i]) / gap);
    return [pyMult(top(gap), Math.sin(pyMult(Math.PI, Math.pow(v, 0.7)))), 1.0];
  }
  _roll_one(run: any = null, t: any = null): any {
    let R: any, amp: any, c: any, f: any, i: any, sides: any, ts: any, u: any;
    [ts, sides, amp] = run;
    if (bool((!(((ts[0] - 0.25) <= t) && (t <= pyAdd(ts[ts.length - 1], 0.35)))))) {
      return [0.0, 0.0];
    }
    R = pyMult(this.roll_max, amp);
    i = (bisectRight(ts, t) - 1);
    if ((i < 0)) {
      f = _smooth((1.0 - ((ts[0] - t) / 0.25)));
      return [pyMult(pyMult(sides[0], R), f), f];
    }
    if ((i >= ((ts).length - 1))) {
      f = (1.0 - _smooth(((t - ts[ts.length - 1]) / 0.35)));
      return [pyMult(pyMult(sides[sides.length - 1], R), f), f];
    }
    u = ((t - ts[i]) / (ts[pyAdd(i, 1)] - ts[i]));
    c = pyMult(0.5, pyAdd(1.0, Math.cos(pyMult(Math.PI, Math.pow(u, 1.8)))));
    return [pyMult(R, pyAdd(pyMult(sides[i], c), pyMult(sides[pyAdd(i, 1)], (1.0 - c)))), 1.0];
  }
  _press_amount(f: any = null, t: any = null): any {
    let ends: any, i: any, starts: any;
    // 0..1 how far finger f has its key down: ramping in on the strike, out as the key rises.
    [starts, ends] = [this.finger_starts[f], this.finger_ends[f]];
    i = (bisectRight(starts, t) - 1);
    if ((i < 0)) {
      return 0.0;
    }
    if ((t < ends[i])) {
      return pyMin(1.0, ((t - starts[i]) / PRESS_T));
    }
    return pyMax(0.0, (1.0 - _smooth(((t - ends[i]) / GESTURE_KEY_UP_T))));
  }
  _near_note(f: any = null, t: any = null, win: any = null): any {
    let ends: any, i: any, starts: any;
    // Finger f has a note within win seconds (before or after t).
    [starts, ends] = [this.finger_starts[f], this.finger_ends[f]];
    i = (bisectRight(starts, t) - 1);
    if ((((i >= 0)) && (((t - ends[i]) < win)))) {
      return true;
    }
    return (((pyAdd(i, 1) < (starts).length)) && (((starts[pyAdd(i, 1)] - t) < win)));
  }
  _key_weight(f: any = null, t: any = null): any {
    let best: any, ends: any, i: any, note: any, starts: any, w: any;
    // (0..1, note) how much finger f's key must be reachable at t: 1 while held, ramping around the strike and release.
    [starts, ends] = [this.finger_starts[f], this.finger_ends[f]];
    i = (bisectRight(starts, t) - 1);
    [best, note] = [0.0, null];
    if ((i >= 0)) {
      w = ((t < ends[i]) ? 1.0 : Math.pow((1.0 - _smooth(((t - ends[i]) / KEY_FIX_RELEASE_T))), 2));
      if ((w > 0)) {
        [best, note] = [w, this.by_finger[f][i]];
      }
    }
    if ((pyAdd(i, 1) < (starts).length)) {
      w = Math.pow(_smooth((1.0 - ((starts[pyAdd(i, 1)] - t) / KEY_FIX_T))), 2);
      if ((w > best)) {
        [best, note] = [w, this.by_finger[f][pyAdd(i, 1)]];
      }
    }
    return [best, note];
  }
  _limited_at(t: any = null): any {
    let a: any, b: any, g: any, k: any, u: any;
    // 
    //         The hand (wx, wy, psi) at t as it is drawn: placed (_placed_at),
    //         fitted to its keys (_key_fix) and then held to the top speed. On its
    //         grid (LIMIT_GRID_T), each step may move the wrist plus the fingertips' swing
    //         about it (turn times TIP_ARM_IN) at most the top speed allows; the
    //         schedule already keeps to it, so this only trims what the solver's
    //         own corrections add. Steps follow on from the one before (cached);
    //         after a seek the chain restarts LIMIT_RESTART_T earlier, long enough
    //         for any lag to have settled. The limited path is then averaged over
    //         +-LIMIT_SMOOTH_HAND steps (triangular, so without delay), which
    //         rounds off the corners where the limit or the key fit kicks in.
    //         Between grid points: linear.
    //         
    g = LIMIT_GRID_T;
    k = Math.floor((t / g));
    [a, b] = [this._smooth_hand_grid(k), this._smooth_hand_grid(pyAdd(k, 1))];
    u = ((t / g) - k);
    return [...Array.from(pyIter(zip(a, b))).map(([x, y]: any) => pyAdd(x, pyMult((y - x), u)))];
  }
  _smooth_hand_grid(k: any = null): any {
    let cache: any, narrow: any, on: any, q: any, wide: any;
    cache = this._smooth_hand_cache;
    q = pyGet(cache, k, null);
    if ((q === null)) {
      if (((cache).length > 20000)) {
        pyClear(cache);
      }
      const avg = (n: any = null): any => {
        let acc: any, d: any, v: any, w: any, ws: any;
        [acc, ws] = [[0.0, 0.0, 0.0], 0.0];
        for (d = (-n); d < pyAdd(n, 1); d += 1) {
          w = (pyAdd(n, 1) - Math.abs(d));
          v = this._limited_grid(pyAdd(k, d));
          acc = Array.from(pyIter(zip(acc, v))).map(([a, x]: any) => pyAdd(a, pyMult(w, x)));
          ws = pyAugAdd(ws, w);
        }
        return Array.from(pyIter(acc)).map((a: any) => (a / ws));
      };
      on = pyMax(Array.from(pyIter(pyRange(1, 6))).map((f: any) => this._key_weight(f, pyMult(k, LIMIT_GRID_T))[0]));
      [wide, narrow] = [avg(LIMIT_SMOOTH_HAND), avg(LIMIT_SMOOTH_HAND_ON)];
      q = [...Array.from(pyIter(zip(wide, narrow))).map(([a, b]: any) => _lerp(a, b, on))];
      cache[k] = q;
    }
    return q;
  }
  _tips_at(t: any = null, hand: any = null): any {
    let _: any, busy: any, comp: any, f: any, local: any, low: any, psi: any, rb: any, rot: any, rx: any, ry: any, shaped: any, tips: any, wx: any, wy: any;
    // 
    //         {finger: (x, y, z)} fingertip targets at t for the hand at `hand`
    //         (wx, wy, psi): first with the plain rest spots, then again with rest
    //         spots shaped around the busy fingers; each kept inside its finger's
    //         range (_limit_tip).
    //         
    [wx, wy, psi] = hand;
    rot = this._rot;
    const to_world_xy = (lx: any = null, ly: any = null): any => {
      let x: any, y: any;
      [x, y] = rot(lx, ly, psi);
      return [pyAdd(wx, x), pyAdd(wy, y)];
    };
    [tips, busy, local] = [{  }, {  }, {  }];
    rb = this.retract_back;
    for (f = 1; f < 6; f += 1) {
      [rx, ry] = this.rest_local[f];
      [tips[f], busy[f]] = this._tip_target(f, t, to_world_xy(rx, (ry - rb[f])), hand);
      local[f] = rot((tips[f][0] - wx), (tips[f][1] - wy), (-psi));
    }
    shaped = this._shaped_rests(busy, local);
    [comp, low] = [this._run_w(t), this._low(t)];
    for (f = 1; f < 6; f += 1) {
      if ((busy[f] < 1.0)) {
        [tips[f], _] = this._tip_target(f, t, to_world_xy(shaped[f][0], (shaped[f][1] - rb[f])), hand);
      }
    }
    tips = this._tendon_pull(tips, t);
    for (f = 1; f < 6; f += 1) {
      tips[f] = this._limit_tip(f, tips[f], wx, wy, psi, comp, this._key_weight(f, t)[0], low);
    }
    return this._separate(tips, wx, wy, psi, t, comp);
  }
  _thumb_bridge(t: any = null, pts: any = null): any {
    let S: any, a_: any, bridged: any, cands: any, cmc: any, cx: any, cy: any, d: any, dx: any, dy: any, h: any, ip: any, k: any, l1: any, l2: any, l3: any, mcp: any, mx: any, my: any, mz: any, n: any, near: any, pk: any, q: any, r: any, side: any, tip: any, ux: any, uy: any, w: any;
    // 
    //         The thumb chain `pts` (CMC, MCP, IP, tip), laid across two black keys
    //         when it plays a pair of them (_bridge_pair) - not pointing up the
    //         keys between them as if playing the white keys there. The thumb is
    //         straight from its MCP joint to the tip (no bend at the IP joint), the
    //         tip on the far key, lying as nearly along the keyboard as its base
    //         lets it so its side is on the near key too; only the MCP joint
    //         angles. Blended in by how firmly the thumb is on (or about to be on)
    //         that pair (_key_weight).
    //         
    [w, n] = this._key_weight(1, t);
    if ((bool((n === null)) ? ((n === null)) : ((w <= 0.0)))) {
      return pts;
    }
    pk = pyGet(this.pair_key, pyId(n), null);
    if ((bool((!bool(pk))) ? ((!bool(pk))) : ((!bool(this._bridge_pair(pk, 1)))))) {
      return pts;
    }
    S = this.S;
    near = pyMax(Array.from(pyIter(pk)).map((p: any) => this.key_target(p, 1, n)[0]));
    [cmc, tip] = [pts[0], pts[3]];
    [l1, l2, l3] = Array.from(pyIter(this.geo.bones[1])).map((L: any) => pyMult(L, S));
    side = ((near >= tip[0]) ? 1.0 : (-1.0));
    mz = pyAdd(tip[2], pyMult(THUMB_BRIDGE_LIFT_IN, this.ppi));
    r = Math.sqrt(pyMax(1e-06, (Math.pow(pyAdd(l2, l3), 2) - Math.pow((mz - tip[2]), 2))));
    q = Math.sqrt(pyMax(1e-06, (Math.pow(l1, 2) - Math.pow((cmc[2] - mz), 2))));
    [dx, dy] = [(cmc[0] - tip[0]), (cmc[1] - tip[1])];
    d = pyMax(1e-06, Math.hypot(dx, dy));
    [ux, uy] = [(dx / d), (dy / d)];
    if ((bool((d >= pyAdd(r, q))) ? ((d >= pyAdd(r, q))) : ((d <= Math.abs((r - q)))))) {
      [mx, my] = [pyAdd(tip[0], pyMult(ux, r)), pyAdd(tip[1], pyMult(uy, r))];
    } else {
      a_ = (pyAdd((pyMult(r, r) - pyMult(q, q)), pyMult(d, d)) / pyMult(2, d));
      h = Math.sqrt(pyMax(0.0, (pyMult(r, r) - pyMult(a_, a_))));
      [cx, cy] = [pyAdd(tip[0], pyMult(ux, a_)), pyAdd(tip[1], pyMult(uy, a_))];
      cands = [[(cx - pyMult(uy, h)), pyAdd(cy, pyMult(ux, h))], [pyAdd(cx, pyMult(uy, h)), (cy - pyMult(ux, h))]];
      [mx, my] = pyMax(cands, ((c) => (pyMult(side, (c[0] - tip[0])) - Math.abs((c[1] - tip[1])))));
    }
    mcp = [mx, my, mz];
    k = (l3 / pyAdd(l2, l3));
    ip = [...Array.from(pyIter(zip(tip, mcp))).map(([tv, mv]: any) => pyAdd(tv, pyMult((mv - tv), k)))];
    bridged = [cmc, mcp, ip, tip];
    return Array.from(pyIter(zip(pts, bridged))).map(([p, q_]: any) => [...Array.from(pyIter(zip(p, q_))).map(([a, b]: any) => _lerp(a, b, w))]);
  }
  _hover(f: any = null): any {
    // Fingertip f's resting height (world z) over the keys.
    return pyAdd(pyMult(HOVER[f], this.S), pyMult(pyMult(this.retract_up_in, this.ppi), ((pyEq(f, 1)) ? 0.5 : 1.0)));
  }
  _tendon_pull(tips: any = null, t: any = null): any {
    let d: any, down: any, f: any, floor: any, free: any, h: any, lead: any, out: any, x: any, y: any, z: any;
    // 
    //         Linked tendons (TENDON_FOLLOWERS): 3 curving down takes 4 with it, 4
    //         takes 3, and 5 takes both - by `self.tendon` of how far down the leader
    //         is (0 hovering, 1 at the key tops), toward TENDON_FLOOR_IN, the deepest
    //         leader counting; a follower reaching for a key of its own (_reaching)
    //         is free of it.
    //         
    if ((this.tendon <= 0.0)) {
      return tips;
    }
    down = {  };
    for (lead of pyIter(TENDON_FOLLOWERS)) {
      h = this._hover(lead);
      down[lead] = ((h > 0) ? pyMin(1.0, pyMax(0.0, ((h - tips[lead][2]) / h))) : 0.0);
    }
    floor = pyMult(TENDON_FLOOR_IN, this.ppi);
    out = { ...tips };
    for (f of pyIter([3, 4])) {
      d = pyMax(Array.from(pyIter(pyItems(TENDON_FOLLOWERS))).filter(([lead, fol]: any) => (pyIn(f, fol))).map(([lead, fol]: any) => down[lead]));
      [x, y, z] = tips[f];
      if ((bool((d <= 0.0)) ? ((d <= 0.0)) : ((z <= floor)))) {
        continue;
      }
      free = (1.0 - this._reaching(f, t));
      if ((free > 0.0)) {
        out[f] = [x, y, (z - pyMult(pyMult(pyMult(this.tendon, d), free), (z - floor)))];
      }
    }
    return out;
  }
  _reaching(f: any = null, t: any = null): any {
    let _: any, i: any, prep_start: any, starts: any, strike_start: any;
    // 0..1: how much finger f is busy with a key of its own - 1 while it presses one, rising with its trip to the next.
    if (bool(this._pressing(f, t))) {
      return 1.0;
    }
    starts = this.finger_starts[f];
    i = (bisectRight(starts, t) - 1);
    if ((pyAdd(i, 1) >= (starts).length)) {
      return 0.0;
    }
    [prep_start, strike_start, _] = this._prep_window(f, i);
    if ((t >= strike_start)) {
      return 1.0;
    }
    if ((t <= prep_start)) {
      return 0.0;
    }
    return this._travel(f, i, t)[0];
  }
  _limited_tips(t: any = null): any {
    let a: any, b: any, g: any, k: any, u: any;
    // 
    //         {finger: (x, y, z)} fingertips at t: _tips_at on the hand grid, held
    //         to the top speed across the keys like the hand (_limited_at); linear
    //         between grid points.
    //         
    g = LIMIT_GRID_T;
    k = Math.floor((t / g));
    [a, b] = [this._smooth_tip_grid(k), this._smooth_tip_grid(pyAdd(k, 1))];
    u = ((t / g) - k);
    return Object.fromEntries(Array.from(pyIter(a)).map((f: any) => [f, [...Array.from(pyIter(zip(a[f], b[f]))).map(([x, y]: any) => pyAdd(x, pyMult((y - x), u)))]]));
  }
  _smooth_tip_grid(k: any = null): any {
    let cache: any, f: any, grids: any, mid: any, n: any, q: any, ws: any;
    // 
    //         _limited_tip_grid averaged across the keys over +-LIMIT_SMOOTH_TIPS
    //         steps (height as it is), for fingers in the air - one holding its
    //         key stays exactly on it.
    //         
    cache = this._smooth_tip_cache;
    q = pyGet(cache, k, null);
    if ((q === null)) {
      if (((cache).length > 20000)) {
        pyClear(cache);
      }
      n = LIMIT_SMOOTH_TIPS;
      grids = Array.from(pyIter(pyRange((-n), pyAdd(n, 1)))).map((d: any) => [(pyAdd(n, 1) - Math.abs(d)), this._limited_tip_grid(pyAdd(k, d))]);
      ws = (Array.from(pyIter(grids)).map(([w, _0]: any) => w)).reduce((a: any, b: any) => a + b, 0);
      mid = grids[n][1];
      q = {  };
      cache[k] = q;
      for (f of pyIter(mid)) {
        if (bool(this._pressing(f, pyMult(k, LIMIT_GRID_T)))) {
          q[f] = mid[f];
        } else {
          q[f] = [((Array.from(pyIter(grids)).map(([w, g_]: any) => pyMult(w, g_[f][0]))).reduce((a: any, b: any) => a + b, 0) / ws), ((Array.from(pyIter(grids)).map(([w, g_]: any) => pyMult(w, g_[f][1]))).reduce((a: any, b: any) => a + b, 0) / ws), mid[f][2]];
        }
      }
    }
    return q;
  }
  _limited_tip_grid(k: any = null): any {
    let _: any, cache: any, d: any, f: any, g: any, j: any, prev: any, px: any, py: any, q: any, step: any, tips: any, todo: any, x: any, y: any, z: any;
    cache = this._tip_limit_cache;
    if ((pyIn(k, cache))) {
      return cache[k];
    }
    if (((cache).length > 20000)) {
      pyClear(cache);
    }
    g = LIMIT_GRID_T;
    step = pyMult(pyMult((this.max_speed / 0.0254), this.ppi), g);
    [j, todo] = [k, []];
    while (((((!pyIn(j, cache)))) && (((todo).length < Math.trunc((LIMIT_RESTART_T / g)))))) {
      todo.push(j);
      j -= 1;
    }
    prev = pyGet(cache, j, null);
    for (j of pyIter(reversed(todo))) {
      tips = this._tips_at(pyMult(j, g), this._smooth_hand_grid(j));
      q = {  };
      for ([f, [x, y, z]] of pyIter(pyItems(tips))) {
        if ((prev !== null)) {
          [px, py, _] = prev[f];
          d = Math.hypot((x - px), (y - py));
          if ((d > step)) {
            [x, y] = [pyAdd(px, (pyMult((x - px), step) / d)), pyAdd(py, (pyMult((y - py), step) / d))];
          }
        }
        q[f] = [x, y, z];
      }
      prev = q;
      cache[j] = prev;
    }
    return prev;
  }
  _limited_grid(k: any = null): any {
    let arm: any, cache: any, dp: any, dx: any, dy: any, g: any, j: any, k_: any, move: any, prev: any, q: any, step: any, todo: any, tt: any;
    cache = this._limit_cache;
    if ((pyIn(k, cache))) {
      return cache[k];
    }
    if (((cache).length > 20000)) {
      pyClear(cache);
    }
    g = LIMIT_GRID_T;
    step = pyMult(pyMult((this.max_speed / 0.0254), this.ppi), g);
    arm = pyMult(TIP_ARM_IN, this.ppi);
    j = k;
    todo = [];
    while (((((!pyIn(j, cache)))) && (((todo).length < Math.trunc((LIMIT_RESTART_T / g)))))) {
      todo.push(j);
      j -= 1;
    }
    prev = pyGet(cache, j, null);
    for (j of pyIter(reversed(todo))) {
      tt = pyMult(j, g);
      q = this._key_fix(tt, ...this._placed_at(tt));
      if ((prev !== null)) {
        [dx, dy, dp] = [(q[0] - prev[0]), (q[1] - prev[1]), (q[2] - prev[2])];
        move = pyAdd(Math.hypot(dx, dy), pyMult(Math.abs(dp), arm));
        if ((move > step)) {
          k_ = (step / move);
          q = [pyAdd(prev[0], pyMult(dx, k_)), pyAdd(prev[1], pyMult(dy, k_)), pyAdd(prev[2], pyMult(dp, k_))];
        }
      }
      prev = q;
      cache[j] = prev;
    }
    return prev;
  }
  _key_fix(t: any = null, wx: any = null, wy: any = null, psi: any = null): any {
    let A: any, _: any, arm: any, cn: any, cols: any, comp: any, cons: any, cost: any, d: any, dm: any, dq: any, dz: any, eps: any, f: any, g: any, hi: any, hmax: any, hmin: any, i: any, j: any, kx: any, ky: any, l1: any, l2: any, l3: any, lo: any, low: any, m: any, mx: any, my: any, n: any, nx: any, pk: any, py: any, q: any, qn: any, qq: any, r0: any, reach: any, rn: any, tr: any, tw: any, w: any, yhi: any, ylo: any, ys: any;
    // 
    //         The smoothed hand (wx, wy, psi), moved and turned as little as it
    //         takes for every finger holding a key (or about to strike one, see
    //         _key_weight) to reach it within its splay and reach limits, so
    //         _limit_tip never has to pull a fingertip off its key.
    //         
    cons = [];
    [comp, low] = [this._run_w(t), this._low(t)];
    [tw, tr] = this._trem_w(t);
    for (f = 1; f < 6; f += 1) {
      [w, n] = this._key_weight(f, t);
      if ((tw > 0.0)) {
        m = this._trem_note(f, t, tr);
        if ((((m !== null)) && ((bool((n === null)) ? ((n === null)) : ((((pyEq(n.pitch, m.pitch))) && ((w < tw)))))))) {
          [w, n] = [((n === null) ? tw : pyMax(w, tw)), m];
        }
      }
      if ((bool((n === null)) ? ((n === null)) : ((!bool(this._has_key(this._pk(n))))))) {
        continue;
      }
      [kx, ky] = this.key_target(this._pk(n), f, n);
      [ylo, yhi] = this._key_depths(this._pk(n));
      ys = pySorted(pyAdd([ky], Array.from(pyIter(pyRange(13))).map((i: any) => pyAdd(ylo, (pyMult((yhi - ylo), i) / 12)))), ((y) => Math.abs((y - ky))), false);
      [lo, hi] = this._splay_at(f, comp);
      m = (((KEY_FIX_MARGIN_DEG) * Math.PI / 180.0) - (bool(this._pressing(f, t)) ? ((PRESS_SLACK_DEG[f]) * Math.PI / 180.0) : 0.0));
      [hmin, hmax] = this._reach_range(f, pyAdd(pyMult(this.base_local[f][2], low), this.travel), 0.99);
      dm = pyMult(KEY_FIX_MARGIN, this.length[f]);
      cons.push([kx, ys, this.base_local[f], pyAdd(lo, m), (hi - m), pyAdd(hmin, dm), (hmax - dm), pyMult(KEY_FIX_K, w)]);
      pk = this._pk(n);
      if ((((pyEq(f, 1))) && bool(this._bridge_pair(pk, 1)))) {
        nx = pyMax(Array.from(pyIter(pk)).map((p: any) => this.key_target(p, 1, n)[0]));
        py = pyAdd((this.kb.rect.h - this.kb.black_h), pyMult(THUMB_BRIDGE_NEAR_IN, this.ppi));
        [l1, l2, l3] = Array.from(pyIter(this.geo.bones[1])).map((L: any) => pyMult(L, this.S));
        d = pyMax(1e-06, Math.hypot((nx - kx), (py - ky)));
        [mx, my] = [pyAdd(kx, (pyMult((nx - kx), pyAdd(l2, l3)) / d)), pyAdd(ky, (pyMult((py - ky), pyAdd(l2, l3)) / d))];
        dz = pyAdd(pyMult(this.base_local[1][2], low), this.travel);
        reach = Math.sqrt(pyMax(0.0, (pyMult(l1, l1) - pyMult(dz, dz))));
        cons.push([mx, [my], this.base_local[1], (-Math.PI), Math.PI, 0.0, reach, pyMult(pyMult(THUMB_BRIDGE_FIX_K, KEY_FIX_K), w)]);
      }
    }
    if (bool((!bool(cons)))) {
      return [wx, wy, psi];
    }
    arm = pyMult(3.0, this.S);
    arm *= pyAdd(1.0, pyMult((RUN_TURN_STIFF - 1.0), comp));
    const residuals = (q: any = null): any => {
      let _: any, a: any, best: any, blx: any, bly: any, c: any, dx: any, dy: any, ea: any, eh: any, h: any, hi: any, hmax: any, hmin: any, k: any, kx: any, ky: any, lo: any, lx: any, ly: any, out: any, p: any, s_: any, x: any, y: any, ys: any;
      [x, y, p] = q;
      [c, s_] = [Math.cos(p), Math.sin(p)];
      out = [(x - wx), (y - wy), pyMult(arm, (p - psi))];
      for ([kx, ys, [blx, bly, _], lo, hi, hmin, hmax, k] of pyIter(cons)) {
        best = null;
        for (ky of pyIter(ys)) {
          dx = (kx - (pyAdd(x, pyMult(blx, c)) - pyMult(bly, s_)));
          dy = (ky - pyAdd(pyAdd(y, pyMult(blx, s_)), pyMult(bly, c)));
          [lx, ly] = [pyAdd(pyMult(dx, c), pyMult(dy, s_)), pyAdd(pyMult((-dx), s_), pyMult(dy, c))];
          [a, h] = [Math.atan2(lx, ly), Math.hypot(lx, ly)];
          ea = pyMult(h, pyAdd(pyMax(0.0, (a - hi)), pyMin(0.0, (a - lo))));
          eh = pyAdd(pyMax(0.0, (h - hmax)), pyMin(0.0, (h - hmin)));
          if ((bool((best === null)) ? ((best === null)) : ((pyAdd(pyMult(ea, ea), pyMult(eh, eh)) < (best[0] - 1e-09))))) {
            best = [pyAdd(pyMult(ea, ea), pyMult(eh, eh)), ea, eh];
          }
        }
        out = pyAugAdd(out, [pyMult(k, best[1]), pyMult(k, best[2])]);
      }
      return out;
    };
    q = [wx, wy, psi];
    r0 = residuals(q);
    cost = (Array.from(pyIter(r0)).map((v: any) => pyMult(v, v))).reduce((a: any, b: any) => a + b, 0);
    eps = [0.5, 0.5, 0.001];
    for (_ = 0; _ < KEY_FIX_ITERS; _ += 1) {
      if (((Array.from(pyIter(r0.slice(3))).map((v: any) => pyMult(v, v))).reduce((a: any, b: any) => a + b, 0) < 1e-06)) {
        break;
      }
      cols = [];
      for (j = 0; j < 3; j += 1) {
        qq = [...q];
        qq[j] = pyAugAdd(qq[j], eps[j]);
        cols.push(Array.from(pyIter(zip(residuals(qq), r0))).map(([a, b]: any) => ((a - b) / eps[j])));
      }
      A = _gram(cols);
      g = Array.from(pyIter(pyRange(3))).map((i: any) => (-(map(((a: number, b: number) => a * b), cols[i], r0)).reduce((a: any, b: any) => a + b, 0)));
      for (i = 0; i < 3; i += 1) {
        A[i][i] *= pyAdd(1.0, GN_DAMPING);
      }
      dq = _solve3(A, g);
      for (_ = 0; _ < 6; _ += 1) {
        qn = Array.from(pyIter(pyRange(3))).map((i: any) => pyAdd(q[i], dq[i]));
        rn = residuals(qn);
        cn = (Array.from(pyIter(rn)).map((v: any) => pyMult(v, v))).reduce((a: any, b: any) => a + b, 0);
        if ((cn < cost)) {
          [q, r0, cost] = [qn, rn, cn];
          break;
        }
        dq = Array.from(pyIter(dq)).map((d: any) => pyMult(d, 0.5));
      }
    }
    return [...q];
  }
  _pressing(f: any = null, t: any = null): any {
    let i: any, starts: any;
    starts = this.finger_starts[f];
    i = (bisectRight(starts, t) - 1);
    return (((i >= 0)) && ((t < this.finger_ends[f][i])));
  }
  _set_behavior(p: any = null): any {
    let a_fing: any, a_hand: any, c: any, r: any;
    // Turn the pianist's behaviour settings into this animator's timings and sizes.
    [a_hand, a_fing] = [p.b('antic_hand'), p.b('antic_fingers')];
    this.antic_t = pyAdd(0.15, pyMult(0.5, a_hand));
    this.need_t = pyAdd(0.06, pyMult(0.18, a_hand));

    [this.prep_max_t, this.travel_share] = pianists.finger_lead(a_fing);
    this.prep_h = Object.fromEntries(Array.from(pyIter(pyItems(PREP))).map(([f, h]: any) => [f, pyMult(h, pyAdd(0.5, p.b('lift_height')))]));
    this.cross_turn = ((p.b('cross_turn')) * Math.PI / 180.0);
    this.cross_norm = ((CROSS_TURN_DEG) * Math.PI / 180.0);
    this.smooth_t = p.b('smoothness');
    this.early_lift = p.b('early_release');
    this.max_speed = Number(p.b('max_speed'));
    this.area_near = p.b('key_area_near');
    this.area_far = pyMax(pyAdd(this.area_near, 0.05), p.b('key_area_far'));
    this.roll_dt = p.b('roll_speed');
    this.cross_arc_in = pyAdd(0.5, pyMult(3.0, p.b('cross_height')));
    this.tendon = p.b('tendon_link');
    this.curl_k = curl_factor(p);
    c = p.b('finger_curve');
    this.curl_lift_in = (pyMult(0.6, (c - 0.4)) - 0.11);
    this.reach_bonus = (pyMult(0.09, pyMax(0.0, (0.4 - c))) / 0.4);
    r = p.b('retraction');
    this.retract_back_in = pyMult(1.4, r);
    this.retract_up_in = pyMult(0.7, r);
    this.curl_min = (1.0 - pyMult(0.55, r));
    this.bounce_in = pyMult(BOUNCE_MAX_IN, p.b('wrist_bounce'));
    this.bounce_release = (0.85 - pyMult(0.4, p.b('wrist_bounce')));
    this.roll_max = pyMult(((ROLL_MAX_DEG) * Math.PI / 180.0), p.b('tremolo_rotation'));
    this.gesture_act = p.b('gesture_finger_action');
  }
  _white_up(): any {
    let _: any, black: any, i: any, n: any, near: any, ns: any, out: any, so: any, t: any, times: any, up: any;
    // {id(note): 0..1} how far toward WHITE_UP_IN each white-key note is played: black keys near in time pull it up.
    so = this.start_of;
    times = Array.from(pyIter(this.groups)).map(([_0, ns]: any) => pyMin(Array.from(pyIter(ns)).map((n: any) => so[pyId(n)])));
    black = Array.from(pyIter(zip(times, this.groups))).filter(([t, [_0, ns]]: any) => Array.from(Array.from(pyIter(ns)).map((n: any) => is_black_key(n.pitch))).some(Boolean)).map(([t, [_0, ns]]: any) => t);
    out = {  };
    for ([t, [_, ns]] of pyIter(zip(times, this.groups))) {
      i = bisectLeft(black, t);
      near = pyMin(Array.from(pyIter([(i - 1), i])).filter((j: any) => ((0 <= j) && (j < (black).length))).map((j: any) => Math.abs((black[j] - t))), null, Infinity);
      up = _smooth(((WHITE_UP_FADE_T - near) / (WHITE_UP_FADE_T - WHITE_UP_T)));
      if ((up > 0)) {
        for (n of pyIter(ns)) {
          if (bool((!bool(is_black_key(n.pitch))))) {
            out[pyId(n)] = up;
          }
        }
      }
    }
    return out;
  }
  _jump_lift(n: any = null, nx: any = null): any {
    let d: any, k: any;
    // 
    //         How early a finger lets go of note n to play nx next: the pianist's
    //         early release for a real jump, scaled down for a short move (a step
    //         in the same voice stays legato, only lifting LEGATO_LIFT_T before).
    //         
    d = Math.abs((key_pos(this.vp(nx.pitch)) - key_pos(this.vp(n.pitch))));
    k = pyMin(1.0, pyMax(0.0, ((d - LEGATO_STEP_WK) / (JUMP_WK - LEGATO_STEP_WK))));
    return pyAdd(LEGATO_LIFT_T, pyMult((this.early_lift - LEGATO_LIFT_T), k));
  }
  _speed_schedule(): any {
    let _: any, at: any, chord: any, cons: any, delay: any, e: any, ends: any, exit_ts: any, exits: any, f: any, fe: any, floor: any, free: any, fs: any, gap: any, gi: any, gj: any, gl_starts: any, groups: any, i: any, j: any, k: any, kept: any, key: any, lead: any, m: any, n: any, need: any, ns: any, nxt: any, prev_of: any, prev_range: any, prev_s1: any, rng: any, s1: any, so: any, t_end: any, vps: any;
    // 
    //         Make the timeline keep to the top speed (pianist "max_speed"). Chord
    //         by chord: a finger moving to a new key must let go of its last one
    //         early enough to get there (fingering.travel_time) and drop onto it
    //         (STRIKE_MIN_T); when the
    //         whole hand has to move (its range for the last chord and this one
    //         don't meet), every key it still holds must be let go early enough
    //         for that. A key is held at least MIN_HOLD_T (or half the time to the
    //         new chord); if that leaves too little time the chord is struck late,
    //         by at most MAX_DELAY_T and never past the hand's next chord. The
    //         first chord after a glissando is reached from where the slide ended
    //         (_gliss_exits), in time to be there GLISS_ARRIVE_T before it.
    //         `self.lead` keeps the travel time each note needs, for _prep_window
    //         and _travel; `self.delayed` counts late chords.
    //         

    so = this.start_of;
    fe = Object.fromEntries(Array.from(pyIter(pyItems(this.by_finger))).flatMap(([f, ns]: any) => Array.from(pyIter(enumerate(ns))).map(([i, n]: any) => [pyId(n), this.finger_ends[f][i]])));
    prev_of = {  };
    for ([f, ns] of pyIter(pyItems(this.by_finger))) {
      for ([i, n] of pyIter(enumerate(ns))) {
        j = (i - 1);
        while ((((j >= 0)) && (((so[pyId(n)] - so[pyId(ns[j])]) < 0.01)))) {
          j -= 1;
        }
        prev_of[pyId(n)] = ((j >= 0) ? ns[j] : null);
      }
    }
    this.lead = {  };
    this.delayed = 0;
    prev_range = null;
    groups = this.groups;
    exits = this._gliss_exits();
    exit_ts = Array.from(pyIter(exits)).map((e: any) => e[0]);
    gl_starts = pySorted(Array.from(pyIter(this.gliss_eps)).map((ep: any) => this.gliss_start[pyId(ep[0][0])]), null, false);
    prev_s1 = (-Infinity);
    for ([gi, [_, ns]] of pyIter(enumerate(groups))) {
      s1 = pyMin(Array.from(pyIter(ns)).map((m: any) => so[pyId(m)]));
      nxt = ((pyAdd(gi, 1) < (groups).length) ? pyMin(Array.from(pyIter(groups[pyAdd(gi, 1)][1])).map((m: any) => so[pyId(m)])) : Infinity);
      vps = Array.from(pyIter(ns)).map((m: any) => this.vp(m.pitch));
      fs = Array.from(pyIter(ns)).map((m: any) => this.fingering[pyId(m)]);
      rng = fg.hand_range(vps, fs);
      cons = [];
      for (m of pyIter(ns)) {
        n = prev_of[pyId(m)];
        if ((((n !== null)) && ((pyNotEq(n.pitch, m.pitch))))) {
          need = fg.travel_time((key_pos(this.vp(m.pitch)) - key_pos(this.vp(n.pitch))), this.max_speed);
          this.lead[pyId(m)] = need;
          cons.push([n, pyAdd(STRIKE_MIN_T, need)]);
        }
      }
      gap = ((prev_range !== null) ? fg.range_gap(prev_range, rng) : 0.0);
      if ((gap > HAND_MOVE_TOL_WK)) {
        need = fg.travel_time(gap, this.max_speed);
        lead = pyAdd(STRIKE_MIN_T, need);
        for (m of pyIter(ns)) {
          this.lead[pyId(m)] = pyMax(pyGet(this.lead, pyId(m), 0.0), need);
        }
        chord = [...zip(vps, fs)];
        kept = [];
        for (gj of pyIter(pyRange((gi - 1), (-1), (-1)))) {
          if (((s1 - groups[gj][0]) > 4.0)) {
            break;
          }
          for (n of pyIter(groups[gj][1])) {
            if ((fe[pyId(n)] > (s1 - lead))) {
              key = [this.vp(n.pitch), this.fingering[pyId(n)]];
              if ((bool((pyIn(key[1], fs))) ? ((pyIn(key[1], fs))) : ((bool(Array.from(Array.from(pyIter(kept)).map((k: any) => (pyEq(k[1], key[1])))).some(Boolean)) ? (Array.from(Array.from(pyIter(kept)).map((k: any) => (pyEq(k[1], key[1])))).some(Boolean)) : ((fg.shape_cost(pyAdd(pyAdd(kept, [key]), chord)) >= fg.IMPOSSIBLE)))))) {
                cons.push([n, lead]);
              } else {
                kept.push(key);
              }
            }
          }
        }
      }
      prev_range = rng;
      delay = 0.0;
      for ([n, lead] of pyIter(cons)) {
        floor = pyAdd(so[pyId(n)], pyMin(MIN_HOLD_T, pyMult(0.5, pyMax(0.0, (s1 - so[pyId(n)])))));
        delay = pyMax(delay, (floor - (s1 - lead)));
      }
      k = (bisectRight(exit_ts, s1) - 1);
      if ((((k >= 0)) && ((exits[k][0] > prev_s1)))) {
        [t_end, at] = exits[k];
        need = fg.travel_time(fg.range_gap(at, rng), this.max_speed);
        delay = pyMax(delay, (pyAdd(pyAdd(t_end, need), GLISS_ARRIVE_T) - s1));
      }
      prev_s1 = s1;
      if ((delay > 0.0001)) {
        k = bisectRight(gl_starts, s1);
        free = ((k < (gl_starts).length) ? (gl_starts[k] - GLISS_RAMP_T) : Infinity);
        delay = pyMin(delay, MAX_DELAY_T, pyMax(0.0, ((nxt - 0.03) - s1)), pyMax(0.0, ((free - MIN_HOLD_T) - s1)));
        if ((delay > 0.0001)) {
          this.delayed = pyAugAdd(this.delayed, 1);
          for (m of pyIter(ns)) {
            so[pyId(m)] = pyAugAdd(so[pyId(m)], delay);
            e = fe[pyId(m)];
            fe[pyId(m)] = ((e <= free) ? pyMin(pyAdd(e, delay), free) : pyAdd(e, delay));
          }
          s1 = pyAugAdd(s1, delay);
        }
      }
      for ([n, lead] of pyIter(cons)) {
        floor = pyAdd(so[pyId(n)], pyMin(MIN_HOLD_T, pyMult(0.5, pyMax(0.0, (s1 - so[pyId(n)])))));
        fe[pyId(n)] = pyMax(floor, pyMin(fe[pyId(n)], (s1 - lead)), pyAdd(so[pyId(n)], 0.001));
      }
    }
    for ([f, ns] of pyIter(pyItems(this.by_finger))) {
      ns.sort((a: any, b: any) => { const ka = ((n) => so[pyId(n)]) ? (((n) => so[pyId(n)]))(a) : a; const kb = ((n) => so[pyId(n)]) ? (((n) => so[pyId(n)]))(b) : b; return ka < kb ? (false ? 1 : -1) : (ka > kb ? (false ? -1 : 1) : 0); });
      this.finger_starts[f] = Array.from(pyIter(ns)).map((n: any) => so[pyId(n)]);
      ends = Array.from(pyIter(ns)).map((n: any) => pyMax(fe[pyId(n)], pyAdd(so[pyId(n)], 0.001)));
      for (i = 0; i < ((ns).length - 1); i += 1) {
        if (((this.finger_starts[f][pyAdd(i, 1)] - this.finger_starts[f][i]) >= 0.01)) {
          ends[i] = pyMax(pyAdd(this.finger_starts[f][i], 0.001), pyMin(ends[i], this.finger_starts[f][pyAdd(i, 1)]));
        }
      }
      this.finger_ends[f] = ends;
    }
  }
  _roll_wide_chords(): any {
    let _: any, drawn: any, eo: any, f: any, fs: any, ft: any, gi: any, groups: any, k: any, latest: any, n: any, need: any, ns: any, order: any, over: any, pairs: any, pt: any, scale: any, so: any, too_wide: any, top: any;
    // 
    //         A chord this hand can't span is rolled from the bottom up, and the
    //         lower notes are let go as the hand moves on to the top ones (the pedal,
    //         if it's down, keeps them sounding): a note the top finger can't reach
    //         from is let go in time for the hand to stretch on to the top at its
    //         top speed, and the top note waits for that if the roll is quicker
    //         (never past the hand's next chord).
    //         

    scale = reach_scale(this.pianist.anatomy);
    [so, eo] = [this.start_of, this.end_of];
    drawn = {  };
    const reach = (f1: any = null, f2: any = null): any => {
      let a: any, b: any;
      [a, b] = [pyMin(f1, f2), pyMax(f1, f2)];
      return pyAdd(pyMult(fg.BASE_MAX_SPAN[[a, b]], scale[[a, b]]), 0.25);
    };
    const suspect = (f1: any = null, f2: any = null, d: any = null): any => {
      let a: any, b: any;
      // Near or past the drawn hand's reach for the pair (drawn_reach is a quick, cautious bound).
      [a, b] = [pyMin(f1, f2), pyMax(f1, f2)];
      if (((!pyIn([a, b], drawn)))) {
        drawn[[a, b]] = drawn_reach(this.geo, this.curl_lift_in, a, b);
      }
      return (d > (drawn[[a, b]] - ROLL_SUSPECT_WK));
    };
    const pos = (n: any = null): any => {
      let a: any, b: any, pk: any;
      // Where the note's finger is: between the two keys it covers, if a pair - the far one for a thumb bridge.
      pk = pyGet(this.pair_key, pyId(n), null);
      if (bool(pk)) {
        [a, b] = [key_pos(this.vp(pk[0])), key_pos(this.vp(pk[1]))];
        if (bool(this._bridge_pair(pk, this.fingering[pyId(n)]))) {
          return pyMin(a, b);
        }
        return (pyAdd(a, b) / 2);
      }
      return key_pos(this.vp(n.pitch));
    };
    groups = this.groups;
    for ([gi, [_, ns]] of pyIter(enumerate(groups))) {
      if (((ns).length < 2)) {
        continue;
      }
      fs = Array.from(pyIter(ns)).map((n: any) => [pos(n), this.fingering[pyId(n)], n]);
      pairs = Array.from(pyIter(enumerate(fs))).flatMap(([i, [p1, f1, _0]]: any) => Array.from(pyIter(fs.slice(pyAdd(i, 1)))).filter(([p2, f2, _0]: any) => (pyNotEq(f1, f2))).map(([p2, f2, _0]: any) => [Math.abs((p2 - p1)), f1, f2]));
      too_wide = Array.from(Array.from(pyIter(pairs)).map(([d, f1, f2]: any) => (d > pyAdd(reach(f1, f2), ROLL_PLAN_SLACK_WK)))).some(Boolean);
      if ((((!bool(too_wide))) && bool(Array.from(Array.from(pyIter(pairs)).map(([d, f1, f2]: any) => (bool((d > reach(f1, f2))) ? ((d > reach(f1, f2))) : (suspect(f1, f2, d))))).some(Boolean)))) {
        too_wide = (!bool(this._chord_fits(ns)));
      }
      if (bool((!bool(too_wide)))) {
        continue;
      }
      this.rolled = pyAugAdd(this.rolled, 1);
      order = pySorted(ns, ((n) => n.pitch), false);
      for ([k, n] of pyIter(enumerate(order))) {
        so[pyId(n)] = pyAdd(n.start, pyMult(k, this.roll_dt));
      }
      top = order[order.length - 1];
      [ft, pt] = [this.fingering[pyId(top)], pos(top)];
      latest = pyMax(so[pyId(top)], ((pyAdd(gi, 1) < (groups).length) ? (groups[pyAdd(gi, 1)][0] - 0.03) : Infinity));
      for (n of pyIter(order.slice(0, (-1)))) {
        f = this.fingering[pyId(n)];
        if ((pyEq(f, ft))) {
          continue;
        }
        over = (Math.abs((pt - pos(n))) - reach(f, ft));
        if ((over > 0)) {
          need = fg.travel_time(over, this.max_speed);
          eo[pyId(n)] = pyMin(eo[pyId(n)], pyMax(pyAdd(so[pyId(n)], 0.03), (so[pyId(top)] - need)));
          so[pyId(top)] = pyMin(latest, pyMax(so[pyId(top)], pyAdd(eo[pyId(n)], need)));
        }
      }
      for (n of pyIter(order)) {
        eo[pyId(n)] = pyMax(eo[pyId(n)], pyAdd(so[pyId(n)], 0.03));
      }
    }
  }
    _chord_fits(ns: any[]): boolean {
      if (this._ref_kb === null) {
        this._ref_kb = new KeyboardGeometry(
          new NumericRect(0, 0, 52 * ROLL_FIT_WW, Math.trunc(KEY_LEN_WW * ROLL_FIT_WW)),
          this.key_style
        );
      }
      this._ensure_layout(this._ref_kb);
      const wk = this.kb.white_w;
      let keys = ns.map((n: any) => [n, this.fingering[pyId(n)], this._pk(n)]);
      keys = keys.filter((k: any) => this._has_key(k[2])).map((k: any) => [k[0], k[1], k[2], this.key_target(k[2], k[1])[0]]);
      if (keys.length < 2) return true;

      const span = (Math.max(...keys.map((k: any) => k[3])) - Math.min(...keys.map((k: any) => k[3]))) / wk;
      const low = 1.0 - FLAT_DROP * _smooth((span - FLAT_SPAN_WK[0]) / (FLAT_SPAN_WK[1] - FLAT_SPAN_WK[0]));
      const items: any[] = [];
      for (const [n, f, pk, kx] of keys) {
        const [ylo, yhi] = this._key_depths(pk);
        const black = (Array.isArray(pk) ? pk : [pk]).every((p: number) => is_black_key(p));
        const sl = (PRESS_SLACK_DEG[f] * Math.PI / 180.0);
        const [lo, hi] = this.splay[f];
        const [blx, bly, blz] = this.base_local[f];
        const [hmin, hmax] = this._reach_range(f, blz * low + this.travel, 0.99);
        const ds = ROLL_DEPTH_SLACK_WK * wk;
        const ys: number[] = [];
        const yStart = ylo - ds;
        const yEnd = yhi + ds;
        for (let sIdx = 0; sIdx < 9; sIdx += 1) {
          ys.push(yStart + (yEnd - yStart) * (sIdx / 8.0));
        }
        items.push([kx, ys, blx, bly, lo - sl, hi + sl, hmin, hmax, ROLL_MISS_WK[black ? 'true' : 'false'] * wk]);
      }

      function linspace(start: number, stop: number, num: number): number[] {
        const res: number[] = [];
        if (num <= 1) return [start];
        for (let i = 0; i < num; i += 1) {
          res.push(start + (stop - start) * (i / (num - 1)));
        }
        return res;
      }

      function worstOne(wx: number, wy: number, psi: number): number {
        const c = Math.cos(psi);
        const s = Math.sin(psi);
        let out = -Infinity;
        for (const [kx, ys, blx, bly, lo, hi, hmin, hmax, allow] of items) {
          const bx = wx + blx * c - bly * s;
          const by = wy + blx * s + bly * c;
          let minMiss = Infinity;
          for (const y of ys) {
            const dx = kx - bx;
            const dy = y - by;
            const lx = dx * c + dy * s;
            const ly = -dx * s + dy * c;
            const a = Math.atan2(lx, ly);
            let h = Math.hypot(lx, ly);
            const ac = Math.max(lo, Math.min(hi, a));
            if (ac !== a) {
              h = h * Math.max(0.0, Math.cos(a - ac));
            }
            h = Math.max(hmin, Math.min(hmax, h));
            const miss = Math.hypot(h * Math.sin(ac) - lx, h * Math.cos(ac) - ly) - allow;
            if (miss < minMiss) minMiss = miss;
          }
          if (minMiss > out) out = minMiss;
        }
        return out;
      }

      const cx = items.reduce((acc: number, it: any) => acc + it[0], 0) / items.length;
      let axes: number[][] = [
        linspace(cx - 3 * wk, cx + 3 * wk, 25),
        linspace(-5 * wk, 3 * wk, 17),
        linspace(-50, 30, 17).map((d: number) => d * Math.PI / 180.0),
      ];
      let best = Infinity;
      for (let iter = 0; iter < 3; iter += 1) {
        let bestQ = [axes[0]![0]!, axes[1]![0]!, axes[2]![0]!];
        let iterBest = Infinity;
        for (const wx of axes[0]!) {
          for (const wy of axes[1]!) {
            for (const psi of axes[2]!) {
              const w = worstOne(wx, wy, psi);
              if (w < iterBest) {
                iterBest = w;
                bestQ = [wx, wy, psi];
              }
            }
          }
        }
        best = iterBest;
        if (best <= 0.0) return true;
        axes = axes.map((ax: number[], idx: number) => {
          const v = bestQ[idx]!;
          const step = ax[1]! - ax[0]!;
          return linspace(v - 1.5 * step, v + 1.5 * step, 9);
        });
      }
      return best <= 0.0;
    }
  finger_for(note: any = null): any {
    // Planned finger for a note (None if it isn't played by this hand, or is slid in a glissando).
    return pyGet(this.fingering, pyId(note), null);
  }
  is_gliss(note: any = null): any {
    // Is this note slid in a glissando by this hand?
    return (pyIn(pyId(note), this.gliss_ids));
  }
  _ensure_layout(kb: any = null): any {
    let S: any, back: any, front: any, geo: any, sig: any, sp: any, sx: any, u: any;
    sig = [[...kb.rect], kb.white_w, kb.black_h, kb.style];
    if ((pyEq(sig, this._layout_sig))) {
      return;
    }
    this._layout_sig = sig;
    this.kb = kb;
    this.ppi = (kb.white_w / WHITE_KEY_IN);
    S = pyMult(INCHES_PER_UNIT, this.ppi);
    this.S = S;
    u = (1.0 / INCHES_PER_UNIT);
    geo = this.geo;
    front = (pyAdd(geo.mcp[3][1], pyMult(geo.rest_reach, this.curl_k)) - pyMult(WHITE_DEPTH_IN[3], u));
    this.rest_local = Object.fromEntries(Array.from(pyIter(pyRange(1, 6))).map((f: any) => [f, [pyMult(pyAdd(geo.mcp[3][0], pyMult(pyMult((f - 3), WHITE_KEY_IN), u)), S), pyMult(pyAdd(front, pyMult(WHITE_DEPTH_IN[f], u)), S)]]));
    back = pyMult(this.retract_back_in, this.ppi);
    this.retract_back = Object.fromEntries(Array.from(pyIter(pyRange(1, 6))).map((f: any) => [f, pyMult(back, ((pyEq(f, 1)) ? 0.5 : 1.0))]));
    this.z_off = pyMult(this.curl_lift_in, this.ppi);
    this.base_local = Object.fromEntries(Array.from(pyIter(pyRange(1, 6))).map((f: any) => [f, [pyMult(geo.base(f)[0], S), pyMult(geo.base(f)[1], S), pyAdd(pyMult(geo.base(f)[2], S), this.z_off)]]));
    this.length = Object.fromEntries(Array.from(pyIter(pyRange(1, 6))).map((f: any) => [f, pyMult((geo.bones[f]).reduce((a: any, b: any) => a + b, 0), S)]));
    this.splay = Object.fromEntries(Array.from(pyIter(pyRange(1, 6))).map((f: any) => [f, [...Array.from(pyIter(SPLAY_LIMIT_DEG[f])).map((a: any) => ((a) * Math.PI / 180.0))]]));
    this.splay_comfort = Object.fromEntries(Array.from(pyIter(pyRange(1, 6))).map((f: any) => [f, [...Array.from(pyIter(SPLAY_COMFORT_DEG[f])).map((a: any) => ((a) * Math.PI / 180.0))]]));
    this.travel = pyMult(KEY_TRAVEL_IN, this.ppi);
    this._cache = {  };
    [this._idle_cache, this._clear_cache, this._path_cache] = [{  }, {  }, {  }];
    [this._limit_cache, this._tip_limit_cache] = [{  }, {  }];
    [this._smooth_hand_cache, this._smooth_tip_cache] = [{  }, {  }];
    this._gliss_cache = null;
    this._gliss_follow_cache = {  };
    this._follow_jobs = {  };
    this._warm_k = null;
    this._strike_list = null;
    this.axis_x = ((pyIn(62, kb.key_rects)) ? kb.key_rects[62].centerx : kb.rect.centerx);
    sp = (bool(this.mirror) ? 52 : 72);
    sx = ((pyIn(sp, kb.key_rects)) ? kb.key_rects[sp].centerx : kb.rect.centerx);
    this.shoulder_x = this._mx(sx);
    this.forearm_len = pyMult(16, this.ppi);
    this._foot = null;
    [this._contact_cache, this._contact_spans] = [{  }, {  }];
  }
  _pk(note: any = null): any {
    // The key(s) a note's finger aims at: its pitch, or (lo, hi) when it covers two.
    return pyGet(this.pair_key, pyId(note), note.pitch);
  }
  _has_key(pk: any = null): any {
    let rects: any;
    rects = this.kb.key_rects;
    return (bool(Array.isArray(pk)) ? Array.from(Array.from(pyIter(pk)).map((p: any) => (pyIn(p, rects)))).every(Boolean) : (pyIn(pk, rects)));
  }
  key_target(pitch: any = null, f: any = null, note: any = null): any {
    let front: any, hi: any, lo: any, r: any, up: any, x: any, x1: any, x2: any, y: any, y1: any, y2: any;
    // 
    //         Fingertip contact point (X, Y) for a finger on a key (or between two,
    //         for a pair). A white key is played at its finger's usual depth - or,
    //         for a note among black keys (`white_up`), further up, just past the
    //         black keys' front, so the hand needn't move in and out between them.
    //         
    if (bool(Array.isArray(pitch))) {
      [[x1, y1], [x2, y2]] = Array.from(pyIter(pitch)).map((p: any) => this.key_target(p, f, note));
      if (bool(this._bridge_pair(pitch, f))) {
        x = pyMin(x1, x2);
        return [x, pyAdd((this.kb.rect.h - this.kb.black_h), pyMult(THUMB_BRIDGE_DEPTH_IN, this.ppi))];
      }
      return [(pyAdd(x1, x2) / 2), (pyAdd(y1, y2) / 2)];
    }
    r = this.kb.key_rects[pitch];
    x = r.centerx;
    front = (this.kb.rect.h - this.kb.black_h);
    if (bool(is_black_key(pitch))) {
      y = pyAdd(front, pyMult(BLACK_DEPTH_IN, this.ppi));
    } else {
      y = pyMult(WHITE_DEPTH_IN[f], this.ppi);
      up = ((note !== null) ? pyGet(this.white_up, pyId(note), 0.0) : 0.0);
      if ((up > 0)) {
        y = pyMax(y, _lerp(y, pyAdd(front, pyMult(WHITE_UP_IN, this.ppi)), up));
        if ((pyIn(pitch, this.kb.tails))) {
          x = _lerp(x, this.kb.tails[pitch].centerx, up);
        }
      }
    }
    [lo, hi] = this._key_depths(pitch, note, f);
    return [this._mx(x), pyMin(pyMax(y, lo), hi)];
  }
  _bridge_pair(pk: any = null, f: any = null): any {
    // 
    //         Is this the thumb bridging two black keys (C#-D#, D#-F#, A#-C#...)? It
    //         lies flat across the keyboard over the white keys between them: its
    //         tip on the far key (away from the other fingers), its side on the
    //         near one - so its tip aims at the far key (key_target), its reach is
    //         measured from there, and _thumb_bridge lays it across.
    //         
    return (((pyEq(f, 1))) && bool(Array.isArray(pk)) && bool(Array.from(Array.from(pyIter(pk)).map((p: any) => is_black_key(p))).every(Boolean)));
  }
  _key_depths(pk: any = null, note: any = null, f: any = null): any {
    let a: any, b: any, black: any, cap: any, front: any, hi: any, lo: any, spans: any, usual: any;
    // 
    //         (lowest, highest) world Y a fingertip may play key(s) pk at: the
    //         pianist's playing area on the key (key_area_near .. key_area_far of
    //         its playable length, WHITE_SPAN_IN / BLACK_SPAN_IN). With `note`
    //         and its finger `f`: where it aims, by its loudness - a loud note no
    //         further up than its finger's usual spot (plus LOUD_MARGIN_IN),
    //         nearer the key's front, where it has leverage; a soft one anywhere
    //         in the area. (A finger that can't reach its aim may still slide
    //         within the whole area, see _key_spot.)
    //         
    if (bool(Array.isArray(pk))) {
      spans = Array.from(pyIter(pk)).map((p: any) => this._key_depths(p, note, f));
      [lo, hi] = [pyMax(Array.from(pyIter(spans)).map(([a, _0]: any) => a)), pyMin(Array.from(pyIter(spans)).map(([_0, b]: any) => b))];
      return ((lo <= hi) ? [lo, hi] : [hi, lo]);
    }
    front = (this.kb.rect.h - this.kb.black_h);
    if (bool(is_black_key(pk))) {
      [a, b] = [pyAdd(front, pyMult(BLACK_SPAN_IN[0], this.ppi)), pyAdd(front, pyMult(BLACK_SPAN_IN[1], this.ppi))];
    } else {
      [a, b] = [pyMult(WHITE_SPAN_IN[0], this.ppi), pyAdd(front, pyMult(WHITE_SPAN_IN[1], this.ppi))];
    }
    [lo, hi] = [pyAdd(a, pyMult((b - a), this.area_near)), pyAdd(a, pyMult((b - a), this.area_far))];
    if ((((note !== null)) && ((f !== null)))) {
      black = is_black_key(pk);
      usual = (bool(black) ? pyAdd(front, pyMult(BLACK_DEPTH_IN, this.ppi)) : pyMult(WHITE_DEPTH_IN[f], this.ppi));
      cap = pyMax(lo, pyMin(hi, pyAdd(usual, pyMult(LOUD_MARGIN_IN[black], this.ppi))));
      hi = _lerp(hi, cap, loudness(note.velocity));
    }
    return [lo, hi];
  }
  _clamp_tip(f: any = null, x: any = null, y: any = null, z: any = null, wx: any = null, wy: any = null, psi: any = null, slack: any = null, margin: any = null, comp: any = null, stretch: any = null, low: any = null): any {
    // 
    //         (x, y) clamped into finger f's splay and reach range (shrunk by
    //         `margin` share, widened by `slack` rad): the reachable point closest
    //         to it. A target beyond the splay limit is brought onto the limit's
    //         line at its nearest point there - not swung round at full length,
    //         which would stretch the finger out past where it is going.
    //         
    return _clamp_apply(this._clamp_prep(f, z, wx, wy, psi, slack, margin, comp, stretch, low), x, y);
  }
  _clamp_prep(f: any = null, z: any = null, wx: any = null, wy: any = null, psi: any = null, slack: any = null, margin: any = null, comp: any = null, stretch: any = null, low: any = null): any {
    let blx: any, bly: any, blz: any, bx: any, by: any, dm: any, hi: any, hmax: any, hmin: any, lo: any, m: any, rot: any;
    // What _clamp_tip needs for finger f at this hand and height, worked out once (_clamp_apply).
    rot = this._rot;
    [blx, bly, blz] = this.base_local[f];
    [bx, by] = rot(blx, bly, psi);
    [bx, by] = [pyAdd(wx, bx), pyAdd(wy, by)];
    [lo, hi] = this._splay_at(f, comp, stretch);
    m = (bool(margin) ? (pyMult(((KEY_FIX_MARGIN_DEG) * Math.PI / 180.0), margin) / KEY_FIX_MARGIN) : 0.0);
    [lo, hi] = [pyAdd((lo - slack), m), (pyAdd(hi, slack) - m)];
    [hmin, hmax] = this._reach_range(f, (pyMult(blz, low) - z), 0.99);
    if ((z > 0)) {
      hmin *= this.curl_min;
    }
    dm = pyMult(margin, this.length[f]);
    [hmin, hmax] = [pyAdd(hmin, dm), pyMax(pyAdd(hmin, dm), (hmax - dm))];
    return [bx, by, Math.cos((-psi)), Math.sin((-psi)), Math.cos(psi), Math.sin(psi), lo, hi, hmin, hmax];
  }
  _key_spot(pk: any = null, f: any = null, hand: any = null, z: any = null, note: any = null, soft: any = null, comp: any = null, low: any = null): any {
    let best: any, cands: any, cx: any, cy: any, e0: any, far: any, hi: any, i: any, kk: any, kx: any, ky: any, lo: any, prep: any, span: any, tau: any, ws: any, y: any;
    // 
    //         Where finger f plays key(s) pk with the hand at `hand` (wx, wy, psi):
    //         squarely across the key, and along it where it aims (key_target:
    //         its usual depth, bounded by the note's loudness), or as little
    //         further in or out (anywhere in the pianist's playing area,
    //         _key_depths) as it takes to be inside the finger's splay and reach
    //         range. None for `hand` gives the usual spot.
    // 
    //         The depth is a soft choice over spots along the key (each priced by
    //         how far it is from the aim plus a weight times how far out of reach
    //         it is), so it moves smoothly as the hand moves instead of jumping
    //         between spots: firm (KEY_SPOT_FIRM) on the key, softer
    //         (KEY_SPOT_SOFT, by `soft` 0..1) while the finger is on its way; a
    //         key far out of reach fades back to its usual spot.
    //         
    [kx, ky] = this.key_target(pk, f, note);
    if ((hand === null)) {
      return [kx, ky];
    }
    z = ((z === null) ? (-this.travel) : z);
    [lo, hi] = this._key_depths(pk);
    span = pyMax(1e-06, (hi - lo));
    prep = this._clamp_prep(f, z, hand[0], hand[1], hand[2], 0.0, KEY_FIX_MARGIN, comp, 1.0, low);
    [cx, cy] = _clamp_apply(prep, kx, ky);
    e0 = Math.hypot((cx - kx), (cy - ky));
    far = _smooth(((e0 - pyMult(1.5, span)) / pyMult(1.5, span)));
    if ((bool((e0 < 0.5)) ? ((e0 < 0.5)) : ((far >= 1.0)))) {
      return [kx, ky];
    }
    kk = _lerp(KEY_SPOT_FIRM[0], KEY_SPOT_SOFT[0], soft);
    tau = pyMult(_lerp(KEY_SPOT_FIRM[1], KEY_SPOT_SOFT[1], soft), this.ppi);
    cands = [[ky, pyMult(kk, e0)]];
    for (i = 0; i < 21; i += 1) {
      y = pyAdd(lo, (pyMult(span, i) / 20));
      [cx, cy] = _clamp_apply(prep, kx, y);
      cands.push([y, pyAdd(Math.abs((y - ky)), pyMult(kk, Math.hypot((cx - kx), (cy - y))))]);
    }
    best = pyMin(Array.from(pyIter(cands)).map(([_0, c]: any) => c));
    ws = Array.from(pyIter(cands)).map(([y, c]: any) => [y, Math.exp(((-(c - best)) / tau))]);
    y = ((Array.from(pyIter(ws)).map(([y, w]: any) => pyMult(y, w))).reduce((a: any, b: any) => a + b, 0) / (Array.from(pyIter(ws)).map(([_0, w]: any) => w)).reduce((a: any, b: any) => a + b, 0));
    return [kx, _lerp(y, ky, far)];
  }
  _mx(x: any = null): any {
    // Screen x <-> this hand's working frame (mirrored for the left hand).
    return (bool(this.mirror) ? (pyMult(2, this.axis_x) - x) : x);
  }
  _yaw(wx: any = null): any {
    let forearm: any;
    // Natural hand turn from a forearm swinging around the right shoulder.
    forearm = Math.atan2((wx - this.shoulder_x), this.forearm_len);
    return pyMult((-0.3), forearm);
  }
  _rot(x: any = null, y: any = null, psi: any = null): any {
    let c: any, s: any;
    [c, s] = [Math.cos(psi), Math.sin(psi)];
    return [(pyMult(x, c) - pyMult(y, s)), pyAdd(pyMult(x, s), pyMult(y, c))];
  }
  _reach_range(f: any = null, dz: any = null, share: any = null): any {
    let L: any, hmax: any;
    // Allowed horizontal distance, knuckle to fingertip, for a tip dz below the knuckle.
    L = pyMult(this.length[f], ((share === null) ? pyMin(0.99, pyAdd(REACH_COMFORT[f], this.reach_bonus)) : share));
    hmax = Math.sqrt(pyMax(0.0, (pyMult(L, L) - pyMult(dz, dz))));
    return [pyMin(pyMult(REACH_MIN[f], this.length[f]), hmax), hmax];
  }
  _items_at(t: any = null): any {
    let age: any, c: any, ends: any, f: any, fade: any, hold: any, i: any, immediate: any, items: any, n: any, need_next: any, notes: any, nxt: any, prep_start: any, ramp: any, s: any, starts: any, w: any;
    // 
    //         [(pitch, finger, pull, need, note_start, released)] for time t: `pull` is how much the key
    //         shapes the hand (it leans toward keys a finger is heading for), `need`
    //         how strictly the finger must be able to reach it (1 while pressed,
    //         rising just before a strike, fading right after a release).
    //         
    items = [];
    for (f = 1; f < 6; f += 1) {
      [notes, starts, ends] = [this.by_finger[f], this.finger_starts[f], this.finger_ends[f]];
      n = (notes).length;
      if (bool((!bool(n)))) {
        continue;
      }
      i = (bisectRight(starts, t) - 1);
      nxt = ((pyAdd(i, 1) < n) ? pyAdd(i, 1) : null);
      ramp = ((nxt !== null) ? _smooth((1.0 - ((starts[nxt] - t) / this.antic_t))) : 0.0);
      need_next = ((nxt !== null) ? Math.pow(_smooth((1.0 - ((starts[nxt] - t) / this.need_t))), 3) : 0.0);
      if ((i < 0)) {
        items.push([this._pk(notes[0]), f, pyMax(ramp, pyAdd(1e-06, pyMult(IDLE_W, Math.pow(0.5, (starts[0] - t))))), need_next, starts[0], 0, notes[0]]);
        continue;
      }
      if ((((i >= 1)) && ((t >= ends[(i - 1)])))) {
        hold = pyMin(RELEASE_HOLD_T, pyMax(0.001, (starts[i] - ends[(i - 1)])));
        w = (1.0 - _smooth(((t - ends[(i - 1)]) / hold)));
        if ((w > 0)) {
          items.push([this._pk(notes[(i - 1)]), f, w, pyMult(RELEASE_NEED, (1.0 - _smooth(((t - ends[(i - 1)]) / RELEASE_NEED_T)))), starts[(i - 1)], 1, notes[(i - 1)]]);
        }
      }
      if ((t < ends[i])) {
        items.push([this._pk(notes[i]), f, 1.0, 1.0, starts[i], 0, notes[i]]);
        if ((((nxt !== null)) && ((ramp > 0)))) {
          w = pyMult(ANTIC_HELD, ramp);
          items.push([this._pk(notes[nxt]), f, w, Math.pow(w, VOTE_POWER), starts[nxt], 0, notes[nxt]]);
        }
        continue;
      }
      age = (t - ends[i]);
      if ((nxt !== null)) {
        [s, prep_start] = this._travel(f, i, t);
        immediate = (prep_start <= pyAdd(ends[i], 1e-06));
      } else {
        [s, immediate] = [0.0, false];
      }
      fade = (bool(immediate) ? 1.0 : (1.0 - _smooth((age / RELEASE_HOLD_T))));
      w = pyMult((1.0 - s), pyMax(fade, pyAdd(1e-06, pyMult(IDLE_W, Math.pow(0.5, age)))));
      if ((w > 0)) {
        items.push([this._pk(notes[i]), f, w, pyMult(RELEASE_NEED, (1.0 - _smooth((age / RELEASE_NEED_T)))), starts[i], 1, notes[i]]);
      }
      if ((nxt !== null)) {
        w = pyMax(pyMult(ANTIC_HELD, ramp), s);
        c = pyMax(Math.pow(pyMult(ANTIC_HELD, ramp), VOTE_POWER), need_next);
        if ((bool((w > 0)) ? ((w > 0)) : ((c > 0)))) {
          items.push([this._pk(notes[nxt]), f, w, c, starts[nxt], 0, notes[nxt]]);
        }
      }
    }
    return Array.from(pyIter(items)).filter((it: any) => this._has_key(it[0])).map((it: any) => it);
  }
  _solve_hand(items: any = null, comp: any = null, low: any = null): any {
    let A: any, G: any, S: any, _: any, a: any, arm: any, arriving: any, bias: any, c: any, cols: any, dev_hi: any, dev_lo: any, dq: any, eps: any, f: any, fit: any, fits: any, g: any, hi: any, hmax: any, hmin: any, i: any, imp: any, j: any, k: any, k_dev: any, k_prior: any, k_soft: any, keep: any, lam: any, lim: any, lims: any, lo: any, lst: any, n: any, over: any, p: any, per: any, psi0: any, q: any, qq: any, r: any, r0: any, rel: any, rshare: any, s1: any, sc: any, scale: any, sf: any, soft: any, st: any, th: any, tx: any, tx1: any, ty: any, under: any, v: any, w: any, w1: any, wi: any, wj: any, wk: any, ws: any, wsum: any, x: any, y: any;
    // 
    //         Wrist (x, y) and hand turn psi serving the weighted items:
    //           1. a weighted rigid fit of the natural fingertip spots onto the keys
    //              (closed form, with the forearm's natural turn as a prior);
    //           2. a few damped Gauss-Newton steps on a smooth cost that adds
    //              penalties for any finger that would need more splay or reach
    //              than its limits allow, and for the wrist turning past its range.
    //              Keys being pressed (weight 1) dominate; keys further ahead only
    //              nudge. Turning the hand is cheap, so an out-of-range finger is
    //              fixed mostly by wrist rotation, the rest by sliding the hand.
    //         
    if (bool((!bool(items)))) {
      return [this._mx(this.kb.rect.centerx), (-150.0), 0.0];
    }
    per = {  };
    arriving = {  };
    rel = {  };
    for ([p, f, w, c, st, r, n] of pyIter(items)) {
      [x, y] = this.key_target(p, f, n);
      pySetDefault(per, f, []).push([x, y, w, c]);
      if (bool(r)) {
        rel[f] = pyAdd(pyGet(rel, f, 0.0), c);
      }
      a = pySetDefault(arriving, f, [0.0, 0.0]);
      a[0] = pyAugAdd(a[0], pyMult(w, st));
      a[1] = pyAugAdd(a[1], w);
    }
    [fit, lim, imp] = [[], [], {  }];
    for ([f, lst] of pyIter(pyItems(per))) {
      ws = (Array.from(pyIter(lst)).map(([_0, _1, w, _2]: any) => w)).reduce((a: any, b: any) => a + b, 0);
      if ((ws > 0)) {
        imp[f] = pyAdd(ws, pyMult(2.0, pyMax(Array.from(pyIter(lst)).map(([_0, _1, _2, c]: any) => c))));
        fit.push([[((Array.from(pyIter(lst)).map(([x, _0, w, _1]: any) => pyMult(x, w))).reduce((a: any, b: any) => a + b, 0) / ws), ((Array.from(pyIter(lst)).map(([_0, y, w, _1]: any) => pyMult(y, w))).reduce((a: any, b: any) => a + b, 0) / ws)], this.rest_local[f], pyMult(ws, FIT_WEIGHT[f]), f]);
      }
      sc = (Array.from(pyIter(lst)).map(([_0, _1, _2, c]: any) => c)).reduce((a: any, b: any) => a + b, 0);
      if ((sc > 1e-09)) {
        lim.push([((Array.from(pyIter(lst)).map(([x, _0, _1, c]: any) => pyMult(x, c))).reduce((a: any, b: any) => a + b, 0) / sc), ((Array.from(pyIter(lst)).map(([_0, y, _1, c]: any) => pyMult(y, c))).reduce((a: any, b: any) => a + b, 0) / sc), f, pyMax(Array.from(pyIter(lst)).map(([_0, _1, _2, c]: any) => c)), (pyGet(rel, f, 0.0) / sc)]);
      }
    }
    if (bool((!bool(fit)))) {
      return [this._mx(this.kb.rect.centerx), (-150.0), 0.0];
    }
    wk = this.kb.white_w;
    keep = pyMult([1.0], (fit).length);
    for (i = 0; i < (fit).length; i += 1) {
      for (j = 0; j < (fit).length; j += 1) {
        if ((fit[i][3] < fit[j][3])) {
          v = _smooth((pyAdd((fit[i][0][0] - fit[j][0][0]), pyMult(0.5, wk)) / wk));
          if ((v > 0)) {
            [wi, wj] = [Math.pow(imp[fit[i][3]], 6), Math.pow(imp[fit[j][3]], 6)];
            keep[i] *= (1.0 - (pyMult(pyMult(0.98, v), wj) / pyAdd(wi, wj)));
            keep[j] *= (1.0 - (pyMult(pyMult(0.98, v), wi) / pyAdd(wi, wj)));
          }
        }
      }
    }
    under = 0.0;
    over = under;
    th = Array.from(pyIter(fit)).filter((e: any) => (pyEq(e[3], 1))).map((e: any) => e);
    if (bool(th)) {
      [[tx1, _], _, w1, _] = th[0];
      s1 = (arriving[1][0] / pyMax(1e-09, arriving[1][1]));
      for ([[tx, _], _, w, f] of pyIter(fit)) {
        if ((pyNotEq(f, 1))) {
          v = pyMult(pyMult(_smooth((pyAdd((tx1 - tx), pyMult(0.5, wk)) / wk)), pyMin(1.0, (w / 0.5))), pyMin(1.0, (w1 / pyMult(0.5, FIT_WEIGHT[1]))));
          sf = (arriving[f][0] / pyMax(1e-09, arriving[f][1]));
          k = _smooth(pyAdd(0.5, ((s1 - sf) / 0.1)));
          under = pyMax(under, pyMult(v, k));
          over = pyMax(over, pyMult(v, (1.0 - k)));
        }
      }
    }
    this._bias = pyMult(this.cross_turn, (over - under));
    fit = Array.from(pyIter(zip(fit, keep))).map(([[t, r, w, _0], k]: any) => [t, r, pyMult(w, k)]);
    q = [...this._fit_hand(fit)];
    S = this.S;
    [dev_lo, dev_hi] = Array.from(pyIter(WRIST_DEV_DEG)).map((a: any) => ((a) * Math.PI / 180.0));
    arm = pyMult(3.0, S);
    wsum = (Array.from(pyIter(fit)).map(([_0, _1, w]: any) => w)).reduce((a: any, b: any) => a + b, 0);
    k_soft = SOFT_K;
    k_prior = pyMult(Math.sqrt(pyMult(pyAdd(YAW_PRIOR, (pyMult(CROSS_PRIOR, Math.abs(this._bias)) / this.cross_norm)), wsum)), arm);
    k_dev = pyMult(Math.sqrt(pyMult(LIMIT_K, 25)), arm);
    lims = [];
    for ([tx, ty, f, c, rshare] of pyIter(lim)) {
      [lo, hi] = this._splay_at(f, comp);
      [hmin, hmax] = this._reach_range(f, pyAdd(pyMult(this.base_local[f][2], low), this.travel));
      soft = pyMax(0.001, (1.0 - c));
      lims.push([tx, ty, this.base_local[f], lo, hi, hmin, hmax, Math.sqrt(pyMult(LIMIT_K, c)), (pyMult(0.25, pyAdd((1 - rshare), pyMult(rshare, c))) / soft), (pyMult(wk, pyAdd((1 - rshare), pyMult(rshare, c))) / soft)]);
    }
    bias = this._bias;
    fits = Array.from(pyIter(fit)).map(([t, r, w]: any) => [t, r, Math.sqrt(pyMult(k_soft, w))]);
    const residuals = (wx: any = null, wy: any = null, psi: any = null): any => {
      let _: any, a: any, blx: any, bly: any, c: any, dpsi: any, dx: any, dy: any, ea: any, eh: any, h: any, hi: any, hmax: any, hmin: any, k: any, kk: any, lo: any, lx: any, ly: any, out: any, rx: any, ry: any, s_: any, sa: any, sh: any, tx: any, ty: any;
      [c, s_] = [Math.cos(psi), Math.sin(psi)];
      out = [];
      for ([[tx, ty], [rx, ry], kk] of pyIter(fits)) {
        out.push(pyMult(kk, ((pyAdd(wx, pyMult(rx, c)) - pyMult(ry, s_)) - tx)));
        out.push(pyMult(kk, (pyAdd(pyAdd(wy, pyMult(rx, s_)), pyMult(ry, c)) - ty)));
      }
      dpsi = (psi - this._yaw(wx));
      out.push(pyMult(k_prior, (dpsi - bias)));
      out.push(pyMult(k_dev, pyAdd(pyMax(0.0, (dpsi - dev_hi)), pyMin(0.0, (dpsi - dev_lo)))));
      for ([tx, ty, [blx, bly, _], lo, hi, hmin, hmax, k, sa, sh] of pyIter(lims)) {
        dx = (tx - (pyAdd(wx, pyMult(blx, c)) - pyMult(bly, s_)));
        dy = (ty - pyAdd(pyAdd(wy, pyMult(blx, s_)), pyMult(bly, c)));
        [lx, ly] = [pyAdd(pyMult(dx, c), pyMult(dy, s_)), pyAdd(pyMult((-dx), s_), pyMult(dy, c))];
        [a, h] = [Math.atan2(lx, ly), Math.hypot(lx, ly)];
        ea = pyAdd(pyMax(0.0, (a - hi)), pyMin(0.0, (a - lo)));
        eh = pyAdd(pyMax(0.0, (h - hmax)), pyMin(0.0, (h - hmin)));
        out.push((pyMult(pyMult(k, h), ea) / pyAdd(1.0, (Math.abs(ea) / sa))));
        out.push((pyMult(k, eh) / pyAdd(1.0, (Math.abs(eh) / sh))));
      }
      return out;
    };
    eps = [0.5, 0.5, 0.001];
    for (_ = 0; _ < GN_ITERS; _ += 1) {
      r0 = residuals(...q);
      cols = [];
      for (j = 0; j < 3; j += 1) {
        qq = [...q];
        qq[j] = pyAugAdd(qq[j], eps[j]);
        cols.push(Array.from(pyIter(zip(residuals(...qq), r0))).map(([a, b]: any) => ((a - b) / eps[j])));
      }
      scale = [1.0, 1.0, arm];
      G = _gram(cols);
      A = Array.from(pyIter(pyRange(3))).map((i: any) => Array.from(pyIter(pyRange(3))).map((j: any) => (G[i][j] / pyMult(scale[i], scale[j]))));
      g = Array.from(pyIter(pyRange(3))).map((i: any) => ((-(map(((a: number, b: number) => a * b), cols[i], r0)).reduce((a: any, b: any) => a + b, 0)) / scale[i]));
      lam = pyAdd((pyMult(GN_DAMPING, pyAdd(pyAdd(A[0][0], A[1][1]), A[2][2])) / 3), 1e-09);
      for (i = 0; i < 3; i += 1) {
        A[i][i] = pyAugAdd(A[i][i], lam);
      }
      dq = _solve3(A, g);
      q = Array.from(pyIter(pyRange(3))).map((i: any) => pyAdd(q[i], (dq[i] / scale[i])));
    }
    psi0 = this._yaw(q[0]);
    q[2] = _clamp(q[2], pyAdd(psi0, dev_lo), pyAdd(psi0, dev_hi));
    return [...q];
  }
  _fit_hand(pts: any = null): any {
    let C: any, S: any, Sn: any, _: any, ax: any, ay: any, bx: any, by: any, dev_hi: any, dev_lo: any, ox: any, oy: any, pb: any, prior: any, psi: any, psi0: any, rbx: any, rby: any, rot: any, rx: any, ry: any, tbx: any, tby: any, tx: any, ty: any, w: any, ws: any, wx: any, wy: any;
    // Weighted rigid fit of the natural fingertip spots onto the keys.
    [rot, S] = [this._rot, this.S];
    [dev_lo, dev_hi] = Array.from(pyIter(WRIST_DEV_DEG)).map((a: any) => ((a) * Math.PI / 180.0));
    ws = (Array.from(pyIter(pts)).map(([_0, _1, w]: any) => w)).reduce((a: any, b: any) => a + b, 0);
    tbx = ((Array.from(pyIter(pts)).map(([t, _0, w]: any) => pyMult(t[0], w))).reduce((a: any, b: any) => a + b, 0) / ws);
    tby = ((Array.from(pyIter(pts)).map(([t, _0, w]: any) => pyMult(t[1], w))).reduce((a: any, b: any) => a + b, 0) / ws);
    rbx = ((Array.from(pyIter(pts)).map(([_0, r, w]: any) => pyMult(r[0], w))).reduce((a: any, b: any) => a + b, 0) / ws);
    rby = ((Array.from(pyIter(pts)).map(([_0, r, w]: any) => pyMult(r[1], w))).reduce((a: any, b: any) => a + b, 0) / ws);
    C = 0.0;
    Sn = C;
    for ([[tx, ty], [rx, ry], w] of pyIter(pts)) {
      [ax, ay, bx, by] = [(rx - rbx), (ry - rby), (tx - tbx), (ty - tby)];
      C = pyAugAdd(C, pyMult(w, pyAdd(pyMult(ax, bx), pyMult(ay, by))));
      Sn = pyAugAdd(Sn, pyMult(w, (pyMult(ax, by) - pyMult(ay, bx))));
    }
    prior = pyMult(pyMult(pyAdd(YAW_PRIOR, (pyMult(CROSS_PRIOR, Math.abs(this._bias)) / this.cross_norm)), ws), Math.pow(pyMult(3.0, S), 2));
    [wx, wy] = [(tbx - rbx), (tby - rby)];
    for (_ = 0; _ < 2; _ += 1) {
      psi0 = this._yaw(wx);
      pb = pyAdd(psi0, this._bias);
      psi = Math.atan2(pyAdd(Sn, pyMult(prior, Math.sin(pb))), pyAdd(C, pyMult(prior, Math.cos(pb))));
      psi = _clamp(psi, pyAdd(psi0, dev_lo), pyAdd(psi0, dev_hi));
      [ox, oy] = rot(rbx, rby, psi);
      [wx, wy] = [(tbx - ox), (tby - oy)];
    }
    return [wx, wy, psi];
  }
  _hand_at(t: any = null): any {
    let a: any, b: any, glide: any, hold: any, q: any, r: any, w: any;
    // 
    //         Hand pose at t, smoothed over time with a short triangular window so
    //         quick shifts accelerate and settle instead of snapping. Solves are
    //         made on a fixed time grid and cached, so each frame costs one or two.
    //         
    if ((this.smooth_t <= 0)) {
      return this._solve_hand(this._items_at(t), this._run_w(t), this._low(t));
    }
    q = this._hand_avg(t, this.smooth_t);
    w = this._run_w(t);
    if ((w > 0)) {
      [a, b] = this._run_span(t);
      glide = this._hand_avg(t, RUN_GLIDE_T, (a - RUN_RAMP_T), pyAdd(b, RUN_RAMP_T));
      q = [...Array.from(pyIter(zip(q, glide))).map(([x, y]: any) => _lerp(x, y, w))];
    }
    [w, r] = this._trem_w(t);
    if ((r !== null)) {
      [a, b] = r;
      hold = this._hand_avg(t, TREM_HOLD_T, a, b);
      q = [...Array.from(pyIter(zip(q, hold))).map(([x, y]: any) => _lerp(x, y, w))];
    }
    return q;
  }
  _hand_avg(t: any = null, span: any = null, lo: any = null, hi: any = null): any {
    let g: any, k: any, k0: any, k1: any, p: any, sp: any, sw: any, sx: any, sy: any, w: any, x: any, y: any;
    // The solved hand averaged over t +- span (triangular), only from poses within lo..hi.
    g = HAND_GRID_T;
    k0 = Math.ceil(((t - span) / g));
    k1 = Math.floor((pyAdd(t, span) / g));
    sx = 0.0;
    sy = sx;
    sp = sx;
    sw = sx;
    for (k = k0; k < pyAdd(k1, 1); k += 1) {
      w = (1.0 - (Math.abs((pyMult(k, g) - t)) / span));
      if ((bool((w <= 0)) ? ((w <= 0)) : ((!((lo <= pyMult(k, g)) && (pyMult(k, g) <= hi)))))) {
        continue;
      }
      [x, y, p] = this._grid_pose(k);
      [sx, sy, sp, sw] = [pyAdd(sx, pyMult(w, x)), pyAdd(sy, pyMult(w, y)), pyAdd(sp, pyMult(w, p)), pyAdd(sw, w)];
    }
    return [(sx / sw), (sy / sw), (sp / sw)];
  }
  idle_at(t: any = null): any {
    // 0..1 how idle this hand is at t (see idle_weight).
    return (bool(this.spans) ? idle_weight(this.spans, this.span_starts, t) : 1.0);
  }
  _placed_at(t: any = null): any {
    let d: any, dx: any, f: any, g: any, k: any, k0: any, k1: any, nxt: any, p: any, psi: any, sd: any, sf: any, span: any, sw: any, w: any, wx: any, wy: any;
    // 
    //         _hand_at, moved out of the other hand's way while this one is idle
    //         and the other is playing: the idle hand keeps clear of where the
    //         playing hand is and is about to be, and drifts after it when it
    //         gets far away, so the playing hand never has to cross over it.
    //         
    [wx, wy, psi] = this._hand_at(t);
    p = this.partner;
    if ((bool((p === null)) ? ((p === null)) : ((!bool(p.spans))))) {
      return [wx, wy, psi];
    }
    p._ensure_layout(this.kb);
    [g, span] = [IDLE_GRID_T, IDLE_SMOOTH_T];
    [k0, k1] = [Math.ceil(((t - span) / g)), Math.floor((pyAdd(t, span) / g))];
    sd = 0.0;
    sf = sd;
    sw = sd;
    for (k = k0; k < pyAdd(k1, 1); k += 1) {
      w = (1.0 - (Math.abs((pyMult(k, g) - t)) / span));
      if ((w > 0)) {
        d = pyGet(this._idle_cache, k, null);
        if ((d === null)) {
          if (((this._idle_cache).length > 4000)) {
            pyClear(this._idle_cache);
          }
          d = this._idle_shift_parts(pyMult(k, g));
          this._idle_cache[k] = d;
        }
        [sd, sf, sw] = [pyAdd(sd, pyMult(w, d[0])), pyAdd(sf, pyMult(w, d[1])), pyAdd(sw, w)];
      }
    }
    dx = (bool(sw) ? (sd / sw) : 0.0);
    f = (bool(sw) ? (sf / sw) : 0.0);
    if ((f > 0.0)) {
      nxt = this._next_strike(t);
      if ((nxt < Infinity)) {
        dx = pyAugAdd(dx, pyMult(f, (this._hand_at(nxt)[0] - wx)));
      }
    }
    if ((Math.abs(dx) < 1e-06)) {
      return [wx, wy, psi];
    }
    dx = this._short_of_next(t, wx, dx);
    return [pyAdd(wx, dx), wy, (pyAdd(psi, this._yaw(pyAdd(wx, dx))) - this._yaw(wx))];
  }
  _idle_shift_parts(t: any = null): any {
    let edge: any, hi: any, i1: any, lo: any, mine: any, nxt: any, p: any, p_idle: any, raw: any, rise: any, span: any, target: any, theirs: any, ticks: any, trail: any, w: any, xn: any;
    // 
    //         (shift, share): the idle hand's shift at t, and - moved as far as its
    //         next notes - the share (0..1) of the way to them, which _placed_at
    //         smooths as a share (the shift is then only a push beyond them).
    //         
    p = this.partner;
    p_idle = p.idle_at(t);
    [mine, theirs] = [this._first_t(), p._first_t()];
    if (((t < theirs) && (theirs < mine))) {
      p_idle = 0.0;
    }
    w = pyMult(this.idle_at(t), (1.0 - p_idle));
    rise = this._idle_rise(t);
    if ((rise <= 0.0)) {
      return [0.0, 0.0];
    }
    raw = this._hand_at(t)[0];
    span = pyMult(this.geo.span_units(), this.S);
    i1 = Math.floor((t / IDLE_TICK_T));
    ticks = pyRange((i1 - Math.trunc(Math.round((IDLE_TRAIL_T / IDLE_TICK_T)))), pyAdd(i1, 1));
    trail = ((Array.from(pyIter(ticks)).map((i: any) => this._partner_x(i))).reduce((a: any, b: any) => a + b, 0) / (ticks).length);
    lo = pyAdd(this._clear_line(Math.trunc(Math.round((t / IDLE_GRID_T)))), pyMult(IDLE_CLEAR_SPAN, span));
    hi = pyMax(lo, pyAdd(trail, pyMult(IDLE_FAR_SPAN, span)));
    target = pyMin(pyMax(raw, lo), hi);
    if ((target > raw)) {
      edge = (pyMax(this._mx(this.kb.rect.left), this._mx(this.kb.rect.right)) - pyMult(IDLE_EDGE_IN, this.ppi));
      target = pyMin(target, pyMax(raw, edge));
    }
    nxt = this._next_strike(t);
    if ((((nxt < Infinity)) && ((Math.abs((target - raw)) > 1e-06)))) {
      xn = this._hand_at(nxt)[0];
      if (((raw < xn) && (xn <= target))) {
        return [pyMult(w, (target - xn)), rise];
      }
      if (((target <= xn) && (xn < raw))) {
        return [0.0, rise];
      }
    }
    if ((w <= 0.0)) {
      return [0.0, 0.0];
    }
    return [this._short_of_next(t, raw, pyMult(w, (target - raw))), 0.0];
  }
  _idle_rise(t: any = null): any {
    let i: any, last: any;
    // How far into its rest the hand is at t: idle_weight without the ramp down before the next note.
    i = (bisectRight(this.span_starts, t) - 1);
    if ((((i >= 0)) && ((t < this.spans[i][1])))) {
      return 0.0;
    }
    last = ((i >= 0) ? this.spans[i][1] : (-Infinity));
    return _smooth((((t - last) - IDLE_AFTER_T) / IDLE_RAMP_T));
  }
  _short_of_next(t: any = null, raw: any = null, dx: any = null): any {
    let nxt: any;
    // 
    //         Shift dx of the hand at raw, as a pull toward the other hand (dx < 0):
    //         it may only bring the hand toward where it plays next, never past it -
    //         so a hand resting where it plays next stays put (it would drift off and
    //         jerk back). Getting out of the other hand's way (dx > 0) isn't cut.
    //         
    nxt = this._next_strike(t);
    if ((((dx < 0)) && ((nxt < Infinity)))) {
      return pyMax(dx, pyMin(0.0, (this._hand_at(nxt)[0] - raw)));
    }
    return dx;
  }
  _first_t(): any {
    // When this hand strikes its first fingered key (inf if never).
    return (bool(this._group_ts) ? this._group_ts[0] : Infinity);
  }
  _partner_x(i: any = null): any {
    let p: any, x: any;
    // The other hand's wrist x at tick i (IDLE_TICK_T), in this hand's frame.
    x = pyGet(this._path_cache, i, null);
    if ((x === null)) {
      if (((this._path_cache).length > 20000)) {
        pyClear(this._path_cache);
      }
      p = this.partner;
      x = this._mx(p._mx(p._grid_pose(Math.trunc(Math.round((pyMult(i, IDLE_TICK_T) / HAND_GRID_T))))[0]));
      this._path_cache[i] = x;
    }
    return x;
  }
  _clear_line(k: any = null): any {
    let a: any, at: any, cache: any, fall: any, g: any, j: any, p: any, prev: any, tick: any, todo: any;
    // 
    //         On the idle grid: how far toward this hand the other one reaches now
    //         and over the next IDLE_LOOK_T (in this hand's frame), remembered
    //         through the idle stretch with a fall-off of IDLE_DRIFT_IN, so that
    //         once the playing hand has passed, the idle one drifts back rather
    //         than springing.
    //         
    [cache, p, g] = [this._clear_cache, this.partner, IDLE_GRID_T];
    if ((pyIn(k, cache))) {
      return cache[k];
    }
    if (((cache).length > 20000)) {
      pyClear(cache);
    }
    [at, tick] = [this._partner_x.bind(this), IDLE_TICK_T];
    const ahead = (j: any = null): any => {
      let i0: any;
      i0 = Math.floor((pyMult(j, g) / tick));
      return pyMax(Array.from(pyIter(pyRange(i0, pyAdd(Math.ceil((pyAdd(pyMult(j, g), IDLE_LOOK_T) / tick)), 1)))).map((i: any) => at(i)));
    };
    [todo, j] = [[], k];
    while (((((!pyIn(j, cache)))) && (((todo).length < (IDLE_MEMORY_T / g))) && ((bool((pyEq(j, k))) ? ((pyEq(j, k))) : ((pyMult(this.idle_at(pyMult(j, g)), (1.0 - p.idle_at(pyMult(j, g)))) > 0.0)))))) {
      todo.push(j);
      j -= 1;
    }
    prev = pyGet(cache, j, null);
    fall = pyMult(pyMult(IDLE_DRIFT_IN, this.ppi), g);
    for (j of pyIter(reversed(todo))) {
      a = ahead(j);
      prev = ((prev === null) ? a : pyMax(a, (prev - fall)));
      cache[j] = prev;
    }
    return prev;
  }
  _grid_pose(k: any = null): any {
    let cache: any, pose: any, t: any;
    cache = this._cache;
    pose = pyGet(cache, k, null);
    if ((pose === null)) {
      if (((cache).length > 4000)) {
        pyClear(cache);
      }
      t = pyMult(k, HAND_GRID_T);
      pose = this._solve_hand(this._items_at(t), this._run_w(t), this._low(t));
      cache[k] = pose;
    }
    return pose;
  }
  _blocked_until(f: any = null, i: any = null): any {
    let cache: any, dst: any, g: any, ge: any, gn: any, got: any, gs: any, j: any, key: any, notes: any, p: any, starts: any, t0: any, t1: any;
    // 
    //         When finger f (2-5) can set off from its note i (or from where it
    //         rests, i = -1) toward note i+1: not before every neighbouring finger
    //         holding a key short of that one - a finger on f's far side of it,
    //         in the way - has let go: fingers can't pass each other (in a 1-3
    //         chromatic scale the index waited pressed against the middle finger
    //         and then jumped with it). The thumb passes under them.
    //         
    if ((pyEq(f, 1))) {
      return (-Infinity);
    }
    cache = this._prep_cache;
    key = [f, i];
    got = pyGet(cache, key, null);
    if ((got === null)) {
      [notes, starts] = [this.by_finger[f], this.finger_starts[f]];
      dst = key_pos(this.vp(notes[pyAdd(i, 1)].pitch));
      got = (-Infinity);
      if ((bool((i < 0)) ? ((i < 0)) : ((pyNotEq(key_pos(this.vp(notes[i].pitch)), dst))))) {
        t1 = starts[pyAdd(i, 1)];
        t0 = ((i >= 0) ? this.finger_ends[f][i] : (t1 - PREP_LOOKBACK_T));
        for (g = 2; g < 6; g += 1) {
          if ((pyEq(g, f))) {
            continue;
          }
          [gs, ge, gn] = [this.finger_starts[g], this.finger_ends[g], this.by_finger[g]];
          j = (bisectRight(gs, t1) - 1);
          while ((((j >= 0)) && ((ge[j] > t0)))) {
            p = key_pos(this.vp(gn[j].pitch));
            if (bool(((g > f) ? (p < dst) : (p > dst)))) {
              got = pyMax(got, ge[j]);
            }
            j -= 1;
          }
        }
      }
      cache[key] = got;
    }
    return got;
  }
  _prep_window(f: any = null, i: any = null): any {
    let ends: any, need: any, nxt: any, prep_start: any, starts: any, strike: any, window: any;
    // (prep_start, strike_start, strike) for finger f's note i+1 (i = its last note, or -1).
    [starts, ends] = [this.finger_starts[f], this.finger_ends[f]];
    nxt = starts[pyAdd(i, 1)];
    need = pyGet(this.lead, pyId(this.by_finger[f][pyAdd(i, 1)]), 0.0);
    prep_start = pyMax((nxt - pyMax(this.prep_max_t, pyAdd(STRIKE_MIN_T, need))), ((i >= 0) ? ends[i] : (-Infinity)));
    prep_start = pyMax(prep_start, pyMin(this._blocked_until(f, i), (nxt - STRIKE_MIN_T)));
    window = pyMax(0.0, (nxt - prep_start));
    strike = pyMin(STRIKE_T, pyMult(0.35, window));
    if (((window - strike) < need)) {
      strike = pyMin(strike, pyMax(STRIKE_MIN_T, (window - need)));
    }
    return [prep_start, (nxt - strike), strike];
  }
  _travel(f: any = null, i: any = null, t: any = null): any {
    let _: any, need: any, prep_start: any, span: any, strike_start: any, window: any;
    // 
    //         How far (0..1) finger f has travelled from its last key toward the
    //         next one at time t. It leaves as soon as it is free and gets there
    //         early (self.travel_share of the time), then hovers, ready to strike.
    //         
    [prep_start, strike_start, _] = this._prep_window(f, i);
    window = (strike_start - prep_start);
    need = pyGet(this.lead, pyId(this.by_finger[f][pyAdd(i, 1)]), 0.0);
    span = pyMax(0.001, pyMult(window, this.travel_share), pyMin(need, window));
    return [_smooth(((t - prep_start) / span)), prep_start];
  }
  _tip_target(f: any = null, t: any = null, rest_xy: any = null, hand: any = null): any {
    let S: any, arc: any, busy: any, comp: any, ends: any, hover: any, i: any, idle: any, kx: any, ky: any, low: any, notes: any, nxt: any, prep: any, prep_start: any, prev: any, prev_end: any, s: any, since: any, starts: any, strike: any, strike_start: any, travel: any, tx: any, z: any;
    // 
    //         (x, y, z) world target for fingertip f at time t, and how busy it is
    //         (0..1). With the hand's (wx, wy, psi), keys are aimed at where this
    //         hand can play them (_key_spot), the same spot all the way from the
    //         approach through the strike, the press and the release.
    //         
    S = this.S;
    hover = this._hover(f);
    prep = pyMult(this.prep_h[f], S);
    travel = this.travel;
    [notes, starts, ends] = [this.by_finger[f], this.finger_starts[f], this.finger_ends[f]];
    i = (bisectRight(starts, t) - 1);
    prev = ((i >= 0) ? notes[i] : null);
    nxt = ((pyAdd(i, 1) < (notes).length) ? notes[pyAdd(i, 1)] : null);
    prev_end = (bool(prev) ? ends[i] : (-Infinity));
    [comp, low] = [this._run_w(t), this._low(t)];
    if ((bool(prev) && ((t < prev_end)))) {
      [kx, ky] = this._key_spot(this._pk(prev), f, hand, null, prev, 0.0, comp, low);
      return [[kx, ky, pyMult((-travel), pyMin(1.0, ((t - starts[i]) / PRESS_T)))], 1.0];
    }
    if (bool(prev)) {
      [kx, ky] = this._key_spot(this._pk(prev), f, hand, null, prev, 0.0, comp, low);
      since = (t - prev_end);
      z = _lerp((-travel), hover, _ease_out((since / RELEASE_T)));
      s = _smooth(((since - LINGER_T) / RETURN_T));
      idle = [_lerp(kx, rest_xy[0], s), _lerp(ky, rest_xy[1], s), z];
      busy = (1.0 - s);
    } else {
      idle = [rest_xy[0], rest_xy[1], hover];
      busy = 0.0;
    }
    if ((nxt === null)) {
      return [idle, busy];
    }
    [prep_start, strike_start, strike] = this._prep_window(f, i);
    if ((t < prep_start)) {
      return [idle, busy];
    }
    s = ((t < strike_start) ? this._travel(f, i, t)[0] : 1.0);
    [kx, ky] = this._key_spot(this._pk(nxt), f, hand, null, nxt, (1.0 - s), comp, low);
    if ((t < strike_start)) {
      arc = 0.0;
      if ((pyNotEq(f, 1))) {
        arc = pyMin(pyMult(0.3, Math.abs((kx - idle[0]))), pyMult(1.5, S));
        tx = this._thumb_x(t);
        if ((((tx !== null)) && ((kx < (tx - pyMult(0.3, this.kb.white_w)))) && ((idle[0] > kx)))) {
          arc = pyMax(arc, pyMult(this.cross_arc_in, this.ppi));
        }
        arc *= Math.sin(pyMult(Math.PI, s));
      }
      return [[_lerp(idle[0], kx, s), _lerp(idle[1], ky, s), pyAdd(_lerp(idle[2], prep, s), arc)], pyMax(busy, s)];
    }
    s = ((t - strike_start) / pyMax(0.001, strike));
    return [[kx, ky, _lerp(prep, 0.0, pyMult(s, s))], 1.0];
  }
  _thumb_x(t: any = null): any {
    let i: any, starts: any;
    // Working-frame x of the key the thumb is on (or last played), if any.
    starts = this.finger_starts[1];
    i = (bisectRight(starts, t) - 1);
    if ((i < 0)) {
      return null;
    }
    return this.key_target(this._pk(this.by_finger[1][i]), 1)[0];
  }
  _shaped_rests(busy: any = null, local: any = null): any {
    let band: any, cap_x: any, cap_y: any, disp: any, dx: any, dy: any, f: any, g: any, hi: any, k: any, lo: any, out: any, rest: any, s: any, w: any;
    // 
    //         Resting spots (hand frame) for the fingers, shifted so idle fingers
    //         fan out between busy neighbours: when 1 and 5 stretch an octave the
    //         middle fingers spread with them, when the hand closes they close too.
    //         
    rest = this.rest_local;
    disp = {  };
    band = pyMult(pyMult(0.5, WHITE_KEY_IN), this.ppi);
    for (g = 1; g < 6; g += 1) {
      w = busy[g];
      if ((pyEq(g, 1))) {
        w *= _smooth(pyAdd(0.5, ((rest[2][0] - local[1][0]) / band)));
      } else {
        w *= (1.0 - pyMult(pyMin(1.0, (busy[1] / 0.1)), _smooth(pyAdd(0.5, ((local[1][0] - local[g][0]) / band)))));
      }
      if ((w <= 0.001)) {
        continue;
      }
      [dx, dy] = [(local[g][0] - rest[g][0]), (local[g][1] - rest[g][1])];
      disp[g] = [pyMult(dx, w), pyMult(dy, w)];
    }
    [cap_x, cap_y] = [pyMult(pyMult(0.9, WHITE_KEY_IN), this.ppi), pyMult(pyMult(0.5, WHITE_KEY_IN), this.ppi)];
    out = {  };
    for (f = 1; f < 6; f += 1) {
      lo = pyMax(Array.from(pyIter(disp)).filter((g: any) => (g < f)).map((g: any) => g), null, null);
      hi = pyMin(Array.from(pyIter(disp)).filter((g: any) => (g > f)).map((g: any) => g), null, null);
      if ((((lo !== null)) && ((hi !== null)))) {
        s = ((f - lo) / (hi - lo));
        dx = _lerp(disp[lo][0], disp[hi][0], s);
        dy = _lerp(disp[lo][1], disp[hi][1], s);
      } else {
        if ((bool((lo !== null)) ? ((lo !== null)) : ((hi !== null)))) {
          g = ((lo !== null) ? lo : hi);
          k = Math.pow(SHAPE_FALLOFF, Math.abs((f - g)));
          [dx, dy] = [pyMult(disp[g][0], k), pyMult(disp[g][1], k)];
        } else {
          dx = 0.0;
          dy = dx;
        }
      }
      out[f] = [pyAdd(rest[f][0], _clamp(dx, (-cap_x), cap_x)), pyAdd(rest[f][1], _clamp(dy, (-cap_y), cap_y))];
    }
    return out;
  }
  _limit_tip(f: any = null, tip: any = null, wx: any = null, wy: any = null, psi: any = null, comp: any = null, stretch: any = null, low: any = null): any {
    let slack: any, x: any, y: any, z: any;
    // 
    //         Clamp a fingertip target to the finger's splay and reach range (widened
    //         inward in a run, `comp`; the full stretch only as far as `stretch`).
    //         
    slack = ((tip[2] < 0) ? ((PRESS_SLACK_DEG[f]) * Math.PI / 180.0) : 0.0);
    z = tip[2];
    if ((pyNotEq(f, 1))) {
      z = pyMin(z, (pyMult(this.base_local[f][2], low) - pyMult(TIP_BELOW_KNUCKLE, this.length[f])));
    }
    [x, y] = this._clamp_tip(f, tip[0], tip[1], z, wx, wy, psi, slack, 0.0, comp, stretch, low);
    return [x, y, tip[2]];
  }
  pose(t: any = null, kb: any = null): any {
    let ep: any, fp: any, g: any, p: any, px: any, py: any, rush: any, target: any;
    // 
    //         Skeleton at time t (see _finger_pose), blended into the glissando
    //         pose (_gliss_pose) around this hand's glissandos.
    //         
    this._ensure_layout(kb);
    [g, ep] = this._gliss_w(t);
    if ((g >= 1.0)) {
      return this._gliss_pose(t, ep, kb, g);
    }
    fp = this._finger_pose(t, kb);
    target = this._gliss_across(t, kb);
    if ((target === null)) {
      rush = this._gliss_rush(t, kb);
      if ((rush !== null)) {
        target = [pyAdd(rush[0], rush[2]), pyAdd(rush[1], rush[3])];
      } else {
        fp = this._gliss_travel(t, kb, fp);
      }
    }
    p = ((g <= 0.0) ? fp : _blend_pose(fp, this._gliss_pose(t, ep, kb, g), g));
    if ((target !== null)) {
      [px, py] = this._pose_wrist(p);
      p = _shift_pose(p, (target[0] - px), (target[1] - py), this.mirror);
    }
    return { ...p, anim: this };
  }
  footprint(t: any = null): any {
    let a: any, b: any, c: any, held: any, i: any, idx: any, pinky: any, soon: any, thumb: any, ts: any, xs: any;
    // 
    //         (left, right) screen x the hand covers at t, for contact (_layer_top),
    //         from its notes - free to look far ahead, where a placement solved
    //         there stalled a frame: the keys of its latest chord (its next one when
    //         that's near, CONTACT_NEXT_T, or the hand has been silent CROSS_STALE),
    //         widened by CONTACT_PAD_WK (thumb side, little finger side), at least the
    //         hand's own width. Idle, it keeps out of the other's way: None - unless
    //         its next notes are near (CONTACT_AHEAD_T), when it's there already (a
    //         hand leaping in is foreseen while it's still on its way).
    //         
    if (bool((!bool(this.groups)))) {
      return null;
    }
    if ((this._foot === null)) {
      xs = pyAdd(Array.from(pyIter(pyRange(1, 6))).map((f: any) => this.rest_local[f][0]), Array.from(pyIter(pyRange(1, 6))).map((f: any) => this.base_local[f][0]));
      this._foot = (pyMax(xs) - pyMin(xs));
    }
    ts = this._group_ts;
    i = (bisectRight(ts, t) - 1);
    idx = Array.from(pyIter([i, pyAdd(i, 1)])).filter((j: any) => ((0 <= j) && (j < (ts).length))).map((j: any) => j);
    held = (((i >= 0)) && bool(Array.from(Array.from(pyIter(this.groups[i][1])).map((n: any) => (n.end > t))).some(Boolean)));
    soon = (((pyAdd(i, 1) < (ts).length)) && (((ts[pyAdd(i, 1)] - t) <= CONTACT_AHEAD_T)));
    if ((((!bool(held))) && bool(soon))) {
      idx = [pyAdd(i, 1)];
    } else {
      if ((this.idle_at(t) > 0.5)) {
        return null;
      } else {
        if ((((i >= 0)) && ((pyAdd(i, 1) < (ts).length)) && (((ts[pyAdd(i, 1)] - t) > CONTACT_NEXT_T)) && (((t - ts[i]) < CROSS_STALE)))) {
          idx = [i];
        } else {
          if ((((i >= 0)) && (((t - ts[i]) >= CROSS_STALE)) && ((pyAdd(i, 1) < (ts).length)))) {
            idx = [pyAdd(i, 1)];
          }
        }
      }
    }
    xs = Array.from(pyIter(idx)).flatMap((j: any) => Array.from(pyIter(this.groups[j][1])).filter((n: any) => (pyIn(n.pitch, this.kb.key_rects))).map((n: any) => this.kb.key_rects[n.pitch].centerx));
    if (bool((!bool(xs)))) {
      return null;
    }
    [thumb, pinky] = Array.from(pyIter(CONTACT_PAD_WK)).map((w: any) => pyMult(w, this.kb.white_w));
    [a, b] = (bool(this.mirror) ? [(pyMin(xs) - pinky), pyAdd(pyMax(xs), thumb)] : [(pyMin(xs) - thumb), pyAdd(pyMax(xs), pinky)]);
    if (((b - a) < this._foot)) {
      c = (pyAdd(a, b) / 2);
      [a, b] = [(c - (this._foot / 2)), pyAdd(c, (this._foot / 2))];
    }
    return [a, b];
  }
  _pose_wrist(p: any = null): any {
    let _: any, ax: any, ay: any, bx: any, by: any;
    [[ax, ay, _], [bx, by, _]] = p['struct']['wrist'];
    return [(pyAdd(ax, bx) / 2), (pyAdd(ay, by) / 2)];
  }
  _gliss_follow(i: any = null, kb: any = null, leaving: any = null): any {
    let _: any, job: any, key: any, path: any;
    // 
    //         The hand's way from glissando episode i back to the finger pose
    //         (leaving) or from the finger pose into it: [(t, x, y)] on screen, in
    //         time order. It chases the finger pose (or, played backwards, runs
    //         from it) at no more than the top speed, speeding up and slowing down
    //         at GLISS_TRAVEL_ACC, until it is back on it.
    //         
    key = [i, leaving];
    path = pyGet(this._gliss_follow_cache, key, null);
    if ((path !== null)) {
      return (bool(path) ? (path) : (null));
    }
    job = (bool(pyPop(this._follow_jobs, key, null)) ? (pyPop(this._follow_jobs, key, null)) : (this._gliss_follow_steps(i, kb, leaving)));
    for (_ of pyIter(job)) {
      ;
    }
    return (bool(this._gliss_follow_cache[key]) ? (this._gliss_follow_cache[key]) : (null));
  }
  _gliss_follow_steps(i: any = null, kb: any = null, leaving: any = null): any {
    let W: any, _: any, acc: any, d: any, dt: any, dx: any, dy: any, e: any, ex: any, ey: any, fx: any, fy: any, key: any, path: any, sp: any, t: any, t0: any, t1: any, ta: any, vmax: any, vx: any, vy: any, wx: any, wy: any, x: any, y: any;
    // _gliss_follow as a job that yields after each step, so prepare() can do it a little at a time.
    key = [i, leaving];
    [t0, t1, _] = this._gliss_paths()[i];
    W = this._pose_wrist;
    ta = (bool(leaving) ? pyAdd(t1, GLISS_RAMP_T) : (t0 - GLISS_RAMP_T));
    [x, y] = W(this._gliss_pose((bool(leaving) ? t1 : t0), i, kb));
    vmax = pyMult((this.max_speed / 0.0254), this.ppi);
    acc = pyMult((GLISS_TRAVEL_ACC / 0.0254), this.ppi);
    dt = pyMult(GLISS_TRAVEL_DT, (bool(leaving) ? 1 : (-1)));
    vx = 0.0;
    vy = vx;
    [t, path] = [ta, [[ta, x, y]]];
    for (_ = 0; _ < Math.trunc((GLISS_TRAVEL_MAX_T / Math.abs(dt))); _ += 1) {
      t = pyAugAdd(t, dt);
      [fx, fy] = W(this._finger_pose(t, kb));
      [dx, dy] = [(fx - x), (fy - y)];
      d = Math.hypot(dx, dy);
      if ((((d < 0.5)) && ((Math.hypot(vx, vy) < pyMult(pyMult(acc, Math.abs(dt)), 2))))) {
        break;
      }
      sp = pyMin(vmax, Math.sqrt(pyMult(pyMult(2, acc), d)));
      [wx, wy] = ((d > 1e-09) ? [pyMult((dx / d), sp), pyMult((dy / d), sp)] : [0.0, 0.0]);
      [ex, ey] = [(wx - vx), (wy - vy)];
      e = Math.hypot(ex, ey);
      if ((e > pyMult(acc, Math.abs(dt)))) {
        [ex, ey] = [pyMult(pyMult((ex / e), acc), Math.abs(dt)), pyMult(pyMult((ey / e), acc), Math.abs(dt))];
      }
      [vx, vy] = [pyAdd(vx, ex), pyAdd(vy, ey)];
      [x, y] = [pyAdd(x, pyMult(vx, Math.abs(dt))), pyAdd(y, pyMult(vy, Math.abs(dt)))];
      path.push([t, x, y]);
      /* yield */;
    }
    if (bool((bool(leaving) ? (path[path.length - 1][0] > this._gliss_rush_window(i, true)[1]) : (path[path.length - 1][0] < this._gliss_rush_window(i, false)[0])))) {
      this._gliss_follow_cache[key] = false;
      return;
    }
    if (bool((!bool(leaving)))) {
      path.reverse();
    }
    this._gliss_follow_cache[key] = path;
  }
  prepare(t: any = null, kb: any = null, budget: any = null): any {
    let _: any, end: any, frontier: any, g: any, i: any, job: any, k: any, k_end: any, k_now: any, key: any, leaving: any, paths: any, start: any, t0: any, t1: any;
    // 
    //         Work done ahead, a little each frame (about `budget` seconds): the
    //         hand's motion (its speed-limited grid, a chain where each step needs
    //         the one before) carried on up to WARM_AHEAD_T past t, then the ways
    //         to and from the glissandos it reaches - so working any of it out
    //         when it's needed never stalls a frame. In steady play it costs no
    //         more than the frames would have spent anyway.
    //         
    this._ensure_layout(kb);
    end = pyAdd(time.perf_counter(), budget);
    g = LIMIT_GRID_T;
    k_now = Math.floor((t / g));
    if ((bool((this._warm_k === null)) ? ((this._warm_k === null)) : ((bool((this._warm_k < k_now)) ? ((this._warm_k < k_now)) : ((this._warm_k > pyAdd(k_now, (pyMult(4, WARM_AHEAD_T) / g)))))))) {
      this._warm_k = k_now;
    }
    k_end = Math.floor((pyAdd(t, WARM_AHEAD_T) / g));
    while ((this._warm_k < k_end)) {
      if ((time.perf_counter() > end)) {
        return;
      }
      this._warm_k = pyAugAdd(this._warm_k, 1);
      this._smooth_tip_grid(this._warm_k);
    }
    if (bool((!bool(this.gliss_eps)))) {
      return;
    }
    frontier = pyMult(this._warm_k, g);
    paths = this._gliss_paths();
    k = bisectRight(this._gliss_starts, frontier);
    for (i = pyMax(0, (k - 2)); i < k; i += 1) {
      [t0, t1, _] = paths[i];
      for ([leaving, start] of pyIter([[false, (t0 - GLISS_RAMP_T)], [true, pyAdd(t1, GLISS_RAMP_T)]])) {
        key = [i, leaving];
        if ((bool((pyIn(key, this._gliss_follow_cache))) ? ((pyIn(key, this._gliss_follow_cache))) : ((bool((frontier < start)) ? ((frontier < start)) : ((t > pyAdd(start, GLISS_TRAVEL_MAX_T))))))) {
          continue;
        }
        job = pyGet(this._follow_jobs, key, null);
        if ((job === null)) {
          job = this._gliss_follow_steps(i, kb, leaving);
          this._follow_jobs[key] = job;
        }
        for (_ of pyIter(job)) {
          if ((time.perf_counter() > end)) {
            return;
          }
        }
        pyPop(this._follow_jobs, key, null);
      }
    }
  }
  _gliss_rush_window(i: any = null, leaving: any = null): any {
    let _: any, t0: any, t1: any;
    // 
    //         (from, to): leaving episode i, from its end to just before the hand's
    //         next fingered strike; arriving, from just after the last key before
    //         it is let go to its start.
    //         
    [t0, t1, _] = this._gliss_paths()[i];
    if (bool(leaving)) {
      return [t1, pyMax(t1, (this._next_strike(t1) - GLISS_ARRIVE_T))];
    }
    return [pyMin(t0, pyAdd(this._last_release(t0), KEY_FIX_RELEASE_T)), t0];
  }
  _travel_u(u: any = null, T: any = null, D: any = null): any {
    let acc: any, d: any, disc: any, ta: any, v: any, vmax: any, x: any;
    // 
    //         Share of a move of D pixels done at u (0..1) of T seconds: smootherstep
    //         when that keeps to the top speed, else speeding up, cruising at the
    //         slowest speed that makes it and slowing down (GLISS_TRAVEL_ACC).
    //         
    u = pyMax(0.0, pyMin(1.0, u));
    vmax = pyMult((this.max_speed / 0.0254), this.ppi);
    if (((pyMult(D, 1.875) / pyMax(1e-06, T)) <= vmax)) {
      return _smooth(u);
    }
    acc = pyMult((GLISS_TRAVEL_ACC / 0.0254), this.ppi);
    disc = (Math.pow(pyMult(acc, T), 2) - pyMult(pyMult(4, acc), D));
    v = ((disc > 0) ? ((pyMult(acc, T) - Math.sqrt(disc)) / 2) : (pyMult(acc, T) / 2));
    ta = (v / acc);
    x = pyMult(u, T);
    if ((x < ta)) {
      d = pyMult(pyMult(pyMult(0.5, acc), x), x);
    } else {
      if ((x > (T - ta))) {
        d = (pyMult(v, (T - ta)) - pyMult(pyMult(0.5, acc), Math.pow((T - x), 2)));
      } else {
        d = pyAdd(pyMult(pyMult(pyMult(0.5, acc), ta), ta), pyMult(v, (x - ta)));
      }
    }
    return pyMax(0.0, pyMin(1.0, (d / pyMax(1e-06, pyMult(v, (T - ta))))));
  }
  _gliss_rush(t: any = null, kb: any = null): any {
    let W: any, _: any, at: any, d0: any, fx: any, fx0: any, fy: any, fy0: any, gx: any, gy: any, i: any, into: any, key: any, leaving: any, nxt: any, out: any, path: any, paths: any, prev: any, t0: any, t1: any, ta: any, tb: any, u: any, w: any;
    // 
    //         (fx, fy, dx, dy): when there isn't time to chase the finger pose
    //         (_gliss_follow None), where the wrist should be at t - the finger
    //         pose's wrist (fx, fy) plus an offset (dx, dy) from where the glissando
    //         left the hand (or where the next begins), easing out over
    //         _gliss_rush_window. None when it doesn't apply.
    //         
    if (bool((!bool(this.gliss_eps)))) {
      return null;
    }
    [out, into, prev, nxt] = this._gliss_neighbours(t, kb);
    W = this._pose_wrist;
    paths = this._gliss_paths();
    for ([i, leaving, path] of pyIter([[prev, true, out], [nxt, false, into]])) {
      if ((bool((i === null)) ? ((i === null)) : ((path !== null)))) {
        continue;
      }
      [ta, tb] = this._gliss_rush_window(i, leaving);
      [t0, t1, _] = paths[i];
      if ((bool(leaving) && ((nxt !== null)) && ((pyNotEq(nxt, i))))) {
        tb = pyMin(tb, (bool(into) ? into[0][0] : (paths[nxt][0] - GLISS_RAMP_T)));
      } else {
        if ((((!bool(leaving))) && ((prev !== null)) && ((pyNotEq(prev, i))))) {
          ta = pyMax(ta, (bool(out) ? out[out.length - 1][0] : pyAdd(paths[prev][1], GLISS_RAMP_T)));
        }
      }
      if (bool((bool(leaving) ? (tb <= pyAdd(t1, GLISS_RAMP_T)) : (ta >= (t0 - GLISS_RAMP_T))))) {
        continue;
      }
      if (bool((!((ta <= t) && (t <= tb))))) {
        continue;
      }
      key = ['rush', i, leaving];
      d0 = pyGet(this._gliss_follow_cache, key, null);
      if ((d0 === null)) {
        at = (bool(leaving) ? t1 : t0);
        [gx, gy] = W(this._gliss_pose(at, i, kb));
        [fx0, fy0] = W(this._finger_pose((bool((!bool(leaving))) ? tb : ta), kb));
        d0 = [(gx - fx0), (gy - fy0)];
        this._gliss_follow_cache[key] = d0;
      }
      u = this._travel_u(((t - ta) / pyMax(1e-06, (tb - ta))), (tb - ta), Math.hypot(...d0));
      w = (bool(leaving) ? (1.0 - u) : u);
      [fx, fy] = W(this._finger_pose(t, kb));
      return [fx, fy, pyMult(d0[0], w), pyMult(d0[1], w)];
    }
    return null;
  }
  _strikes(): any {
    let e: any, f: any, n: any, ns: any, out: any;
    // [(struck, let go)] of the hand's fingered notes, by when struck.
    if ((this._strike_list === null)) {
      out = [];
      for ([f, ns] of pyIter(pyItems(this.by_finger))) {
        for ([n, e] of pyIter(zip(ns, this.finger_ends[f]))) {
          out.push([this.start_of[pyId(n)], e]);
        }
      }
      out.sort((a: any, b: any) => { const ka = null ? (null)(a) : a; const kb = null ? (null)(b) : b; return ka < kb ? (false ? 1 : -1) : (ka > kb ? (false ? -1 : 1) : 0); });
      this._strike_list = out;
      this._strike_starts = Array.from(pyIter(out)).map((p: any) => p[0]);
    }
    return this._strike_list;
  }
  _next_strike(t: any = null): any {
    let k: any;
    // When the hand next strikes a fingered key after t (inf if never).
    this._strikes();
    k = bisectRight(this._strike_starts, t);
    return ((k < (this._strike_starts).length) ? this._strike_starts[k] : Infinity);
  }
  _last_release(t: any = null): any {
    let k: any, ps: any;
    // When the hand lets go of the last fingered key it struck before t (-inf if none).
    ps = this._strikes();
    k = bisectLeft(this._strike_starts, t);
    return (bool(k) ? pyMax(Array.from(pyIter(ps.slice(0, k))).map(([_0, e]: any) => e), null, (-Infinity)) : (-Infinity));
  }
  _along(path: any = null, t: any = null): any {
    let k: any, ta: any, tb: any, u: any, xa: any, xb: any, ya: any, yb: any;
    k = (bisectRight(Array.from(pyIter(path)).map((p: any) => p[0]), t) - 1);
    k = pyMax(0, pyMin(((path).length - 2), k));
    [[ta, xa, ya], [tb, xb, yb]] = [path[k], path[pyAdd(k, 1)]];
    u = pyMax(0.0, pyMin(1.0, ((t - ta) / pyMax(1e-09, (tb - ta)))));
    return [pyAdd(xa, pyMult((xb - xa), u)), pyAdd(ya, pyMult((yb - ya), u))];
  }
  _gliss_neighbours(t: any = null, kb: any = null): any {
    let into: any, k: any, nxt: any, out: any, paths: any, prev: any, reach: any;
    // (the hand's way back from the last glissando episode, its way into the next, their indices) at t.
    paths = this._gliss_paths();
    k = (bisectRight(this._gliss_starts, t) - 1);
    prev = ((((k >= 0)) && ((paths[k][1] <= t))) ? k : null);
    nxt = ((pyAdd(k, 1) < (paths).length) ? pyAdd(k, 1) : null);
    reach = pyAdd(pyAdd(GLISS_TRAVEL_MAX_T, GLISS_RAMP_T), 0.1);
    out = ((prev !== null) ? ((t <= pyAdd(paths[prev][1], reach)) ? this._gliss_follow(prev, kb, true) : []) : null);
    into = ((nxt !== null) ? ((t >= (paths[nxt][0] - reach)) ? this._gliss_follow(nxt, kb, false) : []) : null);
    return [out, into, prev, nxt];
  }
  _gliss_across(t: any = null, kb: any = null): any {
    let T: any, _: any, into: any, nxt: any, out: any, paths: any, prev: any, te: any, ts: any, u: any, xe: any, xs: any, ye: any, ys: any;
    // 
    //         Where the wrist is at t when there's no time to get back to the
    //         finger pose between two glissandos (the way back from one ends after
    //         the way into the next begins): straight from where the first one
    //         ends to where the next begins, over the whole gap, blends included.
    //         None otherwise.
    //         
    if (bool((!bool(this.gliss_eps)))) {
      return null;
    }
    [out, into, prev, nxt] = this._gliss_neighbours(t, kb);
    if (bool((!(bool(out) && bool(into) && ((out[out.length - 1][0] > into[0][0])))))) {
      return null;
    }
    paths = this._gliss_paths();
    [te, ts] = [paths[prev][1], paths[nxt][0]];
    if ((this._next_strike(te) < ts)) {
      return null;
    }
    if (bool((!((te <= t) && (t <= ts))))) {
      return null;
    }
    [[_, xe, ye], [_, xs, ys]] = [out[0], into[into.length - 1]];
    T = pyMax(1e-06, (ts - te));
    u = this._travel_u(((t - te) / T), T, Math.hypot((xs - xe), (ys - ye)));
    return [pyAdd(xe, pyMult((xs - xe), u)), pyAdd(ye, pyMult((ys - ye), u))];
  }
  _gliss_travel(t: any = null, kb: any = null, fp: any = null): any {
    let _: any, fx: any, fy: any, hx: any, hy: any, into: any, out: any;
    // 
    //         The finger pose, moved so the hand leaves a glissando from where it
    //         ended and comes to the next one where it starts, never faster than
    //         the top speed (_gliss_follow): after a glissando it catches up with
    //         the finger pose, before one it leaves it just in time. (When the two
    //         overlap, _gliss_across takes over.)
    //         
    if (bool((!bool(this.gliss_eps)))) {
      return fp;
    }
    [out, into, _, _] = this._gliss_neighbours(t, kb);
    if ((bool(out) && ((t > out[out.length - 1][0])))) {
      out = null;
    }
    if ((bool(into) && ((t < into[0][0])))) {
      into = null;
    }
    if ((((!bool(out))) && ((!bool(into))))) {
      return fp;
    }
    [fx, fy] = this._pose_wrist(fp);
    [hx, hy] = this._along((bool(out) ? (out) : (into)), t);
    return _shift_pose(fp, (hx - fx), (hy - fy), this.mirror);
  }
  _gliss_schedule(): any {
    let d: any, ep: any, n: any, need: any, out: any, pd: any, per_wk: any, pn: any, prev: any, pt: any, r: any, t: any;
    // 
    //         {id(note): when it's struck} for the glissando notes: their own times,
    //         except that the slide keeps to the top speed. A key further on than
    //         the hand can slide in the time it has (a run's loose end skipping
    //         keys, in a file that hurries it) is struck late, and the keys after
    //         it with it. The step's speed is as _gliss_contact moves: steady
    //         within a run, eased (GLISS_EASE_PEAK at its fastest) where it turns
    //         round or pauses; GLISS_SPEED_SHARE leaves room for the hand's turn.
    //         

    out = {  };
    per_wk = (fg.WHITE_KEY_M / pyMult(this.max_speed, GLISS_SPEED_SHARE));
    for (ep of pyIter(this.gliss_eps)) {
      prev = null;
      for (r of pyIter(ep)) {
        d = ((r[r.length - 1].pitch >= r[0].pitch) ? 1 : (-1));
        for (n of pyIter(r)) {
          t = n.start;
          if ((prev !== null)) {
            [pn, pt, pd] = prev;
            need = pyMult(Math.abs((key_pos(n.pitch) - key_pos(pn.pitch))), per_wk);
            if ((bool((pyNotEq(pd, d))) ? ((pyNotEq(pd, d))) : (((t - pt) > 0.2)))) {
              need *= GLISS_EASE_PEAK;
            }
            t = pyMax(t, pyAdd(pt, need));
          }
          out[pyId(n)] = t;
          prev = [n, t, d];
        }
      }
    }
    return out;
  }
  _gliss_end(ep: any = null): any {
    let last: any, ls: any;
    // When the hand leaves glissando episode ep's last key (its glissando pose holds until then).
    last = ep[ep.length - 1][ep[ep.length - 1].length - 1];
    ls = this.gliss_start[pyId(last)];
    return pyMax(ls, pyMin((pyAdd(last.end, ls) - last.start), pyAdd(ls, 0.12)));
  }
  _gliss_exits(): any {
    let ep: any, f: any, first: any, last: any, out: any;
    // [(when the hand leaves a glissando, the hand's range there - as fingering.hand_range)], in time order.

    out = [];
    for (ep of pyIter(this.gliss_eps)) {
      [first, last] = [ep[ep.length - 1][0], ep[ep.length - 1][ep[ep.length - 1].length - 1]];
      f = ((this.vp(last.pitch) >= this.vp(first.pitch)) ? 2 : 1);
      out.push([this._gliss_end(ep), fg.hand_range([this.vp(last.pitch)], [f])]);
    }
    out.sort((a: any, b: any) => { const ka = ((e) => e[0]) ? (((e) => e[0]))(a) : a; const kb = ((e) => e[0]) ? (((e) => e[0]))(b) : b; return ka < kb ? (false ? 1 : -1) : (ka > kb ? (false ? -1 : 1) : 0); });
    return out;
  }
  _gliss_performance(): any {
    let n: any, out: any, r: any, s: any;
    // [(press, release, note)] for the glissando notes, at their scheduled times.
    out = [];
    for (r of pyIter(this.gliss_runs)) {
      for (n of pyIter(r)) {
        s = this.gliss_start[pyId(n)];
        out.push([s, (pyAdd(n.end, s) - n.start), n]);
      }
    }
    return out;
  }
  _gliss_paths(): any {
    let d: any, ep: any, front: any, n: any, out: any, pts: any, r: any, white_in: any, x: any, xs: any, y: any;
    // 
    //         Per glissando episode, in the working frame: (start, end, [(t, x, y,
    //         direction)] - where the backs of the fingers touch the keys at each
    //         note, and which way the run goes (+1: toward the little finger).
    //         
    if ((this._gliss_cache !== null)) {
      return this._gliss_cache;
    }
    out = [];
    for (ep of pyIter(this.gliss_eps)) {
      pts = [];
      for (r of pyIter(ep)) {
        xs = Array.from(pyIter(r)).map((n: any) => this.key_target(n.pitch, 2)[0]);
        d = ((xs[xs.length - 1] >= xs[0]) ? 1.0 : (-1.0));
        front = (this.kb.rect.h - this.kb.black_h);
        white_in = ((d > 0) ? GLISS_WHITE_IN : pyMin(GLISS_THUMB_IN, (front / this.ppi)));
        for ([n, x] of pyIter(zip(r, xs))) {
          y = (bool(is_black_key(n.pitch)) ? pyAdd(front, pyMult(GLISS_BLACK_IN, this.ppi)) : pyMult(white_in, this.ppi));
          pts.push([this.gliss_start[pyId(n)], x, y, d]);
        }
      }
      out.push([pts[0][0], this._gliss_end(ep), pts]);
    }
    this._gliss_cache = out;
    return out;
  }
  _gliss_w(t: any = null): any {
    let _: any, best: any, i: any, j: any, paths: any, t0: any, t1: any, w: any;
    // (0..1 how much the hand is in its glissando pose at t, that episode's index or None).
    if (bool((!bool(this.gliss_eps)))) {
      return [0.0, null];
    }
    paths = this._gliss_paths();
    i = (bisectRight(this._gliss_starts, pyAdd(t, GLISS_RAMP_T)) - 1);
    best = [0.0, null];
    for (j of pyIter([i, (i - 1)])) {
      if ((j < 0)) {
        continue;
      }
      [t0, t1, _] = paths[j];
      if ((t < t0)) {
        w = _smooth((1.0 - ((t0 - t) / GLISS_RAMP_T)));
      } else {
        if ((t <= t1)) {
          w = 1.0;
        } else {
          w = _smooth((1.0 - ((t - t1) / GLISS_RAMP_T)));
        }
      }
      if ((w > best[0])) {
        best = [w, j];
      }
    }
    return best;
  }
  _gliss_contact(t: any = null, i: any = null): any {
    let da: any, db: any, k: any, pts: any, ta: any, tb: any, u: any, xa: any, xb: any, ya: any, yb: any;
    // (x, y, roll direction -1..1) where the fingertips are on the keys at t in episode i.
    pts = this._gliss_paths()[i][2];
    if ((t <= pts[0][0])) {
      return [pts[0][1], pts[0][2], pts[0][3]];
    }
    if ((t >= pts[pts.length - 1][0])) {
      return [pts[pts.length - 1][1], pts[pts.length - 1][2], pts[pts.length - 1][3]];
    }
    k = (bisectRight(Array.from(pyIter(pts)).map((p: any) => p[0]), t) - 1);
    [[ta, xa, ya, da], [tb, xb, yb, db]] = [pts[k], pts[pyAdd(k, 1)]];
    u = ((t - ta) / pyMax(1e-06, (tb - ta)));
    if ((bool((pyNotEq(da, db))) ? ((pyNotEq(da, db))) : (((tb - ta) > 0.2)))) {
      u = _smooth(u);
    }
    return [_lerp(xa, xb, u), _lerp(ya, yb, u), _lerp(da, db, u)];
  }
  _gliss_pose(t: any = null, i: any = null, kb: any = null, g: any = null): any {
    let L: any, S: any, a: any, ap: any, apex: any, arm_end: any, b: any, back: any, bases: any, bones: any, chains: any, cmc: any, cp: any, cr: any, curled: any, cx: any, cy: any, d: any, extra: any, f: any, fd: any, fl: any, flat: any, front: any, fx: any, geo: any, hide: any, joints: any, kind: any, low: any, m3: any, mcps: any, natural: any, out: any, out_chains: any, ox: any, oy: any, oz: any, p: any, palm_up: any, ph: any, psi: any, pts: any, push: any, reach: any, ring: any, ro: any, rot: any, sp: any, sq: any, sr: any, struct: any, thumb: any, tucked: any, turn: any, tv: any, u: any, wb: any, wcmc: any, wr: any, wu: any, wx: any, wy: any, zc: any;
    // 
    //         The glissando pose. Sliding toward the little finger (RH up, LH
    //         down): the hand flat and turned over, palm up, the fingers straight
    //         and together, the thumb tucked in along the index, the fingers
    //         trailing - the backs of the fingertips (the nails) on the keys.
    //         Sliding toward the thumb (RH down, LH up): palm down, fingers 2-5
    //         curled right in, the thumb straight out along the keys, its nail on
    //         them. One family of poses (u: 1 the first, 0 the second), so turning
    //         round between glissandos goes smoothly from one to the other.
    //         
    [S, geo, rot] = [this.S, this.geo, this._rot];
    [cx, cy, d] = this._gliss_contact(t, i);
    m3 = geo.mcp[3];
    sq = ((p) => [pyAdd(m3[0], pyMult((p[0] - m3[0]), GLISS_SQUEEZE)), p[1], p[2]]);
    mcps = Object.fromEntries(Array.from(pyIter(pyRange(2, 6))).map((f: any) => [f, sq(geo.mcp[f])]));
    bases = Object.fromEntries(Array.from(pyIter(pyRange(2, 6))).map((f: any) => [f, pyAdd([pyMult(geo.mc_base[f][0], pyAdd(0.5, pyMult(0.5, GLISS_SQUEEZE)))], [...geo.mc_base[f].slice(1)])]));
    cmc = geo.thumb_cmc;
    u = _smooth((pyAdd(d, 1.0) / 2.0));
    const unit = (v: any = null): any => {
      let n_: any;
      n_ = Math.sqrt((Array.from(pyIter(v)).map((c: any) => pyMult(c, c))).reduce((a: any, b: any) => a + b, 0));
      return [...Array.from(pyIter(v)).map((c: any) => (c / n_))];
    };
    fd = unit(GLISS_FINGER_DIR);
    chains = {  };
    for (f = 2; f < 6; f += 1) {
      L = pyMult((geo.bones[f]).reduce((a: any, b: any) => a + b, 0), 0.98);
      flat = _add(mcps[f], _mul(fd, L));
      curled = _add(mcps[f], GLISS_CURL);
      chains[f] = solve_chain(mcps[f], _lerp3(curled, flat, u), [...geo.bones[f]], [0.0, 0.0, 1.0], FINGER_COUPLING, FINGER_BEND_MAX);
    }
    tucked = _add(mcps[2], GLISS_THUMB_TIP);
    out = _add(cmc, _mul(unit(GLISS_THUMB_DIR), pyMult((geo.bones[1]).reduce((a: any, b: any) => a + b, 0), 0.98)));
    thumb = solve_chain(cmc, _lerp3(out, tucked, u), [...geo.bones[1]], _lerp3([(-0.85), 0.0, 0.5], [(-0.6), 0.0, (-0.8)], u), THUMB_COUPLING, THUMB_BEND_MAX);
    apex = _lerp3(thumb[thumb.length - 1], _lerp3(chains[2][chains[2].length - 1], chains[3][chains[3].length - 1], 0.5), u);
    zc = WRIST_Z;
    ro = pyMult(pyMult(((GLISS_ROLL_DEG) * Math.PI / 180.0), g), u);
    ph = ((_lerp(GLISS_THUMB_PITCH_DEG, GLISS_PITCH_DEG, u)) * Math.PI / 180.0);
    [cr, sr, cp, sp] = [Math.cos(ro), Math.sin(ro), Math.cos(ph), Math.sin(ph)];
    tv = [(thumb[thumb.length - 1][0] - cmc[0]), (thumb[thumb.length - 1][1] - cmc[1])];
    turn = _lerp(Math.atan2(tv[0], tv[1]), ((GLISS_YAW_DEG) * Math.PI / 180.0), u);
    psi = pyAdd(pyMult(this._yaw(cx), u), turn);
    const place = (p: any = null, roll: any = null): any => {
      let x: any, y: any, z: any;
      [x, y, z] = p;
      if (bool(roll)) {
        [x, z] = [pyAdd(pyMult(x, cr), pyMult((z - zc), sr)), pyAdd((zc - pyMult(x, sr)), pyMult((z - zc), cr))];
      }
      [y, z] = [pyAdd(pyMult(y, cp), pyMult((z - zc), sp)), pyAdd((zc - pyMult(y, sp)), pyMult((z - zc), cp))];
      [x, y] = rot(pyMult(x, S), pyMult(y, S), psi);
      return [x, y, pyMult(z, S)];
    };
    low = pyMin(Array.from(pyIter(pyAdd([...pyValues(chains)], [thumb]))).flatMap((c: any) => Array.from(pyIter(c.slice(1))).map((p: any) => place(p))), ((p) => p[2]));
    ap = place(apex);
    front = (this.kb.rect.h - this.kb.black_h);
    if ((((u < 1.0)) && ((cy <= pyAdd(front, 1e-06))))) {
      reach = (pyMax(Array.from(pyIter(pyRange(2, 6))).flatMap((f: any) => Array.from(pyIter(chains[f])).map((p: any) => place(p)[1]))) - ap[1]);
      cy = pyMin(cy, pyMax(pyMult(GLISS_WHITE_IN, this.ppi), ((front - pyMult(GLISS_FIST_CLEAR, this.ppi)) - reach)));
    }
    [ox, oy, oz] = [(cx - ap[0]), (cy - ap[1]), (pyMult((-this.travel), 0.5) - low[2])];
    const world = (p: any = null, roll: any = null): any => {
      let x: any, y: any, z: any;
      [x, y, z] = place(p, roll);
      return [pyAdd(ox, x), pyAdd(oy, y), pyAdd(oz, z)];
    };
    [wr, wu] = [world(geo.wrist_sides[0], false), world(geo.wrist_sides[1], false)];
    wcmc = world(cmc);
    wb = Object.fromEntries(Array.from(pyIter(pyRange(2, 6))).map((f: any) => [f, world(bases[f])]));
    [bones, joints] = [[], []];
    push = pyMult(((GLISS_THUMB_ARM_DEG) * Math.PI / 180.0), (1.0 - u));
    natural = pyMult(pyMult((-0.45), Math.atan2((cx - this.shoulder_x), this.forearm_len)), u);
    back = rot(0.0, (-1.0), pyAdd(pyAdd(natural, pyMult(GLISS_ARM_SHARE, turn)), push));
    fl = pyMult(12, this.ppi);
    for (p of pyIter([wr, wu])) {
      bones.push([p, [pyAdd(p[0], pyMult(back[0], fl)), pyAdd(p[1], pyMult(back[1], fl)), pyAdd(p[2], pyMult(0.5, S))], 'forearm']);
    }
    ring = [wr, wcmc, wb[2], wb[3], wb[4], wb[5], wu];
    for ([a, b] of pyIter(zip(ring, ring.slice(1)))) {
      bones.push([a, b, 'carpal']);
    }
    bones.push([wr, wu, 'carpal']);
    out_chains = {  };
    for (f = 2; f < 6; f += 1) {
      pts = Array.from(pyIter(chains[f])).map((p: any) => world(p));
      bones.push([wb[f], pts[0], 'metacarpal']);
      out_chains[f] = pyAdd([wb[f]], pts);
      for ([[a, b], kind] of pyIter(zip(zip(pts, pts.slice(1)), ['proximal', 'middle', 'distal']))) {
        bones.push([a, b, kind]);
      }
      joints = pyAugAdd(joints, pyAdd(Array.from(pyIter(pts.slice(0, 3))).map((p: any) => [p, 'knuckle']), [[pts[3], 'tip']]));
    }
    pts = Array.from(pyIter(thumb)).map((p: any) => world(p));
    out_chains[1] = pts;
    for ([[a, b], kind] of pyIter(zip(zip(pts, pts.slice(1)), ['metacarpal', 'proximal', 'distal']))) {
      bones.push([a, b, kind]);
    }
    joints = pyAugAdd(joints, pyAdd(Array.from(pyIter(pts.slice(0, 3))).map((p: any) => [p, 'knuckle']), [[pts[3], 'tip']]));
    joints = pyAugAdd(joints, Array.from(pyIter([wr, wu])).map((p: any) => [p, 'wrist']));
    arm_end = [pyAdd((pyAdd(wr[0], wu[0]) / 2), pyMult(back[0], fl)), pyAdd((pyAdd(wr[1], wu[1]) / 2), pyMult(back[1], fl)), pyAdd((pyAdd(wr[2], wu[2]) / 2), pyMult(0.5, S))];
    wx = (pyAdd(wr[0], wu[0]) / 2);
    wy = (pyAdd(wr[1], wu[1]) / 2);
    hide = [2, 3, 4, 5];
    palm_up = (Math.cos(ro) < 0.0);
    extra = { ['nail_hide']: hide, ['palm_up']: palm_up, ['flush']: pyMult(g, u), ['thumb_edge']: pyMult(g, (1.0 - u)) };
    struct = { ['chains']: out_chains, ['wrist']: [wr, wu], ['arm_end']: arm_end, ['mirror']: this.mirror, ...extra };
    if (bool(this.mirror)) {
      fx = ((p) => [(pyMult(2, this.axis_x) - p[0]), p[1], p[2]]);
      bones = Array.from(pyIter(bones)).map(([a, b, k]: any) => [fx(a), fx(b), k]);
      joints = Array.from(pyIter(joints)).map(([p, k]: any) => [fx(p), k]);
      struct = { ['chains']: Object.fromEntries(Array.from(pyIter(pyItems(out_chains))).map(([f, c]: any) => [f, Array.from(pyIter(c)).map((p: any) => fx(p))])), ['wrist']: [fx(wr), fx(wu)], ['arm_end']: fx(arm_end), ['mirror']: true, ...extra };
    }
    return { ['bones']: bones, ['joints']: joints, ['front_y']: kb.rect.bottom, ['ppi']: this.ppi, ['wrist']: [wx, wy, psi], ['hand']: this.hand, ['color']: this.color, ['struct']: struct, ['skin']: this.skin, ['t']: t, ['song']: this.song };
  }
  _finger_pose(t: any = null, kb: any = null): any {
    let S: any, a: any, arm_end: any, b: any, back: any, bases: any, bones: any, bulge: any, chains: any, cmc: any, comp: any, cos_r: any, f: any, fl: any, fwd: any, fx: any, geo: any, gw: any, hb: any, held: any, joints: any, kind: any, lengths: any, lift: any, low: any, lxs: any, mcp: any, out: any, own: any, p: any, press: any, ps: any, psi: any, pts: any, pw: any, rigid: any, ring: any, roll: any, rot: any, sin_r: any, spare: any, struct: any, tip: any, tips: any, travel: any, up: any, wr: any, wu: any, wx: any, wy: any, xc: any, z: any, z0: any;
    // 
    //         Skeleton at time t as a dict:
    //             'bones':  [(p, q, kind)]  3D world points, kind in
    //                       {'forearm','carpal','metacarpal','proximal','middle','distal'}
    //             'joints': [(p, kind)]
    //             'front_y': screen y of the keyboard's front edge (for projection)
    //         
    this._ensure_layout(kb);
    [S, rot] = [this.S, this._rot];
    [wx, wy, psi] = this._limited_at(t);
    [lift, roll, gw] = this._gesture_at(t);
    [sin_r, cos_r, xc] = [Math.sin(roll), Math.cos(roll), pyMult(this.geo.mcp[3][0], S)];
    hb = [0.0];
    const droll = (lx: any = null): any => {
      return pyMult((-sin_r), (lx - xc));
    };
    const world = (p: any = null): any => {
      let lx: any, x: any, y: any;
      lx = pyMult(p[0], S);
      [x, y] = rot(pyAdd(xc, pyMult((lx - xc), cos_r)), pyMult(p[1], S), psi);
      return [pyAdd(wx, x), pyAdd(wy, y), pyAdd(pyMult(pyAdd(pyMult(p[2], S), this.z_off), low), pyMult(gw, pyAdd(hb[0], droll(lx))))];
    };
    [comp, low] = [this._run_w(t), this._low(t)];
    tips = Object.fromEntries(Array.from(pyIter(pyItems(this._limited_tips(t)))).map(([f, p]: any) => [f, this._limit_tip(f, p, wx, wy, psi, comp, this._key_weight(f, t)[0], low)]));
    tips = this._separate(tips, wx, wy, psi, t, comp);
    if ((gw > 0)) {
      travel = this.travel;
      lxs = Object.fromEntries(Array.from(pyIter(tips)).map((f: any) => [f, rot((tips[f][0] - wx), (tips[f][1] - wy), (-psi))[0]]));
      press = Object.fromEntries(Array.from(pyIter(tips)).map((f: any) => [f, this._press_amount(f, t)]));
      ps = (pyValues(press)).reduce((a: any, b: any) => a + b, 0);
      if ((ps > 1e-06)) {
        held = ((Array.from(pyIter(pyItems(press))).map(([f, w]: any) => pyMult(w, ((-travel) - droll(lxs[f]))))).reduce((a: any, b: any) => a + b, 0) / ps);
        pw = pyMin(1.0, ps);
        hb[0] = pyAdd(pyMult((1.0 - pw), lift), pyMult(pw, held));
      } else {
        hb[0] = lift;
      }
      for (f of pyIter(tips)) {
        if (bool(this._pressing(f, t))) {
          continue;
        }
        z0 = tips[f][2];
        own = ((z0 > 0) ? pyMult(this.gesture_act, z0) : 0.0);
        spare = (bool(this._near_note(f, t, GESTURE_REPEAT_T)) ? 0.0 : travel);
        rigid = pyAdd(pyAdd(pyAdd(hb[0], droll(lxs[f])), own), spare);
        z = pyAdd(pyMult(gw, rigid), pyMult((1.0 - gw), z0));
        tips[f] = [tips[f][0], tips[f][1], pyMax(pyMin(z0, 0.0), z)];
      }
    }
    [bones, joints] = [[], []];
    up = [0.0, 0.0, 1.0];
    geo = this.geo;
    [wr, wu] = [world(geo.wrist_sides[0]), world(geo.wrist_sides[1])];
    cmc = world(geo.thumb_cmc);
    bases = Object.fromEntries(Array.from(pyIter(pyRange(2, 6))).map((f: any) => [f, world(geo.mc_base[f])]));
    back = this._rot(0.0, (-1.0), pyMult((-0.45), Math.atan2((wx - this.shoulder_x), this.forearm_len)));
    fl = pyMult(12, this.ppi);
    for (p of pyIter([wr, wu])) {
      bones.push([p, [pyAdd(p[0], pyMult(back[0], fl)), pyAdd(p[1], pyMult(back[1], fl)), pyAdd(p[2], pyMult(0.5, S))], 'forearm']);
    }
    ring = [wr, cmc, bases[2], bases[3], bases[4], bases[5], wu];
    for ([a, b] of pyIter(zip(ring, ring.slice(1)))) {
      bones.push([a, b, 'carpal']);
    }
    bones.push([wr, wu, 'carpal']);
    chains = {  };
    fwd = rot(0.0, 1.0, psi);
    for (f = 2; f < 6; f += 1) {
      mcp = world(geo.mcp[f]);
      bones.push([bases[f], mcp, 'metacarpal']);
      lengths = Array.from(pyIter(geo.bones[f])).map((L: any) => pyMult(L, S));
      tip = tips[f];
      tip = [tip[0], tip[1], pyMin(tip[2], (mcp[2] - pyMult(TIP_BELOW_KNUCKLE, (lengths).reduce((a: any, b: any) => a + b, 0))))];
      pts = solve_chain(mcp, tip, lengths, up, FINGER_COUPLING, FINGER_BEND_MAX, FINGER_LIFT_MAX, fwd);
      chains[f] = pyAdd([bases[f]], [...pts]);
      for ([[a, b], kind] of pyIter(zip(zip(pts, pts.slice(1)), ['proximal', 'middle', 'distal']))) {
        bones.push([a, b, kind]);
      }
      joints = pyAugAdd(joints, pyAdd(Array.from(pyIter(pts.slice(0, 3))).map((p: any) => [p, 'knuckle']), [[pts[3], 'tip']]));
    }
    out = this._rot((-1.0), 0.0, psi);
    bulge = [pyMult(out[0], 0.85), pyMult(out[1], 0.85), 0.5];
    pts = solve_chain(cmc, tips[1], Array.from(pyIter(geo.bones[1])).map((L: any) => pyMult(L, S)), bulge, THUMB_COUPLING, THUMB_BEND_MAX);
    pts = this._thumb_bridge(t, pts);
    chains[1] = [...pts];
    for ([[a, b], kind] of pyIter(zip(zip(pts, pts.slice(1)), ['metacarpal', 'proximal', 'distal']))) {
      bones.push([a, b, kind]);
    }
    joints = pyAugAdd(joints, pyAdd(Array.from(pyIter(pts.slice(0, 3))).map((p: any) => [p, 'knuckle']), [[pts[3], 'tip']]));
    joints = pyAugAdd(joints, Array.from(pyIter([wr, wu])).map((p: any) => [p, 'wrist']));
    arm_end = [pyAdd((pyAdd(wr[0], wu[0]) / 2), pyMult(back[0], fl)), pyAdd((pyAdd(wr[1], wu[1]) / 2), pyMult(back[1], fl)), pyAdd((pyAdd(wr[2], wu[2]) / 2), pyMult(0.5, S))];
    struct = { ['chains']: chains, ['wrist']: [wr, wu], ['arm_end']: arm_end, ['mirror']: this.mirror };
    if (bool(this.mirror)) {
      fx = ((p) => [(pyMult(2, this.axis_x) - p[0]), p[1], p[2]]);
      bones = Array.from(pyIter(bones)).map(([a, b, k]: any) => [fx(a), fx(b), k]);
      joints = Array.from(pyIter(joints)).map(([p, k]: any) => [fx(p), k]);
      struct = { ['chains']: Object.fromEntries(Array.from(pyIter(pyItems(chains))).map(([f, c]: any) => [f, Array.from(pyIter(c)).map((p: any) => fx(p))])), ['wrist']: [fx(wr), fx(wu)], ['arm_end']: fx(arm_end), ['mirror']: true };
    }
    return { ['bones']: bones, ['joints']: joints, ['front_y']: kb.rect.bottom, ['ppi']: this.ppi, ['wrist']: [wx, wy, psi], ['hand']: this.hand, ['color']: this.color, ['struct']: struct, ['skin']: this.skin, ['t']: t, ['song']: this.song };
  }
}
export let STRETCH_SPLAY_DEG: any = { [1]: (-50.0), [2]: (-10.0), [3]: (-1.0), [4]: 7.0, [5]: 16.0 };
export let SPAN_SPLAY_DEG: any = { [1]: (-((_THUMB_MAX_ABD) * 180.0 / Math.PI)), [2]: (-22.0), [3]: 0.0, [4]: 8.0, [5]: ((_PINKY_MAX_ABD) * 180.0 / Math.PI) };
export let NATURAL_THUMB_REACH: any = 0.93;
export function _within(base: any = null, target: any = null, reach: any = null): any {
  let d: any;
  // target, pulled in toward base to at most reach away.
  d = Math.dist(base, target);
  if ((bool((d <= reach)) ? ((d <= reach)) : ((d < 1e-09)))) {
    return target;
  }
  return [...Array.from(pyIter(zip(base, target))).map(([b, t]: any) => pyAdd(b, (pyMult((t - b), reach) / d)))];
}
export let FINGER_BEND_RAD: any = [0.6, 0.8, 0.5];
export let THUMB_SWING_RAD: any = 0.8;
export let THUMB_TUCK_MIN: any = 0.2;
export let THUMB_TUCK_SHY: any = 0.26;
export let THUMB_FLEX_RAD: any = [0.0, 0.25, 0.3];
export let THUMB_CURL_RAD: any = [0.5, 0.55, 0.6];
export let THUMB_SPREAD_RAD: any = 0.15;
export let BEND_RANGE: any = { ['finger']: [(-0.5), 1.0], ['thumb']: [(-0.6), 1.0] };
export function clamp_bend(finger: any = null, b: any = null): any {
  let hi: any, lo: any;
  [lo, hi] = BEND_RANGE[((pyEq(finger, 1)) ? 'thumb' : 'finger')];
  return pyMax(lo, pyMin(hi, b));
}
export function _flex(pts: any = null, angles: any = null): any {
  let a2: any, along: any, c: any, d: any, dx: any, dy: any, i: any, j: any, n: any, px: any, py: any, pz: any, rx: any, ry: any, rz: any, s: any, side: any, th: any, z2: any;
  // pts (a finger chain) bent down at each joint by angles[i] radians (negative: up), each
  //     joint turning everything beyond it about the horizontal axis across the finger.
  pts = Array.from(pyIter(pts)).map((p: any) => [...p]);
  [dx, dy] = [(pts[pts.length - 1][0] - pts[0][0]), (pts[pts.length - 1][1] - pts[0][1])];
  n = Math.hypot(dx, dy);
  if ((n < 1e-09)) {
    return pts;
  }
  d = [(dx / n), (dy / n)];
  for ([i, th] of pyIter(enumerate(angles))) {
    if ((bool((!bool(th))) ? ((!bool(th))) : ((i >= ((pts).length - 1))))) {
      continue;
    }
    [c, s] = [Math.cos(th), Math.sin(th)];
    [px, py, pz] = pts[i];
    for (j = pyAdd(i, 1); j < (pts).length; j += 1) {
      [rx, ry, rz] = [(pts[j][0] - px), (pts[j][1] - py), (pts[j][2] - pz)];
      along = pyAdd(pyMult(rx, d[0]), pyMult(ry, d[1]));
      side = [(rx - pyMult(along, d[0])), (ry - pyMult(along, d[1]))];
      [a2, z2] = [pyAdd(pyMult(along, c), pyMult(rz, s)), pyAdd(pyMult((-along), s), pyMult(rz, c))];
      pts[j] = [pyAdd(pyAdd(px, side[0]), pyMult(a2, d[0])), pyAdd(pyAdd(py, side[1]), pyMult(a2, d[1])), pyAdd(pz, z2)];
    }
  }
  return pts;
}
export function _swing(pts: any = null, ang: any = null, at: any = null): any {
  let _: any, c: any, out: any, px: any, py: any, rx: any, ry: any, s: any, x: any, y: any, z: any;
  // pts beyond pts[at] turned about the vertical axis through it, by ang radians toward +x.
  [c, s] = [Math.cos(ang), Math.sin(ang)];
  [px, py, _] = pts[at];
  out = [...pts.slice(0, pyAdd(at, 1))];
  for ([x, y, z] of pyIter(pts.slice(pyAdd(at, 1)))) {
    [rx, ry] = [(x - px), (y - py)];
    out.push([pyAdd(pyAdd(px, pyMult(rx, c)), pyMult(ry, s)), pyAdd((py - pyMult(rx, s)), pyMult(ry, c)), z]);
  }
  return out;
}
export function bend_chain(finger: any = null, pts: any = null, b: any = null, toward: any = null): any {
  let a: any, j: any, now: any, room: any;
  // A finger's chain (MCP..tip; the thumb's CMC..tip) curved in by b (clamp_bend's range):
  //     fingers curl down (negative: lift), the thumb swings into the palm and flexes (negative: out).
  //     toward: the index knuckle, which the fully tucked thumb points just short of (any further
  //     and the palm, seen from above, hides it).
  b = clamp_bend(finger, b);
  if (bool((!bool(b)))) {
    return [...pts];
  }
  if ((pyEq(finger, 1))) {
    if ((b < 0)) {
      pts = _swing(pts, pyMult(b, THUMB_SWING_RAD));
      for (j of pyIter([1, 2])) {
        pts = _swing(pts, pyMult(b, THUMB_SPREAD_RAD), j);
      }
      return pts;
    }
    now = Math.atan2((pts[pts.length - 1][0] - pts[0][0]), (pts[pts.length - 1][1] - pts[0][1]));
    room = THUMB_TUCK_MIN;
    if ((toward !== null)) {
      room = pyMax(room, ((Math.atan2((toward[0] - pts[0][0]), (toward[1] - pts[0][1])) - THUMB_TUCK_SHY) - now));
    }
    pts = _swing(pts, pyMult(pyMult(b, room), THUMB_CURL_RAD[0]));
    for ([j, a] of pyIter([[1, THUMB_CURL_RAD[1]], [2, THUMB_CURL_RAD[2]]])) {
      pts = _swing(pts, pyMult(b, a), j);
    }
    return _flex(pts, Array.from(pyIter(THUMB_FLEX_RAD)).map((a: any) => pyMult(b, a)));
  }
  if ((b < 0)) {
    return _flex(pts, [pyMult(pyMult(b, FINGER_BEND_RAD[0]), 1.3), pyMult(b, 0.2), 0.0]);
  }
  return _flex(pts, Array.from(pyIter(FINGER_BEND_RAD)).map((a: any) => pyMult(b, a)));
}
export function static_skeleton(geo: any = null, shape: any = null, curl: any = null, bends: any = null): any {
  let a: any, arm_end: any, b: any, base: any, bid: any, bones: any, bulge: any, chains: any, cmc: any, f: any, front: any, joints: any, kind: any, mcp: any, pts: any, rest: any, ring: any, splay: any, struct: any, tips: any, u: any, wr: any, wu: any;
  // 
  //     A still right hand, in model units (wrist centre at the origin, +x toward
  //     the little finger, +y toward the fingertips, +z up; z = 0 is the key
  //     surface): {'bones': [(p, q, kind, bone_id)], 'joints': [(p, kind)],
  //     'tips': {finger: p}}. bone_id is a pianist.BONES id (None for the carpals
  //     and forearm).
  // 
  //     shape: 'stretched' - every finger straight and flat, fanned out;
  //            'natural'   - the relaxed curve the animation rests in;
  //            'span'      - thumb and little finger stretched as far as is
  //                          comfortable (how the hand span is measured).
  //     bends: {finger: b} curls a finger further in from that shape (bend_chain).
  //     
  [bones, joints, tips, chains] = [[], [], {  }, {  }];
  bends = (bool(bends) ? (bends) : ({  }));
  const straight = (base: any = null, ang_deg: any = null, lengths: any = null, z_drop: any = null): any => {
    let L: any, a: any, d: any, p: any, pts: any, total: any;
    a = ((ang_deg) * Math.PI / 180.0);
    d = [Math.sin(a), Math.cos(a)];
    [pts, p] = [[base], base];
    total = (lengths).reduce((a: any, b: any) => a + b, 0);
    for (L of pyIter(lengths)) {
      p = [pyAdd(p[0], pyMult(d[0], L)), pyAdd(p[1], pyMult(d[1], L)), (p[2] - (pyMult(z_drop, L) / total))];
      pts.push(p);
    }
    return pts;
  };
  if ((pyEq(shape, 'natural'))) {
    u = (1.0 / INCHES_PER_UNIT);
    front = (pyAdd(geo.mcp[3][1], pyMult(geo.rest_reach, curl)) - pyMult(WHITE_DEPTH_IN[3], u));
    rest = Object.fromEntries(Array.from(pyIter(pyRange(1, 6))).map((f: any) => [f, [pyAdd(geo.mcp[3][0], pyMult(pyMult((f - 3), WHITE_KEY_IN), u)), pyAdd(front, pyMult(WHITE_DEPTH_IN[f], u)), HOVER[f]]]));
  }
  splay = ((pyEq(shape, 'span')) ? SPAN_SPLAY_DEG : STRETCH_SPLAY_DEG);
  [wr, wu] = geo.wrist_sides;
  cmc = geo.thumb_cmc;
  base = geo.mc_base;
  bones.push([wr, [(wr[0] - 0.4), (wr[1] - 6.0), pyAdd(wr[2], 0.4)], 'forearm', null]);
  bones.push([wu, [pyAdd(wu[0], 0.4), (wu[1] - 6.0), pyAdd(wu[2], 0.4)], 'forearm', null]);
  ring = [wr, cmc, base[2], base[3], base[4], base[5], wu];
  for ([a, b] of pyIter(zip(ring, ring.slice(1)))) {
    bones.push([a, b, 'carpal', null]);
  }
  bones.push([wr, wu, 'carpal', null]);
  for (f = 2; f < 6; f += 1) {
    mcp = geo.mcp[f];
    bones.push([base[f], mcp, 'metacarpal', `mc${f}`]);
    if ((pyEq(shape, 'natural'))) {
      pts = solve_chain(mcp, _within(mcp, rest[f], pyMult(REACH_COMFORT[f], (geo.bones[f]).reduce((a: any, b: any) => a + b, 0))), [...geo.bones[f]], [0.0, 0.0, 1.0], FINGER_COUPLING, FINGER_BEND_MAX);
    } else {
      pts = straight(mcp, splay[f], geo.bones[f], (mcp[2] - 0.3));
    }
    if (bool(pyGet(bends, f, null))) {
      pts = bend_chain(f, pts, bends[f], null);
    }
    for ([[a, b], kind, bid] of pyIter(zip(zip(pts, pts.slice(1)), ['proximal', 'middle', 'distal'], [`pp${f}`, `mp${f}`, `dp${f}`]))) {
      bones.push([a, b, kind, bid]);
    }
    joints = pyAugAdd(joints, pyAdd(pyAdd([[base[f], 'knuckle']], Array.from(pyIter(pts.slice(0, 3))).map((p: any) => [p, 'knuckle'])), [[pts[3], 'tip']]));
    tips[f] = pts[3];
    chains[f] = pyAdd([base[f]], [...pts]);
  }
  if ((pyEq(shape, 'natural'))) {
    bulge = [(-0.85), 0.0, 0.5];
    pts = solve_chain(cmc, _within(cmc, rest[1], pyMult(NATURAL_THUMB_REACH, (geo.bones[1]).reduce((a: any, b: any) => a + b, 0))), [...geo.bones[1]], bulge, THUMB_COUPLING, THUMB_BEND_MAX);
  } else {
    pts = straight(cmc, splay[1], geo.bones[1], (cmc[2] - 0.3));
  }
  if (bool(pyGet(bends, 1, null))) {
    pts = bend_chain(1, pts, bends[1], geo.mcp[2]);
  }
  for ([[a, b], kind, bid] of pyIter(zip(zip(pts, pts.slice(1)), ['metacarpal', 'proximal', 'distal'], ['mc1', 'pp1', 'dp1']))) {
    bones.push([a, b, kind, bid]);
  }
  joints = pyAugAdd(joints, pyAdd(Array.from(pyIter(pts.slice(0, 3))).map((p: any) => [p, 'knuckle']), [[pts[3], 'tip']]));
  joints = pyAugAdd(joints, [[wr, 'wrist'], [wu, 'wrist']]);
  tips[1] = pts[3];
  chains[1] = [...pts];
  arm_end = [(pyAdd(wr[0], wu[0]) / 2), ((pyAdd(wr[1], wu[1]) / 2) - 7.0), pyAdd((pyAdd(wr[2], wu[2]) / 2), 0.4)];
  struct = { ['chains']: chains, ['wrist']: [wr, wu], ['arm_end']: arm_end, ['mirror']: false };
  return { ['bones']: bones, ['joints']: joints, ['tips']: tips, ['struct']: struct };
}
export let BONE_COLOR: any = [12, 12, 14];
export let HALO_COLOR: any = [205, 205, 212];
export let BONE_WIDTH_IN: any = { ['forearm']: 0.16, ['carpal']: 0.1, ['metacarpal']: 0.14, ['proximal']: 0.15, ['middle']: 0.13, ['distal']: 0.11 };
export let JOINT_RADIUS_IN: any = { ['knuckle']: 0.085, ['tip']: 0.075, ['wrist']: 0.09 };
export function halo_for(color: any = null): any {
  let lum: any;
  // A thin outline that contrasts with the bone colour (light for dark bones, dark for light).
  lum = pyAdd(pyAdd(pyMult(0.299, color[0]), pyMult(0.587, color[1])), pyMult(0.114, color[2]));
  return ((lum < 140) ? HALO_COLOR : [22, 22, 26]);
}
export function depth_scale(z: any = null, ppi: any = null): any {
  // Higher bones are drawn a little thicker, so the knuckle arch reads from above.
  return pyMin(1.6, pyMax(0.8, pyAdd(1.0, (pyMult(0.25, z) / ppi))));
}
export function bone_width(kind: any = null, z: any = null, ppi: any = null): any {
  return pyMax(2, Math.trunc(Math.round(pyMult(pyMult(BONE_WIDTH_IN[kind], ppi), depth_scale(z, ppi)))));
}
export function joint_radius(kind: any = null, z: any = null, ppi: any = null): any {
  return pyMax(2, Math.trunc(Math.round(pyMult(pyMult(JOINT_RADIUS_IN[kind], ppi), depth_scale(z, ppi)))));
}
export let CROSS_GROUP: any = 0.035;
export let CROSS_MERGE: any = 0.35;
export let CROSS_HOME: any = 4.0;
export let CROSS_RAMP: any = 0.4;
export let CROSS_LIFT_IN: any = 0.8;
export let CROSS_STALE: any = 1.5;
export let INTERLOCK_BLACK: any = 0.3;
export let INTERLOCK_WINDOW: any = 0.3;
export let INTERLOCK_SPAN: any = 14;
export let INTERLOCK_BLIP: any = 0.3;
export let INTERLOCK_NEAR: any = 1.0;
export function crossing_episodes(song: any = null): any {
  let L: any, R: any, _: any, by_hand: any, cached: any, cl: any, clustered: any, clusters: any, crossed: any, d: any, deep: any, deeper: any, depth: any, devL: any, devR: any, episodes: any, f: any, full: any, groups: any, gs: any, h: any, held: any, i: any, lead: any, main_top: any, moments: any, n: any, newL: any, newR: any, note_ts: any, ns: any, p0: any, pl: any, ps: any, r: any, runs: any, span_starts: any, spans: any, starts: any, state: any, strength: any, t: any, t0: any, t1: any, t_on: any, top: any, tt: any;
  // 
  //     [(t0, t1, top_hand, lift 0..1)] for the stretches where the hands cross
  //     or interlock. The hand that crosses always goes OVER, so the question is
  //     which hand crossed, and that is decided by who moved into whose ground:
  // 
  //     - the left hand playing above where the right hand is (the left hand's
  //       new notes above the right hand's current ones) - the left hand crossed
  //       going up, and it's on top;
  //     - the right hand playing below where the left hand is - the right hand
  //       crossed going down, and it's on top.
  // 
  //     A hand that is idle doesn't count: it moves out of the playing hand's way
  //     instead (HandAnimator._placed_at), so a leap by the other hand is no crossing.
  //     A crossing lasts until the hands are back on their own sides; the other
  //     hand playing on underneath meanwhile doesn't change who is on top. When
  //     both hands move into the crossing at the same moment, the one further
  //     from its usual place (its mean position in the seconds around) crossed.
  // 
  //     Hands interlocked rather than crossed - both playing, their ranges
  //     overlapping - lie one over the other by depth instead: the hand playing
  //     further in (more of its notes on black keys, INTERLOCK_BLACK) has its
  //     palm and fingers over the other's fingertips at the keys' front, so it's
  //     on top whoever moved in (a thumb on a white key's front edge, drawn over
  //     the fingers reaching past it to the black keys, went through them).
  //     
  cached = getattr(song, '_crossings', null);
  if ((cached !== null)) {
    return cached;
  }

  episodes = [];
  [groups, spans] = [{  }, {  }];
  for (h of pyIter([RIGHT, LEFT])) {
    ns = pySorted(Array.from(pyIter(song.notes)).filter((n: any) => (pyEq(n.hand, h))).map((n: any) => n), ((n) => n.start), false);
    gs = [];
    for (n of pyIter(ns)) {
      if ((bool(gs) && (((n.start - gs[gs.length - 1][0]) < CROSS_GROUP)))) {
        gs[gs.length - 1][1].push(n.pitch);
      } else {
        gs.push([n.start, [n.pitch]]);
      }
    }
    groups[h] = Array.from(pyIter(gs)).map(([t, ps]: any) => [t, pyMin(ps), pyMax(ps)]);
    spans[h] = busy_spans(Array.from(pyIter(ns)).map((n: any) => [n.start, n.end]));
  }
  if ((bool(groups[RIGHT]) && bool(groups[LEFT]))) {
    starts = Object.fromEntries(Array.from(pyIter(groups)).map((h: any) => [h, Array.from(pyIter(groups[h])).map((g: any) => g[0])]));
    span_starts = Object.fromEntries(Array.from(pyIter(spans)).map((h: any) => [h, Array.from(pyIter(spans[h])).map(([a, _0]: any) => a)]));
    const current = (h: any = null, t: any = null): any => {
      let gs: any, i: any;
      // 
      //             (low, high) of the hand's latest chord at t (its next one if it has
      //             been silent), or None while it is idle: then it has moved out of
      //             the playing hand's way (HandAnimator._placed_at), so it can't be crossed.
      //             
      if ((idle_weight(spans[h], span_starts[h], t) > 0.5)) {
        return null;
      }
      [gs, i] = [groups[h], (bisectRight(starts[h], pyAdd(t, 1e-06)) - 1)];
      if ((((i >= 0)) && ((bool(((t - gs[i][0]) < CROSS_STALE)) ? (((t - gs[i][0]) < CROSS_STALE)) : ((pyAdd(i, 1) >= (gs).length)))))) {
        return [gs[i][1], gs[i][2]];
      }
      return [gs[pyAdd(i, 1)][1], ((pyAdd(i, 1) < (gs).length) ? gs[pyAdd(i, 1)][2] : null)];
    };
    const home = (h: any = null, t: any = null): any => {
      let gs: any, hi: any, lo: any, sel: any;
      [gs, lo] = [groups[h], bisectLeft(starts[h], (t - CROSS_HOME))];
      hi = bisectRight(starts[h], pyAdd(t, CROSS_HOME));
      sel = (bool(gs.slice(lo, hi)) ? (gs.slice(lo, hi)) : (gs));
      return ((Array.from(pyIter(sel)).map((g: any) => (pyAdd(g[1], g[2]) / 2))).reduce((a: any, b: any) => a + b, 0) / (sel).length);
    };
    moments = pySorted(new Set(Array.from(pyIter(groups)).flatMap((h: any) => Array.from(pyIter(groups[h])).map((g: any) => g[0]))), null, false);
    clustered = [];
    for (t of pyIter(moments)) {
      if ((bool(clustered) && (((t - clustered[clustered.length - 1]) < CROSS_GROUP)))) {
        continue;
      }
      clustered.push(t);
    }
    [state, t_on, depth, full] = [null, 0.0, 0.0, false];
    runs = [];
    for (t of pyIter(clustered)) {
      tt = pyAdd(t, pyMult(CROSS_GROUP, 0.99));
      [L, R] = [current(LEFT, tt), current(RIGHT, tt)];
      crossed = (((L !== null)) && ((R !== null)) && ((L[1] > R[0])));
      if (bool((!bool(crossed)))) {
        if ((state !== null)) {
          runs.push([t_on, t, state, depth, full]);
          state = null;
        }
        continue;
      }
      if ((state === null)) {
        newL = Array.from(Array.from(pyIter(groups[LEFT].slice(pyMax(0, bisectLeft(starts[LEFT], (t - CROSS_GROUP)))).slice(0, 2))).map((g: any) => (Math.abs((g[0] - t)) < CROSS_GROUP))).some(Boolean);
        newR = Array.from(Array.from(pyIter(groups[RIGHT].slice(pyMax(0, bisectLeft(starts[RIGHT], (t - CROSS_GROUP)))).slice(0, 2))).map((g: any) => (Math.abs((g[0] - t)) < CROSS_GROUP))).some(Boolean);
        if ((bool(newL) && ((!bool(newR))))) {
          state = LEFT;
        } else {
          if ((bool(newR) && ((!bool(newL))))) {
            state = RIGHT;
          } else {
            devL = ((pyAdd(L[0], L[1]) / 2) - home(LEFT, t));
            devR = (home(RIGHT, t) - (pyAdd(R[0], R[1]) / 2));
            state = ((devL > devR) ? LEFT : RIGHT);
          }
        }
        [t_on, depth, full] = [t, 0.0, false];
      }
      depth = pyMax(depth, (L[1] - R[0]));
      full = (bool(full) ? (full) : (((pyAdd(L[0], L[1]) / 2) > (pyAdd(R[0], R[1]) / 2))));
    }
    if ((state !== null)) {
      runs.push([t_on, pyAdd(clustered[clustered.length - 1], 0.3), state, depth, full]);
    }
    by_hand = Object.fromEntries(Array.from(pyIter([RIGHT, LEFT])).map((h: any) => [h, pySorted(Array.from(pyIter(song.notes)).filter((n: any) => (pyEq(n.hand, h))).map((n: any) => [n.start, n.pitch]), null, false)]));
    note_ts = Object.fromEntries(Array.from(pyIter(by_hand)).map((h: any) => [h, Array.from(pyIter(by_hand[h])).map(([s, _0]: any) => s)]));
    const interlocked_top = (t0: any = null, t1: any = null): any => {
      let got: any, h: any, hi: any, inside: any, lb: any, lh: any, ll: any, lo: any, ps: any, rb: any, rh: any, rl: any;
      // The hand further in when the hands interlock around t0..t1 (see above), else None.
      got = {  };
      for (h of pyIter([RIGHT, LEFT])) {
        lo = bisectLeft(note_ts[h], (t0 - INTERLOCK_WINDOW));
        hi = bisectRight(note_ts[h], pyAdd(t1, INTERLOCK_WINDOW));
        ps = Array.from(pyIter(by_hand[h].slice(lo, hi))).map(([_0, p]: any) => p);
        if ((bool((!bool(ps))) ? ((!bool(ps))) : (((pyMax(ps) - pyMin(ps)) > INTERLOCK_SPAN)))) {
          return null;
        }
        inside = new Set(Array.from(pyIter(by_hand[h].slice(bisectLeft(note_ts[h], (t0 - CROSS_GROUP)), bisectRight(note_ts[h], t1)))).map(([s, _0]: any) => s));
        if (((new Set(Array.from(pyIter(inside)).map((s: any) => Math.round((s / CROSS_GROUP))))).length < 2)) {
          return null;
        }
        got[h] = [pyMin(ps), pyMax(ps), ((Array.from(pyIter(ps)).map((p: any) => is_black_key(p))).reduce((a: any, b: any) => a + b, 0) / (ps).length)];
      }
      [[rl, rh, rb], [ll, lh, lb]] = [got[RIGHT], got[LEFT]];
      if ((bool((ll > rh)) ? ((ll > rh)) : ((lh < rl)))) {
        return null;
      }
      if ((Math.abs((lb - rb)) < INTERLOCK_BLACK)) {
        return null;
      }
      return ((rb > lb) ? RIGHT : LEFT);
    };
    clusters = [];
    for (r of pyIter(runs)) {
      if ((bool(clusters) && (((r[0] - clusters[clusters.length - 1][clusters[clusters.length - 1].length - 1][1]) < INTERLOCK_NEAR)))) {
        clusters[clusters.length - 1].push(r);
      } else {
        clusters.push([r]);
      }
    }
    runs = [];
    for (cl of pyIter(clusters)) {
      deep = interlocked_top(cl[0][0], cl[cl.length - 1][1]);
      held = {  };
      for ([t0, t1, top, _, _] of pyIter(cl)) {
        held[top] = pyAdd(pyGet(held, top, 0.0), (t1 - t0));
      }
      main_top = pyMax(held, held.get);
      runs = pyAugAdd(runs, Array.from(pyIter(cl)).map(([t0, t1, top, d, f]: any) => [t0, t1, (((((t1 - t0) < INTERLOCK_BLIP)) && (((held).length > 1))) ? main_top : top), d, f, deep]));
    }
    for ([t0, t1, top, d, f, deeper] of pyIter(runs)) {
      if ((deeper !== null)) {
        [top, f] = [deeper, true];
      }
      strength = (bool(f) ? 1.0 : pyMax(0.3, pyMin(1.0, (d / 6.0))));
      i = (bisectLeft(starts[top], (t0 - CROSS_GROUP)) - 1);
      lead = ((i >= 0) ? (t0 - starts[top][i]) : CROSS_RAMP);
      lead = pyMax(0.25, pyMin(0.6, lead));
      if ((bool(episodes) && ((pyEq(episodes[episodes.length - 1][2], top))) && (((t0 - episodes[episodes.length - 1][1]) < CROSS_MERGE)))) {
        [p0, _, _, ps, pl] = episodes[episodes.length - 1];
        episodes[episodes.length - 1] = [p0, t1, top, pyMax(ps, strength), pl];
      } else {
        episodes.push([t0, t1, top, strength, lead]);
      }
    }
  }
  try {
    song._crossings = episodes;
  } catch (_err: any) {
    ;
  }
  return episodes;
}
export function _crossing_lifts(episodes: any = null, t: any = null): any {
  let a: any, lead: any, out: any, strength: any, t0: any, t1: any, top: any;
  // {hand: 0..1 how far it is raised} at time t.
  out = {  };
  for ([t0, t1, top, strength, lead] of pyIter(episodes)) {
    if ((((t0 - lead) <= t) && (t <= pyAdd(t1, CROSS_RAMP)))) {
      if ((t < t0)) {
        a = ((t - (t0 - lead)) / pyMult(0.8, lead));
      } else {
        if ((t > t1)) {
          a = (1.0 - ((t - t1) / CROSS_RAMP));
        } else {
          a = 1.0;
        }
      }
      a = pyMax(0.0, pyMin(1.0, a));
      a = pyMult(pyMult(a, a), (3 - pyMult(2, a)));
      out[top] = pyMax(pyGet(out, top, 0.0), pyMult(a, strength));
    } else {
      if (((t0 - 0.6) > t)) {
        break;
      }
    }
  }
  return out;
}
export function _lift_pose(pose: any = null, dz: any = null): any {
  let out: any, span: any, st: any, wr: any, wu: any, y_tip: any, y_wr: any;
  // A copy of pose with the wrist, palm and forearm raised by dz pixels, fading to 0 at the fingertips.
  st = pose['struct'];
  y_tip = pyMax(Array.from(pyIter(pyValues(st['chains']))).map((c: any) => c[c.length - 1][1]));
  [wr, wu] = st['wrist'];
  y_wr = (pyAdd(wr[1], wu[1]) / 2);
  span = pyMax(1e-06, (y_tip - y_wr));
  const up = (p: any = null): any => {
    let w: any;
    w = Math.pow(pyMax(0.0, pyMin(1.0, ((y_tip - p[1]) / span))), 0.8);
    return [p[0], p[1], pyAdd(p[2], pyMult(dz, w))];
  };
  out = { ...pose };
  out['struct'] = { ...st, chains: Object.fromEntries(Array.from(pyIter(pyItems(st['chains']))).map(([f, c]: any) => [f, Array.from(pyIter(c)).map((p: any) => up(p))])), wrist: [up(wr), up(wu)], arm_end: up(st['arm_end']) };
  out['bones'] = Array.from(pyIter(pose['bones'])).map(([a, b, k]: any) => [up(a), up(b), k]);
  out['joints'] = Array.from(pyIter(pose['joints'])).map(([p, k]: any) => [up(p), k]);
  return out;
}
export let CONTACT_GRID: any = 0.05;
export let CONTACT_SCAN: any = 6.0;
export let CONTACT_BRIDGE: any = 0.3;
export let CONTACT_PAD_WK: any = [2.5, 1.0];
export let CONTACT_AHEAD_T: any = 1.2;
export let CONTACT_NEXT_T: any = 0.3;
export function contact_overlap(right: any = null, left: any = null, k: any = null): any {
  let cache: any, fl: any, fr: any, t: any, v: any;
  // How far (pixels) the hands' footprints overlap at grid step k (<= 0: apart), cached on `right`.
  cache = pySetDefault(right.__dict__, '_contact_cache', {  });
  v = pyGet(cache, k, null);
  if ((v === null)) {
    if (((cache).length > 20000)) {
      pyClear(cache);
    }
    t = pyMult(k, CONTACT_GRID);
    [fr, fl] = [right.footprint(t), left.footprint(t)];
    v = ((bool((fr === null)) ? ((fr === null)) : ((fl === null))) ? (-1.0) : (pyMin(fr[1], fl[1]) - pyMax(fr[0], fl[0])));
    cache[k] = v;
  }
  return v;
}
export function _layer_top(right: any = null, left: any = null, episodes: any = null, t: any = null): any {
  let a: any, ab: any, b: any, cut: any, eps: any, g: any, hi: any, j: any, k: any, lo: any, n: any, nxt: any, prev: any, spans: any, ta: any, tb: any, top: any;
  // 
  //     The hand drawn on top while the hands are in contact (their footprints
  //     overlapping): settled for the whole stretch of contact, looking ahead, so
  //     the layers never swap while the hands overlap (a hand rising on top of
  //     the other through it, in one frame). The stretch's first crossing
  //     episode decides it - from the moment the hands touch, not from when that
  //     episode begins; with several episodes with other hands on top, the swap
  //     comes where the hands overlap least between them. None: not in contact,
  //     or no episode in the stretch.
  //     
  g = Math.trunc(Math.round((CONTACT_BRIDGE / CONTACT_GRID)));
  const touching = (j: any = null): any => {
    // In contact at step j, or within CONTACT_BRIDGE of it (gaps bridged, contact seen a little early).
    return Array.from(Array.from(pyIter(pyRange((j - g), pyAdd(pyAdd(j, g), 1)))).map((i: any) => (contact_overlap(right, left, i) > 0))).some(Boolean);
  };
  k = Math.round((t / CONTACT_GRID));
  if (bool((!bool(touching(k))))) {
    return null;
  }
  spans = pySetDefault(right.__dict__, '_contact_spans', {  });
  ab = pyGet(spans, k, null);
  if ((ab === null)) {
    n = Math.trunc((CONTACT_SCAN / CONTACT_GRID));
    a = k;
    while ((((a > (k - n))) && bool(touching((a - 1))))) {
      a -= 1;
    }
    b = k;
    while ((((b < pyAdd(k, n))) && bool(touching(pyAdd(b, 1))))) {
      b = pyAugAdd(b, 1);
    }
    if (((spans).length > 20000)) {
      pyClear(spans);
    }
    for (j = a; j < pyAdd(b, 1); j += 1) {
      spans[j] = [a, b];
    }
    ab = [a, b];
  }
  [a, b] = ab;
  [ta, tb] = [pyMult(a, CONTACT_GRID), pyMult(b, CONTACT_GRID)];
  eps = Array.from(pyIter(episodes)).filter((e: any) => (((pyAdd(e[1], CROSS_RAMP) >= ta)) && (((e[0] - e[4]) <= tb)))).map((e: any) => e);
  if (bool((!bool(eps)))) {
    return null;
  }
  top = eps[0][2];
  for ([prev, nxt] of pyIter(zip(eps, eps.slice(1)))) {
    if ((pyEq(nxt[2], prev[2]))) {
      continue;
    }
    [lo, hi] = [Math.round((prev[1] / CONTACT_GRID)), pyMax(Math.round((prev[1] / CONTACT_GRID)), Math.round((nxt[0] / CONTACT_GRID)))];
    cut = pyMin(pyRange(pyMax(lo, a), pyAdd(pyMin(hi, b), 1)), ((j) => contact_overlap(right, left, j)), hi);
    if ((k < cut)) {
      break;
    }
    top = nxt[2];
  }
  return top;
}
export function arrange_crossing(poses: any = null): any {
  let episodes: any, h: any, hands_: any, l: any, lifts: any, out: any, p: any, r: any, t: any, top: any;
  // 
  //     Order (and lift) two hands that cross: the crossing hand is drawn on top
  //     and its wrist raised above the other; while the hands are in contact the
  //     one on top is settled ahead (_layer_top), and only it is raised. Other
  //     poses pass through unchanged.
  //     
  hands_ = Object.fromEntries(Array.from(pyIter(poses)).map((p: any) => [pyGet(p, 'hand', null), p]));
  if ((bool((pyNotEq((poses).length, 2))) ? ((pyNotEq((poses).length, 2))) : ((bool((pyNotEq((hands_).length, 2))) ? ((pyNotEq((hands_).length, 2))) : ((bool(((!pyIn('song', poses[0])))) ? (((!pyIn('song', poses[0])))) : ((poses[0]['song'] === null)))))))) {
    return poses;
  }
  t = pyGet(poses[0], 't', 0.0);
  episodes = crossing_episodes(poses[0]['song']);
  lifts = _crossing_lifts(episodes, t);
  lifts = Object.fromEntries(Array.from(pyIter(pyItems(lifts))).filter(([h, a]: any) => (((pyIn(h, hands_))) && ((a > 0.0)))).map(([h, a]: any) => [h, a]));
  top = null;
  [r, l] = [pyGet(pyGet(hands_, RIGHT, {  }), 'anim', null), pyGet(pyGet(hands_, LEFT, {  }), 'anim', null)];
  if ((((r !== null)) && ((l !== null)))) {
    top = _layer_top(r, l, episodes, t);
  }
  if ((top === null)) {
    if (bool((!bool(lifts)))) {
      return poses;
    }
    top = pyMax(lifts, lifts.get);
  }
  out = [];
  for ([h, p] of pyIter(pyItems(hands_))) {
    if ((((pyEq(h, top))) && bool(pyGet(lifts, h, null)))) {
      p = _lift_pose(p, pyMult(pyMult(CROSS_LIFT_IN, p['ppi']), lifts[h]));
    }
    out.push({ ...p, layer: ((pyEq(h, top)) ? 1 : 0) });
  }
  return pySorted(out, ((p) => p['layer']), false);
}