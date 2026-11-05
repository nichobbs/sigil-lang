// Mutation-based adequacy: does the human-reviewable spec actually constrain the implementation?
// A mutant that no check kills is a spec gap, reported back to the human as a concrete question.

import { Expr, FnDef, Program, mapChildren, resolveType } from './ast.js';
import { check, errors } from './check.js';
import { Feature, Glossary, SuiteOptions, runSuite } from './scenario.js';
import { printExpr } from './print/sexp.js';
import { Policy } from './ast.js';

export interface Mutant {
  id: number;
  fn: string;
  desc: string;
  prog: Program;
}

const SWAP: Record<string, string> = {
  add: 'sub',
  sub: 'add',
  mul: 'add',
  '<=': '<',
  '<': '<=',
  '>=': '>',
  '>': '>=',
  and: 'or',
  or: 'and',
  min: 'max',
  max: 'min',
  'div-floor': 'mul',
  mod: 'div-floor',
  any: 'all',
  all: 'any',
};

function children(e: Expr): Expr[] {
  const out: Expr[] = [];
  mapChildren(e, (c) => (out.push(c), c));
  return out;
}
function withChild(e: Expr, k: number, n: Expr): Expr {
  let i = 0;
  return mapChildren(e, (c) => (i++ === k ? n : c));
}

function mutations(e: Expr, errCases: string[]): { desc: string; expr: Expr }[] {
  const out: { desc: string; expr: Expr }[] = [];
  switch (e.k) {
    case 'int':
      out.push({ desc: `${e.v} -> ${e.v + 1n}`, expr: { ...e, v: e.v + 1n } });
      if (e.v > 0n) out.push({ desc: `${e.v} -> ${e.v - 1n}`, expr: { ...e, v: e.v - 1n } });
      break;
    case 'str':
      if (e.v.length > 0) out.push({ desc: `${JSON.stringify(e.v)} -> ${JSON.stringify(e.v + 'x')}`, expr: { ...e, v: e.v + 'x' } });
      break;
    case 'call':
      if (e.fn in SWAP) out.push({ desc: `${e.fn} -> ${SWAP[e.fn]}`, expr: { ...e, fn: SWAP[e.fn] } });
      break;
    case 'if':
      out.push({ desc: 'swap if branches', expr: { ...e, then: e.else, else: e.then } });
      break;
    case 'match':
      if (e.arms.length >= 2) {
        const arms = e.arms.map((a) => ({ ...a }));
        arms[0] = { ...arms[0], body: e.arms[1].body };
        arms[1] = { ...arms[1], body: e.arms[0].body };
        out.push({ desc: `swap results of ${e.arms[0].tag} and ${e.arms[1].tag}`, expr: { ...e, arms } });
      }
      break;
    case 'try': {
      const other = errCases.find((c) => c !== e.onErr);
      if (other) out.push({ desc: `:on-err ${e.onErr} -> ${other}`, expr: { ...e, onErr: other } });
      break;
    }
    case 'let':
    case 'do':
      for (let i = 0; i < e.body.length - 1; i++) {
        out.push({ desc: `delete statement ${printExpr(e.body[i]).slice(0, 48)}`, expr: { ...e, body: e.body.filter((_, j) => j !== i) } });
      }
      break;
    default:
      break;
  }
  children(e).forEach((c, k) => {
    for (const m of mutations(c, errCases)) out.push({ desc: m.desc, expr: withChild(e, k, m.expr) });
  });
  return out;
}

export function enumerateMutants(prog: Program): Mutant[] {
  const out: Mutant[] = [];
  let id = 0;
  for (const f of prog.fns.values()) {
    const rt = resolveType(prog, f.out);
    const errCases = rt.k === 'result' && resolveType(prog, rt.err).k === 'enum' ? (resolveType(prog, rt.err) as { cases: string[] }).cases : [];
    for (const m of mutations(f.body, errCases)) {
      const fns = new Map(prog.fns);
      fns.set(f.name, { ...f, body: m.expr } as FnDef);
      out.push({ id: ++id, fn: f.name, desc: m.desc, prog: { ...prog, fns } });
    }
  }
  return out;
}

export interface MutationReport {
  total: number;
  killedByChecker: number;
  killedByScenarios: number;
  killedByContractsOnly: number;
  survivors: { id: number; fn: string; desc: string }[];
}

export function runMutation(
  prog: Program,
  pol: Policy,
  feature: Feature,
  glossaryFor: (p: Program) => Glossary,
  opts: Pick<SuiteOptions, 'propCases' | 'privacyCases'> = { propCases: 150, privacyCases: 40 },
): MutationReport {
  const ms = enumerateMutants(prog);
  const rep: MutationReport = { total: ms.length, killedByChecker: 0, killedByScenarios: 0, killedByContractsOnly: 0, survivors: [] };
  const failing = (rs: { status: string }[]) => rs.some((r) => r.status !== 'pass');
  for (const m of ms) {
    try {
      const chk = check(m.prog, pol);
      if (errors(chk).length) {
        rep.killedByChecker++;
        continue;
      }
      const g = glossaryFor(m.prog);
      const noContracts = runSuite(m.prog, feature, g, chk, { ...opts, contracts: false });
      if (failing(noContracts.results)) {
        rep.killedByScenarios++;
        continue;
      }
      const withContracts = runSuite(m.prog, feature, g, chk, { ...opts, contracts: true });
      if (failing(withContracts.results)) {
        rep.killedByContractsOnly++;
        continue;
      }
      rep.survivors.push({ id: m.id, fn: m.fn, desc: m.desc });
    } catch {
      rep.killedByScenarios++; // crashes count as detected
    }
  }
  return rep;
}
