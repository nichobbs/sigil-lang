// Wasm backend for Sigil.
//
// Values are flattened into Wasm "leaves" (see shape.ts): scalars are one leaf, records are the concatenation of their
// fields, a Result is a tag leaf plus the leaves of both payloads, a list is a (ptr, len) pair into linear memory.
// Functions take their parameters' leaves and return their result's leaves with multi-value returns.
//
// Lists: elements are fixed-stride arrays of 8-byte slots (one per scalar leaf). len, sum, map, filter and `list`
// compile to loops over memory with the lambda inlined. Scratch memory is laid out statically from the list types'
// declared maximum lengths (no dynamic allocation); a list returned from a function lives in the callee's scratch,
// which the caller then reserves.
//
// Scope (everything else is reported "not compilable" with a reason, never miscompiled):
//   types    : ranged Int, Bool, enum, Unit, records, Result, lists of scalars/records (no nested lists)
//   body     : literals, variables and field reads, let/do, if, match on enums and Results, `try ... :on-err`,
//              record construction, (ok e) (err e), calls to compiled functions, map filter sum len list,
//              add sub mul div-floor neg min max, = < <= > >=, and or not (short-circuit, as in the interpreter)
//   function must have: no `requires`, no checker errors, every non-`ensures` obligation proved by the interval
//   analysis (so overflow and zero-divisor are excluded).
//
// The point of the exercise: the checker has already proved there is no overflow and no zero
// divisor, so the emitted code is plain wrapping i32/i64 arithmetic with NO checks.
// (`ensures` clauses are specifications; they are not emitted.)

import { Expr, FnDef, Program, asDeclassify, resolveType } from '../ast.js';
import { CAP_OPS } from '../caps.js';
import { CheckResult, FnEvidence } from '../check.js';
import { Repr, reprFor } from '../interval.js';
import { I32, I64, IntOps, OP, TypeTable, ValType, WasmFunc, WasmImport, blockTypeOf, buildModule, call, i64Load, i64Store, localGet, localSet } from './encode.js';
import {
  ElemLayout, Kind, ListShape, MAX_MEMORY_BYTES, MEM_BASE, NotCompilable, SLOT, Scalar, Shape, flatLeaves, intLeaves, layoutOf, listsOf, magnitudes, nleaves, no, sameShape, shapeOf, showShape, wtypes,
} from './shape.js';

export type { ElemLayout, Kind, Shape };
export { MAX_MEMORY_BYTES, MEM_BASE, SLOT };

export interface Leaf {
  path: string; // '' for a scalar parameter, else 'field' or 'field.sub' (Result sides: '#tag', 'ok', 'err')
  kind: Shape;
  lo?: bigint;
  hi?: bigint;
}
export interface ParamSpec {
  name: string;
  type: import('../ast.js').Type;
  shape: Shape;
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
  result?: Shape;
  hasBase?: boolean; // takes a trailing i32 scratch-base parameter and uses linear memory
  inputBytes?: number; // bytes reserved for list parameters (from MEM_BASE), at their declared maximum lengths
  scratchBytes?: number; // statically bounded scratch needed above the inputs (including callees)
  entry?: boolean; // listed in a `program` entry form
  needs?: string[]; // capability handles the function (and its callees) use
}

export interface CompileOptions {
  /** Test hook for mutation testing the compiler itself: 'trunc' emits plain div_s (WRONG for negatives). */
  divMode?: 'floor' | 'trunc';
  /** Test hook: deliberately miscompile one construct, so the differential tests can be shown to catch it. */
  mutation?: 'tag-flip' | 'try-fallthrough' | 'result-arms-swapped' | 'str-eq-true' | 'put-flag-inverted' | 'effect-order-swapped' | 'emit-dropped';
}

export interface CompileResult {
  bytes: Uint8Array;
  fns: FnReport[];
  memPages?: number; // 64KiB pages of the exported "memory" (only when some function uses memory)
  entries: string[]; // compiled functions listed in a `program` entry form
  abi: AbiDescriptor;
}

/** Self-describing ABI data; also embedded in the module as the custom section `sigil.abi` (JSON). */
export interface AbiDescriptor {
  version: 1;
  /** String literal table: literal i is host string handle i + 1 (handle 0 is the empty string). */
  strings: string[];
  /** Capability handle table: the first argument of a host effect import is an index into this list. */
  handles: string[];
  /** Host effect imports (module "host"), one per distinct operation and argument shape. */
  effects: EffectDesc[];
}
export interface EffectDesc {
  import: string;
  op: string; // put | post | emit | fresh
  args: Shape[]; // shapes of the arguments after the handle; their leaves are the import's parameters
}

/** What a caller needs to know about a compiled callee. */
export interface Callee {
  index: number; // position among the module's defined functions
  vt: ValType; // int representation of the callee
  params: Shape[];
  result: Shape;
  hasBase: boolean;
  need: number; // scratch bytes the callee uses above its base
}
export type CalleeResolver = (name: string) => Callee | string; // string = reason it cannot be called

/** The function needs scratch memory (and so a trailing base parameter): compile it again with one. */
class NeedBase extends Error {}

const FEATURES = { effects: false };
const SHAPE_OPTS = { strings: true };

// ---------------------------------------------------------------------------
// Module-level registries shared by all functions of one compilation
// ---------------------------------------------------------------------------

interface ImportReg {
  desc: WasmImport;
  effect?: EffectDesc;
  used: boolean;
}
class Registry {
  imports: ImportReg[] = [];
  strings: string[] = []; // string literal i is host handle i + 1
  enumBlocks = new Map<string, number>(); // enum cases registered as consecutive literals: first handle
  handles: string[] = [];
  /** Pass 2: the import set is fixed, so nothing may be added. */
  constructor(public frozen = false) {}
  importIndex(name: string): number {
    return this.imports.findIndex((i) => i.desc.name === name);
  }
  literal(s: string): number {
    if (s === '') return 0;
    let i = this.strings.indexOf(s);
    if (i < 0) {
      i = this.strings.length;
      this.strings.push(s);
    }
    return i + 1;
  }
  /** Handle of the first of `cases.length` consecutive literals holding the case names. */
  enumBlock(cases: string[]): number {
    const key = cases.join('|');
    let h = this.enumBlocks.get(key);
    if (h === undefined) {
      h = this.strings.length + 1;
      this.strings.push(...cases);
      this.enumBlocks.set(key, h);
    }
    return h;
  }
}
interface Ctx {
  types: TypeTable;
  reg: Registry;
  importBase: number;
}

