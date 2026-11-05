// Integer interval domain with exact bigint arithmetic. 'top' = unknown/unbounded.
// There are no machine integers in Sigil: ranges are the only integer story, and
// the machine representation (i32 / i64 / bigint) is *derived* from them.

export type Interval = { lo: bigint; hi: bigint } | 'top';

export const TOP: Interval = 'top';
export const point = (v: bigint): Interval => ({ lo: v, hi: v });
export const range = (lo: bigint, hi: bigint): Interval => ({ lo, hi });

const min = (...xs: bigint[]) => xs.reduce((a, b) => (a < b ? a : b));
const max = (...xs: bigint[]) => xs.reduce((a, b) => (a > b ? a : b));

export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  return r !== 0n && r < 0n !== b < 0n ? q - 1n : q;
}

export function add(a: Interval, b: Interval): Interval {
  if (a === 'top' || b === 'top') return TOP;
  return range(a.lo + b.lo, a.hi + b.hi);
}
export function sub(a: Interval, b: Interval): Interval {
  if (a === 'top' || b === 'top') return TOP;
  return range(a.lo - b.hi, a.hi - b.lo);
}
export function mul(a: Interval, b: Interval): Interval {
  if (a === 'top' || b === 'top') return TOP;
  const p = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
  return range(min(...p), max(...p));
}
export function neg(a: Interval): Interval {
  return a === 'top' ? TOP : range(-a.hi, -a.lo);
}
export function containsZero(a: Interval): boolean {
  return a === 'top' || (a.lo <= 0n && 0n <= a.hi);
}
/** Floor division. Caller must have established that the divisor excludes zero. */
export function divFloor(a: Interval, b: Interval): Interval {
  if (a === 'top' || b === 'top' || containsZero(b)) return TOP;
  const q = [floorDiv(a.lo, b.lo), floorDiv(a.lo, b.hi), floorDiv(a.hi, b.lo), floorDiv(a.hi, b.hi)];
  return range(min(...q), max(...q));
}
/** Floor modulo: a = b * floorDiv(a, b) + floorMod(a, b); the result has the divisor's sign. */
export function floorMod(a: bigint, b: bigint): bigint {
  const r = a % b;
  return r !== 0n && r < 0n !== b < 0n ? r + b : r;
}
/**
 * Floor modulo. Caller must have established that the divisor excludes zero. Bounded whenever the divisor is,
 * even for an unbounded dividend: a positive divisor in [dl, dh] gives [0, dh - 1], a negative one [dl + 1, 0].
 * Tightened when the dividend's sign is known (0 <= a gives a mod b <= a, a <= 0 gives a mod b >= a) and exact when
 * the dividend already lies in [0, dl - 1] (or [dh + 1, 0]).
 */
export function mod(a: Interval, b: Interval): Interval {
  if (b === 'top' || containsZero(b)) return TOP;
  if (a !== 'top' && a.lo === a.hi && b.lo === b.hi) return point(floorMod(a.lo, b.lo));
  if (b.lo > 0n) {
    if (a !== 'top' && a.lo >= 0n && a.hi < b.lo) return a;
    const hi = a !== 'top' && a.lo >= 0n ? min(a.hi, b.hi - 1n) : b.hi - 1n;
    return range(0n, hi);
  }
  if (a !== 'top' && a.hi <= 0n && a.lo > b.hi) return a;
  const lo = a !== 'top' && a.hi <= 0n ? max(a.lo, b.lo + 1n) : b.lo + 1n;
  return range(lo, 0n);
}
export function imin(a: Interval, b: Interval): Interval {
  if (a === 'top' || b === 'top') return TOP;
  return range(min(a.lo, b.lo), min(a.hi, b.hi));
}
export function imax(a: Interval, b: Interval): Interval {
  if (a === 'top' || b === 'top') return TOP;
  return range(max(a.lo, b.lo), max(a.hi, b.hi));
}
export function join(a: Interval, b: Interval): Interval {
  if (a === 'top' || b === 'top') return TOP;
  return range(min(a.lo, b.lo), max(a.hi, b.hi));
}
/** Intersection; falls back to `b` (the declared bound) when disjoint. */
export function meet(a: Interval, b: Interval): Interval {
  if (a === 'top') return b;
  if (b === 'top') return a;
  const lo = max(a.lo, b.lo);
  const hi = min(a.hi, b.hi);
  return lo <= hi ? range(lo, hi) : b;
}
/** Sum of n elements with n in `len` and each in `el`. */
export function sumOf(len: Interval, el: Interval): Interval {
  if (len === 'top' || el === 'top') return TOP;
  const lo = el.lo >= 0n ? len.lo * el.lo : len.hi * el.lo;
  const hi = el.hi >= 0n ? len.hi * el.hi : len.lo * el.hi;
  return range(lo, hi);
}
export function within(a: Interval, bound: Interval): boolean {
  if (bound === 'top') return true;
  if (a === 'top') return false;
  return bound.lo <= a.lo && a.hi <= bound.hi;
}
export function maxAbs(a: Interval): bigint | null {
  if (a === 'top') return null;
  const x = a.lo < 0n ? -a.lo : a.lo;
  const y = a.hi < 0n ? -a.hi : a.hi;
  return x > y ? x : y;
}

export type Repr = 'i32' | 'i64' | 'bigint';
export function reprFor(maxMagnitude: bigint | null): Repr {
  if (maxMagnitude === null) return 'bigint';
  if (maxMagnitude <= 2147483647n) return 'i32';
  if (maxMagnitude <= 9223372036854775807n) return 'i64';
  return 'bigint';
}

export function showInterval(a: Interval): string {
  return a === 'top' ? '(-inf, +inf)' : a.lo === a.hi ? `{${a.lo}}` : `[${a.lo}, ${a.hi}]`;
}

// Three-valued comparison over intervals.
export type Tri = 'true' | 'false' | 'unknown';
export function triLE(a: Interval, b: Interval): Tri {
  if (a === 'top' || b === 'top') return 'unknown';
  if (a.hi <= b.lo) return 'true';
  if (a.lo > b.hi) return 'false';
  return 'unknown';
}
export function triLT(a: Interval, b: Interval): Tri {
  if (a === 'top' || b === 'top') return 'unknown';
  if (a.hi < b.lo) return 'true';
  if (a.lo >= b.hi) return 'false';
  return 'unknown';
}
export function triEQ(a: Interval, b: Interval): Tri {
  if (a === 'top' || b === 'top') return 'unknown';
  if (a.lo === a.hi && b.lo === b.hi && a.lo === b.lo) return 'true';
  if (a.hi < b.lo || b.hi < a.lo) return 'false';
  return 'unknown';
}
export function triAnd(xs: Tri[]): Tri {
  if (xs.includes('false')) return 'false';
  return xs.every((x) => x === 'true') ? 'true' : 'unknown';
}
export function triOr(xs: Tri[]): Tri {
  if (xs.includes('true')) return 'true';
  return xs.every((x) => x === 'false') ? 'false' : 'unknown';
}
export function triNot(x: Tri): Tri {
  return x === 'true' ? 'false' : x === 'false' ? 'true' : 'unknown';
}
