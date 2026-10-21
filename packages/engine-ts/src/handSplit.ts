/**
 * handSplit.ts - Decide which hand plays each note when the MIDI file doesn't say.
 *
 * Ported 1-to-1 from python-core/handthesia_core/hand_split.py.
 */

import { bisectLeft } from "./pythonCompat.ts";
import * as progress from "./progress.ts";
import { find_trills, type NoteLike, objId } from "./figures.ts";
import { key_pos, travel_time, MOVE_SHARE } from "./fingering.ts";
import type { Pianist } from "./pianist.ts";
import { handSpanInches } from "./pianist.ts";

export const LEFT = "L";
export const RIGHT = "R";

export const CHORD_TOL = 0.035; // onsets closer than this count as one group
export const BEAM = 32; // candidates kept per group

// span within one hand (semitones): free up to an octave, costly to a 10th
export let SPAN_FREE = 12;
export let SPAN_MAX = 16;
export let SPAN_HELD_MAX = 19; // with keys still held
export const SPAN_OVER = 12.0; // a chord wider than SPAN_MAX has to be rolled

export const HAND_WK = 7.0;
export const TOO_FAST = 60.0;
export const MOVE_COST = 0.06; // per semitone of any shift
export const SPEED_COST = 0.25; // per 40 semitones/second of travel the note demands
export const CHORD_COST = 0.5; // per extra note in a chord, when chords come quickly
export const REPEAT_SHAPE = 0.3; // share of it for keys the hand's last chord was on
export const HELD_TOL = 0.03;
export const TRACK_T = 1.5;
export const TRACK_SWITCH = 12.0;
export const CROWD_GAP = 5;
export const CROWD = 1.5;
export const REPEAT_T = 0.5;
export const REPEAT_SPLIT = 4.0;
export const TRACK_PRIOR = 200.0;
export const TRACK_PRIOR_SOFT = 1.0;
export const TRACK_FREE_T = 0.5;
export const TOO_FAST_TRACK = 0.5;
export const WIDE_T = 0.15;
export const WIDE_STREAK = 4;
export const INSIDE = 40.0;
export const INSIDE_T = 0.04;

export let MAX_SPEED = 3.0; // m/s, from the pianist (split_hands)

export function _groups<T extends NoteLike>(notes: readonly T[]): [number, T[]][] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const out: [number, T[]][] = [];
  for (const n of sorted) {
    if (out.length > 0 && n.start - out[out.length - 1]![0] <= CHORD_TOL) {
      out[out.length - 1]![1].push(n);
    } else {
      out.push([n.start, [n]]);
    }
  }
  return out.map(([t, ns]) => [t, ns.sort((a, b) => a.pitch - b.pitch)]);
}

export type HeldEntry = readonly [number, number, number]; // [end, pitch, start]

export class _Hand {
  readonly center: number;
  readonly last_t: number;
  readonly last_lo: number | null;
  readonly last_hi: number | null;
  readonly held: readonly HeldEntry[];
  readonly last_ps: readonly number[];

  constructor(
    center: number,
    last_t = -Infinity,
    last_lo: number | null = null,
    last_hi: number | null = null,
    held: readonly HeldEntry[] = [],
    last_ps: readonly number[] = [],
  ) {
    this.center = center;
    this.last_t = last_t;
    this.last_lo = last_lo;
    this.last_hi = last_hi;
    this.held = held;
    this.last_ps = last_ps;
  }

  after<T extends NoteLike>(t: number, notes: readonly T[]): _Hand {
    const held = this.held.filter((h) => h[0] > t + HELD_TOL);
    if (notes.length === 0) {
      return new _Hand(this.center, this.last_t, this.last_lo, this.last_hi, held, this.last_ps);
    }
    const ps = notes.map((n) => n.pitch);
    const m = ps.reduce((sum, p) => sum + p, 0) / ps.length;
    const c = this.last_lo === null ? m : 0.7 * m + 0.3 * this.center;
    const newHeldEntries: HeldEntry[] = notes.map((n) => [n.end, n.pitch, n.start]);
    return new _Hand(
      c,
      t,
      Math.min(...ps),
      Math.max(...ps),
      [...held, ...newHeldEntries],
      ps,
    );
  }
}

