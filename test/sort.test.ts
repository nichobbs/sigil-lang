import { describe, expect, it } from 'vitest';
import { check, errors } from '../src/check.js';
import { Host, Interp } from '../src/interp.js';
import { parsePolicy, parseProgram } from '../src/parse.js';

const run = (app: string) => check(parseProgram(app), parsePolicy('(policy)'));
const T = `(type Qty (Int 0 1000))
(type Row (rec (id Qty) (v Qty)))`;

describe('sort: stable, comparator-driven permutation', () => {
  const APP = `${T}
(fn asc (in (xs (List Qty 0 100))) (out (List Qty 0 100)) (sort xs (fn (a b) (< a b))))
(fn by-v (in (xs (List Row 0 100))) (out (List Row 0 100)) (sort xs (fn (a b) (< a.v b.v))))`;

  it('checks clean and keeps the length bound', () => {
    expect(errors(run(APP))).toEqual([]);
  });

  it('sorts ascending, handles empty and singleton', () => {
    const it = new Interp(parseProgram(APP), new Host(1));
    expect(it.callFn('asc', [[3n, 1n, 2n, 1n]])).toEqual([1n, 1n, 2n, 3n]);
    expect(it.callFn('asc', [[]])).toEqual([]);
    expect(it.callFn('asc', [[7n]])).toEqual([7n]);
  });

  it('is stable: equal keys keep their original order', () => {
    const app = `${APP}
(fn ids (in (u Qty)) (out (List Qty 0 100))
  (map (by-v (list (Row 1 5) (Row 2 3) (Row 3 5) (Row 4 3))) (fn (r) r.id)))`;
    const it = new Interp(parseProgram(app), new Host(1));
    expect(it.callFn('ids', [0n])).toEqual([2n, 4n, 1n, 3n]);
  });

  it('sorts 100 items well inside the fuel budget', () => {
    const it = new Interp(parseProgram(APP), new Host(1));
    const xs = Array.from({ length: 100 }, (_, i) => BigInt((i * 37) % 101));
    const out = it.callFn('asc', [xs]) as bigint[];
    expect(out).toEqual([...xs].sort((a, b) => Number(a - b)));
  });

  it('rejects a one-parameter lambda', () => {
    expect(errors(run(`${T}(fn f (in (xs (List Qty 0 5))) (out (List Qty 0 5)) (sort xs (fn (a) true)))`)).map((d) => d.code)).toContain('E-lambda');
  });

  it('propagates comparator labels into the result (ordering public rows by a secret key is E-flow)', () => {
    const base = `${T}
(type SRow (rec (secret Qty :secret) (v Qty)))
(type Out (rec (q Qty)))`;
    const leak = run(`${base}
(fn f (in (rs (List SRow 0 5))) (out Out) (Out (fold (sort rs (fn (a b) (< a.secret b.secret))) Qty 0 (fn (acc r) r.v))))`);
    expect(errors(leak).map((d) => d.code)).toContain('E-flow');
    const fine = run(`${base}
(fn f (in (rs (List SRow 0 5))) (out Out) (Out (fold (sort rs (fn (a b) (< a.v b.v))) Qty 0 (fn (acc r) r.v))))`);
    expect(errors(fine)).toEqual([]);
  });
});
