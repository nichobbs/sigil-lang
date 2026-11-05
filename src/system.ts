// system.sigil: processes, channels and the static composition check (docs/EXPERIMENT.md, Extension 4, C0).
//
//   (system NAME
//     (approved "PROGRAM-HASH" "SPEC-HASH")              ; human-owned approval ledger entries
//     (declassifier D (from pii) (to internal) (hosted-in vault))
//     (process vault (program "P") (spec "S") (reads pii) (in public) (sink db internal))
//     (channel vault report (carries internal) (via D)))
//
// A process holds the join of what it reads and what its inbound channels carry (no per-output tracking: conservative).
// A process's `in` is the highest label it accepts on any inbound channel (default public); a `sink` clearance is the
// highest label its audience may see (default: none declared). Declassifiers are the only edges that lower a label.

import { readFileSync } from 'node:fs';
import { CONFS, Conf } from './ast.js';
import { isList, isSym, readAll, SExp, SigilError } from './sexpr.js';

export interface SysProcess { name: string; program: string; spec: string; reads: Conf; ceiling: Conf; sinks: { name: string; clearance: Conf }[] }
export interface SysChannel { from: string; to: string; carries: Conf; via?: string }
export interface SysDeclassifier { name: string; from: Conf; to: Conf; hostedIn: string }
export interface System { name: string; approved: [string, string][]; declassifiers: SysDeclassifier[]; processes: SysProcess[]; channels: SysChannel[] }
export interface SysDiag { code: string; msg: string }

const rank = (c: Conf) => CONFS.indexOf(c);
const max = (a: Conf, b: Conf) => (rank(a) >= rank(b) ? a : b);

function sym(s: SExp | undefined, what: string): string {
  if (!isSym(s)) throw new SigilError(`${what}: expected a name`, s?.pos);
  return s.v;
}
function str(s: SExp | undefined, what: string): string {
  if (!s || s.t !== 'str') throw new SigilError(`${what}: expected a string`, s?.pos);
  return s.v;
}
function label(s: SExp | undefined, what: string): Conf {
  const v = sym(s, what);
  if (!CONFS.includes(v as Conf)) throw new SigilError(`${what}: unknown label ${v} (expected ${CONFS.join(', ')})`, s?.pos);
  return v as Conf;
}
function clause(items: SExp[], key: string): SExp[] | undefined {
  const c = items.find((x) => isList(x) && isSym(x.items[0], key));
  return c && isList(c) ? c.items : undefined;
}

export function parseSystem(src: string): System {
  const forms = readAll(src);
  if (forms.length !== 1 || !isList(forms[0]) || !isSym(forms[0].items[0], 'system')) throw new SigilError('expected a single (system NAME ...) form');
  const [, nameS, ...body] = forms[0].items;
  const sys: System = { name: sym(nameS, 'system name'), approved: [], declassifiers: [], processes: [], channels: [] };
  for (const f of body) {
    if (!isList(f) || !isSym(f.items[0])) throw new SigilError('expected a clause', f.pos);
    const [head, ...r] = f.items;
    switch ((head as { v: string }).v) {
      case 'approved':
        sys.approved.push([str(r[0], 'approved program hash'), str(r[1], 'approved spec hash')]);
        break;
      case 'declassifier': {
        const from = clause(r, 'from'), to = clause(r, 'to'), host = clause(r, 'hosted-in');
        if (!from || !to || !host) throw new SigilError('declassifier needs (from L) (to L) (hosted-in P)', f.pos);
        sys.declassifiers.push({ name: sym(r[0], 'declassifier name'), from: label(from[1], 'from'), to: label(to[1], 'to'), hostedIn: sym(host[1], 'hosted-in') });
        break;
      }
      case 'process': {
        const prog = clause(r, 'program'), spec = clause(r, 'spec');
        if (!prog || !spec) throw new SigilError('process needs (program "H") and (spec "H")', f.pos);
        const reads = clause(r, 'reads'), inn = clause(r, 'in');
        const sinks = r.filter((x) => isList(x) && isSym(x.items[0], 'sink')).map((x) => {
          const it = (x as { items: SExp[] }).items;
          return { name: sym(it[1], 'sink name'), clearance: label(it[2], 'sink clearance') };
        });
        sys.processes.push({ name: sym(r[0], 'process name'), program: str(prog[1], 'program'), spec: str(spec[1], 'spec'), reads: reads ? label(reads[1], 'reads') : 'public', ceiling: inn ? label(inn[1], 'in') : 'public', sinks });
        break;
      }
      case 'channel': {
        const carries = clause(r, 'carries');
        if (!carries) throw new SigilError('channel needs (carries L)', f.pos);
        const via = clause(r, 'via');
        sys.channels.push({ from: sym(r[0], 'channel from'), to: sym(r[1], 'channel to'), carries: label(carries[1], 'carries'), via: via ? sym(via[1], 'via') : undefined });
        break;
      }
      default:
        throw new SigilError(`unknown clause ${(head as { v: string }).v}`, f.pos);
    }
  }
  const dup = (what: string, keys: string[], where = '') => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) throw new SigilError(`duplicate ${what} ${k}${where}`);
      seen.add(k);
    }
  };
  dup('process', sys.processes.map((p) => p.name));
  dup('declassifier', sys.declassifiers.map((x) => x.name));
  dup('approved entry', sys.approved.map(([a, b]) => `${a}/${b}`));
  for (const p of sys.processes) dup('sink', p.sinks.map((x) => x.name), ` in process ${p.name}`);
  return sys;
}

