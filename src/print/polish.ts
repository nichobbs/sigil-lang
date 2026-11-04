// Prefix ("Polish") syntax with no delimiters at all. Calls to fixed-arity functions need no
// punctuation; variadic constructs carry an explicit count. The parser exists so the fragility
// experiment can test what a dropped token does.

import { Expr, Field, FnDef, Program, Type } from '../ast.js';
import { BUILTIN_ARITY } from '../caps.js';
import { Arity, Sections, Syntax, arityTable, positionalArgs } from './common.js';

function tyTokens(t: Type): string[] {
  switch (t.k) {
    case 'int':
      return ['int', t.lo.toString(), t.hi.toString()];
    case 'str':
      return [t.validated ? 'vstr' : 'str'];
    case 'bool':
      return ['bool'];
    case 'unit':
      return ['unit'];
    case 'enum':
      return ['enum', String(t.cases.length), ...t.cases];
    case 'rec':
      return ['rec', String(t.fields.length), ...t.fields.flatMap(fieldTokens)];
    case 'list':
      return ['list', ...tyTokens(t.elem), String(t.min), String(t.max)];
    case 'result':
      return ['result', ...tyTokens(t.ok), ...tyTokens(t.err)];
    case 'named':
      return [t.name];
  }
}

function fieldTokens(f: Field): string[] {
  const flags = [f.conf !== 'public' ? f.conf : '', f.control ? 'control' : ''].filter(Boolean);
  return [f.name, ...tyTokens(f.type), String(flags.length), ...flags];
}

export function exprTokens(a: Arity, e: Expr): string[] {
  const x = (y: Expr) => exprTokens(a, y);
  switch (e.k) {
    case 'int':
      return [e.v.toString()];
    case 'str':
      return [JSON.stringify(e.v)];
    case 'bool':
      return [String(e.v)];
    case 'var':
      return [[e.name, ...e.path].join('.')];
    case 'call': {
      const args = positionalArgs(a, e);
      return a.of(e.fn) === -1 ? [e.fn, String(args.length), ...args.flatMap(x)] : [e.fn, ...args.flatMap(x)];
    }
    case 'let':
      return ['let', String(e.binds.length), ...e.binds.flatMap((b) => [b.name, ...x(b.value)]), String(e.body.length), ...e.body.flatMap(x)];
    case 'match':
      return ['match', ...x(e.scrut), String(e.arms.length), ...e.arms.flatMap((r) => [r.tag, ...(r.bind ? ['@' + r.bind] : []), ...x(r.body)])];
    case 'if':
      return ['if', ...x(e.cond), ...x(e.then), ...x(e.else)];
    case 'lam':
      return ['fn', String(e.params.length), ...e.params, ...x(e.body)];
    case 'do':
      return ['do', String(e.body.length), ...e.body.flatMap(x)];
    case 'try':
      return ['try', ...x(e.expr), e.onErr];
  }
}

function fnTokens(a: Arity, f: FnDef): string[] {
  return [
    'fn',
    f.name,
    String(f.params.length),
    ...f.params.flatMap((p) => [p.name, ...tyTokens(p.type)]),
    ...tyTokens(f.out),
    String(f.needs.length),
    ...f.needs,
    String(f.requires.length),
    ...f.requires.flatMap((r) => exprTokens(a, r)),
    String(f.ensures.length),
    ...f.ensures.flatMap((r) => exprTokens(a, r)),
    ...exprTokens(a, f.body),
  ];
}

export const polish: Syntax = {
  name: 'prefix',
  blurb: 'delimiter-free prefix notation; arity known, counts for variadics',
  sections(prog: Program): Sections {
    const a = arityTable(prog);
    return {
      types: [...prog.types].map(([n, t]) => ['type', n, ...tyTokens(t)].join(' ')).join('\n'),
      validators: [...prog.validators.values()]
        .map((v) => ['vld', v.name, ...tyTokens(v.out), JSON.stringify(v.regex), String(v.samples.length), ...v.samples.map((s) => JSON.stringify(s))].join(' '))
        .join('\n'),
      fns: [...prog.fns.values()].map((f) => fnTokens(a, f).join(' ')).join('\n'),
    };
  },
  expr: (prog, e) => exprTokens(arityTable(prog), e).join(' '),
};

