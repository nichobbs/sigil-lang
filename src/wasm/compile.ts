// Wasm backend for the pure numeric core of Sigil.
//
// Lists: a list parameter is passed as (ptr, len) into an exported linear memory; elements are
// fixed-stride arrays of 8-byte slots (one per scalar field). len, sum, map, filter and `list` compile to
// loops over memory with the lambda inlined. Scratch memory is laid out statically from the list types'
// declared maximum lengths (no dynamic allocation).
//
// Scope (everything else is reported "not compilable" with a reason, never miscompiled):
//   params   : ranged Int, Bool, enum, and records of those (flattened to scalar params)
//   result   : ranged Int, Bool, enum
//   body     : int/bool literals, variables and field reads, let/do, if, match on enums,
//              add sub mul div-floor neg min max, = < <= > >=, and or not
//   function must have: no `needs`, no `requires`, no checker errors, every non-`ensures`
//   obligation proved by the interval analysis (so overflow and zero-divisor are excluded).
//
// The point of the exercise: the checker has already proved there is no overflow and no zero
// divisor, so the emitted code is plain wrapping i32/i64 arithmetic with NO checks.
// (`ensures` clauses are specifications; they are not emitted.)

import { Expr, FnDef, Program, Type, resolveType } from '../ast.js';
import { CAP_OPS } from '../caps.js';
import { CheckResult, FnEvidence } from '../check.js';
import { Repr, reprFor } from '../interval.js';
import { uleb } from './encode.js';
import { I32, I64, IntOps, OP, ValType, WasmFunc, blockType, buildModule, i64Load, i64Store, localGet, localSet } from './encode.js';

/** Memory layout of one list element: `stride` 8-byte slots, one per scalar leaf (string fields are omitted). */
export interface ElemLayout {
  stride: number;
  leaves: { path: string; kind: Kind; slot: number }[];
  key: string;
}
export type Kind = { t: 'int' } | { t: 'bool' } | { t: 'enum'; cases: string[] } | { t: 'list'; layout: ElemLayout; min: number; max: number };

/** Inputs plus scratch above this many bytes are refused (a list type with an absurd declared maximum). */
export const MAX_MEMORY_BYTES = 16 * 1024 * 1024;
export const MEM_BASE = 16; // inputs start here (keeps address 0 unused)
export const SLOT = 8;

export interface Leaf {
  path: string; // '' for a scalar parameter, else 'field' or 'field.sub' inside a record parameter
  kind: Kind;
  lo?: bigint;
  hi?: bigint;
}
export interface ParamSpec {
  name: string;
  type: Type;
  leaves: Leaf[];
}

export interface FnReport {
  name: string;
  compilable: boolean;
  reason?: string;
  checkerRepr: Repr;
  repr?: 'i32' | 'i64'; // representation actually used for every Int in the function
  widenedFromChecker?: string; // set when the checker's repr was too narrow for parameters/literals
  params?: ParamSpec[];
  result?: Kind;
  hasBase?: boolean; // takes a trailing i32 scratch-base parameter and uses linear memory
  inputBytes?: number; // bytes reserved for list parameters (from MEM_BASE), at their declared maximum lengths
  scratchBytes?: number; // statically bounded scratch needed above the inputs (including callees)
}

export interface CompileOptions {
  /** Test hook for mutation testing the compiler itself: 'trunc' emits plain div_s (WRONG for negatives). */
  divMode?: 'floor' | 'trunc';
}

export interface CompileResult {
  bytes: Uint8Array;
  fns: FnReport[];
  memPages?: number; // 64KiB pages of the exported "memory" (only when some function uses lists)
}

/** What a caller needs to know about a compiled callee. */
export interface Callee {
  index: number;
  vt: ValType; // int representation of the callee
  params: Kind[];
  result: Kind;
  hasBase: boolean;
  need: number; // scratch bytes the callee uses above its base
}
export type CalleeResolver = (name: string) => Callee | string; // string = reason it cannot be called

class NotCompilable extends Error {}
const no = (reason: string): never => {
  throw new NotCompilable(reason);
};

const sameCases = (a: string[], b: string[]) => a.length === b.length && a.every((c, i) => c === b[i]);
const sameKind = (a: Kind, b: Kind): boolean =>
  a.t === b.t && (a.t !== 'enum' || sameCases(a.cases, (b as typeof a).cases)) && (a.t !== 'list' || a.layout.key === (b as typeof a).layout.key);
const showKind = (k: Kind) => (k.t === 'enum' ? `enum(${k.cases.join('|')})` : k.t === 'list' ? `list(${k.layout.key})` : k.t);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function kindOfType(prog: Program, t: Type, what: string): Kind {
  const r = resolveType(prog, t);
  switch (r.k) {
    case 'int':
      return { t: 'int' };
    case 'bool':
      return { t: 'bool' };
    case 'enum':
      return { t: 'enum', cases: r.cases };
    default:
      return no(`${what} has type ${r.k}, which is outside the numeric subset (Int, Bool, enum)`);
  }
}

