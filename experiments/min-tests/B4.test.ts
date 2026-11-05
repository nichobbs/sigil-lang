// Tests for B4 import-batch: examples, always properties, privacy, integer boundaries.
import { describe, expect, it } from 'vitest';
import { makeHost } from './host';
import run from './solution';

interface Raw { id: number; quantity: number; unitPrice: number; category: number; note: string }
const MAXID = 9_007_199_254_740_991;
const raw = (id: number, quantity: number, unitPrice: number, category: number, note = 'n'): Raw => ({ id, quantity, unitPrice, category, note });
const go = async (records: Raw[], imported: number[] = [], failStore = false) => {
  const { host, effects } = makeHost({ fail: failStore ? [{ handle: 'store:records', op: 'put' }] : [] });
  const report = await run({ records, imported }, host);
  return { report, ...effects() };
};
const rep = (o: Partial<Record<string, number>>) => ({ imported: 0, badId: 0, badQuantity: 0, badPrice: 0, unknownCategory: 0, alreadyImported: 0, duplicateInBatch: 0, storeFailed: 0, ...o });
const clean = (id: number, quantity: number, unitPrice: number, category: number) => ({ id, quantity, unitPrice, category, lineTotal: quantity * unitPrice });

let s = 12345;
const rnd = () => {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const val = (lo: number, hi: number, edges: number[]) => (rnd() < 0.4 ? edges[int(0, edges.length - 1)]! : int(lo, hi));
const genRaw = (idHi = 30): Raw =>
  raw(
    rnd() < 0.1 ? val(-MAXID, MAXID, [-MAXID, 0, 1, MAXID]) : int(-3, idHi),
    val(-1_000_000, 1_000_000, [-1_000_000, 0, 1, 1000, 1001, 1_000_000]),
    val(-1e12, 1e12, [-1e12, 0, 1, 10_000_000, 10_000_001, 1e12]),
    val(-1000, 1000, [-1000, -1, 0, 9, 10, 1000]),
    'secret-' + int(0, 1e9),
  );
const valid = (r: Raw) => r.id >= 1 && r.quantity >= 1 && r.quantity <= 1000 && r.unitPrice >= 1 && r.unitPrice <= 10_000_000 && r.category >= 0 && r.category <= 9;

describe('examples', () => {
  const cases: [string, Raw[], number[], boolean, ReturnType<typeof rep>, unknown[]][] = [
    ['clean batch', [raw(11, 3, 1250, 4, 'call me on 0412 345 678'), raw(12, 10, 99, 0)], [], false, rep({ imported: 2 }), [clean(11, 3, 1250, 4), { ...clean(12, 10, 99, 0), lineTotal: 990 }]],
    ['clean fields', [raw(21, 2, 500, 9, 'fragile')], [], false, rep({ imported: 1 }), [clean(21, 2, 500, 9)]],
    ['bad quantity', [raw(31, 0, 400, 2), raw(32, 5, 400, 2)], [], false, rep({ imported: 1, badQuantity: 1 }), [clean(32, 5, 400, 2)]],
    ['bad price', [raw(41, 5, 0, 2)], [], false, rep({ badPrice: 1 }), []],
    ['unknown category', [raw(51, 5, 300, 12)], [], false, rep({ unknownCategory: 1 }), []],
    ['already imported', [raw(62, 1, 800, 1), raw(63, 1, 800, 1)], [61, 62], false, rep({ imported: 1, alreadyImported: 1 }), [clean(63, 1, 800, 1)]],
    ['store failed', [raw(71, 1, 800, 1)], [], true, rep({ storeFailed: 1 }), []],
  ];
  it.each(cases)('%s', async (_n, records, imported, fail, report, stored) => {
    const r = await go(records, imported, fail);
    expect(r.report).toEqual(report);
    expect(r.stored).toEqual(stored);
    expect(r.emitted).toEqual([{ received: records.length, imported: report.imported, rejected: records.length - report.imported }]);
  });
});

describe('always', () => {
  it('validity, reason order, and stored clean records', async () => {
    for (let i = 0; i < 400; i++) {
      const r = genRaw();
      const out = await go([r]);
      const q = r.quantity >= 1 && r.quantity <= 1000;
      const p = r.unitPrice >= 1 && r.unitPrice <= 10_000_000;
      const expected = rep(
        r.id < 1 ? { badId: 1 } : !q ? { badQuantity: 1 } : !p ? { badPrice: 1 } : r.category < 0 || r.category > 9 ? { unknownCategory: 1 } : { imported: 1 },
      );
      expect(out.report).toEqual(expected);
      expect(out.stored).toEqual(valid(r) ? [clean(r.id, r.quantity, r.unitPrice, r.category)] : []);
    }
  });

  it('already imported unless an earlier check fails', async () => {
    for (let i = 0; i < 400; i++) {
      const r = genRaw();
      const e = rnd() < 0.5 ? r.id : genRaw().id;
      const out = await go([r], [e]);
      expect(out.report.alreadyImported === 1).toBe(e === r.id && valid(r));
    }
  });

  it('duplicate ids in a batch', async () => {
    for (let i = 0; i < 300; i++) {
      const k = int(1, 1_000_000);
      const out = await go([raw(k, 1, 100, 0), raw(k, 2, 200, 1), raw(k + 1, 3, 300, 2)]);
      expect(out.report).toEqual(rep({ duplicateInBatch: 2, imported: 1 }));
      expect(out.stored).toEqual([clean(k + 1, 3, 300, 2)]);
    }
  });

  it('duplicates count invalid copies; earlier reasons win; none imported', async () => {
    const out = await go([raw(5, 1, 100, 0), raw(5, 0, 100, 0), raw(6, 1, 100, 0), raw(6, 1, 100, 0)], [6]);
    expect(out.report).toEqual(rep({ duplicateInBatch: 1, badQuantity: 1, alreadyImported: 2 }));
    expect(out.stored).toEqual([]);
  });

  it('every record is accounted for exactly once', async () => {
    for (let i = 0; i < 300; i++) {
      const records = Array.from({ length: int(1, 20) }, () => genRaw(int(1, 25)));
      const imported = Array.from({ length: int(0, 40) }, () => int(-2, 25));
      const out = await go(records, imported, rnd() < 0.3);
      expect(Object.values(out.report).reduce((a, b) => a + b, 0)).toBe(records.length);
      expect(out.report.imported).toBe(out.stored.length);
      expect(out.emitted).toEqual([{ received: records.length, imported: out.stored.length, rejected: records.length - out.stored.length }]);
    }
  });
});

describe('privacy', () => {
  it('note never reaches store, audit or any other effect', async () => {
    for (let i = 0; i < 120; i++) {
      const marker = `NOTE-${int(0, 1e9)}-secret`;
      const records = Array.from({ length: int(1, 20) }, () => ({ ...genRaw(), note: marker }));
      const out = await go(records, [], rnd() < 0.3);
      expect(JSON.stringify([out.stored, out.emitted, out.sent, out.report])).not.toContain(marker);
      for (const c of out.stored) expect(Object.keys(c as object).sort()).toEqual(['category', 'id', 'lineTotal', 'quantity', 'unitPrice']);
      for (const e of out.emitted) expect(Object.keys(e as object).sort()).toEqual(['imported', 'received', 'rejected']);
      expect(out.sent).toEqual([]);
    }
  });
});

describe('integer boundaries', () => {
  const good = raw(1, 1, 1, 0);
  it.each([
    ['id min valid', { ...good, id: 1 }, { imported: 1 }],
    ['id zero', { ...good, id: 0 }, { badId: 1 }],
    ['id min raw', { ...good, id: -MAXID }, { badId: 1 }],
    ['id max', { ...good, id: MAXID }, { imported: 1 }],
    ['quantity min', { ...good, quantity: 1 }, { imported: 1 }],
    ['quantity below', { ...good, quantity: 0 }, { badQuantity: 1 }],
    ['quantity max', { ...good, quantity: 1000 }, { imported: 1 }],
    ['quantity above', { ...good, quantity: 1001 }, { badQuantity: 1 }],
    ['quantity raw extremes', { ...good, quantity: -1_000_000 }, { badQuantity: 1 }],
    ['quantity raw max', { ...good, quantity: 1_000_000 }, { badQuantity: 1 }],
    ['price below', { ...good, unitPrice: 0 }, { badPrice: 1 }],
    ['price max', { ...good, unitPrice: 10_000_000 }, { imported: 1 }],
    ['price above', { ...good, unitPrice: 10_000_001 }, { badPrice: 1 }],
    ['price raw min', { ...good, unitPrice: -1e12 }, { badPrice: 1 }],
    ['price raw max', { ...good, unitPrice: 1e12 }, { badPrice: 1 }],
    ['category below', { ...good, category: -1 }, { unknownCategory: 1 }],
    ['category max', { ...good, category: 9 }, { imported: 1 }],
    ['category above', { ...good, category: 10 }, { unknownCategory: 1 }],
    ['category raw extremes', { ...good, category: -1000 }, { unknownCategory: 1 }],
    ['category raw max', { ...good, category: 1000 }, { unknownCategory: 1 }],
  ])('%s', async (_n, r, report) => {
    expect((await go([r])).report).toEqual(rep(report));
  });

  it('line total at the maximum is exact; max id is deduplicated and already-imported', async () => {
    const r = raw(MAXID, 1000, 10_000_000, 9);
    expect((await go([r])).stored).toEqual([{ id: MAXID, quantity: 1000, unitPrice: 10_000_000, category: 9, lineTotal: 10_000_000_000 }]);
    expect((await go([r], [MAXID])).report).toEqual(rep({ alreadyImported: 1 }));
    expect((await go([r, { ...r }])).report).toEqual(rep({ duplicateInBatch: 2 }));
    expect((await go([raw(MAXID - 1, 1, 1, 0), r])).report).toEqual(rep({ imported: 2 }));
  });
});
