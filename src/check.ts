// Static checker: one abstract interpreter over a product domain
//   (integer intervals) x (confidentiality/integrity labels with provenance).
//
// Outputs:
//   * obligations (range, bounds, division, ensures) with proved/unproved/failed status
//   * diagnostics (capability misuse, flow violations as counterexample paths, arity/name errors)
//   * a flow matrix: labelled source field -> sinks reached
//   * the derived machine representation of each function's arithmetic
//
// Limits (deliberate, for the spike): intervals only (no relational reasoning), no recursion,
// declassifiers only as human-declared policy entries, no covert channels, capability rows must be declared rather than inferred.

import { Expr, FnDef, Policy, Program, Type, asDeclassify, resolveType } from './ast.js';
import { CAP_OPS, KIND_TARGETS, isBuiltin, kindOfHandle } from './caps.js';
import * as I from './interval.js';
import { Interval } from './interval.js';
import * as L from './labels.js';
import { Label } from './labels.js';
import { Conf } from './ast.js';
import { printExpr } from './print/sexp.js';

export type Status = 'proved' | 'unproved' | 'failed';

export interface Obligation {
  fn: string;
  id: string;
  kind: 'range' | 'bounds' | 'div' | 'ensures' | 'tag';
  desc: string;
  status: Status;
  note?: string;
}

export interface Diag {
  level: 'error' | 'warn';
  code: string;
  fn: string;
  msg: string;
  paths?: { src: string; path: string[] }[];
}

export interface FlowEdge {
  src: string;
  sink: string;
  ok: boolean;
  path: string[];
  /** Declassifiers this flow passed through (with the policy's reason); absent for a direct flow. */
  via?: { name: string; reason: string }[];
}

export interface FnEvidence {
  fn: string;
  obligations: Obligation[];
  maxAbs: bigint | null;
  repr: I.Repr;
}

export interface CheckResult {
  diags: Diag[];
  evidence: Map<string, FnEvidence>;
  flows: FlowEdge[];
  manifest: { fn: string; needs: string[]; declassifies: { name: string; reason: string }[] }[];
}

// ---------------------------------------------------------------------------
// Abstract values
// ---------------------------------------------------------------------------

interface AV {
  num?: Interval;
  len?: Interval;
  elem?: AV;
  fields?: Map<string, AV>;
  tags?: Set<string>;
  res?: { ok?: AV; err?: AV };
  handle?: string;
  lab: Label;
}

const mk = (p: Partial<AV> = {}): AV => ({ lab: L.bottom(), ...p });
const unitAV = (): AV => mk();
const topAV = (): AV => mk();

function mapLabels(a: AV, f: (l: Label) => Label): AV {
  return {
    ...a,
    lab: f(a.lab),
    elem: a.elem && mapLabels(a.elem, f),
    fields: a.fields && new Map([...a.fields].map(([k, v]) => [k, mapLabels(v, f)])),
    res: a.res && { ok: a.res.ok && mapLabels(a.res.ok, f), err: a.res.err && mapLabels(a.res.err, f) },
  };
}

function flatten(a: AV): Label {
  let l = a.lab;
  if (a.elem) l = L.join(l, flatten(a.elem));
  if (a.fields) for (const v of a.fields.values()) l = L.join(l, flatten(v));
  if (a.res?.ok) l = L.join(l, flatten(a.res.ok));
  if (a.res?.err) l = L.join(l, flatten(a.res.err));
  return l;
}

function joinAV(a: AV, b: AV): AV {
  const r: AV = { lab: L.join(a.lab, b.lab) };
  if (a.num !== undefined || b.num !== undefined) r.num = a.num !== undefined && b.num !== undefined ? I.join(a.num, b.num) : I.TOP;
  if (a.len !== undefined || b.len !== undefined) r.len = a.len !== undefined && b.len !== undefined ? I.join(a.len, b.len) : I.TOP;
  if (a.elem || b.elem) r.elem = a.elem && b.elem ? joinAV(a.elem, b.elem) : (a.elem ?? b.elem);
  if (a.tags && b.tags) r.tags = new Set([...a.tags, ...b.tags]);
  if (a.fields && b.fields) {
    r.fields = new Map();
    for (const [k, v] of a.fields) r.fields.set(k, b.fields.has(k) ? joinAV(v, b.fields.get(k)!) : v);
  } else r.fields = a.fields ?? b.fields;
  if (a.res || b.res) {
    const ok = a.res?.ok && b.res?.ok ? joinAV(a.res.ok, b.res.ok) : (a.res?.ok ?? b.res?.ok);
    const err = a.res?.err && b.res?.err ? joinAV(a.res.err, b.res.err) : (a.res?.err ?? b.res?.err);
    r.res = { ok, err };
  }
  return r;
}

