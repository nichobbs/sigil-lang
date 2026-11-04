// Validating export wrappers: the trust boundary of a compiled module.
//
// The compiled function bodies are unchecked: the checker proved there is no overflow and no zero divisor ASSUMING
// every argument is within its declared type, and the emitted code is plain wrapping arithmetic. So every function
// the module exports is a wrapper generated here. It checks each parameter against its declared type, in the same
// order as the interpreter's contract check (src/interp.ts, Interp.checkType), and only then calls the internal,
// unchecked function (which is not exported). On a violation it calls the host import
//     contract_violation(site: i32, index: i32, value: i64)
// and then executes `unreachable`, so a host whose import returns still gets a trap and never an unchecked call.
// `site` indexes AbiDescriptor.checks (the `sigil.abi` custom section): which function, which value, which reason.
// `index` is the list element index for a check inside a list element (else -1); `value` is the offending raw value
// (the Int, the length, the case index, the string length, the handle, the pointer).
//
// What a wrapper checks, per parameter leaf (records are walked field by field, Results by tag then active side):
//   Int          lo <= v <= hi                                                  reason range
//   Bool         v is 0 or 1                                                    reason type
//   enum         0 <= v < number of cases                                       reason enum
//   Str          the handle is live (host import str_len(h) >= 0)               reason type
//                and, with :max N, str_len(h) <= N (code points)                reason str-max
//   Result       tag is 0 or 1                                                  reason type
//                every leaf of the inactive side is zero (the ABI encoding)     reason encoding
//   List         min <= len <= max                                              reason list-length
//                ptr + len * stride * 8 <= scratch base (inputs below scratch)  reason memory
//                then every element's slots, as above (Str slot: a handle < 2^32, live, within :max)
//   scratch base base + scratch bytes <= memory size (checked first)            reason memory
//
// Host import results the compiled code relies on are checked at the call site (compile.ts), with the same import:
//   fresh$k      the value is in 0..9007199254740991 (the range the checker assumes)       reason host-result
//   str_chars    the count is in 0..:max (it becomes a list length)                        reason host-result
//   str_eq       normalised to 0/1 (no check needed)
// String handles returned by the host (str_concat, str_int, str_money, str_from_chars) are trusted: the host owns the
// table, and every later use goes back to the host, which resolves the handle itself.

import { ContractReason } from '../interp.js';
import { I32, I64, IntOps, OP, ValType, WasmFunc, call, i64Load, localGet, localSet } from './encode.js';
import { ListShape, SLOT, Shape, wtypes } from './shape.js';

/**
 * Reason a check fails. range, str-max, enum, list-length and type are the interpreter's own (ContractViolation.reason);
 * encoding and memory concern raw arguments that no Sigil value encodes to; host-result is a host import answering
 * outside the range the compiled code relies on (a host fault, not a caller error).
 */
export type CheckReason = ContractReason | 'host-result';

/** One check site (an entry of AbiDescriptor.checks). Integer bounds are decimal strings (JSON has no bigint). */
export interface CheckSite {
  fn: string;
  reason: CheckReason;
  /** Where the value sits, as the interpreter names it: "f(p)", "f(p).field", "f(p).ok"; for an element, the list. */
  at: string;
  /** For a check inside a list element: the path after "[i]" ("" for a scalar element, ".qty" for a field). */
  elem?: string;
  /** For reason `type`: the expected kind. */
  expect?: 'Bool' | 'Str' | 'Result';
  low?: string;
  high?: string;
  min?: number;
  max?: number;
  cases?: string[];
}

