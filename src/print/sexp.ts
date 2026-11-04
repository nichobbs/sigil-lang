// Canonical verbose S-expression printer: the agent-facing serialization of the graph.
// parse(print(ast)) must equal ast (tested).

import { Expr, Field, FnDef, Program, Type, Validator } from '../ast.js';
import { Sections, Syntax } from './common.js';

export function printType(t: Type): string {
  switch (t.k) {
    case 'int':
      return `(Int ${t.lo} ${t.hi})`;
    case 'str':
      return t.validated || t.max !== undefined ? `(Str${t.validated ? ' :validated' : ''}${t.max !== undefined ? ` :max ${t.max}` : ''})` : 'Str';
    case 'bool':
      return 'Bool';
    case 'unit':
      return 'Unit';
    case 'enum':
      return `(var ${t.cases.join(' ')})`;
    case 'rec':
      return `(rec ${t.fields.map(printField).join(' ')})`;
    case 'list':
      return `(List ${printType(t.elem)} ${t.min} ${t.max})`;
    case 'result':
      return `(Result ${printType(t.ok)} ${printType(t.err)})`;
    case 'named':
      return t.name;
  }
}

function printField(f: Field): string {
  const flags = [f.conf !== 'public' ? `:${f.conf}` : '', f.control ? ':control' : ''].filter(Boolean);
  return `(${f.name} ${printType(f.type)}${flags.length ? ' ' + flags.join(' ') : ''})`;
}

export function printExpr(e: Expr): string {
  switch (e.k) {
    case 'int':
      return e.v.toString();
    case 'str':
      return JSON.stringify(e.v);
    case 'bool':
      return e.v ? 'true' : 'false';
    case 'var':
      return [e.name, ...e.path].join('.');
    case 'call': {
      const parts = [e.fn, ...e.args.map(printExpr), ...e.kw.flatMap((k) => [`:${k.name}`, printExpr(k.value)])];
      return `(${parts.join(' ')})`;
    }
    case 'let':
      return `(let [${e.binds.map((b) => `${b.name} ${printExpr(b.value)}`).join(' ')}] ${e.body.map(printExpr).join(' ')})`;
    case 'match':
      return `(match ${printExpr(e.scrut)} ${e.arms
        .map((a) => (a.bind ? `(${a.tag} ${a.bind} ${printExpr(a.body)})` : `(${a.tag} ${printExpr(a.body)})`))
        .join(' ')})`;
    case 'if':
      return `(if ${printExpr(e.cond)} ${printExpr(e.then)} ${printExpr(e.else)})`;
    case 'lam':
      return `(fn (${e.params.join(' ')}) ${printExpr(e.body)})`;
    case 'do':
      return `(do ${e.body.map(printExpr).join(' ')})`;
    case 'try':
      return `(try ${printExpr(e.expr)} :on-err ${e.onErr})`;
  }
}

export function printFn(f: FnDef): string {
  const clauses = [
    `(in ${f.params.map((p) => `(${p.name} ${printType(p.type)})`).join(' ')})`,
    `(out ${printType(f.out)})`,
    f.needs.length ? `(needs ${f.needs.join(' ')})` : '',
    f.declassifies.length ? `(declassifies ${f.declassifies.join(' ')})` : '',
    ...f.requires.map((r) => `(requires ${printExpr(r)})`),
    ...f.ensures.map((r) => `(ensures ${printExpr(r)})`),
  ].filter(Boolean);
  const body = f.body.k === 'do' ? f.body.body.map(printExpr).join(' ') : printExpr(f.body);
  return `(fn ${f.name} ${clauses.join(' ')} ${body})`;
}

export function printValidator(v: Validator): string {
  return `(validator ${v.name} (in (${v.param} Str)) (out ${printType(v.out)}) (regex ${JSON.stringify(v.regex)})${v.samples.length ? ` (sample ${v.samples.map((x) => JSON.stringify(x)).join(' ')})` : ''})`;
}

/** Implementation layer only (types, validators, fns). Wiring/policy are separate layers. */
export function printProgram(p: Program): string {
  const lines: string[] = [];
  for (const [n, t] of p.types) lines.push(`(type ${n} ${printType(t)})`);
  for (const v of p.validators.values()) lines.push(printValidator(v));
  for (const f of p.fns.values()) lines.push(printFn(f));
  return lines.join('\n') + '\n';
}

export const sexpVerbose: Syntax = {
  name: 'sexp-verbose',
  blurb: 'canonical S-expr: named clauses, keyword args, [let] brackets',
  sections(p: Program): Sections {
    return {
      types: [...p.types].map(([n, t]) => `(type ${n} ${printType(t)})`).join('\n'),
      validators: [...p.validators.values()].map(printValidator).join('\n'),
      fns: [...p.fns.values()].map(printFn).join('\n'),
    };
  },
  expr: (_p, e) => printExpr(e),
};
