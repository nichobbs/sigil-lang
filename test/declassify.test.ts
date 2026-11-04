import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, errors } from '../src/check.js';
import { SYNTAXES, compareSyntaxes, fragilityExperiment } from '../src/compare.js';
import { Host, Interp } from '../src/interp.js';
import { enumerateMutants, runMutation } from '../src/mutate.js';
import { parsePolicy, parseProgram } from '../src/parse.js';
import { printProgram } from '../src/print/sexp.js';
import { parseFeature, parseGlossary, runSuite } from '../src/scenario.js';
import { SigilError } from '../src/sexpr.js';

const read = (p: string) => readFileSync(new URL(`../examples/declassify/${p}`, import.meta.url), 'utf8');
const APP = read('app.sigil');
const POLICY = read('policy.sigil');
const FEATURE = read('screening.feature');
const GLOSSARY = read('glossary.sigil');

const run = (app = APP, policy = POLICY) => check(parseProgram(app), parsePolicy(policy));
const errs = (app = APP, policy = POLICY) => errors(run(app, policy));

const WITH_SECRET = APP.replace('(salary Salary :pii))', '(salary Salary :pii) (key (Int 0 9) :secret))');
const RELEASE = '(declassify salary-band (div-floor a.salary 10000))';

describe('declassifiers: acceptance and rejection', () => {
  it('the example is accepted with the declared declassifier', () => {
    expect(errs()).toEqual([]);
  });

  it('the leak is still rejected without declassify (pii into an internal field)', () => {
    const bad = APP.replace(RELEASE, '(div-floor a.salary 10000)');
    const d = errs(bad).find((x) => x.code === 'E-flow');
    expect(d).toBeTruthy();
    expect(d!.paths![0].src).toBe('Applicant.salary');
  });

  it('an undeclared declassifier name is E-policy: code cannot invent one', () => {
    const bad = APP.replace('declassify salary-band (div', 'declassify made-up (div');
    expect(errs(bad).some((d) => d.code === 'E-policy' && d.msg.includes('made-up'))).toBe(true);
    // the release did not happen, so the leak is also reported
    expect(errs(bad).some((d) => d.code === 'E-flow')).toBe(true);
  });

  it('a (declassifies ...) entry the policy does not declare is E-policy', () => {
    const bad = APP.replace('(declassifies salary-band)', '(declassifies salary-band ghost)');
    expect(errs(bad).some((d) => d.code === 'E-policy' && d.msg.includes('ghost'))).toBe(true);
  });

  it('a use that is not declared in the function (needs-style) is E-declassify; an unused declaration warns', () => {
    const undeclared = APP.replace('  (declassifies salary-band)\n', '');
    expect(errs(undeclared).some((d) => d.code === 'E-declassify')).toBe(true);
    const unused = APP.replace(RELEASE, '(div-floor 5 10000)');
    expect(run(unused).diags.some((d) => d.code === 'W-declassify')).toBe(true);
  });

  it('data above `from` is rejected: a pii declassifier cannot launder secret', () => {
    const bad = WITH_SECRET.replace(RELEASE, '(declassify salary-band (add (div-floor a.salary 10000) a.key))');
    const d = errs(bad, POLICY).find((x) => x.code === 'E-flow' && x.msg.includes('declassifier salary-band'));
    expect(d).toBeTruthy();
    expect(d!.msg).toContain('secret');
    expect(d!.paths!.some((p) => p.src === 'Applicant.key')).toBe(true);
  });

  it('the (fields ...) restriction rejects other sources, and (fns ...) rejects other functions', () => {
    const other = WITH_SECRET.replace(RELEASE, '(declassify salary-band (add (div-floor a.salary 10000) a.key))');
    const widened = POLICY.replace('(from pii)', '(from secret)');
    expect(errs(other, widened).some((d) => d.code === 'E-policy' && d.msg.includes('restricted to Applicant.salary'))).toBe(true);
    const twin = APP + `\n(fn screen2 (in (a Applicant)) (out Unit) (needs audit) (declassifies salary-band)\n  (emit audit (Screened a.id ${RELEASE})))`;
    expect(errs(twin).some((d) => d.code === 'E-policy' && d.msg.includes('may only be used in screen'))).toBe(true);
  });

  it('integrity labels are untouched: an untrusted value stays untrusted through declassify', () => {
    const src = `
(type R (rec (secret Str :pii)))
(type Out (rec (to Str :control)))
(fn f (in (r R)) (out Out) (declassifies d) (Out (declassify d r.secret)))`;
    const pol = `(policy (declassify d (from pii) (to internal) (reason "test")))`;
    const e = errs(src, pol);
    expect(e.some((d) => d.code === 'E-integrity')).toBe(true);
  });

  it('the implicit-flow (pc) label is not lowered by declassify', () => {
    // branching on a secret and declassifying inside the branch: the emit still carries the secret branch label
    const bad = WITH_SECRET.replace(
      `(emit audit (Screened a.id ${RELEASE}))`,
      `(if (= a.key 1) (emit audit (Screened a.id ${RELEASE})) (emit audit (Screened a.id 0)))`,
    );
    const e = errs(bad).filter((d) => d.code === 'E-flow');
    expect(e.some((d) => d.msg.includes('secret data reaches audit'))).toBe(true);
    // ...and a declassified value selected by a secret branch is itself secret afterwards
    const bad2 = WITH_SECRET.replace(RELEASE, `(if (= a.key 1) ${RELEASE} 0)`);
    expect(errs(bad2).some((d) => d.code === 'E-flow' && d.msg.includes('Screened.band'))).toBe(true);
  });

  it('rejects malformed declassifier declarations in the policy', () => {
    const p = (body: string) => () => parsePolicy(`(policy ${body})`);
    expect(p('(declassify d (from internal) (to pii) (reason "x"))')).toThrow(/strictly lower/);
    expect(p('(declassify d (from pii) (to internal))')).toThrow(/reason/);
    expect(p('(declassify d (from pii) (to internal) (reason ""))')).toThrow(SigilError);
    expect(p('(declassify d (from pii) (to bogus) (reason "x"))')).toThrow(/confidentiality/);
    expect(p('(declassify d (from pii) (to internal) (reason "x")) (declassify d (from pii) (to public) (reason "y"))')).toThrow(/duplicate/);
  });
});

