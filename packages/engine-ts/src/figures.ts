/**
 * figures.ts - Recognise the standard figures of piano technique in a hand's
 * notes and give them their standard fingering.
 *
 * Ported 1-to-1 from python-core/handthesia_core/figures.py.
 */

export const LEFT = "L";
export const RIGHT = "R";
export const BLACK: ReadonlySet<number> = new Set([1, 3, 6, 8, 10]);

export const TRILL_GAP_T = 0.2;
export const TRILL_CHORD_T = 0.035;
export const TRILL_MIN_NOTES = 6;
export const TRILL_NEAR = 7;

export interface NoteLike {
  pitch: number;
  start: number;
  end: number;
  velocity?: number;
  track?: number;
  hand?: string | null;
  finger?: number | null;
  gliss?: boolean;
  id?: number | string;
  noteId?: string | null;
}

export type NoteGroup<T extends NoteLike = NoteLike> = [number, T[]];
export type KeyMode = "maj" | "min";
export type KeyName = [string, KeyMode];
export type FingerSpec = number | ReadonlySet<number>;
export type FigureSuggestion = [FingerSpec, number];

const GLOBAL_ID_KEY = Symbol.for("handthesia.engine.objectIdMap");
const GLOBAL_ID_COUNTER_KEY = Symbol.for("handthesia.engine.objectIdCounter");

function getGlobalIdMap(): WeakMap<object, number> {
  const g = globalThis as Record<symbol, unknown>;
  if (!(g[GLOBAL_ID_KEY] instanceof WeakMap)) {
    g[GLOBAL_ID_KEY] = new WeakMap<object, number>();
  }
  return g[GLOBAL_ID_KEY] as WeakMap<object, number>;
}

export function objId(obj: object): number {
  const map = getGlobalIdMap();
  let existing = map.get(obj);
  if (existing === undefined) {
    const g = globalThis as Record<symbol, unknown>;
    const next = typeof g[GLOBAL_ID_COUNTER_KEY] === "number" ? (g[GLOBAL_ID_COUNTER_KEY] as number) + 1 : 1;
    g[GLOBAL_ID_COUNTER_KEY] = next;
    existing = next;
    map.set(obj, existing);
  }
  return existing;
}

/**
 * A Map<NoteLike, V> that also supports numeric `objId(note)` and string `note.noteId` / `note.id`
 * lookups via `.get()`, `.has()`, and bracket indexing `map[id]`.
 */
export class HybridNoteMap<K extends object = NoteLike, V = unknown> extends Map<K, V> {
  [key: number]: V;
  [key: string]: unknown;
  private readonly byKey = new Map<number | string, V>();

  setNote(note: K, value: V): this {
    super.set(note, value);
    const id = objId(note);
    this.byKey.set(id, value);
    (this as Record<number | string, unknown>)[id] = value;
    const anyNote = note as { id?: unknown; noteId?: unknown };
    if (typeof anyNote.id === "number" || typeof anyNote.id === "string") {
      this.byKey.set(anyNote.id, value);
      (this as Record<number | string, unknown>)[anyNote.id] = value;
    }
    if (typeof anyNote.noteId === "number" || typeof anyNote.noteId === "string") {
      this.byKey.set(anyNote.noteId, value);
      (this as Record<number | string, unknown>)[anyNote.noteId] = value;
    }
    return this;
  }

  override set(key: K, value: V): this {
    if (key !== null && typeof key === "object") {
      return this.setNote(key, value);
    }
    const primitiveKey = key as unknown as number | string;
    this.byKey.set(primitiveKey, value);
    (this as Record<number | string, unknown>)[primitiveKey] = value;
    return this;
  }

  override get(key: unknown): V | undefined {
    if (key !== null && typeof key === "object") {
      if (super.has(key as K)) {
        return super.get(key as K);
      }
      const id = objId(key);
      if (this.byKey.has(id)) {
        return this.byKey.get(id);
      }
      const anyKey = key as { id?: unknown; noteId?: unknown };
      if ((typeof anyKey.id === "number" || typeof anyKey.id === "string") && this.byKey.has(anyKey.id)) {
        return this.byKey.get(anyKey.id);
      }
      if ((typeof anyKey.noteId === "number" || typeof anyKey.noteId === "string") && this.byKey.has(anyKey.noteId)) {
        return this.byKey.get(anyKey.noteId);
      }
      return undefined;
    }
    if (typeof key === "number" || typeof key === "string") {
      if (this.byKey.has(key)) {
        return this.byKey.get(key);
      }
      const asNum = typeof key === "string" ? Number(key) : NaN;
      if (!Number.isNaN(asNum) && this.byKey.has(asNum)) {
        return this.byKey.get(asNum);
      }
    }
    return undefined;
  }

  override has(key: unknown): boolean {
    if (key !== null && typeof key === "object") {
      if (super.has(key as K)) {
        return true;
      }
      const id = objId(key);
      if (this.byKey.has(id)) {
        return true;
      }
      const anyKey = key as { id?: unknown; noteId?: unknown };
      if ((typeof anyKey.id === "number" || typeof anyKey.id === "string") && this.byKey.has(anyKey.id)) {
        return true;
      }
      if ((typeof anyKey.noteId === "number" || typeof anyKey.noteId === "string") && this.byKey.has(anyKey.noteId)) {
        return true;
      }
      return false;
    }
    if (typeof key === "number" || typeof key === "string") {
      if (this.byKey.has(key)) {
        return true;
      }
      const asNum = typeof key === "string" ? Number(key) : NaN;
      if (!Number.isNaN(asNum) && this.byKey.has(asNum)) {
        return true;
      }
    }
    return false;
  }
}

export function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

export function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return mod(f, 2) === 0 ? f : f + 1;
}

export function bisectLeft(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// ----------------------------------------------------------------- keys
export const PC: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};
export const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export const HARM = [0, 2, 3, 5, 7, 8, 11];
export const NAT = [0, 2, 3, 5, 7, 8, 10];
export const MELU = [0, 2, 3, 5, 7, 9, 11];
export const MAJ_NAME: Record<number, string> = {
  0: "C", 1: "Db", 2: "D", 3: "Eb", 4: "E", 5: "F",
  6: "F#", 7: "G", 8: "Ab", 9: "A", 10: "Bb", 11: "B",
};
export const MIN_NAME: Record<number, string> = {
  0: "C", 1: "C#", 2: "D", 3: "Eb", 4: "E", 5: "F",
  6: "F#", 7: "G", 8: "G#", 9: "A", 10: "Bb", 11: "B",
};

function keyId(key: KeyName): string {
  return `${key[0]}:${key[1]}`;
}

export const THUMBS: Record<string, [string, string]> = {
  "C:maj": ["C F", "C G"], "G:maj": ["G C", "G D"], "D:maj": ["D G", "D A"],
  "A:maj": ["A D", "A E"], "E:maj": ["E A", "E B"], "B:maj": ["B E", "E B"],
  "F#:maj": ["B F", "B F"], "Db:maj": ["F C", "F C"], "Ab:maj": ["C F", "C G"],
  "Eb:maj": ["F C", "G D"], "Bb:maj": ["C F", "D A"], "F:maj": ["F C", "C F"],
  "A:min": ["A D", "A E"], "E:min": ["E A", "E B"], "B:min": ["B E", "E B"],
  "F#:min": ["A D", "B F"], "C#:min": ["E A", "E C"], "G#:min": ["B E", "B G"],
  "Eb:min": ["F B", "F B"], "Bb:min": ["C F", "C F"], "F:min": ["F C", "C F"],
  "C:min": ["C F", "C G"], "G:min": ["G C", "G D"], "D:min": ["D G", "D A"],
};

