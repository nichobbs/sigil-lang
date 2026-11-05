// Language v2 (docs/FREEZE.md): mod, concat, range, any, all and fold with an index, in the checker and interpreter.

import { describe, expect, it } from 'vitest';
import { check, errors } from '../src/check.js';
import { Host, Interp, RuntimeFault } from '../src/interp.js';
import * as I from '../src/interval.js';
import { parsePolicy, parseProgram } from '../src/parse.js';
import { mulberry32 } from '../src/interp.js';
import { proveEnsures } from '../src/smt.js';
import { braces } from '../src/print/braces.js';
import { arityTable } from '../src/print/common.js';
import { compact } from '../src/print/compact.js';
import { parsePolishExpr, polish } from '../src/print/polish.js';
import { printExpr } from '../src/print/sexp.js';

const run = (app: string, policy = '(policy)') => check(parseProgram(app), parsePolicy(policy));
const codes = (app: string, policy?: string) => errors(run(app, policy)).map((d) => d.code);
const obs = (app: string, fn: string, part = '') => run(app).evidence.get(fn)!.obligations.filter((o) => o.desc.includes(part));
const status = (app: string, fn: string, part: string) => obs(app, fn, part).map((o) => o.status);
const interp = (app: string) => new Interp(parseProgram(app), new Host(1));
const T = `
(type Qty (Int 0 1000))
(type Idx (Int 0 49))
`;

describe('mod: floor modulo', () => {
  it('interval mod is sound for every dividend and divisor in small intervals (brute force)', () => {
    const rnd = mulberry32(77);
    const pick = () => BigInt(Math.floor(rnd() * 41) - 20);
    for (let k = 0; k < 3000; k++) {
      let [al, ah, bl, bh] = [pick(), pick(), pick(), pick()];
      if (al > ah) [al, ah] = [ah, al];
      if (bl > bh) [bl, bh] = [bh, bl];
      if (bl <= 0n && bh >= 0n) continue;
      const r = I.mod(I.range(al, ah), I.range(bl, bh));
      expect(r).not.toBe('top');
      for (let a = al; a <= ah; a++) {
        for (let b = bl; b <= bh; b++) {
          const v = I.floorMod(a, b);
          if (r === 'top' || v < r.lo || v > r.hi) throw new Error(`${a} mod ${b} = ${v} outside ${I.showInterval(r)} for [${al},${ah}] mod [${bl},${bh}]`);
          expect(a).toBe(b * I.floorDiv(a, b) + v);
        }
      }
    }
  });

  it('bounds the result by the divisor even for an unbounded dividend, and folds constants', () => {
    expect(I.mod(I.TOP, I.range(3n, 10n))).toEqual(I.range(0n, 9n));
    expect(I.mod(I.TOP, I.range(-10n, -3n))).toEqual(I.range(-9n, 0n));
    expect(I.mod(I.point(-7n), I.point(3n))).toEqual(I.point(2n));
    expect(I.mod(I.range(0n, 5n), I.range(10n, 20n))).toEqual(I.range(0n, 5n));
    expect(I.mod(I.range(-5n, 5n), I.range(-1n, 1n))).toBe('top');
  });

  it('proves results in the divisor range (positive and negative divisors)', () => {
    const app = `${T}
(fn pos (in (x (Int -100 100))) (out (Int 0 6)) (mod x 7))
(fn neg (in (x (Int -100 100))) (out (Int -6 0)) (mod x -7))
(fn wide (in (x (Int -100 100)) (d (Int 3 10))) (out (Int 0 9)) (mod x d))
(fn konst (in) (out (Int 2 2)) (mod -7 3))`;
    expect(codes(app)).toEqual([]);
    for (const f of ['pos', 'neg', 'wide', 'konst']) expect(status(app, f, 'out'), f).toEqual(['proved']);
    expect(status(`${T}(fn bad (in (x (Int -100 100))) (out (Int 0 6)) (mod x -7))`, 'bad', 'out')).toEqual(['unproved']);
  });

  it('needs a divisor range that excludes 0, with the div-floor fix', () => {
    const app = `${T}(fn f (in (x Qty) (d (Int 0 10))) (out (Int 0 9)) (mod x d))`;
    const div = obs(app, 'f', 'divisor');
    expect(div.map((o) => o.status)).toEqual(['unproved']);
    expect(div[0].fix?.new).toBe('(mod x (max 1 d))');
    expect(status(`${T}(fn f (in (x Qty) (d (Int 0 10))) (out (Int 0 9)) (mod x (max 1 d)))`, 'f', 'divisor')).toEqual(['proved']);
  });

  it('E-arity on a wrong count and E-type on a list', () => {
    expect(codes(`${T}(fn f (in (x Qty)) (out Qty) (mod x))`)).toContain('E-arity');
    expect(codes(`${T}(fn f (in (x Qty)) (out Qty) (mod x 2 3))`)).toContain('E-arity');
    expect(codes(`${T}(fn f (in (xs (List Qty 0 3))) (out Qty) (mod xs 2))`)).toContain('E-type');
  });

  it('runs with floor semantics (sign of the divisor) and faults on a zero divisor', () => {
    const it = interp(`(fn f (in (a (Int -100 100)) (b (Int -100 100))) (out (Int -100 100)) (mod a b))`);
    const cases: [bigint, bigint, bigint][] = [[7n, 3n, 1n], [-7n, 3n, 2n], [7n, -3n, -2n], [-7n, -3n, -1n], [6n, 3n, 0n], [-6n, 3n, 0n], [0n, -5n, 0n]];
    for (const [a, b, r] of cases) expect(it.callFn('f', [a, b]), `${a} mod ${b}`).toBe(r);
    expect(() => it.callFn('f', [1n, 0n])).toThrow(RuntimeFault);
  });
});