// ---------------------------------------------------------------------------
// Expression walk helpers
// ---------------------------------------------------------------------------

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
// Code generation for one function
// ---------------------------------------------------------------------------

/** A generated value: code that leaves all of the value's leaves on the stack, and its shape. */
interface G {
  c: number[];
  shape: Shape;
}
/** A named value: one local per leaf. */
interface Binding {
  shape: Shape;
  locals: number[];
}
interface ListLocals {
  ptr: number;
  len: number;
  shape: ListShape;
}

class FnGen {
  locals: ValType[] = [];
  scopes: Map<string, Binding>[] = [];
  nParams = 0;
  baseLocal = -1; // i32 scratch base (trailing parameter), when the function uses memory
  frame = 0; // bytes of scratch allocated so far (static offsets from the base)
  need = 0; // max scratch bytes needed, including callees
  retShape: Shape = { t: 'unit' };
  touched = new Set<string>(); // host imports this function uses
  constructor(
    protected prog: Program,
    protected R: IntOps,
    protected opts: CompileOptions,
    protected callee: CalleeResolver,
    protected ctx: Ctx,
  ) {}

  alloc(vt: ValType): number {
    this.locals.push(vt);
    return this.nParams + this.locals.length - 1;
  }

  // --- leaves -------------------------------------------------------------------
  protected wt(s: Shape): ValType[] {
    return wtypes(s, this.R.vt);
  }
  protected bt(s: Shape): number[] {
    return blockTypeOf(this.wt(s), this.ctx.types);
  }
  protected allocLeaves(s: Shape): number[] {
    return this.wt(s).map((t) => this.alloc(t));
  }
  /** Pop the leaves on the stack into these locals (the last leaf is on top). */
  protected setAll(locals: number[]): number[] {
    const c: number[] = [];
    for (let i = locals.length - 1; i >= 0; i--) c.push(...localSet(locals[i]));
    return c;
  }
  protected getAll(locals: number[]): number[] {
    return locals.flatMap((l) => localGet(l));
  }
  protected dropAll(s: Shape): number[] {
    return Array.from({ length: nleaves(s) }, () => OP.drop);
  }
  protected zero(s: Shape): number[] {
    return this.wt(s).flatMap((t) => (t === 'i64' ? I64.const(0n) : I32.const(0n)));
  }
  protected spill(g: G): { c: number[]; locals: number[] } {
    const locals = this.allocLeaves(g.shape);
    return { c: [...g.c, ...this.setAll(locals)], locals };
  }
  /** Narrow a binding to a (possibly nested) record field. */
  protected select(b: Binding, path: string[], what: string): Binding {
    let { shape, locals } = b;
    for (const seg of path) {
      if (shape.t !== 'rec') return no(`field access .${seg} on non-record ${what}`);
      let off = 0;
      let found = false;
      for (const f of shape.fields) {
        const n = nleaves(f.shape);
        if (f.name === seg) {
          shape = f.shape;
          locals = locals.slice(off, off + n);
          found = true;
          break;
        }
        off += n;
      }
      if (!found) return no(`no field ${what}.${seg} (a Str field of a list element is not stored)`);
    }
    return { shape, locals };
  }

