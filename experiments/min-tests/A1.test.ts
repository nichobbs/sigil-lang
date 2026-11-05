// Tests for A1 tiered pricing: examples, always-properties, privacy, range boundaries.
import { describe, expect, it } from 'vitest';
import { makeHost } from './host';
import run from './solution';

type Tier = 'Standard' | 'Silver' | 'Gold';
interface Line {
  sku: string;
  unit: number;
  qty: number;
}
interface Cust {
  id: number;
  name: string;
  email: string;
  tier: Tier;
  credit: number;
}

const MAX_ID = 9_007_199_254_740_991;
const LIMIT = 5_000_000;
const TIERS: Tier[] = ['Standard', 'Silver', 'Gold'];

const prng = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
type Rnd = () => number;
const int = (r: Rnd, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rnd, xs: T[]) => xs[int(r, 0, xs.length - 1)] as T;
const genLine = (r: Rnd): Line => ({
  sku: 'S',
  unit: Math.min(10_000_000, int(r, 0, 10 ** int(r, 0, 7))),
  qty: r() < 0.3 ? pick(r, [1, 9, 10, 49, 50, 199, 200, 1000]) : int(r, 1, 1000),
});
const genLines = (r: Rnd) =>
  Array.from({ length: r() < 0.5 ? int(r, 1, 3) : int(r, 1, 50) }, () => (r() < 0.7 ? { ...genLine(r), qty: int(r, 1, 60) } : genLine(r)));
const genCust = (r: Rnd): Cust => ({
  id: int(r, 0, 1000),
  name: `nm${int(r, 0, 1e9)}`,
  email: `em${int(r, 0, 1e9)}@x.io`,
  tier: pick(r, TIERS),
  credit: pick(r, [0, 1_000_000_000_000, int(r, 0, 1_000_000_000_000), int(r, 0, 10_000)]),
});
const gross = (ls: Line[]) => ls.reduce((s, l) => s + l.unit * l.qty, 0);
const vpct = (q: number) => (q >= 200 ? 15 : q >= 50 ? 10 : q >= 10 ? 5 : 0);

const go = async (id: number, cust: Cust, lines: Line[], failStore = false) => {
  const { host, effects } = makeHost(failStore ? { fail: [{ handle: 'store:quotes', op: 'put' }] } : {});
  const result = await run({ id, cust, lines }, host);
  return { result, ...effects() };
};
const cust = (tier: Tier, credit: number): Cust => ({ id: 7, name: 'Ada', email: 'a@e.com', tier, credit });
const L = (unit: number, qty: number): Line => ({ sku: 'W-1', unit, qty });

describe('examples and rule tables', () => {
  const rows: [number, Tier, number, Line[], number, number, number, number][] = [
    [1, 'Standard', 0, [L(1000, 2)], 2000, 2000, 0, 2000],
    [2, 'Standard', 0, [L(1000, 10)], 10000, 9500, 0, 9500],
    [3, 'Standard', 0, [L(333, 10)], 3330, 3163, 0, 3163],
    [4, 'Gold', 0, [L(1000, 10)], 10000, 8550, 0, 8550],
    [5, 'Silver', 500, [L(1000, 4)], 4000, 3800, 500, 3300],
    [6, 'Standard', 0, [L(500, 1)], 500, 500, 0, 500],
    [9, 'Silver', 0, [L(10000, 1)], 10000, 9500, 0, 9500],
    [10, 'Gold', 0, [L(10000, 1)], 10000, 9000, 0, 9000],
    ...[1, 9, 10, 49, 50, 199, 200, 1000].map(
      (q): [number, Tier, number, Line[], number, number, number, number] => [
        11, 'Standard', 0, [L(100, q)], 100 * q, q * (100 - vpct(q)), 0, q * (100 - vpct(q)),
      ],
    ),
    [12, 'Gold', 0, [L(5000, 1000)], LIMIT, 4_000_000, 0, 4_000_000],
  ];
  it.each(rows)('quote %i', async (id, tier, credit, lines, g, total, used, due) => {
    const c = cust(tier, credit);
    const q = { id, cust: 7, gross: g, total, creditUsed: used, due };
    const r = await go(id, c, lines);
    expect(r.result).toEqual({ ok: q });
    expect(r.stored).toEqual([q]);
    expect(r.emitted).toEqual([{ id, cust: 7, due }]);
  });

  it('refused above the limit stores nothing and audits refusal', async () => {
    const r = await go(7, cust('Standard', 0), [L(6_000_000, 1)]);
    expect(r.result).toEqual({ err: 'NeedsApproval' });
    expect(r.stored).toEqual([]);
    expect(r.emitted).toEqual([{ id: 7, cust: 7 }]);
  });

  it('store failure is reported and nothing is audited', async () => {
    const r = await go(8, cust('Standard', 0), [L(500, 1)], true);
    expect(r.result).toEqual({ err: 'StoreFailed' });
    expect(r.stored).toEqual([]);
    expect(r.emitted).toEqual([]);
  });
});

