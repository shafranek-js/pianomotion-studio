/**
 * glissando.ts - Find the glissandos in one hand's notes.
 *
 * Ported 1-to-1 from python-core/handthesia_core/glissando.py.
 */

import { bisectRight, divmod } from "./pythonCompat.ts";
import { type NoteLike, objId } from "./figures.ts";
import type { Pianist } from "./pianist.ts";

export const BLACK: ReadonlySet<number> = new Set([1, 3, 6, 8, 10]);
export const SAME_T = 0.012; // s, notes struck closer than this sound together
export const MAX_SKIP = 1; // same-colour keys a detected run may skip at a step
export const TAIL_SKIP = 3; // a run's loose ends may skip this many keys of its colour...
export const TAIL_GAP = 2.0; // ...and come this many times the gap after (or before) it
export const EXPLICIT_GAP_T = 0.5; // s, explicitly marked notes further apart than this are separate glissandos
export const MERGE_MAX_KEYS = 5; // keys from where the last ended

export function isBlack(p: number): boolean {
  return BLACK.has(((p % 12) + 12) % 12);
}

export const is_black = isBlack;

export function keysBetween(a: number, b: number, black: boolean): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let count = 0;
  if (a <= b) {
    for (let q = lo + 1; q <= hi; q += 1) {
      if (isBlack(q) === black) count += 1;
    }
  } else {
    for (let q = lo; q < hi; q += 1) {
      if (isBlack(q) === black) count += 1;
    }
  }
  return count;
}

export const keys_between = keysBetween;

const SORTED_BLACK: readonly number[] = [1, 3, 6, 8, 10];
const WHITE_PCS: readonly number[] = [0, 2, 4, 5, 7, 9, 11];

export function colourIndex(p: number): number {
  const [o, pc] = divmod(p, 12);
  if (BLACK.has(pc)) {
    return o * 5 + SORTED_BLACK.indexOf(pc);
  }
  return o * 7 + WHITE_PCS.indexOf(pc);
}

export const colour_index = colourIndex;

export function isString<T extends NoteLike>(notes: readonly T[], maxSkip = 0): boolean {
  if (notes.length < 3) return false;
  const black = isBlack(notes[0]!.pitch);
  if (notes.some((n) => isBlack(n.pitch) !== black)) return false;
  const steps: number[] = [];
  for (let idx = 0; idx < notes.length - 1; idx += 1) {
    steps.push(colourIndex(notes[idx + 1]!.pitch) - colourIndex(notes[idx]!.pitch));
  }
  if (steps.some((s) => s === 0 || Math.abs(s) > 1 + maxSkip)) return false;
  return steps.every((s) => s > 0) || steps.every((s) => s < 0);
}

export const is_string = isString;

export function ordered<T extends NoteLike>(notes: readonly T[]): T[] {
  const ns = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const out: T[] = [];
  let i = 0;
  while (i < ns.length) {
    let j = i + 1;
    while (j < ns.length && ns[j]!.start - ns[i]!.start < SAME_T) {
      j += 1;
    }
    const cluster = ns.slice(i, j);
    if (cluster.length > 1) {
      const before = out.length > 0 ? out[out.length - 1]!.pitch : null;
      const after = j < ns.length ? ns[j]!.pitch : null;
      const mean = cluster.reduce((sum, n) => sum + n.pitch, 0) / cluster.length;
      const up =
        (before !== null && before < mean) ||
        (before === null && after !== null && after > mean);
      cluster.sort((a, b) => (up ? a.pitch - b.pitch : b.pitch - a.pitch));
    }
    out.push(...cluster);
    i = j;
  }
  return out;
}

export const _ordered = ordered;