export class _Part<T extends NoteLike = NoteLike> {
  readonly notes: readonly T[];
  readonly ps: readonly number[];
  readonly lo: number;
  readonly hi: number;
  readonly m: number;
  readonly n: number;
  readonly span: number;
  readonly span1: number | null;
  readonly span2: number | null;
  readonly chord: number | null;
  readonly pref: number;

  constructor(notes: readonly T[], side: string) {
    this.notes = notes;
    if (notes.length === 0) {
      this.ps = [];
      this.lo = 0;
      this.hi = 0;
      this.m = 0;
      this.n = 0;
      this.span = 0;
      this.span1 = null;
      this.span2 = null;
      this.chord = null;
      this.pref = 0;
      return;
    }
    const ps = notes.map((n) => n.pitch);
    this.ps = ps;
    this.lo = ps[0]!;
    this.hi = ps[ps.length - 1]!;
    this.n = ps.length;
    this.m = ps.reduce((sum, p) => sum + p, 0) / ps.length;
    const span = this.hi - this.lo;
    this.span = span;
    this.span1 = span > SPAN_FREE ? 2.5 * (span - SPAN_FREE) : null;
    this.span2 = span > SPAN_MAX ? SPAN_OVER + 3.0 * (span - SPAN_MAX) : null;
    if (ps.length > 1) {
      const size = this.hi - this.lo <= 5 ? 0.0 : this.hi - this.lo <= 9 ? 0.5 : 1.0;
      this.chord = CHORD_COST * size * (ps.length - 1) ** 1.5;
    } else {
      this.chord = null;
    }
    if (side === RIGHT) {
      this.pref = 0.02 * ps.reduce((sum, p) => sum + Math.max(0, 55 - p), 0);
    } else {
      this.pref = 0.02 * ps.reduce((sum, p) => sum + Math.max(0, p - 67), 0);
    }
  }
}

export function _hand_cost<T extends NoteLike>(
  hand: _Hand,
  t: number,
  part: _Part<T>,
  side: string,
  other: _Hand,
): number {
  if (part.notes.length === 0) {
    return 0.0;
  }
  const ps = part.ps;
  const lo = part.lo;
  const hi = part.hi;
  let c = 0.0;

  const held = hand.held.filter((h) => h[0] > t + HELD_TOL).map((h) => h[1]);
  const nall = part.n + held.length;
  if (part.n > 5) {
    c += 100.0;
  } else if (nall > 5) {
    c += 8.0 * (nall - 5);
  }

  const span = part.span;
  if (part.span1 !== null) {
    c += part.span1;
  }
  if (part.span2 !== null) {
    c += part.span2;
  }

  if (held.length > 0) {
    const maxHeld = Math.max(...held);
    const minHeld = Math.min(...held);
    const span_h = Math.max(hi, maxHeld) - Math.min(lo, minHeld);
    const threshold = Math.max(span, SPAN_FREE);
    if (span_h > threshold) {
      c += 0.8 * (span_h - threshold);
    }
    if (span_h > SPAN_HELD_MAX) {
      c += 20.0;
    }
  }

  if (part.chord !== null) {
    const dt_h = hand.last_lo !== null ? t - hand.last_t : 1.0;
    const lastSet = new Set(hand.last_ps);
    const newCount = ps.filter((p) => !lastSet.has(p)).length;
    const newRatio = newCount / ps.length;
    c += part.chord * Math.min(3.0, 0.4 / Math.max(1e-3, dt_h)) *
      (REPEAT_SHAPE + (1.0 - REPEAT_SHAPE) * newRatio);
  }

  if (hand.last_lo === null) {
    c += MOVE_COST * Math.abs(part.m - hand.center);
  }

  if (hand.last_lo !== null) {
    const dt = Math.max(1e-3, t - hand.last_t);
    const lh = hand.last_hi!;
    const ll = hand.last_lo!;
    const d = Math.max(...ps.map((p) => Math.max(0.0, p - lh, ll - p)));
    const shift = Math.abs(part.m - hand.center);
    const fade = Math.exp(-dt / 1.5);
    c += fade * MOVE_COST * shift;

    const r = _too_fast(hand, t, lo, hi);
    if (r > 0) {
      c += TOO_FAST * (r + r * r);
    }
    c += SPEED_COST * d / Math.max(dt, 0.05) / 40.0;
  }

  if (other.last_lo !== null && t - other.last_t < 1.0) {
    if (side === RIGHT && lo < other.center - 2) {
      c += 0.25 * (other.center - 2 - lo);
    }
    if (side === LEFT && hi > other.center + 2) {
      c += 0.25 * (hi - other.center - 2);
    }
  }

  c += part.pref;
  return c;
}

