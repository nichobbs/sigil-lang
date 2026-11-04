// TypeScript-flavoured baseline: what the same program looks like in the style models know best.
// Infix arithmetic with precedence, statements, braces, semicolons.

import { Expr, Field, FnDef, Program, Type } from '../ast.js';
import { Arity, Sections, Syntax, arityTable, positionalArgs } from './common.js';

function ty(t: Type): string {
  switch (t.k) {
    case 'int':
      return `int<${t.lo}, ${t.hi}>`;
    case 'str':
      return t.validated ? 'string!' : 'string';
    case 'bool':
      return 'boolean';
    case 'unit':
      return 'void';
    case 'enum':
      return `enum { ${t.cases.join(', ')} }`;
    case 'rec':
      return `{ ${t.fields.map(field).join(', ')} }`;
    case 'list':
      return `List<${ty(t.elem)}, ${t.min}, ${t.max}>`;
    case 'result':
      return `Result<${ty(t.ok)}, ${ty(t.err)}>`;
    case 'named':
      return t.name;
  }
}

function field(f: Field): string {
  const flags = [f.conf !== 'public' ? ` @${f.conf}` : '', f.control ? ' @control' : ''].join('');
  return `${f.name}: ${ty(f.type)}${flags}`;
}

const PREC: Record<string, number> = { '||': 1, '&&': 2, cmp: 3, '+': 4, '-': 4, '*': 5, '/': 5 };
const INFIX: Record<string, string> = { add: '+', sub: '-', mul: '*', 'div-floor': '/' };
const CMP: Record<string, string> = { '<=': '<=', '<': '<', '>=': '>=', '>': '>', '=': '==' };

function paren(s: string, own: number, ctx: number): string {
  return own < ctx ? `(${s})` : s;
}

export function expr(a: Arity, e: Expr, ctx = 0): string {
  const x = (y: Expr, c = 0) => expr(a, y, c);
  switch (e.k) {
    case 'int':
      return e.v.toString();
    case 'str':
      return JSON.stringify(e.v);
    case 'bool':
      return String(e.v);
    case 'var':
      return [e.name, ...e.path].join('.');
    case 'call': {
      const args = positionalArgs(a, e);
      if (e.fn in INFIX && args.length === 2) {
        const p = PREC[INFIX[e.fn]];
        return paren(`${x(args[0], p)} ${INFIX[e.fn]} ${x(args[1], p + 1)}`, p, ctx);
      }
      if (e.fn in CMP && args.length >= 2) {
        const parts: string[] = [];
        for (let i = 0; i + 1 < args.length; i++) parts.push(`${x(args[i], PREC.cmp + 1)} ${CMP[e.fn]} ${x(args[i + 1], PREC.cmp + 1)}`);
        return paren(parts.join(' && '), parts.length > 1 ? PREC['&&'] : PREC.cmp, ctx);
      }
      if (e.fn === 'and' || e.fn === 'or') {
        const op = e.fn === 'and' ? '&&' : '||';
        return paren(args.map((y) => x(y, PREC[op] + 1)).join(` ${op} `), PREC[op], ctx);
      }
      if (e.fn === 'not' && args.length === 1) return `!${x(args[0], 9)}`;
      if (e.fn === 'list') return `[${args.map((y) => x(y)).join(', ')}]`;
      if (e.kw.length && a.fields(e.fn)) return `${e.fn} { ${e.kw.map((k) => `${k.name}: ${x(k.value)}`).join(', ')} }`;
      return `${e.fn}(${args.map((y) => x(y)).join(', ')})`;
    }
    case 'let':
      return `(() => { ${block(a, e)} })()`;
    case 'do':
      return `(() => { ${block(a, e)} })()`;
    case 'match':
      return `match ${x(e.scrut, 9)} { ${e.arms.map((r) => `${r.tag}${r.bind ? `(${r.bind})` : ''} => ${x(r.body)}`).join(', ')} }`;
    case 'if':
      return paren(`${x(e.cond, 1)} ? ${x(e.then, 1)} : ${x(e.else, 0)}`, 0, ctx);
    case 'lam':
      return `(${e.params.join(', ')}) => ${x(e.body)}`;
    case 'try':
      return `try ${x(e.expr)} else ${e.onErr}`;
  }
}

function block(a: Arity, e: Expr): string {
  const stmts: string[] = [];
  const emit = (b: Expr, last: boolean) => {
    if (b.k === 'let') {
      for (const bd of b.binds) stmts.push(`const ${bd.name} = ${expr(a, bd.value)};`);
      b.body.forEach((y, i) => emit(y, last && i === b.body.length - 1));
    } else if (b.k === 'do') b.body.forEach((y, i) => emit(y, last && i === b.body.length - 1));
    else stmts.push(last ? `return ${expr(a, b)};` : `${expr(a, b)};`);
  };
  emit(e, true);
  return stmts.join('\n');
}

function fn(a: Arity, f: FnDef): string {
  const ann = [
    f.needs.length ? `@needs(${f.needs.join(', ')})` : '',
    f.declassifies.length ? `@declassifies(${f.declassifies.join(', ')})` : '',
    ...f.requires.map((r) => `@requires(${expr(a, r)})`),
    ...f.ensures.map((r) => `@ensures(${expr(a, r)})`),
  ].filter(Boolean);
  const head = `fn ${f.name}(${f.params.map((p) => `${p.name}: ${ty(p.type)}`).join(', ')}): ${ty(f.out)} {`;
  return [...ann, head, block(a, f.body), '}'].join('\n');
}

export const braces: Syntax = {
  name: 'ts-like',
  blurb: 'TypeScript-flavoured baseline: infix operators, statements, braces',
  sections(prog: Program): Sections {
    const a = arityTable(prog);
    return {
      types: [...prog.types].map(([n, t]) => `type ${n} = ${ty(t)};`).join('\n'),
      validators: [...prog.validators.values()]
        .map((v) => `validator ${v.name}(${v.param}: string): ${ty(v.out)} matches ${JSON.stringify(v.regex)}${v.samples.length ? ` samples [${v.samples.map((s) => JSON.stringify(s)).join(', ')}]` : ''};`)
        .join('\n'),
      fns: [...prog.fns.values()].map((f) => fn(a, f)).join('\n'),
    };
  },
  expr: (prog, e) => expr(arityTable(prog), e),
};