/** Abstract a declared type: ranges, list lengths, enum domains and field labels. */
function absOfType(p: Program, t: Type, typeName: string | undefined, at: string): AV {
  const nm = t.k === 'named' ? t.name : typeName;
  const r = resolveType(p, t);
  const lab = (integ: Label['integ']): Label => ({ conf: 'public', integ, srcs: new Map() });
  switch (r.k) {
    case 'int':
      return mk({ num: I.range(r.lo, r.hi), lab: lab('validated') });
    case 'bool':
      return mk({ lab: lab('validated') });
    case 'unit':
      return unitAV();
    case 'str':
      return mk({ lab: lab(r.validated ? 'validated' : 'untrusted'), ...(r.max !== undefined ? { len: I.range(0n, BigInt(r.max)) } : {}) });
    case 'enum':
      return mk({ tags: new Set(r.cases), lab: lab('validated') });
    case 'list':
      return mk({ len: I.range(BigInt(r.min), BigInt(r.max)), elem: absOfType(p, r.elem, undefined, `${at}[]`) });
    case 'result':
      return mk({ res: { ok: absOfType(p, r.ok, undefined, at), err: absOfType(p, r.err, undefined, at) } });
    case 'rec': {
      const fields = new Map<string, AV>();
      for (const f of r.fields) {
        let child = absOfType(p, f.type, undefined, `${at}.${f.name}`);
        if (f.conf !== 'public') {
          const src = `${nm ?? at}.${f.name}`;
          const sl = L.sourceLabel(src, f.conf, 'trusted', `${at}.${f.name}`);
          child = mapLabels(child, (l) => L.join(l, sl));
        }
        fields.set(f.name, child);
      }
      return mk({ fields });
    }
    case 'named':
      throw new Error('unreachable: resolveType removes named types');
  }
}

// ---------------------------------------------------------------------------
// Checker state
// ---------------------------------------------------------------------------

type Env = Map<string, AV>;

interface Ctx {
  prog: Program;
  pol: Policy;
  root: FnDef;
  cur: FnDef; // the function whose body is being evaluated (differs from root while inlining a callee)
  depth: number;
  report: boolean; // emit range obligations / magnitude tracking (root function only)
  pc: Label;
  acc: {
    diags: Diag[];
    obs: Obligation[];
    flows: FlowEdge[];
    maxAbs: bigint;
    seen: Set<string>;
    declUsed: Set<string>; // declassifiers applied lexically in the root function
    n: number;
  };
}

function diag(ctx: Ctx, level: Diag['level'], code: string, msg: string, paths?: Diag['paths']) {
  const key = `${ctx.root.name}|${code}|${msg}`;
  if (ctx.acc.seen.has(key)) return;
  ctx.acc.seen.add(key);
  ctx.acc.diags.push({ level, code, fn: ctx.root.name, msg, paths });
}

function oblige(ctx: Ctx, kind: Obligation['kind'], desc: string, status: Status, note?: string) {
  if (!ctx.report) return;
  ctx.acc.obs.push({ fn: ctx.root.name, id: `${ctx.root.name}#${++ctx.acc.n}`, kind, desc, status, note });
}

function track(ctx: Ctx, iv: Interval): Interval {
  if (ctx.report) {
    const m = I.maxAbs(iv);
    if (m !== null && m > ctx.acc.maxAbs) ctx.acc.maxAbs = m;
    if (m === null) ctx.acc.maxAbs = BigInt('1' + '0'.repeat(40));
  }
  return iv;
}

const MAX_INLINE_DEPTH = 8;

// ---------------------------------------------------------------------------
// Conformance of an abstract value to a declared type (range / bounds / tag obligations)
// ---------------------------------------------------------------------------

function conforms(ctx: Ctx, a: AV | undefined, t: Type, where: string): void {
  if (!ctx.report) return;
  const r = resolveType(ctx.prog, t);
  switch (r.k) {
    case 'int': {
      const bound = { lo: r.lo, hi: r.hi };
      const num = a?.num;
      const desc = `${where} in ${I.showInterval(bound)}`;
      if (num === undefined || num === 'top') oblige(ctx, 'range', desc, 'unproved', 'value is unbounded or untracked');
      else if (I.within(num, bound)) oblige(ctx, 'range', desc, 'proved', `inferred ${I.showInterval(num)}`);
      else {
        const disjoint = num.hi < bound.lo || num.lo > bound.hi;
        oblige(ctx, 'range', desc, disjoint ? 'failed' : 'unproved', `inferred ${I.showInterval(num)}`);
      }
      return;
    }
    case 'str': {
      if (r.max === undefined) return;
      const bound = I.range(0n, BigInt(r.max));
      const desc = `${where}.length in ${I.showInterval(bound)}`;
      if (!a || a.len === undefined || a.len === 'top') oblige(ctx, 'bounds', desc, 'unproved', 'length untracked');
      else oblige(ctx, 'bounds', desc, I.within(a.len, bound) ? 'proved' : 'unproved', `inferred ${I.showInterval(a.len)}`);
      return;
    }
    case 'list': {
      const bound = I.range(BigInt(r.min), BigInt(r.max));
      const desc = `${where}.length in ${I.showInterval(bound)}`;
      if (!a || a.len === undefined || a.len === 'top') oblige(ctx, 'bounds', desc, 'unproved', 'length untracked');
      else oblige(ctx, 'bounds', desc, I.within(a.len, bound) ? 'proved' : 'unproved', `inferred ${I.showInterval(a.len)}`);
      if (a?.elem) conforms(ctx, a.elem, r.elem, `${where}[]`);
      return;
    }
    case 'enum': {
      if (!a?.tags) return;
      const bad = [...a.tags].filter((x) => !r.cases.includes(x));
      oblige(ctx, 'tag', `${where} is one of ${r.cases.join('|')}`, bad.length ? 'failed' : 'proved', bad.length ? `unexpected ${bad.join(',')}` : undefined);
      return;
    }
    case 'rec': {
      if (!a?.fields) return;
      for (const f of r.fields) conforms(ctx, a.fields.get(f.name), f.type, `${where}.${f.name}`);
      return;
    }
    case 'result': {
      if (a?.res?.ok) conforms(ctx, a.res.ok, r.ok, `${where}.ok`);
      if (a?.res?.err) conforms(ctx, a.res.err, r.err, `${where}.err`);
      return;
    }
    default:
      return;
  }
}

