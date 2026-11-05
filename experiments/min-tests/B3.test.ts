// Tests for solution.ts: intent.feature examples, glossary properties, card privacy, range boundaries.
import { describe, expect, it } from 'vitest';
import { makeHost } from './host';
import run from './solution';

type Role = 'Support' | 'Manager' | 'Admin';
type Status = 'Settled' | 'Disputed' | 'Voided';
type Reason = 'Duplicate' | 'Defective' | 'Goodwill' | 'Fraud';
interface Case {
  actor: { id: number; role: Role };
  payment: { id: number; amount: number; refunded: number; status: Status; card: string };
  amount: number;
  reason: Reason;
}
const MAX = 1_000_000_000_000;
const ROLES: Role[] = ['Support', 'Manager', 'Admin'];
const STATUSES: Status[] = ['Settled', 'Disputed', 'Voided'];
const REASONS: Reason[] = ['Duplicate', 'Defective', 'Goodwill', 'Fraud'];
const CAP: Record<Role, number> = { Support: 20000, Manager: 100000, Admin: 1000000 };

const mk = (role: Role, status: Status, amount: number, refunded: number, m: number, reason: Reason = 'Goodwill', card = '4242'): Case => ({
  actor: { id: 11, role },
  payment: { id: 5001, amount, refunded, status, card },
  amount: m,
  reason,
});

const go = async (c: Case, fail = false) => {
  const { host, effects } = makeHost(fail ? { fail: [{ handle: 'store:payments', op: 'put' }] } : {});
  const res = (await run(c, host)) as { ok?: { payment: number; refund: number; refunded: number; remaining: number }; err?: string };
  return { res, stored: effects().stored, emitted: effects().emitted };
};

let seed = 12345;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const int = (hi: number) => Math.floor(rnd() * (hi + 1));
const edge = [0, 1, 2, 19999, 20000, 20001, 99999, 100000, 100001, 999999, 1000000, 1000001, MAX - 1, MAX];
const money = () => (rnd() < 0.4 ? pick(edge) : int(pick([100, 50000, 2000000, MAX])));
const gen = (): Case => {
  const amount = money();
  const refunded = pick([0, amount, int(amount)]);
  const rem = amount - refunded;
  const m = rnd() < 0.4 ? Math.min(MAX, Math.max(0, rem + pick([-1, 0, 1]))) : money();
  const ids = [0, 9007199254740991, int(9007199254740991)];
  return {
    actor: { id: pick(ids), role: pick(ROLES) },
    payment: { id: int(9007199254740991), amount, refunded, status: pick(STATUSES), card: String(int(9999)).padStart(4, '0') },
    amount: m,
    reason: pick(REASONS),
  };
};
const forAll = async (f: (c: Case) => Promise<void>) => {
  for (let i = 0; i < 400; i++) await f(gen());
};
const settled = (c: Case, role: Role, m = c.amount): Case => ({ ...c, actor: { id: 1, role }, payment: { ...c.payment, status: 'Settled' }, amount: m });

describe('examples', () => {
  const rows: [Role, Status, number, number, number, Reason, string, number | string, boolean?][] = [
    ['Support', 'Settled', 15000, 0, 6000, 'Defective', '4242', 9000],
    ['Support', 'Settled', 15000, 6000, 9000, 'Duplicate', '4242', 0],
    ['Manager', 'Settled', 80000, 0, 75000, 'Goodwill', '0007', 5000],
    ['Admin', 'Settled', 500000, 0, 400000, 'Fraud', '1111', 100000],
    ['Manager', 'Disputed', 30000, 0, 30000, 'Fraud', '9999', 0],
    ['Support', 'Disputed', 30000, 0, 1000, 'Goodwill', '9999', 'NeedsManager'],
    ['Admin', 'Voided', 10000, 0, 1000, 'Duplicate', '2222', 'NotRefundable'],
    ['Manager', 'Settled', 10000, 0, 12000, 'Goodwill', '3333', 'ExceedsRemaining'],
    ['Support', 'Settled', 10000, 0, 0, 'Goodwill', '3333', 'BadAmount'],
    ['Support', 'Settled', 15000, 0, 1000, 'Defective', '4242', 'StoreFailed', true],
  ];
  it.each(rows)('%s %s %i/%i refund %i as %s', async (role, status, amount, refunded, m, reason, card, out, fail) => {
    const c = mk(role, status, amount, refunded, m, reason, card);
    const { res, stored, emitted } = await go(c, fail);
    const ev = { actor: 11, payment: 5001, amount: m, reason };
    if (typeof out === 'number') {
      expect(res).toEqual({ ok: { payment: 5001, refund: m, refunded: refunded + m, remaining: out } });
      expect(stored).toEqual([{ id: 5001, amount, refunded: refunded + m, status, card }]);
      expect(emitted).toEqual([ev]);
    } else {
      expect(res).toEqual({ err: out });
      expect(stored).toEqual([]);
      expect(emitted).toEqual([{ ...ev, why: out }]);
    }
  });
});