export function _too_fast(hand: _Hand, t: number, lo: number, hi: number): number {
  if (hand.last_lo === null) {
    return 0.0;
  }
  const dt = Math.max(1e-3, t - hand.last_t);
  const was = [key_pos(hand.last_hi!) - HAND_WK, key_pos(hand.last_lo!)];
  const now = [key_pos(hi) - HAND_WK, key_pos(lo)];
  const gap = Math.max(0.0, now[0]! - was[1]!, was[0]! - now[1]!);
  if (gap <= 0) {
    return 0.0;
  }
  return Math.max(0.0, travel_time(gap, MAX_SPEED) / Math.max(1e-3, MOVE_SHARE * dt) - 1.0);
}

export function _track_weights<T extends NoteLike>(
  groups: readonly [number, readonly T[]][],
  prefer: ReadonlyMap<number, string> | Record<number, string>,
): Map<number, number> {
  const getPrefer = (id: number): string | undefined => {
    if (prefer instanceof Map) return prefer.get(id);
    return (prefer as Record<number, string>)[id];
  };

  const hands: Record<string, _Hand> = {
    [RIGHT]: new _Hand(67.0),
    [LEFT]: new _Hand(48.0),
  };
  const bad: number[] = [];
  const wide: Record<string, number[]> = { [RIGHT]: [], [LEFT]: [] };

  for (const [t, ns] of groups) {
    for (const side of [RIGHT, LEFT] as const) {
      const mine = ns.filter((n) => getPrefer(objId(n)) === side);
      if (mine.length === 0) continue;
      const ps = mine.map((n) => n.pitch);
      const h = hands[side]!;
      if (_too_fast(h, t, Math.min(...ps), Math.max(...ps)) > TOO_FAST_TRACK) {
        bad.push(t);
      }
      if (
        h.last_lo !== null &&
        t - h.last_t < WIDE_T &&
        Math.max(h.last_hi!, Math.max(...ps)) - Math.min(h.last_lo!, Math.min(...ps)) > SPAN_MAX
      ) {
        wide[side]!.push(t);
        if (wide[side]!.length >= WIDE_STREAK) {
          bad.push(...wide[side]!);
          wide[side] = wide[side]!.slice(-1);
        }
      } else {
        wide[side] = [];
      }
      hands[side] = h.after(t, mine);
    }
  }

  bad.sort((a, b) => a - b);
  const out = new Map<number, number>();
  for (const [t, ns] of groups) {
    const i = bisectLeft(bad, t - TRACK_FREE_T);
    const near = i < bad.length && bad[i]! <= t + TRACK_FREE_T;
    for (const n of ns) {
      out.set(objId(n), near ? TRACK_PRIOR_SOFT : TRACK_PRIOR);
    }
  }
  return out;
}

export function _crowding<T extends NoteLike>(
  _rh: _Hand,
  _lh: _Hand,
  _t: number,
  rn: readonly T[],
  ln: readonly T[],
): number {
  if (rn.length === 1 && ln.length === 1) {
    const gap = rn[0]!.pitch - ln[0]!.pitch;
    return CROWD * Math.max(0, CROWD_GAP - gap);
  }
  return 0.0;
}