  protected lookup(name: string): Binding | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const b = this.scopes[i].get(name);
      if (b) return b;
    }
    return undefined;
  }

  private enumCaseIndex(name: string): { shape: Shape; idx: number } | undefined {
    const hits: string[][] = [];
    for (const t of this.prog.types.values()) {
      if (t.k === 'enum' && t.cases.includes(name) && !hits.some((h) => h.length === t.cases.length && h.every((c, i) => c === t.cases[i]))) hits.push(t.cases);
    }
    if (hits.length > 1) return no(`enum case ${name} belongs to more than one enum type (ambiguous)`);
    return hits.length ? { shape: { t: 'enum', cases: hits[0] }, idx: hits[0].indexOf(name) } : undefined;
  }

  protected int(g: G, what: string): number[] {
    if (g.shape.t !== 'int') no(`${what}: expected Int, got ${showShape(g.shape)}`);
    return g.c;
  }
  protected bool(g: G, what: string): number[] {
    if (g.shape.t !== 'bool') no(`${what}: expected Bool, got ${showShape(g.shape)}`);
    return g.c;
  }

  // --- scratch memory --------------------------------------------------------------
  /** Reserve `bytes` of scratch at a static offset from the base; returns that offset. */
  protected allocScratch(bytes: number, what: string): number {
    if (this.baseLocal < 0) throw new NeedBase();
    const off = this.frame;
    this.frame += bytes;
    this.need = Math.max(this.need, this.frame);
    if (MEM_BASE + this.need > MAX_MEMORY_BYTES) no(`${what}: scratch of ${this.need} bytes exceeds the ${MAX_MEMORY_BYTES} byte limit`);
    return off;
  }
  protected baseAddr(off: number): number[] {
    return [...localGet(this.baseLocal), ...I32.const(BigInt(off)), I32.add];
  }

  /** Convert a value of the slot kind on the stack to its 8-byte slot form (i64). */
  protected toSlot(k: Scalar): number[] {
    return k.t === 'int' ? (this.R.vt === 'i64' ? [] : [OP.i64ExtendI32S]) : [OP.i64ExtendI32U];
  }
  /** Convert an i64 slot value on the stack to the function's representation of `k`. */
  protected fromSlot(k: Scalar): number[] {
    return k.t === 'int' && this.R.vt === 'i64' ? [] : [OP.i32WrapI64];
  }

  /** `for i in 0..len { body }` */
  protected loop(len: number, i: number, body: number[]): number[] {
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

  /** Address of element `i` of a list: ptr + i * stride * 8. */
  protected elemAddr(ptr: number, i: number, stride: number): number[] {
    return [...localGet(ptr), ...localGet(i), ...I32.const(BigInt(stride * SLOT)), I32.mul, I32.add];
  }

  /** Bind a lambda parameter to the element at index `i`; returns the binding and the code that loads it. */
  protected bindElem(lv: ListLocals, i: number): { binding: Binding; load: number[] } {
    const L = lv.shape.layout;
    const ea = this.alloc('i32');
    const load: number[] = [...this.elemAddr(lv.ptr, i, L.stride), ...localSet(ea)];
    const locals: number[] = [];
    for (const l of L.leaves) {
      const local = this.alloc(l.kind.t === 'int' ? this.R.vt : 'i32');
      load.push(...localGet(ea), ...i64Load(l.slot * SLOT), ...this.fromSlot(l.kind), ...localSet(local));
      locals.push(local);
    }
    return { binding: { shape: L.elem, locals }, load };
  }

  /** Store a spilled element value (locals, one per layout leaf) at the address held in local `addr`. */
  protected storeElem(addr: number, layout: ElemLayout, vals: number[], slotBase = 0): number[] {
    const c: number[] = [];
    layout.leaves.forEach((l, k) => c.push(...localGet(addr), ...localGet(vals[k]), ...this.toSlot(l.kind), ...i64Store((slotBase + l.slot) * SLOT)));
    return c;
  }

  protected listArg(e: Expr, what: string): { c: number[]; lv: ListLocals } {
    const g = this.gen(e);
    if (g.shape.t !== 'list') return no(`${what}: expected a list, got ${showShape(g.shape)}`);
    const sp = this.spill(g);
    return { c: sp.c, lv: { ptr: sp.locals[0], len: sp.locals[1], shape: g.shape } };
  }

  protected lambda(e: Expr, n: number, what: string): Extract<Expr, { k: 'lam' }> {
    if (e.k !== 'lam' || e.params.length !== n) return no(`${what} needs a ${n}-parameter lambda`);
    return e;
  }

  protected withScope<T>(m: Map<string, Binding>, f: () => T): T {
    this.scopes.push(m);
    try {
      return f();
    } finally {
      this.scopes.pop();
    }
  }

  /** map / filter: the lambda is inlined into a loop over the source list. */
  private genMapFilter(e: Extract<Expr, { k: 'call' }>, isMap: boolean): G {
    const name = isMap ? 'map' : 'filter';
    if (e.args.length !== 2 || e.kw.length) no(`${name} expects 2 arguments`);
    const src = this.listArg(e.args[0], name);
    const lam = this.lambda(e.args[1], 1, name);
    const sk = src.lv.shape;
    const p = this.alloc('i32');
    const i = this.alloc('i32');
    const { binding, load } = this.bindElem(src.lv, i);
    // filter copies whole elements, so its output can be reserved before the body is generated
    const fOff = isMap ? 0 : this.allocScratch(sk.max * sk.layout.stride * SLOT, name);
    const body = this.withScope(new Map([[lam.params[0], binding]]), () => this.gen(lam.body));
    if (isMap) {
      const layout = layoutOf(body.shape, 'map lambda result');
      // The output goes above everything the body (and its callees) may use, so it is never overwritten per iteration.
      this.frame = Math.max(this.frame, this.need);
      const off = this.allocScratch(sk.max * layout.stride * SLOT, name);
      const vals = this.allocLeaves(body.shape);
      const ea = this.alloc('i32');
      const store = [...body.c, ...this.setAll(vals), ...this.elemAddr(p, i, layout.stride), ...localSet(ea), ...this.storeElem(ea, layout, vals)];
      const out: ListShape = { t: 'list', layout, min: sk.min, max: sk.max };
      return { c: [...src.c, ...this.baseAddr(off), ...localSet(p), ...this.loop(src.lv.len, i, [...load, ...store]), ...localGet(p), ...localGet(src.lv.len)], shape: out };
    }
    if (body.shape.t !== 'bool') no(`filter lambda must return Bool, got ${showShape(body.shape)}`);
    const off = fOff;
    const j = this.alloc('i32');
    const da = this.alloc('i32');
    const L = sk.layout;
    const copy: number[] = [...this.elemAddr(p, j, L.stride), ...localSet(da)];
    for (let k = 0; k < L.stride; k++) copy.push(...localGet(da), ...this.elemAddr(src.lv.ptr, i, L.stride), ...i64Load(k * SLOT), ...i64Store(k * SLOT));
    copy.push(...localGet(j), ...I32.const(1n), I32.add, ...localSet(j));
    const out: ListShape = { t: 'list', layout: L, min: 0, max: sk.max };
    return {
      c: [...src.c, ...this.baseAddr(off), ...localSet(p), ...I32.const(0n), ...localSet(j), ...this.loop(src.lv.len, i, [...load, ...body.c, OP.if, OP.void, ...copy, OP.end]), ...localGet(p), ...localGet(j)],
      shape: out,
    };
  }

  private genSum(e: Extract<Expr, { k: 'call' }>): G {
    if (e.args.length !== 1 || e.kw.length) no('sum expects 1 argument');
    const src = this.listArg(e.args[0], 'sum');
    const L = src.lv.shape.layout;
    if (L.elem.t !== 'int') no(`sum needs a list of Int, got ${showShape(src.lv.shape)}`);
    const acc = this.alloc(this.R.vt);
    const i = this.alloc('i32');
    const elem = [...this.elemAddr(src.lv.ptr, i, 1), ...i64Load(0), ...this.fromSlot({ t: 'int' })];
    return {
      c: [...src.c, ...this.R.const(0n), ...localSet(acc), ...this.loop(src.lv.len, i, [...localGet(acc), ...elem, this.R.add, ...localSet(acc)]), ...localGet(acc)],
      shape: { t: 'int' },
    };
  }

  private genLen(e: Extract<Expr, { k: 'call' }>): G {
    if (e.args.length !== 1 || e.kw.length) no('len expects 1 argument');
    const src = this.listArg(e.args[0], 'len');
    return { c: [...src.c, ...localGet(src.lv.len), ...(this.R.vt === 'i64' ? [OP.i64ExtendI32U] : [])], shape: { t: 'int' } };
  }

  /** `(list a b c)` of scalars or records, built in scratch memory. */
  private genListLit(e: Extract<Expr, { k: 'call' }>): G {
    if (e.kw.length) no('keyword arguments to list');
    if (!e.args.length) no('empty (list) has no element type');
    const gs = e.args.map((a) => this.gen(a));
    const sh = gs[0].shape;
    for (const g of gs) if (!sameShape(g.shape, sh)) no(`list elements differ: ${showShape(sh)} vs ${showShape(g.shape)}`);
    const layout = layoutOf(sh, 'list element');
    const off = this.allocScratch(gs.length * layout.stride * SLOT, 'list');
    const p = this.alloc('i32');
    const n = this.alloc('i32');
    const c = [...this.baseAddr(off), ...localSet(p), ...I32.const(BigInt(gs.length)), ...localSet(n)];
    gs.forEach((g, idx) => {
      const sp = this.spill(g);
      c.push(...sp.c, ...this.storeElem(p, layout, sp.locals, idx * layout.stride));
    });
    c.push(...localGet(p), ...localGet(n));
    return { c, shape: { t: 'list', layout, min: gs.length, max: gs.length } };
  }

  // --- expressions ---------------------------------------------------------------
  /** `expect` is the shape the context requires (needed for `(ok e)` / `(err e)`, whose other side is not inferable). */
  gen(e: Expr, expect?: Shape): G {
    const R = this.R;
    switch (e.k) {
      case 'int':
        return { c: R.const(e.v), shape: { t: 'int' } };
      case 'bool':
        return { c: I32.const(e.v ? 1n : 0n), shape: { t: 'bool' } };
      case 'str':
        return this.genStr(e.v);
      case 'var': {
        const b = this.lookup(e.name);
        if (b) {
          const s = this.select(b, e.path, e.name);
          return { c: this.getAll(s.locals), shape: s.shape };
        }
        if (!e.path.length) {
          const ec = this.enumCaseIndex(e.name);
          if (ec) return { c: I32.const(BigInt(ec.idx)), shape: ec.shape };
        }
        return no(`unbound name ${e.name}${e.path.length ? '.' + e.path.join('.') : ''}`);
      }
      case 'let': {
        const scope = new Map<string, Binding>();
        return this.withScope(scope, () => {
          const pre: number[] = [];
          for (const b of e.binds) {
            const g = this.gen(b.value); // compiled before the name is visible, as in the interpreter
            const sp = this.spill(g);
            pre.push(...sp.c);
            scope.set(b.name, { shape: g.shape, locals: sp.locals });
          }
          const body = this.seq(e.body, expect);
          return { ...body, c: [...pre, ...body.c] };
        });
      }
      case 'do':
        return this.seq(e.body, expect);
      case 'if': {
        const c = this.bool(this.gen(e.cond), 'if condition');
        const t = this.gen(e.then, expect);
        const f = this.gen(e.else, expect ?? t.shape);
        if (!sameShape(t.shape, f.shape)) no(`if branches differ: ${showShape(t.shape)} vs ${showShape(f.shape)}`);
        return { c: [...c, OP.if, ...this.bt(t.shape), ...t.c, OP.else, ...f.c, OP.end], shape: t.shape };
      }
      case 'match':
        return this.genMatch(e, expect);
      case 'lam':
        return no('lambda outside map, filter, fold or sort');
      case 'try':
        return this.genTry(e);
      case 'call':
        return this.genCall(e, expect);
    }
  }

  /** Sequence of expressions: earlier ones are compiled and dropped, the last is the value. */
  protected seq(es: Expr[], expect?: Shape): G {
    const gs = es.map((x, i) => this.gen(x, i === es.length - 1 ? expect : undefined));
    const drops = gs.slice(0, -1).flatMap((g) => [...g.c, ...this.dropAll(g.shape)]);
    return { c: [...drops, ...gs[gs.length - 1].c], shape: gs[gs.length - 1].shape };
  }

  private genMatch(e: Extract<Expr, { k: 'match' }>, expect?: Shape): G {
    const s = this.gen(e.scrut);
    if (s.shape.t === 'result') return this.genMatchResult(e, s, expect);
    if (s.shape.t !== 'enum') return no(`match on ${showShape(s.shape)} (only enums and Results are supported)`);
    const cases = s.shape.cases;
    const seen = new Set<string>();
    const arms = e.arms
      .filter((a) => {
        if (!cases.includes(a.tag)) no(`match arm ${a.tag} is not a case of ${showShape(s.shape)}`);
        if (a.bind !== null) no(`match arm ${a.tag} binds a payload, but enum cases carry none`);
        if (seen.has(a.tag)) return false; // first arm wins, as in the interpreter
        seen.add(a.tag);
        return true;
      })
      .map((a) => ({ idx: cases.indexOf(a.tag), g: this.gen(a.body, expect) }));
    if (seen.size !== cases.length) no(`non-exhaustive match (missing ${cases.filter((c) => !seen.has(c)).join(', ')})`);
    const shape = arms[0].g.shape;
    for (const a of arms) if (!sameShape(a.g.shape, shape)) no(`match arms differ: ${showShape(shape)} vs ${showShape(a.g.shape)}`);
    const tmp = this.alloc('i32');
    const bt = this.bt(shape);
    const chain = (i: number): number[] =>
      i === arms.length - 1 ? arms[i].g.c : [...localGet(tmp), ...I32.const(BigInt(arms[i].idx)), I32.eq, OP.if, ...bt, ...arms[i].g.c, OP.else, ...chain(i + 1), OP.end];
    return { c: [...s.c, ...localSet(tmp), ...chain(0)], shape };
  }

  private genMatchResult(e: Extract<Expr, { k: 'match' }>, s: G, expect?: Shape): G {
    const rs = s.shape as Extract<Shape, { t: 'result' }>;
    const sp = this.spill(s);
    const nok = nleaves(rs.ok);
    const okLocals = sp.locals.slice(1, 1 + nok);
    const errLocals = sp.locals.slice(1 + nok);
    const arm = (tag: 'ok' | 'err'): G => {
      const a = e.arms.find((x) => x.tag === tag);
      if (!a) return no(`non-exhaustive match on Result (missing ${tag})`);
      const m = new Map<string, Binding>();
      if (a.bind) m.set(a.bind, tag === 'ok' ? { shape: rs.ok, locals: okLocals } : { shape: rs.err, locals: errLocals });
      return this.withScope(m, () => this.gen(a.body, expect));
    };
    for (const a of e.arms) if (a.tag !== 'ok' && a.tag !== 'err') no(`match arm ${a.tag} is not ok or err`);
    const ok = arm('ok');
    const err = arm('err');
    if (!sameShape(ok.shape, err.shape)) no(`match arms differ: ${showShape(ok.shape)} vs ${showShape(err.shape)}`);
    const [first, second] = this.opts.mutation === 'result-arms-swapped' ? [ok, err] : [err, ok];
    return { c: [...sp.c, ...localGet(sp.locals[0]), OP.if, ...this.bt(err.shape), ...first.c, OP.else, ...second.c, OP.end], shape: ok.shape };
  }

  /** `(try e :on-err Case)`: Ok gives its value; Err returns `(err Case)` from the whole function. */
  private genTry(e: Extract<Expr, { k: 'try' }>): G {
    const ret = this.retShape;
    if (ret.t !== 'result') return no('try in a function that does not return a Result');
    if (ret.err.t !== 'enum') return no('try needs the function result to be a Result with an enum Err');
    const idx = ret.err.cases.indexOf(e.onErr);
    if (idx < 0) return no(`try :on-err ${e.onErr} is not a case of the function's Err type`);
    const g = this.gen(e.expr);
    if (g.shape.t !== 'result') return no(`try applied to ${showShape(g.shape)}, not a Result`);
    const sp = this.spill(g);
    const early = [...I32.const(1n), ...this.zero(ret.ok), ...I32.const(BigInt(idx)), OP.return];
    const guard = this.opts.mutation === 'try-fallthrough' ? [] : [...localGet(sp.locals[0]), OP.if, OP.void, ...early, OP.end];
    return { c: [...sp.c, ...guard, ...this.getAll(sp.locals.slice(1, 1 + nleaves(g.shape.ok)))], shape: g.shape.ok };
  }

  /** Record construction `(T a b c)` or `(T :f1 a :f2 b)`. Fields are evaluated in declared order, as in the interpreter. */
  private genRecord(e: Extract<Expr, { k: 'call' }>): G {
    const shape = shapeOf(this.prog, { k: 'named', name: e.fn }, `type ${e.fn}`, SHAPE_OPTS);
    if (shape.t !== 'rec') return no(`${e.fn} is not a record type`);
    let c: number[] = [];
    if (e.args.length) {
      if (e.kw.length) return no('mixed positional and keyword fields');
      if (e.args.length !== shape.fields.length) return no(`${e.fn} has ${shape.fields.length} field(s) but is built with ${e.args.length}`);
      shape.fields.forEach((f, i) => {
        const g = this.gen(e.args[i], f.shape);
        if (!sameShape(g.shape, f.shape)) no(`field ${e.fn}.${f.name} is ${showShape(f.shape)} but the value is ${showShape(g.shape)}`);
        c = [...c, ...g.c];
      });
    } else {
      for (const f of shape.fields) {
        const k = e.kw.find((x) => x.name === f.name);
        if (!k) return no(`${e.fn}: missing field ${f.name}`);
        const g = this.gen(k.value, f.shape);
        if (!sameShape(g.shape, f.shape)) no(`field ${e.fn}.${f.name} is ${showShape(f.shape)} but the value is ${showShape(g.shape)}`);
        c = [...c, ...g.c];
      }
    }
    return { c, shape };
  }

  /** Convert the leaves on the stack between integer representations (a no-op when no Int leaf is involved). */
  protected convert(shape: Shape, from: ValType, to: ValType): number[] {
    if (from === to) return [];
    const ints = intLeaves(shape);
    if (!ints.some((x) => x)) return [];
    const locals = wtypes(shape, from).map((t) => this.alloc(t));
    const c = this.setAll(locals);
    locals.forEach((l, k) => c.push(...localGet(l), ...(ints[k] ? (from === 'i64' ? [OP.i32WrapI64] : [OP.i64ExtendI32S]) : [])));
    return c;
  }

  private checkBounds(got: Shape, want: Shape, what: string) {
    if (got.t === 'list' && want.t === 'list') {
      // The callee sizes its scratch from its own parameter maximum, so the argument must not be longer.
      if (got.max > want.max) no(`${what} may have up to ${got.max} elements but the parameter allows ${want.max}`);
    } else if (got.t === 'rec' && want.t === 'rec') got.fields.forEach((f, i) => this.checkBounds(f.shape, want.fields[i].shape, what));
    else if (got.t === 'result' && want.t === 'result') {
      this.checkBounds(got.ok, want.ok, what);
      this.checkBounds(got.err, want.err, what);
    }
  }

  /** Direct call to another compiled Sigil function. Ints are converted between the two functions' widths. */
  private genUserCall(e: Extract<Expr, { k: 'call' }>): G {
    const info = this.callee(e.fn);
    if (typeof info === 'string') return no(`calls ${e.fn}, which is not compilable: ${info}`);
    if (e.kw.length) return no(`keyword arguments to ${e.fn}`);
    if (e.args.length !== info.params.length) return no(`${e.fn} expects ${info.params.length} argument(s)`);
    // The checker has proved each argument lies in the callee's parameter range, so narrowing is lossless.
    const c: number[] = [];
    e.args.forEach((a, i) => {
      const g = this.gen(a, info.params[i]);
      if (!sameShape(g.shape, info.params[i])) no(`argument ${i + 1} of ${e.fn} is ${showShape(g.shape)}, expected ${showShape(info.params[i])}`);
      this.checkBounds(g.shape, info.params[i], `argument ${i + 1} of ${e.fn}`);
      c.push(...g.c, ...this.convert(g.shape, this.R.vt, info.vt));
    });
    if (info.hasBase) {
      if (this.baseLocal < 0) throw new NeedBase();
      c.push(...this.baseAddr(this.frame)); // callee scratch starts after everything allocated so far
      this.need = Math.max(this.need, this.frame + info.need);
      if (MEM_BASE + this.need > MAX_MEMORY_BYTES) no(`call to ${e.fn}: scratch of ${this.need} bytes exceeds the ${MAX_MEMORY_BYTES} byte limit`);
    }
    c.push(...call(info.index + this.ctx.importBase), ...this.convert(info.result, info.vt, this.R.vt));
    // A list in the result lives in the callee's scratch: keep it reserved so later allocations cannot overwrite it.
    if (info.hasBase && listsOf(info.result).length) this.frame += info.need;
    return { c, shape: info.result };
  }

  /** `a and b ...` / `a or b ...`, short-circuit (operands may have effects or return early). */
  private genShort(e: Extract<Expr, { k: 'call' }>): G {
    const isAnd = e.fn === 'and';
    if (!e.args.length) return { c: I32.const(isAnd ? 1n : 0n), shape: { t: 'bool' } };
    const parts = e.args.map((a) => this.bool(this.gen(a), e.fn));
    const build = (i: number): number[] => {
      if (i === parts.length - 1) return parts[i];
      return isAnd
        ? [...parts[i], OP.if, 0x7f, ...build(i + 1), OP.else, ...I32.const(0n), OP.end]
        : [...parts[i], OP.if, 0x7f, ...I32.const(1n), OP.else, ...build(i + 1), OP.end];
    };
    return { c: build(0), shape: { t: 'bool' } };
  }

  /** Structural equality, leaf by leaf (inactive Result payloads are zero, so every leaf can be compared). */
  protected genEq(a: G, b: G): G {
    if (!sameShape(a.shape, b.shape)) return no(`= on ${showShape(a.shape)} and ${showShape(b.shape)}`);
    if (listsOf(a.shape).length) return no('= on a value containing a list');
    const sa = this.spill(a);
    const sb = this.spill(b);
    const c = [...sa.c, ...sb.c];
    const leafT = this.eqLeaves(a.shape);
    let first = true;
    leafT.forEach((k, i) => {
      c.push(...localGet(sa.locals[i]), ...localGet(sb.locals[i]), ...this.eqLeaf(k));
      if (!first) c.push(I32.and);
      first = false;
    });
    if (first) c.push(...I32.const(1n)); // no leaves (Unit): equal
    return { c, shape: { t: 'bool' } };
  }
  protected eqLeaves(s: Shape): ('int' | 'i32' | 'str')[] {
    switch (s.t) {
      case 'unit':
        return [];
      case 'int':
        return ['int'];
      case 'str':
        return ['str'];
      case 'rec':
        return s.fields.flatMap((f) => this.eqLeaves(f.shape));
      case 'result':
        return ['i32', ...this.eqLeaves(s.ok), ...this.eqLeaves(s.err)];
      default:
        return ['i32'];
    }
  }
  protected eqLeaf(k: 'int' | 'i32' | 'str'): number[] {
    if (k === 'str') return this.opts.mutation === 'str-eq-true' ? [OP.drop, OP.drop, ...I32.const(1n)] : call(this.imp('str_eq', ['i32', 'i32'], ['i32']));
    return [k === 'int' ? this.R.eq : I32.eq];
  }

  protected genCall(e: Extract<Expr, { k: 'call' }>, expect?: Shape): G {
    const R = this.R;
    const name = e.fn;
    const dc = asDeclassify(e);
    if (dc) return this.gen(dc.expr, expect); // identity at runtime: labels are static
    if (name in CAP_OPS) return this.genCap(e);
    if (this.prog.types.has(name)) return this.genRecord(e);
    if (this.prog.fns.has(name)) return this.genUserCall(e);
    if (e.kw.length) return no(`keyword arguments to ${name}`);
    const need = (n: number) => {
      if (e.args.length !== n) no(`${name} expects ${n} argument(s)`);
    };
    const INT: Shape = { t: 'int' };
    const BOOL: Shape = { t: 'bool' };

    switch (name) {
      case 'map':
        return this.genMapFilter(e, true);
      case 'filter':
        return this.genMapFilter(e, false);
      case 'sum':
        return this.genSum(e);
      case 'sort':
        return this.genSort(e);
      case 'fold':
        return this.genFold(e);
      case 'len':
        return this.genLen(e);
      case 'list':
        return this.genListLit(e);
      case 'ok':
      case 'err': {
        need(1);
        if (!expect || expect.t !== 'result') return no(`(${name} ...) here has no known Result type (it is not the function result, a record field or an argument)`);
        const side = name === 'ok' ? expect.ok : expect.err;
        const g = this.gen(e.args[0], side);
        if (!sameShape(g.shape, side)) return no(`(${name} ...) carries ${showShape(g.shape)} but the Result expects ${showShape(side)}`);
        const flip = this.opts.mutation === 'tag-flip';
        return name === 'ok'
          ? { c: [...I32.const(flip ? 1n : 0n), ...g.c, ...this.zero(expect.err)], shape: expect }
          : { c: [...I32.const(flip ? 0n : 1n), ...this.zero(expect.ok), ...g.c], shape: expect };
      }
      case 'text':
        return this.genText(e);
      case 'money':
        return this.genMoney(e);
      case 'chars':
        return this.genChars(e);
      case 'from-chars':
        return this.genFromChars(e);
      case 'add':
      case 'sub':
      case 'mul': {
        need(2);
        const a = this.int(this.gen(e.args[0]), name);
        const b = this.int(this.gen(e.args[1]), name);
        return { c: [...a, ...b, name === 'add' ? R.add : name === 'sub' ? R.sub : R.mul], shape: INT };
      }
      case 'neg': {
        need(1);
        const a = this.int(this.gen(e.args[0]), name);
        return { c: [...R.const(0n), ...a, R.sub], shape: INT };
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
        if (name === 'min') return { c: [...prefix, ...x, ...y, ...x, ...y, R.ltS, OP.select], shape: INT };
        if (name === 'max') return { c: [...prefix, ...x, ...y, ...x, ...y, R.gtS, OP.select], shape: INT };
        // div-floor. The checker has proved the divisor is non-zero and |x| < 2^(w-1), so neither
        // the zero-divide trap nor the INT_MIN / -1 trap can occur. div_s truncates toward zero;
        // floor = trunc - 1 when the remainder is non-zero and its sign differs from the divisor's.
        if (this.opts.divMode === 'trunc') return { c: [...prefix, ...x, ...y, R.divS], shape: INT };
        const tr = this.alloc(R.vt);
        const r = localGet(tr);
        const flag = [...r, ...R.const(0n), R.ne, ...r, ...y, R.xor, ...R.const(0n), R.ltS, I32.and];
        return {
          c: [...prefix, ...x, ...y, R.divS, ...x, ...y, R.remS, ...localSet(tr), ...flag, ...(R.vt === 'i64' ? [OP.i64ExtendI32U] : []), R.sub],
          shape: INT,
        };
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        if (e.args.length < 2) return no(`${name} with ${e.args.length} argument(s)`);
        const op = name === '<' ? R.ltS : name === '<=' ? R.leS : name === '>' ? R.gtS : R.geS;
        if (e.args.length === 2) return { c: [...this.int(this.gen(e.args[0]), name), ...this.int(this.gen(e.args[1]), name), op], shape: BOOL };
        // chained, e.g. (<= lo x hi): every operand is evaluated once, in order, then adjacent pairs are compared
        const c: number[] = [];
        const ls = e.args.map((a) => {
          const l = this.alloc(R.vt);
          c.push(...this.int(this.gen(a), name), ...localSet(l));
          return l;
        });
        ls.slice(0, -1).forEach((l, i) => {
          c.push(...localGet(l), ...localGet(ls[i + 1]), op);
          if (i > 0) c.push(I32.and);
        });
        return { c, shape: BOOL };
      }
      case '=': {
        need(2);
        return this.genEq(this.gen(e.args[0]), this.gen(e.args[1]));
      }
      case 'not': {
        need(1);
        return { c: [...this.bool(this.gen(e.args[0]), 'not'), I32.eqz], shape: BOOL };
      }
      case 'and':
      case 'or':
        return this.genShort(e);
      default:
        return no(`uses ${name}, which is outside the compiled subset`);
    }
  }

  // Extension points, filled in by later stages.
  protected genCap(e: Extract<Expr, { k: 'call' }>): G {
    return no(`capability operation ${e.fn}`);
  }
  protected genSort(_e: Extract<Expr, { k: 'call' }>): G {
    return no('sort (not yet supported by the Wasm backend)');
  }
  protected genFold(_e: Extract<Expr, { k: 'call' }>): G {
    return no('fold (not yet supported by the Wasm backend)');
  }

  // --- strings: opaque i32 handles into a host-owned table -----------------------------
  /** Index of a host import (registered on first use). Index 0 is returned for a function that will not be emitted. */
  protected imp(name: string, params: ValType[], results: ValType[], effect?: EffectDesc): number {
    this.touched.add(name);
    const reg = this.ctx.reg;
    let i = reg.importIndex(name);
    if (i < 0) {
      if (reg.frozen) return 0;
      i = reg.imports.length;
      reg.imports.push({ desc: { module: 'host', name, params, results }, effect, used: false });
    }
    return i;
  }

  protected genStr(v: string): G {
    return { c: I32.const(BigInt(this.ctx.reg.literal(v))), shape: { t: 'str' } };
  }

  /** `(text a b ...)`: concatenates strings and renders other values as the interpreter's showVal does. */
  protected genText(e: Extract<Expr, { k: 'call' }>): G {
    if (e.kw.length) no('keyword arguments to text');
    if (!e.args.length) return this.genStr('');
    const concat = this.imp('str_concat', ['i32', 'i32'], ['i32']);
    const c: number[] = [];
    e.args.forEach((a, i) => {
      c.push(...this.asStr(this.gen(a)));
      if (i > 0) c.push(...call(concat));
    });
    return { c, shape: { t: 'str' } };
  }

  /** The handle of the rendering of a value inside `text`. */
  private asStr(g: G): number[] {
    const s = g.shape;
    switch (s.t) {
      case 'str':
        return g.c;
      case 'int': {
        const f = this.imp('str_int', ['i64'], ['i32']);
        return [...g.c, ...(this.R.vt === 'i32' ? [OP.i64ExtendI32S] : []), ...call(f)];
      }
      case 'bool':
        return [...g.c, OP.if, 0x7f, ...I32.const(BigInt(this.ctx.reg.literal('true'))), OP.else, ...I32.const(BigInt(this.ctx.reg.literal('false'))), OP.end];
      case 'enum':
        return [...g.c, ...I32.const(BigInt(this.ctx.reg.enumBlock(s.cases))), I32.add];
      case 'unit':
        return [...g.c, ...I32.const(BigInt(this.ctx.reg.literal('unit')))];
      default:
        return no(`text of a ${showShape(s)} (only Str, Int, Bool, enum and Unit are rendered)`);
    }
  }

  protected genMoney(e: Extract<Expr, { k: 'call' }>): G {
    if (e.args.length !== 1 || e.kw.length) no('money expects 1 argument');
    const a = this.int(this.gen(e.args[0]), 'money');
    const f = this.imp('str_money', ['i64'], ['i32']);
    return { c: [...a, ...(this.R.vt === 'i32' ? [OP.i64ExtendI32S] : []), ...call(f)], shape: { t: 'str' } };
  }

  /** `(chars s)`: the host writes the code points into scratch memory (s must have a declared :max). */
  protected genChars(e: Extract<Expr, { k: 'call' }>): G {
    if (e.args.length !== 1 || e.kw.length) no('chars expects 1 argument');
    const s = this.gen(e.args[0]);
    if (s.shape.t !== 'str') return no(`chars needs a Str, got ${showShape(s.shape)}`);
    if (s.shape.max === undefined) return no('chars needs a Str with a declared :max');
    const max = s.shape.max;
    const f = this.imp('str_chars', ['i32', 'i32', 'i32'], ['i32']);
    const off = this.allocScratch(max * SLOT, 'chars');
    const n = this.alloc('i32');
    const layout = layoutOf({ t: 'int', lo: 0n, hi: 1114111n }, 'chars element');
    return {
      c: [...s.c, ...this.baseAddr(off), ...I32.const(BigInt(max)), ...call(f), ...localSet(n), ...this.baseAddr(off), ...localGet(n)],
      shape: { t: 'list', layout, min: 0, max },
    };
  }

  protected genFromChars(e: Extract<Expr, { k: 'call' }>): G {
    if (e.args.length !== 1 || e.kw.length) no('from-chars expects 1 argument');
    const l = this.gen(e.args[0]);
    if (l.shape.t !== 'list' || l.shape.layout.elem.t !== 'int') return no(`from-chars needs a list of Int, got ${showShape(l.shape)}`);
    const f = this.imp('str_from_chars', ['i32', 'i32'], ['i32']);
    return { c: [...l.c, ...call(f)], shape: { t: 'str' } };
  }
}