describe('properties', () => {
  it('status gates: NotRefundable iff Voided, NeedsManager iff Disputed by Support', async () => {
    await forAll(async (c) => {
      const { res } = await go(c);
      expect(res.err === 'NotRefundable').toBe(c.payment.status === 'Voided');
      expect(res.err === 'NeedsManager').toBe(c.payment.status === 'Disputed' && c.actor.role === 'Support');
    });
  });

  it('zero amount is BadAmount', async () => {
    await forAll(async (c) => expect((await go(settled(c, 'Admin', 0))).res).toEqual({ err: 'BadAmount' }));
  });

  it('ExceedsRemaining iff amount exceeds amount - refunded', async () => {
    await forAll(async (c) => {
      const m = Math.max(1, c.amount);
      expect(((await go(settled(c, 'Admin', m))).res.err === 'ExceedsRemaining')).toBe(m > c.payment.amount - c.payment.refunded);
    });
  });

  it('OverCap iff above the role cap, per refund not running total', async () => {
    await forAll(async (c) => {
      const m = Math.max(1, c.amount);
      for (const role of ROLES) {
        const big = { ...settled(c, role, m), payment: { ...c.payment, amount: MAX, refunded: 0, status: 'Settled' as Status } };
        expect((await go(big)).res.err === 'OverCap').toBe(m > CAP[role]);
      }
      const prior = { ...settled(c, 'Support', Math.min(m, 20000)), payment: { ...c.payment, amount: MAX, refunded: 900000, status: 'Settled' as Status } };
      expect((await go(prior)).res.ok).toBeDefined();
    });
  });

  it('refusal precedence', async () => {
    await forAll(async (c) => {
      const p = { ...c.payment, refunded: c.payment.amount };
      const t = (role: Role, status: Status, m: number) => go({ ...c, actor: { id: 1, role }, payment: { ...p, status }, amount: m });
      expect((await t('Admin', 'Voided', 0)).res.err).toBe('NotRefundable');
      expect((await t('Support', 'Disputed', 0)).res.err).toBe('NeedsManager');
      expect((await t('Support', 'Settled', 0)).res.err).toBe('BadAmount');
      expect((await t('Support', 'Settled', 300000)).res.err).toBe('ExceedsRemaining');
    });
  });

  it('success stores updated payment, one RefundIssued, consistent receipt', async () => {
    await forAll(async (c) => {
      const { res, stored, emitted } = await go(c);
      if (!res.ok) return;
      const refunded = c.payment.refunded + c.amount;
      expect(res.ok).toEqual({ payment: c.payment.id, refund: c.amount, refunded, remaining: c.payment.amount - refunded });
      expect(stored).toEqual([{ ...c.payment, refunded }]);
      expect(emitted).toEqual([{ actor: c.actor.id, payment: c.payment.id, amount: c.amount, reason: c.reason }]);
    });
  });

  it('refusals and store failure emit one RefundRefused and store nothing', async () => {
    await forAll(async (c) => {
      for (const fail of [false, true]) {
        const { res, stored, emitted } = await go(c, fail);
        if (res.ok) {
          expect(fail).toBe(false);
          continue;
        }
        expect(fail || res.err !== 'StoreFailed').toBe(true);
        expect(stored).toEqual([]);
        expect(emitted).toEqual([{ actor: c.actor.id, payment: c.payment.id, amount: c.amount, reason: c.reason, why: res.err }]);
      }
    });
  });
});

describe('privacy', () => {
  it('card is stored but never in the audit log', async () => {
    await forAll(async (c) => {
      const marked = { ...c, payment: { ...c.payment, card: `Q${c.payment.card}` } };
      for (const fail of [false, true]) {
        const { stored, emitted } = await go(marked, fail);
        expect(JSON.stringify(emitted)).not.toMatch(/Q\d{4}|card/);
        if (stored.length) expect(stored).toEqual([{ ...marked.payment, refunded: marked.payment.refunded + marked.amount }]);
      }
    });
  });
});

describe('range boundaries', () => {
  it('extreme amounts neither overflow nor underflow', async () => {
    const ok = (await go(mk('Admin', 'Settled', MAX, MAX - 1000000, 1000000))).res.ok;
    expect(ok).toEqual({ payment: 5001, refund: 1000000, refunded: MAX, remaining: 0 });
    expect((await go(mk('Admin', 'Settled', MAX, MAX, 1))).res.err).toBe('ExceedsRemaining');
    expect((await go(mk('Admin', 'Settled', MAX, 0, MAX))).res.err).toBe('OverCap');
    expect((await go(mk('Admin', 'Settled', MAX, 0, MAX + 1))).res.err).toBe('ExceedsRemaining');
    expect((await go(mk('Admin', 'Settled', 0, 0, 0))).res.err).toBe('BadAmount');
    expect((await go(mk('Support', 'Settled', 0, 0, 1))).res.err).toBe('ExceedsRemaining');
  });
});
