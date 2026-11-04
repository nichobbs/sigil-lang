// Sigil AST. This is the "truth": the canonical serialization (text) is a view of it.

export type Conf = 'public' | 'internal' | 'pii' | 'secret';
export type Integ = 'untrusted' | 'screened' | 'validated' | 'approved' | 'trusted';

export interface Field {
  name: string;
  type: Type;
  conf: Conf; // declared upper bound on what may be stored in the field
  control: boolean; // requires integrity >= validated (selects a target / capability)
}

export type Type =
  | { k: 'int'; lo: bigint; hi: bigint }
  | { k: 'str'; validated: boolean }
  | { k: 'bool' }
  | { k: 'unit' }
  | { k: 'enum'; cases: string[] }
  | { k: 'rec'; fields: Field[] }
  | { k: 'list'; elem: Type; min: number; max: number }
  | { k: 'result'; ok: Type; err: Type }
  | { k: 'named'; name: string };

export type Expr =
  | { k: 'int'; v: bigint }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'var'; name: string; path: string[] }
  | { k: 'call'; fn: string; args: Expr[]; kw: { name: string; value: Expr }[] }
  | { k: 'let'; binds: { name: string; value: Expr }[]; body: Expr[] }
  | { k: 'match'; scrut: Expr; arms: { tag: string; bind: string | null; body: Expr }[] }
  | { k: 'if'; cond: Expr; then: Expr; else: Expr }
  | { k: 'lam'; params: string[]; body: Expr }
  | { k: 'do'; body: Expr[] }
  | { k: 'try'; expr: Expr; onErr: string };

export interface FnDef {
  name: string;
  params: { name: string; type: Type }[];
  out: Type;
  needs: string[]; // capability handles, e.g. store:invoices
  declassifies: string[]; // declassifiers (declared in the policy) this function may apply
  requires: Expr[];
  ensures: Expr[];
  body: Expr;
}

export interface Validator {
  name: string;
  param: string;
  out: Type; // a named validated type
  regex: string;
  samples: string[]; // known-valid values, used by generators
}

export interface Bind {
  handle: string;
  kind: string;
  caveats: Record<string, string[]>;
}

export interface Program {
  types: Map<string, Type>;
  fns: Map<string, FnDef>;
  validators: Map<string, Validator>;
  binds: Map<string, Bind>;
  entries: string[];
  targets: string[];
  names: string[]; // program names
}

export interface SinkPolicy {
  accepts: Conf;
}

/** A human-declared, auditable release of labelled data: confidentiality `from` (or below) becomes `to`. */
export interface Declassifier {
  name: string;
  from: Conf;
  to: Conf;
  reason: string;
  fields?: string[]; // restriction: only data whose labelled sources are among these (e.g. Customer.name)
  fns?: string[]; // restriction: only these functions may apply it
}

export interface Policy {
  allow: { kind: string; key?: string; pattern?: string }[];
  sinks: Map<string, SinkPolicy>;
  declassifiers: Map<string, Declassifier>;
}

/**
 * `(declassify name expr)` is represented as an ordinary call whose first argument is the declassifier
 * name. (A dedicated Expr kind would force every exhaustive switch, including the Wasm backend, to change.)
 */
export const DECLASSIFY = 'declassify';
export function asDeclassify(e: Expr): { name: string; expr: Expr } | null {
  if (e.k !== 'call' || e.fn !== DECLASSIFY || e.kw.length || e.args.length !== 2) return null;
  const n = e.args[0];
  return n.k === 'var' && n.path.length === 0 ? { name: n.name, expr: e.args[1] } : null;
}

export const CONFS: Conf[] = ['public', 'internal', 'pii', 'secret'];
export const INTEGS: Integ[] = ['untrusted', 'screened', 'validated', 'approved', 'trusted'];

export function emptyProgram(): Program {
  return {
    types: new Map(),
    fns: new Map(),
    validators: new Map(),
    binds: new Map(),
    entries: [],
    targets: [],
    names: [],
  };
}

/** Follow `named` references to a structural type. */
export function resolveType(p: Program, t: Type, seen = new Set<string>()): Type {
  while (t.k === 'named') {
    if (seen.has(t.name)) throw new Error(`cyclic type ${t.name}`);
    seen.add(t.name);
    const d = p.types.get(t.name);
    if (!d) throw new Error(`unknown type ${t.name}`);
    t = d;
  }
  return t;
}

/** Number of AST nodes in an expression (used for token-per-node metrics). */
export function countNodes(e: Expr): number {
  switch (e.k) {
    case 'int':
    case 'str':
    case 'bool':
    case 'var':
      return 1;
    case 'call':
      return 1 + e.args.reduce((n, a) => n + countNodes(a), 0) + e.kw.reduce((n, a) => n + countNodes(a.value), 0);
    case 'let':
      return 1 + e.binds.reduce((n, b) => n + countNodes(b.value), 0) + e.body.reduce((n, b) => n + countNodes(b), 0);
    case 'match':
      return 1 + countNodes(e.scrut) + e.arms.reduce((n, a) => n + 1 + countNodes(a.body), 0);
    case 'if':
      return 1 + countNodes(e.cond) + countNodes(e.then) + countNodes(e.else);
    case 'lam':
      return 1 + countNodes(e.body);
    case 'do':
      return 1 + e.body.reduce((n, b) => n + countNodes(b), 0);
    case 'try':
      return 1 + countNodes(e.expr);
  }
}

/** Structural map over immediate children (used by the mutation tester). */
export function mapChildren(e: Expr, f: (c: Expr) => Expr): Expr {
  switch (e.k) {
    case 'int':
    case 'str':
    case 'bool':
    case 'var':
      return e;
    case 'call':
      return { ...e, args: e.args.map(f), kw: e.kw.map((x) => ({ name: x.name, value: f(x.value) })) };
    case 'let':
      return { ...e, binds: e.binds.map((b) => ({ name: b.name, value: f(b.value) })), body: e.body.map(f) };
    case 'match':
      return { ...e, scrut: f(e.scrut), arms: e.arms.map((a) => ({ ...a, body: f(a.body) })) };
    case 'if':
      return { ...e, cond: f(e.cond), then: f(e.then), else: f(e.else) };
    case 'lam':
      return { ...e, body: f(e.body) };
    case 'do':
      return { ...e, body: e.body.map(f) };
    case 'try':
      return { ...e, expr: f(e.expr) };
  }
}