export function detect<T extends NoteLike>(notes: readonly T[], maxGap: number, minLen: number): T[][] {
  const ns = ordered(notes);
  const runs: T[][] = [];
  let cur: T[] = [];
  let d = 0;

  function closeRun(): void {
    if (cur.length >= minLen) {
      runs.push([...cur]);
    }
  }

  for (const n of ns) {
    if (cur.length > 0) {
      const a = cur[cur.length - 1]!;
      const step = isBlack(n.pitch) === isBlack(a.pitch)
        ? colourIndex(n.pitch) - colourIndex(a.pitch)
        : 0;
      const ok =
        step !== 0 &&
        Math.abs(step) <= 1 + MAX_SKIP &&
        n.start - a.start <= maxGap + 1e-9 &&
        (d === 0 || (step > 0) === (d > 0));
      if (ok) {
        cur.push(n);
        d = step;
        continue;
      }
      closeRun();
      if (
        step !== 0 &&
        Math.abs(step) <= 1 + MAX_SKIP &&
        n.start - a.start <= maxGap + 1e-9
      ) {
        cur = [a, n];
        d = step;
      } else {
        cur = [n];
        d = 0;
      }
      continue;
    }
    cur = [n];
    d = 0;
  }
  closeRun();

  const taken = new Set<number>();
  const out: T[][] = [];
  for (const r of runs) {
    const filtered = r.filter((n) => !taken.has(objId(n)));
    if (filtered.length >= Math.min(minLen, 3)) {
      out.push(filtered);
      for (const n of filtered) {
        taken.add(objId(n));
      }
    }
  }

  const pos = new Map<number, number>();
  for (let idx = 0; idx < ns.length; idx += 1) {
    pos.set(objId(ns[idx]!), idx);
  }

  for (const r of out) {
    const dir = colourIndex(r[r.length - 1]!.pitch) > colourIndex(r[0]!.pitch) ? 1 : -1;
    for (const [end, step] of [[1, 1], [0, -1]] as const) {
      while (true) {
        const edge = end ? r[r.length - 1]! : r[0]!;
        const i = (pos.get(objId(edge)) ?? -1) + step;
        if (i < 0 || i >= ns.length || taken.has(objId(ns[i]!))) {
          break;
        }
        const n = ns[i]!;
        const k = (colourIndex(n.pitch) - colourIndex(edge.pitch)) * step;
        if (
          isBlack(n.pitch) !== isBlack(edge.pitch) ||
          !(0 < k * dir && k * dir <= TAIL_SKIP + 1) ||
          Math.abs(n.start - edge.start) > TAIL_GAP * maxGap
        ) {
          break;
        }
        taken.add(objId(n));
        if (end) {
          r.push(n);
        } else {
          r.unshift(n);
        }
      }
    }
  }
  return out;
}

export function explicit<T extends NoteLike>(notes: readonly T[]): T[][] {
  const ns = ordered(notes).filter((n) => Boolean(n.gliss));
  const runs: T[][] = [];
  let cur: T[] = [];
  for (const n of ns) {
    if (cur.length > 0 && n.start - cur[cur.length - 1]!.start > EXPLICIT_GAP_T) {
      runs.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length > 0) {
    runs.push(cur);
  }
  return runs.filter((r) => r.length >= 2);
}

export function find<T extends NoteLike>(notes: readonly T[], pianist?: Pianist | null): T[][] {
  let runs = explicit(notes);
  const on = pianist == null || pianist.b("glissando") === "on";
  if (on) {
    const gap = pianist != null ? Number(pianist.b("gliss_gap")) : 0.05;
    const k = pianist != null ? Math.round(Number(pianist.b("gliss_min"))) : 6;
    const marked = new Set<number>();
    for (const r of runs) {
      for (const n of r) marked.add(objId(n));
    }
    const nonGlissNotes = notes.filter((n) => !n.gliss);
    const detected = detect(nonGlissNotes, gap, k);
    for (const r of detected) {
      if (!r.some((n) => marked.has(objId(n)))) {
        runs.push(r);
      }
    }
  }
  runs.sort((a, b) => a[0]!.start - b[0]!.start);
  return runs;
}

export function episodes<T extends NoteLike>(
  runs: readonly (readonly T[])[],
  notes: readonly T[],
  mergeT: number,
): T[][][] {
  const inRun = new Set<number>();
  for (const r of runs) {
    for (const n of r) inRun.add(objId(n));
  }
  const others = notes
    .filter((n) => !inRun.has(objId(n)))
    .map((n) => n.start)
    .sort((a, b) => a - b);

  const out: T[][][] = [];
  for (const r of runs) {
    const rCopy = [...r];
    if (out.length > 0) {
      const lastEpisode = out[out.length - 1]!;
      const lastRun = lastEpisode[lastEpisode.length - 1]!;
      const t0 = lastRun[lastRun.length - 1]!.start;
      const t1 = rCopy[0]!.start;
      const i = bisectRight(others, t0);
      const near =
        keysBetween(
          lastRun[lastRun.length - 1]!.pitch,
          rCopy[0]!.pitch,
          isBlack(rCopy[0]!.pitch),
        ) <= MERGE_MAX_KEYS;
      if (t1 - t0 < mergeT && near && (i >= others.length || others[i]! >= t1)) {
        lastEpisode.push(rCopy);
        continue;
      }
    }
    out.push([rCopy]);
  }
  return out;
}
