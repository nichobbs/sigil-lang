import { describe, expect, it } from 'vitest';
import { check, errors } from '../src/check.js';
import { Host, Interp } from '../src/interp.js';
import { parsePolicy, parseProgram } from '../src/parse.js';

const POLICY = '(policy)';
const run = (app: string) => check(parseProgram(app), parsePolicy(POLICY));
const TYPES = `
(type Cents (Int 0 1000000000000000))
(type Qty   (Int 0 1000))
`;

describe('fold: bounded iteration with a declared accumulator type', () => {
  const OK = `${TYPES}
(fn total (in (xs (List Qty 0 50))) (out Cents)
  (fold xs Cents 0 (fn (acc x) (add acc x))))`;

  it('proves the accumulator stays in its declared type when the body provably preserves it', () => {
    const bad = `${TYPES}
(fn total (in (xs (List Qty 0 50))) (out Cents)
  (fold xs Cents 0 (fn (acc x) (min (add acc x) 1000000000000000))))`;
    expect(errors(run(bad))).toEqual([]);
    const ob = run(bad).evidence.get('total')!.obligations.filter((o) => o.desc.includes('fold'));
    expect(ob.length).toBe(2);
    expect(ob.every((o) => o.status === 'proved')).toBe(true);
  });

  it('flags an unclamped step as unproved (the invariant is not inductive)', () => {
    const ob = run(OK).evidence.get('total')!.obligations.find((o) => o.desc.includes('fold step'))!;
    expect(ob.status).toBe('unproved');
  });

  it('rejects an unknown accumulator type and a one-parameter lambda', () => {
    expect(errors(run(`${TYPES}(fn f (in (xs (List Qty 0 5))) (out Cents) (fold xs Nope 0 (fn (acc x) acc)))`)).map((d) => d.code)).toContain('E-type');
    expect(errors(run(`${TYPES}(fn f (in (xs (List Qty 0 5))) (out Cents) (fold xs Cents 0 (fn (x) x)))`)).map((d) => d.code)).toContain('E-lambda');
  });

  it('runs: sums, handles the empty list and enforces the type on each step at run time', () => {
    const prog = parseProgram(OK);
    const it = new Interp(prog, new Host(1));
    expect(it.callFn('total', [[1n, 2n, 3n]])).toBe(6n);
    expect(it.callFn('total', [[]])).toBe(0n);
    const bad = parseProgram(`${TYPES}(fn f (in (xs (List Qty 0 5))) (out Cents) (fold xs Cents 0 (fn (acc x) (sub acc x))))`);
    expect(() => new Interp(bad, new Host(1)).callFn('f', [[1n]])).toThrow(/fold step 0/);
  });

  it('carries records as accumulator state (running totals with a counter)', () => {
    const app = `${TYPES}
(type Acc (rec (sum Cents) (n Qty)))
(fn stats (in (xs (List Qty 0 50))) (out Acc)
  (fold xs Acc (Acc 0 0)
    (fn (a x) (Acc (min (add a.sum x) 1000000000000000) (min (add a.n 1) 1000)))))`;
    expect(errors(run(app))).toEqual([]);
    const it = new Interp(parseProgram(app), new Host(1));
    const out = it.callFn('stats', [[5n, 7n]]) as { fields: Record<string, bigint> };
    expect(out.fields).toEqual({ sum: 12n, n: 2n });
  });

  it('propagates labels from the list into the result (a secret folded into a public field is E-flow)', () => {
    const base = `${TYPES}
(type Row (rec (secret Qty :secret) (v Qty)))
(type Out (rec (q Qty)))`;
    const leak = run(`${base}
(fn f (in (rs (List Row 0 5))) (out Out) (Out (fold rs Qty 0 (fn (acc r) (min (add acc r.secret) 1000)))))`);
    expect(errors(leak).map((d) => d.code)).toContain('E-flow');
    const fine = run(`${base}
(fn f (in (rs (List Row 0 5))) (out Out) (Out (fold rs Qty 0 (fn (acc r) (min (add acc r.v) 1000)))))`);
    expect(errors(fine)).toEqual([]);
  });
});