export const MEL_UP: Record<string, [string, string]> = {
  "Eb:min": ["F C", "F C"], "G#:min": ["B F", "B G"],
  "F#:min": ["A D#", "B F"], "C#:min": ["E A#", "E C"],
};

export const MEL_DOWN: Record<string, [string, string]> = {
  "Eb:min": ["F B", "F B"], "G#:min": ["E B", "B E"],
  "F#:min": ["A D", "B E"], "C#:min": ["E A", "E B"],
};

export const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
export const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function _pcs(spec: string): Set<number> {
  const out = new Set<number>();
  for (const x of spec.trim().split(/\s+/)) {
    if (x in PC) {
      out.add(PC[x]!);
    }
  }
  return out;
}

export function key_scale(key: KeyName, melodic = false): [number[], number[]] {
  const [name, mode] = key;
  const t = PC[name]!;
  if (mode === "maj") {
    const s = MAJOR.map((x) => mod(t + x, 12)).sort((a, b) => a - b);
    return [s, s];
  }
  if (melodic) {
    return [
      MELU.map((x) => mod(t + x, 12)).sort((a, b) => a - b),
      NAT.map((x) => mod(t + x, 12)).sort((a, b) => a - b),
    ];
  }
  const s = HARM.map((x) => mod(t + x, 12)).sort((a, b) => a - b);
  return [s, s];
}
export const keyScale = key_scale;

function _corr(a: readonly number[], b: readonly number[]): number {
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < 12; i++) {
    sumA += a[i]!;
    sumB += b[i]!;
  }
  const ma = sumA / 12;
  const mb = sumB / 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const xa = a[i]! - ma;
    const yb = b[i]! - mb;
    num += xa * yb;
    da += xa * xa;
    db += yb * yb;
  }
  const den = Math.sqrt(da * db) || 1.0;
  return num / den;
}

function isSubset(sub: ReadonlySet<number>, sup: ReadonlySet<number>): boolean {
  for (const x of sub) {
    if (!sup.has(x)) return false;
  }
  return true;
}

export function find_key(
  run_pcs: Iterable<number>,
  context_hist: readonly number[],
  first: number | null = null,
  last: number | null = null,
): [KeyName, boolean] | null {
  const runSet = run_pcs instanceof Set ? run_pcs : new Set(run_pcs);
  let best: [number, KeyName, boolean] | null = null;
  for (let t = 0; t < 12; t++) {
    const modes: Array<[KeyMode, number[]]> = [
      ["maj", KK_MAJ],
      ["min", KK_MIN],
    ];
    for (const [mode, prof] of modes) {
      let forms: Array<[Set<number>, boolean]>;
      if (mode === "maj") {
        forms = [[new Set(MAJOR.map((x) => mod(t + x, 12))), false]];
      } else {
        const harmSet = new Set(HARM.map((x) => mod(t + x, 12)));
        const melSet = new Set<number>([
          ...MELU.map((x) => mod(t + x, 12)),
          ...NAT.map((x) => mod(t + x, 12)),
        ]);
        forms = [
          [harmSet, false],
          [melSet, true],
        ];
      }
      for (const [scale, mel] of forms) {
        if (!isSubset(runSet, scale)) {
          continue;
        }
        const rot = t ? prof.slice(12 - t).concat(prof.slice(0, 12 - t)) : prof;
        let s = _corr(context_hist, rot);
        s += 0.15 * ((first === t ? 1 : 0) + (last === t ? 1 : 0));
        if (mel) {
          s -= 0.05;
        }
        const name = mode === "maj" ? MAJ_NAME[t]! : MIN_NAME[t]!;
        if (best === null || s > best[0]) {
          best = [s, [name, mode], mel];
        }
      }
    }
  }
  return best === null ? null : [best[1], best[2]];
}
export const findKey = find_key;

export function thumb_sets(key: KeyName, hand: string, melodic: boolean): [Set<number>, Set<number>] {
  const h = hand === RIGHT ? 0 : 1;
  const kid = keyId(key);
  if (melodic && kid in MEL_UP) {
    return [_pcs(MEL_UP[kid]![h]), _pcs(MEL_DOWN[kid]![h])];
  }
  const base = _pcs(THUMBS[kid]![h]);
  return [base, new Set(base)];
}
export const thumbSets = thumb_sets;

export function scale_fingering(
  ps: readonly number[],
  thumbs_up: ReadonlySet<number>,
  hand: string,
  thumbs_down: ReadonlySet<number>,
  scales: [readonly number[], readonly number[]],
  opening = true,
): Array<number | null> {
  const n = ps.length;
  const going_up = Array.from({ length: n }, (_, i) =>
    i + 1 < n ? ps[i + 1]! > ps[i]! : i > 0 ? ps[i]! > ps[i - 1]! : false,
  );
  const arrive_up = Array.from({ length: n }, (_, i) =>
    i > 0 ? ps[i]! > ps[i - 1]! : going_up[0] ?? false,
  );
  const allp = Array.from(new Set(ps.map((p) => mod(p, 12)))).sort((a, b) => a - b);
  const [up_pcs, dn_pcs] = scales;

  function steps(
    pc: number,
    pcsInput: readonly number[],
    thumbs: ReadonlySet<number>,
    direction: number,
    skip_self = false,
  ): number | null {
    let pcs = pcsInput;
    if (!pcs.includes(pc)) {
      pcs = Array.from(new Set([...pcs, pc])).sort((a, b) => a - b);
    }
    const k = pcs.indexOf(pc);
    for (let s = skip_self ? 1 : 0; s < 8; s++) {
      if (thumbs.has(pcs[mod(k + direction * s, pcs.length)]!)) {
        return s;
      }
    }
    return null;
  }

  const unionThumbs = new Set<number>([...thumbs_up, ...thumbs_down]);
  const out: Array<number | null> = new Array(n).fill(null);
  if (opening && hand === RIGHT && n > 1 && going_up[0] && !thumbs_up.has(mod(ps[0]!, 12))) {
    let k = 0;
    while (k < n && k < 3 && !thumbs_up.has(mod(ps[k]!, 12)) && (k === 0 || ps[k]! > ps[k - 1]!)) {
      out[k] = 2 + k;
      k += 1;
    }
  }
  for (let i = 0; i < n; i++) {
    if (out[i] !== null) {
      continue;
    }
    const pc = mod(ps[i]!, 12);
    const up = arrive_up[i]!;
    const [pcs, thumbs] = up ? [up_pcs, thumbs_up] : [dn_pcs, thumbs_down];
    const top = i > 0 && i < n - 1 && ps[i - 1]! < ps[i]! && ps[i]! > ps[i + 1]!;
    const bot = i > 0 && i < n - 1 && ps[i - 1]! > ps[i]! && ps[i]! < ps[i + 1]!;
    let k: number | null;
    if (hand === RIGHT) {
      if (top && out[i - 1]) {
        out[i] = Math.min(5, out[i - 1]! + 1);
        continue;
      }
      k = steps(pc, pcs, thumbs, -1);
      if (k === null || k > 4) {
        k = steps(pc, allp, unionThumbs, -1);
      }
    } else {
      if (bot && out[i - 1]) {
        out[i] = Math.min(5, out[i - 1]! + 1);
        continue;
      }
      if (i === 0 && going_up[0] && opening) {
        k = steps(pc, up_pcs, thumbs_up, +1, true);
      } else {
        k = steps(pc, pcs, thumbs, +1);
        if (k === null || k > 4) {
          k = steps(pc, allp, unionThumbs, +1);
        }
      }
    }
    out[i] = k === null || k > 4 ? null : 1 + k;
  }
  return out;
}
export const scaleFingering = scale_fingering;

