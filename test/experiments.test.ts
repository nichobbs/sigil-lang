// The scoring harness must (1) pass the reference solutions in both languages and (2) catch deliberately
// broken variants, flagging trap violations. If a variant here stops being caught, the hidden cases got weaker.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runTask } from '../experiments/run.js';

const TASK = 'A1-tiered-pricing';
const REF_SIGIL = `experiments/tasks/${TASK}/ref/sigil/app.sigil`;
const REF_TS = `experiments/tasks/${TASK}/ref/ts/solution.ts`;
const tmp = mkdtempSync(join(tmpdir(), 'sigil-exp-'));
afterAll(() => {
  delete process.env.EXPERIMENT_HIDDEN_DIR;
});

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
  { name: 'off-by-one at the 10-unit boundary', from: '(if (< qty 10) 0', to: '(if (<= qty 10) 0', trap: false },
  { name: 'wrong rounding: line discount rounds up', from: '(div-floor (mul (line-gross l) (sub 100 (volume-pct l.qty))) 100))', to: '(div-floor (add (mul (line-gross l) (sub 100 (volume-pct l.qty))) 99) 100))', trap: false },
  { name: 'missing effect: no QuoteIssued audit event', from: '(emit audit (QuoteIssued q.id q.cust q.due))', to: '', trap: false },
  { name: 'trap: floor is rounded down instead of up', from: '(add (mul (gross ls) 80) 99)', to: '(mul (gross ls) 80)', trap: true },
  { name: 'trap: all credit is used even when it exceeds the total', from: 'used (min cust.credit t)', to: 'used cust.credit', trap: true },
  {
    name: 'trap: customer name leaks into the audit event',
    from: '(due Cents :internal)))\n(type QuoteRefused',
    to: '(due Cents :internal) (who Str)))\n(type QuoteRefused',
    trap: true,
  },
];
// The name-leak variant needs a second edit (the constructor call), applied below.

const TS_VARIANTS: Variant[] = [
  { name: 'off-by-one at the 10-unit boundary', from: 'qty < 10 ? 0', to: 'qty <= 10 ? 0', trap: false },
  { name: 'wrong rounding: Math.round on the line discount', from: 'Math.floor((l.unit * l.qty * (100 - volumePct(l.qty))) / 100)', to: 'Math.round((l.unit * l.qty * (100 - volumePct(l.qty))) / 100)', trap: false },
  { name: 'missing effect: no QuoteIssued audit event', from: "await host.audit.emit('audit', { id, cust: cust.id, due: quote.due });", to: '', trap: false },
  { name: 'trap: floor is rounded down instead of up', from: '(gross * 80 + 99) / 100', to: '(gross * 80) / 100', trap: true },
  { name: 'trap: negative amount due when credit exceeds the total', from: 'Math.min(cust.credit, total)', to: 'cust.credit', trap: true },
  { name: 'trap: customer name leaks into the audit event', from: '{ id, cust: cust.id, due: quote.due }', to: '{ id, cust: cust.id, due: quote.due, who: cust.name }', trap: true },
];

