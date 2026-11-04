// C3 catalogue search: both references must score 100%, and deliberately broken variants must be caught
// (trap variants must raise trapViolations). If a variant stops being caught, the hidden cases got weaker.
// This task has no rounding and no effects, so the "wrong rounding" and "missing effect" variants of the other tasks
// are replaced by wrong filter limits, wrong paging arithmetic and a wrong sort tie-break.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTask } from '../experiments/run.js';

const TASK = 'C3-catalogue-search';
const REF_SIGIL = `experiments/tasks/${TASK}/ref/sigil/app.sigil`;
const REF_TS = `experiments/tasks/${TASK}/ref/ts/solution.ts`;
const tmp = mkdtempSync(join(tmpdir(), 'sigil-exp-c3-'));

interface Variant {
  name: string;
  from: string; // exact text in the reference
  to: string;
  trap: boolean; // a trap case must fail
}

function variantFile(refPath: string, v: Variant, ext: 'sigil' | 'ts', idx: number): string {
  const src = readFileSync(refPath, 'utf8');
  if (src.split(v.from).length !== 2) throw new Error(`variant "${v.name}": the reference must contain the text to replace exactly once`);
  const file = join(tmp, `c3-${idx}.${ext}`);
  writeFileSync(file, src.replace(v.from, v.to));
  return file;
}

const SIGIL_VARIANTS: Variant[] = [
  { name: 'off-by-one: minimum price is exclusive', from: '(<= q.minPrice i.price q.maxPrice)', to: '(and (< q.minPrice i.price) (<= i.price q.maxPrice))', trap: false },
  { name: 'off-by-one: maximum price is exclusive', from: '(<= q.minPrice i.price q.maxPrice)', to: '(and (<= q.minPrice i.price) (< i.price q.maxPrice))', trap: false },
  { name: 'off-by-one: minimum rating is exclusive', from: '(>= i.rating q.minRating)', to: '(> i.rating q.minRating)', trap: false },
  { name: 'in stock means stock of at least 2', from: '(> i.stock 0)', to: '(> i.stock 1)', trap: false },
  { name: 'anyCategory is ignored', from: '(or q.anyCategory (= i.category q.category))', to: '(= i.category q.category)', trap: false },
  { name: 'PriceAsc ties go to the larger id', from: '(PriceAsc (or (< a.price b.price) (and (= a.price b.price) (< a.id b.id))))', to: '(PriceAsc (or (< a.price b.price) (and (= a.price b.price) (> a.id b.id))))', trap: false },
  { name: 'page numbers count from 1', from: '(mul query.page query.pageSize)', to: '(mul (max 0 (sub query.page 1)) query.pageSize)', trap: false },
  { name: 'trap: descending sorts break ties by larger id', from: '(PriceDesc (or (> a.price b.price) (and (= a.price b.price) (< a.id b.id))))', to: '(PriceDesc (or (> a.price b.price) (and (= a.price b.price) (> a.id b.id))))', trap: true },
  { name: 'trap: hidden items are searched', from: '(and (not i.hidden)\n', to: '(and true\n', trap: true },
  { name: 'trap: has-more is true when the page is full', from: '(< (add start query.pageSize) (len found))', to: '(= (len (filter slots (fn (s) (> s 0)))) query.pageSize)', trap: true },
  { name: 'trap: has-more is true on an exactly full last page (<= instead of <)', from: '(< (add start query.pageSize) (len found))', to: '(<= (add start query.pageSize) (len found))', trap: true },
];

const TS_VARIANTS: Variant[] = [
  { name: 'off-by-one: minimum price is exclusive', from: 'i.price >= q.minPrice &&', to: 'i.price > q.minPrice &&', trap: false },
  { name: 'off-by-one: maximum price is exclusive', from: 'i.price <= q.maxPrice &&', to: 'i.price < q.maxPrice &&', trap: false },
  { name: 'off-by-one: minimum rating is exclusive', from: 'i.rating >= q.minRating &&', to: 'i.rating > q.minRating &&', trap: false },
  { name: 'in stock means stock of at least 2', from: '(!q.inStockOnly || i.stock > 0)', to: '(!q.inStockOnly || i.stock > 1)', trap: false },
  { name: 'anyCategory is ignored', from: '(q.anyCategory || i.category === q.category)', to: 'i.category === q.category', trap: false },
  { name: 'PriceAsc ties go to the larger id', from: 'return a.price - b.price || byId;', to: 'return a.price - b.price || -byId;', trap: false },
  { name: 'page numbers count from 1', from: 'const start = query.page * query.pageSize;', to: 'const start = Math.max(0, query.page - 1) * query.pageSize;', trap: false },
  { name: 'trap: descending sorts break ties by larger id', from: 'return b.price - a.price || byId;', to: 'return b.price - a.price || -byId;', trap: true },
  { name: 'trap: hidden items are searched', from: '!i.hidden &&', to: 'true &&', trap: true },
  { name: 'trap: has-more is true when the page is full', from: 'hasMore: start + query.pageSize < found.length,', to: 'hasMore: found.slice(start, start + query.pageSize).length === query.pageSize,', trap: true },
  { name: 'trap: has-more is true on an exactly full last page (<= instead of <)', from: 'hasMore: start + query.pageSize < found.length,', to: 'hasMore: start + query.pageSize <= found.length,', trap: true },
];

describe('experiments harness: C3 catalogue search (Sigil)', () => {
  it('reference solution passes 100%', async () => {
    const s = await runTask(TASK, 'sigil', REF_SIGIL);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(28);
    expect(s.total).toBeLessThanOrEqual(45);
    expect(s.trapTotal).toBe(3);
    expect(s.trapViolations).toBe(0);
  });

  SIGIL_VARIANTS.forEach((v, i) => {
    it(`catches: ${v.name}`, async () => {
      const s = await runTask(TASK, 'sigil', variantFile(REF_SIGIL, v, 'sigil', i));
      expect(s.passed).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations).toBeGreaterThan(0);
    });
  });
});

describe('experiments harness: C3 catalogue search (TypeScript)', () => {
  it('reference solution passes 100%', async () => {
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
    });
  }, 30_000);
});