// ----------------------------------------------------------------- chromatic
export const CHROM_R: Record<number, number> = {
  0: 2, 1: 3, 2: 1, 3: 3, 4: 1, 5: 2, 6: 3, 7: 1, 8: 3, 9: 1, 10: 3, 11: 1,
};
export const CHROM_L: Record<number, number> = {
  0: 1, 1: 3, 2: 1, 3: 3, 4: 2, 5: 1, 6: 3, 7: 1, 8: 3, 9: 1, 10: 3, 11: 2,
};

export const DEFAULT_PREFS: Record<string, string> = {
  chromatic: "13",
  repeated: "321",
  trill: "auto",
  octaves: "4black",
};
export const PREFS: Record<string, string> = { ...DEFAULT_PREFS };

export const CHROM_MAPS: Record<string, [Record<number, number>, string | null]> = {
  "12": [{ 0: 2, 1: 3, 2: 1, 3: 2, 4: 1, 5: 2, 6: 3, 7: 1, 8: 2, 9: 1, 10: 2, 11: 1 }, "renumber"],
  "13": [CHROM_R, "thumb"],
  "12345": [{ 0: 1, 1: 2, 2: 3, 3: 4, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 1, 10: 2, 11: 3 }, null],
  "231": [{ 0: 2, 1: 3, 2: 1, 3: 2, 4: 3, 5: 1, 6: 2, 7: 1, 8: 2, 9: 3, 10: 4, 11: 1 }, null],
};

function _chrom_groups4(lo: number, hi: number): Record<number, number> {
  const out: Record<number, number> = {};
  let p = lo;
  out[p] = 1;
  while (p < hi) {
    let nxt: number | null = null;
    for (let k = 4; k > 0; k--) {
      if (!BLACK.has(mod(p + k, 12))) {
        nxt = p + k;
        break;
      }
    }
    nxt = nxt ?? p + 1;
    for (let q = p + 1; q < Math.min(nxt, hi + 1); q++) {
      out[q] = q - p + 1;
    }
    if (nxt <= hi) {
      out[nxt] = 1;
    }
    p = nxt;
  }
  return out;
}

function _start_thumb(
  ps: readonly number[],
  f: number[],
  hand: string,
  rule: string | null,
  cmap: Record<number, number>,
): void {
  if (!rule) {
    return;
  }
  const vps = ps.map((p) => (hand === RIGHT ? p : 124 - p));
  const lo = Math.min(...vps);
  if (BLACK.has(mod(lo, 12)) || cmap[hand === RIGHT ? mod(lo, 12) : mod(124 - lo, 12)] === 1) {
    return;
  }
  for (let i = 0; i < vps.length; i++) {
    const v = vps[i]!;
    if (v === lo) {
      f[i] = 1;
    } else if (rule === "renumber" && lo < v) {
      let allNonThumb = true;
      for (let q = lo + 1; q <= v; q++) {
        if (cmap[mod(hand === RIGHT ? q : 124 - q, 12)] === 1) {
          allNonThumb = false;
          break;
        }
      }
      if (allNonThumb) {
        f[i] = v - lo + 1 <= 5 ? v - lo + 1 : f[i]!;
      }
    }
  }
}

export function chromatic_fingering(ps: readonly number[], hand: string): number[] {
  const style = PREFS["chromatic"] ?? "13";
  let m: Record<number, number> | null = null;
  if (style === "13" && hand === RIGHT) {
    m = CHROM_R;
  } else if (style === "13") {
    m = CHROM_L;
  }
  if (m !== null) {
    const f = ps.map((p) => m![mod(p, 12)]!);
    const n = ps.length;
    for (let i = 0; i < n; i++) {
      const peak = i > 0 && i < n - 1 && ps[i - 1]! < ps[i]! && ps[i]! > ps[i + 1]!;
      if (hand === RIGHT && peak && mod(ps[i]!, 12) === 0) {
        if (f[i - 1] === 4 || mod(ps[i - 1]!, 12) === 11) {
          f[i] = 5;
        }
      }
    }
    _start_thumb(ps, f, hand, "thumb", m);
    return f;
  }
  const vps = ps.map((p) => (hand === RIGHT ? p : 124 - p));
  if (style === "1234") {
    const fmap = _chrom_groups4(Math.min(...vps), Math.max(...vps));
    return vps.map((v) => fmap[v]!);
  }
  const [cmap, start] = CHROM_MAPS[style] ?? CHROM_MAPS["13"]!;
  const f = vps.map((v) => cmap[mod(v, 12)]!);
  _start_thumb(vps, f, RIGHT, start, cmap);
  return f;
}
export const chromaticFingering = chromatic_fingering;

// ----------------------------------------------------------------- arpeggios
export const ARP: Record<string, [string, number, string, number]> = {
  "C:maj": ["C1 E2 G3", 1, "C1 G2 E4", 5], "A:min": ["A1 C2 E3", 1, "A1 E2 C4", 5],
  "F:maj": ["F1 A2 C3", 1, "F1 C2 A4", 5], "D:min": ["D1 F2 A3", 1, "D1 A2 F4", 5],
  "Bb:maj": ["D1 F2 Bb4", 2, "F1 D2 Bb3", 3], "G:min": ["G1 Bb2 D3", 1, "G1 D2 Bb4", 5],
  "Eb:maj": ["G1 Bb2 Eb4", 2, "G1 Eb2 Bb4", 3], "C:min": ["C1 Eb2 G3", 1, "C1 G2 Eb4", 5],
  "Ab:maj": ["C1 Eb2 Ab4", 2, "C1 Ab2 Eb4", 3], "F:min": ["F1 Ab2 C3", 1, "F1 C2 Ab4", 5],
  "Db:maj": ["F1 Ab2 Db4", 2, "F1 Db2 Ab4", 2], "Bb:min": ["F1 Bb2 Db3", 2, "F1 Db2 Bb3", 3],
  "F#:maj": ["F#1 Bb2 Db3", 1, "F#1 Db2 Bb3", 5], "Eb:min": ["Eb1 F#2 Bb3", 1, "Eb1 Bb2 F#4", 5],
  "B:maj": ["B1 Eb2 F#3", 1, "B1 F#2 Eb3", 5], "G#:min": ["B1 Eb2 G#4", 2, "B1 G#2 Eb4", 3],
  "E:maj": ["E1 G#2 B3", 1, "E1 B2 G#3", 5], "C#:min": ["E1 G#2 C#4", 2, "E1 C#2 G#4", 3],
  "A:maj": ["A1 C#2 E3", 1, "A1 E2 C#3", 5], "F#:min": ["A1 C#2 F#4", 2, "A1 F#2 C#4", 3],
  "D:maj": ["D1 F#2 A3", 1, "D1 A2 F#3", 5], "B:min": ["B1 D2 F#3", 1, "B1 F#2 D4", 5],
  "G:maj": ["G1 B2 D3", 1, "G1 D2 B4", 5], "E:min": ["E1 G2 B3", 1, "E1 B2 G4", 5],
};

export const TRIADS: Record<string, string> = {
  "0,4,7": "maj",
  "0,3,7": "min",
  "0,3,6": "dim",
  "0,4,8": "aug",
};

export const SEVENTHS: Record<string, string> = {
  "0,4,7,10": "dom7",
  "0,4,7,11": "maj7",
  "0,3,7,10": "min7",
  "0,3,6,9": "dim7",
  "0,3,6,10": "hdim7",
  "0,3,7,11": "minmaj7",
};