describe('concat', () => {
  it('length is the sum of the length ranges; a too-long result gets the take fix', () => {
    const ok = `${T}(fn f (in (a (List Qty 1 5)) (b (List Qty 2 5))) (out (List Qty 3 10)) (concat a b))`;
    expect(codes(ok)).toEqual([]);
    expect(status(ok, 'f', 'out.length')).toEqual(['proved']);
    const long = `${T}(fn f (in (a (List Qty 0 6)) (b (List Qty 0 5))) (out (List Qty 0 10)) (concat a b))`;
    const o = obs(long, 'f', 'out.length');
    expect(o.map((x) => x.status)).toEqual(['unproved']);
    expect(o[0].fix?.new).toBe('(take (concat a b) 10)');
    expect(status(`${T}(fn f (in (a (List Qty 0 6)) (b (List Qty 0 5))) (out (List Qty 0 10)) (take (concat a b) 10))`, 'f', 'out.length')).toEqual(['proved']);
  });

  it('joins element facts of both lists', () => {
    const app = `(fn f (in (a (List (Int 0 5) 0 3)) (b (List (Int 10 20) 0 3))) (out (List (Int 0 20) 0 6)) (concat a b))`;
    expect(status(app, 'f', 'out[]')).toEqual(['proved']);
    expect(status(`(fn f (in (a (List (Int 0 5) 0 3)) (b (List (Int 10 20) 0 3))) (out (List (Int 0 5) 0 6)) (concat a b))`, 'f', 'out[]')).toEqual(['unproved']);
  });

  it('carries element labels (a secret element reaching a public field is E-flow)', () => {
    const base = `${T}
(type Row (rec (s Qty :secret) (v Qty)))
(type Out (rec (n Qty)))`;
    expect(codes(`${base}(fn f (in (a (List Row 0 3)) (b (List Row 0 3))) (out Out) (Out (sum (map (concat a b) (fn (r) r.s)))))`)).toContain('E-flow');
    expect(codes(`${base}(fn f (in (a (List Row 0 3)) (b (List Row 0 3))) (out Out) (Out (sum (map (concat a b) (fn (r) r.v)))))`)).toEqual([]);
  });

  it('E-arity and E-type', () => {
    expect(codes(`${T}(fn f (in (a (List Qty 0 3))) (out (List Qty 0 3)) (concat a))`)).toContain('E-arity');
    expect(codes(`${T}(fn f (in (a (List Qty 0 3)) (x Qty)) (out (List Qty 0 3)) (concat a x))`)).toContain('E-type');
  });

  it('runs, including empty lists', () => {
    const it = interp(`${T}(fn f (in (a (List Qty 0 3)) (b (List Qty 0 3))) (out (List Qty 0 6)) (concat a b))`);
    expect(it.callFn('f', [[1n, 2n], [3n]])).toEqual([1n, 2n, 3n]);
    expect(it.callFn('f', [[], [3n]])).toEqual([3n]);
    expect(it.callFn('f', [[1n], []])).toEqual([1n]);
    expect(it.callFn('f', [[], []])).toEqual([]);
  });
});

