import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/parse.js';
import { proveEnsures } from '../src/smt.js';

const PRELUDE = `
(type Line (rec (unit (Int 0 1000)) (qty (Int 1 100))))
(fn gross
  (in (ls (List Line 1 4)))
  (out (Int 0 1000000))
  (sum (map ls (fn (l) (mul l.unit l.qty)))))
`;
const run = async (src: string, fn: string, maxList?: number) =>
  (await proveEnsures(parseProgram(PRELUDE + src), undefined, { maxList })).find((r) => r.fn === fn)!;

describe('SMT over bounded lists', () => {
  it('proves a non-negativity ensures through sum/map (gross is inlined)', async () => {
    const r = await run(`(fn g (in (ls (List Line 1 4))) (out (Int 0 1000000)) (ensures (>= out 0)) (gross ls))`, 'g');
    expect(r.status).toBe('proved');
    expect(r.note).toContain('inlined');
  });
  it('proves gross of a filtered sublist is at most gross of the list', async () => {
    const r = await run(
      `(fn g (in (ls (List Line 1 4))) (out (Int 0 1000000)) (ensures (<= out (gross ls)))
         (gross (filter ls (fn (l) (> l.qty 1)))))`,
      'g',
    );
    expect(r.status).toBe('proved');
  });
  it('proves len bounds: len of a filter is at most len, and at most the declared max', async () => {
    const body = (cmp: string) =>
      `(fn c (in (ls (List Line 1 4))) (out (Int 0 4)) (ensures ${cmp}) (len (filter ls (fn (l) (> l.qty 1)))))`;
    expect((await run(body('(<= out (len ls))'), 'c')).status).toBe('proved');
    expect((await run(body('(<= out 4)'), 'c')).status).toBe('proved');
  });
  it('refutes a too-strong list ensures with a concrete list', async () => {
    const r = await run(`(fn c (in (ls (List Line 1 4))) (out (Int 0 4)) (ensures (<= out 3)) (len ls))`, 'c');
    expect(r.status).toBe('counterexample');
    expect(r.note).toContain('exact, no abstraction');
    expect(r.note).toMatch(/ls=\[(\{[^}]*\}(, )?){4}\]/); // only a 4-element list breaks it
  });
  it('refutes a strict gross inequality for a filtered sublist', async () => {
    const r = await run(
      `(fn g (in (ls (List Line 1 4))) (out (Int 0 1000000)) (ensures (< out (gross ls)))
         (gross (filter ls (fn (l) (> l.qty 1)))))`,
      'g',
    );
    expect(r.status).toBe('counterexample');
  });
  it('stays unsupported when elements of a list above the bound are needed', async () => {
    const big = `(fn s (in (ls (List Line 1 200))) (out (Int 0 100000000)) (ensures (>= out 0)) (sum (map ls (fn (l) (mul l.unit l.qty)))))`;
    expect((await run(big, 's')).status).toBe('unsupported');
    // len alone needs no elements, and is provable at any size.
    const len = `(fn n (in (ls (List Line 1 200))) (out (Int 1 200)) (ensures (>= out 1)) (len ls))`;
    expect((await run(len, 'n')).status).toBe('proved');
  });
  it('falls back to a sound abstraction (callee range) when a call cannot be inlined', async () => {
    // gross is declared for List 1 4 but ls is List 1 200: inlining fails on sum, abstraction gives gross >= 0.
    const r = await run(`(fn s (in (ls (List Line 1 200))) (out (Int 0 100000000)) (ensures (>= out 0)) (gross ls))`, 's');
    expect(r.status).toBe('proved');
    expect(r.note).toContain('1 abstracted');
  });
  it("does not assume the function's own output range", async () => {
    const r = await run(`(fn g (in (ls (List Line 1 4))) (out (Int 0 10)) (ensures (<= out 10)) (gross ls))`, 'g');
    expect(r.status).toBe('counterexample');
  });
});
