// Tests for A4 transfer: examples, always-properties, privacy, integer-range boundaries.
import { describe, expect, it } from 'vitest';
import { makeHost } from './host';
import run from './solution';

type Role = 'Customer' | 'Teller' | 'Admin';
type Acct = [number, number, number];
const MAX = 1_000_000_000_000;
const LIMIT = 1_000_000;
const ROLES: Role[] = ['Customer', 'Teller', 'Admin'];

async function go(role: Role, id: number, s: Acct, d: Acct, amount: number, approved = false, failStore = false) {
  const { host, effects } = makeHost({ fail: failStore ? [{ handle: 'store:accounts', op: 'put' }] : [] });
  const args = {
    actor: { id, role },
    src: { id: s[0], owner: s[1], balance: s[2] },
    dst: { id: d[0], owner: d[1], balance: d[2] },
    amount,
    approved,
  };
  const result = (await run(args, host)) as { ok?: Record<string, number>; err?: string };
  return { result, eff: effects(), args };
}

function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('examples', () => {
  const ok = (a: number, b: number) => ({ stored: [a, b] });
  const cases: [string, Role, Acct, Acct, number, boolean, boolean, { stored?: number[]; err?: string }][] = [
    ['customer own', 'Customer', [101, 5, 50000], [202, 9, 2000], 12000, false, false, ok(38000, 14000)],
    ['teller any', 'Teller', [101, 5, 50000], [202, 9, 2000], 7550, false, false, ok(42450, 9550)],
    ['admin approved', 'Admin', [101, 5, 5000000], [202, 9, 0], 2000000, true, false, ok(3000000, 2000000)],
    ['not allowed', 'Customer', [101, 9, 50000], [202, 5, 2000], 1000, false, false, { err: 'NotAllowed' }],
    ['insufficient', 'Customer', [101, 5, 5000], [202, 9, 2000], 6000, false, false, { err: 'Insufficient' }],
    ['needs approval', 'Customer', [101, 5, 5000000], [202, 9, 2000], 2000000, false, false, { err: 'NeedsApproval' }],
    ['same account', 'Teller', [101, 5, 50000], [101, 5, 50000], 1000, false, false, { err: 'SameAccount' }],
    ['store failed', 'Customer', [101, 5, 50000], [202, 9, 2000], 1000, false, true, { err: 'StoreFailed' }],
  ];
  it.each(cases)('%s', async (_n, role, s, d, amount, approved, fail, want) => {
    const { result, eff } = await go(role, role === 'Customer' ? 5 : 6, s, d, amount, approved, fail);
    if (want.stored) {
      expect(result.ok).toBeDefined();
      expect(eff.stored.map((x) => (x as { balance: number }).balance)).toEqual(want.stored);
      expect(eff.emitted).toEqual([{ actor: role === 'Customer' ? 5 : 6, src: s[0], dst: d[0], amount }]);
    } else {
      expect(result).toEqual({ err: want.err });
      expect(eff.stored).toEqual([]);
    }
  });
});

