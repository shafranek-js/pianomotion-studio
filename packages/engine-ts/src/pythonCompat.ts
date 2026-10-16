/**
 * Python 3 standard-library compatibility primitives for 1-to-1 numerical parity.
 */

const _floatBuf = new ArrayBuffer(8);
const _floatView = new DataView(_floatBuf);

/**
 * Python 3 round-half-to-even (banker's rounding) on exact IEEE-754 binary64 values,
 * normalizing -0 to 0.
 */
export function pyRound(value: number, digits = 0): number {
  if (!Number.isFinite(value) || value === 0) {
    return 0;
  }
  const d = Math.trunc(digits);
  if (d === 0) {
    const fl = Math.floor(value);
    const diff = value - fl;
    let r: number;
    if (diff < 0.5) {
      r = fl;
    } else if (diff > 0.5) {
      r = fl + 1;
    } else {
      r = Math.abs(fl % 2) === 0 ? fl : fl + 1;
    }
    return r === 0 ? 0 : r;
  }

  _floatView.setFloat64(0, value);
  const bits = _floatView.getBigUint64(0);
  const sign = (bits >> 63n) !== 0n;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const fracBits = bits & 0xfffffffffffffn;
  const m = expBits === 0 ? fracBits : fracBits | (1n << 52n);
  let e = expBits === 0 ? -1074 : expBits - 1075;

  let num = m;
  let denExp = 0;
  let den5 = 0;
  if (d >= 0) {
    num *= 5n ** BigInt(d);
    e += d;
  } else {
    den5 = -d;
    e += d;
  }
  if (e >= 0) {
    num <<= BigInt(e);
  } else {
    denExp = -e;
  }

  let quot: bigint;
  if (den5 === 0 && denExp === 0) {
    quot = num;
  } else if (den5 === 0) {
    const k = BigInt(denExp);
    quot = num >> k;
    const half = 1n << (k - 1n);
    const rem = num & ((1n << k) - 1n);
    if (rem > half || (rem === half && (quot & 1n) === 1n)) {
      quot += 1n;
    }
  } else {
    const den = (5n ** BigInt(den5)) << BigInt(denExp);
    quot = num / den;
    const rem = num % den;
    const cmp = rem * 2n;
    if (cmp > den || (cmp === den && (quot & 1n) === 1n)) {
      quot += 1n;
    }
  }

  if (quot === 0n) {
    return 0;
  }
  const res = Number(`${quot.toString()}e${-d}`);
  if (res === 0) {
    return 0;
  }
  return sign ? -res : res;
}

/**
 * Matches `_rounded(value, digits=8)` in `api.py` and `identity.py`.
 */
export function rounded(value: number, digits = 8): number {
  const result = pyRound(Number(value), digits);
  return result === 0 ? 0 : result;
}

export const _rounded = rounded;

/**
 * Matches `itertools.combinations(items, k)` in lexicographical index order.
 */
export function combinations<T>(items: readonly T[], k: number): T[][] {
  const n = items.length;
  if (k < 0 || k > n) {
    return [];
  }
  if (k === 0) {
    return [[]];
  }
  const indices = Array.from({ length: k }, (_, idx) => idx);
  const result: T[][] = [indices.map((idx) => items[idx]!)];
  while (true) {
    let i = k - 1;
    while (i >= 0 && indices[i] === i + n - k) {
      i -= 1;
    }
    if (i < 0) {
      break;
    }
    indices[i] = indices[i]! + 1;
    for (let j = i + 1; j < k; j += 1) {
      indices[j] = indices[j - 1]! + 1;
    }
    result.push(indices.map((idx) => items[idx]!));
  }
  return result;
}

/**
 * Matches `itertools.product(items, repeat=repeat)` in lexicographical order.
 */
export function product<T>(items: readonly T[], repeat = 1): T[][] {
  if (repeat < 0) {
    return [];
  }
  if (repeat === 0) {
    return [[]];
  }
  const n = items.length;
  if (n === 0) {
    return [];
  }
  const indices = new Array<number>(repeat).fill(0);
  const result: T[][] = [];
  while (true) {
    result.push(indices.map((idx) => items[idx]!));
    let pos = repeat - 1;
    while (pos >= 0) {
      const next = indices[pos]! + 1;
      if (next < n) {
        indices[pos] = next;
        break;
      }
      indices[pos] = 0;
      pos -= 1;
    }
    if (pos < 0) {
      break;
    }
  }
  return result;
}