// ---------------------------------------------------------------------------
// Per-function and per-program drivers
// ---------------------------------------------------------------------------

/** Integer ranges of every type a function body names (record constructions, fold accumulators, callees). */
function declaredMagnitudes(prog: Program, f: FnDef): bigint[] {
  const out: bigint[] = [];
  const add = (t: import('../ast.js').Type) => {
    try {
      magnitudes(shapeOf(prog, t, 'type', { strings: true }), out);
    } catch {
      // surfaces as a reason during code generation
    }
  };
  walk(f.body, (x) => {
    if (x.k !== 'call') return;
    if (prog.types.has(x.fn)) add({ k: 'named', name: x.fn });
    const uf = prog.fns.get(x.fn);
    if (uf) {
      uf.params.forEach((p) => add(p.type));
      add(uf.out);
    }
    if (x.fn === 'fold' && x.args[1]?.k === 'var' && prog.types.has(x.args[1].name)) add({ k: 'named', name: x.args[1].name });
    if (x.fn === 'fresh') out.push(9007199254740991n);
    if (x.fn === 'chars') out.push(1114111n);
  });
  return out;
}

function literals(e: Expr): bigint[] {
  const out: bigint[] = [];
  walk(e, (x) => {
    if (x.k === 'int') out.push(x.v);
  });
  return out;
}