describe('properties', () => {
  const rnd = prng(42);
  const int = (n: number) => Math.floor(rnd() * (n + 1));
  const pick = <T>(xs: T[]) => xs[int(xs.length - 1)] as T;
  const amt = () => pick([int(MAX), int(LIMIT * 2), LIMIT, LIMIT + 1, 0, 1, int(1000)]);
  const gen = () => {
    const id = pick([int(MAX), int(5)]);
    const s: Acct = [pick([int(5), int(2 ** 53 - 1)]), pick([id, int(5), int(2 ** 53 - 1)]), pick([int(MAX), int(LIMIT * 2), int(100)])];
    const d: Acct = [pick([s[0], int(5), int(2 ** 53 - 1)]), int(2 ** 53 - 1), int(MAX)];
    return { role: pick(ROLES), id, s, d, m: amt(), ap: rnd() < 0.5 };
  };
  const cases = Array.from({ length: 400 }, gen);

  it('allowed/not-allowed, checked first; approval, ordering, whole balance, movement, audit', async () => {
    for (const c of cases) {
      const r = await go(c.role, c.id, c.s, c.d, c.m, c.ap);
      const denied = c.role === 'Customer' && c.id !== c.s[1];
      expect(r.result.err === 'NotAllowed').toBe(denied);
      const zero = await go(c.role, c.id, [c.s[0], c.s[1], 0], c.d, c.m, c.ap);
      expect(zero.result.err === 'NotAllowed').toBe(denied);

      const approved = c.role === 'Admin' && c.ap;
      const flip = await go(c.role, c.id, c.s, c.d, c.m, !c.ap);
      if (c.role !== 'Admin') expect(flip.result).toEqual(r.result);
      const want = denied ? 'NotAllowed'
        : c.s[0] === c.d[0] ? 'SameAccount'
        : c.m < 1 ? 'BadAmount'
        : c.m > LIMIT && !approved ? 'NeedsApproval'
        : c.m > c.s[2] ? 'Insufficient' : undefined;
      expect(r.result.err).toBe(want);

      if (want) {
        expect(r.eff.stored).toEqual([]);
        expect(r.eff.emitted).toEqual([{ actor: c.id, src: c.s[0], dst: c.d[0], amount: c.m, reason: want }]);
      } else {
        expect(r.result.ok).toEqual({ src: c.s[0], dst: c.d[0], amount: c.m, srcBalance: c.s[2] - c.m, dstBalance: c.d[2] + c.m });
        expect(r.eff.stored).toEqual([
          { id: c.s[0], owner: c.s[1], balance: c.s[2] - c.m },
          { id: c.d[0], owner: c.d[1], balance: c.d[2] + c.m },
        ]);
        expect(r.eff.emitted).toEqual([{ actor: c.id, src: c.s[0], dst: c.d[0], amount: c.m }]);
      }

      const whole = await go('Admin', 1, c.s, c.d, c.s[2], true);
      if (c.s[0] !== c.d[0] && c.s[2] >= 1) expect(whole.result.ok?.srcBalance).toBe(0);
      else expect(whole.result.err).toBe(c.s[0] === c.d[0] ? 'SameAccount' : 'BadAmount');

      const same = await go('Teller', 2, c.s, [c.s[0], c.d[1], c.d[2]], c.m, c.ap);
      expect(same.result.err).toBe('SameAccount');
      if (c.s[0] !== c.d[0]) expect((await go('Teller', 2, c.s, c.d, 0, c.ap)).result.err).toBe('BadAmount');
    }
  });

  it('privacy: refusals carry no balance; only public fields leave, only to the two sinks', async () => {
    const pub = ['actor', 'src', 'dst', 'amount'];
    for (const c of cases) {
      const r = await go(c.role, c.id, c.s, c.d, c.m, c.ap);
      expect(r.eff.sent).toEqual([]);
      if (r.result.err) {
        expect(r.eff.stored).toEqual([]);
        for (const e of r.eff.emitted) expect(Object.keys(e as object).sort()).toEqual([...pub, 'reason'].sort());
        expect(JSON.stringify(r.eff.emitted)).not.toContain('balance');
      } else {
        for (const e of r.eff.emitted) expect(Object.keys(e as object).sort()).toEqual([...pub].sort());
      }
    }
  });
});

describe('boundaries', () => {
  it('max balances do not overflow, ceiling of Wide reached', async () => {
    const r = await go('Admin', 2, [1, 1, MAX], [2, 2, MAX], MAX, true);
    expect(r.result.ok).toMatchObject({ srcBalance: 0, dstBalance: 2 * MAX });
    expect(r.eff.stored).toEqual([
      { id: 1, owner: 1, balance: 0 },
      { id: 2, owner: 2, balance: 2 * MAX },
    ]);
  });
  it.each([
    [0, 0, 'BadAmount'],
    [0, 1, 'Insufficient'],
    [MAX, MAX + 1, 'Insufficient'],
    [LIMIT, LIMIT + 1, 'Insufficient'],
  ])('balance %i amount %i', async (bal, amount, err) => {
    expect((await go('Admin', 2, [1, 1, bal], [2, 2, 0], amount, true)).result.err).toBe(err);
  });
  it('approval limit is inclusive', async () => {
    expect((await go('Teller', 2, [1, 1, MAX], [2, 2, 0], LIMIT)).result.ok).toBeDefined();
    expect((await go('Teller', 2, [1, 1, MAX], [2, 2, 0], LIMIT + 1)).result.err).toBe('NeedsApproval');
  });
  it('id range maximum', async () => {
    const big = 2 ** 53 - 1;
    const r = await go('Customer', big, [big, big, 5], [big - 1, 0, 0], 5);
    expect(r.eff.stored).toEqual([
      { id: big, owner: big, balance: 0 },
      { id: big - 1, owner: 0, balance: 5 },
    ]);
  });
});
