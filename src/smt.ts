// SMT discharge of relational `ensures` that intervals cannot prove.
//
// Fragment: integer arithmetic (div-floor and mod by a positive literal), comparisons, booleans, if, let, match on
// enums, record field reads and construction, and bounded lists (`len`, `sum`, `map`, `filter`, `any`, `all`, `list`).
//
// Lists: a (List T min max) with max <= maxList (default 6) is encoded exactly as a length variable in
// [min, max] plus one symbolic element per slot; slots at index >= len are never observed. `sum` is the
// unrolled guarded sum, `map` maps slotwise, `filter` compacts kept elements to a prefix. For a larger
// max only `len` is modelled (elements are not), so anything touching elements is out of the fragment.
// Calls to user functions are inlined (their body is the semantics). If inlining leaves the fragment, a
// top-level call whose arguments are plain parameters falls back to an uninterpreted constant (one per
// syntactically identical call) constrained by the callee's declared output range: sound, because that
// range is the callee's separately checked contract, but incomplete. Otherwise the result is
// 'unsupported'. Proofs for bounded lists are exact for every list the type admits; proofs never assume
// the analysed function's own output range.

import { init } from 'z3-solver';
import { Expr, FnDef, Program, Type, resolveType } from './ast.js';
import { printExpr } from './print/sexp.js';

export type SmtStatus = 'proved' | 'counterexample' | 'unknown' | 'unsupported';
export interface SmtResult {
  fn: string;
  index: number;
  status: SmtStatus;
  note: string;
}

class Unsupported extends Error {}

type Z3 = Awaited<ReturnType<typeof init>>;

export interface SmtOptions {
  /** Largest declared list max whose elements are modelled symbolically. Default 6. */
  maxList?: number;
}

export async function proveEnsures(prog: Program, only?: (fn: string, i: number) => boolean, opts: SmtOptions = {}): Promise<SmtResult[]> {
  const z3: Z3 = await init();
  const out: SmtResult[] = [];
  try {
    for (const f of prog.fns.values()) {
      f.ensures.forEach((_, i) => {
        if (!only || only(f.name, i)) out.push({ fn: f.name, index: i, ...{ status: 'unknown' as SmtStatus, note: '' } });
      });
    }
    for (const r of out) {
      const f = prog.fns.get(r.fn)!;
      try {
        Object.assign(r, await proveOne(z3, prog, f, r.index, opts.maxList ?? 6));
      } catch (e) {
        if (e instanceof Unsupported) Object.assign(r, { status: 'unsupported', note: e.message });
        else throw e;
      }
    }
  } finally {
    // z3-solver spawns worker threads; let the process exit.
    (z3 as unknown as { em?: { PThread?: { terminateAllThreads(): void } } }).em?.PThread?.terminateAllThreads();
  }
  return out;
}

type Term = any; // z3 Arith | Bool expr; the library's generics are not worth fighting here
class RecV {
  constructor(public fields: Map<string, V>) {}
}
class ListV {
  // elems === null: length only (declared max too large to model elements)
  constructor(public len: Term, public elems: V[] | null) {}
}
type V = Term | RecV | ListV | null; // null: opaque (strings etc.), unusable in arithmetic
type Env = Map<string, { v: V; type: Type | null; param: boolean }>;

function freeVars(e: Expr, out: Set<string>): boolean {
  // returns false if the expression contains binders (let/lam/match arms), which we do not key calls on
  switch (e.k) {
    case 'int': case 'bool': case 'str': return true;
    case 'var': out.add(e.name); return true;
    case 'call': return e.args.every((a) => freeVars(a, out)) && e.kw.every((k) => freeVars(k.value, out));
    case 'if': return freeVars(e.cond, out) && freeVars(e.then, out) && freeVars(e.else, out);
    default: return false;
  }
}