describe('always properties', () => {
  const cases = (seed: number, gen: (r: Rnd) => [Cust, Line[]]) => {
    const r = prng(seed);
    return Array.from({ length: 400 }, () => gen(r));
  };
  const free = (r: Rnd): [Cust, Line[]] => [genCust(r), genLines(r)];

  it('single-line standard total is floor(gross * (100 - volume%) / 100)', async () => {
    const r = prng(1);
    for (let i = 0; i < 400; i++) {
      const l = genLine(r);
      const { result } = await go(1, cust('Standard', 0), [l]);
      if (l.unit * l.qty > LIMIT) continue;
      expect(result).toMatchObject({ ok: { total: Math.floor((l.unit * l.qty * (100 - vpct(l.qty))) / 100) } });
    }
  });

  it('total is within [ceil(80% gross), gross]', async () => {
    for (const [c, ls] of cases(2, free)) {
      const { result } = await go(1, c, ls);
      const g = gross(ls);
      const q = result.ok;
      if (q) expect(q.total <= g && q.total * 100 >= g * 80).toBe(true);
    }
  });

  it('credit used is min(credit, total) and due is never negative', async () => {
    for (const [c, ls] of cases(3, free)) {
      const { result } = await go(1, c, ls);
      const q = result.ok;
      if (q) {
        expect(q.creditUsed).toBe(Math.min(c.credit, q.total));
        expect(q.due).toBe(q.total - q.creditUsed);
      }
    }
  });

  it('refused exactly when gross exceeds the limit, with refusal audited and nothing stored', async () => {
    let refused = 0;
    for (const [c, ls] of cases(4, free)) {
      const r = await go(1, c, ls);
      const over = gross(ls) > LIMIT;
      refused += over ? 1 : 0;
      expect('err' in r.result).toBe(over);
      expect(r.stored.length).toBe(over ? 0 : 1);
      expect(r.emitted).toEqual([over ? { id: 1, cust: c.id } : { id: 1, cust: c.id, due: (r.stored[0] as { due: number } | undefined)?.due }]);
    }
    expect(refused).toBeGreaterThan(10);
  });
});

describe('privacy', () => {
  it.each(['name', 'email'] as const)('%s never reaches storage or audit', async (field) => {
    const r = prng(5);
    for (let i = 0; i < 100; i++) {
      const c = genCust(r);
      const ls = genLines(r);
      const a = await go(1, { ...c, [field]: 'SECRET-A' }, ls);
      const b = await go(1, { ...c, [field]: 'SECRET-B' }, ls);
      expect(a.result).toEqual(b.result);
      expect(a.stored).toEqual(b.stored);
      expect(a.emitted).toEqual(b.emitted);
      expect(JSON.stringify([a.stored, a.emitted, a.sent])).not.toContain('SECRET');
    }
  });
});

describe('range boundaries', () => {
  it('limit is inclusive and one past is refused', async () => {
    const ok = await go(1, cust('Standard', 0), [L(LIMIT, 1)]);
    expect(ok.result).toMatchObject({ ok: { gross: LIMIT, total: LIMIT, due: LIMIT } });
    const over = await go(1, cust('Standard', 0), [L(LIMIT + 1, 1)]);
    expect(over.result).toEqual({ err: 'NeedsApproval' });
  });

  it('maximum ids and credit pass through exactly; zero price gives zero', async () => {
    const c = { ...cust('Gold', 1_000_000_000_000), id: MAX_ID };
    const g = await go(MAX_ID, c, [L(5000, 1000)]);
    const q = { id: MAX_ID, cust: MAX_ID, gross: LIMIT, total: 4_000_000, creditUsed: 4_000_000, due: 0 };
    expect(g.result).toEqual({ ok: q });
    expect(g.stored).toEqual([q]);
    expect(g.emitted).toEqual([{ id: MAX_ID, cust: MAX_ID, due: 0 }]);
    const z = await go(0, { ...c, credit: 0, id: 0 }, [L(0, 1)]);
    expect(z.result).toEqual({ ok: { id: 0, cust: 0, gross: 0, total: 0, creditUsed: 0, due: 0 } });
  });

  it('maximum order size (50 lines of max unit and qty) is refused without overflow', async () => {
    const r = await go(1, cust('Gold', 0), Array.from({ length: 50 }, () => L(10_000_000, 1000)));
    expect(r.result).toEqual({ err: 'NeedsApproval' });
    expect(r.emitted).toEqual([{ id: 1, cust: 7 }]);
    expect(r.stored).toEqual([]);
  });
});
