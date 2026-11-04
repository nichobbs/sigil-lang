// Shared helpers for alternative surface syntaxes: arity tables and canonical constructor ordering.

import { Expr, Program, resolveType } from '../ast.js';
import { BUILTIN_ARITY, CAP_OPS } from '../caps.js';

export interface Arity {
  /** Number of positional arguments, -1 for variadic, null if `name` is not a callable. */
  of(name: string): number | null;
  fields(name: string): string[] | null; // record constructor field order
}

export function arityTable(prog: Program): Arity {
  const fields = (name: string): string[] | null => {
    const t = prog.types.get(name);
    if (!t) return null;
    const r = resolveType(prog, t);
    return r.k === 'rec' ? r.fields.map((f) => f.name) : null;
  };
  return {
    of(name) {
      if (name in BUILTIN_ARITY) return BUILTIN_ARITY[name];
      if (name in CAP_OPS) return CAP_OPS[name].arity;
      const f = prog.fns.get(name);
      if (f) return f.params.length;
      const fl = fields(name);
      return fl ? fl.length : null;
    },
    fields,
  };
}

/** Positional argument list for a call; keyword record constructors are reordered to field order. */
export function positionalArgs(a: Arity, e: Extract<Expr, { k: 'call' }>): Expr[] {
  if (!e.kw.length) return e.args;
  const fl = a.fields(e.fn);
  if (!fl) return [...e.args, ...e.kw.map((k) => k.value)];
  return fl.map((f) => e.kw.find((k) => k.name === f)!.value);
}

export interface Sections {
  types: string;
  validators: string;
  fns: string;
}

export interface Syntax {
  name: string;
  blurb: string;
  sections(prog: Program): Sections;
  expr(prog: Program, e: Expr): string;
}

export const bigintReplacer = (_: string, v: unknown) => (typeof v === 'bigint' ? (v <= 9007199254740991n && v >= -9007199254740991n ? Number(v) : v.toString()) : v);