describe('text primitives: Str :max, chars, from-chars, append, take, drop, at', () => {
  const T = `${TYPES}
(type Code (Int 0 1114111))
(type Word (Str :max 20))
(type Codes (List Code 0 20))`;
  const interp = (app: string) => new Interp(parseProgram(app), new Host(1));

  it('parses (Str :max N) and prints it back', () => {
    const p = parseProgram(`(type W (Str :validated :max 9))`);
    expect(p.types.get('W')).toEqual({ k: 'str', validated: true, max: 9 });
  });

  it('chars needs a bounded string; with :max it yields a list of code points with the same bound', () => {
    expect(errors(run(`${T}(fn f (in (s Str)) (out Qty) (len (chars s)))`)).map((d) => d.code)).toContain('E-type');
    const r = run(`${T}(fn f (in (s Word)) (out Qty) (len (chars s)))`);
    expect(errors(r)).toEqual([]);
    expect(r.evidence.get('f')!.obligations.find((o) => o.desc.startsWith('out in'))!.status).toBe('proved');
  });

  it('round-trips and counts code points, not UTF-16 units', () => {
    const it = interp(`${T}(fn f (in (s Word)) (out Word) (from-chars (chars s)))
(fn n (in (s Word)) (out Qty) (len (chars s)))`);
    expect(it.callFn('f', ['héllo'])).toBe('héllo');
    expect(it.callFn('n', ['a😀b'])).toBe(3n);
  });

  it('enforces :max at run time', () => {
    const it = interp(`${T}(fn f (in (s Word)) (out Qty) (len (chars s)))`);
    expect(() => it.callFn('f', ['x'.repeat(21)])).toThrow(/exceeds :max 20/);
  });

  it('append, take, drop and at have the expected values and length ranges', () => {
    const app = `${T}
(fn app (in (xs Codes)) (out Codes) (take (append xs 65) 20))
(fn tk  (in (xs Codes)) (out Codes) (take xs 3))
(fn dr  (in (xs Codes)) (out Codes) (drop xs 3))
(fn at0 (in (xs Codes)) (out Code) (at xs 0 0))
(fn atn (in (xs Codes)) (out Code) (at xs 99 7))`;
    expect(errors(run(app))).toEqual([]);
    const it = interp(app);
    const xs = [1n, 2n, 3n, 4n, 5n];
    expect(it.callFn('app', [xs])).toEqual([1n, 2n, 3n, 4n, 5n, 65n]);
    expect(it.callFn('tk', [xs])).toEqual([1n, 2n, 3n]);
    expect(it.callFn('dr', [xs])).toEqual([4n, 5n]);
    expect(it.callFn('dr', [[1n]])).toEqual([]);
    expect(it.callFn('at0', [xs])).toBe(1n);
    expect(it.callFn('at0', [[]])).toBe(0n);
    expect(it.callFn('atn', [xs])).toBe(7n);
  });

  it('append without take is not provably within the list bound (the checker says so)', () => {
    const r = run(`${T}(fn f (in (xs Codes)) (out Codes) (append xs 65))`);
    expect(r.evidence.get('f')!.obligations.find((o) => o.kind === 'bounds')!.status).toBe('unproved');
  });

  it('a character scanner built with fold: number of lines in a text', () => {
    const app = `${T}
(type Text (Str :max 100))
(type Count (Int 0 100))
(fn lines (in (t Text)) (out Count)
  (fold (chars t) Count 0 (fn (n c) (if (= c 10) (min (add n 1) 100) n))))`;
    expect(errors(run(app))).toEqual([]);
    expect(interp(app).callFn('lines', ['a\nb\nc'])).toBe(2n);
  });

  it('parses a decimal integer with fold (digits to value), clamped to its type', () => {
    const app = `${T}
(type Text (Str :max 12))
(type Num (Int 0 2147483647))
(fn digits (in (t Text)) (out Num)
  (fold (chars t) Num 0 (fn (acc c) (min (add (mul acc 10) (sub c 48)) 2147483647))))`;
    const r = run(app);
    expect(errors(r)).toEqual([]);
    expect(interp(app).callFn('digits', ['0042'])).toBe(42n);
  });
});