/**
 * Matches Python `bisect.bisect_left(a, x, lo, hi)`.
 */
export function bisectLeft(
  a: readonly number[],
  x: number,
  lo = 0,
  hi: number = a.length,
): number {
  let left = Math.max(0, lo);
  let right = Math.min(a.length, hi);
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (a[mid]! < x) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
}

/**
 * Matches Python `bisect.bisect_right(a, x, lo, hi)`.
 */
export function bisectRight(
  a: readonly number[],
  x: number,
  lo = 0,
  hi: number = a.length,
): number {
  let left = Math.max(0, lo);
  let right = Math.min(a.length, hi);
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (x < a[mid]!) {
      right = mid;
    } else {
      left = mid + 1;
    }
  }
  return left;
}

export const bisect_left = bisectLeft;
export const bisect_right = bisectRight;

/**
 * Python floor modulo (`a % b` where sign matches `b`).
 */
export function pyMod(a: number, b: number): number {
  const r = ((a % b) + b) % b;
  return r === 0 ? 0 : r;
}

/**
 * Python `divmod(a, b)` returning `[Math.floor(a / b), pyMod(a, b)]`.
 */
export function divmod(a: number, b: number): [number, number] {
  const q = Math.floor(a / b);
  const r = a - q * b;
  return [q === 0 ? 0 : q, r === 0 ? 0 : r];
}

export function getattr(obj: any, attr: string, defVal: any = undefined): any {
  if (obj === null || obj === undefined) return defVal;
  return attr in obj && obj[attr] !== undefined ? obj[attr] : defVal;
}

export function hasattr(obj: any, attr: string): boolean {
  return obj !== null && obj !== undefined && attr in obj;
}

export function pyAugAdd(target: any, val: any): any {
  if (Array.isArray(target)) {
    if (Array.isArray(val)) {
      target.push(...val);
      return target;
    }
    if (val && typeof val[Symbol.iterator] === "function") {
      target.push(...Array.from(val));
      return target;
    }
    target.push(val);
    return target;
  }
  return target + val;
}

export function pyEq(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!pyEq(a[i], b[i])) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!(k in b) || !pyEq(a[k], b[k])) return false;
  }
  return true;
}

export function pyNotEq(a: any, b: any): boolean {
  return !pyEq(a, b);
}

export function pyBitOr(a: any, b: any): any {
  if (a instanceof Set) {
    const res = new Set(a);
    if (b) {
      for (const item of pyIter(b)) res.add(item);
    }
    return res;
  }
  if (b instanceof Set) {
    const res = new Set(b);
    if (a) {
      for (const item of pyIter(a)) res.add(item);
    }
    return res;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a | b;
  }
  if (a && typeof a === "object" && !Array.isArray(a)) {
    return { ...a, ...b };
  }
  return a | b;
}

export function pyBitAnd(a: any, b: any): any {
  if (a instanceof Set) {
    const res = new Set();
    if (b) {
      const bSet = b instanceof Set ? b : new Set(pyIter(b));
      for (const item of a) {
        if (bSet.has(item)) res.add(item);
      }
    }
    return res;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a & b;
  }
  return a & b;
}

export function pySetUnion(setA: any, ...iterables: any[]): Set<any> {
  const res = new Set(pyIter(setA));
  for (const it of iterables) {
    if (it) {
      for (const item of pyIter(it)) {
        res.add(item);
      }
    }
  }
  return res;
}

export const tuple = Array;
export const list = Array;

export function pyGet(obj: any, key: any, defVal: any = null): any {
  if (obj === null || obj === undefined) return defVal;
  if (obj instanceof Map) return obj.has(key) ? obj.get(key) : defVal;
  return (key in obj && obj[key] !== undefined) ? obj[key] : defVal;
}

export function pyItems(obj: any): any[] {
  if (obj === null || obj === undefined) return [];
  if (obj instanceof Map) return Array.from(obj.entries());
  return Object.entries(obj);
}

export function pyValues(obj: any): any[] {
  if (obj === null || obj === undefined) return [];
  if (obj instanceof Map || obj instanceof Set) return Array.from(obj.values());
  return Object.values(obj);
}

