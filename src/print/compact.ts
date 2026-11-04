// Compact S-expression dialect: same tree shape as the verbose form, minus the ceremony.
//   - no (in ...)/(out ...) wrappers, short type constructors, symbolic arithmetic
//   - positional record constructors (field order is canonical), (try e Variant)

import { Expr, Field, FnDef, Program, Type } from '../ast.js';
import { Arity, Sections, Syntax, arityTable, positionalArgs } from './common.js';

const RENAME: Record<string, string> = { add: '+', sub: '-', mul: '*', 'div-floor': '/' };

function ty(t: Type): string {
  switch (t.k) {
    case 'int':
      return `(I ${t.lo} ${t.hi})`;
    case 'str':
      return t.validated ? 'S!' : 'S';
    case 'bool':
      return 'B';
    case 'unit':
      return 'U';
    case 'enum':
      return `(var ${t.cases.join(' ')})`;
    case 'rec':
      return `(rec ${t.fields.map(field).join(' ')})`;
    case 'list':
      return `(L ${ty(t.elem)} ${t.min} ${t.max})`;
    case 'result':
      return `(R ${ty(t.ok)} ${ty(t.err)})`;
    case 'named':
      return t.name;
  }
}

function field(f: Field): string {
  const flags = [f.conf !== 'public' ? `:${f.conf}` : '', f.control ? ':control' : ''].filter(Boolean);
  return `(${f.name} ${ty(f.type)}${flags.length ? ' ' + flags.join(' ') : ''})`;
}

export function expr(a: Arity, e: Expr): string {
  const x = (y: Expr) => expr(a, y);
  switch (e.k) {
    case 'int':
      return e.v.toString();
    case 'str':
      return JSON.stringify(e.v);
    case 'bool':
      return String(e.v);
    case 'var':
      return [e.name, ...e.path].join('.');
    case 'call':
      return `(${[RENAME[e.fn] ?? e.fn, ...positionalArgs(a, e).map(x)].join(' ')})`;
    case 'let':
      return `(let (${e.binds.map((b) => `${b.name} ${x(b.value)}`).join(' ')}) ${e.body.map(x).join(' ')})`;
    case 'match':
      return `(match ${x(e.scrut)} ${e.arms.map((r) => (r.bind ? `(${r.tag} ${r.bind} ${x(r.body)})` : `(${r.tag} ${x(r.body)})`)).join(' ')})`;
    case 'if':
      return `(if ${x(e.cond)} ${x(e.then)} ${x(e.else)})`;
    case 'lam':
      return `(fn (${e.params.join(' ')}) ${x(e.body)})`;
    case 'do':
      return `(do ${e.body.map(x).join(' ')})`;
    case 'try':
      return `(try ${x(e.expr)} ${e.onErr})`;
  }
}

function fn(a: Arity, f: FnDef): string {
  const parts = [
    `(fn ${f.name}`,
    `(${f.params.map((p) => `(${p.name} ${ty(p.type)})`).join(' ')})`,
    ty(f.out),
    f.needs.length ? `(needs ${f.needs.join(' ')})` : '',
    f.declassifies.length ? `(declassifies ${f.declassifies.join(' ')})` : '',
    ...f.requires.map((r) => `(req ${expr(a, r)})`),
    ...f.ensures.map((r) => `(ens ${expr(a, r)})`),
    f.body.k === 'do' ? f.body.body.map((b) => expr(a, b)).join(' ') : expr(a, f.body),
  ].filter(Boolean);
  return parts.join(' ') + ')';
}

export const compact: Syntax = {
  name: 'sexp-compact',
  blurb: 'S-expr, short keywords, positional ctors, symbolic arithmetic',
  sections(prog: Program): Sections {
    const a = arityTable(prog);
    return {
      types: [...prog.types].map(([n, t]) => `(type ${n} ${ty(t)})`).join('\n'),
      validators: [...prog.validators.values()]
        .map((v) => `(vld ${v.name} ${ty(v.out)} ${JSON.stringify(v.regex)}${v.samples.map((s) => ' ' + JSON.stringify(s)).join('')})`)
        .join('\n'),
      fns: [...prog.fns.values()].map((f) => fn(a, f)).join('\n'),
    };
  },
  expr: (prog, e) => expr(arityTable(prog), e),
};