/** The message for a violation, worded like the interpreter's contract check where there is one. */
export function violationMessage(s: CheckSite, index: number, value: bigint): { where: string; message: string } {
  const where = index >= 0 ? `${s.at}[${index}]${s.elem ?? ''}` : s.at;
  let m: string;
  switch (s.reason) {
    case 'range':
      m = `${value} outside [${s.low}, ${s.high}]`;
      break;
    case 'str-max':
      m = `string of ${value} characters exceeds :max ${s.max}`;
      break;
    case 'enum':
      m = `expected one of ${s.cases!.join('|')}, got case index ${value}`;
      break;
    case 'list-length':
      m = `length ${value} outside [${s.min}, ${s.max}]`;
      break;
    case 'type':
      m = s.expect === 'Bool' ? 'expected Bool' : s.expect === 'Result' ? 'expected Result' : `expected Str, got invalid string handle ${value}`;
      break;
    case 'encoding':
      m = `the inactive side of a Result must be all zero (got ${value})`;
      break;
    case 'memory':
      m = `list or scratch memory out of bounds (address ${value})`;
      break;
    case 'host-result':
      m = `host returned ${value}, outside [${s.low}, ${s.high}]`;
      break;
  }
  return { where, message: `${where}: ${m}` };
}

/** What the generator needs from the module being built. */
export interface WrapperEnv {
  /** Register a check site (deduplicated) and return its index. */
  site(s: CheckSite): number;
  /** Function index of the import contract_violation(i32, i32, i64). */
  cv(): number;
  /** Function index of the import str_len(i32) -> i32. */
  strLen(): number;
}

/** The parts of a function report a wrapper needs. */
export interface WrapperSpec {
  name: string;
  repr: 'i32' | 'i64';
  params: { name: string; shape: Shape }[];
  result: Shape;
  hasBase: boolean;
  scratchBytes: number;
}

// Raw opcodes not in IntOps (unsigned comparisons, i64 widening, memory.size).
const I32_GT_U = 0x4b;
const I32_GE_U = 0x4f;
const I32_LT_S = 0x48;
const I32_GT_S = 0x4a;
const I32_OR = 0x72;
const I64_GT_U = 0x56;
const I64_ADD = 0x7c;
const I64_MUL = 0x7e;
const MEMORY_SIZE = [0x3f, 0x00];
const ext = (signed: boolean) => (signed ? OP.i64ExtendI32S : OP.i64ExtendI32U);

const I32_MIN = -(2n ** 31n);
const I32_MAX = 2n ** 31n - 1n;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** `if (cond) { contract_violation(site, index, value); unreachable }` */
export function failIf(cond: number[], site: number, index: number[], value: number[], cv: number): number[] {
  return [...cond, OP.if, OP.void, ...I32.const(BigInt(site)), ...index, ...value, ...call(cv), OP.unreachable, OP.end];
}

class WrapperGen {
  locals: ValType[] = [];
  c: number[] = [];
  R: IntOps;
  constructor(
    private spec: WrapperSpec,
    private env: WrapperEnv,
    private nParams: number,
    private base: number,
  ) {
    this.R = spec.repr === 'i64' ? I64 : I32;
  }
  alloc(t: ValType): number {
    this.locals.push(t);
    return this.nParams + this.locals.length - 1;
  }
  fail(cond: number[], s: CheckSite, value: number[], index: number[] = I32.const(-1n)): number[] {
    return failIf(cond, this.env.site(s), index, value, this.env.cv());
  }