function calledFns(prog: Program, e: Expr): Set<string> {
  const out = new Set<string>();
  walk(e, (x) => {
    if (x.k === 'call' && prog.fns.has(x.fn)) out.add(x.fn);
  });
  return out;
}

function compileFn(prog: Program, f: FnDef, ev: FnEvidence, res: CheckResult, opts: CompileOptions, callee: CalleeResolver, ctx: Ctx, entries: Set<string>): { report: FnReport; func?: WasmFunc; touched?: Set<string> } {
  const report: FnReport = { name: f.name, compilable: false, checkerRepr: ev.repr };
  try {
    if (f.needs.length && !FEATURES.effects) no(`uses capabilities/effects (needs ${f.needs.join(', ')})`);
    if (f.requires.length) no('has requires clauses, which the backend does not enforce');
    const errs = res.diags.filter((d) => d.level === 'error' && d.fn === f.name);
    if (errs.length) no(`checker reports errors (${errs[0].code})`);
    for (const o of ev.obligations) {
      if (o.kind === 'ensures') {
        if (o.status === 'failed') no(`ensures is refuted by the checker: ${o.desc}`);
      } else if (o.status !== 'proved') no(`obligation not proved by the checker: ${o.desc}`);
    }

    const params: ParamSpec[] = f.params.map((p) => {
      const shape = shapeOf(prog, p.type, `param ${p.name}`, SHAPE_OPTS);
      return { name: p.name, type: p.type, shape, leaves: flatLeaves(shape) };
    });
    const result = shapeOf(prog, f.out, 'result', SHAPE_OPTS);

    // Representation: the checker's derived repr, widened if its tracked intermediates did not
    // cover parameters, declared types or literals (it only tracks arithmetic results).
    const mags: bigint[] = [];
    for (const p of params) magnitudes(p.shape, mags);
    magnitudes(result, mags);
    mags.push(...declaredMagnitudes(prog, f));
    mags.push(...literals(f.body).map((v) => (v < 0n ? -v : v)));
    const mine = reprFor(mags.reduce((a, b) => (a > b ? a : b), 0n));
    if (ev.repr === 'bigint' || mine === 'bigint') no('needs bigint representation (exceeds i64)');
    // A caller is at least as wide as its callees, so a callee's result always fits the caller.
    let calleeWide = false;
    for (const name of calledFns(prog, f.body)) {
      const info = callee(name);
      if (typeof info === 'string') no(`calls ${name}, which is not compilable: ${info}`);
      else if (info.vt === 'i64') calleeWide = true;
    }
    const used: 'i32' | 'i64' = ev.repr === 'i64' || mine === 'i64' || calleeWide ? 'i64' : 'i32';
    if (used !== ev.repr) report.widenedFromChecker = `checker derived ${ev.repr}, but parameter ranges or literals need ${used}`;
    report.repr = used;
    const R = used === 'i64' ? I64 : I32;
    const needsInput = params.some((p) => listsOf(p.shape).length > 0);

    for (const withBase of needsInput ? [true] : [false, true]) {
      const g = new FnGen(prog, R, opts, callee, ctx);
      g.retShape = result;
      const top = new Map<string, Binding>();
      const ptypes: ValType[] = [];
      for (const p of params) {
        const locals = wtypes(p.shape, R.vt).map((t) => {
          ptypes.push(t);
          return ptypes.length - 1;
        });
        top.set(p.name, { shape: p.shape, locals });
      }
      if (withBase) {
        g.baseLocal = ptypes.length;
        ptypes.push('i32');
      }
      g.nParams = ptypes.length;
      g.scopes.push(top);
      let body: G;
      try {
        body = g.gen(f.body, result);
      } catch (e) {
        if (e instanceof NeedBase && !withBase) continue;
        throw e;
      }
      if (!sameShape(body.shape, result)) no(`body is ${showShape(body.shape)} but declared result is ${showShape(result)}`);

      let inputBytes = 0;
      for (const p of params) for (const l of listsOf(p.shape)) inputBytes += l.max * l.layout.stride * SLOT;
      if (withBase && MEM_BASE + inputBytes + g.need > MAX_MEMORY_BYTES) no(`memory for inputs (${inputBytes}) and scratch (${g.need}) exceeds the ${MAX_MEMORY_BYTES} byte limit`);
      if (withBase) Object.assign(report, { hasBase: true, inputBytes, scratchBytes: g.need });
      report.params = params;
      report.result = result;
      report.compilable = true;
      if (entries.has(f.name)) report.entry = true;
      return { report, func: { name: f.name, params: ptypes, results: wtypes(result, R.vt), locals: g.locals, body: body.c }, touched: g.touched };
    }
    return no('internal: scratch base was not granted');
  } catch (e) {
    if (e instanceof NotCompilable) {
      report.reason = e.message;
      return { report };
    }
    throw e;
  }
}

