// JSON AST: the naive "serialize the graph as data" baseline. Machine-trivial, token-hungry.

import { Expr, Program } from '../ast.js';
import { Sections, Syntax, bigintReplacer } from './common.js';

export const jsonSyntax: Syntax = {
  name: 'json-ast',
  blurb: 'the AST as compact JSON (naive graph serialization)',
  sections(prog: Program): Sections {
    return {
      types: JSON.stringify([...prog.types].map(([name, type]) => ({ name, type })), bigintReplacer),
      validators: JSON.stringify([...prog.validators.values()], bigintReplacer),
      fns: JSON.stringify([...prog.fns.values()], bigintReplacer),
    };
  },
  expr: (_prog, e) => JSON.stringify(e, bigintReplacer),
};

/** Parse an expression from JSON text, restoring bigints on int nodes only. Throws on invalid JSON. */
export function parseJsonExpr(src: string): Expr {
  return JSON.parse(src, function (this: { k?: string }, k: string, v: unknown) {
    if (this.k === 'int' && k === 'v' && (typeof v === 'number' || (typeof v === 'string' && /^-?\d+$/.test(v)))) return BigInt(v);
    return v;
  }) as Expr;
}