  /** Checks for one value held in `locals` (its leaves, in order). */
  value(shape: Shape, locals: number[], at: string): number[] {
    const fn = this.spec.name;
    const R = this.R;
    switch (shape.t) {
      case 'unit':
        return [];
      case 'int': {
        const x = locals[0];
        const [min, max] = R.vt === 'i64' ? [I64_MIN, I64_MAX] : [I32_MIN, I32_MAX];
        const lo = shape.lo ?? min;
        const hi = shape.hi ?? max;
        const parts: number[][] = [];
        if (lo > min) parts.push([...localGet(x), ...R.const(lo), R.ltS]);
        if (hi < max) parts.push([...localGet(x), ...R.const(hi), R.gtS]);
        if (!parts.length) return [];
        const cond = parts.length === 2 ? [...parts[0], ...parts[1], I32_OR] : parts[0];
        const value = R.vt === 'i64' ? localGet(x) : [...localGet(x), ext(true)];
        return this.fail(cond, { fn, reason: 'range', at, low: String(lo), high: String(hi) }, value);
      }
      case 'bool': {
        const x = locals[0];
        return this.fail([...localGet(x), ...I32.const(1n), I32_GT_U], { fn, reason: 'type', at, expect: 'Bool' }, [...localGet(x), ext(true)]);
      }
      case 'enum': {
        const x = locals[0];
        return this.fail([...localGet(x), ...I32.const(BigInt(shape.cases.length)), I32_GE_U], { fn, reason: 'enum', at, cases: shape.cases }, [...localGet(x), ext(true)]);
      }
      case 'str':
        return this.str(localGet(locals[0]), shape.max, at);
      case 'rec': {
        const out: number[] = [];
        let off = 0;
        for (const f of shape.fields) {
          const n = wtypes(f.shape, R.vt).length;
          out.push(...this.value(f.shape, locals.slice(off, off + n), `${at}.${f.name}`));
          off += n;
        }
        return out;
      }
      case 'result': {
        const tag = locals[0];
        const nOk = wtypes(shape.ok, R.vt).length;
        const okL = locals.slice(1, 1 + nOk);
        const errL = locals.slice(1 + nOk);
        const out = this.fail([...localGet(tag), ...I32.const(1n), I32_GT_U], { fn, reason: 'type', at, expect: 'Result' }, [...localGet(tag), ext(true)]);
        const okSide = [...this.value(shape.ok, okL, `${at}.ok`), ...this.zeros(shape.err, errL, `${at}.err`)];
        const errSide = [...this.value(shape.err, errL, `${at}.err`), ...this.zeros(shape.ok, okL, `${at}.ok`)];
        out.push(...localGet(tag), I32.eqz, OP.if, OP.void, ...okSide, OP.else, ...errSide, OP.end);
        return out;
      }
      case 'list':
        return this.list(shape, locals[0], locals[1], at);
    }
  }

  /** The inactive side of a Result must be all zero leaves. */
  zeros(shape: Shape, locals: number[], at: string): number[] {
    const out: number[] = [];
    wtypes(shape, this.R.vt).forEach((t, k) => {
      const value = t === 'i64' ? localGet(locals[k]) : [...localGet(locals[k]), ext(true)];
      out.push(...this.fail([...localGet(locals[k]), t === 'i64' ? I64.eqz : I32.eqz, I32.eqz], { fn: this.spec.name, reason: 'encoding', at }, value));
    });
    return out;
  }

  /** A Str handle (i32 on the stack via `get`): live, and within :max. */
  str(get: number[], max: number | undefined, at: string, index?: number[], elem?: string): number[] {
    const fn = this.spec.name;
    const n = this.alloc('i32');
    const el = elem === undefined ? {} : { elem };
    const out = [...get, ...call(this.env.strLen()), ...localSet(n)];
    out.push(...this.fail([...localGet(n), ...I32.const(0n), I32_LT_S], { fn, reason: 'type', at, expect: 'Str', ...el }, [...get, ext(true)], index));
    if (max !== undefined) out.push(...this.fail([...localGet(n), ...I32.const(BigInt(max)), I32_GT_S], { fn, reason: 'str-max', at, max, ...el }, [...localGet(n), ext(true)], index));
    return out;
  }

