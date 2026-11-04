// Wasm backend for the pure numeric core of Sigil.
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
import { I32, I64, IntOps, OP, ValType, WasmFunc, blockType, buildModule, localGet, localSet } from './encode.js';

export type Kind = { t: 'int' } | { t: 'bool' } | { t: 'enum'; cases: string[] };

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
}

export interface CompileOptions {
  /** Test hook for mutation testing the compiler itself: 'trunc' emits plain div_s (WRONG for negatives). */
  divMode?: 'floor' | 'trunc';
}

export interface CompileResult {
  bytes: Uint8Array;
  fns: FnReport[];
}

/** What a caller needs to know about a compiled callee. */
export interface Callee {
  index: number;
  vt: ValType; // int representation of the callee
  params: Kind[];
  result: Kind;
}
export type CalleeResolver = (name: string) => Callee | string; // string = reason it cannot be called

class NotCompilable extends Error {}
const no = (reason: string): never => {
  throw new NotCompilable(reason);
};

const sameCases = (a: string[], b: string[]) => a.length === b.length && a.every((c, i) => c === b[i]);
const sameKind = (a: Kind, b: Kind) => a.t === b.t && (a.t !== 'enum' || sameCases(a.cases, (b as typeof a).cases));
const showKind = (k: Kind) => (k.t === 'enum' ? `enum(${k.cases.join('|')})` : k.t);

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

interface G {
  c: number[];
  kind: Kind;
}
type Binding = { b: 'val'; local: number; kind: Kind } | { b: 'rec'; leaves: Map<string, { local: number; kind: Kind }> };

class FnGen {
  locals: ValType[] = [];
  scopes: Map<string, Binding>[] = [];
  nParams = 0;
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
    return k.t === 'int' ? this.R.vt : 'i32';
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
            const local = this.alloc(this.vtOf(g.kind));
            pre.push(...g.c, ...localSet(local));
            scope.set(b.name, { b: 'val', local, kind: g.kind });
          }
          const body = this.seq(e.body);
          return { c: [...pre, ...body.c], kind: body.kind };
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
    const drops = gs.slice(0, -1).flatMap((g) => [...g.c, 0x1a]);
    return { c: [...drops, ...gs[gs.length - 1].c], kind: gs[gs.length - 1].kind };
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
      c.push(...g.c, ...(g.kind.t === 'int' ? conv(this.R.vt, info.vt) : []));
    });
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
        const a = this.gen(e.args[0]);
        const b = this.gen(e.args[1]);
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
        return no(`uses ${name}, which is outside the numeric subset (lists, strings, Results and higher-order builtins are not supported)`);
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

    const params: ParamSpec[] = f.params.map((p) => ({ name: p.name, type: p.type, leaves: leavesOf(prog, p.type, '', `param ${p.name}`) }));
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
    for (const name of calledFns(prog, f.body)) {
      const info = callee(name);
      if (typeof info === 'string') no(`calls ${name}, which is not compilable: ${info}`);
      else if (info.vt === 'i64') calleeWide = true;
    }
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
      for (const l of p.leaves) {
        leaves.set(l.path, { local: ptypes.length, kind: l.kind });
        ptypes.push(l.kind.t === 'int' ? R.vt : 'i32');
      }
      top.set(p.name, isRec ? { b: 'rec', leaves } : { b: 'val', local: leaves.get('')!.local, kind: leaves.get('')!.kind });
    }
    g.nParams = ptypes.length;
    g.scopes.push(top);
    const body = g.gen(f.body);
    if (!sameKind(body.kind, result)) no(`body is ${showKind(body.kind)} but declared result is ${showKind(result)}`);

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
    return { index: r.index, vt: rep.repr!, params, result: rep.result! };
  };

  for (const f of prog.fns.values()) ensure(f.name);
  return { bytes: buildModule(funcs), fns: [...prog.fns.keys()].map((n) => done.get(n)!.report) };
}
