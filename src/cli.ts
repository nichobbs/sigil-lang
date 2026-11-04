#!/usr/bin/env tsx
// sigil check   <dir>   static checks: ranges, capabilities, information flow
// sigil verify  <dir>   check + scenarios + properties + privacy + mutation adequacy
// sigil compare <dir>   token-cost comparison of alternative surface syntaxes

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CheckResult, check, errors } from './check.js';
import { runMutation } from './mutate.js';
import { parsePolicy, parseProgram } from './parse.js';
import { DEFAULT_SUITE, parseFeature, parseGlossary, runSuite } from './scenario.js';
import { SigilError } from './sexpr.js';
import { showInterval } from './interval.js';
import { compareSyntaxes, fragilityExperiment, formatComparison, formatFragility } from './compare.js';

function load(dir: string) {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  const files = readdirSync(dir);
  const featureFile = files.find((f) => f.endsWith('.feature'));
  const prog = parseProgram(read('app.sigil'));
  const pol = parsePolicy(read('policy.sigil'));
  return {
    prog,
    pol,
    glossarySrc: read('glossary.sigil'),
    feature: featureFile ? parseFeature(read(featureFile)) : undefined,
  };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const hr = (title: string) => console.log(`\n== ${title} ${'='.repeat(Math.max(2, 70 - title.length))}`);

function printCheck(res: CheckResult, ensuresTested?: Map<string, number>) {
  hr('Range and capability evidence (interval analysis)');
  for (const ev of res.evidence.values()) {
    const proved = ev.obligations.filter((o) => o.status === 'proved').length;
    const open = ev.obligations.filter((o) => o.status !== 'proved');
    const mag = ev.maxAbs === null ? '-' : ev.maxAbs.toString();
    console.log(`${pad(ev.fn, 16)} repr=${pad(ev.repr, 6)} max|x|=${pad(mag, 18)} ${proved} proved${open.length ? `, ${open.length} open` : ''}`);
    for (const o of open) {
      let note = o.note ?? '';
      if (o.kind === 'ensures' && ensuresTested) {
        const idx = ev.obligations.filter((x) => x.kind === 'ensures').indexOf(o);
        const n = ensuresTested.get(`${ev.fn}#${idx}`);
        note = n ? `${note}; held in ${n} runtime checks` : note;
      }
      console.log(`    ${o.status.toUpperCase()}  ${o.desc}${note ? `   [${note}]` : ''}`);
    }
  }

  hr('Capability manifest');
  for (const m of res.manifest) console.log(`${pad(m.fn, 16)} needs ${m.needs.join(', ')}`);

  hr('Flow matrix (labelled source -> sinks reached)');
  const srcs = [...new Set(res.flows.map((f) => f.src))].sort();
  if (!srcs.length) console.log('(no labelled data reaches any sink)');
  for (const s of srcs) {
    const fs = res.flows.filter((f) => f.src === s);
    console.log(`${pad(s, 18)} ${fs.map((f) => `${f.sink}${f.ok ? '' : ' (REJECTED)'}`).join(', ')}`);
  }

  hr('Diagnostics');
  if (!res.diags.length) console.log('none');
  for (const d of res.diags) {
    console.log(`${d.level.toUpperCase()} ${d.code} [${d.fn}] ${d.msg}`);
    for (const p of d.paths ?? []) console.log(`    ${p.src}: ${p.path.join(' -> ')}`);
  }
}

function main() {
  const [cmd, dir = 'examples/invoicing'] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'check': {
        const { prog, pol } = load(dir);
        const res = check(prog, pol);
        printCheck(res);
        process.exit(errors(res).length ? 1 : 0);
        break;
      }
      case 'verify': {
        const { prog, pol, glossarySrc, feature } = load(dir);
        if (!feature) throw new SigilError('no .feature file found');
        const res = check(prog, pol);
        const g = parseGlossary(glossarySrc, prog);
        const suite = runSuite(prog, feature, g, res, DEFAULT_SUITE);
        printCheck(res, suite.ensuresStats);

        hr('Scenarios, rules, properties, privacy');
        let bad = 0;
        for (const r of suite.results) {
          if (r.status !== 'pass') bad++;
          const cases = r.cases && r.kind !== 'example' ? ` (${r.cases} cases)` : '';
          console.log(`${r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'ERR '} ${pad(r.kind, 8)} ${r.title}${cases}`);
          if (r.message) console.log(`       ${r.message}`);
          if (r.note) console.log(`       ${r.note}`);
        }

        hr('Open questions for a human (Unresolved)');
        if (!suite.unresolved.length) console.log('none');
        for (const u of suite.unresolved) console.log(`? ${u.text}`);

        hr('Mutation adequacy (does the spec constrain the implementation?)');
        const m = runMutation(prog, pol, feature, (p) => parseGlossary(glossarySrc, p));
        const killed = m.killedByChecker + m.killedByScenarios + m.killedByContractsOnly;
        console.log(`mutants: ${m.total}   killed: ${killed} (${((100 * killed) / m.total).toFixed(0)}%)`);
        console.log(`  by static checker:      ${m.killedByChecker}`);
        console.log(`  by scenarios/props:     ${m.killedByScenarios}`);
        console.log(`  by runtime contracts:   ${m.killedByContractsOnly}  (ranges/ensures only; no scenario asserts it)`);
        console.log(`  SURVIVED:               ${m.survivors.length}`);
        for (const s of m.survivors) console.log(`    - ${s.fn}: ${s.desc}`);

        process.exit(bad || errors(res).length ? 1 : 0);
        break;
      }
      case 'compare': {
        const { prog, pol } = load(dir);
        console.log(formatComparison(compareSyntaxes(prog)));
        console.log(formatFragility(fragilityExperiment(prog, pol)));
        break;
      }
      default:
        console.log('usage: sigil <check|verify|compare> <example-dir>');
        process.exit(2);
    }
  } catch (e) {
    if (e instanceof SigilError) {
      console.error(`error: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

void showInterval;
main();
