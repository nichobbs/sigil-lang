import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, errors } from '../src/check.js';
import { parsePolicy, parseProgram } from '../src/parse.js';
import { SigilError } from '../src/sexpr.js';

const read = (p: string) => readFileSync(new URL(`../experiments/tasks/${p}`, import.meta.url), 'utf8');
const POLICY = read('G3-qa-plus-fraud/visible/policy.sigil');
const BOUNDED = POLICY.replace('(fns refund)))', '(fns refund)\n    (max-bits 1)))');
const LAUNDERED = read('G3-qa-plus-fraud/probe/laundered-app.sigil');
const QA_ONLY = read('G2-qa-discover/ref/sigil/app.sigil');

const run = (app: string, policy: string) => check(parseProgram(app), parsePolicy(policy));
const msgs = (app: string, policy: string) => errors(run(app, policy)).map((d) => `${d.code}: ${d.msg}`);

describe('declassifier max-bits', () => {
  it('the policy without max-bits still accepts the digit-sum launder (the hole), and warns', () => {
    const r = run(LAUNDERED, POLICY);
    expect(errors(r)).toEqual([]);
    expect(r.diags.some((d) => d.code === 'W-declassify' && /max-bits/.test(d.msg))).toBe(true);
  });

  it('with (max-bits 1) the digit-sum release is rejected as E-policy', () => {
    const m = msgs(LAUNDERED, BOUNDED);
    expect(m.some((x) => x.startsWith('E-policy') && /at most 1 bit/.test(x) && /digit-sum/.test(x))).toBe(true);
  });

  it('with (max-bits 1) the yes/no QA check is accepted and no max-bits warning appears', () => {
    const r = run(QA_ONLY, BOUNDED);
    expect(errors(r)).toEqual([]);
    expect(r.diags.some((d) => /max-bits/.test(d.msg))).toBe(false);
  });

  it('rejects a malformed clause', () => {
    for (const bad of ['(max-bits 0)', '(max-bits 65)', '(max-bits x)', '(max-bits 1 2)']) {
      expect(() => parsePolicy(POLICY.replace('(fns refund)))', `(fns refund) ${bad}))`))).toThrow(SigilError);
    }
  });
});