export function checkSystem(sys: System): SysDiag[] {
  const d: SysDiag[] = [];
  const procs = new Map(sys.processes.map((p) => [p.name, p]));
  const decl = new Map(sys.declassifiers.map((x) => [x.name, x]));
  for (const x of sys.declassifiers)
    if (rank(x.to) > rank(x.from)) d.push({ code: 'E-declass', msg: `declassifier ${x.name} raises a label (from ${x.from} to ${x.to}); a declassifier may only lower one` });
  const level = new Map<string, Conf>();
  for (const p of sys.processes) level.set(p.name, p.reads);
  const valid = sys.channels.filter((c) => {
    const missing = [c.from, c.to].filter((n) => !procs.has(n));
    for (const n of missing) d.push({ code: 'E-chan-undeclared', msg: `channel ${c.from} -> ${c.to} names undeclared process ${n}` });
    return !missing.length;
  });
  for (const c of valid) level.set(c.to, max(level.get(c.to)!, c.carries));

  for (const p of sys.processes)
    if (!sys.approved.some(([pr, sp]) => pr === p.program && sp === p.spec)) d.push({ code: 'E-approval', msg: `process ${p.name}: program/spec hash pair is not in the approval ledger (stale or never approved)` });

  for (const c of valid) {
    const from = procs.get(c.from)!, to = procs.get(c.to)!;
    const held = level.get(from.name)!;
    if (c.via) {
      const x = decl.get(c.via);
      if (!x) d.push({ code: 'E-declass', msg: `channel ${c.from} -> ${c.to}: declassifier ${c.via} is not declared` });
      else {
        if (x.hostedIn !== from.name) d.push({ code: 'E-declass', msg: `channel ${c.from} -> ${c.to}: declassifier ${x.name} is hosted in ${x.hostedIn}, not in ${from.name}` });
        if (rank(held) > rank(x.from)) d.push({ code: 'E-declass', msg: `channel ${c.from} -> ${c.to}: ${from.name} holds ${held}, above what ${x.name} may release (from ${x.from})` });
        if (rank(c.carries) < rank(x.to)) d.push({ code: 'E-declass', msg: `channel ${c.from} -> ${c.to}: carries ${c.carries}, below ${x.name}'s output label ${x.to}` });
      }
    } else if (rank(held) > rank(c.carries)) d.push({ code: 'E-chan-label', msg: `channel ${c.from} -> ${c.to}: ${from.name} holds ${held} but the channel carries ${c.carries} with no declassifier` });
    if (rank(c.carries) > rank(to.ceiling)) d.push({ code: 'E-ceiling', msg: `channel ${c.from} -> ${c.to}: carries ${c.carries}, above ${to.name}'s input ceiling ${to.ceiling}` });
  }
  for (const p of sys.processes)
    for (const s of p.sinks)
      if (rank(level.get(p.name)!) > rank(s.clearance)) d.push({ code: 'E-sink', msg: `process ${p.name}: holds ${level.get(p.name)} but sink ${s.name} is cleared only for ${s.clearance}` });
  return d;
}

export function systemMain(args: string[]): number {
  const [sub, file] = args;
  if (sub !== 'check' || !file) {
    console.error('usage: sigil system check FILE');
    return 2;
  }
  try {
    const diags = checkSystem(parseSystem(readFileSync(file, 'utf8')));
    for (const x of diags) console.log(`${x.code}: ${x.msg}`);
    console.log(diags.length ? `REJECTED (${diags.length})` : 'OK');
    return diags.length ? 1 : 0;
  } catch (e) {
    console.error(e instanceof SigilError ? e.message : String(e));
    return 2;
  }
}
