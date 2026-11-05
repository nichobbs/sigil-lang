// Language v2 on Wasm: mod, concat, range, any, all and fold with an index compile and agree with the interpreter on
// random boundary-biased inputs (negative operands, empty lists, n <= 0); compiler mutations of each are caught.

import { describe, expect, it } from 'vitest';
import { compileProgram } from '../src/wasm/compile.js';
import { build, differential } from './helpers/wasm-diff.js';
import { differentialEffects } from './helpers/wasm-effects.js';

const FIXTURE = `
(type Big  (Int 0 1000000000000))
(type Item (rec (id (Int 0 1000)) (w (Int -1000 1000))))
(type Pos  (Int 0 99))
(type P39  (Int 0 39))
(type Acc  (rec (best (Int 0 99)) (top (Int -1000 1000))))

(fn mod-pos   (in (a (Int -1000000 1000000)) (b (Int 1 97)))   (out (Int 0 96))  (mod a b))
(fn mod-neg   (in (a (Int -1000000 1000000)) (b (Int -97 -1))) (out (Int -96 0)) (mod a b))
(fn mod-mixed (in (a (Int -1000 1000)) (b (Int -50 50)))       (out (Int -49 49))
  (if (< b 0) (mod a (min -1 b)) (mod a (max 1 b))))
(fn mod-wide  (in (a (Int -4000000000000 4000000000000)) (b (Int -3000000000 -1))) (out (Int -2999999999 0)) (mod a b))
(fn mod-lit   (in (a (Int -1000 1000))) (out (Int 0 6)) (mod a 7))

(fn cat (in (a (List (Int -1000 1000) 0 20)) (b (List (Int -1000 1000) 0 30))) (out (List (Int -1000 1000) 0 50)) (concat a b))
(fn cat-rec (in (a (List Item 0 10)) (b (List Item 1 10))) (out (List Item 1 20)) (concat a b))
(fn cat-sum (in (a (List (Int -1000 1000) 0 20)) (b (List (Int -1000 1000) 0 30))) (out (Int -50000 50000))
  (sum (concat (map a (fn (x) (neg x))) b)))
(fn cat-take (in (a (List (Int -1000 1000) 0 20)) (b (List (Int -1000 1000) 0 30))) (out (List (Int -1000 1000) 0 25))
  (take (concat a b) 25))
(fn cat-self (in (a (List Item 0 10))) (out (Int -20000 20000)) (sum (map (concat a a) (fn (x) x.w))))

(fn rng      (in (n (Int -20 60))) (out (List (Int 0 59) 0 60)) (range n))
(fn rng-sum  (in (n (Int -20 60))) (out (Int 0 3540)) (sum (range n)))
(fn rng-sq   (in (n (Int -5 30))) (out (List (Int 0 841) 0 30)) (map (range n) (fn (i) (mul i i))))
(fn rng-len  (in (xs (List Item 0 40))) (out (Int 0 40)) (len (range (len xs))))
(fn rng-at   (in (xs (List Item 0 40)) (k (Int -3 45))) (out (Int -1 39)) (at (range (len xs)) k -1))

(fn any-neg  (in (xs (List (Int -1000 1000) 0 30))) (out Bool) (any xs (fn (x) (< x 0))))
(fn all-even (in (xs (List (Int -1000 1000) 0 30))) (out Bool) (all xs (fn (x) (= (mod x 2) 0))))
(fn any-rec  (in (xs (List Item 0 30)) (t (Int -1000 1000))) (out Bool) (any xs (fn (x) (and (> x.w t) (< x.id 500)))))
(fn all-rec  (in (xs (List Item 0 30)) (t (Int -1000 1000))) (out Bool) (all xs (fn (x) (or (> x.w t) (= x.id 0)))))
(fn sorted   (in (xs (List (Int -1000 1000) 0 30))) (out Bool)
  (all (range (sub (len xs) 1)) (fn (i) (<= (at xs i 0) (at xs (add i 1) 0)))))

(fn argmax (in (xs (List (Int -1000 1000) 1 100))) (out Pos)
  (let [a (fold xs Acc (Acc 0 -1000) (fn (acc x i) (if (> x acc.top) (Acc (min 99 i) x) acc)))] a.best))
(fn weighted (in (xs (List (Int -1000 1000) 0 100))) (out Big)
  (fold xs Big 0 (fn (acc x i) (min 1000000000000 (max 0 (add acc (mul x i)))))))
(fn idx-rec (in (xs (List Item 0 40))) (out (Int 0 39))
  (fold xs P39 0 (fn (acc x i) (if (= (mod x.id 3) 0) (min 39 i) acc))))
(fn two-param (in (xs (List (Int 0 1000) 0 100))) (out Big) (fold xs Big 0 (fn (acc x) (min 1000000000000 (add acc x)))))
`;

const FNS = [
  'mod-pos', 'mod-neg', 'mod-mixed', 'mod-wide', 'mod-lit',
  'cat', 'cat-rec', 'cat-sum', 'cat-take', 'cat-self',
  'rng', 'rng-sum', 'rng-sq', 'rng-len', 'rng-at',
  'any-neg', 'all-even', 'any-rec', 'all-rec', 'sorted',
  'argmax', 'weighted', 'idx-rec', 'two-param',
];