/** Use the caller's actual value, narrowed by the declared parameter type (assume-guarantee). */
function narrow(actual: AV, declared: AV): AV {
  const r: AV = { ...actual };
  if (declared.num !== undefined) r.num = actual.num === undefined ? declared.num : I.meet(actual.num, declared.num);
  if (declared.len !== undefined) r.len = actual.len === undefined ? declared.len : I.meet(actual.len, declared.len);
  if (declared.elem) r.elem = actual.elem ? narrow(actual.elem, declared.elem) : declared.elem;
  if (declared.tags && !actual.tags) r.tags = declared.tags;
  if (declared.fields) {
    r.fields = new Map();
    for (const [k, dv] of declared.fields) {
      const av = actual.fields?.get(k);
      r.fields.set(k, av ? narrow(av, dv) : dv);
    }
  }
  if (declared.res && !actual.res) r.res = declared.res;
  return r;
}

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

const lit = (p: Partial<AV>): AV => mk({ ...p, lab: { conf: 'public', integ: 'trusted', srcs: new Map() } });

function evalExpr(e: Expr, env: Env, ctx: Ctx): AV {
  switch (e.k) {
    case 'int':
      return lit({ num: track(ctx, I.point(e.v)) });
    case 'str':
      return lit({});
    case 'bool':
      return lit({});
    case 'var':
      return evalVar(e, env, ctx);
    case 'let': {
      const env2 = new Map(env);
      for (const b of e.binds) env2.set(b.name, evalExpr(b.value, env2, ctx));
      let last = unitAV();
      for (const b of e.body) last = evalExpr(b, env2, ctx);
      return last;
    }
    case 'do': {
      let last = unitAV();
      for (const b of e.body) last = evalExpr(b, env, ctx);
      return last;
    }
    case 'try': {
      const r = evalExpr(e.expr, env, ctx);
      const out = resolveType(ctx.prog, ctx.root.out);
      if (out.k !== 'result') diag(ctx, 'error', 'E-try', `try in ${ctx.root.name}, whose result type is not a Result`);
      else {
        const errT = resolveType(ctx.prog, out.err);
        if (errT.k === 'enum' && !errT.cases.includes(e.onErr)) diag(ctx, 'error', 'E-try', `:on-err ${e.onErr} is not a case of ${printType(out.err)}`);
      }
      return r.res?.ok ?? unitAV();
    }
    case 'if': {
      const c = evalExpr(e.cond, env, ctx);
      const cl = flatten(c);
      const ctx2 = { ...ctx, pc: L.join(ctx.pc, cl) };
      const t = evalExpr(e.then, env, ctx2);
      const f = evalExpr(e.else, env, ctx2);
      return mapLabels(joinAV(t, f), (l) => L.join(l, cl));
    }
    case 'match':
      return evalMatch(e, env, ctx);
    case 'lam':
      diag(ctx, 'error', 'E-lambda', 'lambda is only allowed as an argument of map/filter');
      return topAV();
    case 'call':
      return evalCall(e, env, ctx);
  }
}

function printType(t: Type): string {
  return t.k === 'named' ? t.name : t.k;
}

function evalVar(e: Extract<Expr, { k: 'var' }>, env: Env, ctx: Ctx): AV {
  let cur: AV | undefined = env.get(e.name);
  if (!cur) {
    // enum case literal?
    for (const t of ctx.prog.types.values()) {
      if (t.k === 'enum' && t.cases.includes(e.name) && e.path.length === 0) return lit({ tags: new Set([e.name]) });
    }
    if (ctx.root.needs.includes(e.name) || ctx.prog.binds.has(e.name)) return mk({ handle: e.name });
    diag(ctx, 'error', 'E-name', `unknown name ${e.name}`);
    return topAV();
  }
  for (const f of e.path) {
    if (!cur.fields || !cur.fields.has(f)) {
      diag(ctx, 'error', 'E-field', `no field ${f} on ${printExpr({ ...e, path: e.path.slice(0, e.path.indexOf(f)) })}`);
      return topAV();
    }
    const child: AV = cur.fields.get(f)!;
    const parent: Label = cur.lab;
    cur = mapLabels(child, (l) => L.join(l, parent));
  }
  return cur;
}

function evalMatch(e: Extract<Expr, { k: 'match' }>, env: Env, ctx: Ctx): AV {
  const s = evalExpr(e.scrut, env, ctx);
  const sl = flatten(s);
  const ctx2 = { ...ctx, pc: L.join(ctx.pc, sl) };
  const armTags = e.arms.map((a) => a.tag);

  if (s.tags) {
    const missing = [...s.tags].filter((t) => !armTags.includes(t));
    if (missing.length) diag(ctx, 'error', 'E-match', `non-exhaustive match on ${printExpr(e.scrut)}: missing ${missing.join(', ')}`);
    const stray = armTags.filter((t) => !s.tags!.has(t) && t !== 'ok' && t !== 'err');
    if (stray.length) diag(ctx, 'warn', 'E-match', `arm(s) ${stray.join(', ')} can never match ${printExpr(e.scrut)}`);
  }

  let acc: AV | undefined;
  for (const a of e.arms) {
    if (s.tags && !s.tags.has(a.tag) && a.tag !== 'ok' && a.tag !== 'err') continue;
    const env2 = new Map(env);
    if (a.bind) {
      const payload = a.tag === 'ok' ? s.res?.ok : a.tag === 'err' ? s.res?.err : undefined;
      env2.set(a.bind, payload ?? topAV());
    }
    const r = evalExpr(a.body, env2, ctx2);
    acc = acc ? joinAV(acc, r) : r;
  }
  return mapLabels(acc ?? topAV(), (l) => L.join(l, sl));
}