describe('experiments harness: Sigil runner', () => {
  it('reference solution passes 100%', async () => {
    const s = await runTask(TASK, 'sigil', REF_SIGIL);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(25);
    expect(s.trapTotal).toBe(3);
    expect(s.trapViolations).toBe(0);
  });

  SIGIL_VARIANTS.forEach((v, i) => {
    it(`catches: ${v.name}`, async () => {
      let file = variantFile(REF_SIGIL, v, 'sigil', i);
      if (v.name.includes('name leaks')) {
        const src = readFileSync(file, 'utf8');
        const edited = src.replace('(QuoteIssued q.id q.cust q.due)', '(QuoteIssued q.id q.cust q.due cust.name)');
        expect(edited).not.toBe(src);
        writeFileSync(file, edited);
      }
      const s = await runTask(TASK, 'sigil', file);
      expect(s.passed).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations).toBeGreaterThan(0);
      else expect(s.failures.length).toBeGreaterThan(0);
    });
  });

  it('a program that does not parse fails every case with a reason, not a crash', async () => {
    const f = join(tmp, 'broken.sigil');
    writeFileSync(f, '(fn oops (in (x Int');
    const s = await runTask(TASK, 'sigil', f);
    expect(s.passed).toBe(0);
    expect(s.trapViolations).toBe(s.trapTotal);
    expect(s.failures[0].reason).toMatch(/parse error/);
  });

  it('a missing solution fails every case', async () => {
    const s = await runTask(TASK, 'sigil', join(tmp, 'nope.sigil'));
    expect(s.passed).toBe(0);
    expect(s.failures[0].reason).toMatch(/not found/);
  });
});

describe('experiments harness: TypeScript runner', () => {
  it('reference solution passes 100%', async () => {
    const s = await runTask(TASK, 'ts', REF_TS);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.trapViolations).toBe(0);
  }, 30_000);

  it('catches every broken variant (and flags trap violations)', async () => {
    const results = await Promise.all(TS_VARIANTS.map((v, i) => runTask(TASK, 'ts', variantFile(REF_TS, v, 'ts', i))));
    results.forEach((s, i) => {
      const v = TS_VARIANTS[i];
      expect(s.passed, v.name).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations, v.name).toBeGreaterThan(0);
      else expect(s.failures.length, v.name).toBeGreaterThan(0);
    });
  }, 30_000);

  it('a crash, a hang and a wrong shape are failures with reasons, and the other cases still run', async () => {
    const ref = readFileSync(REF_TS, 'utf8');
    const hang = join(tmp, 'hang.ts');
    writeFileSync(hang, ref.replace('const gross =', 'if (lines.length === 50) { for (;;) {} }\n  const gross ='));
    const crash = join(tmp, 'crash.ts');
    writeFileSync(crash, ref.replace('const gross =', "if (lines.length === 50) throw new Error('boom');\n  const gross ="));
    const shape = join(tmp, 'shape.ts');
    writeFileSync(shape, ref.replace('return { ok: quote };', 'return { ok: { ...quote, total: BigInt(quote.total) } } as never;'));
    const [h, c, s] = await Promise.all([
      runTask(TASK, 'ts', hang, { timeoutMs: 400 }),
      runTask(TASK, 'ts', crash),
      runTask(TASK, 'ts', shape),
    ]);
    expect(h.failures.map((f) => f.reason)).toEqual([expect.stringMatching(/timeout/)]);
    expect(h.passed).toBe(h.total - 1);
    expect(c.failures.map((f) => f.reason)).toEqual([expect.stringMatching(/crash: boom/)]);
    expect(s.passed).toBeLessThan(s.total);
    expect(s.failures[0].reason).toMatch(/bigint/);
  }, 30_000);

  it('a module without a default export fails every case', async () => {
    const f = join(tmp, 'noexport.ts');
    writeFileSync(f, 'export const run = () => 1;\n');
    const s = await runTask(TASK, 'ts', f);
    expect(s.passed).toBe(0);
    expect(s.failures[0].reason).toMatch(/default-export/);
  }, 30_000);
});

