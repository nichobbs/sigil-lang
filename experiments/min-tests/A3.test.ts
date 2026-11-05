// Tests for the A3 rate limiter: examples, always-properties, privacy, integer boundaries.
import { describe, expect, it } from 'vitest';
import { makeHost } from './host';
import run from './solution';

type Args = Parameters<typeof run>[0];
type Plan = Args['req']['plan'];
const PLANS: Plan[] = ['Free', 'Pro', 'Enterprise'];
const ALLOW: Record<Plan, number> = { Free: 100, Pro: 1000, Enterprise: 10000 };

const go = async (plan: Plan, cost: number, now: number, start: number, used: number, burst = false, key = 4242) => {
  const { host, effects } = makeHost();
  const res: unknown = await run({ req: { key, plan, cost, now }, state: { start, used, burst } }, host);
  return { res, stored: effects().stored, emitted: effects().emitted };
};

const rng = (seed: number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const N = 400;
const gen = (seed: number) => {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  return { int, plan: () => PLANS[int(0, 2)] as Plan, bool: () => r() < 0.5 };
};

describe('examples', () => {
  const ok = (remaining: number, burst: boolean) => ({ ok: { remaining, burst } });
  const err = (reason: string, retryAfter: number) => ({ err: { reason, retryAfter } });
  const cases: [string, [Plan, number, number, number, number], unknown, unknown[], unknown[]][] = [
    ['fits', ['Free', 50, 10000, 0, 40], ok(10, false), [{ start: 0, used: 90, burst: false }], [{ plan: 'Free', cost: 50, remaining: 10, burst: false }]],
    ['new window', ['Free', 30, 130000, 0, 100], ok(70, false), [{ start: 130000, used: 30, burst: false }], [{ plan: 'Free', cost: 30, remaining: 70, burst: false }]],
    ['denied', ['Free', 20, 10000, 0, 90], err('Denied', 50), [], [{ plan: 'Free', cost: 20, reason: 'Denied', retryAfter: 50 }]],
    ['too large', ['Free', 150, 1000, 0, 0], err('TooLarge', 0), [], [{ plan: 'Free', cost: 150, reason: 'TooLarge', retryAfter: 0 }]],
    ['burst', ['Pro', 50, 5000, 0, 990], ok(0, true), [{ start: 0, used: 1040, burst: true }], [{ plan: 'Pro', cost: 50, remaining: 0, burst: true }]],
  ];
  it.each(cases)('%s', async (_n, [plan, cost, now, start, used], res, stored, emitted) => {
    expect(await go(plan, cost, now, start, used)).toEqual({ res, stored, emitted });
  });
});

describe('always', () => {
  it('window: 60s boundary, new window resets used and burst', async () => {
    const g = gen(1);
    for (let i = 0; i < N; i++) {
      const [p, c, s, k, u, b] = [g.plan(), g.int(1, 1000000), g.int(0, 1e9), g.int(0, 1e6), g.int(0, 1e9), g.bool()];
      const { res, stored } = (await go(p, c, s + 60000 + k, s, u, b)) as { res: { ok?: { remaining: number; burst: boolean }; err?: { reason: string } }; stored: unknown[] };
      if (c <= ALLOW[p]) {
        expect(res.ok).toEqual({ remaining: ALLOW[p] - c, burst: false });
        expect(stored).toEqual([{ start: s + 60000 + k, used: c, burst: false }]);
      } else expect(res.err?.reason).toBe('TooLarge');
    }
  });

  it('allowance: fits iff used + cost <= allowance, remaining exact', async () => {
    const g = gen(2);
    for (let i = 0; i < N; i++) {
      const [c, s, k, u, b] = [g.int(1, 150), g.int(0, 1e9), g.int(0, 59999), g.int(0, 150), g.bool()];
      const { res, stored } = await go('Free', c, s + k, s, u, b);
      if (u + c <= 100) {
        expect(res).toEqual({ ok: { remaining: 100 - u - c, burst: false } });
        expect(stored).toEqual([{ start: s, used: u + c, burst: b }]);
      } else expect(res).toHaveProperty('err');
    }
  });

  it('too large: rejected with retryAfter 0, nothing stored', async () => {
    const g = gen(3);
    for (let i = 0; i < N; i++) {
      const [p, c, s, k, u, b] = [g.plan(), g.int(1, 20000), g.int(0, 1e9), g.int(0, 100000), g.int(0, 12000), g.bool()];
      if (c <= ALLOW[p]) continue;
      const { res, stored } = await go(p, c, s + k, s, u, b);
      expect(res).toEqual({ err: { reason: 'TooLarge', retryAfter: 0 } });
      expect(stored).toEqual([]);
    }
  });

  it('denied: retryAfter is ceil seconds to window end, at least 1', async () => {
    const g = gen(4);
    for (let i = 0; i < N; i++) {
      const [p, c, s, k, u, b] = [g.plan(), g.int(1, 12000), g.int(0, 1e9), g.int(0, 59999), g.int(0, 12000), g.bool()];
      const { res, stored } = (await go(p, c, s + k, s, u, b)) as { res: { err?: { reason: string; retryAfter: number } }; stored: unknown[] };
      if (res.err?.reason !== 'Denied') continue;
      expect(res.err.retryAfter).toBe(Math.floor((60000 - k + 999) / 1000));
      expect(res.err.retryAfter).toBeGreaterThanOrEqual(1);
      expect(stored).toEqual([]);
    }
  });

  it('burst: once per window, Pro/Enterprise only, within allowance + 10%', async () => {
    const g = gen(5);
    for (let i = 0; i < N; i++) {
      const [p, c, s, k, u, b] = [g.plan(), g.int(1, 12000), g.int(0, 1e9), g.int(0, 59999), g.int(0, 12000), g.bool()];
      const a = ALLOW[p];
      const cap = a + Math.floor(a / 10);
      const { res, stored, emitted } = (await go(p, c, s + k, s, u, b)) as { res: { ok?: { burst: boolean }; err?: { reason: string } }; stored: unknown[]; emitted: unknown[] };
      if (res.ok) {
        expect(res.ok.burst).toBe(u + c > a);
        if (res.ok.burst) {
          expect(!b && p !== 'Free' && u + c <= cap).toBe(true);
          expect(stored).toEqual([{ start: s, used: u + c, burst: true }]);
        }
      } else if (res.err?.reason === 'TooLarge') expect(c).toBeGreaterThan(a);
      else expect(u + c > a && c <= a && (b || p === 'Free' || u + c > cap)).toBe(true);
      expect(emitted).toHaveLength(1);
    }
  });
});

describe('privacy', () => {
  it('api key never changes stored values or audit events', async () => {
    const g = gen(6);
    for (let i = 0; i < 150; i++) {
      const [p, c, s, k, u, b] = [g.plan(), g.int(1, 12000), g.int(0, 1e9), g.int(0, 100000), g.int(0, 12000), g.bool()];
      const base = await go(p, c, s + k, s, u, b, 0);
      for (const key of [Number.MAX_SAFE_INTEGER, g.int(1, Number.MAX_SAFE_INTEGER)]) {
        expect(await go(p, c, s + k, s, u, b, key)).toEqual(base);
      }
    }
  });
});

describe('boundaries', () => {
  const T = 1e9;
  const M = 1e15;
  const cases: [string, [Plan, number, number, number, number, boolean?], unknown][] = [
    ['59999ms is same window', ['Free', 1, 59999, 0, 100], { err: { reason: 'Denied', retryAfter: 1 } }],
    ['60000ms is new window', ['Free', 1, 60000, 0, 100], { ok: { remaining: 99, burst: false } }],
    ['retry 60 at start', ['Free', 1, 0, 0, 100], { err: { reason: 'Denied', retryAfter: 60 } }],
    ['max time new window', ['Enterprise', 1, M, M - 60000, T], { ok: { remaining: 9999, burst: false } }],
    ['max time same window', ['Enterprise', 1, M, M - 59999, T], { err: { reason: 'Denied', retryAfter: 1 } }],
    ['max time zero start', ['Enterprise', 1, M, 0, 0], { ok: { remaining: 9999, burst: false } }],
    ['max used denied', ['Pro', 1, 0, 0, T], { err: { reason: 'Denied', retryAfter: 60 } }],
    ['max used new window', ['Pro', 1, 60000, 0, T], { ok: { remaining: 999, burst: false } }],
    ['max cost too large', ['Enterprise', 1e6, 0, 0, T], { err: { reason: 'TooLarge', retryAfter: 0 } }],
    ['one past max cost', ['Free', 1e6 + 1, 0, 0, 0], { err: { reason: 'TooLarge', retryAfter: 0 } }],
    ['min cost', ['Free', 1, 0, 0, 0], { ok: { remaining: 99, burst: false } }],
    ['exact allowance', ['Enterprise', 10000, 0, 0, 0], { ok: { remaining: 0, burst: false } }],
    ['allowance + 1 free', ['Free', 101, 0, 0, 0], { err: { reason: 'TooLarge', retryAfter: 0 } }],
    ['burst at cap', ['Pro', 100, 0, 0, 1000], { ok: { remaining: 0, burst: true } }],
    ['burst one past cap', ['Pro', 101, 0, 0, 1000], { err: { reason: 'Denied', retryAfter: 60 } }],
    ['burst already used', ['Pro', 1, 0, 0, 1000, true], { err: { reason: 'Denied', retryAfter: 60 } }],
    ['free no burst', ['Free', 1, 0, 0, 100], { err: { reason: 'Denied', retryAfter: 60 } }],
    ['enterprise burst cap', ['Enterprise', 1000, 0, 0, 10000], { ok: { remaining: 0, burst: true } }],
  ];
  it.each(cases)('%s', async (_n, [plan, cost, now, start, used, burst], res) => {
    expect((await go(plan, cost, now, start, used, burst)).res).toEqual(res);
  });
});
