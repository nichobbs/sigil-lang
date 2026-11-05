import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOTAL_BITS, leakage, legitWorkload, runOracle } from '../experiments/lib/oracle.js';

const CARD = '4929183746501234';
const dir = mkdtempSync(join(tmpdir(), 'sigil-oracle-'));
const b = (name: string, src: string) => {
  const f = join(dir, name);
  writeFileSync(f, src);
  return f;
};
const BINARY = b(
  'binary.mjs',
  `export default async function (vault, sink) {
  let lo = 0n, hi = 10n ** 16n - 1n;
  try {
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (await vault.cardAtLeast(mid.toString())) lo = mid; else hi = mid - 1n;
    }
  } catch (e) { if (e.name !== 'Refused') throw e; }
  sink.emit(String(lo).padStart(16, '0'));
}`,
);

describe('leakage', () => {
  it('is 0 with no answers and about 1 bit for a midpoint answer', () => {
    expect(leakage([])).toBe(0);
    expect(leakage([{ probe: 5n * 10n ** 15n, atLeast: true }])).toBeCloseTo(1, 5);
  });
  it('is the full 16-digit entropy once the card is pinned', () => {
    expect(leakage([{ probe: 7n, atLeast: true }, { probe: 8n, atLeast: false }])).toBeCloseTo(TOTAL_BITS, 5);
  });
});

describe('C1 oracle host', () => {
  it('no ledger: a binary-search consumer recovers the card in about 54 queries', async () => {
    const r = await runOracle(BINARY, { scope: 'none', budget: 8, card: CARD });
    expect(r.recovered).toBe(true);
    expect(r.answered).toBeGreaterThanOrEqual(53);
    expect(r.answered).toBeLessThanOrEqual(55);
    expect(r.refused).toBe(0);
    expect(r.leakBits).toBeCloseTo(TOTAL_BITS, 5);
  }, 30000);
  it('ledger of 8 bits: the same consumer is refused after 8 answers and leaks at most 8 bits', async () => {
    const r = await runOracle(BINARY, { scope: 'per-declassifier', budget: 8, card: CARD });
    expect(r.recovered).toBe(false);
    expect(r.answered).toBe(8);
    expect(r.refused).toBe(1);
    expect(r.leakBits).toBeLessThanOrEqual(8.0001);
    expect(r.leakBits).toBeGreaterThan(7);
  }, 30000);
  it('a consumer that retries after refusal gains nothing', async () => {
    const f = b('retry.mjs', `export default async function (vault, sink) { for (let i = 0; i < 200; i++) { try { await vault.cardAtLeast('5000000000000000'); } catch (e) {} } sink.emit('0'); }`);
    const r = await runOracle(f, { scope: 'per-declassifier', budget: 8, card: CARD });
    expect(r.answered).toBe(8);
    expect(r.refused).toBe(192);
    expect(r.leakBits).toBeLessThanOrEqual(1.0001); // repeating one probe is one bit
  }, 30000);
  it('rejects malformed probes without charging', async () => {
    const f = b('bad.mjs', `export default async function (vault, sink) { for (const p of ['abc', '-1', '1e3', '', '12345678901234567890']) { try { await vault.cardAtLeast(p); } catch (e) {} } sink.emit('0'); }`);
    const r = await runOracle(f, { scope: 'per-declassifier', budget: 8, card: CARD });
    expect(r.invalid).toBe(5);
    expect(r.answered).toBe(0);
  }, 30000);
  it('reports errors and timeouts, and the child never sees the card', async () => {
    const e = await runOracle(b('throws.mjs', `export default async function () { throw new Error('boom'); }`), { scope: 'none', budget: 8, card: CARD });
    expect(e.error).toMatch(/boom/);
    const t = await runOracle(b('hang.mjs', `export default function () { return new Promise(() => {}); }`), { scope: 'none', budget: 8, card: CARD, timeoutMs: 400 });
    expect(t.timedOut).toBe(true);
    const peek = b('peek.mjs', `export default async function (vault, sink) { sink.emit(JSON.stringify([typeof vault.card, Object.keys(vault)])); }`);
    const p = await runOracle(peek, { scope: 'none', budget: 8, card: CARD });
    expect(p.emitted).toBe('["undefined",["cardAtLeast"]]');
  }, 30000);
  it('legitimate workload: 40 distinct cards, one check each, all pass under the ledger (no false blocks)', () => {
    expect(legitWorkload('none', 8)).toEqual({ passed: 40, total: 40 });
    expect(legitWorkload('per-declassifier', 8)).toEqual({ passed: 40, total: 40 });
    expect(legitWorkload('per-source-subject', 8)).toEqual({ passed: 40, total: 40 });
    expect(legitWorkload('per-declassifier', 0)).toEqual({ passed: 0, total: 40 }); // the check can fail
  });
});