function evalCall(e: Extract<Expr, { k: 'call' }>, env: Env, ctx: Ctx): AV {
  const name = e.fn;

  // --- declassification (policy-declared, explicit, named) --------------------
  if (name === 'declassify') return evalDeclassify(e, env, ctx);

  // --- capability operations -------------------------------------------------
  if (name in CAP_OPS) return evalOp(e, env, ctx);

  // --- record construction ---------------------------------------------------
  const td = ctx.prog.types.get(name);
  if (td) {
    const r = resolveType(ctx.prog, td);
    if (r.k === 'rec') return construct(e, name, r, env, ctx);
    diag(ctx, 'error', 'E-name', `${name} is a type but not a record type`);
    return topAV();
  }

  // --- user functions --------------------------------------------------------
  const uf = ctx.prog.fns.get(name);
  if (uf) {
    if (e.kw.length) diag(ctx, 'error', 'E-arity', `${name} takes positional arguments`);
    const args = e.args.map((a) => evalExpr(a, env, ctx));
    return callFn(uf, args, e, ctx);
  }

  if (!isBuiltin(name)) {
    diag(ctx, 'error', 'E-name', `unknown function ${name}`);
    return topAV();
  }
  return evalBuiltin(e, env, ctx);
}

function callFn(f: FnDef, args: AV[], site: Expr, ctx: Ctx): AV {
  if (args.length !== f.params.length) {
    diag(ctx, 'error', 'E-arity', `${f.name} expects ${f.params.length} argument(s), got ${args.length} in ${printExpr(site)}`);
    return topAV();
  }
  for (const n of f.needs) {
    if (!ctx.root.needs.includes(n)) diag(ctx, 'error', 'E-cap', `${ctx.root.name} calls ${f.name}, which needs ${n}, but does not declare it in needs`);
  }
  const env: Env = new Map();
  f.params.forEach((p, i) => {
    conforms(ctx, args[i], p.type, `${f.name}(${p.name})`);
    env.set(p.name, narrow(args[i], absOfType(ctx.prog, p.type, undefined, p.name)));
  });
  if (ctx.depth >= MAX_INLINE_DEPTH) {
    diag(ctx, 'warn', 'W-depth', `inlining depth limit reached at ${f.name}; result is unconstrained`);
    return topAV();
  }
  const sub: Ctx = { ...ctx, cur: f, depth: ctx.depth + 1, report: false };
  const r = evalExpr(f.body, env, sub);
  return mapLabels(r, (l) => L.step(l, `${f.name}()`));
}

/** Does labelled source `Type.field` hold data above `to`? Unknown sources are treated as needing release. */
function sourceNeedsRelease(prog: Program, src: string, to: Conf): boolean {
  const [tn, fn] = src.split('.');
  const t = prog.types.get(tn);
  if (!t || !fn) return true;
  const r = resolveType(prog, t);
  const f = r.k === 'rec' ? r.fields.find((x) => x.name === fn) : undefined;
  return f ? !L.confLE(f.conf, to) : true;
}

/**
 * (declassify name expr): controlled release. Only the policy can create a declassifier; the code can only
 * name one. Lowers confidentiality from `from` (or below) to `to`, leaves integrity alone, and leaves the
 * implicit-flow label (ctx.pc) alone, so a release under a secret branch still carries the branch label.
 */
function evalDeclassify(e: Extract<Expr, { k: 'call' }>, env: Env, ctx: Ctx): AV {
  const d = asDeclassify(e);
  if (!d) {
    diag(ctx, 'error', 'E-arity', `declassify is (declassify name expr), got ${printExpr(e)}`);
    e.args.slice(1).forEach((a) => evalExpr(a, env, ctx));
    return topAV();
  }
  const v = evalExpr(d.expr, env, ctx);
  const decl = ctx.pol.declassifiers.get(d.name);
  if (!decl) {
    diag(ctx, 'error', 'E-policy', `declassifier ${d.name} is not declared in the policy (code cannot invent declassifiers)`);
    return v; // labels unchanged: the leak will also be reported where it lands
  }
  if (ctx.depth === 0) {
    ctx.acc.declUsed.add(d.name);
    if (!ctx.cur.declassifies.includes(d.name)) {
      diag(ctx, 'error', 'E-declassify', `${ctx.cur.name} applies declassifier ${d.name} but does not declare it in (declassifies ...)`);
    }
  }
  if (decl.fns && !decl.fns.includes(ctx.cur.name)) {
    diag(ctx, 'error', 'E-policy', `declassifier ${d.name} may only be used in ${decl.fns.join(', ')}, not ${ctx.cur.name}`);
  }
  const fl = flatten(v);
  if (decl.fields) {
    const stray = [...fl.srcs.keys()].filter((s) => !decl.fields!.includes(s));
    if (stray.length) {
      diag(ctx, 'error', 'E-policy', `declassifier ${d.name} is restricted to ${decl.fields.join(', ')}, but ${printExpr(d.expr)} carries ${stray.join(', ')}`);
    }
  }
  if (!L.confLE(fl.conf, decl.from)) {
    diag(
      ctx,
      'error',
      'E-flow',
      `${fl.conf} data reaches declassifier ${d.name}, which releases only up to ${decl.from} (value: ${printExpr(d.expr)})`,
      [...fl.srcs].map(([src, path]) => ({ src, path: [...path, `-> declassify ${d.name}`] })),
    );
    return v; // not released
  }
  return mapLabels(v, (l) => L.declassifyLabel(l, decl.to, d.name, decl.from, (src) => sourceNeedsRelease(ctx.prog, src, decl.to)));
}