function leavesOf(prog: Program, t: Type, path: string, what: string): Leaf[] {
  const r = resolveType(prog, t);
  if (r.k === 'rec') return r.fields.flatMap((f) => leavesOf(prog, f.type, path ? `${path}.${f.name}` : f.name, `${what}.${f.name}`));
  const kind = kindOfType(prog, r, what);
  return [r.k === 'int' ? { path, kind, lo: r.lo, hi: r.hi } : { path, kind }];
}

/** Layout of a list element. Record fields of type Str are not stored (compiled code cannot read them). */
function layoutOf(prog: Program, elem: Type, what: string): ElemLayout {
  const leaves: { path: string; kind: Kind; slot: number }[] = [];
  const walkT = (t: Type, path: string, w: string) => {
    const x = resolveType(prog, t);
    if (x.k === 'rec') {
      for (const f of x.fields) walkT(f.type, path ? `${path}.${f.name}` : f.name, `${w}.${f.name}`);
    } else if (x.k === 'str' && path) {
      return; // opaque field: not stored, and any read of it is refused
    } else if (x.k === 'list') {
      no(`${w} is a nested list (not supported)`);
    } else {
      leaves.push({ path, kind: kindOfType(prog, x, w), slot: leaves.length });
    }
  };
  walkT(elem, '', what);
  if (!leaves.length) no(`${what} has no scalar fields`);
  return { stride: leaves.length, leaves, key: leaves.map((l) => `${l.path}:${showKind(l.kind)}`).join(',') };
}

function listKind(prog: Program, t: Extract<ReturnType<typeof resolveType>, { k: 'list' }>, what: string): Kind {
  const layout = layoutOf(prog, t.elem, `${what} element`);
  const bytes = t.max * layout.stride * SLOT;
  if (!Number.isFinite(t.max) || t.max < 0 || bytes > MAX_MEMORY_BYTES) no(`${what}: list maximum length ${t.max} needs ${bytes} bytes, over the ${MAX_MEMORY_BYTES} byte limit`);
  return { t: 'list', layout, min: t.min, max: t.max };
}

/** Sub-expression walk (including lambda bodies). */
function walk(e: Expr, f: (e: Expr) => void): void {
  f(e);
  switch (e.k) {
    case 'call':
      e.args.forEach((a) => walk(a, f));
      e.kw.forEach((a) => walk(a.value, f));
      break;
    case 'let':
      e.binds.forEach((b) => walk(b.value, f));
      e.body.forEach((b) => walk(b, f));
      break;
    case 'match':
      walk(e.scrut, f);
      e.arms.forEach((a) => walk(a.body, f));
      break;
    case 'if':
      walk(e.cond, f);
      walk(e.then, f);
      walk(e.else, f);
      break;
    case 'lam':
      walk(e.body, f);
      break;
    case 'do':
      e.body.forEach((b) => walk(b, f));
      break;
    case 'try':
      walk(e.expr, f);
      break;
  }
}

// ---------------------------------------------------------------------------
// Expression walk helpers
// ---------------------------------------------------------------------------

