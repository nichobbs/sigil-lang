#!/usr/bin/env tsx
// sigil check   <dir>   static checks: ranges, capabilities, information flow
// sigil verify  <dir>   check + scenarios + properties + privacy + mutation adequacy
// sigil compare <dir>   token-cost comparison of alternative surface syntaxes

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { compileProgram } from './wasm/compile.js';
import { join } from 'node:path';
import { CheckResult, check, errors } from './check.js';
import { runMutation } from './mutate.js';
import { parsePolicy, parseProgram } from './parse.js';
import { DEFAULT_SUITE, parseFeature, parseGlossary, runSuite } from './scenario.js';
import { SigilError } from './sexpr.js';
import { showInterval } from './interval.js';
import { Program } from './ast.js';
import { proveEnsures, SmtResult } from './smt.js';
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

function printCheck(res: CheckResult, ensuresTested?: Map<string, number>, smt: SmtResult[] = []) {
  hr('Range and capability evidence (interval analysis)');
  for (const ev of res.evidence.values()) {
    const smtFor = (o: (typeof ev.obligations)[number]) => {
      if (o.kind !== 'ensures') return undefined;
      return smt.find((r) => r.fn === ev.fn && r.index === ev.obligations.filter((x) => x.kind === 'ensures').indexOf(o));
    };
    const bySmt = ev.obligations.filter((o) => o.status !== 'proved' && smtFor(o)?.status === 'proved');
    const proved = ev.obligations.filter((o) => o.status === 'proved').length + bySmt.length;
    const open = ev.obligations.filter((o) => o.status !== 'proved' && !bySmt.includes(o));
    const mag = ev.maxAbs === null ? '-' : ev.maxAbs.toString();
    console.log(`${pad(ev.fn, 16)} repr=${pad(ev.repr, 6)} max|x|=${pad(mag, 18)} ${proved} proved${open.length ? `, ${open.length} open` : ''}`);
    for (const o of bySmt) console.log(`    PROVED (SMT)  ${o.desc}   [${smtFor(o)!.note}]`);
    for (const o of open) {
      let note = o.note ?? '';
      if (o.kind === 'ensures' && ensuresTested) {
        const idx = ev.obligations.filter((x) => x.kind === 'ensures').indexOf(o);
        const n = ensuresTested.get(`${ev.fn}#${idx}`);
        note = n ? `${note}; held in ${n} runtime checks` : note;
      }
      const sr = smtFor(o);
      if (sr && sr.status !== 'proved') note = `${note}; ${sr.note}`;
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

async function openEnsures(prog: Program, res: CheckResult): Promise<SmtResult[]> {
  const open = new Set<string>();
  for (const ev of res.evidence.values()) {
    ev.obligations.filter((o) => o.kind === 'ensures').forEach((o, i) => o.status !== 'proved' && open.add(`${ev.fn}#${i}`));
  }
  if (!open.size) return [];
  return proveEnsures(prog, (fn, i) => open.has(`${fn}#${i}`));
}

async function main() {
  const [cmd, dir = 'examples/invoicing', outFile] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'check': {
        const { prog, pol } = load(dir);
        const res = check(prog, pol);
        printCheck(res, undefined, await openEnsures(prog, res));
        process.exit(errors(res).length ? 1 : 0);
        break;
      }
      case 'verify': {
        const { prog, pol, glossarySrc, feature } = load(dir);
        if (!feature) throw new SigilError('no .feature file found');
        const res = check(prog, pol);
        const g = parseGlossary(glossarySrc, prog);
        const suite = runSuite(prog, feature, g, res, DEFAULT_SUITE);
        printCheck(res, suite.ensuresStats, await openEnsures(prog, res));

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
        for (const s of m.survivors) {
          // An :on-err mutant is the Unresolved question (keep or roll back?) while one is open: a human must answer, not the spec writer.
          const open = feature.unresolved.length > 0 && s.desc.startsWith(':on-err');
          console.log(`    - ${s.fn}: ${s.desc}${open ? '   [OPEN QUESTION: see Unresolved above; stays a survivor until a human answers]' : ''}`);
        }

        process.exit(bad || errors(res).length ? 1 : 0);
        break;
      }
      case 'compare': {
        const { prog, pol } = load(dir);
        console.log(formatComparison(compareSyntaxes(prog)));
        console.log(formatFragility(fragilityExperiment(prog, pol)));
        break;
      }
      case 'wasm': {
        const { prog, pol } = load(dir);
        const res = check(prog, pol);
        const out = compileProgram(prog, res);
        hr('Wasm backend (pure numeric core)');
        for (const f of out.fns) {
          if (f.compilable) console.log(`COMPILED      ${pad(f.name, 16)} ${f.repr}${f.hasBase ? `  [memory: ${f.inputBytes}B input + ${f.scratchBytes}B scratch]` : ''}${f.widenedFromChecker ? `  (${f.widenedFromChecker})` : ''}`);
          else console.log(`NOT COMPILABLE ${pad(f.name, 15)} ${f.reason}`);
        }
        if (outFile) {
          writeFileSync(outFile, out.bytes);
          console.log(`\nwrote ${out.bytes.length} bytes to ${outFile}`);
        }
        break;
      }
      default:
        console.log('usage: sigil <check|verify|compare|wasm> <example-dir> [out.wasm]');
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
main().then(() => process.exit(process.exitCode ?? 0));