describe('declassifiers: visibility', () => {
  const r = run();

  it('the manifest lists the declassifier and its policy reason', () => {
    const m = r.manifest.find((x) => x.fn === 'screen')!;
    expect(m.needs).toEqual(['audit']);
    expect(m.declassifies).toEqual([{ name: 'salary-band', reason: expect.stringContaining('10,000-wide band') }]);
  });

  it('the flow matrix says the flow passes via the declassifier, with the reason', () => {
    const f = r.flows.find((x) => x.src === 'Applicant.salary' && x.sink === 'audit')!;
    expect(f.ok).toBe(true);
    expect(f.via).toEqual([{ name: 'salary-band', reason: expect.stringContaining('band') }]);
    expect(f.path.join(' ')).toContain('declassify salary-band (pii -> internal)');
  });

  it('provenance paths in later counterexamples include the declassify step', () => {
    // released to internal, then the sink is tightened to public: the counterexample still shows the release step
    const e = errors(run(APP, POLICY.replace('(accepts internal)', '(accepts public)')));
    const d = e.find((x) => x.code === 'E-flow' && x.msg.includes('reaches audit'))!;
    expect(d.paths![0].src).toBe('Applicant.salary');
    expect(d.paths![0].path.join(' -> ')).toContain('declassify salary-band');
  });

  it('a direct flow to the same sink is not hidden by a declassified one', () => {
    const both = APP.replace(
      `(emit audit (Screened a.id ${RELEASE}))`,
      `(do (emit audit (Screened a.id ${RELEASE})) (emit audit (Screened a.id (div-floor a.salary 10000))))`,
    );
    // the direct emit is an E-flow error, and the matrix edge for the pair is the violation, not the "via" one
    const res = run(both);
    expect(errors(res).some((d) => d.code === 'E-flow')).toBe(true);
    const f = res.flows.find((x) => x.src === 'Applicant.salary' && x.sink === 'audit')!;
    expect(f.ok).toBe(false);
    expect(f.via).toBeUndefined();
  });
});