interface Built {
  funcs: WasmFunc[];
  fns: FnReport[];
  reg: Registry;
  types: TypeTable;
  entries: string[];
}

function buildOnce(prog: Program, res: CheckResult, opts: CompileOptions, reg: Registry, importBase: number): Built {
  const types = new TypeTable();
  const ctx: Ctx = { types, reg, importBase };
  const entrySet = new Set(prog.entries);
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
        const { report, func, touched } = compileFn(prog, f, ev, res, opts, callee, ctx, entrySet);
        out = { report };
        if (func) {
          out.index = funcs.length;
          funcs.push(func);
          for (const n of touched ?? []) {
            const i = reg.importIndex(n);
            if (i >= 0) reg.imports[i].used = true;
          }
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
    return { index: r.index, vt: rep.repr!, params: rep.params!.map((p) => p.shape), result: rep.result!, hasBase: !!rep.hasBase, need: rep.scratchBytes ?? 0 };
  };

  for (const f of prog.fns.values()) ensure(f.name);
  const fns = [...prog.fns.keys()].map((n) => done.get(n)!.report);
  return { funcs, fns, reg, types, entries: fns.filter((r) => r.compilable && r.entry).map((r) => r.name) };
}

export function compileProgram(prog: Program, res: CheckResult, opts: CompileOptions = {}): CompileResult {
  // Pass 1 discovers which host imports the compiled functions use (imports come first in the function index
  // space, so the defined functions' indices depend on how many there are); pass 2 emits the final code.
  const reg1 = new Registry();
  buildOnce(prog, res, opts, reg1, 0);
  const reg = new Registry(true);
  reg.imports = reg1.imports.filter((i) => i.used).map((i) => ({ ...i, used: true }));
  reg.strings = [...reg1.strings];
  reg.enumBlocks = new Map(reg1.enumBlocks);
  reg.handles = [...reg1.handles];
  const b = buildOnce(prog, res, opts, reg, reg.imports.length);

  let memBytes = 0;
  for (const r of b.fns) if (r.compilable && r.hasBase) memBytes = Math.max(memBytes, MEM_BASE + r.inputBytes! + r.scratchBytes!);
  const memPages = memBytes ? Math.ceil(memBytes / 65536) : undefined;
  const abi: AbiDescriptor = {
    version: 1,
    strings: reg.strings,
    handles: reg.handles,
    effects: reg.imports.flatMap((i) => (i.effect ? [i.effect] : [])),
  };
  const custom = [{ name: 'sigil.abi', data: new TextEncoder().encode(JSON.stringify(abi, (k, v) => (k === 'lo' || k === 'hi' ? undefined : v))) }];
  const bytes = buildModule(b.funcs, { memPages, imports: reg.imports.map((i) => i.desc), types: b.types, custom: b.funcs.length || reg.imports.length ? custom : [] });
  return { bytes, fns: b.fns, memPages, entries: b.entries, abi };
}
