// Stage 1: records and Results as first-class values (construction, let-bound records, field reads, records and
// Results as parameters and results via multi-value, match on Result, `try ... :on-err`), differential against the interpreter.

import { describe, expect, it } from 'vitest';
import { Host, Interp, Val, enumVal, eqVal, errVal, okVal, showVal } from '../src/interp.js';
import { callCompiled, instantiate } from '../src/wasm/abi.js';
import { build, differential } from './helpers/wasm-diff.js';

const FIXTURE = `
(type Cents (Int 0 1000000000000))
(type Role  (var Admin Member Guest))
(type Err   (var Denied TooBig Odd))
(type Pt    (rec (x (Int -1000 1000)) (y (Int -1000 1000))))
(type Seg   (rec (a Pt) (b Pt) (on Bool)))
(type Acc   (rec (id (Int 0 100)) (role Role) (bal Cents)))
(type Stat  (rec (n (Int 0 20)) (pos (List Pt 0 20))))

(fn mk (in (x (Int -1000 1000)) (y (Int -1000 1000))) (out Pt) (Pt x y))
(fn mk-kw (in (x (Int -1000 1000)) (y (Int -1000 1000))) (out Pt) (Pt :y y :x x))
(fn mid (in (s Seg)) (out Pt)
  (Pt (div-floor (add s.a.x s.b.x) 2) (div-floor (add s.a.y s.b.y) 2)))
(fn swap (in (p Pt)) (out Pt) (Pt p.y p.x))
(fn seg-of (in (p Pt) (q Pt)) (out Seg) (Seg p q (< p.x q.x)))
(fn twice (in (p Pt)) (out Pt) (swap (swap p)))
(fn let-rec (in (p Pt)) (out (Int -2000 2000))
  (let [q (swap p) r (mk q.x p.x)] (add r.x r.y)))
(fn nested-let (in (s Seg)) (out Seg)
  (let [t (Seg s.b s.a s.on)] (if t.on t s)))

(fn check-amt (in (r Role) (amt Cents)) (out (Result Cents Err))
  (match r
    (Admin (ok amt))
    (Member (if (> amt 1000) (err TooBig) (ok amt)))
    (Guest (err Denied))))
(fn half (in (n Cents)) (out (Result Cents Err))
  (if (> n 0) (ok (div-floor n 2)) (err Odd)))
(fn quarter (in (n Cents)) (out (Result Cents Err))
  (let [h (try (half n) :on-err Odd)] (ok (div-floor h 2))))
(fn two-try (in (r Role) (n Cents)) (out (Result Cents Err))
  (let [a (try (check-amt r n) :on-err Denied)
        b (try (half a) :on-err TooBig)]
    (ok (min 1000000000000 (add a b)))))
(fn half-or-zero (in (n Cents)) (out Cents) (match (half n) (ok v v) (err e 0)))
(fn err-code (in (n Cents)) (out (Int 0 2))
  (match (half n) (ok v 0) (err e (match e (Denied 1) (TooBig 1) (Odd 2)))))
(fn arms-reversed (in (n Cents)) (out Cents) (match (half n) (err e 7) (ok v v)))
(fn acc-step (in (a Acc) (amt Cents)) (out (Result Acc Err))
  (match (check-amt a.role amt)
    (ok v (ok (Acc a.id a.role (min 1000000000000 (add a.bal v)))))
    (err e (err e))))
(fn result-param (in (r (Result Cents Err))) (out (Int 0 1000000000000))
  (match r (ok v v) (err e 5)))
(fn result-pass (in (r (Result Pt Err))) (out (Result Pt Err)) r)
(fn eq-rec (in (p Pt) (q Pt)) (out Bool) (= p q))
(fn eq-res (in (n Cents) (m Cents)) (out Bool) (= (half n) (half m)))
(fn eq-enum (in (a Role) (b Role)) (out Bool) (= a b))
(fn short-and (in (n Cents)) (out Bool) (and (> n 5) (match (half n) (ok v (> v 3)) (err e false))))
(fn short-or (in (n Cents)) (out Bool) (or (= n 0) (match (half n) (ok v (> v 3)) (err e true))))
(fn try-in-and (in (n Cents)) (out (Result Bool Err))
  (ok (and (> n 100) (> (try (half n) :on-err TooBig) 60))))

(fn pick-pts (in (ps (List Pt 0 20))) (out (List Pt 0 20)) (filter ps (fn (p) (> p.x 0))))
(fn flip-pts (in (ps (List Pt 0 20))) (out (List Pt 0 20)) (map ps (fn (p) (swap p))))
(fn lens (in (ps (List Pt 0 20))) (out (List (Int 0 20) 0 20)) (map ps (fn (p) (len ps))))
(fn pos-count (in (ps (List Pt 0 20))) (out (Int 0 20)) (len (pick-pts ps)))
(fn stat (in (ps (List Pt 0 20))) (out Stat)
  (let [pp (pick-pts ps)] (Stat (len pp) pp)))
(fn stat-n (in (ps (List Pt 0 20))) (out (Int 0 20)) (let [s (stat ps)] s.n))
(fn res-list (in (ps (List Pt 1 20))) (out (Result (List Pt 0 20) Err))
  (if (> (len ps) 10) (err TooBig) (ok (filter ps (fn (p) (> p.y 0))))))
(fn lit-pts (in (a (Int -5 5)) (b (Int -5 5))) (out (List Pt 3 3)) (list (Pt a b) (Pt b a) (swap (Pt a a))))
(fn sum-x (in (ps (List Pt 0 20))) (out (Int -20000 20000)) (sum (map ps (fn (p) p.x))))

(fn bad-ok-let (in (a (Int 0 5))) (out (Int 0 5)) (let [r (ok a)] (match r (ok v v) (err e 0))))
(fn bad-try-plain (in (a (Int 0 5))) (out (Int 0 5)) (try a :on-err Odd))
(fn bad-try-ret (in (n Cents)) (out Cents) (try (half n) :on-err Odd))
`;