describe('range', () => {
  it('gives length 0..max(n.hi, 0) and elements 0..n.hi-1', () => {
    const app = `
(fn f (in (n (Int 0 100))) (out (List (Int 0 99) 0 100)) (range n))
(fn g (in (n (Int -5 10))) (out (List (Int 0 9) 0 10)) (range n))
(fn h (in (n (Int -5 -1))) (out (List (Int 0 0) 0 0)) (range n))
(fn k (in) (out (List (Int 0 2) 3 3)) (range 3))`;
    expect(codes(app)).toEqual([]);
    for (const f of ['f', 'g', 'h', 'k']) expect(status(app, f, 'out').every((s) => s === 'proved'), f).toBe(true);
    expect(status(`(fn f (in (n (Int 0 100))) (out (List (Int 0 98) 0 100)) (range n))`, 'f', 'out[]')).toEqual(['unproved']);
  });

  it(`rejects an n that may exceed the cap (E-type) and accepts it clamped`, () => {
    const big = `(fn f (in (n (Int 0 20000))) (out (List (Int 0 9999) 0 10000)) (range n))`;
    const ds = errors(run(big));
    expect(ds.map((d) => d.code)).toContain('E-type');
    expect(ds.find((d) => d.code === 'E-type')!.msg).toMatch(/at most 10000.*\(range \(min n 10000\)\)/);
    expect(codes(`(fn f (in (n (Int 0 20000))) (out (List (Int 0 9999) 0 10000)) (range (min n 10000)))`)).toEqual([]);
    expect(codes(`(fn f (in (n (Int 0 9))) (out (List (Int 0 9) 0 9)) (range n n))`)).toContain('E-arity');
  });

  it('the length and the elements carry the label of n', () => {
    const app = `(type S (rec (n (Int 0 10) :secret)))
(type Out (rec (k (Int 0 10))))
(fn f (in (s S)) (out Out) (Out (len (range s.n))))`;
    expect(codes(app)).toContain('E-flow');
  });

  it('runs: n <= 0 is the empty list', () => {
    const it = interp(`(fn f (in (n (Int -5 10))) (out (List (Int 0 9) 0 10)) (range n))`);
    expect(it.callFn('f', [4n])).toEqual([0n, 1n, 2n, 3n]);
    expect(it.callFn('f', [1n])).toEqual([0n]);
    expect(it.callFn('f', [0n])).toEqual([]);
    expect(it.callFn('f', [-5n])).toEqual([]);
  });
});

describe('any / all', () => {
  const app = `${T}
(fn has-big (in (xs (List Qty 0 10))) (out Bool) (any xs (fn (x) (> x 500))))
(fn all-small (in (xs (List Qty 0 10))) (out Bool) (all xs (fn (x) (<= x 500))))`;

  it('type-checks; a wrong lambda is E-lambda and a wrong count E-arity', () => {
    expect(codes(app)).toEqual([]);
    expect(codes(`${T}(fn f (in (xs (List Qty 0 10))) (out Bool) (any xs (fn (a b) true)))`)).toContain('E-lambda');
    expect(codes(`${T}(fn f (in (xs (List Qty 0 10))) (out Bool) (all xs))`)).toContain('E-arity');
  });

  it('runs: any of the empty list is false, all is true', () => {
    const it = interp(app);
    expect(it.callFn('has-big', [[]])).toBe(false);
    expect(it.callFn('all-small', [[]])).toBe(true);
    expect(it.callFn('has-big', [[1n, 600n]])).toBe(true);
    expect(it.callFn('has-big', [[1n, 6n]])).toBe(false);
    expect(it.callFn('all-small', [[1n, 600n]])).toBe(false);
    expect(it.callFn('all-small', [[1n, 6n]])).toBe(true);
  });

  it('short-circuits at the first deciding element', () => {
    const fx = `${T}
(type Ev (rec (v Qty)))
(fn seen (in (xs (List Qty 0 10))) (out Bool) (needs audit) (any xs (fn (x) (do (emit audit (Ev x)) (> x 500)))))
(fn seen-all (in (xs (List Qty 0 10))) (out Bool) (needs audit) (all xs (fn (x) (do (emit audit (Ev x)) (<= x 500)))))
(program p (targets server) (entry seen (bind audit (audit))))`;
    const pol = '(policy (allow audit) (sink audit (accepts internal)))';
    expect(codes(fx, pol)).toEqual([]);
    for (const fn of ['seen', 'seen-all']) {
      const host = new Host(1);
      new Interp(parseProgram(fx), host).callFn(fn, [[1n, 600n, 2n, 700n]]);
      expect(host.emitted('audit').length, fn).toBe(2);
    }
  });

  it('labels of the lambda flow into the result; so does an implicit flow through the stop point', () => {
    const base = `${T}
(type Row (rec (s Qty :secret) (v Qty)))
(type Out (rec (b Bool)))
(type Ev (rec (v Qty)))`;
    expect(codes(`${base}(fn f (in (rs (List Row 0 5))) (out Out) (Out (any rs (fn (r) (> r.s 3)))))`)).toContain('E-flow');
    expect(codes(`${base}(fn f (in (rs (List Row 0 5))) (out Out) (Out (all rs (fn (r) (> r.v 3)))))`)).toEqual([]);
    // whether the emit for a later row runs depends on the secret of an earlier one
    const pol = '(policy (allow audit) (sink audit (accepts internal)))';
    const leak = `${base}(fn f (in (rs (List Row 0 5))) (out Bool) (needs audit) (any rs (fn (r) (do (emit audit (Ev r.v)) (> r.s 3)))))
(program p (targets server) (entry f (bind audit (audit))))`;
    expect(codes(leak, pol)).toContain('E-flow');
  });
});

