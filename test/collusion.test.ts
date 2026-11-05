import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countUpTo, leakage2, runCollusion } from '../experiments/lib/collusion.js';
import { legitWorkload } from '../experiments/lib/oracle.js';

const CARD = '4929183746501234';
const dir = mkdtempSync(join(tmpdir(), 'sigil-collusion-'));
const b = (name: string, src: string) => {
  const f = join(dir, name);
  writeFileSync(f, src);
  return f;
};
// B1 binary-searches the threshold oracle for 8 queries and publishes its lower bound.
const B1_EIGHT = b(
  'b1-eight.mjs',
  `export default async function (vault, sink) {
  let lo = 0n, hi = 10n ** 16n - 1n;
  try { for (let i = 0; i < 8; i++) { const mid = (lo + hi + 1n) / 2n; if (await vault.cardAtLeast(mid.toString())) lo = mid; else hi = mid - 1n; } } catch (e) { if (e.name !== 'Refused') throw e; }
  sink.emit(String(lo));
}`,
);
// B2 reads bits 0..7 (independent of the threshold information) and publishes nothing useful.
const B2_LOW_BITS = b(
  'b2-low.mjs',
  `export default async function (vault, sink, inbox) {
  const bits = [];
  try { for (let k = 0; k < 8; k++) bits.push(await vault.cardBit(k)); } catch (e) { if (e.name !== 'Refused') throw e; }
  sink.emit(inbox + '|' + bits.join(''));
}`,
);
const B1_FOUR = b('b1-four.mjs', B1_EIGHT_SRC(4));
const B2_FOUR = b('b2-four.mjs', `export default async function (vault, sink) { try { for (let k = 0; k < 4; k++) await vault.cardBit(k); } catch (e) {} sink.emit('0'); }`);
function B1_EIGHT_SRC(n: number) {
  return `export default async function (vault, sink) {
  let lo = 0n, hi = 10n ** 16n - 1n;
  try { for (let i = 0; i < ${n}; i++) { const mid = (lo + hi + 1n) / 2n; if (await vault.cardAtLeast(mid.toString())) lo = mid; else hi = mid - 1n; } } catch (e) { if (e.name !== 'Refused') throw e; }
  sink.emit(String(lo));
}`;
}

// Seeded (mulberry32) so a failure reproduces.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('countUpTo', () => {
  it('matches brute force on small ranges, masks and values', () => {
    const rand = rng(20261105);
    for (let t = 0; t < 400; t++) {
      const n = BigInt(Math.floor(rand() * 300));
      const mask = BigInt(Math.floor(rand() * 64));
      const val = BigInt(Math.floor(rand() * 64)) & mask;
      let want = 0n;
      for (let x = 0n; x <= n; x++) if ((x & mask) === val) want++;
      expect(countUpTo(n, mask, val), `n=${n} mask=${mask} val=${val}`).toBe(want);
    }
    expect(countUpTo(-1n, 0n, 0n)).toBe(0n);
  });
});

describe('leakage2', () => {
  it('is 0 with no answers, 1 for one bit answer, 2 for two, and adds thresholds and independent low bits', () => {
    expect(leakage2([])).toBeCloseTo(0, 9);
    expect(leakage2([{ kind: 'bit', k: 0, value: 1 }])).toBeCloseTo(1, 6);
    expect(leakage2([{ kind: 'bit', k: 0, value: 1 }, { kind: 'bit', k: 1, value: 0 }])).toBeCloseTo(2, 6);
    const ge = { kind: 'ge' as const, probe: 5n * 10n ** 15n, atLeast: true };
    expect(leakage2([ge])).toBeCloseTo(1, 5);
    expect(leakage2([ge, { kind: 'bit', k: 0, value: 1 }])).toBeCloseTo(2, 5);
  });
  it('a high bit already implied by a tight threshold adds almost nothing', () => {
    const ge = { kind: 'ge' as const, probe: 4n * 2n ** 50n, atLeast: true };
    const hiBit = { kind: 'bit' as const, k: 53, value: 0 as const };
    const a = leakage2([ge]);
    const both = leakage2([ge, hiBit]);
    expect(both - a).toBeLessThan(1);
  });
});

describe('C2 collusion host', () => {
  it('per-declassifier budgets (8 each): two processes leak about 16 bits between them', async () => {
    const r = await runCollusion(B1_EIGHT, B2_LOW_BITS, { scope: 'per-declassifier', budget: 8, card: CARD });
    expect(r.answeredGe).toBe(8);
    expect(r.answeredBit).toBe(8);
    expect(r.refused).toBe(0);
    expect(r.leakBits).toBeGreaterThan(15);
    expect(r.leakBits).toBeLessThanOrEqual(16.0001);
    expect(r.b2Emitted).toMatch(/\|\d{8}$/); // B2 received B1's public message
  }, 30000);
  it('one shared per-source-subject budget (8): the same two processes are held to 8 bits', async () => {
    const r = await runCollusion(B1_EIGHT, B2_LOW_BITS, { scope: 'per-source-subject', budget: 8, card: CARD });
    expect(r.answeredGe).toBe(8);
    expect(r.answeredBit).toBe(0);
    expect(r.refused).toBe(1); // B2 stops at its first Refused
    expect(r.leakBits).toBeLessThanOrEqual(8.0001);
    expect(r.leakBits).toBeGreaterThan(7);
  }, 30000);
  it('splitting the shared budget 4 and 4 still totals at most 8 bits', async () => {
    const r = await runCollusion(B1_FOUR, B2_FOUR, { scope: 'per-source-subject', budget: 8, card: CARD });
    expect(r.answeredGe + r.answeredBit).toBe(8);
    expect(r.leakBits).toBeLessThanOrEqual(8.0001);
  }, 30000);
  it('B1 cannot call card-bit and B2 cannot call card-at-least (each process holds one declassifier)', async () => {
    const peek1 = b('peek1.mjs', `export default async function (vault, sink) { sink.emit(JSON.stringify(Object.keys(vault))); }`);
    const peek2 = b('peek2.mjs', `export default async function (vault, sink) { sink.emit(JSON.stringify(Object.keys(vault))); }`);
    const r = await runCollusion(peek1, peek2, { scope: 'none', budget: 8, card: CARD });
    expect(r.b1Emitted).toBe('["cardAtLeast"]');
    expect(r.b2Emitted).toBe('["cardBit"]');
  }, 30000);
  it('rejects out-of-range bit indexes without charging, and recovers nothing from a stub', async () => {
    const f = b('badbit.mjs', `export default async function (vault, sink) { for (const k of [54, -1, 99, 'x']) { try { await vault.cardBit(k); } catch (e) {} } sink.emit('0'); }`);
    const r = await runCollusion(B1_FOUR, f, { scope: 'per-declassifier', budget: 8, card: CARD });
    expect(r.invalid).toBe(4);
    expect(r.answeredBit).toBe(0);
    expect(r.recovered).toBe(false);
  }, 30000);
  it('legitimate workload (40 cards, one check each) passes under both ledger scopes', () => {
    expect(legitWorkload('per-declassifier', 8)).toEqual({ passed: 40, total: 40 });
    expect(legitWorkload('per-source-subject', 8)).toEqual({ passed: 40, total: 40 });
  });
});
