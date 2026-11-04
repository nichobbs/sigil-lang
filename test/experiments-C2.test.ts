// Task C2 (sales report): both references must pass the hidden cases at 100%, and deliberately broken variants
// must be caught, with trap variants raising trapViolations. If a variant here stops being caught, the hidden
// cases got weaker. This task has no effects (a pure report), so there is no "missing effect" variant.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTask } from '../experiments/run.js';

const TASK = 'C2-sales-report';
const REF_SIGIL = `experiments/tasks/${TASK}/ref/sigil/app.sigil`;
const REF_TS = `experiments/tasks/${TASK}/ref/ts/solution.ts`;
const tmp = mkdtempSync(join(tmpdir(), 'sigil-exp-c2-'));

interface Variant {
  name: string;
  from: string; // exact text in the reference, must occur once
  to: string;
  trap: boolean; // a trap case must fail
}

function variantFile(refPath: string, v: Variant, ext: 'sigil' | 'ts', idx: number): string {
  const src = readFileSync(refPath, 'utf8');
  if (src.split(v.from).length !== 2) throw new Error(`variant "${v.name}": the reference must contain the text to replace exactly once`);
  const file = join(tmp, `${ext}-${idx}.${ext}`);
  writeFileSync(file, src.replace(v.from, v.to));
  return file;
}

const SIGIL_VARIANTS: Variant[] = [
  { name: 'trap: average is truncated instead of rounded half up', from: '(div-floor (add (mul 2 total) n)', to: '(div-floor (mul 2 total)', trap: true },
  { name: 'trap: average rounds half down', from: '(div-floor (add (mul 2 total) n)', to: '(div-floor (add (mul 2 total) (max 0 (sub n 1)))', trap: true },
  { name: 'trap: tie on revenue goes to the higher code', from: '(< d.code r.code)', to: '(> d.code r.code)', trap: true },
  { name: 'trap: refunded sales still counted in the count and the average', from: 'n (len ls)]', to: 'n (len (filter sales (fn (s) (in-scope s scope))))]', trap: true },
  { name: 'trap: refunded sales still compete for best product', from: 'n (best-product ls)', to: 'n (best-product (filter sales (fn (s) (in-scope s scope))))', trap: true },
  { name: 'wrong region: OnlyEast selects the West', from: '(OnlyEast (= s.region East))', to: '(OnlyEast (= s.region West))', trap: false },
  { name: 'off-by-one: a product with revenue of one cent cannot win', from: '(> r.rev 0)', to: '(> r.rev 1)', trap: false },
  { name: 'regional revenue ignores the scope and refunds', from: '(region-revenue ls North)', to: '(region-revenue sales North)', trap: false },
];

const TS_VARIANTS: Variant[] = [
  { name: 'trap: average is truncated instead of rounded half up', from: 'Math.floor((2 * total + n) / (2 * n))', to: 'Math.floor(total / n)', trap: true },
  { name: 'trap: average rounds half down', from: 'Math.floor((2 * total + n) / (2 * n))', to: 'Math.floor((2 * total + n - 1) / (2 * n))', trap: true },
  { name: 'trap: tie on revenue goes to the first product seen', from: 'rev > bestRev || (rev === bestRev && code < best)', to: 'rev > bestRev', trap: true },
  { name: 'trap: refunded sales still counted in the count and the average', from: 'const n = counted.length;', to: 'const n = sales.filter((s) => only === null || s.region === only).length;', trap: true },
  { name: 'trap: refunded sales still compete for best product', from: 'byProduct.set(s.product, (byProduct.get(s.product) ?? 0) + v);', to: 'byProduct.set(s.product, (byProduct.get(s.product) ?? 0) + v);\n  }\n  for (const s of sales.filter((x) => x.refunded && (only === null || x.region === only))) {\n    byProduct.set(s.product, (byProduct.get(s.product) ?? 0) + s.qty * s.unit);', trap: true },
  { name: 'wrong region: OnlyEast selects the West', from: "OnlyEast: 'East'", to: "OnlyEast: 'West'", trap: false },
  { name: 'off-by-one: a product with revenue of one cent cannot win', from: 'let bestRev = -1;', to: 'let bestRev = 1;', trap: false },
  { name: 'empty list: average divides by zero', from: 'const average = n === 0 ? 0 : ', to: 'const average = ', trap: false },
];

describe('C2 sales report: Sigil reference', () => {
  it('passes 100% with the expected shape of hidden cases', async () => {
    const s = await runTask(TASK, 'sigil', REF_SIGIL);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(28);
    expect(s.total).toBeLessThanOrEqual(45);
    expect(s.trapTotal).toBe(3);
    expect(s.trapViolations).toBe(0);
  }, 60_000);

  SIGIL_VARIANTS.forEach((v, i) => {
    it(`catches: ${v.name}`, async () => {
      const s = await runTask(TASK, 'sigil', variantFile(REF_SIGIL, v, 'sigil', i));
      expect(s.passed).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations).toBeGreaterThan(0);
      else expect(s.failures.length).toBeGreaterThan(0);
    }, 60_000);
  });
});

describe('C2 sales report: TypeScript reference', () => {
  it('passes 100%', async () => {
    const s = await runTask(TASK, 'ts', REF_TS);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.trapTotal).toBe(3);
    expect(s.trapViolations).toBe(0);
  }, 30_000);

  it('catches every broken variant (and flags trap violations)', async () => {
    const results = await Promise.all(TS_VARIANTS.map((v, i) => runTask(TASK, 'ts', variantFile(REF_TS, v, 'ts', i))));
    results.forEach((s, i) => {
      const v = TS_VARIANTS[i];
      expect(s.passed, v.name).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations, v.name).toBeGreaterThan(0);
      else expect(s.failures.length, v.name).toBeGreaterThan(0);
    });
  }, 30_000);
});
