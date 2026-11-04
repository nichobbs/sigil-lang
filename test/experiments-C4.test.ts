// Task C4 (schedule conflicts): both references must pass the hidden cases, and deliberately broken variants must be caught,
// with trap variants raising trapViolations. If a variant here stops being caught, the hidden cases got weaker.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTask } from '../experiments/run.js';

const TASK = 'C4-schedule-conflicts';
const REF_SIGIL = `experiments/tasks/${TASK}/ref/sigil/app.sigil`;
const REF_TS = `experiments/tasks/${TASK}/ref/ts/solution.ts`;
const tmp = mkdtempSync(join(tmpdir(), 'sigil-exp-c4-'));

interface Variant {
  name: string;
  from: string; // exact text in the reference
  to: string;
  trap: boolean; // a trap case must fail
}

function variantFile(refPath: string, v: Variant, ext: string, idx: number): string {
  const src = readFileSync(refPath, 'utf8');
  if (src.split(v.from).length !== 2) throw new Error(`variant "${v.name}": the reference must contain the text to replace exactly once`);
  const file = join(tmp, `${ext}-${idx}.${ext === 'sigil' ? 'sigil' : 'ts'}`);
  writeFileSync(file, src.replace(v.from, v.to));
  return file;
}

const SIGIL_VARIANTS: Variant[] = [
  { name: 'trap: a booking exactly the buffer away conflicts (< became <=)', from: '(< start (add b.end buffer))', to: '(<= start (add b.end buffer))', trap: true },
  { name: 'off-by-one on the other side: request ending exactly buffer before a booking conflicts', from: '(< b.start (add end buffer))', to: '(<= b.start (add end buffer))', trap: false },
  { name: 'buffer applied only before the request', from: '(add b.end buffer)', to: 'b.end', trap: false },
  { name: 'trap: Staff may displace Tentative bookings', from: '(Staff hits)', to: '(Staff (filter hits (fn (b) (= b.status Confirmed))))', trap: true },
  { name: 'trap: displaced ids missing from the result and the audit event', from: '(let [displaced (map hits (fn (b) b.id))]', to: '(let [displaced (map (filter hits (fn (b) false)) (fn (b) b.id))]', trap: true },
  { name: 'Manager is also blocked by Tentative bookings', from: '(Manager (filter hits (fn (b) (= b.status Confirmed))))', to: '(Manager hits)', trap: false },
  { name: 'refusal names the highest blocking id', from: '(< o.id b.id)', to: '(> o.id b.id)', trap: false },
  { name: 'BadRange off-by-one: end at the end of the week is refused', from: '(> end 10080)', to: '(>= end 10080)', trap: false },
  { name: 'wrong status: Manager bookings stored as Tentative', from: '(match role (Staff Tentative) (Manager Confirmed))', to: '(match role (Staff Tentative) (Manager Tentative))', trap: false },
  { name: 'missing effect: no audit event', from: '(do (emit audit (BookingAccepted role id displaced))\n                      (ok (Accepted id displaced)))', to: '(ok (Accepted id displaced))', trap: false },
  { name: 'missing effect: booking not stored', from: '(put store:bookings id (Booking id start end (new-status role)))', to: '(ok 0)', trap: false },
];

const TS_VARIANTS: Variant[] = [
  { name: 'trap: a booking exactly the buffer away conflicts (< became <=)', from: 'start < b.end + buffer', to: 'start <= b.end + buffer', trap: true },
  { name: 'off-by-one on the other side: request ending exactly buffer before a booking conflicts', from: 'b.start < end + buffer', to: 'b.start <= end + buffer', trap: false },
  { name: 'buffer applied only before the request', from: 'start < b.end + buffer', to: 'start < b.end', trap: false },
  { name: 'trap: Staff may displace Tentative bookings', from: "role === 'Staff' || b.status === 'Confirmed'", to: "b.status === 'Confirmed'", trap: true },
  { name: 'trap: displaced ids missing from the result and the audit event', from: 'const displaced = hits.map((b) => b.id);', to: 'const displaced: number[] = [];', trap: true },
  { name: 'Manager is also blocked by Tentative bookings', from: "role === 'Staff' || b.status === 'Confirmed'", to: 'true', trap: false },
  { name: 'refusal names the first blocking booking in list order', from: 'Math.min(...blockers.map((b) => b.id))', to: 'blockers[0].id', trap: false },
  { name: 'BadRange off-by-one: end at the end of the week is refused', from: 'end > WEEK', to: 'end >= WEEK', trap: false },
  { name: 'wrong status: Manager bookings stored as Tentative', from: "status: role === 'Manager' ? 'Confirmed' : 'Tentative'", to: "status: 'Tentative'", trap: false },
  { name: 'missing effect: no audit event', from: "await host.audit.emit('audit', { role, id, displaced });", to: '', trap: false },
  { name: 'missing effect: booking not stored', from: "const stored = await host.store.put('store:bookings', id, booking);", to: 'const stored = { ok: true };', trap: false },
];

describe('experiments harness: C4 schedule conflicts', () => {
  it('Sigil reference passes 100%', async () => {
    const s = await runTask(TASK, 'sigil', REF_SIGIL);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(28);
    expect(s.total).toBeLessThanOrEqual(45);
    expect(s.trapTotal).toBeGreaterThanOrEqual(2);
    expect(s.trapViolations).toBe(0);
  }, 30_000);

  SIGIL_VARIANTS.forEach((v, i) => {
    it(`Sigil catches: ${v.name}`, async () => {
      const s = await runTask(TASK, 'sigil', variantFile(REF_SIGIL, v, 'sigil', 100 + i));
      expect(s.passed).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations).toBeGreaterThan(0);
    }, 30_000);
  });

  it('TypeScript reference passes 100%', async () => {
    const s = await runTask(TASK, 'ts', REF_TS);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.trapViolations).toBe(0);
  }, 30_000);

  it('TypeScript catches every broken variant (and flags trap violations)', async () => {
    const results = await Promise.all(TS_VARIANTS.map((v, i) => runTask(TASK, 'ts', variantFile(REF_TS, v, 'ts', 100 + i))));
    results.forEach((s, i) => {
      const v = TS_VARIANTS[i];
      expect(s.passed, v.name).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations, v.name).toBeGreaterThan(0);
    });
  }, 60_000);
});