export function pyKeys(obj: any): any[] {
  if (obj === null || obj === undefined) return [];
  if (obj instanceof Map || obj instanceof Set) return Array.from(obj.keys());
  return Object.keys(obj);
}

export function pyMin(iterableOrFirst: any, ...rest: any[]): any {
  let items: any[];
  let keyFn: any = null;
  let defVal: any = null;

  if (rest.length === 0) {
    items = Array.from(pyIter(iterableOrFirst));
  } else if (rest.length === 1 && typeof rest[0] === "object" && rest[0] !== null && ("key" in rest[0] || "default" in rest[0])) {
    items = Array.from(pyIter(iterableOrFirst));
    keyFn = rest[0].key ?? null;
    defVal = rest[0].default ?? null;
  } else if (rest.length >= 1 && (typeof rest[0] === "function" || rest[0] === null || rest[0] === undefined)) {
    items = Array.from(pyIter(iterableOrFirst));
    keyFn = typeof rest[0] === "function" ? rest[0] : null;
    defVal = rest.length > 1 ? rest[1] : null;
  } else {
    items = [iterableOrFirst, ...rest];
  }

  if (items.length === 0) return defVal;
  return items.reduce((best: any, cur: any) => {
    if (keyFn) {
      const kb = keyFn(best);
      const kc = keyFn(cur);
      return kc < kb ? cur : best;
    }
    if (Array.isArray(best) && Array.isArray(cur)) {
      const len = Math.max(best.length, cur.length);
      for (let i = 0; i < len; i++) {
        if (i >= cur.length) return best;
        if (i >= best.length) return cur;
        if (cur[i] < best[i]) return cur;
        if (cur[i] > best[i]) return best;
      }
      return best;
    }
    return cur < best ? cur : best;
  });
}
export const min = pyMin;

export function pyMax(iterableOrFirst: any, ...rest: any[]): any {
  let items: any[];
  let keyFn: any = null;
  let defVal: any = null;

  if (rest.length === 0) {
    items = Array.from(pyIter(iterableOrFirst));
  } else if (rest.length === 1 && typeof rest[0] === "object" && rest[0] !== null && ("key" in rest[0] || "default" in rest[0])) {
    items = Array.from(pyIter(iterableOrFirst));
    keyFn = rest[0].key ?? null;
    defVal = rest[0].default ?? null;
  } else if (rest.length >= 1 && (typeof rest[0] === "function" || rest[0] === null || rest[0] === undefined)) {
    items = Array.from(pyIter(iterableOrFirst));
    keyFn = typeof rest[0] === "function" ? rest[0] : null;
    defVal = rest.length > 1 ? rest[1] : null;
  } else {
    items = [iterableOrFirst, ...rest];
  }

  if (items.length === 0) return defVal;
  return items.reduce((best: any, cur: any) => {
    if (keyFn) {
      const kb = keyFn(best);
      const kc = keyFn(cur);
      return kc > kb ? cur : best;
    }
    if (Array.isArray(best) && Array.isArray(cur)) {
      const len = Math.max(best.length, cur.length);
      for (let i = 0; i < len; i++) {
        if (i >= cur.length) return best;
        if (i >= best.length) return cur;
        if (cur[i] > best[i]) return cur;
        if (cur[i] < best[i]) return best;
      }
      return best;
    }
    return cur > best ? cur : best;
  });
}
export const max = pyMax;

export class PyFrozenSet<T = any> extends Set<T> {
  private _frozen = false;
  constructor(iterable?: Iterable<T> | null) {
    super(iterable ?? undefined);
    this._frozen = true;
  }
  override add(value: T): this {
    if (this._frozen) throw new Error("frozenset is immutable");
    return super.add(value);
  }
  override delete(value: T): boolean {
    if (this._frozen) throw new Error("frozenset is immutable");
    return super.delete(value);
  }
  override clear(): void {
    if (this._frozen) throw new Error("frozenset is immutable");
    super.clear();
  }
}

const frozenSetInternCache = new Map<string, PyFrozenSet<any>>();

