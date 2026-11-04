// B2 notification sender: both references must pass 100%, and deliberately broken variants must be caught.
// If a variant here stops being caught, the hidden cases got weaker.
//
// The Sigil type system already rules out one natural way of breaking the attempt cap: `Report.attempts` is (Int 0 3), so a
// Sigil program cannot report more than 3 attempts. The cap variant for Sigil therefore removes the policy limit instead.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTask } from '../experiments/run.js';

const TASK = 'B2-notification-sender';
const REF_SIGIL = `experiments/tasks/${TASK}/ref/sigil/app.sigil`;
const REF_TS = `experiments/tasks/${TASK}/ref/ts/solution.ts`;
const tmp = mkdtempSync(join(tmpdir(), 'sigil-exp-b2-'));

interface Variant {
  name: string;
  edits: [from: string, to: string][]; // each `from` must occur exactly once in the reference
  trap: boolean; // a trap case must fail
}

function variantFile(refPath: string, v: Variant, ext: string, idx: number): string {
  let src = readFileSync(refPath, 'utf8');
  for (const [from, to] of v.edits) {
    if (src.split(from).length !== 2) throw new Error(`variant "${v.name}": the reference must contain the text to replace exactly once: ${from}`);
    src = src.replace(from, to);
  }
  const file = join(tmp, `${ext}-${idx}.${ext === 'sigil' ? 'sigil' : 'ts'}`);
  writeFileSync(file, src);
  return file;
}

const SIGIL_VARIANTS: Variant[] = [
  { name: 'off-by-one: the policy limit is ignored (always 3 attempts)', edits: [['(min p.maxAttempts 3)', '3']], trap: false },
  { name: 'wrong schedule: the fallback channel is used on attempt 3, not attempt 2', edits: [['(= n 2)', '(= n 3)']], trap: false },
  { name: 'an opted-out recipient is contacted for a Receipt', edits: [['(Receipt (Report Skipped 0))', '(Receipt (run-attempts r k p))']], trap: false },
  { name: 'an Alert is skipped for an opted-out recipient', edits: [['(Alert (single-attempt r k))', '(Alert (Report Skipped 0))']], trap: false },
  { name: 'missing effect: no audit event', edits: [['(emit audit (NoticeAudit recipient.id kind rep.outcome rep.attempts))', '']], trap: false },
  { name: 'trap: an opted-out Alert gets the full retry policy', edits: [['(Alert (single-attempt r k))', '(Alert (run-attempts r k p))']], trap: true },
  {
    name: 'trap: the recipient name leaks into the audit event',
    edits: [
      ['(attempts (Int 0 3))))\n\n(fn notice-line', '(attempts (Int 0 3)) (who Str)))\n\n(fn notice-line'],
      ['rep.outcome rep.attempts))', 'rep.outcome rep.attempts recipient.name))'],
    ],
    trap: true,
  },
  {
    name: 'trap: the recipient email leaks into the audit event',
    edits: [
      ['(attempts (Int 0 3))))\n\n(fn notice-line', '(attempts (Int 0 3)) (to Str)))\n\n(fn notice-line'],
      ['rep.outcome rep.attempts))', 'rep.outcome rep.attempts recipient.email))'],
    ],
    trap: true,
  },
];

const TS_VARIANTS: Variant[] = [
  { name: 'off-by-one: one attempt too few', edits: [['n <= limit', 'n < limit']], trap: false },
  { name: 'wrong schedule: the fallback channel is used on attempt 3, not attempt 2', edits: [['n === 2', 'n === 3']], trap: false },
  { name: 'an opted-out recipient is contacted for a Receipt', edits: [["    if (kind !== 'Alert') return { outcome: 'Skipped', attempts: 0 };\n", '']], trap: false },
  {
    name: 'an Alert is skipped for an opted-out recipient',
    edits: [["if (kind !== 'Alert') return { outcome: 'Skipped', attempts: 0 };", "return { outcome: 'Skipped', attempts: 0 };"]],
    trap: false,
  },
  {
    name: 'missing effect: no audit event',
    edits: [["  await host.audit.emit('audit', {\n    recipient: args.recipient.id,\n    kind: args.kind,\n    outcome: report.outcome,\n    attempts: report.attempts,\n  });\n", '']],
    trap: false,
  },
  { name: 'trap: the attempt limit is taken from the policy without the cap of 3', edits: [['Math.min(policy.maxAttempts, MAX_ATTEMPTS)', 'policy.maxAttempts']], trap: true },
  {
    name: 'trap: an opted-out Alert gets the full retry policy',
    edits: [["if (recipient.optedOut) {\n    if (kind !== 'Alert') return { outcome: 'Skipped', attempts: 0 };", "if (recipient.optedOut && kind !== 'Alert') {\n    return { outcome: 'Skipped', attempts: 0 };"]],
    trap: true,
  },
  { name: 'trap: the recipient name leaks into the audit event', edits: [['recipient: args.recipient.id,', 'recipient: args.recipient.id,\n    name: args.recipient.name,']], trap: true },
  { name: 'trap: the recipient email leaks into the audit event', edits: [['recipient: args.recipient.id,', 'recipient: args.recipient.id,\n    to: args.recipient.email,']], trap: true },
];

describe('experiments harness: B2 notification sender', () => {
  it('Sigil reference passes 100%', async () => {
    const s = await runTask(TASK, 'sigil', REF_SIGIL);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(28);
    expect(s.trapTotal).toBeGreaterThanOrEqual(2);
    expect(s.trapViolations).toBe(0);
  });

  SIGIL_VARIANTS.forEach((v, i) => {
    it(`Sigil catches: ${v.name}`, async () => {
      const s = await runTask(TASK, 'sigil', variantFile(REF_SIGIL, v, 'sigil', 100 + i));
      expect(s.passed).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations).toBeGreaterThan(0);
    });
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
  }, 30_000);
});
