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
