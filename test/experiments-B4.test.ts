// B4 (import of untrusted records): both references must pass the hidden cases, and deliberately broken variants
// must be caught, with trap variants raising trapViolations. If a variant stops being caught, the hidden cases got weaker.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTask } from '../experiments/run.js';

const B4 = 'B4-record-import';
const B4_SIGIL = `experiments/tasks/${B4}/ref/sigil/app.sigil`;
const B4_TS = `experiments/tasks/${B4}/ref/ts/solution.ts`;
const tmp = mkdtempSync(join(tmpdir(), 'sigil-exp-b4-'));

interface Edit {
  from: string; // exact text in the reference, must occur exactly once
  to: string;
}
interface Variant {
  name: string;
  edits: Edit[];
  trap: boolean; // a trap case must fail
}

function variantFile(refPath: string, v: Variant, ext: string, idx: number): string {
  let src = readFileSync(refPath, 'utf8');
  for (const e of v.edits) {
    if (src.split(e.from).length !== 2) throw new Error(`variant "${v.name}": the reference must contain the text to replace exactly once: ${e.from}`);
    src = src.replace(e.from, e.to);
  }
  const file = join(tmp, `${ext}-${idx}.${ext === 'sigil' ? 'sigil' : 'ts'}`);
  writeFileSync(file, src);
  return file;
}

const SIGIL_VARIANTS: Variant[] = [
  { name: 'off-by-one: quantity 1000 is rejected', edits: [{ from: '(> r.quantity 1000)', to: '(>= r.quantity 1000)' }], trap: false },
  { name: 'off-by-one: price 1 cent is accepted as 0', edits: [{ from: '(< r.unitPrice 1)', to: '(< r.unitPrice 0)' }], trap: false },
  {
    name: 'wrong order: duplicate check before the already-imported check',
    edits: [
      {
        from: '(if (> (len (filter done (fn (i) (= i r.id)))) 0) AlreadyImported\n            (if (> (len (filter batch (fn (x) (= x.id r.id)))) 1) DuplicateInBatch\n              Accepted))',
        to: '(if (> (len (filter batch (fn (x) (= x.id r.id)))) 1) DuplicateInBatch\n            (if (> (len (filter done (fn (i) (= i r.id)))) 0) AlreadyImported\n              Accepted))',
      },
    ],
    trap: false,
  },
  { name: 'wrong order: price is checked before quantity', edits: [{ from: '(if (or (< r.quantity 1) (> r.quantity 1000)) BadQuantity\n      (if (or (< r.unitPrice 1) (> r.unitPrice 10000000)) BadPrice', to: '(if (or (< r.unitPrice 1) (> r.unitPrice 10000000)) BadPrice\n      (if (or (< r.quantity 1) (> r.quantity 1000)) BadQuantity' }], trap: false },
  { name: 'missing effect: no audit summary', edits: [{ from: '(emit audit (ImportSummary (len records) n (max 0 (sub (len records) n))))', to: '' }], trap: false },
  { name: 'missing effect: records are never stored', edits: [{ from: '(match (put store:records clean.id clean)\n          (ok _ Accepted)\n          (err _ StoreFailed))', to: 'Accepted' }], trap: false },
  { name: 'a failed store is still counted as imported', edits: [{ from: '(err _ StoreFailed))\n        v))', to: '(err _ Accepted))\n        v))' }], trap: false },
  { name: 'trap: duplicate ids inside one batch are not detected', edits: [{ from: '(> (len (filter batch (fn (x) (= x.id r.id)))) 1)', to: 'false' }], trap: true },
  { name: 'trap: quantity above 1000 is accepted (and clamped)', edits: [{ from: '(or (< r.quantity 1) (> r.quantity 1000))', to: '(< r.quantity 1)' }], trap: true },
  { name: 'trap: price above the maximum is accepted (and clamped)', edits: [{ from: '(or (< r.unitPrice 1) (> r.unitPrice 10000000))', to: '(< r.unitPrice 1)' }], trap: true },
  {
    name: 'trap: the note is stored with the clean record',
    edits: [
      { from: '(lineTotal (Int 1 10000000000))))', to: '(lineTotal (Int 1 10000000000)) (note Str :internal)))' },
      { from: '(mul q p))]', to: '(mul q p) r.note)]' },
    ],
    trap: true,
  },
];

