// Tests for A2 apply-posting: examples, always-properties, privacy, range boundaries.
import { expect, it } from 'vitest';
import { makeHost } from './host';
import run from './solution';

type Kind = 'Checking' | 'Savings';
type PK = 'Credit' | 'Debit' | 'Fee';
interface Acct {
  id: number;
  kind: Kind;
  status: 'Open' | 'Frozen';
  balance: number;
  spent: number;
}
const MAX = 1_000_000_000_000;
const acct = (kind: Kind, balance: number, spent = 0, status: Acct['status'] = 'Open'): Acct => ({
  id: 9,
  kind,
  status,
  balance,
  spent,
});
const go = async (a: Acct, kind: PK, amount: number, failStore = false) => {
  const { host, effects } = makeHost({ fail: failStore ? [{ handle: 'store:ledger', op: 'put' }] : [] });
  const result = await run({ acct: a, posting: { kind, amount } }, host);
  return { result, ...effects() };
};
const rejected = (a: Acct, reason: string) => [{ acct: a.id, reason }];

it.each([
  [acct('Checking', 10000), 'Credit', 5000, { ok: { acct: 9, balance: 15000 } }, 15000, 0],
  [acct('Savings', 10000), 'Debit', 3000, { ok: { acct: 9, balance: 7000 } }, 7000, 3000],
  [acct('Checking', 2000), 'Fee', 250, { ok: { acct: 9, balance: 1750 } }, 1750, 0],
  [acct('Checking', 1000), 'Debit', 10000, { ok: { acct: 9, balance: -9000 } }, -9000, 10000],
  [acct('Checking', 10000), 'Debit', 1000, { ok: { acct: 9, balance: 9000 } }, 9000, 1000],
  [acct('Savings', 1000), 'Debit', 5000, { err: 'Insufficient' }, 0, 0],
  [acct('Checking', 500000, 150000), 'Debit', 80000, { err: 'OverLimit' }, 0, 0],
  [acct('Savings', 10000, 0, 'Frozen'), 'Debit', 1000, { err: 'AcctFrozen' }, 0, 0],
] as const)('example %#', async (a, kind, amount, result, balance, spent) => {
  const r = await go(a, kind, amount);
  expect(r.result).toEqual(result);
  if ('ok' in result) {
    expect(r.stored).toEqual([{ ...a, balance, spent: a.spent + spent }]);
    expect(r.emitted).toEqual([{ acct: 9, kind, amount, balance }]);
  } else expect(r.emitted).toEqual(rejected(a, result.err));
});

it('store failure gives StoreFailed and no audit', async () => {
  const r = await go(acct('Checking', 10000), 'Debit', 1000, true);
  expect(r.result).toEqual({ err: 'StoreFailed' });
  expect(r.stored).toEqual([]);
  expect(r.emitted).toEqual([]);
});

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const cases = (n: number) => {
  const r = rng(42);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]) => xs[int(0, xs.length - 1)] as T;
  return Array.from({ length: n }, () => {
    const kind = pick(['Checking', 'Savings'] as const);
    const lo = kind === 'Checking' ? -50000 : 0;
    const amount = pick([int(1, 100_000_000), int(1, 100_000), int(1, 100), 1, 100_000_000]);
    const balance = pick([int(lo, MAX), int(lo, 300_000), lo, MAX, MAX - int(0, 100_000_000), int(lo, lo + 100_000)]);
    const spent = pick([int(0, MAX), int(0, 250_000), 200_000 - amount, 200_000, 0, MAX]);
    const a = acct(kind, balance, Math.max(0, Math.min(MAX, spent)), pick(['Open', 'Frozen'] as const));
    return { a, kind: pick(['Credit', 'Debit', 'Fee'] as const), amount };
  });
};

it('always-properties over generated inputs', async () => {
  for (const { a, kind, amount } of cases(600)) {
    const r = await go(a, kind, amount);
    const limit = a.kind === 'Checking' ? 50000 : 0;
    const frozen = a.status === 'Frozen' && kind !== 'Credit';
    const over = kind === 'Debit' && a.spent + amount > 200000;
    const insufficient = kind !== 'Credit' && a.balance - amount < -limit;
    const why = frozen ? 'AcctFrozen' : over ? 'OverLimit' : insufficient ? 'Insufficient' : null;
    if (why) {
      expect(r.result).toEqual({ err: why });
      expect(r.stored).toEqual([]);
      expect(r.emitted).toEqual(rejected(a, why));
    } else {
      const balance = kind === 'Credit' ? Math.min(MAX, a.balance + amount) : a.balance - amount;
      const spent = kind === 'Debit' ? a.spent + amount : a.spent;
      expect(r.result).toEqual({ ok: { acct: a.id, balance } });
      expect(r.stored).toEqual([{ ...a, balance, spent }]);
      expect(r.emitted).toEqual([{ acct: a.id, kind, amount, balance }]);
    }
  }
});

it('privacy: only ledger store and audit are used, with exactly the specified fields', async () => {
  for (const { a, kind, amount } of cases(150)) {
    const r = await go(a, kind, amount);
    expect(r.sent).toEqual([]);
    expect(r.stored.length).toBeLessThanOrEqual(1);
    expect(r.emitted).toHaveLength(1);
    for (const s of r.stored) expect(Object.keys(s as object).sort()).toEqual(['balance', 'id', 'kind', 'spent', 'status']);
    for (const e of r.emitted) {
      const keys = Object.keys(e as object).sort();
      expect(keys).toEqual('reason' in (e as object) ? ['acct', 'reason'] : ['acct', 'amount', 'balance', 'kind']);
    }
  }
});

it('range boundaries', async () => {
  const cases2: [Acct, PK, number, unknown][] = [
    [acct('Checking', MAX), 'Credit', 1, { ok: { acct: 9, balance: MAX } }],
    [acct('Checking', MAX - 1), 'Credit', 100_000_000, { ok: { acct: 9, balance: MAX } }],
    [acct('Checking', -50000), 'Debit', 1, { err: 'Insufficient' }],
    [acct('Checking', -50000), 'Credit', 1, { ok: { acct: 9, balance: -49999 } }],
    [acct('Checking', -49999), 'Fee', 1, { ok: { acct: 9, balance: -50000 } }],
    [acct('Savings', 0), 'Fee', 1, { err: 'Insufficient' }],
    [acct('Savings', 1), 'Fee', 1, { ok: { acct: 9, balance: 0 } }],
    [acct('Checking', MAX, 0), 'Debit', 100_000_000, { err: 'OverLimit' }],
    [acct('Checking', MAX, MAX), 'Debit', 1, { err: 'OverLimit' }],
    [acct('Checking', MAX, MAX), 'Fee', 100_000_000, { ok: { acct: 9, balance: MAX - 100_000_000 } }],
    [acct('Checking', 0, 199_999), 'Debit', 1, { ok: { acct: 9, balance: -1 } }],
    [acct('Checking', 0, 199_999), 'Debit', 2, { err: 'OverLimit' }],
    [acct('Checking', 0, 0, 'Frozen'), 'Credit', 1, { ok: { acct: 9, balance: 1 } }],
  ];
  for (const [a, kind, amount, result] of cases2) expect((await go(a, kind, amount)).result).toEqual(result);
});