describe('declassifiers: syntax, runtime, tooling', () => {
  const prog = parseProgram(APP);

  it('round-trips through the canonical printer, including (declassifies ...)', () => {
    const text = printProgram(prog);
    expect(text).toContain('(declassifies salary-band)');
    expect(text).toContain(RELEASE);
    const p2 = parseProgram(text);
    expect([...p2.fns.values()]).toEqual([...prog.fns.values()]);
    expect(printProgram(p2)).toBe(text);
  });

  it('parses the policy declaration', () => {
    const d = parsePolicy(POLICY).declassifiers.get('salary-band')!;
    expect(d).toMatchObject({ from: 'pii', to: 'internal', fields: ['Applicant.salary'], fns: ['screen'] });
  });

  it('rejects a malformed use and a function named declassify', () => {
    expect(() => parseProgram('(fn f (in) (out Unit) (declassify 1 2))')).toThrow(/declassify name expr/);
    expect(() => parseProgram('(fn declassify (in) (out Unit) 1)')).toThrow(/reserved/);
  });

  it('is the identity at runtime', () => {
    const host = new Host(1);
    const it = new Interp(prog, host);
    it.callFn('screen', [{ $: 'rec', type: 'Applicant', fields: { id: 5n, salary: 123456n } }] as never);
    const emitted = JSON.stringify(host.log.map((o) => o.args), (_, v) => (typeof v === 'bigint' ? Number(v) : v));
    expect(emitted).toContain('12'); // 123456 div 10000
  });

  it('mutation enumeration does not crash and checking every mutant is safe', () => {
    const ms = enumerateMutants(prog);
    expect(ms.length).toBeGreaterThan(0);
    for (const m of ms) expect(() => check(m.prog, parsePolicy(POLICY))).not.toThrow();
    const rep = runMutation(prog, parsePolicy(POLICY), parseFeature(FEATURE), (p) => parseGlossary(GLOSSARY, p));
    expect(rep.total).toBe(ms.length);
  });

  it('every surface syntax prints it, and the comparison tooling does not crash', () => {
    for (const s of SYNTAXES) {
      const secs = s.sections(prog);
      expect(secs.fns).toContain('salary-band');
    }
    expect(compareSyntaxes(prog).length).toBe(SYNTAXES.length);
    expect(() => fragilityExperiment(prog, parsePolicy(POLICY))).not.toThrow();
  });
});

describe('declassifiers and Privacy scenarios', () => {
  const opts = { propCases: 20, privacyCases: 60, contracts: true };
  const suite = (glossary: string, withCheck = true) => {
    const p = parseProgram(APP);
    const chk = check(p, parsePolicy(POLICY));
    return runSuite(p, parseFeature(FEATURE), parseGlossary(glossary, p), withCheck ? chk : undefined, opts).results.find((r) => r.kind === 'privacy')!;
  };

  it('without human acceptance in the glossary the declassified flow violates the rule, with a hint', () => {
    const r = suite(GLOSSARY.replace('(declassified salary-band)', ''));
    expect(r.status).toBe('fail');
    expect(r.message).toContain('via declassify salary-band');
    expect(r.message).toContain('(declassified salary-band)');
  });

  it('with acceptance it passes, but reports that a declassifier was involved (not strict noninterference)', () => {
    const r = suite(GLOSSARY);
    expect(r.status).toBe('pass');
    expect(r.declassifiers).toEqual(['salary-band']);
    expect(r.note).toContain('PASS MODULO DECLASSIFIER salary-band');
    expect(r.note).toContain('does NOT hold');
    expect(r.note).not.toContain('vacuous');
  });

  it('the exemption comes only from the static matrix: with no checker result the strict two-run check fails', () => {
    const r = suite(GLOSSARY, false);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/changed observable behaviour outside/);
  });
});