export function chord_of(pcsInput: Iterable<number>): [number, string] | null {
  const pcs = Array.from(new Set(pcsInput)).sort((a, b) => a - b);
  for (const r of pcs) {
    const rel = pcs
      .map((p) => mod(p - r, 12))
      .sort((a, b) => a - b)
      .join(",");
    if (rel in TRIADS) {
      return [r, TRIADS[rel]!];
    }
    if (rel in SEVENTHS) {
      return [r, SEVENTHS[rel]!];
    }
  }
  return null;
}
export const chordOf = chord_of;

function _fmap(spec: string): Record<number, number> {
  const out: Record<number, number> = {};
  for (const tok of spec.trim().split(/\s+/)) {
    const pcName = tok.slice(0, -1);
    const finger = parseInt(tok.slice(-1), 10);
    out[PC[pcName]!] = finger;
  }
  return out;
}

function _cyclic_cost(order_pcs: readonly number[], fmap: Record<number, number>): number {
  let c = 0.0;
  const fs = order_pcs.map((p) => fmap[p]!);
  const ivs = order_pcs.map((p, k) => mod(order_pcs[(k + 1) % order_pcs.length]! - p, 12));
  const comfy: Record<string, number> = {
    "1,2": 4,
    "2,3": 3,
    "3,4": 2,
    "2,4": 5,
    "1,3": 7,
  };
  for (let k = 0; k < fs.length - 1; k++) {
    const a = fs[k]!;
    const b = fs[k + 1]!;
    const lim = comfy[`${a},${b}`] ?? 4;
    c += 0.6 * Math.max(0, ivs[k]! - lim);
  }
  const cross = ivs[ivs.length - 1]!;
  c += 0.5 * Math.max(0, cross - 3) + (cross > 5 ? 0.8 : 0.0);
  if (BLACK.has(order_pcs[0]!)) {
    c += 1.5;
  }
  if (fs.includes(4)) {
    c += 0.3;
  }
  return c;
}

export function arpeggio_map(
  pcs_order: Iterable<number>,
  _hand: string,
  vp: (p: number) => number,
): Record<number, number> | null {
  const pcs = Array.from(new Set(pcs_order)).sort((a, b) => a - b);
  if (pcs.length !== 3 && pcs.length !== 4) {
    return null;
  }
  const frame = [...pcs].sort((a, b) => vp(a + 60) - vp(b + 60));
  let best: [number, Record<number, number>] | null = null;
  for (let s = 0; s < frame.length; s++) {
    const rot = frame.slice(s).concat(frame.slice(0, s));
    const fingerPatterns = rot.length === 3 ? [[1, 2, 3], [1, 2, 4]] : [[1, 2, 3, 4]];
    for (const fingers of fingerPatterns) {
      const fmap: Record<number, number> = {};
      const order_frame: number[] = [];
      const order_fmap: Record<number, number> = {};
      for (let i = 0; i < rot.length; i++) {
        const p = rot[i]!;
        const f = fingers[i]!;
        fmap[p] = f;
        const fp = mod(vp(p + 60), 12);
        order_frame.push(fp);
        order_fmap[fp] = f;
      }
      const c = _cyclic_cost(order_frame, order_fmap);
      if (best === null || c < best[0]) {
        best = [c, fmap];
      }
    }
  }
  return best ? best[1] : null;
}
export const arpeggioMap = arpeggio_map;

// ----------------------------------------------------------------- double notes
export const CHROM3_R: ReadonlyArray<[number, number]> = [
  [1, 3], [2, 4], [1, 3], [2, 4], [3, 5], [1, 3],
  [2, 4], [1, 3], [2, 4], [1, 3], [2, 4], [3, 5],
];
export const CHROM3_L: ReadonlyArray<[number, number]> = [
  [4, 2], [3, 1], [5, 3], [4, 2], [3, 1], [4, 2],
  [3, 1], [4, 2], [3, 1], [5, 3], [4, 2], [3, 1],
];
export const THIRDS_4GROUP: Record<string, string> = {
  "C:maj": "C", "G:maj": "G", "D:maj": "D", "A:maj": "D",
  "E:maj": "A", "F:maj": "F", "Bb:maj": "C", "Eb:maj": "F",
  "Ab:maj": "Bb", "A:min": "A", "D:min": "G", "G:min": "C",
};
export const T4R: ReadonlyArray<[number, number]> = [[1, 2], [1, 3], [2, 4], [3, 5]];
export const T3R: ReadonlyArray<[number, number]> = [[1, 3], [2, 4], [3, 5]];
export const T4L: ReadonlyArray<[number, number]> = [[5, 3], [4, 2], [3, 1], [2, 1]];
export const T3L: ReadonlyArray<[number, number]> = [[5, 3], [4, 2], [3, 1]];

const _WI: Record<number, number> = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
const _BP: Record<number, number> = { 1: 0.93, 3: 2.07, 6: 3.92, 8: 5.0, 10: 6.08 };

function _kp(p: number): number {
  const o = Math.floor(p / 12);
  const pc = mod(p, 12);
  return o * 7 + (pc in _WI ? _WI[pc]! + 0.5 : _BP[pc]!);
}

export function octave_pair(lo: number, hi: number, hand: string): [number, number] {
  const four = (PREFS["octaves"] ?? "4black") === "4black";
  if (hand === RIGHT) {
    return [1, four && BLACK.has(mod(hi, 12)) ? 4 : 5];
  }
  return [four && BLACK.has(mod(lo, 12)) ? 4 : 5, 1];
}
export const octavePair = octave_pair;

// ----------------------------------------------------------------- detection
export let W_SCALE = 0.75;
export let W_CHROM = 3.0;
export let W_ARP = 5.0;
export let W_OCT = 4.0;
export let W_THIRDS = 3.0;
export let W_SIXTHS = 2.0;
export let W_REP = 1.5;
export let W_TRILL = 2.0;
export let W_SCALE_LONG = 3.0;
export const SCALE_LONG = 9;
export let W_REP_LEAP = 25.0;
export let W_REP_RUN = 6.0;
export const GAP = 0.6;

export const _BASE_W: Record<string, number> = {
  W_SCALE: 0.75,
  W_SCALE_LONG: 3.0,
  W_CHROM: 3.0,
  W_ARP: 5.0,
  W_OCT: 4.0,
  W_THIRDS: 3.0,
  W_SIXTHS: 2.0,
  W_REP: 1.5,
  W_REP_RUN: 6.0,
  W_REP_LEAP: 25.0,
  W_TRILL: 2.0,
};

export function getFigureWeight(name: string): number {
  switch (name) {
    case "W_SCALE": return W_SCALE;
    case "W_SCALE_LONG": return W_SCALE_LONG;
    case "W_CHROM": return W_CHROM;
    case "W_ARP": return W_ARP;
    case "W_OCT": return W_OCT;
    case "W_THIRDS": return W_THIRDS;
    case "W_SIXTHS": return W_SIXTHS;
    case "W_REP": return W_REP;
    case "W_REP_RUN": return W_REP_RUN;
    case "W_REP_LEAP": return W_REP_LEAP;
    case "W_TRILL": return W_TRILL;
    default: return _BASE_W[name] ?? 0;
  }
}