export function _inside<T extends NoteLike>(
  rh: _Hand,
  lh: _Hand,
  t: number,
  rn: readonly T[],
  ln: readonly T[],
): number {
  const rd = rh.held.filter((h) => h[0] > t + HELD_TOL && t - h[2] <= INSIDE_T + 1e-9).map((h) => h[1]);
  const ld = lh.held.filter((h) => h[0] > t + HELD_TOL && t - h[2] <= INSIDE_T + 1e-9).map((h) => h[1]);
  const rnp = rn.map((n) => n.pitch);
  const lnp = ln.map((n) => n.pitch);
  const r_all = [...rd, ...rnp];
  const l_all = [...ld, ...lnp];
  if (r_all.length < 2 && l_all.length < 2) {
    return 0.0;
  }
  const isInside = (keys: readonly number[], p: number): boolean => {
    if (keys.length < 2) return false;
    let minKey = Infinity;
    let maxKey = -Infinity;
    for (const k of keys) {
      if (k < minKey) minKey = k;
      if (k > maxKey) maxKey = k;
    }
    return minKey < p && p < maxKey;
  };

  let k = 0;
  for (const p of rnp) {
    if (isInside(l_all, p)) k += 1;
  }
  for (const p of lnp) {
    if (isInside(r_all, p)) k += 1;
  }
  if (lnp.length > 0) {
    for (const q of rd) {
      if (isInside(l_all, q)) k += 1;
    }
  }
  if (rnp.length > 0) {
    for (const q of ld) {
      if (isInside(r_all, q)) k += 1;
    }
  }
  return INSIDE * k;
}

const _BASE_SPANS = [SPAN_FREE, SPAN_MAX, SPAN_HELD_MAX] as const;

export function _fit_spans(pianist?: Pianist | null): void {
  let k = 1.0;
  if (pianist != null && typeof pianist.anatomy === "object" && pianist.anatomy != null) {
    // Match hand_split.py: scale by the hand's real span relative to the
    // default model, not by a legacy "hand_span" anatomy key.
    k = handSpanInches(pianist.anatomy) / handSpanInches(null);
  }
  SPAN_FREE = _BASE_SPANS[0] * k;
  SPAN_MAX = _BASE_SPANS[1] * k;
  SPAN_HELD_MAX = _BASE_SPANS[2] * k;
}