const TS_VARIANTS: Variant[] = [
  { name: 'off-by-one: quantity 1000 is rejected', edits: [{ from: 'r.quantity > MAX_QUANTITY', to: 'r.quantity >= MAX_QUANTITY' }], trap: false },
  { name: 'off-by-one: price 1 cent is rejected', edits: [{ from: 'r.unitPrice < 1', to: 'r.unitPrice < 2' }], trap: false },
  {
    name: 'wrong order: duplicate check before the already-imported check',
    edits: [
      {
        from: "if (done.has(r.id)) return 'AlreadyImported';\n  if (records.filter((x) => x.id === r.id).length > 1) return 'DuplicateInBatch';",
        to: "if (records.filter((x) => x.id === r.id).length > 1) return 'DuplicateInBatch';\n  if (done.has(r.id)) return 'AlreadyImported';",
      },
    ],
    trap: false,
  },
  { name: 'wrong order: category is checked before price', edits: [{ from: "if (r.unitPrice < 1 || r.unitPrice > MAX_PRICE) return 'BadPrice';\n  if (r.category < 0 || r.category > 9) return 'UnknownCategory';", to: "if (r.category < 0 || r.category > 9) return 'UnknownCategory';\n  if (r.unitPrice < 1 || r.unitPrice > MAX_PRICE) return 'BadPrice';" }], trap: false },
  { name: 'missing effect: no audit summary', edits: [{ from: "await host.audit.emit('audit', { received: records.length, imported: ok, rejected: records.length - ok });", to: '' }], trap: false },
  { name: 'missing effect: no audit summary when nothing was imported', edits: [{ from: "await host.audit.emit('audit', { received: records.length, imported: ok, rejected: records.length - ok });", to: "if (ok > 0) await host.audit.emit('audit', { received: records.length, imported: ok, rejected: records.length - ok });" }], trap: false },
  { name: 'a failed store is still counted as imported', edits: [{ from: 'if (res.ok) ok++;\n    else counts.StoreFailed++;', to: 'ok++;' }], trap: false },
  { name: 'trap: duplicate ids inside one batch are not detected', edits: [{ from: "if (records.filter((x) => x.id === r.id).length > 1) return 'DuplicateInBatch';", to: '' }], trap: true },
  {
    name: 'trap: duplicate ids are handled first-wins instead of rejecting every copy',
    edits: [
      { from: "if (records.filter((x) => x.id === r.id).length > 1) return 'DuplicateInBatch';", to: "if (records.slice(0, records.indexOf(r)).some((x) => x.id === r.id)) return 'DuplicateInBatch';" },
    ],
    trap: true,
  },
  { name: 'trap: quantity above 1000 is accepted', edits: [{ from: 'r.quantity < 1 || r.quantity > MAX_QUANTITY', to: 'r.quantity < 1' }], trap: true },
  { name: 'trap: price above the maximum is accepted', edits: [{ from: 'r.unitPrice < 1 || r.unitPrice > MAX_PRICE', to: 'r.unitPrice < 1' }], trap: true },
  { name: 'trap: the note is stored with the clean record', edits: [{ from: 'lineTotal: r.quantity * r.unitPrice,', to: 'lineTotal: r.quantity * r.unitPrice,\n      note: r.note,' }], trap: true },
  { name: 'trap: the note leaks into the audit summary', edits: [{ from: 'rejected: records.length - ok }', to: 'rejected: records.length - ok, firstNote: records[0].note }' }], trap: true },
];

describe('experiments harness: B4 record import', () => {
  it('Sigil reference passes 100%', async () => {
    const s = await runTask(B4, 'sigil', B4_SIGIL);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(28);
    expect(s.trapTotal).toBeGreaterThanOrEqual(3);
    expect(s.trapViolations).toBe(0);
  }, 30_000);

  SIGIL_VARIANTS.forEach((v, i) => {
    it(`Sigil catches: ${v.name}`, async () => {
      const s = await runTask(B4, 'sigil', variantFile(B4_SIGIL, v, 'sigil', 100 + i));
      expect(s.passed).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations).toBeGreaterThan(0);
    }, 30_000);
  });

  it('TypeScript reference passes 100%', async () => {
    const s = await runTask(B4, 'ts', B4_TS);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.trapViolations).toBe(0);
  }, 30_000);

  it('TypeScript catches every broken variant (and flags trap violations)', async () => {
    const results = await Promise.all(TS_VARIANTS.map((v, i) => runTask(B4, 'ts', variantFile(B4_TS, v, 'ts', 100 + i))));
    results.forEach((s, i) => {
      const v = TS_VARIANTS[i];
      expect(s.passed, v.name).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations, v.name).toBeGreaterThan(0);
    });
  }, 60_000);
});