export function frozenset<T = any>(iterable?: Iterable<T> | null): PyFrozenSet<T> {
  if (!iterable) {
    let empty = frozenSetInternCache.get("[]");
    if (!empty) {
      empty = new PyFrozenSet();
      frozenSetInternCache.set("[]", empty);
    }
    return empty;
  }
  const items = Array.from(iterable);
  const sorted = [...items].sort((a: any, b: any) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  const key = JSON.stringify(sorted);
  let cached = frozenSetInternCache.get(key);
  if (!cached) {
    cached = new PyFrozenSet(sorted);
    frozenSetInternCache.set(key, cached);
  }
  return cached;
}

export function pyPop(obj: any, key: any, defVal: any = null): any {
  if (obj === null || obj === undefined) return defVal;
  if (obj instanceof Map) {
    if (obj.has(key)) {
      const v = obj.get(key);
      obj.delete(key);
      return v;
    }
    return defVal;
  }
  if (key in obj) {
    const v = obj[key];
    delete obj[key];
    return v;
  }
  return defVal;
}

export function pyClear(obj: any): void {
  if (obj === null || obj === undefined) return;
  if (obj instanceof Map || obj instanceof Set) {
    obj.clear();
    return;
  }
  for (const k of Object.keys(obj)) delete obj[k];
}

export function pyIn(item: any, container: any): boolean {
  if (container === null || container === undefined) return false;
  if (container instanceof Set || container instanceof Map) return container.has(item);
  if (Array.isArray(container) || typeof container === "string") return container.includes(item);
  return item in container;
}

export function pyIter(obj: any): any {
  if (obj === null || obj === undefined) return [];
  if (typeof obj[Symbol.iterator] === "function") return obj;
  if (typeof obj === "object") return Object.keys(obj);
  return [];
}
export const iter = pyIter;

export function bool(val: any): boolean {
  if (val === null || val === undefined || val === false || val === 0 || val === "" || Number.isNaN(val)) {
    return false;
  }
  if (Array.isArray(val) || typeof val === "string") {
    return val.length > 0;
  }
  if (val instanceof Set || val instanceof Map) {
    return val.size > 0;
  }
  if (typeof val === "object") {
    return Object.keys(val).length > 0;
  }
  return Boolean(val);
}

export function ValueError(msg?: string): Error {
  const err = new Error(msg);
  err.name = "ValueError";
  return err;
}

export function KeyError(msg?: string): Error {
  const err = new Error(msg);
  err.name = "KeyError";
  return err;
}

export function IndexError(msg?: string): Error {
  const err = new Error(msg);
  err.name = "IndexError";
  return err;
}

export function pyCmp(a: any, b: any): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (Array.isArray(a) && Array.isArray(b)) {
    const minLen = Math.min(a.length, b.length);
    for (let i = 0; i < minLen; i++) {
      const c = pyCmp(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function pySorted<T>(iterable: any, keyFn: ((item: T) => any) | null = null, reverse = false): T[] {
  const arr = Array.from(pyIter(iterable)) as T[];
  return arr.sort((a: any, b: any) => {
    const ka = keyFn ? keyFn(a) : a;
    const kb = keyFn ? keyFn(b) : b;
    const cmp = pyCmp(ka, kb);
    return reverse ? -cmp : cmp;
  });
}

export function pyRange(...args: number[]): number[] {
  let start = 0;
  let stop = 0;
  let step = 1;
  if (args.length === 1) {
    stop = args[0]!;
  } else if (args.length === 2) {
    start = args[0]!;
    stop = args[1]!;
  } else if (args.length >= 3) {
    start = args[0]!;
    stop = args[1]!;
    step = args[2]!;
  }
  const result: number[] = [];
  if (step > 0) {
    for (let i = start; i < stop; i += step) result.push(i);
  } else if (step < 0) {
    for (let i = start; i > stop; i += step) result.push(i);
  }
  return result;
}

export function enumerate<T>(iterable: any): [number, T][] {
  const result: [number, T][] = [];
  let i = 0;
  for (const item of pyIter(iterable)) {
    result.push([i, item]);
    i += 1;
  }
  return result;
}

export function pyNext<T = any>(iterableOrIterator: any, defVal: any = null): T {
  if (iterableOrIterator === null || iterableOrIterator === undefined) return defVal;
  if (Array.isArray(iterableOrIterator)) {
    return iterableOrIterator.length > 0 ? iterableOrIterator[0] : defVal;
  }
  if (typeof iterableOrIterator.next === "function") {
    const res = iterableOrIterator.next();
    return res.done ? defVal : res.value;
  }
  if (iterableOrIterator instanceof Set || iterableOrIterator instanceof Map) {
    const it = iterableOrIterator.values();
    const res = it.next();
    return res.done ? defVal : res.value;
  }
  if (typeof iterableOrIterator[Symbol.iterator] === "function") {
    const it = iterableOrIterator[Symbol.iterator]();
    const res = it.next();
    return res.done ? defVal : res.value;
  }
  return defVal;
}
export const next = pyNext;

export function pyMap(fn: (...args: any[]) => any, ...iterables: any[]): any[] {
  if (iterables.length === 0) return [];
  const arrays = iterables.map((it) => Array.from(pyIter(it)));
  const minLen = Math.min(...arrays.map((a) => a.length));
  const res: any[] = [];
  for (let i = 0; i < minLen; i++) {
    const args = arrays.map((a) => a[i]);
    res.push(fn(...args));
  }
  return res;
}
export const map = pyMap;

export function pySetDefault(obj: any, key: any, defVal: any): any {
  if (obj === null || obj === undefined) return defVal;
  if (obj instanceof Map) {
    if (!obj.has(key)) obj.set(key, defVal);
    return obj.get(key);
  }
  if (!(key in obj)) {
    obj[key] = defVal;
  }
  return obj[key];
}

export function pyUpdate(target: any, items: any): void {
  if (target === null || target === undefined) return;
  if (target instanceof Set) {
    for (const x of pyIter(items)) target.add(x);
  } else if (target instanceof Map) {
    if (items instanceof Map) {
      for (const [k, v] of items.entries()) target.set(k, v);
    } else if (Array.isArray(items)) {
      for (const [k, v] of items) target.set(k, v);
    } else if (typeof items === "object") {
      for (const [k, v] of Object.entries(items)) target.set(k, v);
    }
  } else if (typeof target === "object") {
    if (items instanceof Map) {
      for (const [k, v] of items.entries()) target[k] = v;
    } else if (items !== null && items !== undefined) {
      Object.assign(target, items);
    }
  }
}

export const dict = {
  fromkeys: (keys: any) => new Set(pyIter(keys)),
};

export function zip(...iterables: any[]): any[][] {
  if (iterables.length === 0) return [];
  const arrays = iterables.map((it) => Array.from(pyIter(it)));
  const minLen = Math.min(...arrays.map((a) => a.length));
  const result: any[][] = [];
  for (let i = 0; i < minLen; i += 1) {
    result.push(arrays.map((a) => a[i]));
  }
  return result;
}

export function reversed<T>(iterable: any): T[] {
  const arr = Array.from(pyIter(iterable)) as T[];
  return arr.reverse();
}

export function type(obj: any): { __name__: string } {
  const name = obj?.name || obj?.constructor?.name || typeof obj || "Error";
  return { __name__: name };
}

export function pyAdd(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (Array.isArray(a)) {
    if (Array.isArray(b)) return a.concat(b);
    return a.concat(Array.from(b));
  }
  return a + b;
}

export function pyMult(a: any, b: any): any {
  if (Array.isArray(a) && typeof b === "number") {
    const res: any[] = [];
    const count = Math.max(0, Math.trunc(b));
    for (let i = 0; i < count; i++) {
      res.push(...a);
    }
    return res;
  }
  if (typeof a === "number" && Array.isArray(b)) {
    const res: any[] = [];
    const count = Math.max(0, Math.trunc(a));
    for (let i = 0; i < count; i++) {
      res.push(...b);
    }
    return res;
  }
  if (typeof a === "string" && typeof b === "number") {
    return a.repeat(Math.max(0, Math.trunc(b)));
  }
  if (typeof a === "number" && typeof b === "string") {
    return b.repeat(Math.max(0, Math.trunc(a)));
  }
  return a * b;
}

export function pyLen(obj: any): number {
  if (obj === null || obj === undefined) return 0;
  if (typeof obj.length === "number") return obj.length;
  if (obj instanceof Set || obj instanceof Map) return obj.size;
  if (typeof obj === "object") return Object.keys(obj).length;
  return 0;
}
export const len = pyLen;


