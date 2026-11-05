// Reference interpreter. It is the executable semantics of the core: scenarios, property tests,
// noninterference runs and mutation testing all execute on it. Effects go through a mock Host,
// so every run is deterministic and its effect trace is observable.

import { Expr, FnDef, Program, Type, resolveType } from './ast.js';
import { CAP_OPS, RANGE_MAX } from './caps.js';
import { printExpr } from './print/sexp.js';

export type Val =
  | bigint
  | string
  | boolean
  | null // unit
  | { $: 'enum'; tag: string }
  | { $: 'rec'; type: string; fields: Record<string, Val> }
  | { $: 'ok'; v: Val }
  | { $: 'err'; v: Val }
  | Val[];

export const UNIT: Val = null;
export const enumVal = (tag: string): Val => ({ $: 'enum', tag });
export const okVal = (v: Val): Val => ({ $: 'ok', v });
export const errVal = (v: Val): Val => ({ $: 'err', v });

/**
 * Why a value failed its declared type (set on `type` violations; shared with the Wasm backend, which reports the
 * same reasons from its validating export wrappers, see src/wasm/validate.ts):
 *   range        an Int outside its declared [lo, hi]
 *   str-max      a Str longer than its declared :max (in code points)
 *   enum         not one of the enum's cases
 *   list-length  a list length outside its declared [min, max]
 *   type         a value of the wrong kind (not an Int, Str, Bool, record, list or Result)
 * Only a compiled module raises the last two, for raw arguments that no Sigil value encodes to:
 *   encoding     the inactive side of a Result argument is not all zero
 *   memory       a list argument or the scratch base lies outside the module's memory layout
 */
export type ContractReason = 'range' | 'str-max' | 'enum' | 'list-length' | 'type' | 'encoding' | 'memory';

export class ContractViolation extends Error {
  constructor(
    public kind: 'type' | 'requires' | 'ensures',
    msg: string,
    /** For `type` violations: the reason, and where the value sits (e.g. "f(req).size", "f(xs)[3].qty"). */
    public reason?: ContractReason,
    public where?: string,
  ) {
    super(msg);
    this.name = 'ContractViolation';
  }
}
export class RuntimeFault extends Error {}
class EarlyReturn {
  constructor(public value: Val) {}
}

export function showVal(v: Val): string {
  if (v === null) return 'unit';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(showVal).join(', ')}]`;
  switch (v.$) {
    case 'enum':
      return v.tag;
    case 'ok':
      return `(ok ${showVal(v.v)})`;
    case 'err':
      return `(err ${showVal(v.v)})`;
    case 'rec':
      return `${v.type}{${Object.entries(v.fields)
        .map(([k, x]) => `${k}: ${showVal(x)}`)
        .join(', ')}}`;
  }
}

/** `(money cents)`: "$12.34" (shared with the Wasm host adapter so both render identically). */
export function moneyStr(c: bigint): string {
  const abs = c < 0n ? -c : c;
  return `${c < 0n ? '-' : ''}$${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export function eqVal(a: Val, b: Val): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => eqVal(x, b[i]));
  }
  if (a.$ !== b.$) return false;
  switch (a.$) {
    case 'enum':
      return a.tag === (b as typeof a).tag;
    case 'ok':
    case 'err':
      return eqVal(a.v, (b as typeof a).v);
    case 'rec': {
      const bb = b as typeof a;
      const ka = Object.keys(a.fields);
      return a.type === bb.type && ka.length === Object.keys(bb.fields).length && ka.every((k) => k in bb.fields && eqVal(a.fields[k], bb.fields[k]));
    }
  }
}

// ---------------------------------------------------------------------------
// Host: mock capabilities with a full observation log
// ---------------------------------------------------------------------------