// ---------------------------------------------------------------------------
// Expression parser (used only by the fragility experiment)
// ---------------------------------------------------------------------------

export class PolishError extends Error {}

export function tokenizePolish(src: string): string[] {
  return src.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
}

export function parsePolishExpr(src: string, a: Arity): Expr {
  const toks = tokenizePolish(src);
  let i = 0;
  const next = (what: string): string => {
    if (i >= toks.length) throw new PolishError(`unexpected end of input, expected ${what}`);
    return toks[i++];
  };
  const count = (what: string): number => {
    const t = next(what);
    if (!/^\d+$/.test(t)) throw new PolishError(`expected a count for ${what}, got ${t}`);
    return Number(t);
  };
  const ident = (what: string): string => {
    const t = next(what);
    if (!/^[A-Za-z_][\w\-:]*$/.test(t)) throw new PolishError(`expected ${what}, got ${t}`);
    return t;
  };
  function expr(): Expr {
    const t = next('an expression');
    if (/^-?\d+$/.test(t)) return { k: 'int', v: BigInt(t) };
    if (t.startsWith('"')) return { k: 'str', v: JSON.parse(t) };
    if (t === 'true' || t === 'false') return { k: 'bool', v: t === 'true' };
    switch (t) {
      case 'let': {
        const n = count('let bindings');
        const binds: { name: string; value: Expr }[] = [];
        for (let j = 0; j < n; j++) binds.push({ name: ident('binding name'), value: expr() });
        const m = count('let body');
        if (m === 0) throw new PolishError('empty let body');
        const body: Expr[] = [];
        for (let j = 0; j < m; j++) body.push(expr());
        return { k: 'let', binds, body };
      }
      case 'match': {
        const scrut = expr();
        const n = count('match arms');
        const arms: { tag: string; bind: string | null; body: Expr }[] = [];
        for (let j = 0; j < n; j++) {
          const tag = ident('arm tag');
          let bind: string | null = null;
          if (toks[i]?.startsWith('@')) bind = next('binder').slice(1);
          arms.push({ tag, bind, body: expr() });
        }
        return { k: 'match', scrut, arms };
      }
      case 'if':
        return { k: 'if', cond: expr(), then: expr(), else: expr() };
      case 'fn': {
        const n = count('lambda parameters');
        const params: string[] = [];
        for (let j = 0; j < n; j++) params.push(ident('parameter'));
        return { k: 'lam', params, body: expr() };
      }
      case 'do': {
        const n = count('do body');
        if (n === 0) throw new PolishError('empty do');
        const body: Expr[] = [];
        for (let j = 0; j < n; j++) body.push(expr());
        return { k: 'do', body };
      }
      case 'try': {
        const e = expr();
        return { k: 'try', expr: e, onErr: ident('error variant') };
      }
    }
    const ar = a.of(t);
    if (ar === null) {
      if (!/^[A-Za-z_][\w\-:.]*$/.test(t)) throw new PolishError(`unexpected token ${t}`);
      const parts = t.split('.');
      return { k: 'var', name: parts[0], path: parts.slice(1) };
    }
    const n = ar === -1 ? count(`${t} argument count`) : ar;
    const args: Expr[] = [];
    for (let j = 0; j < n; j++) args.push(expr());
    return { k: 'call', fn: t, args, kw: [] };
  }
  const e = expr();
  if (i !== toks.length) throw new PolishError(`${toks.length - i} unconsumed token(s) after the expression`);
  return e;
}

export const POLISH_FIXED = Object.entries(BUILTIN_ARITY).filter(([, n]) => n >= 0).map(([k]) => k);