  list(shape: ListShape, ptr: number, len: number, at: string): number[] {
    const fn = this.spec.name;
    const L = shape.layout;
    const out: number[] = [];
    const lenV = [...localGet(len), ext(true)];
    out.push(
      ...this.fail(
        [...localGet(len), ...I32.const(BigInt(shape.min)), I32_LT_S, ...localGet(len), ...I32.const(BigInt(shape.max)), I32_GT_S, I32_OR],
        { fn, reason: 'list-length', at, min: shape.min, max: shape.max },
        lenV,
      ),
    );
    // ptr + len * stride * 8 <= base, in i64 so that nothing wraps
    out.push(
      ...this.fail(
        [
          ...localGet(ptr), ext(false), ...localGet(len), ext(false), ...I64.const(BigInt(L.stride * SLOT)), I64_MUL, I64_ADD,
          ...localGet(this.base), ext(false), I64_GT_U,
        ],
        { fn, reason: 'memory', at },
        [...localGet(ptr), ext(false)],
      ),
    );
    // every element's slots
    const i = this.alloc('i32');
    const addr = this.alloc('i32');
    const tmp = this.alloc('i64');
    const idx = localGet(i);
    const body: number[] = [...localGet(ptr), ...localGet(i), ...I32.const(BigInt(L.stride * SLOT)), I32.mul, I32.add, ...localSet(addr)];
    for (const leaf of L.leaves) {
      const elem = leaf.path ? `.${leaf.path}` : '';
      body.push(...localGet(addr), ...i64Load(leaf.slot * SLOT), ...localSet(tmp));
      const k = leaf.kind;
      switch (k.t) {
        case 'int': {
          const parts: number[][] = [];
          if (k.lo !== undefined) parts.push([...localGet(tmp), ...I64.const(k.lo), I64.ltS]);
          if (k.hi !== undefined) parts.push([...localGet(tmp), ...I64.const(k.hi), I64.gtS]);
          if (parts.length) body.push(...this.fail(parts.length === 2 ? [...parts[0], ...parts[1], I32_OR] : parts[0], { fn, reason: 'range', at, elem, low: String(k.lo), high: String(k.hi) }, localGet(tmp), idx));
          break;
        }
        case 'bool':
          body.push(...this.fail([...localGet(tmp), ...I64.const(1n), I64_GT_U], { fn, reason: 'type', at, elem, expect: 'Bool' }, localGet(tmp), idx));
          break;
        case 'enum':
          body.push(...this.fail([...localGet(tmp), ...I64.const(BigInt(k.cases.length) - 1n), I64_GT_U], { fn, reason: 'enum', at, elem, cases: k.cases }, localGet(tmp), idx));
          break;
        case 'str':
          body.push(...this.fail([...localGet(tmp), ...I64.const(0xffffffffn), I64_GT_U], { fn, reason: 'type', at, elem, expect: 'Str' }, localGet(tmp), idx));
          body.push(...this.str([...localGet(tmp), OP.i32WrapI64], k.max, at, idx, elem));
          break;
      }
    }
    out.push(
      ...I32.const(0n), ...localSet(i),
      OP.block, OP.void, OP.loop, OP.void,
      ...localGet(i), ...localGet(len), I32.geS, OP.brIf, 1,
      ...body,
      ...localGet(i), ...I32.const(1n), I32.add, ...localSet(i),
      OP.br, 0,
      OP.end, OP.end,
    );
    return out;
  }
}

/**
 * The exported wrapper of a compiled function: same Wasm signature as the internal function at `internal` (a
 * function index), validates every parameter, then tail-calls it.
 */
export function genWrapper(spec: WrapperSpec, internal: number, env: WrapperEnv): WasmFunc {
  const vt: ValType = spec.repr;
  const ptypes: ValType[] = [];
  const paramLocals: number[][] = spec.params.map((p) =>
    wtypes(p.shape, vt).map((t) => {
      ptypes.push(t);
      return ptypes.length - 1;
    }),
  );
  const base = spec.hasBase ? ptypes.length : -1;
  if (spec.hasBase) ptypes.push('i32');
  const g = new WrapperGen(spec, env, ptypes.length, base);
  const body: number[] = [];
  if (spec.hasBase) {
    // base + scratch <= memory size: the internal function's scratch (and its callees') stays inside the memory
    body.push(
      ...g.fail(
        [...localGet(base), ext(false), ...I64.const(BigInt(spec.scratchBytes)), I64_ADD, ...MEMORY_SIZE, ext(false), ...I64.const(65536n), I64_MUL, I64_GT_U],
        { fn: spec.name, reason: 'memory', at: `${spec.name}(scratch base)` },
        [...localGet(base), ext(false)],
      ),
    );
  }
  spec.params.forEach((p, k) => body.push(...g.value(p.shape, paramLocals[k], `${spec.name}(${p.name})`)));
  for (let k = 0; k < ptypes.length; k++) body.push(...localGet(k));
  body.push(...call(internal));
  return { name: spec.name, params: ptypes, results: wtypes(spec.result, vt), locals: g.locals, body };
}
