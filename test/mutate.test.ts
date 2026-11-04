import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enumerateMutants, runMutation } from '../src/mutate.js';
import { parsePolicy, parseProgram } from '../src/parse.js';
import { parseFeature, parseGlossary } from '../src/scenario.js';

const read = (p: string) => readFileSync(new URL(`../examples/invoicing/${p}`, import.meta.url), 'utf8');
const APP = read('app.sigil');
const POLICY = read('policy.sigil');
const FEATURE = read('invoicing.feature');
const GLOSSARY = read('glossary.sigil');

describe('mutation adequacy', () => {
  const prog = parseProgram(APP);
  const pol = parsePolicy(POLICY);

  it('enumerates mutants across the implementation', () => {
    const ms = enumerateMutants(prog);
    expect(ms.length).toBeGreaterThan(20);
    expect(ms.some((m) => m.desc === '20 -> 21')).toBe(true);
    expect(ms.some((m) => m.desc.startsWith('delete statement (emit audit'))).toBe(true);
  });

  const rep = runMutation(prog, pol, parseFeature(FEATURE), (p) => parseGlossary(GLOSSARY, p));

  it('the Enterprise discount mutant is killed because the Rule table pins it', () => {
    expect(rep.survivors.some((s) => s.desc === '20 -> 21')).toBe(false);
  });

  it('the only survivor is the Unresolved mail-failure question, which a human must answer', () => {
    expect(rep.total).toBe(22);
    expect(rep.survivors.map((s) => `${s.fn}: ${s.desc}`)).toEqual(['issue-invoice: :on-err MailFailed -> StoreFailed']);
    // the feature still carries the open question that explains it
    expect(parseFeature(FEATURE).unresolved).toHaveLength(1);
  });

  it('receipt wording and the audit emit are no longer survivors', () => {
    const descs = rep.survivors.map((s) => s.desc);
    expect(descs.some((d) => d.includes('Invoice ') || d.includes('Hello ') || d.includes('your total is'))).toBe(false);
    expect(descs.some((d) => d.startsWith('delete statement (emit audit'))).toBe(false);
  });

  it('kills most mutants overall', () => {
    const killed = rep.total - rep.survivors.length;
    expect(killed / rep.total).toBeGreaterThan(0.6);
  });

  it('without the Rule table, the Enterprise rate becomes a surviving mutant (spec gap)', () => {
    const noRule = FEATURE.replace(/  Rule:[\s\S]*?\n\n/, '');
    const r = runMutation(prog, pol, parseFeature(noRule), (p) => parseGlossary(GLOSSARY, p));
    expect(r.survivors.some((s) => s.desc === '20 -> 21')).toBe(true);
  });
});
