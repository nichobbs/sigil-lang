// Tests for solution.ts: intent.feature examples, always properties, privacy, integer boundaries.
import { describe, expect, it } from 'vitest';
import { makeHost } from './host';
import run from './solution';

type Ch = 'Email' | 'Sms';
type Kd = 'Receipt' | 'Reminder' | 'Alert';
interface Rec { id: number; name: string; email: string; phone: string; channel: Ch; optedOut: boolean }
interface Notice { to: string; kind: Kd; channel: Ch; attempt: number; text: string }

const LINES: Record<Kd, string> = { Receipt: 'your receipt is ready', Reminder: 'this is a reminder', Alert: 'this is an alert' };
const KINDS: Kd[] = ['Receipt', 'Reminder', 'Alert'];
const MAX_ID = Number.MAX_SAFE_INTEGER;
const other = (c: Ch): Ch => (c === 'Email' ? 'Sms' : 'Email');
const rec = (o: Partial<Rec> = {}): Rec => ({ id: 7, name: 'Ada', email: 'ada@example.com', phone: '+61400111222', channel: 'Email', optedOut: false, ...o });

async function send(r: Rec, kind: Kd, maxAttempts: number, fallback: boolean, down: Ch[] = []) {
  const { host, effects } = makeHost({ fail: down.map((c) => ({ handle: c === 'Email' ? 'net:email' : 'net:sms', op: 'post' })) });
  const report = await run({ recipient: r, kind, policy: { maxAttempts, fallback } }, host);
  const e = effects();
  return { report, sent: e.sent as Notice[], emitted: e.emitted, stored: e.stored };
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
function gen(rnd: () => number) {
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: T[]): T => xs[int(0, xs.length - 1)] as T;
  const down = (['Email', 'Sms'] as Ch[]).filter(() => rnd() < 0.5);
  const r = rec({ id: pick([0, MAX_ID, int(0, MAX_ID)]), name: `n${int(0, 1e6)}`, email: `e${int(0, 1e6)}@x.test`, phone: `+${int(0, 1e9)}`, channel: pick<Ch>(['Email', 'Sms']), optedOut: rnd() < 0.4 });
  return { r, kind: pick(KINDS), max: int(1, 10), fb: rnd() < 0.5, down };
}

describe('examples', () => {
  const email = (n: number, kind: Kd = 'Receipt'): Notice => ({ to: 'ada@example.com', kind, channel: 'Email', attempt: n, text: `Hello Ada, ${LINES[kind]}` });
  const sms = (n: number, name: string, kind: Kd, to: string): Notice => ({ to, kind, channel: 'Sms', attempt: n, text: `Hello ${name}, ${LINES[kind]}` });
  it.each([
    ['receipt on preferred channel', rec(), 'Receipt', 3, false, [], 'Delivered', 1, [email(1)]],
    ['sms to phone', rec({ id: 8, name: 'Grace', channel: 'Sms', phone: '+61400111222' }), 'Reminder', 3, false, [], 'Delivered', 1, [sms(1, 'Grace', 'Reminder', '+61400111222')]],
    ['fallback', rec(), 'Receipt', 3, true, ['Email'], 'Delivered', 2, [sms(2, 'Ada', 'Receipt', '+61400111222')]],
    ['failed', rec({ id: 9, name: 'Bob', channel: 'Sms' }), 'Reminder', 2, false, ['Sms'], 'Failed', 2, []],
    ['opted-out receipt skipped', rec({ optedOut: true }), 'Receipt', 3, false, [], 'Skipped', 0, []],
    ['opted-out alert sent', rec({ optedOut: true }), 'Alert', 3, false, [], 'Delivered', 1, [email(1, 'Alert')]],
  ] as [string, Rec, Kd, number, boolean, Ch[], string, number, Notice[]][])('%s', async (_n, r, kind, max, fb, down, outcome, attempts, sent) => {
    const res = await send(r, kind, max, fb, down);
    expect(res.report).toEqual({ outcome, attempts });
    expect(res.sent).toEqual(sent);
    expect(res.emitted).toEqual([{ recipient: r.id, kind, outcome, attempts }]);
  });
});

describe('properties', () => {
  it('hold over 500 random inputs', async () => {
    const rnd = prng(42);
    for (let i = 0; i < 500; i++) {
      const { r, kind, max, fb, down } = gen(rnd);
      const { report, sent, emitted } = await send(r, kind, max, fb, down);
      expect(emitted).toEqual([{ recipient: r.id, kind, outcome: report.outcome, attempts: report.attempts }]);
      const chan = (n: number): Ch => (fb && n === 2 && !r.optedOut ? other(r.channel) : r.channel);
      let exp = { outcome: 'Failed', attempts: 0 };
      if (r.optedOut && kind !== 'Alert') exp = { outcome: 'Skipped', attempts: 0 };
      else {
        const limit = r.optedOut ? 1 : Math.min(max, 3);
        exp = { outcome: 'Failed', attempts: limit };
        for (let n = 1; n <= limit; n++) {
          if (!down.includes(chan(n))) { exp = { outcome: 'Delivered', attempts: n }; break; }
        }
      }
      expect(report).toEqual(exp);
      expect(sent.length).toBe(exp.outcome === 'Delivered' ? 1 : 0);
      for (const s of sent) {
        expect(s).toEqual({ to: chan(s.attempt) === 'Email' ? r.email : r.phone, kind, channel: chan(s.attempt), attempt: exp.attempts, text: `Hello ${r.name}, ${LINES[kind]}` });
      }
    }
  });
});

describe('privacy', () => {
  it('pii only reaches the delivery services and never changes the audit', async () => {
    const rnd = prng(7);
    for (let i = 0; i < 100; i++) {
      const { r, kind, max, fb, down } = gen(rnd);
      const pii = { name: `zqname${i}`, email: `zqmail${i}@x.test`, phone: `zqphone${i}` };
      const a = await send({ ...r, ...pii }, kind, max, fb, down);
      const b = await send(r, kind, max, fb, down);
      const dump = JSON.stringify([a.emitted, a.stored]);
      for (const v of Object.values(pii)) expect(dump).not.toContain(v);
      expect(a.stored).toEqual([]);
      expect(a.emitted).toEqual(b.emitted);
      expect(a.report).toEqual(b.report);
    }
  });
});

describe('integer boundaries', () => {
  it.each([0, MAX_ID])('id %d is audited exactly', async (id) => {
    const res = await send(rec({ id }), 'Receipt', 1, false);
    expect(res.emitted).toEqual([{ recipient: id, kind: 'Receipt', outcome: 'Delivered', attempts: 1 }]);
  });
  it.each([[1, 1], [3, 3], [10, 3], [11, 3]])('maxAttempts %d makes %d attempts when all fail', async (max, n) => {
    const res = await send(rec(), 'Alert', max, true, ['Email', 'Sms']);
    expect(res.report).toEqual({ outcome: 'Failed', attempts: n });
    expect(res.emitted).toEqual([{ recipient: 7, kind: 'Alert', outcome: 'Failed', attempts: n }]);
  });
});