function literals(e: Expr, out: bigint[]): void {
  switch (e.k) {
    case 'int':
      out.push(e.v);
      return;
    case 'call':
      e.args.forEach((a) => literals(a, out));
      e.kw.forEach((a) => literals(a.value, out));
      return;
    case 'let':
      e.binds.forEach((b) => literals(b.value, out));
      e.body.forEach((b) => literals(b, out));
      return;
    case 'match':
      literals(e.scrut, out);
      e.arms.forEach((a) => literals(a.body, out));
      return;
    case 'if':
      literals(e.cond, out);
      literals(e.then, out);
      literals(e.else, out);
      return;
    case 'lam':
      literals(e.body, out);
      return;
    case 'do':
      e.body.forEach((b) => literals(b, out));
      return;
    case 'try':
      literals(e.expr, out);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Code generation for one function
// ---------------------------------------------------------------------------

/** A list value: two i32 locals (pointer, length) plus its static bounds. */
interface ListVal {
  ptr: number;
  len: number;
  kind: Extract<Kind, { t: 'list' }>;
}
interface G {
  c: number[]; // for a list value: stack-neutral code that leaves the list's ptr/len locals set
  kind: Kind;
  lv?: ListVal;
}
type Binding =
  | { b: 'val'; local: number; kind: Kind }
  | { b: 'rec'; leaves: Map<string, { local: number; kind: Kind }> }
  | { b: 'list'; lv: ListVal };

class FnGen {
  locals: ValType[] = [];
  scopes: Map<string, Binding>[] = [];
  nParams = 0;
  baseLocal = -1; // i32 scratch base (trailing parameter), when the function uses memory
  frame = 0; // bytes of scratch allocated so far (static offsets from the base)
  need = 0; // max scratch bytes needed, including callees
  constructor(
    private prog: Program,
    private R: IntOps,
    private opts: CompileOptions,
    private callee: CalleeResolver,
  ) {}

  alloc(vt: ValType): number {
    this.locals.push(vt);
    return this.nParams + this.locals.length - 1;
  }

  private enumCaseIndex(name: string): { kind: Kind; idx: number } | undefined {
    const hits: string[][] = [];
    for (const t of this.prog.types.values()) {
      if (t.k === 'enum' && t.cases.includes(name) && !hits.some((h) => sameCases(h, t.cases))) hits.push(t.cases);
    }
    if (hits.length > 1) return no(`enum case ${name} belongs to more than one enum type (ambiguous)`);
    return hits.length ? { kind: { t: 'enum', cases: hits[0] }, idx: hits[0].indexOf(name) } : undefined;
  }

  private lookup(name: string): Binding | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const b = this.scopes[i].get(name);
      if (b) return b;
    }
    return undefined;
  }

  private int(g: G, what: string): number[] {
    if (g.kind.t !== 'int') no(`${what}: expected Int, got ${showKind(g.kind)}`);
    return g.c;
  }
  private bool(g: G, what: string): number[] {
    if (g.kind.t !== 'bool') no(`${what}: expected Bool, got ${showKind(g.kind)}`);
    return g.c;
  }
  private vtOf(k: Kind): ValType {
    if (k.t === 'list') return no('internal: a list has no single wasm type');
    return k.t === 'int' ? this.R.vt : 'i32';
  }

  private scalar(g: G, what: string): G {
    if (g.kind.t === 'list') no(`${what}: a list value is not allowed here`);
    return g;
  }

  /** Reserve `bytes` of scratch at a static offset from the base; returns that offset. */
  private allocScratch(bytes: number, what: string): number {
    if (this.baseLocal < 0) no(`internal: ${what} needs scratch memory but the function has no base`);
    const off = this.frame;
    this.frame += bytes;
    this.need = Math.max(this.need, this.frame);
    if (MEM_BASE + this.need > MAX_MEMORY_BYTES) no(`${what}: scratch of ${this.need} bytes exceeds the ${MAX_MEMORY_BYTES} byte limit`);
    return off;
  }

  private baseAddr(off: number): number[] {
    return [...localGet(this.baseLocal), ...I32.const(BigInt(off)), I32.add];
  }

  /** Convert a value on the stack to its 8-byte slot form (i64). */
  private toSlot(k: Kind): number[] {
    return k.t === 'int' ? (this.R.vt === 'i64' ? [] : [OP.i64ExtendI32S]) : [OP.i64ExtendI32U];
  }
  /** Convert an i64 slot value on the stack to the function's representation of `k`. */
  private fromSlot(k: Kind): number[] {
    return k.t === 'int' && this.R.vt === 'i64' ? [] : [OP.i32WrapI64];
  }

  /** `for i in 0..len { body }` */
  private loop(len: number, i: number, body: number[]): number[] {
    return [
      ...I32.const(0n), ...localSet(i),
      OP.block, OP.void, OP.loop, OP.void,
      ...localGet(i), ...localGet(len), I32.geS, OP.brIf, 1,
      ...body,
      ...localGet(i), ...I32.const(1n), I32.add, ...localSet(i),
      OP.br, 0,
      OP.end, OP.end,
    ];
  }

  /** Bind a lambda parameter to the element at index `i`; returns the binding and the code that loads it. */
  private bindElem(lv: ListVal, i: number): { binding: Binding; load: number[] } {
    const L = lv.kind.layout;
    const ea = this.alloc('i32');
    const load: number[] = [...localGet(lv.ptr), ...localGet(i), ...I32.const(BigInt(L.stride * SLOT)), I32.mul, I32.add, ...localSet(ea)];
    const leaves = new Map<string, { local: number; kind: Kind }>();
    for (const l of L.leaves) {
      const local = this.alloc(this.vtOf(l.kind));
      load.push(...localGet(ea), ...i64Load(l.slot * SLOT), ...this.fromSlot(l.kind), ...localSet(local));
      leaves.set(l.path, { local, kind: l.kind });
    }
    const only = leaves.get('');
    return { binding: only && L.leaves.length === 1 ? { b: 'val', local: only.local, kind: only.kind } : { b: 'rec', leaves }, load };
  }

  private listArg(e: Expr, what: string): G & { lv: ListVal } {
    const g = this.gen(e);
    if (g.kind.t !== 'list' || !g.lv) return no(`${what}: expected a list, got ${showKind(g.kind)}`);
    return g as G & { lv: ListVal };
  }

  private lambda(e: Expr, what: string): Extract<Expr, { k: 'lam' }> {
    if (e.k !== 'lam' || e.params.length !== 1) return no(`${what} needs a one-parameter lambda`);
    return e;
  }

  /** map / filter: the lambda is inlined into a loop over the source list. */
  private genMapFilter(e: Extract<Expr, { k: 'call' }>, isMap: boolean): G {
    const name = isMap ? 'map' : 'filter';
    if (e.args.length !== 2 || e.kw.length) no(`${name} expects 2 arguments`);
    const src = this.listArg(e.args[0], name);
    const lam = this.lambda(e.args[1], name);
    const sk = src.lv.kind;
    const outStride = isMap ? 1 : sk.layout.stride;
    const off = this.allocScratch(sk.max * outStride * SLOT, name);
    const p = this.alloc('i32');
    const i = this.alloc('i32');
    const { binding, load } = this.bindElem(src.lv, i);
    this.scopes.push(new Map([[lam.params[0], binding]]));
    let body: G;
    try {
      body = this.scalar(this.gen(lam.body), `${name} lambda result`);
    } finally {
      this.scopes.pop();
    }
    const pre = [...src.c, ...this.baseAddr(off), ...localSet(p)];
    if (isMap) {
      const k = body.kind;
      const outLayout: ElemLayout = { stride: 1, leaves: [{ path: '', kind: k, slot: 0 }], key: `:${showKind(k)}` };
      const store = [...localGet(p), ...localGet(i), ...I32.const(BigInt(SLOT)), I32.mul, I32.add, ...body.c, ...this.toSlot(k), ...i64Store(0)];
      const lv: ListVal = { ptr: p, len: src.lv.len, kind: { t: 'list', layout: outLayout, min: sk.min, max: sk.max } };
      return { c: [...pre, ...this.loop(src.lv.len, i, [...load, ...store])], kind: lv.kind, lv };
    }
    if (body.kind.t !== 'bool') no(`filter lambda must return Bool, got ${showKind(body.kind)}`);
    const j = this.alloc('i32');
    const da = this.alloc('i32');
    const w = BigInt(outStride * SLOT);
    const copy: number[] = [...localGet(p), ...localGet(j), ...I32.const(w), I32.mul, I32.add, ...localSet(da)];
    const srcAddr = [...localGet(src.lv.ptr), ...localGet(i), ...I32.const(w), I32.mul, I32.add];
    for (let k = 0; k < outStride; k++) copy.push(...localGet(da), ...srcAddr, ...i64Load(k * SLOT), ...i64Store(k * SLOT));
    copy.push(...localGet(j), ...I32.const(1n), I32.add, ...localSet(j));
    const lv: ListVal = { ptr: p, len: j, kind: { t: 'list', layout: sk.layout, min: 0, max: sk.max } };
    return {
      c: [...pre, ...I32.const(0n), ...localSet(j), ...this.loop(src.lv.len, i, [...load, ...body.c, OP.if, OP.void, ...copy, OP.end])],
      kind: lv.kind,
      lv,
    };
  }

  private genSum(e: Extract<Expr, { k: 'call' }>): G {
    if (e.args.length !== 1 || e.kw.length) no('sum expects 1 argument');
    const src = this.listArg(e.args[0], 'sum');
    const L = src.lv.kind.layout;
    if (L.stride !== 1 || L.leaves[0].kind.t !== 'int') no(`sum needs a list of Int, got ${showKind(src.lv.kind)}`);
    const acc = this.alloc(this.R.vt);
    const i = this.alloc('i32');
    const elem = [...localGet(src.lv.ptr), ...localGet(i), ...I32.const(BigInt(SLOT)), I32.mul, I32.add, ...i64Load(0), ...this.fromSlot({ t: 'int' })];
    return {
      c: [...src.c, ...this.R.const(0n), ...localSet(acc), ...this.loop(src.lv.len, i, [...localGet(acc), ...elem, this.R.add, ...localSet(acc)]), ...localGet(acc)],
      kind: { t: 'int' },
    };
  }

  private genLen(e: Extract<Expr, { k: 'call' }>): G {
    if (e.args.length !== 1 || e.kw.length) no('len expects 1 argument');
    const src = this.listArg(e.args[0], 'len');
    return { c: [...src.c, ...localGet(src.lv.len), ...(this.R.vt === 'i64' ? [OP.i64ExtendI32U] : [])], kind: { t: 'int' } };
  }

  /** `(list a b c)` of scalars, built in scratch memory. */
  private genListLit(e: Extract<Expr, { k: 'call' }>): G {
    if (e.kw.length) no('keyword arguments to list');
    if (!e.args.length) no('empty (list) has no element type');
    const gs = e.args.map((a) => this.scalar(this.gen(a), 'list element'));
    const k = gs[0].kind;
    for (const g of gs) if (!sameKind(g.kind, k)) no(`list elements differ: ${showKind(k)} vs ${showKind(g.kind)}`);
    const off = this.allocScratch(gs.length * SLOT, 'list');
    const p = this.alloc('i32');
    const n = this.alloc('i32');
    const c = [...this.baseAddr(off), ...localSet(p), ...I32.const(BigInt(gs.length)), ...localSet(n)];
    gs.forEach((g, idx) => c.push(...localGet(p), ...g.c, ...this.toSlot(k), ...i64Store(idx * SLOT)));
    const layout: ElemLayout = { stride: 1, leaves: [{ path: '', kind: k, slot: 0 }], key: `:${showKind(k)}` };
    const lv: ListVal = { ptr: p, len: n, kind: { t: 'list', layout, min: gs.length, max: gs.length } };
    return { c, kind: lv.kind, lv };
  }

  gen(e: Expr): G {
    const R = this.R;
    switch (e.k) {
      case 'int':
        return { c: R.const(e.v), kind: { t: 'int' } };
      case 'bool':
        return { c: I32.const(e.v ? 1n : 0n), kind: { t: 'bool' } };
      case 'str':
        return no('string literal');
      case 'var': {
        const b = this.lookup(e.name);
        if (b) {
          if (b.b === 'list') {
            if (e.path.length) no(`field access .${e.path.join('.')} on list ${e.name}`);
            return { c: [], kind: b.lv.kind, lv: b.lv };
          }
          if (b.b === 'val') {
            if (e.path.length) no(`field access .${e.path.join('.')} on non-record ${e.name}`);
            return { c: localGet(b.local), kind: b.kind };
          }
          const leaf = b.leaves.get(e.path.join('.'));
          if (!leaf) return no(`${e.name}${e.path.length ? '.' + e.path.join('.') : ''} is not a scalar field (whole records are not first-class here)`);
          return { c: localGet(leaf.local), kind: leaf.kind };
        }
        if (!e.path.length) {
          const ec = this.enumCaseIndex(e.name);
          if (ec) return { c: I32.const(BigInt(ec.idx)), kind: ec.kind };
        }
        return no(`unbound or non-scalar name ${e.name}`);
      }
      case 'let': {
        const scope = new Map<string, Binding>();
        this.scopes.push(scope);
        try {
          const pre: number[] = [];
          for (const b of e.binds) {
            const g = this.gen(b.value); // compiled before the name is visible, as in the interpreter
            if (g.kind.t === 'list' && g.lv) {
              pre.push(...g.c);
              scope.set(b.name, { b: 'list', lv: g.lv });
              continue;
            }
            const local = this.alloc(this.vtOf(g.kind));
            pre.push(...g.c, ...localSet(local));
            scope.set(b.name, { b: 'val', local, kind: g.kind });
          }
          const body = this.seq(e.body);
          return { ...body, c: [...pre, ...body.c] };
        } finally {
          this.scopes.pop();
        }
      }
      case 'do':
        return this.seq(e.body);
      case 'if': {
        const c = this.bool(this.gen(e.cond), 'if condition');
        const t = this.gen(e.then);
        const f = this.gen(e.else);
        this.scalar(t, 'if branch');
        this.scalar(f, 'if branch');
        if (!sameKind(t.kind, f.kind)) no(`if branches differ: ${showKind(t.kind)} vs ${showKind(f.kind)}`);
        return { c: [...c, OP.if, blockType(this.vtOf(t.kind)), ...t.c, OP.else, ...f.c, OP.end], kind: t.kind };
      }
      case 'match':
        return this.genMatch(e);
      case 'lam':
        return no('lambda');
      case 'try':
        return no('try (Result / early return)');
      case 'call':
        return this.genCall(e);
    }
  }

  /** Sequence of pure expressions: earlier ones are compiled and dropped, the last is the value. */
  private seq(es: Expr[]): G {
    const gs = es.map((x) => this.gen(x));
    const drops = gs.slice(0, -1).flatMap((g) => (g.kind.t === 'list' ? g.c : [...g.c, 0x1a]));
    return { ...gs[gs.length - 1], c: [...drops, ...gs[gs.length - 1].c] };
  }

  private genMatch(e: Extract<Expr, { k: 'match' }>): G {
    const s = this.gen(e.scrut);
    if (s.kind.t !== 'enum') return no(`match on ${showKind(s.kind)} (only enums are supported)`);
    const cases = s.kind.cases;
    const seen = new Set<string>();
    const arms = e.arms
      .filter((a) => {
        if (!cases.includes(a.tag)) no(`match arm ${a.tag} is not a case of ${showKind(s.kind)}`);
        if (a.bind !== null) no(`match arm ${a.tag} binds a payload, but enum cases carry none`);
        if (seen.has(a.tag)) return false; // first arm wins, as in the interpreter
        seen.add(a.tag);
        return true;
      })
      .map((a) => ({ idx: cases.indexOf(a.tag), g: this.gen(a.body) }));
    if (seen.size !== cases.length) no(`non-exhaustive match (missing ${cases.filter((c) => !seen.has(c)).join(', ')})`);
    const kind = arms[0].g.kind;
    for (const a of arms) this.scalar(a.g, 'match arm');
    for (const a of arms) if (!sameKind(a.g.kind, kind)) no(`match arms differ: ${showKind(kind)} vs ${showKind(a.g.kind)}`);
    const tmp = this.alloc('i32');
    const bt = blockType(this.vtOf(kind));
    const chain = (i: number): number[] =>
      i === arms.length - 1 ? arms[i].g.c : [...localGet(tmp), ...I32.const(BigInt(arms[i].idx)), I32.eq, OP.if, bt, ...arms[i].g.c, OP.else, ...chain(i + 1), OP.end];
    return { c: [...s.c, ...localSet(tmp), ...chain(0)], kind };
  }

  /** Direct call to another compiled Sigil function. Ints are converted between the two functions' widths. */
  private genUserCall(e: Extract<Expr, { k: 'call' }>): G {
    const info = this.callee(e.fn);
    if (typeof info === 'string') return no(`calls ${e.fn}, which is not compilable: ${info}`);
    if (e.kw.length) return no(`keyword arguments to ${e.fn}`);
    if (e.args.length !== info.params.length) return no(`${e.fn} expects ${info.params.length} argument(s)`);
    // The checker has proved each argument lies in the callee's parameter range, so narrowing is lossless.
    const conv = (from: ValType, to: ValType): number[] => (from === to ? [] : from === 'i64' ? [OP.i32WrapI64] : [OP.i64ExtendI32S]);
    const c: number[] = [];
    e.args.forEach((a, i) => {
      const g = this.gen(a);
      if (!sameKind(g.kind, info.params[i])) no(`argument ${i + 1} of ${e.fn} is ${showKind(g.kind)}, expected ${showKind(info.params[i])}`);
      if (g.kind.t === 'list') {
        // The callee sizes its scratch from its own parameter maximum, so the argument must not be longer.
        const want = info.params[i] as Extract<Kind, { t: 'list' }>;
        if (g.kind.max > want.max) no(`argument ${i + 1} of ${e.fn} may have up to ${g.kind.max} elements but the parameter allows ${want.max}`);
        c.push(...g.c, ...localGet(g.lv!.ptr), ...localGet(g.lv!.len));
      } else {
        c.push(...g.c, ...(g.kind.t === 'int' ? conv(this.R.vt, info.vt) : []));
      }
    });
    if (info.hasBase) {
      if (this.baseLocal < 0) no('internal: caller has no scratch base');
      c.push(...this.baseAddr(this.frame)); // callee scratch starts after everything allocated so far
      this.need = Math.max(this.need, this.frame + info.need);
      if (MEM_BASE + this.need > MAX_MEMORY_BYTES) no(`call to ${e.fn}: scratch of ${this.need} bytes exceeds the ${MAX_MEMORY_BYTES} byte limit`);
    }
    c.push(OP.call, ...uleb(info.index));
    if (info.result.t === 'int') c.push(...conv(info.vt, this.R.vt));
    return { c, kind: info.result };
  }

  private genCall(e: Extract<Expr, { k: 'call' }>): G {
    const R = this.R;
    const name = e.fn;
    if (name in CAP_OPS) return no(`capability operation ${name}`);
    if (this.prog.types.has(name)) return no(`record construction ${name}`);
    if (this.prog.fns.has(name)) return this.genUserCall(e);
    if (e.kw.length) return no(`keyword arguments to ${name}`);
    const need = (n: number) => {
      if (e.args.length !== n) no(`${name} expects ${n} argument(s)`);
    };
    const INT: Kind = { t: 'int' };
    const BOOL: Kind = { t: 'bool' };

    switch (name) {
      case 'map':
        return this.genMapFilter(e, true);
      case 'filter':
        return this.genMapFilter(e, false);
      case 'sum':
        return this.genSum(e);
      case 'fold':
        return no('fold (not yet supported by the Wasm backend)');
      case 'len':
        return this.genLen(e);
      case 'list':
        return this.genListLit(e);
      case 'add':
      case 'sub':
      case 'mul': {
        need(2);
        const a = this.int(this.gen(e.args[0]), name);
        const b = this.int(this.gen(e.args[1]), name);
        return { c: [...a, ...b, name === 'add' ? R.add : name === 'sub' ? R.sub : R.mul], kind: INT };
      }
      case 'neg': {
        need(1);
        const a = this.int(this.gen(e.args[0]), name);
        return { c: [...R.const(0n), ...a, R.sub], kind: INT };
      }
      case 'div-floor':
      case 'min':
      case 'max': {
        need(2);
        const a = this.int(this.gen(e.args[0]), name);
        const b = this.int(this.gen(e.args[1]), name);
        const tx = this.alloc(R.vt);
        const ty = this.alloc(R.vt);
        const prefix = [...a, ...b, ...localSet(ty), ...localSet(tx)];
        const x = localGet(tx);
        const y = localGet(ty);
        if (name === 'min') return { c: [...prefix, ...x, ...y, ...x, ...y, R.ltS, OP.select], kind: INT };
        if (name === 'max') return { c: [...prefix, ...x, ...y, ...x, ...y, R.gtS, OP.select], kind: INT };
        // div-floor. The checker has proved the divisor is non-zero and |x| < 2^(w-1), so neither
        // the zero-divide trap nor the INT_MIN / -1 trap can occur. div_s truncates toward zero;
        // floor = trunc - 1 when the remainder is non-zero and its sign differs from the divisor's.
        if (this.opts.divMode === 'trunc') return { c: [...prefix, ...x, ...y, R.divS], kind: INT };
        const tr = this.alloc(R.vt);
        const r = localGet(tr);
        const flag = [...r, ...R.const(0n), R.ne, ...r, ...y, R.xor, ...R.const(0n), R.ltS, I32.and];
        return {
          c: [...prefix, ...x, ...y, R.divS, ...x, ...y, R.remS, ...localSet(tr), ...flag, ...(R.vt === 'i64' ? [OP.i64ExtendI32U] : []), R.sub],
          kind: INT,
        };
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        if (e.args.length !== 2) return no(`${name} with ${e.args.length} arguments (only binary comparison is supported)`);
        const a = this.int(this.gen(e.args[0]), name);
        const b = this.int(this.gen(e.args[1]), name);
        return { c: [...a, ...b, name === '<' ? R.ltS : name === '<=' ? R.leS : name === '>' ? R.gtS : R.geS], kind: BOOL };
      }
      case '=': {
        need(2);
        const a = this.scalar(this.gen(e.args[0]), '=');
        const b = this.scalar(this.gen(e.args[1]), '=');
        if (!sameKind(a.kind, b.kind)) return no(`= on ${showKind(a.kind)} and ${showKind(b.kind)}`);
        return { c: [...a.c, ...b.c, a.kind.t === 'int' ? R.eq : I32.eq], kind: BOOL };
      }
      case 'not': {
        need(1);
        return { c: [...this.bool(this.gen(e.args[0]), 'not'), I32.eqz], kind: BOOL };
      }
      case 'and':
      case 'or': {
        // Operands are pure and cannot trap, so non-short-circuit evaluation is equivalent.
        if (!e.args.length) return { c: I32.const(name === 'and' ? 1n : 0n), kind: BOOL };
        const parts = e.args.map((a) => this.bool(this.gen(a), name));
        const c = [...parts[0]];
        for (const p of parts.slice(1)) c.push(...p, name === 'and' ? I32.and : I32.or);
        return { c, kind: BOOL };
      }
      default:
        return no(`uses ${name}, which is outside the compiled subset (strings, Results and text builtins are not supported)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-function and per-program drivers
// ---------------------------------------------------------------------------

function compileFn(prog: Program, f: FnDef, ev: FnEvidence, res: CheckResult, opts: CompileOptions, callee: CalleeResolver): { report: FnReport; func?: WasmFunc } {
  const report: FnReport = { name: f.name, compilable: false, checkerRepr: ev.repr };
  try {
    if (f.needs.length) no(`uses capabilities/effects (needs ${f.needs.join(', ')})`);
    if (f.requires.length) no('has requires clauses, which the backend does not enforce');
    const errs = res.diags.filter((d) => d.level === 'error' && d.fn === f.name);
    if (errs.length) no(`checker reports errors (${errs[0].code})`);
    for (const o of ev.obligations) {
      if (o.kind === 'ensures') {
        if (o.status === 'failed') no(`ensures is refuted by the checker: ${o.desc}`);
      } else if (o.status !== 'proved') no(`obligation not proved by the checker: ${o.desc}`);
    }

    const params: ParamSpec[] = f.params.map((p) => {
      const r = resolveType(prog, p.type);
      // A list parameter is a single leaf of kind list, passed as (ptr, len).
      if (r.k === 'list') return { name: p.name, type: p.type, leaves: [{ path: '', kind: listKind(prog, r, `param ${p.name}`) }] };
      return { name: p.name, type: p.type, leaves: leavesOf(prog, p.type, '', `param ${p.name}`) };
    });
    const result = kindOfType(prog, f.out, 'result');

    // Representation: the checker's derived repr, widened if its tracked intermediates did not
    // cover parameters or literals (it only tracks arithmetic results).
    const mags: bigint[] = [];
    for (const p of params) for (const l of p.leaves) if (l.lo !== undefined) mags.push(l.lo < 0n ? -l.lo : l.lo, l.hi! < 0n ? -l.hi! : l.hi!);
    const lits: bigint[] = [];
    literals(f.body, lits);
    for (const v of lits) mags.push(v < 0n ? -v : v);
    const mine = reprFor(mags.reduce((a, b) => (a > b ? a : b), 0n));
    if (ev.repr === 'bigint' || mine === 'bigint') no('needs bigint representation (exceeds i64)');
    // A caller is at least as wide as its callees, so a callee's result always fits the caller.
    let calleeWide = false;
    let calleeBase = false;
    for (const name of calledFns(prog, f.body)) {
      const info = callee(name);
      if (typeof info === 'string') no(`calls ${name}, which is not compilable: ${info}`);
      else {
        if (info.vt === 'i64') calleeWide = true;
        if (info.hasBase) calleeBase = true;
      }
    }
    let usesListOps = false;
    walk(f.body, (x) => {
      if (x.k === 'call' && ['map', 'filter', 'sum', 'len', 'list'].includes(x.fn) && !prog.fns.has(x.fn)) usesListOps = true;
    });
    const hasList = params.some((p) => p.leaves.some((l) => l.kind.t === 'list'));
    const hasBase = hasList || usesListOps || calleeBase;
    const used: 'i32' | 'i64' = ev.repr === 'i64' || mine === 'i64' || calleeWide ? 'i64' : 'i32';
    if (used !== ev.repr) report.widenedFromChecker = `checker derived ${ev.repr}, but parameter ranges or literals need ${used}`;
    report.repr = used;
    const R = used === 'i64' ? I64 : I32;

    const g = new FnGen(prog, R, opts, callee);
    const top = new Map<string, Binding>();
    const ptypes: ValType[] = [];
    for (const p of params) {
      const isRec = resolveType(prog, p.type).k === 'rec';
      const leaves = new Map<string, { local: number; kind: Kind }>();
      if (p.leaves.length === 1 && p.leaves[0].kind.t === 'list') {
        const kind = p.leaves[0].kind;
        top.set(p.name, { b: 'list', lv: { ptr: ptypes.length, len: ptypes.length + 1, kind } });
        ptypes.push('i32', 'i32');
        continue;
      }
      for (const l of p.leaves) {
        leaves.set(l.path, { local: ptypes.length, kind: l.kind });
        ptypes.push(l.kind.t === 'int' ? R.vt : 'i32');
      }
      top.set(p.name, isRec ? { b: 'rec', leaves } : { b: 'val', local: leaves.get('')!.local, kind: leaves.get('')!.kind });
    }
    if (hasBase) {
      g.baseLocal = ptypes.length;
      ptypes.push('i32');
    }
    g.nParams = ptypes.length;
    g.scopes.push(top);
    const body = g.gen(f.body);
    if (!sameKind(body.kind, result)) no(`body is ${showKind(body.kind)} but declared result is ${showKind(result)}`);

    let inputBytes = 0;
    for (const p of params) for (const l of p.leaves) if (l.kind.t === 'list') inputBytes += l.kind.max * l.kind.layout.stride * SLOT;
    if (hasBase && MEM_BASE + inputBytes + g.need > MAX_MEMORY_BYTES) no(`memory for inputs (${inputBytes}) and scratch (${g.need}) exceeds the ${MAX_MEMORY_BYTES} byte limit`);
    if (hasBase) Object.assign(report, { hasBase: true, inputBytes, scratchBytes: g.need });
    report.params = params;
    report.result = result;
    report.compilable = true;
    return { report, func: { name: f.name, params: ptypes, result: result.t === 'int' ? R.vt : 'i32', locals: g.locals, body: body.c } };
  } catch (e) {
    if (e instanceof NotCompilable) {
      report.reason = e.message;
      return { report };
    }
    throw e;
  }
}

function calledFns(prog: Program, e: Expr, out = new Set<string>()): Set<string> {
  switch (e.k) {
    case 'call':
      if (prog.fns.has(e.fn)) out.add(e.fn);
      e.args.forEach((a) => calledFns(prog, a, out));
      e.kw.forEach((a) => calledFns(prog, a.value, out));
      break;
    case 'let':
      e.binds.forEach((b) => calledFns(prog, b.value, out));
      e.body.forEach((b) => calledFns(prog, b, out));
      break;
    case 'match':
      calledFns(prog, e.scrut, out);
      e.arms.forEach((a) => calledFns(prog, a.body, out));
      break;
    case 'if':
      calledFns(prog, e.cond, out);
      calledFns(prog, e.then, out);
      calledFns(prog, e.else, out);
      break;
    case 'lam':
      calledFns(prog, e.body, out);
      break;
    case 'do':
      e.body.forEach((b) => calledFns(prog, b, out));
      break;
    case 'try':
      calledFns(prog, e.expr, out);
      break;
  }
  return out;
}

export function compileProgram(prog: Program, res: CheckResult, opts: CompileOptions = {}): CompileResult {
  const funcs: WasmFunc[] = [];
  const done = new Map<string, { report: FnReport; index?: number }>();
  const active = new Set<string>();

  // Callees are compiled before their callers, so a callee's function index is known at the call site.
  const ensure = (name: string): { report: FnReport; index?: number } => {
    const hit = done.get(name);
    if (hit) return hit;
    const f = prog.fns.get(name)!;
    const ev = res.evidence.get(name);
    let out: { report: FnReport; index?: number };
    if (active.has(name)) {
      // recursion: report on the caller side, do not memoize a half-built entry
      return { report: { name, compilable: false, reason: 'recursive call', checkerRepr: 'bigint' } };
    }
    if (!ev) {
      out = { report: { name, compilable: false, reason: 'no checker evidence', checkerRepr: 'bigint' } };
    } else {
      active.add(name);
      try {
        const { report, func } = compileFn(prog, f, ev, res, opts, callee);
        out = { report };
        if (func) {
          out.index = funcs.length;
          funcs.push(func);
        }
      } finally {
        active.delete(name);
      }
    }
    done.set(name, out);
    return out;
  };

  const callee: CalleeResolver = (name) => {
    const r = ensure(name);
    const rep = r.report;
    if (!rep.compilable || r.index === undefined) return rep.reason ?? 'not compilable';
    const params: Kind[] = [];
    for (const p of rep.params!) {
      if (p.leaves.length !== 1 || p.leaves[0].path !== '') return `parameter ${p.name} is a record (record arguments are not supported across calls)`;
      params.push(p.leaves[0].kind);
    }
    return { index: r.index, vt: rep.repr!, params, result: rep.result!, hasBase: !!rep.hasBase, need: rep.scratchBytes ?? 0 };
  };

  for (const f of prog.fns.values()) ensure(f.name);
  const fns = [...prog.fns.keys()].map((n) => done.get(n)!.report);
  let memBytes = 0;
  for (const r of fns) if (r.compilable && r.hasBase) memBytes = Math.max(memBytes, MEM_BASE + r.inputBytes! + r.scratchBytes!);
  const memPages = memBytes ? Math.ceil(memBytes / 65536) : undefined;
  return { bytes: buildModule(funcs, memPages), fns, memPages };
}
