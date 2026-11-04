#!/usr/bin/env tsx
// sigil check   <dir>   static checks: ranges, capabilities, information flow
// sigil verify  <dir> [--fast]  check + scenarios + properties + privacy + mutation adequacy (--fast skips mutation)
// sigil fix     <dir>   mechanical edits for open findings (clamps, take, max 1, needs); suggestions only, never writes
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
  // Optional proposed-policy.sigil: declassifiers an agent proposes. They are applied for checking but stay pending a human.
  const proposed: string[] = [];
  if (files.includes('proposed-policy.sigil')) {
    const prop = parsePolicy(read('proposed-policy.sigil'));
    if (prop.allow.length || prop.sinks.size) throw new SigilError('proposed-policy.sigil may contain only (declassify ...) entries; allow and sink rules are human-owned');
    for (const [name, d] of prop.declassifiers) {
      if (pol.declassifiers.has(name)) throw new SigilError(`proposed-policy.sigil: declassifier ${name} already exists in policy.sigil`);
      pol.declassifiers.set(name, d);
      proposed.push(name);
    }
  }
  return {
    prog,
    pol,
    proposed,
    glossarySrc: read('glossary.sigil'),
    feature: featureFile ? parseFeature(read(featureFile)) : undefined,
  };
}

function printPending(res: CheckResult, proposed: string[], pol: ReturnType<typeof parsePolicy>): boolean {
  const used = proposed.filter((n) => res.manifest.some((m) => m.declassifies.some((d) => d.name === n)));
  if (!used.length) return false;
  hr('PENDING HUMAN APPROVAL (proposed-policy.sigil)');
  for (const n of used) {
    const d = pol.declassifiers.get(n)!;
    const fns = res.manifest.filter((m) => m.declassifies.some((x) => x.name === n)).map((m) => m.fn);
    console.log(`declassifier ${n}: releases ${d.from} -> ${d.to} in ${fns.join(', ')}${d.fields ? ` (fields ${d.fields.join(', ')})` : ''}`);
    console.log(`    reason: ${d.reason}`);
  }
  console.log('A human must accept or reject these releases. Until then the program is complete but not approved.');
  return true;
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
  for (const m of res.manifest) {
    const parts = [m.needs.length ? `needs ${m.needs.join(', ')}` : '', m.declassifies.length ? `declassifies ${m.declassifies.map((d) => `${d.name} ("${d.reason}")`).join(', ')}` : ''];
    console.log(`${pad(m.fn, 16)} ${parts.filter(Boolean).join('; ')}`);
  }

  hr('Flow matrix (labelled source -> sinks reached)');
  const srcs = [...new Set(res.flows.map((f) => f.src))].sort();
  if (!srcs.length) console.log('(no labelled data reaches any sink)');
  for (const s of srcs) {
    const fs = res.flows.filter((f) => f.src === s);
    console.log(`${pad(s, 18)} ${fs.map((f) => `${f.sink}${f.via ? ` (via declassify ${f.via.map((v) => `${v.name}: "${v.reason}"`).join(', ')})` : ''}${f.ok ? '' : ' (REJECTED)'}`).join(', ')}`);
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
  const argv = process.argv.slice(2);
  const fast = argv.includes('--fast'); // verify --fast: check + scenarios, no mutation testing
  const [cmd, dir = 'examples/invoicing', outFile] = argv.filter((a) => a !== '--fast');
  try {
    switch (cmd) {
      case 'check': {
        const { prog, pol, proposed } = load(dir);
        const res = check(prog, pol);
        printCheck(res, undefined, await openEnsures(prog, res));
        printPending(res, proposed, pol);
        process.exit(errors(res).length ? 1 : 0);
        break;
      }
      case 'verify': {
        const { prog, pol, glossarySrc, feature, proposed } = load(dir);
        if (!feature) throw new SigilError('no .feature file found');
        const res = check(prog, pol);
        const g = parseGlossary(glossarySrc, prog);
        const suite = runSuite(prog, feature, g, res, DEFAULT_SUITE);
        printCheck(res, suite.ensuresStats, await openEnsures(prog, res));
        const pending = printPending(res, proposed, pol);

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

        if (fast) {
          console.log('\n(--fast: mutation testing skipped; run verify without --fast before you finish)');
          if (pending && !bad && !errors(res).length) console.log('RESULT: CLEAN, PENDING HUMAN APPROVAL (this is a finished state for an agent)');
          process.exit(bad || errors(res).length ? 1 : 0);
        }
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

        if (pending && !bad && !errors(res).length) console.log('RESULT: CLEAN, PENDING HUMAN APPROVAL');
        process.exit(bad || errors(res).length ? 1 : 0);
        break;
      }
      case 'fix': {
        const { prog, pol } = load(dir);
        const res = check(prog, pol);
        const seen = new Set<string>();
        let n = 0;
        const out = (line: string) => {
          if (seen.has(line)) return;
          seen.add(line);
          n++;
          console.log(line);
        };
        console.log('Apply the first suggestion for a function, then rerun: later ones often disappear.\n');
        for (const ev of res.evidence.values()) {
          for (const o of ev.obligations) {
            if (o.status === 'proved' || !o.fix) continue;
            out(`[${ev.fn}] ${o.status.toUpperCase()} ${o.desc}${o.note ? ` (${o.note})` : ''}\n    replace: ${o.fix.old}\n    with:    ${o.fix.new}\n    note:    ${o.fix.why}`);
          }
        }
        // Capability findings: the fix is a name to add to `needs`.
        const needsFor = new Map<string, Set<string>>();
        for (const d of res.diags) {
          const m = /^(\S+) (?:uses|calls \S+, which needs) (\S+)(?: but| ,)? ?(?:but )?does not declare it in needs/.exec(d.msg);
          if (d.code === 'E-cap' && m) (needsFor.get(m[1]) ?? needsFor.set(m[1], new Set()).get(m[1])!).add(m[2]);
        }
        for (const [fn, hs] of needsFor) out(`[${fn}] E-cap\n    add to its needs clause: ${[...hs].join(' ')}`);
        const manual = res.diags.filter((d) => d.level === 'error' && !(d.code === 'E-cap' && /does not declare it in needs/.test(d.msg)));
        if (manual.length) {
          console.log(`\n${manual.length} error(s) with no mechanical fix (they need a decision):`);
          for (const d of manual) console.log(`  ${d.code} [${d.fn}] ${d.msg.split('\n')[0].slice(0, 160)}`);
        }
        if (!n && !manual.length) console.log('nothing to fix');
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
        console.log('usage: sigil <check|verify|fix|compare|wasm> <example-dir> [out.wasm]');
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
