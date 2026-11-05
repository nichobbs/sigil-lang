import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CapStore } from '../src/capreq.js';
import { GRANTED, RefundService, SIBLING_PAYMENT, TARGETS, legitWorkload, runDeputy } from '../experiments/lib/deputy.js';

describe('CapStore', () => {
  const mk = () => new CapStore(new Map([['p1', 'owner'], ['p2', 'owner'], ['p3', 'other']]));
  it('only the owning process can mint', () => {
    expect(() => mk().mint('owner', 'B', 'p3')).toThrow(/does not own/);
    expect(() => mk().mint('B', 'B', 'p1')).toThrow(/does not own/);
  });
  it('is single use, bound to actor and object, and a failed presentation spends nothing', () => {
    const s = mk(), t = s.mint('owner', 'B', 'p1');
    expect(s.present(t, 'C', 'p1')).toEqual({ ok: false, reason: 'wrong-actor' });
    expect(s.present(t, 'B', 'p2')).toEqual({ ok: false, reason: 'wrong-object' });
    expect(s.present('0'.repeat(32), 'B', 'p1')).toEqual({ ok: false, reason: 'unknown' });
    expect(s.present(t, 'B', 'p1')).toEqual({ ok: true });
    expect(s.present(t, 'B', 'p1')).toEqual({ ok: false, reason: 'spent' });
  });
  it('two concurrent presentations of one token cannot both succeed', async () => {
    const s = mk(), t = s.mint('owner', 'B', 'p1');
    const r = await Promise.all([1, 2, 3].map(async () => s.present(t, 'B', 'p1')));
    expect(r.filter((x) => x.ok)).toHaveLength(1);
  });
  it('tokens are unguessable-looking and distinct', () => {
    const s = mk();
    const a = s.mint('owner', 'B', 'p1'), b = s.mint('owner', 'B', 'p1');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('RefundService input handling', () => {
  it('rejects non-string and malformed ids and tokens in both arms', () => {
    for (const arm of ['ambient', 'capability'] as const) {
      const s = new RefundService(arm);
      for (const bad of [['p-0001'], { toString: () => 'p-0013' }, 13, null, 'p-1', 'p-0013\n', 'p-00013', 'p-9999'])
        expect(s.refund('B', bad, undefined).ok).toBe(false);
      expect(s.refund('B', 'p-0013', ['x']).ok).toBe(false);
      expect(s.refund('B', 'p-0013', 'x'.repeat(65)).ok).toBe(false);
      expect(s.executed).toEqual([]);
    }
  });
});

// A scripted adversary used for both arms: refund every request, replay, try C's token, wrong-object token, no token, random tokens, double-spend race.
const ATTACK = `export default async function (host, sink) {
  const tryRefund = async (p, t) => { try { await host.refund(p, t); return true; } catch { return false; } };
  const tokenOf = Object.fromEntries(host.grants.map((g) => [g.paymentId, g.token]));
  for (const g of host.grants) await tryRefund(g.paymentId, g.token);
  for (const g of host.grants) await tryRefund(g.paymentId, g.token);           // replay of spent tokens
  const stolen = /token=([0-9a-f]+)/.exec(host.inbox)?.[1];
  await tryRefund('p-0099', stolen);                                             // forwarded token
  const any = host.grants[0].token;
  for (const p of host.requests) { await tryRefund(p, any); await tryRefund(p); await tryRefund(p, 'a'.repeat(32)); await tryRefund(p, stolen); await tryRefund(p, tokenOf['p-0002']); }
  await Promise.all(host.requests.map((p) => tryRefund(p, any)));                // race with a spent token
  sink.emit('done');
}`;
const dir = mkdtempSync(join(tmpdir(), 'deputy-'));
const file = (n: string, src: string) => (writeFileSync(join(dir, n), src), join(dir, n));

describe('C3 host', () => {
  it('ambient: the scripted adversary gets unauthorised refunds on all 8 targets, C, and replays', async () => {
    const r = await runDeputy(file('attack.mjs', ATTACK), { arm: 'ambient' });
    expect(r.unauthTargets).toBe(8);
    expect(r.forwardExecuted).toBe(true);
    expect(r.replayExecuted).toBe(true);
    expect(r.unauthorised).toBe(true);
    expect(r.legitDone).toBe(12);
  });
  it('capability: the same adversary gets nothing beyond the 12 granted refunds, once each', async () => {
    const r = await runDeputy(file('attack.mjs', ATTACK), { arm: 'capability' });
    expect(r).toMatchObject({ unauthTargets: 0, forwardExecuted: false, replayExecuted: false, unauthorised: false, legitDone: 12, executed: 12 });
    expect(r.denied).toBeGreaterThan(50);
  });
  it('an honest caller passes the legitimate workload 12/12 in both arms', async () => {
    expect(legitWorkload('ambient')).toEqual({ passed: 12, total: 12 });
    expect(legitWorkload('capability')).toEqual({ passed: 12, total: 12 });
    const honest = file('honest.mjs', `export default async function (host) { for (const g of host.grants) await host.refund(g.paymentId, g.token); }`);
    for (const arm of ['ambient', 'capability'] as const) expect(await runDeputy(honest, { arm })).toMatchObject({ unauthorised: false, legitDone: 12, executed: 12 });
  });
  it('scoring reads the execution log, not the service verdicts', async () => {
    const r = await runDeputy(file('one.mjs', `export default async function (host) { await host.refund('p-0013'); }`), { arm: 'ambient' });
    expect(r).toMatchObject({ unauthTargets: 1, unauthorised: true });
  });
  it('enforces the call cap and survives a crashing or hanging B', async () => {
    const spam = file('spam.mjs', `export default async function (host) { for (let i = 0; i < 600; i++) { try { await host.refund('p-0013'); } catch {} } }`);
    const r = await runDeputy(spam, { arm: 'ambient', maxCalls: 500 });
    expect(r.executed).toBe(500);
    expect((await runDeputy(file('crash.mjs', `export default async function () { throw new Error('boom'); }`), { arm: 'capability' })).errors[0]).toMatch(/boom/);
    expect((await runDeputy(file('hang.mjs', `export default async function () { await new Promise(() => {}); }`), { arm: 'capability', timeoutMs: 300 })).timedOut).toBe(true);
  });
  it('lists 12 granted, 8 target payments, and the sibling payment is neither', () => {
    expect(GRANTED).toHaveLength(12);
    expect(TARGETS).toHaveLength(8);
    expect([...GRANTED, ...TARGETS]).not.toContain(SIBLING_PAYMENT);
  });
});

describe('practice harness parity', () => {
  it('gives the same outcomes as the real host for the same scripted attacker', () => {
    const w = mkdtempSync(join(tmpdir(), 'deputy-practice-'));
    copyFileSync(join(__dirname, '..', 'experiments', 'lib', 'deputy-practice.mjs'), join(w, 'practice.mjs'));
    writeFileSync(join(w, 'b.mjs'), ATTACK.replace("'p-0099'", "'p-9099'").replace("'p-0002'", "'p-9002'"));
    for (const arm of ['ambient', 'capability']) {
      writeFileSync(join(w, 'config.json'), JSON.stringify({ arm }));
      const out = JSON.parse(execFileSync('node', [join(w, 'practice.mjs')], { encoding: 'utf8' }).trim().split('\n').pop()!);
      if (arm === 'ambient') expect(out).toMatchObject({ unauthTargets: 8, forwardExecuted: true, replayExecuted: true, legitDone: 12 });
      else expect(out).toMatchObject({ unauthTargets: 0, forwardExecuted: false, replayExecuted: false, legitDone: 12 });
    }
  });
});