describe('experiments harness: hidden cases are relocatable', () => {
  it('reads cases.json from EXPERIMENT_HIDDEN_DIR', async () => {
    const cf = JSON.parse(readFileSync(`experiments/tasks/${TASK}/hidden/cases.json`, 'utf8'));
    cf.cases = cf.cases.slice(0, 3);
    const dir = mkdtempSync(join(tmp, 'hidden-'));
    writeFileSync(join(dir, 'cases.json'), JSON.stringify(cf));
    process.env.EXPERIMENT_HIDDEN_DIR = dir;
    try {
      const s = await runTask(TASK, 'sigil', REF_SIGIL);
      expect(s.total).toBe(3);
      expect(s.passed).toBe(3);
    } finally {
      delete process.env.EXPERIMENT_HIDDEN_DIR;
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A2 ledger postings: the same checks for the second dev task.

const A2 = 'A2-ledger-postings';
const A2_SIGIL = `experiments/tasks/${A2}/ref/sigil/app.sigil`;
const A2_TS = `experiments/tasks/${A2}/ref/ts/solution.ts`;

const A2_SIGIL_VARIANTS: Variant[] = [
  { name: 'trap: the overdraft boundary is exclusive', from: '(< (sub a.balance p.amount) (neg (overdraft-limit a.kind)))', to: '(<= (sub a.balance p.amount) (neg (overdraft-limit a.kind)))', trap: true },
  { name: 'trap: the daily limit is exclusive', from: '(> (add a.spent p.amount) 200000)', to: '(>= (add a.spent p.amount) 200000)', trap: true },
  {
    name: 'trap: a Frozen account refuses a Credit',
    from: '(Credit (accept acct posting (min 1000000000000 (add acct.balance posting.amount)) acct.spent))',
    to: '(Credit (if (is-frozen acct) (reject acct AcctFrozen) (accept acct posting (min 1000000000000 (add acct.balance posting.amount)) acct.spent)))',
    trap: true,
  },
  {
    name: 'trap: Insufficient is checked before OverLimit',
    from: '(if (over-limit acct posting)\n          (reject acct OverLimit)\n          (if (would-overdraw acct posting)\n            (reject acct Insufficient)',
    to: '(if (would-overdraw acct posting)\n          (reject acct Insufficient)\n          (if (over-limit acct posting)\n            (reject acct OverLimit)',
    trap: true,
  },
  { name: 'Savings gets the Checking overdraft allowance', from: '(Savings 0)', to: '(Savings 50000)', trap: false },
  { name: 'a Debit does not add to spent today', from: '(min 1000000000000 (add acct.spent posting.amount))', to: 'acct.spent', trap: false },
  {
    name: 'a Fee adds to spent today',
    from: '(accept acct posting (max -50000 (sub acct.balance posting.amount)) acct.spent))))))',
    to: '(accept acct posting (max -50000 (sub acct.balance posting.amount)) (min 1000000000000 (add acct.spent posting.amount))))))))',
    trap: false,
  },
  { name: 'missing effect: no audit event on a refusal', from: '(do (emit audit (PostingRejected a.id why))\n      (err why))', to: '(err why)', trap: false },
];

const A2_TS_VARIANTS: Variant[] = [
  { name: 'trap: the overdraft boundary is exclusive', from: 'acct.balance - amount < -overdraftLimit(acct.kind)', to: 'acct.balance - amount <= -overdraftLimit(acct.kind)', trap: true },
  { name: 'trap: the daily limit is exclusive', from: 'acct.spent + amount > DAILY_LIMIT', to: 'acct.spent + amount >= DAILY_LIMIT', trap: true },
  { name: 'trap: a Frozen account refuses a Credit', from: "if (kind !== 'Credit' && frozen)", to: 'if (frozen)', trap: true },
  {
    name: 'trap: Insufficient is checked before OverLimit',
    from: "if (overLimit) return reject('OverLimit');\n  if (overdraws) return reject('Insufficient');",
    to: "if (overdraws) return reject('Insufficient');\n  if (overLimit) return reject('OverLimit');",
    trap: true,
  },
  { name: 'Savings gets the Checking overdraft allowance', from: "k === 'Checking' ? 50_000 : 0", to: "k === 'Checking' ? 50_000 : 50_000", trap: false },
  { name: 'a Fee adds to spent today', from: "kind === 'Debit' ? Math.min(MAX, acct.spent + amount)", to: "kind !== 'Credit' ? Math.min(MAX, acct.spent + amount)", trap: false },
  { name: 'a Fee is subject to the daily limit', from: "kind === 'Debit' && acct.spent + amount", to: "kind !== 'Credit' && acct.spent + amount", trap: false },
  { name: 'missing effect: no audit event on a refusal', from: "await host.audit.emit('audit', { acct: acct.id, reason: why });", to: '', trap: false },
];

describe('experiments harness: task A2 (Sigil)', () => {
  it('reference solution passes 100%', async () => {
    const s = await runTask(A2, 'sigil', A2_SIGIL);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(28);
    expect(s.trapTotal).toBe(3);
    expect(s.trapViolations).toBe(0);
  });

  A2_SIGIL_VARIANTS.forEach((v, i) => {
    it(`catches: ${v.name}`, async () => {
      const s = await runTask(A2, 'sigil', variantFile(A2_SIGIL, v, 'sigil', 100 + i));
      expect(s.passed).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations).toBeGreaterThan(0);
      else expect(s.failures.length).toBeGreaterThan(0);
    });
  });
});

describe('experiments harness: task A2 (TypeScript)', () => {
  it('reference solution passes 100%', async () => {
    const s = await runTask(A2, 'ts', A2_TS);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.trapTotal).toBe(3);
    expect(s.trapViolations).toBe(0);
  }, 30_000);

  it('catches every broken variant (and flags trap violations)', async () => {
    const results = await Promise.all(A2_TS_VARIANTS.map((v, i) => runTask(A2, 'ts', variantFile(A2_TS, v, 'ts', 100 + i))));
    results.forEach((s, i) => {
      const v = A2_TS_VARIANTS[i];
      expect(s.passed, v.name).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations, v.name).toBeGreaterThan(0);
      else expect(s.failures.length, v.name).toBeGreaterThan(0);
    });
  }, 30_000);
});

// ---- A3: rate limiter ---------------------------------------------------------------------------------------------

const TASK3 = 'A3-rate-limiter';
const REF3_SIGIL = `experiments/tasks/${TASK3}/ref/sigil/app.sigil`;
const REF3_TS = `experiments/tasks/${TASK3}/ref/ts/solution.ts`;

interface Variant3 extends Variant {
  also?: { from: string; to: string }; // a second edit, for variants that need two coordinated changes
}

function variantFile3(refPath: string, v: Variant3, ext: 'sigil' | 'ts', idx: number): string {
  let src = readFileSync(refPath, 'utf8');
  for (const e of [{ from: v.from, to: v.to }, ...(v.also ? [v.also] : [])]) {
    if (src.split(e.from).length !== 2) throw new Error(`variant "${v.name}": the reference must contain the text to replace exactly once`);
    src = src.replace(e.from, e.to);
  }
  const file = join(tmp, `a3-${ext}-${idx}.${ext}`);
  writeFileSync(file, src);
  return file;
}

const A3_SIGIL_VARIANTS: Variant3[] = [
  { name: 'trap: the window boundary belongs to the old window', from: '(>= now (add s.start 60000))', to: '(> now (add s.start 60000))', trap: true },
  { name: 'trap: retry-after rounds down', from: '(add (sub (add s.start 60000) now) 999)', to: '(sub (add s.start 60000) now)', trap: true },
  {
    name: 'trap: the api key leaks into the audit event',
    from: '(type Admitted  (rec (plan Plan)',
    to: '(type Admitted  (rec (who ApiKey) (plan Plan)',
    also: { from: '(emit audit (Admitted req.plan req.cost (max 0 (sub allow total)) false))', to: '(emit audit (Admitted req.key req.plan req.cost (max 0 (sub allow total)) false))' },
    trap: true,
  },
  { name: 'off-by-one: exactly the allowance is denied', from: '(if (<= total allow)', to: '(if (< total allow)', trap: false },
  { name: 'a Free request may borrow the burst', from: '(if (= p Free) 0 (div-floor (allowance p) 10))', to: '(div-floor (allowance p) 10)', trap: false },
  { name: 'missing effect: an allowed request does not store the window', from: '(put store:limits 0 (State cur.start (min total 1000000000) cur.burst))', to: '', trap: false },
  { name: 'a request larger than the allowance may use the burst', from: '(if (> req.cost allow)', to: '(if (> req.cost (add allow extra))', trap: false },
  { name: 'a new window keeps the old burst flag', from: '(State now 0 false)', to: '(State now 0 s.burst)', trap: false },
  { name: 'a new window keeps the old start', from: '(State now 0 false)', to: '(State s.start 0 false)', trap: false },
];

const A3_TS_VARIANTS: Variant3[] = [
  { name: 'trap: the window boundary belongs to the old window', from: 'req.now >= state.start + WINDOW_MS', to: 'req.now > state.start + WINDOW_MS', trap: true },
  { name: 'trap: retry-after rounds down', from: 'Math.ceil((cur.start', to: 'Math.floor((cur.start', trap: true },
  { name: 'trap: the api key leaks into the audit event', from: '{ plan: req.plan, cost: req.cost, remaining, burst: false }', to: '{ plan: req.plan, cost: req.cost, remaining, burst: false, who: req.key }', trap: true },
  { name: 'off-by-one: exactly the allowance is denied', from: 'if (total <= allow) {', to: 'if (total < allow) {', trap: false },
  { name: 'a Free request may borrow the burst', from: "(p === 'Free' ? 0 : Math.floor(allowanceOf(p) / 10))", to: '(Math.floor(allowanceOf(p) / 10))', trap: false },
  { name: 'missing effect: an allowed request does not store the window', from: "await host.store.put('store:limits', 0, { start: cur.start, used: total, burst: cur.burst });", to: '', trap: false },
  { name: 'a request larger than the allowance may use the burst', from: 'if (req.cost > allow) {', to: 'if (req.cost > allow + burstOf(req.plan)) {', trap: false },
  { name: 'a new window keeps the old burst flag', from: '{ start: req.now, used: 0, burst: false }', to: '{ start: req.now, used: 0, burst: state.burst }', trap: false },
  { name: 'a new window keeps the old start', from: '{ start: req.now, used: 0, burst: false }', to: '{ start: state.start, used: 0, burst: false }', trap: false },
];

describe('experiments harness: A3 rate limiter, Sigil runner', () => {
  it('reference solution passes 100%', async () => {
    const s = await runTask(TASK3, 'sigil', REF3_SIGIL);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(28);
    expect(s.trapTotal).toBe(3);
    expect(s.trapViolations).toBe(0);
  });

  A3_SIGIL_VARIANTS.forEach((v, i) => {
    it(`catches: ${v.name}`, async () => {
      const s = await runTask(TASK3, 'sigil', variantFile3(REF3_SIGIL, v, 'sigil', i));
      expect(s.passed).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations).toBeGreaterThan(0);
      else expect(s.failures.length).toBeGreaterThan(0);
    });
  });
});

describe('experiments harness: A3 rate limiter, TypeScript runner', () => {
  it('reference solution passes 100%', async () => {
    const s = await runTask(TASK3, 'ts', REF3_TS);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(28);
    expect(s.trapTotal).toBe(3);
    expect(s.trapViolations).toBe(0);
  }, 30_000);

  it('catches every broken variant (and flags trap violations)', async () => {
    const results = await Promise.all(A3_TS_VARIANTS.map((v, i) => runTask(TASK3, 'ts', variantFile3(REF3_TS, v, 'ts', i))));
    results.forEach((s, i) => {
      const v = A3_TS_VARIANTS[i];
      expect(s.passed, v.name).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations, v.name).toBeGreaterThan(0);
      else expect(s.failures.length, v.name).toBeGreaterThan(0);
    });
  }, 30_000);
});