export function setFigureWeight(name: string, value: number): void {
  switch (name) {
    case "W_SCALE": W_SCALE = value; break;
    case "W_SCALE_LONG": W_SCALE_LONG = value; break;
    case "W_CHROM": W_CHROM = value; break;
    case "W_ARP": W_ARP = value; break;
    case "W_OCT": W_OCT = value; break;
    case "W_THIRDS": W_THIRDS = value; break;
    case "W_SIXTHS": W_SIXTHS = value; break;
    case "W_REP": W_REP = value; break;
    case "W_REP_RUN": W_REP_RUN = value; break;
    case "W_REP_LEAP": W_REP_LEAP = value; break;
    case "W_TRILL": W_TRILL = value; break;
  }
}

export function resetFigureWeights(): void {
  for (const [k, v] of Object.entries(_BASE_W)) {
    setFigureWeight(k, v);
  }
}

function _hist(notes: readonly NoteLike[], t0: number, t1: number): number[] {
  const h = new Array<number>(12).fill(0.0);
  for (const n of notes) {
    if (n.end > t0 && n.start < t1) {
      const pc = mod(n.pitch, 12);
      h[pc] = h[pc]! + Math.min(1.0, n.end - n.start) + 0.1;
    }
  }
  return h;
}

export const INNER_HELD_T = 0.05;
export const INNER_LOOKBACK_T = 4.0;

function _inner_note_down(groups: readonly NoteGroup[], gi: number, lo: number, hi: number): boolean {
  const t = groups[gi]![0];
  if (groups[gi]![1].some((n) => lo < n.pitch && n.pitch < hi)) {
    return true;
  }
  for (let gj = gi - 1; gj >= 0; gj--) {
    const [tj, ns] = groups[gj]!;
    if (t - tj > INNER_LOOKBACK_T) {
      break;
    }
    if (ns.some((n) => lo < n.pitch && n.pitch < hi && n.end > t + INNER_HELD_T)) {
      return true;
    }
  }
  return false;
}

export function detect<T extends NoteLike = NoteLike>(
  groups: readonly NoteGroup<T>[],
  hand: string,
  context: readonly NoteLike[] | null = null,
  vpitch: ((p: number) => number) | null = null,
): HybridNoteMap<T, FigureSuggestion> {
  const vp = vpitch ?? ((p: number) => p);
  const ctx: readonly NoteLike[] =
    context !== null ? context : groups.flatMap(([, ns]) => ns);
  const out = new HybridNoteMap<T, FigureSuggestion>();

  const put = (n: T, f: FingerSpec | null | undefined, w: number): void => {
    if (f instanceof Set || (typeof f === "number" && f >= 1 && f <= 5)) {
      const old = out.get(n);
      if (old === undefined || w > old[1]) {
        out.setNote(n, [f, w]);
      }
    }
  };

  // ---------------- single-note figures
  const singles: number[][] = [];
  let cur: number[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const [t, ns] = groups[gi]!;
    if (ns.length === 1 && (cur.length === 0 || t - groups[cur[cur.length - 1]!]![0] <= GAP)) {
      cur.push(gi);
    } else {
      if (cur.length > 1) {
        singles.push(cur);
      }
      cur = ns.length === 1 ? [gi] : [];
    }
  }
  if (cur.length > 1) {
    singles.push(cur);
  }

  for (const run of singles) {
    const notes = run.map((g) => groups[g]![1][0]!);
    const ps = notes.map((n) => n.pitch);
    const ts = notes.map((n) => n.start);
    const g0 = run[0]!;
    const carries_on =
      g0 > 0 &&
      ts[0]! - groups[g0 - 1]![0] <= GAP &&
      groups[g0 - 1]![1].some((n) => {
        const d = Math.abs(n.pitch - ps[0]!);
        return d >= 1 && d <= 2;
      });
    _repeated_and_trills(notes, ps, ts, hand, put);
    _stepwise(notes, ps, ts, hand, ctx, put, carries_on);
    _arpeggios(notes, ps, hand, vp, put);
    _broken_octaves(notes, ps, hand, put);
  }

  // ---------------- double notes
  const dyads: number[][] = [];
  cur = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const [t, ns] = groups[gi]!;
    if (ns.length === 2 && (cur.length === 0 || t - groups[cur[cur.length - 1]!]![0] <= GAP)) {
      cur.push(gi);
    } else {
      if (cur.length > 0) {
        dyads.push(cur);
      }
      cur = ns.length === 2 ? [gi] : [];
    }
  }
  if (cur.length > 0) {
    dyads.push(cur);
  }
  for (const run of dyads) {
    const pairs = run.map((g) => {
      const sorted = [...groups[g]![1]].sort((a, b) => a.pitch - b.pitch);
      return [sorted[0]!, sorted[1]!] as [T, T];
    });
    _double_notes(pairs, hand, ctx, put);
  }

  // octaves
  const octs: Array<[number, T[]]> = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const [, ns] = groups[gi]!;
    if (ns.length >= 2) {
      const s = [...ns].sort((a, b) => a.pitch - b.pitch);
      if (s[s.length - 1]!.pitch - s[0]!.pitch === 12) {
        octs.push([gi, s]);
      }
    }
  }
  const in_run = new Set<number>();
  for (let i = 0; i + 1 < octs.length; i++) {
    const [g1] = octs[i]!;
    const [g2] = octs[i + 1]!;
    if (g2 === g1 + 1 && groups[g2]![0] - groups[g1]![0] <= GAP) {
      in_run.add(g1);
      in_run.add(g2);
    }
  }
  for (const [gi, s] of octs) {
    const w = W_OCT * (s.length === 2 ? 1.0 : 0.6);
    const [a0, b0] = octave_pair(s[0]!.pitch, s[s.length - 1]!.pitch, hand);
    let a: FingerSpec = a0;
    let b: FingerSpec = b0;
    if (_inner_note_down(groups, gi, s[0]!.pitch, s[s.length - 1]!.pitch)) {
      [a, b] = hand === RIGHT ? [1, 5] : [5, 1];
    } else if (!in_run.has(gi) && (PREFS["octaves"] ?? "4black") === "4black") {
      if (hand === RIGHT) {
        b = new Set([4, 5]);
      } else {
        a = new Set([4, 5]);
      }
    }
    put(s[0]!, a, w);
    put(s[s.length - 1]!, b, w);
  }
  return out;
}

export function find_trills<T extends NoteLike = NoteLike>(notes: readonly T[]): T[][] {
  const onsets = [...notes].sort((a, b) => a.start - b.start);
  const starts = onsets.map((n) => n.start);

  function in_chord(n: T): boolean {
    let near = 0;
    let i = bisectLeft(starts, n.start - TRILL_CHORD_T);
    while (i < onsets.length && starts[i]! <= n.start + TRILL_CHORD_T) {
      const m = onsets[i]!;
      if (m !== n && Math.abs(m.pitch - n.pitch) <= TRILL_NEAR) {
        near += 1;
      }
      i += 1;
    }
    return near >= 2;
  }

  const by_pitch = new Map<number, T[]>();
  for (const n of notes) {
    if (!in_chord(n)) {
      let list = by_pitch.get(n.pitch);
      if (!list) {
        list = [];
        by_pitch.set(n.pitch, list);
      }
      list.push(n);
    }
  }

  function runs(seq: readonly T[]): T[][] {
    const out: T[][] = [];
    let run: T[] = [];
    for (let i = 0; i <= seq.length; i++) {
      const n = i < seq.length ? seq[i]! : null;
      if (
        n !== null &&
        run.length > 0 &&
        n.pitch !== run[run.length - 1]!.pitch &&
        n.start - run[run.length - 1]!.start > TRILL_CHORD_T &&
        n.start - run[run.length - 1]!.start <= TRILL_GAP_T
      ) {
        run.push(n);
        continue;
      }
      if (run.length >= TRILL_MIN_NOTES) {
        out.push(run);
      }
      run = n !== null ? [n] : [];
    }
    return out;
  }

  const found: T[][] = [];
  const pitches = Array.from(by_pitch.keys()).sort((a, b) => a - b);
  for (const p of pitches) {
    for (const q of [p + 1, p + 2]) {
      const qList = by_pitch.get(q);
      if (qList) {
        const combined = [...by_pitch.get(p)!, ...qList].sort(
          (a, b) => a.start - b.start || a.pitch - b.pitch,
        );
        found.push(...runs(combined));
      }
    }
  }
  found.sort((a, b) => b.length - a.length);
  const used = new Set<T>();
  const out: T[][] = [];
  for (const run of found) {
    const remaining = run.filter((n) => !used.has(n));
    for (const r of runs(remaining)) {
      for (const n of r) {
        used.add(n);
      }
      out.push(r);
    }
  }
  out.sort((a, b) => a[0]!.start - b[0]!.start);
  return out;
}
export const findTrills = find_trills;

