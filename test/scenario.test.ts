import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import { parsePolicy, parseProgram } from '../src/parse.js';
import { DEFAULT_SUITE, parseFeature, parseGlossary, runSuite } from '../src/scenario.js';

const read = (p: string) => readFileSync(new URL(`../examples/invoicing/${p}`, import.meta.url), 'utf8');
const APP = read('app.sigil');
const POLICY = read('policy.sigil');
const FEATURE = read('invoicing.feature');
const GLOSSARY = read('glossary.sigil');

function suite(app = APP, feature = FEATURE, glossary = GLOSSARY, opts = DEFAULT_SUITE) {
  const prog = parseProgram(app);
  const chk = check(prog, parsePolicy(POLICY));
  return runSuite(prog, parseFeature(feature), parseGlossary(glossary, prog), chk, opts);
}

describe('feature parser', () => {
  const f = parseFeature(FEATURE);
  it('reads rules, examples, properties, privacy and open questions', () => {
    expect(f.title).toBe('Invoicing');
    expect(f.rules[0].rows).toEqual([['Free', '0%'], ['Pro', '10%'], ['Enterprise', '20%']]);
    expect(f.examples.map((e) => e.title)).toHaveLength(7);
    expect(f.examples[0].steps.map((s) => s.kind)).toEqual(['given', 'given', 'when', 'then']);
    expect(f.always[0].text).toBe('The price is never negative and never more than the undiscounted total.');
    expect(f.privacy[0].text).toContain('Changing it must not change anything sent anywhere else.');
    expect(f.unresolved[0].text).toContain('audit event');
  });
});

describe('suite on the invoicing example', () => {
  const out = suite();
  it('every scenario, rule, property and privacy check passes', () => {
    for (const r of out.results) expect(r, `${r.kind}: ${r.title}`).toMatchObject({ status: 'pass' });
    expect(out.results.map((r) => r.kind).sort()).toEqual(['always', ...Array(7).fill('example'), 'privacy', 'rule']);
  });
  it('surfaces the spec gap as an unresolved question rather than guessing', () => {
    expect(out.unresolved).toHaveLength(1);
  });
  it('turns the unproved interval obligation into tested evidence', () => {
    expect(out.ensuresStats.get('price-invoice#0')).toBeGreaterThan(500);
  });
  it('the privacy check is not vacuous', () => {
    const p = out.results.find((r) => r.kind === 'privacy')!;
    expect(p.note).toMatch(/influenced the allowed sink/);
  });
});

describe('closed spec gaps are pinned by scenarios', () => {
  const failing = (app: string, title: string) => suite(app).results.find((r) => r.title === title)!;
  it('a changed receipt word fails the receipt example', () => {
    const r = failing(APP.replace('"Hello "', '"Hi "'), 'The receipt names the invoice, the customer and the total');
    expect(r.status).toBe('fail');
    expect(r.message).toContain('the email body is');
  });
  it('a missing audit emit fails the audit example', () => {
    const r = failing(APP.replace('    (emit audit (Issued inv.id))\n', ''), 'Issuing an invoice records an audit event');
    expect(r.status).toBe('fail');
  });
});

describe('scenario failures are precise', () => {
  it('reports a failing example with the step and values', () => {
    const bad = APP.replace('(Pro 10)', '(Pro 11)');
    const out = suite(bad);
    const ex = out.results.find((r) => r.title === 'A Pro customer gets 10% off')!;
    expect(ex.status).toBe('fail');
    expect(ex.message).toContain('the total is $18.00');
    expect(ex.message).toContain('total=1780');
  });

  it('an unknown sentence is a compile error with nearest phrases', () => {
    const f = FEATURE.replace('Then the invoice is stored once', 'Then the invoice gets saved one time');
    const out = suite(APP, f);
    const ex = out.results.find((r) => r.title.startsWith('Issuing'))!;
    expect(ex.status).toBe('error');
    expect(ex.message).toContain('Nearest');
    expect(ex.message).toContain('the invoice is stored once');
  });

  it('rejects invalid values via the validator, at scenario compile time', () => {
    const f = FEATURE.replace('"a@x.com"', '"not an email"');
    const out = suite(APP, f);
    expect(out.results.some((r) => r.status === 'error' && /not a valid Email/.test(r.message ?? ''))).toBe(true);
  });

  it('a non-exhaustive decision table fails', () => {
    const f = FEATURE.replace('    | Enterprise | 20%      |\n', '');
    const out = suite(APP, f);
    const r = out.results.find((x) => x.kind === 'rule')!;
    expect(r.status).toBe('fail');
    expect(r.message).toContain('missing Enterprise');
  });

  it('detects a property violation with a counterexample', () => {
    // A bug: discounts above 100% would make price negative; here Enterprise "20" becomes a surcharge via sub.
    const bad = APP.replace('(div-floor (mul (gross ls) (sub 100 (discount p))) 100)', '(div-floor (mul (gross ls) (add 100 (discount p))) 100)');
    const out = suite(bad);
    const a = out.results.find((x) => x.kind === 'always')!;
    expect(a.status).toBe('fail');
  });

  it('detects a privacy violation dynamically (without the static result): behaviour depends on the name', () => {
    const leaky = APP.replace('(emit audit (Issued inv.id))', '(emit audit (Issued (if (= c.name "") 1 2)))');
    const prog = parseProgram(leaky);
    const out = runSuite(prog, parseFeature(FEATURE), parseGlossary(GLOSSARY, prog), undefined, { propCases: 50, privacyCases: 300, contracts: true });
    const p = out.results.find((x) => x.kind === 'privacy')!;
    expect(p.status).toBe('fail');
    expect(p.message).toMatch(/changed observable behaviour outside \{net:mail\}/);
    expect(p.message).toContain('audit.emit');
  });

  it('detects the same leak statically with the flow matrix, before anything runs', () => {
    const leaky = APP.replace('(emit audit (Issued inv.id))', '(emit audit (Issued (if (= c.name "") 1 2)))');
    const prog = parseProgram(leaky);
    const chk = check(prog, parsePolicy(POLICY));
    const out = runSuite(prog, parseFeature(FEATURE), parseGlossary(GLOSSARY, prog), chk);
    const p = out.results.find((x) => x.kind === 'privacy')!;
    expect(p.status).toBe('fail');
    expect(p.message).toMatch(/static: Customer\.name reaches audit/);
  });

  it('is precise: the length of a one-element list of names is not a leak', () => {
    const fine = APP.replace('(emit audit (Issued inv.id))', '(emit audit (Issued (len (list c.name))))');
    const prog = parseProgram(fine);
    const chk = check(prog, parsePolicy(POLICY));
    const out = runSuite(prog, parseFeature(FEATURE), parseGlossary(GLOSSARY, prog), chk);
    expect(out.results.find((x) => x.kind === 'privacy')!.status).toBe('pass');
  });
});
