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
  it('is conditional on callee contracts: allowing a negative Pct (a surcharge) breaks the proof', async () => {
    const bad = SRC.replace(/\(type Pct\s+\(Int 0 100\)\)/, '(type Pct (Int -50 100))');
    expect(bad).not.toBe(SRC);
    expect((await run(bad)).status).toBe('counterexample');
  });
  it('refutes an ensures that is too strong', async () => {
    const bad = SRC.replace('(ensures (<= out (gross ls)))', '(ensures (< out (gross ls)))');
    const r = await run(bad);
    expect(r.status).toBe('counterexample');
    expect(r.note).toContain('Free');
  }, 30000);
  it('reports unsupported rather than guessing outside the fragment', async () => {
    const r = (await proveEnsures(parseProgram(SRC.replace('(ensures (<= out (gross ls)))', '(ensures (<= out (sum (map ls (fn (l) l.unit)))))')))).find((x) => x.fn === 'price-invoice')!;
    expect(r.status).toBe('unsupported');
  });
});
