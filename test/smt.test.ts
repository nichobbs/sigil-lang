import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseProgram } from '../src/parse.js';
import { proveEnsures } from '../src/smt.js';

const SRC = readFileSync('examples/invoicing/app.sigil', 'utf8');
const run = (src: string) => proveEnsures(parseProgram(src)).then((r) => r.find((x) => x.fn === 'price-invoice')!);

describe('SMT discharge of relational ensures', () => {
  it('proves out <= gross ls for price-invoice', async () => {
    expect((await run(SRC)).status).toBe('proved');
  });
  it('inlines discount, so a negative rate (a surcharge) in its body breaks the proof', async () => {
    const bad = SRC.replace('(Free 0)', '(Free -50)');
    expect(bad).not.toBe(SRC);
    const r = await run(bad);
    expect(r.status).toBe('counterexample');
    expect(r.note).toContain('p=Free');
  });
  it('refutes an ensures that is too strong', async () => {
    const bad = SRC.replace('(ensures (<= out (gross ls)))', '(ensures (< out (gross ls)))');
    const r = await run(bad);
    expect(r.status).toBe('counterexample');
    expect(r.note).toMatch(/p=(Free|Pro|Enterprise)/);
  }, 30000);
  it('reports unsupported rather than guessing outside the fragment', async () => {
    const r = (await proveEnsures(parseProgram(SRC.replace('(ensures (<= out (gross ls)))', '(ensures (<= out (sum (map ls (fn (l) l.unit)))))')))).find((x) => x.fn === 'price-invoice')!;
    expect(r.status).toBe('unsupported');
  });
});
