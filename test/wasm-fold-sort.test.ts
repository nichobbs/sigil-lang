// Stage 5: fold, sort, take, drop, at and append compile to Wasm and agree with the interpreter on random inputs;
// compiler mutations of sort and fold are caught.

import { describe, expect, it } from 'vitest';
import { build, differential } from './helpers/wasm-diff.js';

const FIXTURE = `
(type Big   (Int 0 1000000000000))
(type W     (Int 0 1000))
(type Acc   (rec (n (Int 0 200)) (total Big) (top (Int 0 1000))))
(type Item  (rec (id (Int 0 1000)) (grp (Int 0 4)) (w (Int 0 1000))))

(fn total-of
  (in (xs (List (Int 0 1000) 0 100)))
  (out Big)
  (fold xs Big 0 (fn (acc x) (min 1000000000000 (add acc x)))))

(fn stats
  (in (xs (List (Int 0 1000) 0 100)))
  (out Acc)
  (fold xs Acc (Acc 0 0 0)
    (fn (a x) (Acc (min 200 (add a.n 1)) (min 1000000000000 (add a.total x)) (max a.top x)))))

(fn heaviest
  (in (xs (List Item 0 60)))
  (out (Int 0 1000))
  (fold xs W 7 (fn (acc i) (max acc i.w))))

(fn sorted-asc
  (in (xs (List (Int -1000 1000) 0 80)))
  (out (List (Int -1000 1000) 0 80))
  (sort xs (fn (a b) (< a b))))

(fn sorted-by-grp
  (in (xs (List Item 0 80)))
  (out (List Item 0 80))
  (sort xs (fn (a b) (< a.grp b.grp))))

(fn sorted-heavy-first
  (in (xs (List Item 0 80)))
  (out (List Item 0 80))
  (sort xs (fn (a b) (or (> a.w b.w) (and (= a.w b.w) (< a.id b.id))))))

(fn before-w (in (a Item) (b Item)) (out Bool) (< a.w b.w))

(fn sorted-via-call
  (in (xs (List Item 0 80)))
  (out (List Item 0 80))
  (sort xs (fn (a b) (before-w a b))))

(fn top3
  (in (xs (List Item 0 80)))
  (out (List Item 0 3))
  (take (sort xs (fn (a b) (> a.w b.w))) 3))

(fn median-w
  (in (xs (List (Int 0 1000) 1 99)))
  (out (Int 0 1000))
  (at (sort xs (fn (a b) (< a b))) (div-floor (len xs) 2) 0))

(fn drop-some
  (in (xs (List (Int 0 1000) 0 50)) (k (Int -5 60)))
  (out (List (Int 0 1000) 0 50))
  (drop xs k))

(fn take-some
  (in (xs (List Item 0 50)) (k (Int -5 60)))
  (out (List Item 0 50))
  (take xs k))

(fn at-or
  (in (xs (List Item 0 50)) (i (Int -3 60)) (d Item))
  (out Item)
  (at xs i d))

(fn push
  (in (xs (List (Int 0 1000) 0 50)) (x (Int 0 1000)))
  (out (List (Int 0 1000) 1 51))
  (append xs x))

(fn push-rec
  (in (xs (List Item 0 20)) (x Item))
  (out (Int 0 30000))
  (sum (map (append xs x) (fn (i) i.w))))

(fn sum-sorted-prefix
  (in (xs (List (Int 0 1000) 0 60)))
  (out Big)
  (fold (take (sort xs (fn (a b) (< a b))) 5) Big 0 (fn (acc x) (min 1000000000000 (add acc x)))))
`;

const FNS = ['total-of', 'stats', 'heaviest', 'sorted-asc', 'sorted-by-grp', 'sorted-heavy-first', 'sorted-via-call', 'top3', 'median-w', 'drop-some', 'take-some', 'at-or', 'push', 'push-rec', 'sum-sorted-prefix'];

describe('wasm fold, sort, take, drop, at, append', () => {
  const { prog, out } = build(FIXTURE);

  it('all fixture functions compile', () => {
    for (const n of FNS) {
      const r = out.fns.find((f) => f.name === n)!;
      expect(r.compilable, `${n}: ${r.reason}`).toBe(true);
    }
    expect(WebAssembly.validate(new Uint8Array(out.bytes))).toBe(true);
  });

  for (const n of FNS) {
    it(`${n}: agrees with the interpreter on 300 random inputs`, async () => {
      const d = await differential(prog, out, n, { n: 300, seed: 5150 });
      expect(d.mismatches.slice(0, 3)).toEqual([]);
    });
  }

  const MUTS = [
    ['sort-inverted', ['sorted-asc', 'sorted-by-grp']],
    ['sort-left-tail-dropped', ['sorted-asc', 'sorted-heavy-first']],
    ['fold-init-dropped', ['stats', 'heaviest', 'total-of']],
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
});