function viaOf(ctx: Ctx, path: string[]): FlowEdge['via'] {
  const names = [...new Set(L.viaNames(path))];
  return names.length ? names.map((name) => ({ name, reason: ctx.pol.declassifiers.get(name)?.reason ?? '' })) : undefined;
}

function construct(
  e: Extract<Expr, { k: 'call' }>,
  name: string,
  rec: Extract<Type, { k: 'rec' }>,
  env: Env,
  ctx: Ctx,
): AV {
  const fields = rec.fields;
  const exprs: (Expr | undefined)[] = new Array(fields.length).fill(undefined);
  if (e.args.length && e.kw.length) {
    diag(ctx, 'error', 'E-arity', `${name}: mixing positional and keyword arguments`);
    return topAV();
  }
  if (e.args.length) {
    if (e.args.length !== fields.length) {
      diag(ctx, 'error', 'E-arity', `${name} has ${fields.length} field(s), got ${e.args.length}`);
      return topAV();
    }
    e.args.forEach((a, i) => (exprs[i] = a));
  } else {
    for (const k of e.kw) {
      const i = fields.findIndex((f) => f.name === k.name);
      if (i < 0) diag(ctx, 'error', 'E-field', `${name} has no field ${k.name}`);
      else exprs[i] = k.value;
    }
    const missing = fields.filter((_, i) => !exprs[i]).map((f) => f.name);
    if (missing.length) {
      diag(ctx, 'error', 'E-arity', `${name} is missing field(s): ${missing.join(', ')}`);
      return topAV();
    }
  }

  const out = new Map<string, AV>();
  fields.forEach((f, i) => {
    const ex = exprs[i]!;
    const v = evalExpr(ex, env, ctx);
    const fl = flatten(v);
    const where = `${name}.${f.name}`;

    if (!L.confLE(fl.conf, f.conf)) {
      diag(
        ctx,
        'error',
        'E-flow',
        `${fl.conf} data flows into field ${where}, which is declared ${f.conf} (value: ${printExpr(ex)})`,
        [...fl.srcs].map(([src, path]) => ({ src, path: [...path, `-> ${where}`] })),
      );
    }
    const rt = resolveType(ctx.prog, f.type);
    const needsValidated = f.control || (rt.k === 'str' && rt.validated);
    if (needsValidated && !L.integGE(fl.integ, 'validated')) {
      diag(
        ctx,
        'error',
        'E-integrity',
        `${fl.integ} value ${printExpr(ex)} flows into ${f.control ? 'control' : 'validated'} field ${where}; it must come from a validator`,
        [...fl.srcs].map(([src, path]) => ({ src, path: [...path, `-> ${where}`] })),
      );
    }
    conforms(ctx, v, f.type, where);
    out.set(f.name, mapLabels(v, (l) => L.step(l, where)));
  });
  return mk({ fields: out });
}

function evalOp(e: Extract<Expr, { k: 'call' }>, env: Env, ctx: Ctx): AV {
  const op = CAP_OPS[e.fn];
  if (e.kw.length || e.args.length !== op.arity) {
    diag(ctx, 'error', 'E-arity', `${e.fn} expects ${op.arity} positional argument(s) (handle first), got ${e.args.length}`);
    return topAV();
  }
  const h = e.args[0];
  if (h.k !== 'var' || h.path.length) {
    diag(ctx, 'error', 'E-cap', `${e.fn}: first argument must be a capability handle`);
    return topAV();
  }
  const handle = h.name;
  if (!ctx.root.needs.includes(handle)) diag(ctx, 'error', 'E-cap', `${ctx.root.name} uses ${handle} but does not declare it in needs`);
  const bind = ctx.prog.binds.get(handle);
  if (!bind) diag(ctx, 'error', 'E-cap', `${handle} has no (bind ...) in the program wiring`);
  else if (bind.kind !== op.kind) diag(ctx, 'error', 'E-cap', `${e.fn} needs a ${op.kind} capability, but ${handle} is bound as ${bind.kind}`);
  if (kindOfHandle(handle) !== op.kind) diag(ctx, 'error', 'E-cap', `${e.fn} cannot operate on ${handle}`);

  const vals = e.args.slice(1).map((a) => evalExpr(a, env, ctx));
  const data = L.join(ctx.pc, L.joinAll(vals.map(flatten)));
  const sink = ctx.pol.sinks.get(handle) ?? { accepts: 'public' as const };
  const ok = L.confLE(data.conf, sink.accepts);
  for (const [src, path] of data.srcs) {
    if (ctx.report || ctx.depth > 0) ctx.acc.flows.push({ src, sink: handle, ok, path: [...path, `-> ${handle}`], via: viaOf(ctx, path) });
  }
  if (!ok) {
    diag(
      ctx,
      'error',
      'E-flow',
      `${data.conf} data reaches ${handle}, which accepts up to ${sink.accepts}${ctx.pol.sinks.has(handle) ? '' : ' (no sink policy: deny by default)'}`,
      [...data.srcs].map(([src, path]) => ({ src, path: [...path, `-> ${handle}`] })),
    );
  }

  switch (e.fn) {
    case 'put':
    case 'post':
      return mk({ res: { ok: unitAV() } });
    case 'emit':
      return unitAV();
    case 'fresh':
      return lit({ num: I.range(0n, 9007199254740991n) });
    default:
      return topAV();
  }
}

