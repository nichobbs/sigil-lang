// SMT discharge of relational `ensures` that intervals cannot prove.
//
// Fragment: integer arithmetic, comparisons, booleans, if, let, match on enums, record field reads.
// Calls to other user functions are abstracted as uninterpreted constants (one per syntactically
// identical call), constrained only by the callee's declared output range. That is sound but
// incomplete: a proof that holds under the abstraction is a real proof; "unknown/refuted" may just
// mean the abstraction lost a fact (e.g. what `sum` over a list means).

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

export async function proveEnsures(prog: Program, only?: (fn: string, i: number) => boolean): Promise<SmtResult[]> {
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
        Object.assign(r, await proveOne(z3, prog, f, r.index));
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

async function proveOne(z3: Z3, prog: Program, f: FnDef, index: number): Promise<{ status: SmtStatus; note: string }> {
  const ctx = z3.Context(`c${f.name}${index}`);
  const { Int, Bool, Solver, And, Or, Not, If } = ctx;
  const solver = new Solver();
  const consts = new Map<string, ReturnType<typeof Int.const>>();
  const uf = new Map<string, ReturnType<typeof Int.const>>();

  const constrain = (t: Type, v: ReturnType<typeof Int.const>) => {
    const r = resolveType(prog, t);
    if (r.k === 'int') solver.add(And(v.ge(Int.val(r.lo)), v.le(Int.val(r.hi))));
    else if (r.k === 'enum') solver.add(And(v.ge(Int.val(0)), v.le(Int.val(r.cases.length - 1))));
    else if (r.k === 'bool') solver.add(And(v.ge(Int.val(0)), v.le(Int.val(1))));
  };

  const scalarKind = (t: Type) => resolveType(prog, t).k;

  const constFor = (name: string, t: Type) => {
    let c = consts.get(name);
    if (!c) {
      c = Int.const(name);
      consts.set(name, c);
      constrain(t, c);
    }
    return c;
  };

  type Term = any; // z3 Arith | Bool expr; the library's generics are not worth fighting here
  type Env = Map<string, { t: Term; type: Type | null }>;
  const env0: Env = new Map();
  for (const p of f.params) {
    const k = scalarKind(p.type);
    if (k === 'int' || k === 'enum') env0.set(p.name, { t: constFor(p.name, p.type), type: p.type });
    else env0.set(p.name, { t: null, type: p.type });
  }

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

  const bool = (t: Term): Term => (t && typeof t.eq === 'function' && t.sort?.name?.() === 'Bool' ? t : t.neq(Int.val(0)));
  const num = (t: Term): Term => t;

  function tr(e: Expr, env: Env): Term {
    switch (e.k) {
      case 'int':
        return Int.val(e.v);
      case 'bool':
        return e.v ? Bool.val(true) : Bool.val(false);
      case 'var': {
        const b = env.get(e.name);
        if (!b) throw new Unsupported(`unbound ${e.name}`);
        if (!e.path.length) {
          if (b.t === null) throw new Unsupported(`${e.name} is not a scalar`);
          return b.t;
        }
        if (!b.type) throw new Unsupported(`field of derived value`);
        const ft = fieldType(b.type, e.path);
        const k = scalarKind(ft);
        if (k !== 'int' && k !== 'enum') throw new Unsupported(`${e.name}.${e.path.join('.')} is not a number`);
        return constFor(`${e.name}.${e.path.join('.')}`, ft);
      }
      case 'if':
        return If(bool(tr(e.cond, env)), tr(e.then, env), tr(e.else, env));
      case 'let': {
        const env2: Env = new Map(env);
        for (const b of e.binds) env2.set(b.name, { t: tr(b.value, env2), type: null });
        return tr(e.body[e.body.length - 1], env2);
      }
      case 'match': {
        const sc = e.scrut;
        if (sc.k !== 'var' || sc.path.length) throw new Unsupported('match on a non-variable');
        const b = env.get(sc.name);
        const r = b?.type ? resolveType(prog, b.type) : null;
        if (!b || !r || r.k !== 'enum') throw new Unsupported('match on a non-enum');
        const cases = r.cases;
        let acc: Term | null = null;
        for (let i = e.arms.length - 1; i >= 0; i--) {
          const arm = e.arms[i];
          const idx = cases.indexOf(arm.tag);
          if (idx < 0 || arm.bind) throw new Unsupported(`match arm ${arm.tag}`);
          const v = tr(arm.body, env);
          acc = acc === null ? v : If(b.t.eq(Int.val(idx)), v, acc);
        }
        return acc;
      }
      case 'call':
        return call(e, env);
      default:
        throw new Unsupported(`${e.k} expression`);
    }
  }

  function call(e: Extract<Expr, { k: 'call' }>, env: Env): Term {
    if (e.kw.length) throw new Unsupported('keyword constructor');
    const a = e.args;
    const need = (n: number) => {
      if (a.length !== n) throw new Unsupported(`${e.fn} arity`);
    };
    switch (e.fn) {
      case 'add': need(2); return num(tr(a[0], env)).add(tr(a[1], env));
      case 'sub': need(2); return num(tr(a[0], env)).sub(tr(a[1], env));
      case 'mul': {
        need(2);
        const x = tr(a[0], env);
        const y = tr(a[1], env);
        return x.mul(y);
      }
      case 'div-floor': {
        need(2);
        // SMT-LIB div is floor division only for a positive divisor; require a positive literal.
        const d = a[1];
        if (d.k !== 'int' || d.v <= 0n) throw new Unsupported('divisor must be a positive literal');
        return tr(a[0], env).div(Int.val(d.v));
      }
      case 'neg': need(1); return Int.val(0).sub(tr(a[0], env));
      case 'min': { need(2); const x = tr(a[0], env), y = tr(a[1], env); return If(x.le(y), x, y); }
      case 'max': { need(2); const x = tr(a[0], env), y = tr(a[1], env); return If(x.ge(y), x, y); }
      case '<=': case '<': case '>=': case '>': case '=': {
        if (a.length < 2) throw new Unsupported(`${e.fn} arity`);
        const ts = a.map((x) => tr(x, env));
        const rel = (x: Term, y: Term) => (e.fn === '<=' ? x.le(y) : e.fn === '<' ? x.lt(y) : e.fn === '>=' ? x.ge(y) : e.fn === '>' ? x.gt(y) : x.eq(y));
        const parts = ts.slice(1).map((y, i) => rel(ts[i], y));
        return parts.length === 1 ? parts[0] : And(...parts);
      }
      case 'and': return And(...a.map((x) => bool(tr(x, env))));
      case 'or': return Or(...a.map((x) => bool(tr(x, env))));
      case 'not': need(1); return Not(bool(tr(a[0], env)));
    }
    const callee = prog.fns.get(e.fn);
    if (callee) {
      const ro = resolveType(prog, callee.out);
      if (ro.k !== 'int') throw new Unsupported(`${e.fn} returns a non-number`);
      const key = printExpr(e);
      let c = uf.get(key);
      if (!c) {
        c = Int.const(`call_${uf.size}_${e.fn}`);
        uf.set(key, c);
        constrain(callee.out, c);
      }
      return c;
    }
    throw new Unsupported(`${e.fn}`);
  }

  const outKind = scalarKind(f.out);
  if (outKind !== 'int') throw new Unsupported('function does not return a number');
  const outConst = Int.const('out');
  // Deliberately NOT constrained to f.out's range: that range is itself an obligation, and assuming it
  // would make the proof vacuous whenever the body can leave the range.
  for (const r of f.requires) solver.add(bool(tr(r, env0)));
  solver.add(outConst.eq(tr(f.body, env0)));
  const env1: Env = new Map(env0);
  env1.set('out', { t: outConst, type: f.out });
  const goal = bool(tr(f.ensures[index], env1));
  solver.add(Not(goal as ReturnType<typeof Bool.const>));
  const res = await solver.check();
  if (res === 'unsat') return { status: 'proved', note: `SMT: unsat for the negation (${uf.size} abstracted call(s))` };
  if (res === 'sat') {
    const m = solver.model();
    const show = (n: string, c: unknown) => {
      const v = m.eval(c as any).toString();
      const p = f.params.find((q) => q.name === n);
      const r = p ? resolveType(prog, p.type) : null;
      return `${n}=${r && r.k === 'enum' ? (r.cases[Number(v)] ?? v) : v}`;
    };
    const bits = [...consts.entries(), ...uf.entries(), ['out', outConst] as const].map(([n, c]) => show(n, c));
    return { status: 'counterexample', note: `SMT counterexample (may be spurious if a call was abstracted): ${bits.join(', ')}` };
  }
  return { status: 'unknown', note: 'SMT returned unknown' };
}
