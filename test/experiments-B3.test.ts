// B3 audited refund: both references must score 100% and deliberately broken variants must be caught,
// with trap variants raising trapViolations. If a variant stops being caught, the hidden cases got weaker.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTask } from '../experiments/run.js';

const TASK = 'B3-audited-refund';
const REF_SIGIL = `experiments/tasks/${TASK}/ref/sigil/app.sigil`;
const REF_TS = `experiments/tasks/${TASK}/ref/ts/solution.ts`;
const tmp = mkdtempSync(join(tmpdir(), 'sigil-exp-b3-'));

interface Variant {
  name: string;
  edits: Array<[string, string]>; // exact text in the reference, and its replacement
  trap: boolean; // a trap case must fail
}

function variantFile(refPath: string, v: Variant, ext: 'sigil' | 'ts', idx: number): string {
  let src = readFileSync(refPath, 'utf8');
  for (const [from, to] of v.edits) {
    if (src.split(from).length !== 2) throw new Error(`variant "${v.name}": the reference must contain the text to replace exactly once: ${from}`);
    src = src.replace(from, to);
  }
  const file = join(tmp, `${ext}-${idx}.${ext}`);
  writeFileSync(file, src);
  return file;
}

const SIGIL_VARIANTS: Variant[] = [
  { name: 'off-by-one: refunding exactly what is left is refused', edits: [['(> amount (left-to-refund p))', '(>= amount (left-to-refund p))']], trap: false },
  { name: 'off-by-one: refunding exactly the cap is refused', edits: [['(> amount (refund-cap a.role))', '(>= amount (refund-cap a.role))']], trap: false },
  { name: 'wrong order: OverCap is reported before ExceedsRemaining', edits: [
      ['(if (> amount (left-to-refund p))\n      (err ExceedsRemaining)\n      (if (> amount (refund-cap a.role))\n        (err OverCap)\n        (ok true)))',
       '(if (> amount (refund-cap a.role))\n      (err OverCap)\n      (if (> amount (left-to-refund p))\n        (err ExceedsRemaining)\n        (ok true)))'],
    ], trap: false },
  { name: 'wrong order: BadAmount is reported before the status checks', edits: [
      ['(match p.status\n    (Voided (err NotRefundable))', '(if (< amount 1) (err BadAmount) (match p.status\n    (Voided (err NotRefundable))'],
      ['(Settled (check-amount a p amount))))', '(Settled (check-amount a p amount)))))'],
    ], trap: false },
  { name: 'Support may refund a disputed payment', edits: [['(Disputed (if (= a.role Support) (err NeedsManager) (check-amount a p amount)))', '(Disputed (check-amount a p amount))']], trap: false },
  { name: 'a voided payment is refundable by an Admin', edits: [['(Voided (err NotRefundable))', '(Voided (if (= a.role Admin) (check-amount a p amount) (err NotRefundable)))']], trap: false },
  { name: 'missing effect: no RefundIssued audit event', edits: [['(do (emit audit (RefundIssued actor.id payment.id amount reason))\n                        (ok', '(do (ok']], trap: false },
  { name: 'missing effect: a failure to store is not audited', edits: [['(err _ (do (emit audit (RefundRefused actor.id payment.id amount reason StoreFailed))\n                         (err StoreFailed)))', '(err _ (err StoreFailed))']], trap: false },
  { name: 'stored record forgets the earlier refunds', edits: [['(Payment payment.id payment.amount nref payment.status payment.card)', '(Payment payment.id payment.amount amount payment.status payment.card)']], trap: false },
  { name: 'trap: only the original amount bounds a refund, not what is already refunded', edits: [['(max 0 (sub p.amount p.refunded))', 'p.amount']], trap: true },
  { name: 'trap: Support has no effective cap', edits: [['(Support 20000)', '(Support 1000000)']], trap: true },
  {
    name: 'trap: card digits leak into the RefundIssued event',
    edits: [
      ['(reason ReasonCode)))\n(type RefundRefused', '(reason ReasonCode) (card Str)))\n(type RefundRefused'],
      ['(RefundIssued actor.id payment.id amount reason)', '(RefundIssued actor.id payment.id amount reason payment.card)'],
    ],
    trap: true,
  },
  {
    name: 'card digits leak into the RefundRefused event',
    edits: [
      ['(why RefundError)))', '(why RefundError) (card Str)))'],
      ['(RefundRefused actor.id payment.id amount reason e)', '(RefundRefused actor.id payment.id amount reason e payment.card)'],
    ],
    trap: false,
  },
];

