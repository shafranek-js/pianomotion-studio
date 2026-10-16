/**
 * Numeric keyboard layout for PianoMotion.
 *
 * This module contains only the rectangles and positions used by the IK and
 * chord-fit calculations. Its integer rounding provides clean geometric coordinates.
 */

import { pyMod, pyRound } from "./pythonCompat.ts";

export const LOWEST_PIANO_KEY = 21;
export const HIGHEST_PIANO_KEY = 108;
export const KEY_LEN_WW = 5.6;
export const WHITE_WIDTH = 1.0;
export const BLACK_WIDTH = 0.6;
export const BLACK_LENGTH = 0.63;

export const _BLACK_PITCH_CLASSES = new Set<number>([1, 3, 6, 8, 10]);
export const BLACK_PITCH_CLASSES = _BLACK_PITCH_CLASSES;

export const _BLACK_OFFSETS: Readonly<Record<number, number>> = {
  1: -0.12,
  3: 0.12,
  6: -0.14,
  8: 0.0,
  10: 0.14,
};
export const BLACK_OFFSETS = _BLACK_OFFSETS;

export const _EQUAL_A0_MAX = 2.0;

export function isBlackKey(pitch: number): boolean {
  return _BLACK_PITCH_CLASSES.has(pyMod(pitch, 12));
}

export const is_black_key = isBlackKey;

export const WHITE_KEYS: readonly number[] = Object.freeze(
  Array.from(
    { length: HIGHEST_PIANO_KEY - LOWEST_PIANO_KEY + 1 },
    (_, idx) => LOWEST_PIANO_KEY + idx,
  ).filter((p) => !isBlackKey(p)),
);

function toInt(v: number): number {
  const t = Math.trunc(Number(v));
  return t === 0 ? 0 : t;
}

export type RectLike = NumericRect | readonly [number, number, number, number];

export class NumericRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;

  constructor(
    x: number | RectLike = 0,
    y = 0,
    w = 0,
    h = 0,
  ) {
    if (x instanceof NumericRect) {
      this.x = x.x;
      this.y = x.y;
      this.w = x.w;
      this.h = x.h;
    } else if (Array.isArray(x)) {
      this.x = toInt(x[0]);
      this.y = toInt(x[1]);
      this.w = toInt(x[2]);
      this.h = toInt(x[3]);
    } else {
      this.x = toInt(x as number);
      this.y = toInt(y);
      this.w = toInt(w);
      this.h = toInt(h);
    }
    Object.freeze(this);
  }

  get left(): number {
    return this.x;
  }

  get right(): number {
    return this.x + this.w;
  }

  get top(): number {
    return this.y;
  }

  get bottom(): number {
    return this.y + this.h;
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  get centerx(): number {
    return this.x + Math.floor(this.w / 2);
  }

  get centery(): number {
    return this.y + Math.floor(this.h / 2);
  }

  toTuple(): [number, number, number, number] {
    return [this.x, this.y, this.w, this.h];
  }

  *[Symbol.iterator](): IterableIterator<number> {
    yield this.x;
    yield this.y;
    yield this.w;
    yield this.h;
  }
}

export function _equal_head(pitch: number): [number, number] {
  const i = pyMod(pitch, 12);
  if (i <= 4) {
    const k = Math.floor(i / 2);
    return [(k * 5) / 3, ((k + 1) * 5) / 3];
  }
  const k = Math.floor((i - 5) / 2);
  return [5 + (k * 7) / 4, 5 + ((k + 1) * 7) / 4];
}

export const equalHead = _equal_head;

export class KeyboardGeometry {
  low: number;
  high: number;
  style: string;
  rect!: NumericRect;
  tails: Record<number, NumericRect> = {};
  lane_shade: Array<[number, number]> = [];
  white_w = 0;
  black_w = 0;
  black_h = 0;
  key_rects: Record<number, NumericRect> = {};
  lanes: Record<number, [number, number]> = {};
  lane_lines: number[] = [];
  fronts: Record<number, [number, number]> = {};
  gap = 0;
  pitch = 0;
  keys_x: [number, number] = [0, 0];

  constructor(
    rect: RectLike,
    lowOrStyle: number | string = LOWEST_PIANO_KEY,
    high: number = HIGHEST_PIANO_KEY,
    style = "realistic",
  ) {
    if (typeof lowOrStyle === "string") {
      this.low = LOWEST_PIANO_KEY;
      this.high = HIGHEST_PIANO_KEY;
      this.style = lowOrStyle;
    } else {
      this.low = lowOrStyle;
      this.high = high;
      this.style = style;
    }
    this.layout(rect);
  }

  get whiteW(): number {
    return this.white_w;
  }

  get blackW(): number {
    return this.black_w;
  }

  get blackH(): number {
    return this.black_h;
  }

  get keyRects(): Record<number, NumericRect> {
    return this.key_rects;
  }

  get laneLines(): number[] {
    return this.lane_lines;
  }