async function proveOne(z3: Z3, prog: Program, f: FnDef, index: number, maxList: number): Promise<{ status: SmtStatus; note: string }> {
  const ctx = z3.Context(`c${f.name}${index}`);
  const { Int, Bool, Solver, And, Or, Not, If } = ctx;
  const solver = new Solver();
  const consts = new Map<string, Term>();
  const uf = new Map<string, Term>();
  let inlined = 0;
  const stack: string[] = [];

  const constrain = (t: Type, v: Term) => {
    const r = resolveType(prog, t);
    if (r.k === 'int') solver.add(And(v.ge(Int.val(r.lo)), v.le(Int.val(r.hi))));
    else if (r.k === 'enum') solver.add(And(v.ge(Int.val(0)), v.le(Int.val(r.cases.length - 1))));
    else if (r.k === 'bool') solver.add(And(v.ge(Int.val(0)), v.le(Int.val(1))));
  };

  const scalarKind = (t: Type) => resolveType(prog, t).k;

  // A fresh symbolic value of a declared type (parameters only).
  const mkVal = (type: Type, name: string): V => {
    const r = resolveType(prog, type);
    if (r.k === 'int' || r.k === 'enum' || r.k === 'bool') {
      const c = Int.const(name);
      consts.set(name, c);
      constrain(type, c);
      return c;
    }
    if (r.k === 'rec') return new RecV(new Map(r.fields.map((fl) => [fl.name, mkVal(fl.type, `${name}.${fl.name}`)])));
    if (r.k === 'list') {
      const len = Int.const(`${name}.len`);
      consts.set(`${name}.len`, len);
      solver.add(And(len.ge(Int.val(r.min)), len.le(Int.val(r.max))));
      if (r.max > maxList) return new ListV(len, null);
      return new ListV(len, Array.from({ length: r.max }, (_, i) => mkVal(r.elem, `${name}[${i}]`)));
    }
    return null;
  };

  const env0: Env = new Map();
  for (const p of f.params) env0.set(p.name, { v: mkVal(p.type, p.name), type: p.type, param: true });

  const fieldType = (base: Type, path: string[]): Type => {
    let t = base;
    for (const seg of path) {
      const r = resolveType(prog, t);
      if (r.k !== 'rec') throw new Unsupported(`field access on non-record`);
      const fl = r.fields.find((x) => x.name === seg);
      if (!fl) throw new Unsupported(`unknown field ${seg}`);
      t = fl.type;
    }
    return t;
  };

  const isTerm = (v: V): boolean => v !== null && !(v instanceof RecV) && !(v instanceof ListV);
  const bool = (t: Term): Term => (t && typeof t.eq === 'function' && t.sort?.name?.() === 'Bool' ? t : t.neq(Int.val(0)));
  const scalar = (v: V, what: string): Term => {
    if (!isTerm(v)) throw new Unsupported(`${what} is not a number`);
    return v;
  };
  const listOf = (v: V, what: string): ListV => {
    if (!(v instanceof ListV)) throw new Unsupported(`${what} is not a list`);
    return v;
  };

  function ite(c: Term, a: V, b: V): V {
    if (isTerm(a) && isTerm(b)) return If(c, a, b);
    if (a instanceof RecV && b instanceof RecV) {
      return new RecV(new Map([...a.fields].map(([k, x]) => [k, ite(c, x, b.fields.get(k) ?? null)])));
    }
    if (a instanceof ListV && b instanceof ListV) {
      const len = If(c, a.len, b.len);
      if (!a.elems || !b.elems) return new ListV(len, null);
      const n = Math.max(a.elems.length, b.elems.length);
      const at = (l: V[], i: number): V => l[i] ?? l[0] ?? null;
      return new ListV(len, Array.from({ length: n }, (_, i) => ite(c, at(a.elems!, i), at(b.elems!, i))));
    }
    if (a === null || b === null) return null;
    throw new Unsupported('if branches have different shapes');
  }

  function tr(e: Expr, env: Env): V {
    switch (e.k) {
      case 'int':
        return Int.val(e.v);
      case 'bool':
        return e.v ? Bool.val(true) : Bool.val(false);
      case 'str':
        return null;
      case 'var': {
        const b = env.get(e.name);
        if (!b) throw new Unsupported(`unbound ${e.name}`);
        let v = b.v;
        for (const seg of e.path) {
          if (!(v instanceof RecV) || !v.fields.has(seg)) throw new Unsupported(`field ${seg} of ${e.name}`);
          v = v.fields.get(seg)!;
        }
        if (v === null) throw new Unsupported(`${e.name}${e.path.length ? '.' + e.path.join('.') : ''} is opaque`);
        return v;
      }
      case 'if':
        return ite(bool(scalar(tr(e.cond, env), 'condition')), tr(e.then, env), tr(e.else, env));
      case 'let': {
        const env2: Env = new Map(env);
        for (const b of e.binds) env2.set(b.name, { v: tr(b.value, env2), type: null, param: false });
        return tr(e.body[e.body.length - 1], env2);
      }
      case 'match': {
        const sc = e.scrut;
        if (sc.k !== 'var') throw new Unsupported('match on a non-variable');
        const b = env.get(sc.name);
        if (!b || !b.type) throw new Unsupported('match on an untyped value');
        const r = resolveType(prog, fieldType(b.type, sc.path));
        if (r.k !== 'enum') throw new Unsupported('match on a non-enum');
        const st = scalar(tr(sc, env), 'match scrutinee');
        let acc: V | null = null;
        for (let i = e.arms.length - 1; i >= 0; i--) {
          const arm = e.arms[i];
          const idx = r.cases.indexOf(arm.tag);
          if (idx < 0 || arm.bind) throw new Unsupported(`match arm ${arm.tag}`);
          const v = tr(arm.body, env);
          acc = acc === null ? v : ite(st.eq(Int.val(idx)), v, acc);
        }
        return acc;
      }
      case 'call':
        return call(e, env);
      default:
        throw new Unsupported(`${e.k} expression`);
    }
  }

  const num = (e: Expr, env: Env): Term => scalar(tr(e, env), 'operand');

  function lambda(e: Expr, env: Env): (x: V) => V {
    if (e.k !== 'lam' || e.params.length !== 1) throw new Unsupported('expected a one-parameter lambda');
    return (x) => {
      const env2: Env = new Map(env);
      env2.set(e.params[0], { v: x, type: null, param: false });
      return tr(e.body, env2);
    };
  }

  function call(e: Extract<Expr, { k: 'call' }>, env: Env): V {
    const a = e.args;
    const need = (n: number) => {
      if (a.length !== n) throw new Unsupported(`${e.fn} arity`);
    };
    const user = prog.fns.get(e.fn);
    const recT = prog.types.get(e.fn) ? resolveType(prog, { k: 'named', name: e.fn }) : null;
    if (recT && recT.k === 'rec' && !user) {
      const fields = new Map<string, V>();
      recT.fields.forEach((fl, i) => {
        const kw = e.kw.find((k) => k.name === fl.name || k.name === ':' + fl.name || ':' + k.name === fl.name);
        const arg = kw ? kw.value : e.kw.length ? undefined : a[i];
        if (!arg) throw new Unsupported(`constructor ${e.fn}: missing ${fl.name}`);
        fields.set(fl.name, tr(arg, env));
      });
      return new RecV(fields);
    }
    if (e.kw.length) throw new Unsupported('keyword constructor');
    switch (e.fn) {
      case 'add': need(2); return num(a[0], env).add(num(a[1], env));
      case 'sub': need(2); return num(a[0], env).sub(num(a[1], env));
      case 'mul': need(2); return num(a[0], env).mul(num(a[1], env));
      case 'div-floor': {
        need(2);
        // SMT-LIB div is floor division only for a positive divisor; require a positive literal.
        const d = a[1];
        if (d.k !== 'int' || d.v <= 0n) throw new Unsupported('divisor must be a positive literal');
        return num(a[0], env).div(Int.val(d.v));
      }
      case 'mod': {
        need(2);
        // SMT-LIB mod is non-negative; it equals floor modulo only for a positive divisor: require a positive literal.
        const d = a[1];
        if (d.k !== 'int' || d.v <= 0n) throw new Unsupported('divisor must be a positive literal');
        return num(a[0], env).mod(Int.val(d.v));
      }
      case 'any':
      case 'all': {
        need(2);
        const l = listOf(tr(a[0], env), `${e.fn} argument`);
        if (!l.elems) throw new Unsupported(`${e.fn} over a list longer than ${maxList} (elements not modelled)`);
        const fn = lambda(a[1], env);
        const parts = l.elems.map((x, i) => {
          const p = bool(scalar(fn(x), `${e.fn} predicate`));
          return e.fn === 'any' ? And(Int.val(i).lt(l.len), p) : Or(Int.val(i).ge(l.len), p);
        });
        return parts.length ? (e.fn === 'any' ? Or(...parts) : And(...parts)) : Bool.val(e.fn === 'all');
      }
      case 'neg': need(1); return Int.val(0).sub(num(a[0], env));
      case 'min': { need(2); const x = num(a[0], env), y = num(a[1], env); return If(x.le(y), x, y); }
      case 'max': { need(2); const x = num(a[0], env), y = num(a[1], env); return If(x.ge(y), x, y); }
      case '<=': case '<': case '>=': case '>': case '=': {
        if (a.length < 2) throw new Unsupported(`${e.fn} arity`);
        const ts = a.map((x) => num(x, env));
        const rel = (x: Term, y: Term) => (e.fn === '<=' ? x.le(y) : e.fn === '<' ? x.lt(y) : e.fn === '>=' ? x.ge(y) : e.fn === '>' ? x.gt(y) : x.eq(y));
        const parts = ts.slice(1).map((y, i) => rel(ts[i], y));
        return parts.length === 1 ? parts[0] : And(...parts);
      }
      case 'and': return And(...a.map((x) => bool(num(x, env))));
      case 'or': return Or(...a.map((x) => bool(num(x, env))));
      case 'not': need(1); return Not(bool(num(a[0], env)));
      case 'len': need(1); return listOf(tr(a[0], env), 'len argument').len;
      case 'list': return new ListV(Int.val(a.length), a.map((x) => tr(x, env)));
      case 'sum': {
        need(1);
        const l = listOf(tr(a[0], env), 'sum argument');
        if (!l.elems) throw new Unsupported(`sum over a list longer than ${maxList} (elements not modelled)`);
        let acc: Term = Int.val(0);
        l.elems.forEach((x, i) => {
          acc = acc.add(If(Int.val(i).lt(l.len), scalar(x, 'list element'), Int.val(0)));
        });
        return acc;
      }
      case 'map': {
        need(2);
        const l = listOf(tr(a[0], env), 'map argument');
        if (!l.elems) throw new Unsupported(`map over a list longer than ${maxList} (elements not modelled)`);
        const fn = lambda(a[1], env);
        return new ListV(l.len, l.elems.map(fn));
      }
      case 'filter': {
        need(2);
        const l = listOf(tr(a[0], env), 'filter argument');
        if (!l.elems) throw new Unsupported(`filter over a list longer than ${maxList} (elements not modelled)`);
        const fn = lambda(a[1], env);
        const kept = l.elems.map((x, i) => And(Int.val(i).lt(l.len), bool(scalar(fn(x), 'filter predicate'))));
        const before: Term[] = [Int.val(0)]; // before[i]: number kept among slots < i
        kept.forEach((k, i) => before.push(before[i].add(If(k, Int.val(1), Int.val(0)))));
        const out = l.elems.map((_, j) => {
          let acc: V = l.elems![0];
          for (let i = l.elems!.length - 1; i >= 0; i--) acc = ite(And(kept[i], before[i].eq(Int.val(j))), l.elems![i], acc);
          return acc;
        });
        return new ListV(before[before.length - 1], out);
      }
    }
    if (user) return callUser(e, user, env);
    throw new Unsupported(`${e.fn}`);
  }

  function callUser(e: Extract<Expr, { k: 'call' }>, callee: FnDef, env: Env): V {
    const abstract = (why: string): Term => {
      const ro = resolveType(prog, callee.out);
      const vars = new Set<string>();
      if (stack.length || ro.k !== 'int' || !freeVars(e, vars) || [...vars].some((n) => !env.get(n)?.param)) throw new Unsupported(why);
      const key = printExpr(e);
      let c = uf.get(key);
      if (!c) {
        c = Int.const(`call_${uf.size}_${e.fn}`);
        uf.set(key, c);
        constrain(callee.out, c);
      }
      return c;
    };
    if (e.args.length !== callee.params.length) throw new Unsupported(`${e.fn} arity`);
    if (stack.includes(callee.name)) return abstract(`${e.fn} is recursive`);
    try {
      const args = e.args.map((x) => tr(x, env));
      const env2: Env = new Map();
      callee.params.forEach((p, i) => env2.set(p.name, { v: args[i], type: p.type, param: false }));
      stack.push(callee.name);
      try {
        const v = tr(callee.body, env2);
        inlined++;
        return v;
      } finally {
        stack.pop();
      }
    } catch (err) {
      if (err instanceof Unsupported) return abstract(`${e.fn}: ${err.message}`);
      throw err;
    }
  }

  const outKind = scalarKind(f.out);
  if (outKind !== 'int') throw new Unsupported('function does not return a number');
  const outConst = Int.const('out');
  // Deliberately NOT constrained to f.out's range: that range is itself an obligation, and assuming it
  // would make the proof vacuous whenever the body can leave the range.
  for (const r of f.requires) solver.add(bool(num(r, env0)));
  solver.add(outConst.eq(num(f.body, env0)));
  const env1: Env = new Map(env0);
  env1.set('out', { v: outConst, type: f.out, param: false });
  const goal = bool(num(f.ensures[index], env1));
  solver.add(Not(goal as ReturnType<typeof Bool.const>));
  const calls = `${inlined} call(s) inlined, ${uf.size} abstracted`;
  const res = await solver.check();
  if (res === 'unsat') return { status: 'proved', note: `SMT: unsat for the negation (${calls})` };
  if (res === 'sat') {
    const m = solver.model();
    const ev = (c: Term) => m.eval(c).toString();
    const show = (v: V, type: Type | null): string => {
      const r = type ? resolveType(prog, type) : null;
      if (v instanceof RecV) {
        const fs = r && r.k === 'rec' ? r.fields : null;
        return `{${[...v.fields].filter(([, x]) => x !== null).map(([k, x]) => `${k}=${show(x, fs?.find((q) => q.name === k)?.type ?? null)}`).join(' ')}}`;
      }
      if (v instanceof ListV) {
        const n = Number(ev(v.len));
        const et = r && r.k === 'list' ? r.elem : null;
        return v.elems ? `[${v.elems.slice(0, n).map((x) => show(x, et)).join(', ')}]` : `<${n} elements>`;
      }
      if (v === null) return '_';
      const s = ev(v);
      return r && r.k === 'enum' ? (r.cases[Number(s)] ?? s) : s;
    };
    const bits = [
      ...f.params.map((p) => `${p.name}=${show(env0.get(p.name)!.v, p.type)}`),
      ...[...uf.values()].map((c) => `${c}=${ev(c)}`),
      `out=${ev(outConst)}`,
    ];
    const caveat = uf.size ? 'may be spurious: a call was abstracted' : 'exact, no abstraction';
    return { status: 'counterexample', note: `SMT counterexample (${caveat}): ${bits.join(', ')}` };
  }
  return { status: 'unknown', note: 'SMT returned unknown' };
}