describe('wasm values: records and Results', () => {
  const { prog, out } = build(FIXTURE);
  const rep = (n: string) => out.fns.find((f) => f.name === n)!;
  const COMPILABLE = [
    'mk', 'mk-kw', 'mid', 'swap', 'seg-of', 'twice', 'let-rec', 'nested-let',
    'check-amt', 'half', 'quarter', 'two-try', 'half-or-zero', 'err-code', 'arms-reversed', 'acc-step',
    'result-param', 'result-pass', 'eq-rec', 'eq-res', 'eq-enum', 'short-and', 'short-or', 'try-in-and',
    'pick-pts', 'flip-pts', 'lens', 'pos-count', 'stat', 'stat-n', 'res-list', 'lit-pts', 'sum-x',
  ];

  it('compiles records, Results, try and list-valued functions and the module validates', () => {
    for (const n of COMPILABLE) expect(rep(n).compilable, `${n}: ${rep(n).reason}`).toBe(true);
    expect(WebAssembly.validate(new Uint8Array(out.bytes))).toBe(true);
  });

  it('refuses what it cannot type or return, with reasons (never miscompiles)', () => {
    expect(rep('bad-ok-let').compilable).toBe(false);
    expect(rep('bad-ok-let').reason).toMatch(/no known Result type/);
    expect(rep('bad-try-plain').compilable).toBe(false);
    expect(rep('bad-try-ret').compilable).toBe(false);
    expect(rep('bad-try-ret').reason).toMatch(/try|Result/);
  });

  it('uses multi-value returns: a record result has one value per leaf, a Result adds a tag', async () => {
    expect(rep('mk').result).toMatchObject({ t: 'rec' });
    expect(rep('half').result).toMatchObject({ t: 'result' });
    const ex = await instantiate(out.bytes);
    const f = ex['mk'] as unknown as (x: number, y: number) => number[];
    expect(f(3, -4)).toEqual([3, -4]);
    const h = ex['half'] as unknown as (n: bigint) => [number, bigint, number];
    expect(h(10n)).toEqual([0, 5n, 0]); // tag ok, payload, inactive err side zero
    expect(h(0n)).toEqual([1, 0n, 2]); // tag err, inactive ok side zero, Odd = index 2
  });

  it('try returns the declared Err case from the whole function', async () => {
    const e = await instantiate(out.bytes);
    const q = (n: bigint) => callCompiled(rep('quarter'), e, [n]);
    expect(q(40n)).toEqual(okVal(10n));
    expect(q(0n)).toEqual(errVal(enumVal('Odd')));
    expect(eqVal(q(1n), okVal(0n))).toBe(true);
    const t = (r: string, n: bigint) => callCompiled(rep('two-try'), e, [enumVal(r), n]);
    expect(t('Guest', 10n)).toEqual(errVal(enumVal('Denied')));
    expect(t('Admin', 0n)).toEqual(errVal(enumVal('TooBig')));
    expect(t('Admin', 20n)).toEqual(okVal(30n));
  });

  for (const name of COMPILABLE) {
    it(`differential: ${name} (300 seeded inputs, interpreter vs wasm)`, async () => {
      const d = await differential(prog, out, name);
      expect(d.mismatches).toEqual([]);
      expect(d.runs).toBe(300);
    });
  }

  it('the inputs cover both Result sides and both try outcomes', async () => {
    const d = await differential(prog, out, 'quarter');
    const kinds = new Set(d.wants.map((w) => (w as { $: string }).$));
    expect(kinds).toEqual(new Set(['ok', 'err']));
    const d2 = await differential(prog, out, 'two-try');
    expect(new Set(d2.wants.map((w) => showVal(w).slice(0, 12))).size).toBeGreaterThan(2);
  });

  it('list results: a function returning a list, a record holding a list, and a Result holding a list', async () => {
    const ex = await instantiate(out.bytes);
    const pt = (x: bigint, y: bigint): Val => ({ $: 'rec', type: 'Pt', fields: { x, y } });
    const xs = [pt(1n, 2n), pt(-1n, 3n), pt(5n, -5n)];
    const got = callCompiled(rep('stat'), ex, [xs]);
    expect(got).toEqual({ $: 'rec', type: 'Stat', fields: { n: 2n, pos: [pt(1n, 2n), pt(5n, -5n)] } });
    expect(callCompiled(rep('res-list'), ex, [xs])).toEqual(okVal([pt(1n, 2n), pt(-1n, 3n)]));
    const big = Array.from({ length: 11 }, () => pt(1n, 1n));
    expect(callCompiled(rep('res-list'), ex, [big])).toEqual(errVal(enumVal('TooBig')));
    // an interpreter run agrees
    expect(new Interp(prog, new Host(1)).callFn('stat', [xs])).toEqual(got);
  });
});

describe('wasm values: the differential test catches a broken compiler', () => {
  const muts = [
    ['tag-flip', ['half', 'check-amt', 'quarter']],
    ['try-fallthrough', ['quarter', 'two-try']],
    ['result-arms-swapped', ['half-or-zero', 'err-code']],
  ] as const;
  for (const [m, names] of muts) {
    it(`mutation ${m} is detected`, async () => {
      const { prog, out } = build(FIXTURE, '(policy)', { mutation: m });
      for (const name of names) {
        const d = await differential(prog, out, name, { n: 100 });
        expect(d.mismatches.length, `${name} should expose ${m}`).toBeGreaterThan(0);
      }
    });
  }
  it('an unmutated build of the same functions agrees', async () => {
    const { prog, out } = build(FIXTURE);
    for (const name of ['half', 'quarter', 'half-or-zero']) expect((await differential(prog, out, name, { n: 100 })).mismatches).toEqual([]);
  });
});