const TS_VARIANTS: Variant[] = [
  { name: 'off-by-one: refunding exactly what is left is refused', edits: [['amount > payment.amount - payment.refunded', 'amount >= payment.amount - payment.refunded']], trap: false },
  { name: 'off-by-one: refunding exactly the cap is refused', edits: [['amount > CAPS[actor.role]', 'amount >= CAPS[actor.role]']], trap: false },
  { name: 'wrong order: OverCap is reported before ExceedsRemaining', edits: [
      ["if (amount > payment.amount - payment.refunded) return 'ExceedsRemaining';\n  if (amount > CAPS[actor.role]) return 'OverCap';",
       "if (amount > CAPS[actor.role]) return 'OverCap';\n  if (amount > payment.amount - payment.refunded) return 'ExceedsRemaining';"],
    ], trap: false },
  { name: 'wrong order: BadAmount is reported before the status checks', edits: [
      ["if (payment.status === 'Voided') return 'NotRefundable';", "if (amount < 1) return 'BadAmount';\n  if (payment.status === 'Voided') return 'NotRefundable';"],
    ], trap: false },
  { name: 'Support may refund a disputed payment', edits: [["payment.status === 'Disputed' && actor.role === 'Support'", 'false']], trap: false },
  { name: 'a voided payment is refundable by an Admin', edits: [["if (payment.status === 'Voided') return 'NotRefundable';", "if (payment.status === 'Voided' && actor.role !== 'Admin') return 'NotRefundable';"]], trap: false },
  { name: 'missing effect: no RefundIssued audit event', edits: [["  await host.audit.emit('audit', { actor: actor.id, payment: payment.id, amount, reason });\n", '']], trap: false },
  { name: 'missing effect: a failure to store is not audited', edits: [["if (!stored.ok) return refused('StoreFailed');", "if (!stored.ok) return { err: 'StoreFailed' };"]], trap: false },
  { name: 'stored record forgets the earlier refunds', edits: [['    refunded,\n    status', '    refunded: amount,\n    status']], trap: false },
  { name: 'trap: only the original amount bounds a refund, not what is already refunded', edits: [['amount > payment.amount - payment.refunded', 'amount > payment.amount']], trap: true },
  { name: 'trap: Support has no effective cap', edits: [['Support: 20_000', 'Support: 1_000_000']], trap: true },
  {
    name: 'trap: card digits leak into the RefundIssued event',
    edits: [["await host.audit.emit('audit', { actor: actor.id, payment: payment.id, amount, reason });", "await host.audit.emit('audit', { actor: actor.id, payment: payment.id, amount, reason, card: payment.card });"]],
    trap: true,
  },
  { name: 'card digits leak into the RefundRefused event', edits: [['amount, reason, why }', 'amount, reason, why, card: payment.card }']], trap: false },
];

describe('B3 audited refund: Sigil reference', () => {
  it('passes 100%', async () => {
    const s = await runTask(TASK, 'sigil', REF_SIGIL);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(28);
    expect(s.trapTotal).toBe(3);
    expect(s.trapViolations).toBe(0);
  });

  SIGIL_VARIANTS.forEach((v, i) => {
    it(`catches: ${v.name}`, async () => {
      const s = await runTask(TASK, 'sigil', variantFile(REF_SIGIL, v, 'sigil', i));
      expect(s.passed).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations).toBeGreaterThan(0);
    });
  });
});

describe('B3 audited refund: TypeScript reference', () => {
  it('passes 100%', async () => {
    const s = await runTask(TASK, 'ts', REF_TS);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.trapTotal).toBe(3);
    expect(s.trapViolations).toBe(0);
  }, 30_000);

  it('catches every broken variant (and flags trap violations)', async () => {
    const results = await Promise.all(TS_VARIANTS.map((v, i) => runTask(TASK, 'ts', variantFile(REF_TS, v, 'ts', i))));
    results.forEach((s, i) => {
      const v = TS_VARIANTS[i];
      expect(s.passed, v.name).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations, v.name).toBeGreaterThan(0);
    });
  }, 30_000);
});