function evalBuiltin(e: Extract<Expr, { k: 'call' }>, env: Env, ctx: Ctx): AV {
  const name = e.fn;
  const ar = (n: number) => {
    if (e.args.length !== n || e.kw.length) {
      diag(ctx, 'error', 'E-arity', `${name} expects ${n} argument(s), got ${e.args.length} in ${printExpr(e)}`);
      return false;
    }
    return true;
  };
  const labOf = (xs: AV[]) => L.joinAll(xs.map(flatten));
  // Evaluate arguments first so one arity slip does not hide every other mistake in the call.
  const higherOrder = name === 'map' || name === 'filter' || name === 'fold';
  const xs: AV[] = higherOrder ? [] : e.args.map((a) => evalExpr(a, env, ctx));

  switch (name) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'div-floor':
    case 'min':
    case 'max': {
      if (!ar(2)) return topAV();
      const [a, b] = xs;
      for (const [v, i] of [[a, 0], [b, 1]] as const) {
        if (v.num === undefined && (v.len !== undefined || v.fields !== undefined || v.tags !== undefined || v.elem !== undefined)) {
          diag(ctx, 'error', 'E-type', `${name} expects a number for argument ${i + 1}, got a non-number in ${printExpr(e)}`);
        }
      }
      const x = a.num ?? I.TOP;
      const y = b.num ?? I.TOP;
      let r: Interval;
      switch (name) {
        case 'add':
          r = I.add(x, y);
          break;
        case 'sub':
          r = I.sub(x, y);
          break;
        case 'mul':
          r = I.mul(x, y);
          break;
        case 'min':
          r = I.imin(x, y);
          break;
        case 'max':
          r = I.imax(x, y);
          break;
        default: {
          const nz = !I.containsZero(y);
          oblige(ctx, 'div', `divisor ${printExpr(e.args[1])} is non-zero`, nz ? 'proved' : 'unproved', `divisor ${I.showInterval(y)}`);
          r = nz ? I.divFloor(x, y) : I.TOP;
        }
      }
      return mk({ num: track(ctx, r), lab: labOf([a, b]) });
    }
    case 'neg': {
      if (!ar(1)) return topAV();
      const a = xs[0];
      return mk({ num: track(ctx, I.neg(a.num ?? I.TOP)), lab: flatten(a) });
    }
    case 'sum': {
      if (!ar(1)) return topAV();
      const l = xs[0];
      const r = I.sumOf(l.len ?? I.TOP, l.elem?.num ?? I.TOP);
      return mk({ num: track(ctx, r), lab: flatten(l) });
    }
    case 'len': {
      if (!ar(1)) return topAV();
      const l = xs[0];
      return mk({ num: l.len ?? I.TOP, lab: l.lab });
    }
    case 'map':
    case 'filter': {
      if (!ar(2)) return topAV();
      const l = evalExpr(e.args[0], env, ctx);
      const f = e.args[1];
      if (f.k !== 'lam' || f.params.length !== 1) {
        diag(ctx, 'error', 'E-lambda', `${name} needs a one-parameter lambda as second argument`);
        return topAV();
      }
      const env2 = new Map(env);
      env2.set(f.params[0], l.elem ?? topAV());
      const r = evalExpr(f.body, env2, ctx);
      if (name === 'map') return mk({ len: l.len, elem: r, lab: l.lab });
      const hi = l.len === undefined || l.len === 'top' ? I.TOP : I.range(0n, l.len.hi);
      return mk({ len: hi, elem: l.elem, lab: L.join(l.lab, flatten(r)) });
    }
    case 'fold': {
      // (fold xs T init (fn (acc x) body)): T is the loop invariant. The initial value and every step result must
      // fit T (obligations); inside the body acc is assumed to be any value of T. The result is any value of T.
      if (!ar(4)) return topAV();
      const [xsE, tE, initE, f] = e.args;
      if (tE.k !== 'var' || tE.path.length || !ctx.prog.types.has(tE.name)) {
        diag(ctx, 'error', 'E-type', `fold: second argument must be the name of a declared type for the accumulator, in ${printExpr(e)}`);
        return topAV();
      }
      if (f.k !== 'lam' || f.params.length !== 2) {
        diag(ctx, 'error', 'E-lambda', 'fold needs a two-parameter lambda (fn (acc x) body) as fourth argument');
        return topAV();
      }
      const l = evalExpr(xsE, env, ctx);
      const init = evalExpr(initE, env, ctx);
      const T: Type = { k: 'named', name: tE.name };
      conforms(ctx, init, T, `fold initial value (${tE.name})`);
      const base = absOfType(ctx.prog, T, tE.name, 'fold accumulator');
      let lab = L.join(flatten(init), l.lab);
      const step = (c: Ctx): AV => {
        const env2 = new Map(env);
        env2.set(f.params[0], mapLabels(base, (x) => L.join(x, lab)));
        env2.set(f.params[1], l.elem ?? topAV());
        return evalExpr(f.body, env2, c);
      };
      const quiet = { ...ctx, report: false };
      for (let i = 0; i < 2; i++) lab = L.join(lab, flatten(step(quiet))); // labels only join, so two passes reach the fixpoint
      const r = step(ctx);
      conforms(ctx, r, T, `fold step result (${tE.name})`);
      const lab2 = L.join(lab, flatten(r));
      return mapLabels(base, (x) => L.join(x, lab2));
    }
    case 'chars': {
      if (!ar(1)) return topAV();
      const s = xs[0];
      if (s.len === undefined || s.len === 'top') {
        diag(ctx, 'error', 'E-type', `chars needs a string with a declared (Str :max N), in ${printExpr(e)}`);
        return topAV();
      }
      return mk({ len: s.len, elem: mk({ num: I.range(0n, 1114111n), lab: s.lab }), lab: s.lab });
    }
    case 'from-chars': {
      if (!ar(1)) return topAV();
      const l = xs[0];
      const cp = I.range(0n, 1114111n);
      const en = l.elem?.num;
      oblige(ctx, 'range', `from-chars elements are code points ${I.showInterval(cp)}`, en === undefined || en === 'top' ? 'unproved' : I.within(en, cp) ? 'proved' : 'unproved', en && en !== 'top' ? `inferred ${I.showInterval(en)}` : 'elements untracked');
      return mk({ len: l.len, lab: flatten(l) });
    }
    case 'append': {
      if (!ar(2)) return topAV();
      const [l, x] = xs;
      return mk({ len: I.add(l.len ?? I.TOP, I.point(1n)), elem: l.elem ? joinAV(l.elem, x) : x, lab: L.join(l.lab, flatten(x)) });
    }
    case 'take': {
      if (!ar(2)) return topAV();
      const [l, n] = xs;
      return mk({ len: I.imin(l.len ?? I.TOP, I.imax(n.num ?? I.TOP, I.point(0n))), elem: l.elem, lab: L.join(l.lab, flatten(n)) });
    }
    case 'drop': {
      if (!ar(2)) return topAV();
      const [l, n] = xs;
      return mk({ len: I.imax(I.point(0n), I.sub(l.len ?? I.TOP, I.imax(n.num ?? I.TOP, I.point(0n)))), elem: l.elem, lab: L.join(l.lab, flatten(n)) });
    }
    case 'at': {
      if (!ar(3)) return topAV();
      const [l, i, d] = xs;
      return l.elem ? joinAV({ ...l.elem, lab: L.join(l.elem.lab, flatten(i)) }, d) : mk({ lab: L.join(flatten(i), flatten(d)) });
    }
    case 'text':
      return mk({ lab: labOf(xs) });
    case 'money':
      if (!ar(1)) return topAV();
      return mk({ lab: labOf(xs) });
    case 'list': {
      const elem = xs.length ? xs.reduce(joinAV) : undefined;
      return mk({ len: I.point(BigInt(xs.length)), elem });
    }
    case '=':
    case '<=':
    case '<':
    case '>=':
    case '>':
    case 'and':
    case 'or':
    case 'not':
      return mk({ lab: labOf(xs) });
    case 'ok':
      if (!ar(1)) return topAV();
      return mk({ res: { ok: xs[0] } });
    case 'err':
      if (!ar(1)) return topAV();
      return mk({ res: { err: xs[0] } });
    default:
      diag(ctx, 'error', 'E-name', `builtin ${name} is not supported by the checker`);
      return topAV();
  }
}