describe('fold with an index', () => {
  it('binds i to the 0-based index, an Int in 0..max-1', () => {
    const ok = `${T}(fn last-idx (in (xs (List Qty 0 50))) (out Idx) (fold xs Idx 0 (fn (acc x i) (max acc i))))`;
    expect(codes(ok)).toEqual([]);
    expect(status(ok, 'last-idx', 'fold step')).toEqual(['proved']);
    const tight = `${T}(type I48 (Int 0 48))(fn f (in (xs (List Qty 0 50))) (out I48) (fold xs I48 0 (fn (acc x i) (max acc i))))`;
    expect(status(tight, 'f', 'fold step')).toEqual(['unproved']);
  });

  it('keeps the two-parameter form and rejects other parameter counts', () => {
    expect(codes(`${T}(fn f (in (xs (List Qty 0 5))) (out Qty) (fold xs Qty 0 (fn (acc x) (max acc x))))`)).toEqual([]);
    expect(codes(`${T}(fn f (in (xs (List Qty 0 5))) (out Qty) (fold xs Qty 0 (fn (acc x i j) acc)))`)).toContain('E-lambda');
  });

  it('runs: weighted positions, the empty list', () => {
    const it = interp(`${T}(type Big (Int 0 1000000))
(fn f (in (xs (List Qty 0 50))) (out Big) (fold xs Big 0 (fn (acc x i) (min 1000000 (add acc (mul x i))))))`);
    expect(it.callFn('f', [[5n, 6n, 7n]])).toBe(0n * 5n + 1n * 6n + 2n * 7n);
    expect(it.callFn('f', [[]])).toBe(0n);
  });
});

describe('printers', () => {
  it('print the v2 builtins (braces infix %, compact %, polish round trip)', () => {
    const prog = parseProgram(`${T}(fn f (in (xs (List Qty 0 9)) (n (Int 0 9))) (out Qty)
  (fold (concat xs (range n)) Qty 0 (fn (acc x i) (if (any xs (fn (y) (all xs (fn (z) (> z y))))) (mod (add acc x) 7) i))))`);
    const body = prog.fns.get('f')!.body;
    expect(braces.expr(prog, body)).toContain('(acc + x) % 7');
    expect(compact.expr(prog, body)).toContain('(% (+ acc x) 7)');
    const toks = polish.expr(prog, body);
    expect(printExpr(parsePolishExpr(toks, arityTable(prog)))).toBe(printExpr(body));
  });
});

describe('SMT: mod by a positive literal, any and all', () => {
  const prove = async (src: string, fn: string) => (await proveEnsures(parseProgram(src))).find((r) => r.fn === fn)!;

  it('proves the floor division identity and refutes a wrong mod claim', async () => {
    const id = await prove(`(fn m (in (a (Int -100 100))) (out (Int 0 6)) (ensures (= a (add (mul 7 (div-floor a 7)) out))) (mod a 7))`, 'm');
    expect(id.status).toBe('proved');
    const bad = await prove(`(fn m (in (a (Int -100 100))) (out (Int 0 6)) (ensures (<= out a)) (mod a 7))`, 'm');
    expect(bad.status).toBe('counterexample');
    const sym = await prove(`(fn m (in (a (Int -100 100)) (b (Int 1 5))) (out (Int 0 4)) (ensures (>= out 0)) (mod a b))`, 'm');
    expect(sym.status).toBe('unsupported');
  });

  it('models any and all over bounded lists (empty list included)', async () => {
    const any = await prove(`(fn f (in (xs (List (Int 0 9) 0 4))) (out (Int 0 1)) (ensures (<= out (len xs))) (if (any xs (fn (x) (> x 5))) 1 0))`, 'f');
    expect(any.status).toBe('proved');
    const all = await prove(`(fn f (in (xs (List (Int 0 9) 0 4))) (out (Int 0 1)) (ensures (>= (add out (len xs)) 1)) (if (all xs (fn (x) (> x 5))) 1 0))`, 'f');
    expect(all.status).toBe('proved');
    const wrong = await prove(`(fn f (in (xs (List (Int 0 9) 0 4))) (out (Int 0 1)) (ensures (= out 0)) (if (all xs (fn (x) (> x 5))) 1 0))`, 'f');
    expect(wrong.status).toBe('counterexample');
  });
});