export interface Observation {
  handle: string;
  op: string;
  args: Val[];
  ok: boolean;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Host {
  log: Observation[] = [];
  failing = new Set<string>(); // "handle.op"
  private rnd: () => number;
  constructor(seed = 1) {
    this.rnd = mulberry32(seed);
  }
  fail(handle: string, op: string) {
    this.failing.add(`${handle}.${op}`);
  }
  sent(handle: string): Val[] {
    return this.log.filter((o) => o.handle === handle && o.op === 'post' && o.ok).map((o) => o.args[0]);
  }
  stored(handle: string): Val[] {
    return this.log.filter((o) => o.handle === handle && o.op === 'put' && o.ok).map((o) => o.args[1]);
  }
  emitted(handle: string): Val[] {
    return this.log.filter((o) => o.handle === handle && o.op === 'emit' && o.ok).map((o) => o.args[0]);
  }
  call(handle: string, op: string, args: Val[]): Val {
    if (this.failing.has(`${handle}.${op}`)) {
      this.log.push({ handle, op, args, ok: false });
      return errVal(UNIT);
    }
    this.log.push({ handle, op, args, ok: true });
    switch (op) {
      case 'put':
      case 'post':
        return okVal(UNIT);
      case 'emit':
        return UNIT;
      case 'fresh':
        return BigInt(Math.floor(this.rnd() * Number.MAX_SAFE_INTEGER));
      default:
        throw new RuntimeFault(`host: unsupported op ${op}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

type Env = Map<string, Val>;
interface Closure {
  params: string[];
  body: Expr;
  env: Env;
}

export interface InterpOptions {
  contracts: boolean; // check ranges, requires and ensures at runtime
  fuel: number;
}

export class Interp {
  fuel: number;
  ensuresStats = new Map<string, number>(); // "fn#i" -> number of passing runtime checks
  constructor(
    public prog: Program,
    public host: Host,
    public opts: InterpOptions = { contracts: true, fuel: 5_000_000 },
  ) {
    this.fuel = opts.fuel;
  }

  // --- type conformance (runtime contract check) -------------------------------
  checkType(v: Val, t: Type, where: string): void {
    if (!this.opts.contracts) return;
    const r = resolveType(this.prog, t);
    const bad = (m: string, reason: ContractReason = 'type') => {
      throw new ContractViolation('type', `${where}: ${m}`, reason, where);
    };
    switch (r.k) {
      case 'int':
        if (typeof v !== 'bigint') return bad(`expected Int, got ${showVal(v)}`);
        if (v < r.lo || v > r.hi) return bad(`${v} outside [${r.lo}, ${r.hi}]`, 'range');
        return;
      case 'str':
        if (typeof v !== 'string') return bad(`expected Str, got ${showVal(v)}`);
        if (r.max !== undefined && Array.from(v).length > r.max) bad(`string of ${Array.from(v).length} characters exceeds :max ${r.max}`, 'str-max');
        return;
      case 'bool':
        if (typeof v !== 'boolean') bad('expected Bool');
        return;
      case 'unit':
        return;
      case 'enum':
        if (!v || typeof v !== 'object' || Array.isArray(v) || v.$ !== 'enum' || !r.cases.includes(v.tag)) bad(`expected one of ${r.cases.join('|')}, got ${showVal(v)}`, 'enum');
        return;
      case 'list':
        if (!Array.isArray(v)) return bad('expected list');
        if (v.length < r.min || v.length > r.max) return bad(`length ${v.length} outside [${r.min}, ${r.max}]`, 'list-length');
        v.forEach((x, i) => this.checkType(x, r.elem, `${where}[${i}]`));
        return;
      case 'rec':
        if (!v || typeof v !== 'object' || Array.isArray(v) || v.$ !== 'rec') return bad(`expected record, got ${showVal(v)}`);
        for (const f of r.fields) this.checkType(v.fields[f.name], f.type, `${where}.${f.name}`);
        return;
      case 'result':
        if (!v || typeof v !== 'object' || Array.isArray(v) || (v.$ !== 'ok' && v.$ !== 'err')) return bad('expected Result');
        this.checkType(v.v, v.$ === 'ok' ? r.ok : r.err, `${where}.${v.$}`);
        return;
      default:
        return;
    }
  }

  // --- function calls ----------------------------------------------------------
  callFn(name: string, args: Val[]): Val {
    const f = this.prog.fns.get(name);
    if (!f) throw new RuntimeFault(`unknown function ${name}`);
    return this.apply(f, args);
  }

  private apply(f: FnDef, args: Val[]): Val {
    if (args.length !== f.params.length) throw new RuntimeFault(`${f.name}: arity ${f.params.length} expected, got ${args.length}`);
    const env: Env = new Map();
    f.params.forEach((p, i) => {
      this.checkType(args[i], p.type, `${f.name}(${p.name})`);
      env.set(p.name, args[i]);
    });
    if (this.opts.contracts) {
      for (const r of f.requires) {
        if (this.eval(r, env) !== true) throw new ContractViolation('requires', `${f.name}: requires ${printExpr(r)} violated`);
      }
    }
    let out: Val;
    try {
      out = this.eval(f.body, env);
    } catch (e) {
      if (e instanceof EarlyReturn) out = e.value;
      else throw e;
    }
    this.checkType(out, f.out, `${f.name}.out`);
    if (this.opts.contracts && f.ensures.length) {
      const env2 = new Map(env);
      env2.set('out', out);
      for (const [i, en] of f.ensures.entries()) {
        if (this.eval(en, env2) !== true) {
          throw new ContractViolation('ensures', `${f.name}: ensures ${printExpr(en)} violated (out=${showVal(out)}, ${[...env].map(([k, v]) => `${k}=${showVal(v)}`).join(', ').slice(0, 200)})`);
        }
        const key = `${f.name}#${i}`;
        this.ensuresStats.set(key, (this.ensuresStats.get(key) ?? 0) + 1);
      }
    }
    return out;
  }

  // --- expressions -------------------------------------------------------------
  eval(e: Expr, env: Env): Val {
    if (--this.fuel < 0) throw new RuntimeFault('out of fuel');
    switch (e.k) {
      case 'int':
        return e.v;
      case 'str':
        return e.v;
      case 'bool':
        return e.v;
      case 'var':
        return this.evalVar(e, env);
      case 'let': {
        const env2 = new Map(env);
        for (const b of e.binds) env2.set(b.name, this.eval(b.value, env2));
        let last: Val = UNIT;
        for (const b of e.body) last = this.eval(b, env2);
        return last;
      }
      case 'do': {
        let last: Val = UNIT;
        for (const b of e.body) last = this.eval(b, env);
        return last;
      }
      case 'try': {
        const r = this.eval(e.expr, env);
        if (r && typeof r === 'object' && !Array.isArray(r) && r.$ === 'err') throw new EarlyReturn(errVal(enumVal(e.onErr)));
        if (r && typeof r === 'object' && !Array.isArray(r) && r.$ === 'ok') return r.v;
        throw new RuntimeFault(`try applied to a non-Result: ${showVal(r)}`);
      }
      case 'if': {
        const c = this.eval(e.cond, env);
        if (typeof c !== 'boolean') throw new RuntimeFault('if condition is not a Bool');
        return this.eval(c ? e.then : e.else, env);
      }
      case 'match':
        return this.evalMatch(e, env);
      case 'lam':
        throw new RuntimeFault('lambda is not a first-class value');
      case 'call':
        return this.evalCall(e, env);
    }
  }

  private evalVar(e: Extract<Expr, { k: 'var' }>, env: Env): Val {
    let cur: Val;
    if (env.has(e.name)) cur = env.get(e.name)!;
    else if (e.path.length === 0 && this.isEnumCase(e.name)) return enumVal(e.name);
    else if (e.path.length === 0 && (this.prog.binds.has(e.name) || e.name.includes(':') || e.name === 'audit' || e.name === 'rand')) return e.name; // capability handle
    else throw new RuntimeFault(`unbound name ${e.name}`);
    for (const f of e.path) {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur) || cur.$ !== 'rec' || !(f in cur.fields)) throw new RuntimeFault(`no field ${f} on ${showVal(cur)}`);
      cur = cur.fields[f];
    }
    return cur;
  }

  isEnumCase(name: string): boolean {
    for (const t of this.prog.types.values()) if (t.k === 'enum' && t.cases.includes(name)) return true;
    return false;
  }

  private evalMatch(e: Extract<Expr, { k: 'match' }>, env: Env): Val {
    const s = this.eval(e.scrut, env);
    let tag: string | undefined;
    let payload: Val = UNIT;
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      if (s.$ === 'enum') tag = s.tag;
      else if (s.$ === 'ok' || s.$ === 'err') {
        tag = s.$;
        payload = s.v;
      }
    }
    if (tag === undefined) throw new RuntimeFault(`cannot match on ${showVal(s)}`);
    const arm = e.arms.find((a) => a.tag === tag);
    if (!arm) throw new RuntimeFault(`non-exhaustive match: no arm for ${tag}`);
    const env2 = new Map(env);
    if (arm.bind) env2.set(arm.bind, payload);
    return this.eval(arm.body, env2);
  }

  private lambda(e: Expr, env: Env): Closure {
    if (e.k !== 'lam') throw new RuntimeFault('expected a lambda');
    return { params: e.params, body: e.body, env };
  }

  private evalCall(e: Extract<Expr, { k: 'call' }>, env: Env): Val {
    const name = e.fn;

    // declassify is the identity at runtime: labels are static, and the checker has already approved the release
    if (name === 'declassify' && e.args.length === 2) return this.eval(e.args[1], env);

    // capability operations
    if (name in CAP_OPS) {
      const h = this.eval(e.args[0], env);
      if (typeof h !== 'string') throw new RuntimeFault(`${name}: first argument must be a capability handle`);
      const rest = e.args.slice(1).map((a) => this.eval(a, env));
      return this.host.call(h, name, rest);
    }

    // record construction
    const td = this.prog.types.get(name);
    if (td) {
      const r = resolveType(this.prog, td);
      if (r.k !== 'rec') throw new RuntimeFault(`${name} is not a record type`);
      const fields: Record<string, Val> = {};
      if (e.args.length) {
        if (e.args.length !== r.fields.length) {
          throw new RuntimeFault(`${name} has ${r.fields.length} field(s) (${r.fields.map((f) => f.name).join(', ')}) but is built with ${e.args.length} argument(s): ${printExpr(e)}. If this is in glossary.sigil, the program changed the shape of a type that the human-owned glossary or README fixes; restore the type instead of editing the glossary`);
        }
        r.fields.forEach((f, i) => (fields[f.name] = this.eval(e.args[i], env)));
      } else {
        for (const f of r.fields) {
          const k = e.kw.find((x) => x.name === f.name);
          if (!k) throw new RuntimeFault(`${name}: missing field ${f.name}`);
          fields[f.name] = this.eval(k.value, env);
        }
      }
      const rec: Val = { $: 'rec', type: name, fields };
      this.checkType(rec, td, name);
      return rec;
    }

    // user functions
    const uf = this.prog.fns.get(name);
    if (uf) return this.apply(uf, e.args.map((a) => this.eval(a, env)));

    return this.builtin(e, env);
  }

  private num(v: Val, what: string): bigint {
    if (typeof v !== 'bigint') throw new RuntimeFault(`${what}: expected Int, got ${showVal(v)}`);
    return v;
  }

  private builtin(e: Extract<Expr, { k: 'call' }>, env: Env): Val {
    const name = e.fn;
    if (name === 'map' || name === 'filter') {
      const xs = this.eval(e.args[0], env);
      if (!Array.isArray(xs)) throw new RuntimeFault(`${name}: expected a list`);
      const c = this.lambda(e.args[1], env);
      const run = (x: Val): Val => {
        const env2 = new Map(c.env);
        env2.set(c.params[0], x);
        return this.eval(c.body, env2);
      };
      return name === 'map' ? xs.map(run) : xs.filter((x) => run(x) === true);
    }
    if (name === 'any' || name === 'all') {
      // short-circuit: stops at the first element that decides the answer
      const xs = this.eval(e.args[0], env);
      if (!Array.isArray(xs)) throw new RuntimeFault(`${name}: expected a list`);
      const c = this.lambda(e.args[1], env);
      const want = name === 'any';
      for (const x of xs) {
        const env2 = new Map(c.env);
        env2.set(c.params[0], x);
        if ((this.eval(c.body, env2) === true) === want) return want;
      }
      return !want;
    }
    if (name === 'sort') {
      // (sort xs (fn (a b) before)): stable merge sort; before(a, b) true means a goes strictly before b.
      const xs = this.eval(e.args[0], env);
      if (!Array.isArray(xs)) throw new RuntimeFault('sort: expected a list');
      const c = this.lambda(e.args[1], env);
      if (c.params.length !== 2) throw new RuntimeFault('sort: lambda needs two parameters (a b)');
      const before = (a: Val, b: Val): boolean => {
        const env2 = new Map(c.env);
        env2.set(c.params[0], a);
        env2.set(c.params[1], b);
        return this.eval(c.body, env2) === true;
      };
      const msort = (v: Val[]): Val[] => {
        if (v.length <= 1) return v;
        const mid = v.length >> 1;
        const l = msort(v.slice(0, mid));
        const r = msort(v.slice(mid));
        const out: Val[] = [];
        let i = 0;
        let j = 0;
        while (i < l.length && j < r.length) out.push(before(r[j], l[i]) ? r[j++] : l[i++]);
        while (i < l.length) out.push(l[i++]);
        while (j < r.length) out.push(r[j++]);
        return out;
      };
      return msort(xs);
    }
    if (name === 'fold') {
      // (fold xs T init (fn (acc x) body)): T is the accumulator's declared type, checked on every step.
      const [xsE, tE, initE, fE] = e.args;
      if (e.args.length !== 4 || tE.k !== 'var' || !this.prog.types.has(tE.name)) throw new RuntimeFault('fold: expected (fold list Type init (fn (acc x) body))');
      const xs = this.eval(xsE, env);
      if (!Array.isArray(xs)) throw new RuntimeFault('fold: expected a list');
      const c = this.lambda(fE, env);
      if (c.params.length !== 2 && c.params.length !== 3) throw new RuntimeFault('fold: lambda needs parameters (acc x) or (acc x i)');
      const T: Type = { k: 'named', name: tE.name };
      let acc = this.eval(initE, env);
      this.checkType(acc, T, 'fold initial value');
      xs.forEach((x, i) => {
        const env2 = new Map(c.env);
        env2.set(c.params[0], acc);
        env2.set(c.params[1], x);
        if (c.params.length === 3) env2.set(c.params[2], BigInt(i));
        acc = this.eval(c.body, env2);
        this.checkType(acc, T, `fold step ${i}`);
      });
      return acc;
    }
    // short-circuit logic
    if (name === 'and') {
      for (const a of e.args) if (this.eval(a, env) !== true) return false;
      return true;
    }
    if (name === 'or') {
      for (const a of e.args) if (this.eval(a, env) === true) return true;
      return false;
    }
    const a = e.args.map((x) => this.eval(x, env));
    switch (name) {
      case 'add':
        return this.num(a[0], 'add') + this.num(a[1], 'add');
      case 'sub':
        return this.num(a[0], 'sub') - this.num(a[1], 'sub');
      case 'mul':
        return this.num(a[0], 'mul') * this.num(a[1], 'mul');
      case 'div-floor': {
        const x = this.num(a[0], 'div-floor');
        const y = this.num(a[1], 'div-floor');
        if (y === 0n) throw new RuntimeFault('division by zero');
        const q = x / y;
        return x % y !== 0n && x % y < 0n !== y < 0n ? q - 1n : q;
      }
      case 'mod': {
        const x = this.num(a[0], 'mod');
        const y = this.num(a[1], 'mod');
        if (y === 0n) throw new RuntimeFault('division by zero');
        const r = x % y;
        return r !== 0n && r < 0n !== y < 0n ? r + y : r;
      }
      case 'neg':
        return -this.num(a[0], 'neg');
      case 'min':
        return this.num(a[0], 'min') < this.num(a[1], 'min') ? a[0] : a[1];
      case 'max':
        return this.num(a[0], 'max') > this.num(a[1], 'max') ? a[0] : a[1];
      case 'sum': {
        if (!Array.isArray(a[0])) throw new RuntimeFault('sum: expected a list');
        return a[0].reduce<bigint>((s, x) => s + this.num(x, 'sum'), 0n);
      }
      case 'len':
        if (!Array.isArray(a[0])) throw new RuntimeFault('len: expected a list');
        return BigInt(a[0].length);
      case 'chars':
        if (typeof a[0] !== 'string') throw new RuntimeFault('chars: expected a Str');
        return Array.from(a[0]).map((c) => BigInt(c.codePointAt(0)!));
      case 'from-chars': {
        if (!Array.isArray(a[0])) throw new RuntimeFault('from-chars: expected a list of code points');
        return a[0].map((c) => {
          const n = this.num(c, 'from-chars');
          if (n < 0n || n > 1114111n) throw new RuntimeFault(`from-chars: ${n} is not a code point`);
          return String.fromCodePoint(Number(n));
        }).join('');
      }
      case 'append':
        if (!Array.isArray(a[0])) throw new RuntimeFault('append: expected a list');
        return [...a[0], a[1]];
      case 'concat':
        if (!Array.isArray(a[0]) || !Array.isArray(a[1])) throw new RuntimeFault('concat: expected two lists');
        return [...a[0], ...a[1]];
      case 'range': {
        const n = this.num(a[0], 'range');
        if (n > BigInt(RANGE_MAX)) throw new RuntimeFault(`range: ${n} exceeds the cap of ${RANGE_MAX}`);
        return Array.from({ length: n > 0n ? Number(n) : 0 }, (_, i) => BigInt(i));
      }
      case 'take':
      case 'drop': {
        if (!Array.isArray(a[0])) throw new RuntimeFault(`${name}: expected a list`);
        const n = this.num(a[1], name);
        const k = n < 0n ? 0 : n > BigInt(a[0].length) ? a[0].length : Number(n);
        return name === 'take' ? a[0].slice(0, k) : a[0].slice(k);
      }
      case 'at': {
        if (!Array.isArray(a[0])) throw new RuntimeFault('at: expected a list');
        const i = this.num(a[1], 'at');
        return i >= 0n && i < BigInt(a[0].length) ? a[0][Number(i)] : a[2];
      }
      case 'text':
        return a.map((x) => (typeof x === 'string' ? x : showVal(x))).join('');
      case 'money':
        return moneyStr(this.num(a[0], 'money'));
      case 'list':
        return a;
      case '=':
        return eqVal(a[0], a[1]);
      case '<=':
      case '<':
      case '>=':
      case '>': {
        for (let i = 0; i + 1 < a.length; i++) {
          const x = this.num(a[i], name);
          const y = this.num(a[i + 1], name);
          const ok = name === '<=' ? x <= y : name === '<' ? x < y : name === '>=' ? x >= y : x > y;
          if (!ok) return false;
        }
        return true;
      }
      case 'not':
        return a[0] !== true;
      case 'ok':
        return okVal(a[0]);
      case 'err':
        return errVal(a[0]);
      case 'sent':
        return this.host.sent(a[0] as string);
      case 'stored':
        return this.host.stored(a[0] as string);
      case 'emitted':
        return this.host.emitted(a[0] as string);
      default:
        throw new RuntimeFault(`unknown function ${name}`);
    }
  }
}

/** Evaluate a standalone expression (used by scenario glossaries and properties). */
export function evalIn(it: Interp, e: Expr, vars: Map<string, Val>): Val {
  try {
    return it.eval(e, vars);
  } catch (x) {
    if (x instanceof EarlyReturn) return x.value;
    throw x;
  }
}