  get laneShade(): Array<[number, number]> {
    return this.lane_shade;
  }

  get keysX(): [number, number] {
    return this.keys_x;
  }

  layout(rect: RectLike): void {
    this.rect = new NumericRect(rect);
    this.tails = {};
    this.lane_shade = [];
    if (
      this.style === "equal" &&
      this.low === LOWEST_PIANO_KEY &&
      this.high === HIGHEST_PIANO_KEY
    ) {
      this._layout_equal();
      return;
    }
    this.style = "realistic";
    const whites: number[] = [];
    for (let p = this.low; p <= this.high; p += 1) {
      if (!isBlackKey(p)) {
        whites.push(p);
      }
    }
    this.white_w = this.rect.w / whites.length;
    this.black_w = this.white_w * BLACK_WIDTH;
    this.black_h = toInt(this.rect.h * BLACK_LENGTH);
    this.key_rects = {};
    this.lanes = {};
    this.lane_lines = [];
    let whiteIndex = 0;
    for (let p = this.low; p <= this.high; p += 1) {
      if (isBlackKey(p)) {
        const boundary = this.rect.x + whiteIndex * this.white_w;
        const offset = _BLACK_OFFSETS[pyMod(p, 12)] ?? 0;
        const x = boundary - this.black_w / 2 + offset * this.black_w;
        const r = new NumericRect(
          pyRound(x),
          this.rect.y,
          pyRound(this.black_w),
          this.black_h,
        );
        this.key_rects[p] = r;
        this.lanes[p] = [r.x, r.w];
      } else {
        const x0 = pyRound(this.rect.x + whiteIndex * this.white_w);
        const x1 = pyRound(this.rect.x + (whiteIndex + 1) * this.white_w);
        this.key_rects[p] = new NumericRect(
          x0,
          this.rect.y,
          x1 - x0,
          this.rect.h,
        );
        const pad = Math.max(1, pyRound(this.white_w * 0.08));
        this.lanes[p] = [x0 + pad, x1 - x0 - 2 * pad];
        const pc = pyMod(p, 12);
        if (pc === 0 || pc === 5) {
          this.lane_lines.push(x0);
        }
        whiteIndex += 1;
      }
    }
  }

  _layout_equal(): void {
    const rect = this.rect;
    const whites: number[] = [];
    for (let p = this.low; p <= this.high; p += 1) {
      if (!isBlackKey(p)) {
        whites.push(p);
      }
    }
    this.white_w = rect.w / whites.length;
    const n = this.high - this.low + 1;
    const P = Math.max(2, Math.floor(rect.w / n));
    const g = (this.gap = Math.max(1, pyRound(P / 15)));
    const L = P - g;
    let back = rect.w - (n - 1) * P;
    const margin = Math.max(0, back - toInt(_EQUAL_A0_MAX * P));
    back -= margin;
    const left = rect.x + Math.floor(margin / 2);
    const x0 = left + back - P;
    this.pitch = P;
    this.keys_x = [left, x0 + n * P];
    this.black_w = L;
    this.black_h = toInt(rect.h * BLACK_LENGTH);
    this.key_rects = {};
    this.lanes = {};
    this.lane_lines = [];
    this.fronts = {};
    const lane = (p: number): number => x0 + (p - this.low) * P;
    const gl = Math.floor(g / 2);
    const heads: Record<number, [number, number]> = {};
    const groups: ReadonlyArray<readonly [number, readonly number[], number]> = [
      [0, [0, 2, 4], 5],
      [5, [5, 7, 9, 11], 7],
    ];
    for (const [first, keys, lanesN] of groups) {
      const k = keys.length;
      const h = (lanesN * P - k * g) / k;
      keys.forEach((pc, i) => {
        heads[pc] = [first * P + gl + i * (h + g), h];
      });
    }
    for (let p = this.low; p <= this.high; p += 1) {
      const a = lane(p);
      const laneRect = new NumericRect(a + gl, rect.y, L, this.black_h);
      if (isBlackKey(p)) {
        this.key_rects[p] = laneRect;
        this.lanes[p] = [laneRect.x, L];
        continue;
      }
      const pc = pyMod(p, 12);
      const head = heads[pc]!;
      let hx = lane(p - pc) + head[0];
      let h = head[1];
      let tail = new NumericRect(laneRect.x, rect.y, L, this.black_h + g);
      if (p === this.high) {
        hx = tail.x;
        h = L;
      }
      if (p === this.low) {
        tail = new NumericRect(left, tail.y, tail.w + tail.x - left, tail.h);
        h += hx - left;
        hx = left;
      }
      this.fronts[p] = [hx, hx + h];
      const rx0 = pyRound(hx);
      const rx1 = pyRound(hx + h);
      this.key_rects[p] = new NumericRect(rx0, rect.y, rx1 - rx0, rect.h);
      this.tails[p] = tail;
      this.lanes[p] = [laneRect.x, L];
      this.lane_shade.push([laneRect.x, L]);
    }
  }
}