export function split_hands<T extends NoteLike>(
  notes: readonly T[],
  pianist?: Pianist | null,
  prefer?: ReadonlyMap<number, string> | Record<number, string> | null,
): Map<number, string> {
  const prefMap = new Map<number, string>();
  if (prefer) {
    if (prefer instanceof Map) {
      for (const [k, v] of prefer) prefMap.set(k, v);
    } else {
      for (const k of Object.keys(prefer)) {
        prefMap.set(Number(k), (prefer as Record<string, string>)[k]!);
      }
    }
  }

  _fit_spans(pianist);
  MAX_SPEED = pianist != null ? Number(pianist.b("max_speed")) : 3.0;

  const groups = _groups(notes);
  if (groups.length === 0) {
    return new Map<number, string>();
  }

  const weight = prefMap.size > 0 ? _track_weights(groups, prefMap) : new Map<number, number>();

  const firstPitches: number[] = [];
  for (const [, ns] of groups.slice(0, 40)) {
    for (const n of ns) firstPitches.push(n.pitch);
  }
  firstPitches.sort((a, b) => a - b);
  let hi_c = firstPitches.length > 3 ? firstPitches[Math.floor((3 * firstPitches.length) / 4)]! : 67.0;
  let lo_c = firstPitches.length > 3 ? firstPitches[Math.floor(firstPitches.length / 4)]! : 48.0;
  if (hi_c - lo_c < 7) {
    hi_c = Math.max(hi_c, 60.0);
    lo_c = Math.min(lo_c, 53.0);
  }

  const tracksSet = new Set<number>();
  for (const [, ns] of groups) {
    for (const n of ns) {
      if (!prefMap.has(objId(n))) {
        tracksSet.add(n.track ?? 0);
      }
    }
  }
  const multi = tracksSet.size > 1;

  const allNotes: T[] = [];
  for (const [, ns] of groups) {
    for (const n of ns) allNotes.push(n);
  }
  const trillRuns = find_trills(allNotes);
  const trillOf = new Map<number, number>();
  const trillEnd = new Map<number, number>();
  for (let e = 0; e < trillRuns.length; e += 1) {
    const run = trillRuns[e]!;
    for (const n of run) {
      trillOf.set(objId(n), e);
    }
    trillEnd.set(e, run[run.length - 1]!.start);
  }

  // beam entries: [cost, rh, lh, back_pointer, split_k, tr, th]
  type BeamItem = [
    number, // cost
    _Hand, // rh
    _Hand, // lh
    number | null, // bi
    number | null, // k
    ReadonlyArray<readonly [number, readonly [string, number]]>, // tr: track -> [hand, t]
    ReadonlyArray<readonly [number, string]>, // th: trill -> hand
  ];

  let beam: BeamItem[] = [
    [0.0, new _Hand(hi_c), new _Hand(lo_c), null, null, [], []],
  ];
  const history: Array<Array<[number, number]>> = [];
  let lastGroup: [number, readonly T[]] | null = null;

  for (let gi = 0; gi < groups.length; gi += 1) {
    if (gi % 64 === 0) {
      progress.report(gi / groups.length);
    }
    const [t, ns] = groups[gi]!;
    const repeat =
      lastGroup !== null &&
      t - lastGroup[0] < REPEAT_T &&
      lastGroup[1].map((n) => n.pitch).join(",") === ns.map((n) => n.pitch).join(",");
    lastGroup = [t, ns];

    const splits: Array<[number, T[], T[]]> = [];
    for (let k = 0; k <= ns.length; k += 1) {
      splits.push([k, ns.slice(0, k), ns.slice(k)]);
    }

    if (ns.every((n) => prefMap.has(objId(n)))) {
      const ln = ns.filter((n) => prefMap.get(objId(n)) === LEFT);
      const isPrefix = ln.length === ns.slice(0, ln.length).filter((n) => prefMap.get(objId(n)) === LEFT).length &&
        ln.length === ns.slice(0, ln.length).length;
      if (!isPrefix) {
        splits.push([-1, ln, ns.filter((n) => prefMap.get(objId(n)) !== LEFT)]);
      }
    }

    const parts = splits.map(([, ln, rn]) => [new _Part(rn, RIGHT), new _Part(ln, LEFT)] as const);

    const trillHands: Array<Map<number, string> | null> = [];
    for (const [, ln, rn] of splits) {
      let d: Map<number, string> | null = new Map<number, string>();
      const assignments = [
        ...ln.map((n) => [n, LEFT] as const),
        ...rn.map((n) => [n, RIGHT] as const),
      ];
      for (const [n, h] of assignments) {
        const e = trillOf.get(objId(n));
        if (e !== undefined) {
          if (!d.has(e)) {
            d.set(e, h);
          } else if (d.get(e) !== h) {
            d = null;
            break;
          }
        }
      }
      trillHands.push(d);
    }

    interface CandItem {
      cost: number;
      bi: number;
      k: number;
      ln: T[];
      rn: T[];
      d: Map<number, string> | null;
    }

    const cand: CandItem[] = [];

    for (let bi = 0; bi < beam.length; bi += 1) {
      const [cost, rh, lh, , pk, tr, th] = beam[bi]!;
      const lastTrackMap = new Map<number, readonly [string, number]>(tr);
      const heldTrillMap = new Map<number, string>(th);

      for (let sIdx = 0; sIdx < splits.length; sIdx += 1) {
        const [k, ln, rn] = splits[sIdx]!;
        const [rp, lp] = parts[sIdx]!;
        const d = trillHands[sIdx]!;
        if (d === null) continue;

        let conflict = false;
        for (const [e, h] of d) {
          const existing = heldTrillMap.get(e);
          if (existing !== undefined && existing !== h) {
            conflict = true;
            break;
          }
        }
        if (conflict) continue;

        let c = cost + _hand_cost(rh, t, rp, RIGHT, lh) + _hand_cost(lh, t, lp, LEFT, rh);
        if (repeat && k !== pk) {
          c += REPEAT_SPLIT;
        }
        c += _crowding(rh, lh, t, rn, ln);
        c += _inside(rh, lh, t, rn, ln);

        if (prefMap.size > 0) {
          for (const n of ln) {
            if ((prefMap.get(objId(n)) ?? LEFT) !== LEFT) {
              c += weight.get(objId(n)) ?? TRACK_PRIOR;
            }
          }
          for (const n of rn) {
            if ((prefMap.get(objId(n)) ?? RIGHT) !== RIGHT) {
              c += weight.get(objId(n)) ?? TRACK_PRIOR;
            }
          }
        }

        if (multi) {
          for (const [n, h] of [...ln.map((x) => [x, LEFT] as const), ...rn.map((x) => [x, RIGHT] as const)]) {
            if (prefMap.has(objId(n))) continue;
            const trk = n.track ?? 0;
            const prev = lastTrackMap.get(trk);
            if (prev && prev[0] !== h && t - prev[1] < TRACK_T) {
              c += TRACK_SWITCH;
            }
          }
        }

        cand.push({ cost: c, bi, k, ln, rn, d });
      }
    }

    cand.sort((a, b) => a.cost - b.cost);

    const newBeam: BeamItem[] = [];
    const seen = new Set<string>();

    for (const { cost: c, bi, k, ln, rn, d } of cand) {
      const [, rh, lh, , , tr, th] = beam[bi]!;
      let newTh = th;
      if (d !== null && d.size > 0 || th.length > 0) {
        const held = new Map<number, string>(th);
        if (d !== null) {
          for (const [e, h] of d) held.set(e, h);
        }
        const filteredTh: Array<[number, string]> = [];
        for (const [e, h] of held) {
          if ((trillEnd.get(e) ?? 0) > t + 1e-9) {
            filteredTh.push([e, h]);
          }
        }
        filteredTh.sort((a, b) => a[0] - b[0]);
        newTh = filteredTh;
      }

      const nr = rh.after(t, rn);
      const nl = lh.after(t, ln);

      let newTr = tr;
      let handsKeyStr = "";
      if (multi) {
        const dTr = new Map<number, readonly [string, number]>(tr);
        for (const n of ln) {
          dTr.set(n.track ?? 0, [LEFT, t]);
        }
        for (const n of rn) {
          dTr.set(n.track ?? 0, [RIGHT, t]);
        }
        const sortedTr = Array.from(dTr.entries()).sort((a, b) => a[0] - b[0]);
        newTr = sortedTr;
        handsKeyStr = sortedTr.map(([trk, [h]]) => `${trk}:${h}`).join(",");
      }

      const thStr = newTh.map(([e, h]) => `${e}:${h}`).join(",");
      const key = `${Math.round(nr.center)}|${Math.round(nl.center)}|${k}|${handsKeyStr}|${thStr}`;
      if (seen.has(key)) continue;
      seen.add(key);

      newBeam.push([c, nr, nl, bi, k, newTr, newTh]);
      if (newBeam.length >= BEAM) break;
    }

    history.push(newBeam.map((e) => [e[3]!, e[4]!]));
    beam = newBeam;
  }

  const out = new Map<number, string>();
  let j = 0;
  for (let gi = groups.length - 1; gi >= 0; gi -= 1) {
    const [bi, k] = history[gi]![j]!;
    const [, ns] = groups[gi]!;
    for (let i = 0; i < ns.length; i += 1) {
      const n = ns[i]!;
      if (k === -1) {
        out.set(objId(n), prefMap.get(objId(n)) === LEFT ? LEFT : RIGHT);
      } else {
        out.set(objId(n), i < k ? LEFT : RIGHT);
      }
    }
    j = bi;
  }

  return out;
}

export const splitHands = split_hands;