describe('wasm v2: mod, concat, range, any, all, fold with an index', () => {
  const { prog, res, out } = build(FIXTURE);

  it('the fixture checks clean and every function compiles', () => {
    expect(res.diags.filter((d) => d.level === 'error')).toEqual([]);
    for (const n of FNS) {
      const r = out.fns.find((f) => f.name === n)!;
      expect(r.compilable, `${n}: ${r.reason}`).toBe(true);
    }
    expect(WebAssembly.validate(new Uint8Array(out.bytes))).toBe(true);
    expect(out.fns.find((f) => f.name === 'mod-wide')!.repr).toBe('i64');
  });

  for (const n of FNS) {
    it(`${n}: agrees with the interpreter on 300 random inputs`, async () => {
      const d = await differential(prog, out, n, { n: 300, seed: 2611 });
      expect(d.mismatches.slice(0, 3)).toEqual([]);
    });
  }

  it('edge cases: every sign combination for mod, n <= 0 for range, empty lists', async () => {
    const signs = [-7n, -6n, -1n, 0n, 1n, 6n, 7n, -1000000n, 1000000n];
    const pos = await differential(prog, out, 'mod-pos', { n: signs.length * 3, args: (_, i) => [signs[i % signs.length], [1n, 7n, 97n][Math.floor(i / signs.length)]] });
    const neg = await differential(prog, out, 'mod-neg', { n: signs.length * 3, args: (_, i) => [signs[i % signs.length], [-1n, -7n, -97n][Math.floor(i / signs.length)]] });
    expect([...pos.mismatches, ...neg.mismatches]).toEqual([]);
    expect(pos.wants.slice(9, 12)).toEqual([0n, 1n, 6n]); // -7, -6, -1 mod 7
    expect(neg.wants.slice(9, 12)).toEqual([0n, -6n, -1n]); // -7, -6, -1 mod -7
    const ns = [-20n, -1n, 0n, 1n, 2n, 59n, 60n];
    const r = await differential(prog, out, 'rng', { n: ns.length, args: (_, i) => [ns[i]] });
    expect(r.mismatches).toEqual([]);
    expect(r.wants.slice(0, 4)).toEqual([[], [], [], [0n]]);
    for (const n of ['cat', 'any-neg', 'all-even', 'sorted', 'weighted']) {
      const args = n === 'cat' ? () => [[], []] : () => [[]];
      const d = await differential(prog, out, n, { n: 1, args });
      expect(d.mismatches, n).toEqual([]);
    }
  });

  const MUTS = [
    ['fold-index-shifted', ['argmax', 'weighted', 'idx-rec']],
    ['concat-second-dropped', ['cat', 'cat-rec', 'cat-sum']],
    ['range-from-one', ['rng', 'rng-sum']],
    ['any-all-swapped', ['any-neg', 'all-even', 'sorted']],
  ] as const;
  for (const [m, fns] of MUTS) {
    it(`mutation ${m} is detected`, async () => {
      const b = build(FIXTURE, '(policy)', { mutation: m });
      let caught = 0;
      for (const n of fns) {
        const d = await differential(b.prog, b.out, n, { n: 200, seed: 3 });
        if (d.mismatches.length) caught++;
      }
      expect(caught, m).toBeGreaterThan(0);
    });
  }

  it('mutation divMode trunc (rem_s without the floor correction) is detected for mod', async () => {
    const b = build(FIXTURE, '(policy)', { divMode: 'trunc' });
    let caught = 0;
    for (const n of ['mod-pos', 'mod-neg', 'mod-mixed', 'mod-wide']) {
      const d = await differential(b.prog, b.out, n, { n: 200, seed: 9 });
      if (d.mismatches.length) caught++;
    }
    expect(caught).toBe(4);
  });

  it('range is not compilable without the checker bound from the same program', () => {
    const f = compileProgram(prog, { ...res, rangeHi: new Map() }).fns.find((y) => y.name === 'rng')!;
    expect(f.compilable).toBe(false);
    expect(f.reason).toMatch(/no checker bound/);
  });
});

describe('wasm v2: any / all stop at the same element as the interpreter (effect logs)', () => {
  const POLICY = '(policy (allow audit) (sink audit (accepts internal)))';
  const FX = `
(type Ev (rec (v (Int -1000 1000))))
(fn seen-any (in (xs (List (Int -1000 1000) 0 12))) (out Bool) (needs audit)
  (any xs (fn (x) (do (emit audit (Ev x)) (> x 0)))))
(fn seen-all (in (xs (List (Int -1000 1000) 0 12))) (out Bool) (needs audit)
  (all xs (fn (x) (do (emit audit (Ev x)) (< x 500)))))
(program p (targets server) (entry seen-any (bind audit (audit))))`;
  const { prog, out } = build(FX, POLICY);
  for (const n of ['seen-any', 'seen-all']) {
    it(`${n}: same result and the same emitted events`, async () => {
      const d = await differentialEffects(prog, out, n, { n: 250 });
      expect(d.mismatches.slice(0, 3)).toEqual([]);
    });
  }
});