// ---------------------------------------------------------------------------
// Three-valued evaluation of contract expressions
// ---------------------------------------------------------------------------

function evalTri(e: Expr, env: Env, ctx: Ctx): I.Tri {
  if (e.k === 'bool') return e.v ? 'true' : 'false';
  if (e.k !== 'call') return 'unknown';
  const quiet = { ...ctx, report: false };
  const nums = () => e.args.map((a) => evalExpr(a, env, quiet).num ?? I.TOP);
  switch (e.fn) {
    case '<=':
    case '<':
    case '>=':
    case '>': {
      const ns = nums();
      const rs: I.Tri[] = [];
      for (let i = 0; i + 1 < ns.length; i++) {
        const [a, b] = ns.slice(i, i + 2);
        rs.push(e.fn === '<=' ? I.triLE(a, b) : e.fn === '<' ? I.triLT(a, b) : e.fn === '>=' ? I.triLE(b, a) : I.triLT(b, a));
      }
      return I.triAnd(rs);
    }
    case '=': {
      const ns = nums();
      return ns.length === 2 ? I.triEQ(ns[0], ns[1]) : 'unknown';
    }
    case 'and':
      return I.triAnd(e.args.map((a) => evalTri(a, env, ctx)));
    case 'or':
      return I.triOr(e.args.map((a) => evalTri(a, env, ctx)));
    case 'not':
      return e.args.length === 1 ? I.triNot(evalTri(e.args[0], env, ctx)) : 'unknown';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Program-level checking
// ---------------------------------------------------------------------------

/** Parameter ranges count toward the representation width, not just arithmetic results. */
function trackAll(ctx: Ctx, av: AV | undefined, depth = 0): void {
  if (!av || depth > 6) return;
  if (av.num !== undefined && av.num !== 'top') track(ctx, av.num);
  av.fields?.forEach((f) => trackAll(ctx, f, depth + 1));
  trackAll(ctx, av.elem, depth + 1);
}

export function checkFn(prog: Program, pol: Policy, f: FnDef, into: CheckResult): void {
  const acc: Ctx['acc'] = { diags: into.diags, obs: [], flows: into.flows, maxAbs: 0n, seen: new Set(), declUsed: new Set(), n: 0 };
  const ctx: Ctx = { prog, pol, root: f, cur: f, depth: 0, report: true, pc: L.bottom(), acc };

  for (const n of f.needs) {
    if (!prog.binds.has(n)) diag(ctx, 'error', 'E-cap', `${f.name} needs ${n}, but the program wiring has no (bind ${n} ...)`);
  }

  for (const n of f.declassifies) {
    if (!pol.declassifiers.has(n)) diag(ctx, 'error', 'E-policy', `${f.name} declares declassifier ${n}, which is not declared in the policy`);
  }

  const env: Env = new Map();
  for (const p of f.params) {
    let av = absOfType(prog, p.type, undefined, p.name);
    // Entry parameters keep per-field labels but trusted envelopes.
    av = { ...av };
    env.set(p.name, av);
    trackAll(ctx, av);
  }

  const out = evalExpr(f.body, env, ctx);
  conforms(ctx, out, f.out, 'out');

  f.ensures.forEach((en, i) => {
    const env2 = new Map(env);
    env2.set('out', out);
    const t = evalTri(en, env2, ctx);
    const desc = `ensures ${printExpr(en)}`;
    if (t === 'true') oblige(ctx, 'ensures', desc, 'proved', 'by interval reasoning');
    else if (t === 'false') oblige(ctx, 'ensures', desc, 'failed', 'interval reasoning refutes it');
    else oblige(ctx, 'ensures', desc, 'unproved', 'intervals are not enough (relational property); needs SMT or tests');
    void i;
  });
  for (const n of f.declassifies) {
    if (pol.declassifiers.has(n) && !acc.declUsed.has(n)) diag(ctx, 'warn', 'W-declassify', `${f.name} declares declassifier ${n} but never applies it`);
  }
  if (f.requires.length) diag(ctx, 'warn', 'W-requires', 'requires clauses are not used by the interval analysis');

  into.evidence.set(f.name, {
    fn: f.name,
    obligations: acc.obs,
    maxAbs: acc.maxAbs === 0n ? null : acc.maxAbs,
    repr: acc.maxAbs === 0n ? 'i32' : I.reprFor(acc.maxAbs),
  });
}

function globMatch(pattern: string, value: string): boolean {
  return pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : pattern === value;
}

export function check(prog: Program, pol: Policy): CheckResult {
  const res: CheckResult = { diags: [], evidence: new Map(), flows: [], manifest: [] };
  const wiring = (code: string, msg: string, level: Diag['level'] = 'error') => res.diags.push({ level, code, fn: '(program)', msg });

  for (const f of prog.fns.values()) checkFn(prog, pol, f, res);

  for (const en of prog.entries) if (!prog.fns.has(en)) wiring('E-entry', `entry ${en} is not a function`);

  // Portability: every bound capability kind must exist on every declared target.
  for (const b of prog.binds.values()) {
    const avail = KIND_TARGETS[b.kind];
    if (!avail) {
      wiring('E-cap', `unknown capability kind ${b.kind} (${b.handle})`);
      continue;
    }
    for (const t of prog.targets) {
      if (!avail.includes(t)) wiring('E-target', `${b.handle} (${b.kind}) is not available on target ${t}`);
    }
  }

  // Policy ceiling: bindings may not exceed what the policy allows.
  for (const b of prog.binds.values()) {
    const rules = pol.allow.filter((a) => a.kind === b.kind);
    if (!rules.length) {
      wiring('E-policy', `${b.handle}: capability kind ${b.kind} is not allowed by policy`);
      continue;
    }
    const okRule = rules.some((r) => {
      if (!r.key || r.pattern === undefined) return true;
      const vals = b.caveats[r.key];
      return !!vals && vals.length > 0 && vals.every((v) => globMatch(r.pattern!, v));
    });
    if (!okRule) wiring('E-policy', `${b.handle}: ${JSON.stringify(b.caveats)} exceeds the policy ceiling for ${b.kind}`);
  }

  // Manifest: what each capability-using function may touch.
  for (const f of prog.fns.values()) {
    if (f.needs.length || f.declassifies.length) {
      res.manifest.push({
        fn: f.name,
        needs: f.needs,
        declassifies: f.declassifies.map((name) => ({ name, reason: pol.declassifiers.get(name)?.reason ?? '(undeclared)' })),
      });
    }
  }

  // De-duplicate flow edges (keep shortest path per src->sink, preferring violations).
  const best = new Map<string, FlowEdge>();
  for (const fe of res.flows) {
    const k = `${fe.src}|${fe.sink}`;
    const cur = best.get(k);
    // Prefer violations, then direct flows over declassified ones (a direct flow is the stronger claim), then shorter paths.
    const viaRank = (x: FlowEdge) => (x.via ? 1 : 0);
    if (!cur || (!fe.ok && cur.ok) || (fe.ok === cur.ok && (viaRank(fe) < viaRank(cur) || (viaRank(fe) === viaRank(cur) && fe.path.length < cur.path.length)))) best.set(k, fe);
  }
  res.flows = [...best.values()];
  return res;
}

export function errors(r: CheckResult): Diag[] {
  return r.diags.filter((d) => d.level === 'error');
}