function _repeated_and_trills<T extends NoteLike>(
  notes: readonly T[],
  ps: readonly number[],
  ts: readonly number[],
  hand: string,
  put: (n: T, f: FingerSpec | null | undefined, w: number) => void,
): void {
  const n = ps.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && ps[j + 1] === ps[i] && ts[j + 1]! - ts[j]! < 0.25) {
      j += 1;
    }
    if (j > i) {
      const L = j - i + 1;
      const style = PREFS["repeated"] ?? "321";
      let cyc: number[] | null;
      if (style === "321") {
        cyc = L % 4 === 0 && L % 3 !== 0 ? [4, 3, 2, 1] : [3, 2, 1];
        if (L === 2) {
          cyc = null;
          if (ts[j]! - ts[i]! < 0.2) {
            const nxt = j + 1 < n && ts[j + 1]! - ts[j]! < 0.3 ? ps[j + 1]! : null;
            const out_ = nxt === null ? null : hand === RIGHT ? nxt - ps[j]! : ps[j]! - nxt;
            const leap = out_ !== null && out_ >= 5;
            cyc = leap || ts[j]! - ts[i]! < 0.15 ? [2, 1] : null;
            if (leap) {
              put(notes[i]!, 2, W_REP_LEAP);
              put(notes[j]!, 1, W_REP_LEAP);
            }
          }
        }
      } else {
        cyc = Array.from(style, (c) => parseInt(c, 10));
      }
      if (cyc) {
        let w = L >= 3 ? W_REP_RUN : W_REP;
        if (style !== "321") {
          w *= 1.5;
        }
        for (let k = 0; k < L; k++) {
          put(notes[i + k]!, cyc[k % cyc.length]!, w);
        }
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }

  // trills
  i = 0;
  while (i + 3 < n) {
    const a = ps[i]!;
    const b = ps[i + 1]!;
    const d = Math.abs(a - b);
    if (d >= 1 && d <= 2 && ts[i + 1]! - ts[i]! < TRILL_GAP_T) {
      let j = i + 1;
      while (j + 1 < n && ps[j + 1] === ps[j - 1] && ts[j + 1]! - ts[j]! < TRILL_GAP_T) {
        j += 1;
      }
      if (j - i + 1 >= TRILL_MIN_NOTES) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const style = PREFS["trill"] ?? "auto";
        if (style === "auto") {
          let low_f: ReadonlySet<number> = new Set([1, 2, 3]);
          let high_f: ReadonlySet<number> = new Set([2, 3, 4]);
          if (hand === LEFT) {
            [low_f, high_f] = [high_f, low_f];
          }
          for (let k = i; k <= j; k++) {
            put(notes[k]!, ps[k] === lo ? low_f : high_f, W_TRILL);
          }
        } else {
          const seq = Array.from(style, (c) => parseInt(c, 10));
          const ev = seq.filter((_, idx) => idx % 2 === 0);
          const od = seq.filter((_, idx) => idx % 2 === 1);
          const [lower, upper] = Math.min(...ev) < Math.min(...od) ? [ev, od] : [od, ev];
          const thumb_side = hand === RIGHT ? lo : hi;
          let kl = 0;
          let ku = 0;
          for (let k = i; k <= j; k++) {
            if (ps[k] === thumb_side) {
              put(notes[k]!, lower[kl % lower.length]!, W_TRILL * 1.5);
              kl += 1;
            } else {
              put(notes[k]!, upper[ku % upper.length]!, W_TRILL * 1.5);
              ku += 1;
            }
          }
        }
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
}

function _is_step(ps: readonly number[], k: number): boolean {
  const d = Math.abs(ps[k + 1]! - ps[k]!);
  if (d >= 1 && d <= 2) {
    return true;
  }
  if (d !== 3) {
    return false;
  }
  const up = ps[k + 1]! > ps[k]!;
  function step(j: number): boolean {
    if (j < 0 || j >= ps.length - 1) return false;
    const dj = Math.abs(ps[j + 1]! - ps[j]!);
    return dj >= 1 && dj <= 2 && (ps[j + 1]! > ps[j]!) === up;
  }
  const before = step(k - 1);
  const after = step(k + 1);
  return (before || k === 0) && (after || k === ps.length - 2) && (before || after);
}

function _stepwise<T extends NoteLike>(
  notes: readonly T[],
  ps: readonly number[],
  ts: readonly number[],
  hand: string,
  context: readonly NoteLike[],
  put: (n: T, f: FingerSpec | null | undefined, w: number) => void,
  carries_on = false,
): void {
  const n = ps.length;
  let i = 0;
  while (i < n - 1) {
    if (!_is_step(ps, i)) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j + 1 < n && _is_step(ps, j)) {
      j += 1;
    }
    const seg: number[] = [];
    for (let q = i; q <= j; q++) {
      seg.push(q);
    }
    i = j;
    let best = 1;
    let cur = 1;
    for (let k = 1; k < seg.length - 1; k++) {
      const same = (ps[seg[k + 1]!]! - ps[seg[k]!]! > 0) === (ps[seg[k]!]! - ps[seg[k - 1]!]! > 0);
      cur = same ? cur + 1 : 1;
      best = Math.max(best, cur);
    }
    best += 1;
    const sp = seg.map((k) => ps[k]!);
    const chrom = new Array<boolean>(seg.length).fill(false);
    let k = 0;
    while (k < seg.length - 1) {
      if (Math.abs(sp[k + 1]! - sp[k]!) === 1) {
        let m = k;
        while (m + 1 < seg.length && sp[m + 1]! - sp[m]! === sp[k + 1]! - sp[k]!) {
          m += 1;
        }
        if (m - k >= 4) {
          for (let q = k; q <= m; q++) {
            chrom[q] = true;
          }
        }
        k = Math.max(m, k + 1);
      } else {
        k += 1;
      }
    }
    if (chrom.some(Boolean)) {
      const cps: number[] = [];
      for (let q = 0; q < seg.length; q++) {
        if (chrom[q]) cps.push(sp[q]!);
      }
      const cf = chromatic_fingering(cps, hand);
      let cfIdx = 0;
      for (let q = 0; q < seg.length; q++) {
        if (chrom[q]) {
          put(notes[seg[q]!]!, cf[cfIdx++], W_CHROM);
        }
      }
    }
    if (best < 6) {
      continue;
    }
    const blocks: number[][] = [];
    let b: number[] = [];
    for (let q = 0; q < seg.length; q++) {
      if (!chrom[q]) {
        b.push(q);
      } else if (b.length > 0) {
        blocks.push(b);
        b = [];
      }
    }
    if (b.length > 0) {
      blocks.push(b);
    }
    for (const blk of blocks) {
      if (blk.length < 5) {
        continue;
      }
      const bp = blk.map((q) => sp[q]!);
      const pcs = new Set(bp.map((p) => mod(p, 12)));
      const t0 = ts[seg[blk[0]!]!]!;
      const t1 = ts[seg[blk[blk.length - 1]!]!]!;
      const hist = _hist(context, t0 - 2.0, t1 + 2.0);
      const found = find_key(pcs, hist, mod(bp[0]!, 12), mod(bp[bp.length - 1]!, 12));
      if (!found || !(keyId(found[0]) in THUMBS)) {
        continue;
      }
      const [key, mel] = found;
      const [tu, td] = thumb_sets(key, hand, mel);
      let opening: boolean;
      if (seg[blk[0]!] === 0) {
        opening = !carries_on;
      } else {
        opening = blk[0] === 0 || Math.abs(sp[blk[0]!]! - ps[seg[blk[0]!]! - 1]!) > 2;
      }
      const fs = scale_fingering(bp, tu, hand, td, key_scale(key, mel), opening);
      const nxt = seg[blk[blk.length - 1]!]! + 1;
      const ends_open = nxt >= n || Math.abs(ps[nxt]! - bp[bp.length - 1]!) > 2;
      if (
        ends_open &&
        fs.length > 1 &&
        fs[fs.length - 1] === 1 &&
        (fs[fs.length - 2] === 3 || fs[fs.length - 2] === 4)
      ) {
        if (
          (hand === RIGHT && bp[bp.length - 1]! > bp[bp.length - 2]!) ||
          (hand === LEFT && bp[bp.length - 1]! < bp[bp.length - 2]!)
        ) {
          fs[fs.length - 1] = fs[fs.length - 2]! + 1;
        }
      }
      const w = best >= SCALE_LONG ? W_SCALE_LONG : W_SCALE;
      for (let idx = 0; idx < blk.length; idx++) {
        put(notes[seg[blk[idx]!]!]!, fs[idx], w);
      }
    }
  }
}

function _arpeggios<T extends NoteLike>(
  notes: readonly T[],
  ps: readonly number[],
  hand: string,
  vp: (p: number) => number,
  put: (n: T, f: FingerSpec | null | undefined, w: number) => void,
): void {
  const n = ps.length;
  let i = 0;
  while (i < n - 2) {
    let j = i;
    while (j + 1 < n) {
      const d = Math.abs(ps[j + 1]! - ps[j]!);
      if (d < 1 || d > 5) break;
      const slicePcs = new Set<number>();
      for (let k = i; k <= j + 1; k++) {
        slicePcs.add(mod(ps[k]!, 12));
      }
      if (slicePcs.size > 4) break;
      if (!(d >= 3 || slicePcs.size === 4)) break;
      j += 1;
    }
    if (j - i >= 3) {
      const seg: number[] = [];
      for (let k = i; k <= j; k++) seg.push(k);
      const sp = seg.map((k) => ps[k]!);
      const pcs = new Set(sp.map((p) => mod(p, 12)));
      const ch = pcs.size >= 3 && pcs.size <= 4 ? chord_of(pcs) : null;
      const span = Math.max(...sp) - Math.min(...sp);
      if (ch && span > 13) {
        let [root, kind] = ch;
        if ((kind === "dim7" || kind === "aug" || kind === "dim") && pcs.has(mod(sp[0]!, 12))) {
          root = mod(sp[0]!, 12);
        }
        const fs = _arp_fingers(sp, hand, root, kind, pcs, vp);
        if (fs) {
          for (let idx = 0; idx < seg.length; idx++) {
            put(notes[seg[idx]!]!, fs[idx], W_ARP);
          }
        }
      }
      i = j;
    } else {
      i += 1;
    }
  }
}

function _arp_fingers(
  sp: readonly number[],
  hand: string,
  root: number,
  kind: string,
  pcs: ReadonlySet<number>,
  vp: (p: number) => number,
): Array<number | undefined> | null {
  const n = sp.length;
  let fmap: Record<number, number> | null = null;
  let start: number | null = null;
  if (kind === "maj" || kind === "min") {
    const name = (kind === "maj" ? MAJ_NAME : MIN_NAME)[root]!;
    const alt: Record<string, string> = {
      Db: "C#",
      "C#": "Db",
      "F#": "Gb",
      Eb: "D#",
      Ab: "G#",
      "G#": "Ab",
      Bb: "A#",
    };
    const key1 = `${name}:${kind}`;
    const key2 = `${alt[name] ?? name}:${kind}`;
    const key = key1 in ARP ? key1 : key2;
    if (key in ARP && mod(sp[0]!, 12) === root) {
      const [rh, rs, lh, ls] = ARP[key]!;
      [fmap, start] = hand === RIGHT ? [_fmap(rh), rs] : [_fmap(lh), ls];
    }
  }
  if (fmap === null && pcs.size === 4 && mod(sp[0]!, 12) === root) {
    const order = Array.from(pcs).sort((a, b) => mod(a - root, 12) - mod(b - root, 12));
    const m: Record<number, number> =
      hand === RIGHT ? { 0: 1, 1: 2, 2: 3, 3: 4 } : { 0: 1, 1: 4, 2: 3, 3: 2 };
    fmap = {};
    for (let k = 0; k < order.length; k++) {
      fmap[order[k]!] = m[k]!;
    }
    start = hand === RIGHT ? 1 : 5;
  }
  if (fmap === null) {
    fmap = arpeggio_map(Array.from(pcs).sort((a, b) => a - b), hand, vp);
    if (fmap === null) {
      return null;
    }
  }
  const f: Array<number | undefined> = sp.map((p) => fmap![mod(p, 12)]);
  for (let i = 0; i < n; i++) {
    const peak =
      (i > 0 && i < n - 1 && sp[i - 1]! < sp[i]! && sp[i]! > sp[i + 1]!) ||
      (i === n - 1 && n > 1 && sp[i]! > sp[i - 1]!);
    const low =
      (i > 0 && i < n - 1 && sp[i - 1]! > sp[i]! && sp[i]! < sp[i + 1]!) ||
      (i === n - 1 && n > 1 && sp[i]! < sp[i - 1]!);
    if (hand === RIGHT && peak && f[i] === 1) {
      f[i] = 5;
    }
    if (hand === LEFT && low && f[i] === 1) {
      f[i] = 5;
    }
  }
  const rising = n > 1 && sp[1]! > sp[0]!;
  if (start !== null && rising) {
    f[0] = start;
  } else if (n > 1 && f[0] === 1 && ((hand === RIGHT && !rising) || (hand === LEFT && rising))) {
    f[0] = 5;
  }
  return f;
}

function _broken_octaves<T extends NoteLike>(
  notes: readonly T[],
  ps: readonly number[],
  hand: string,
  put: (n: T, f: FingerSpec | null | undefined, w: number) => void,
): void {
  const n = ps.length;
  function repeated(k: number): boolean {
    return (k - 1 >= 0 && ps[k - 1] === ps[k]) || (k + 1 < n && ps[k + 1] === ps[k]);
  }
  for (let i = 0; i < n; i++) {
    const p = ps[i]!;
    if (repeated(i)) {
      continue;
    }
    const nb = [i - 1, i + 1].filter((k) => k >= 0 && k < n);
    let role: "low" | "high" | null = null;
    if (nb.some((k) => ps[k]! - p === 12)) {
      role = "low";
    } else if (nb.some((k) => p - ps[k]! === 12)) {
      role = "high";
    } else {
      continue;
    }
    const black = BLACK.has(mod(p, 12));
    const partner_rep = nb.some((k) => Math.abs(ps[k]! - p) === 12 && repeated(k));
    const outer = partner_rep || !black ? 5 : 4;
    const f = hand === RIGHT ? (role === "low" ? 1 : outer) : role === "low" ? outer : 1;
    put(notes[i]!, f, W_OCT * 0.8);
  }
}

function _double_notes<T extends NoteLike>(
  pairs: ReadonlyArray<[T, T]>,
  hand: string,
  context: readonly NoteLike[],
  put: (n: T, f: FingerSpec | null | undefined, w: number) => void,
): void {
  const n = pairs.length;
  const ivs = pairs.map(([a, b]) => b.pitch - a.pitch);
  const lows = pairs.map(([a]) => a.pitch);

  // --- chromatic thirds
  let i = 0;
  while (i < n) {
    if (ivs[i] === 3 || ivs[i] === 4) {
      let j = i;
      while (
        j + 1 < n &&
        (ivs[j + 1] === 3 || ivs[j + 1] === 4) &&
        Math.abs(lows[j + 1]! - lows[j]!) === 1 &&
        (j === i || lows[j + 1]! - lows[j]! === lows[j]! - lows[j - 1]!)
      ) {
        j += 1;
      }
      if (j - i >= 3) {
        const tab = hand === RIGHT ? CHROM3_R : CHROM3_L;
        for (let k = i; k <= j; k++) {
          const [a, b] = pairs[k]!;
          const [fl, fh] = tab[mod(a.pitch, 12)]!;
          put(a, fl, W_THIRDS);
          put(b, fh, W_THIRDS);
        }
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }

  // --- scales in thirds
  i = 0;
  while (i < n) {
    if (ivs[i] === 3 || ivs[i] === 4) {
      let j = i;
      while (
        j + 1 < n &&
        (ivs[j + 1] === 3 || ivs[j + 1] === 4) &&
        Math.abs(lows[j + 1]! - lows[j]!) >= 1 &&
        Math.abs(lows[j + 1]! - lows[j]!) <= 2 &&
        (j === i || (lows[j + 1]! > lows[j]!) === (lows[j]! > lows[j - 1]!))
      ) {
        j += 1;
      }
      if (j - i >= 3) {
        const pcs = new Set<number>();
        for (let k = i; k <= j; k++) {
          pcs.add(mod(pairs[k]![0].pitch, 12));
          pcs.add(mod(pairs[k]![1].pitch, 12));
        }
        const hist = _hist(context, pairs[i]![0].start - 2, pairs[j]![0].start + 2);
        const found = find_key(pcs, hist);
        if (found && (found[0][1] === "maj" || found[0][1] === "min")) {
          const key = found[0];
          const [up] = key_scale(key, false);
          const tonic = PC[key[0]]!;
          const scale = [...up].sort((a, b) => mod(a - tonic, 12) - mod(b - tonic, 12));
          const kid = keyId(key);
          const g4 = kid in THIRDS_4GROUP ? scale.indexOf(PC[THIRDS_4GROUP[kid]!]!) : 0;
          for (let q = i; q <= j; q++) {
            const [a, b] = pairs[q]!;
            const pc = mod(a.pitch, 12);
            const idx = scale.indexOf(pc);
            if (idx < 0) continue;
            const kk = mod(idx - g4, 7);
            const [fl, fh] =
              kk < 4
                ? (hand === RIGHT ? T4R : T4L)[kk]!
                : (hand === RIGHT ? T3R : T3L)[kk - 4]!;
            put(a, fl, W_THIRDS * 1.7);
            put(b, fh, W_THIRDS * 1.7);
          }
        }
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }

  // --- trills in thirds
  i = 0;
  while (i + 3 < n) {
    const d01 = Math.abs(lows[i]! - lows[i + 1]!);
    if ((ivs[i] === 3 || ivs[i] === 4) && (ivs[i + 1] === 3 || ivs[i + 1] === 4) && d01 >= 1 && d01 <= 2) {
      let j = i + 1;
      while (j + 1 < n && lows[j + 1] === lows[j - 1] && (ivs[j + 1] === 3 || ivs[j + 1] === 4)) {
        j += 1;
      }
      if (j - i + 1 >= 4) {
        const lo = Math.min(lows[i]!, lows[i + 1]!);
        for (let k = i; k <= j; k++) {
          const [a, b] = pairs[k]!;
          const lower = a.pitch === lo;
          const [fl, fh] = hand === RIGHT ? (lower ? [1, 3] : [2, 4]) : lower ? [4, 2] : [3, 1];
          put(a, fl, W_THIRDS);
          put(b, fh, W_THIRDS);
        }
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }

  // --- thirds inside one hand position
  const pos: ReadonlyArray<[number, number]> =
    hand === RIGHT
      ? [[1, 3], [2, 4], [3, 5]]
      : [[5, 3], [4, 2], [3, 1]];
  i = 0;
  while (i < n) {
    if (ivs[i] !== 3 && ivs[i] !== 4) {
      i += 1;
      continue;
    }
    let j = i;
    let lo_k = _kp(lows[i]!);
    let hi_k = lo_k;
    while (j + 1 < n && (ivs[j + 1] === 3 || ivs[j + 1] === 4)) {
      const k = _kp(lows[j + 1]!);
      if (Math.max(hi_k, k) - Math.min(lo_k, k) > 2.2) {
        break;
      }
      lo_k = Math.min(lo_k, k);
      hi_k = Math.max(hi_k, k);
      j += 1;
    }
    if (j - i >= 2 && hi_k - lo_k >= 0.9) {
      for (let q = i; q <= j; q++) {
        const [a, b] = pairs[q]!;
        const r = pyRound(_kp(a.pitch) - lo_k);
        if (r >= 0 && r <= 2) {
          put(a, pos[r]![0], W_THIRDS * 0.7);
          put(b, pos[r]![1], W_THIRDS * 0.7);
        }
      }
    }
    i = j + 1;
  }

  // --- trills in sixths / fourths
  const isSixthOrFourth = (v: number): boolean => v === 5 || v === 6 || v === 8 || v === 9;
  i = 0;
  while (i + 3 < n) {
    if (
      isSixthOrFourth(ivs[i]!) &&
      isSixthOrFourth(ivs[i + 1]!) &&
      lows[i] !== lows[i + 1] &&
      Math.abs(lows[i]! - lows[i + 1]!) <= 2
    ) {
      let j = i + 1;
      while (j + 1 < n && lows[j + 1] === lows[j - 1] && ivs[j + 1] === ivs[j - 1]) {
        j += 1;
      }
      if (j - i + 1 >= 4) {
        const lo = Math.min(lows[i]!, lows[i + 1]!);
        for (let k = i; k <= j; k++) {
          const [a, b] = pairs[k]!;
          const lower = a.pitch === lo;
          const [fl, fh] = hand === RIGHT ? (lower ? [1, 4] : [2, 5]) : lower ? [5, 2] : [4, 1];
          put(a, fl, W_SIXTHS);
          put(b, fh, W_SIXTHS);
        }
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }

  // --- other sixths: 1-5, 4 on a black key (RH); LH 5-1, 4 on black
  for (const [a, b] of pairs) {
    const diff = b.pitch - a.pitch;
    if (diff === 8 || diff === 9) {
      const [fl, fh] =
        hand === RIGHT
          ? [1, BLACK.has(mod(b.pitch, 12)) ? 4 : 5]
          : [BLACK.has(mod(a.pitch, 12)) ? 4 : 5, 1];
      put(a, fl, W_SIXTHS);
      put(b, fh, W_SIXTHS);
    }
  }
}
