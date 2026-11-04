// Calling convention between interpreter values and compiled Wasm functions (see shape.ts for the leaf layout).
//   Int  -> i32 (Number) or i64 (BigInt), per FnReport.repr
//   Bool -> i32 0/1;  enum -> i32 index into the type's case list;  Str -> i32 handle into a host string table
//   Unit -> no value
//   record parameters are flattened to one parameter per leaf, in declaration order.
//   Result -> i32 tag (0 ok, 1 err), then the ok payload's leaves, then the err payload's leaves (inactive side zero)
//   List -> two i32 values (ptr, len) into the exported "memory". Each element is `stride` 8-byte little-endian
//   slots (one i64 per scalar leaf in declaration order; a Str leaf is its handle). List inputs are placed from
//   MEM_BASE in parameter-leaf order, each reserving its declared maximum length; a trailing i32 parameter gives
//   the start of scratch memory (just after the inputs).
//   Results are returned with multi-value: an array of the result's leaves (a single value or nothing for fewer).
//   A list in a result points into scratch memory, valid until the next call.
//
// Host ABI (imports, module "host"). Strings are opaque i32 handles into a host-owned table (handle 0 is "",
// 1..n the module's literals, listed in the custom section `sigil.abi`). Effects are one import per operation and
// argument shape; the first parameter is a capability handle id (index into `sigil.abi` handles), the rest are the
// argument leaves with Ints widened to i64:
//     str_eq(a, b) -> i32            str_concat(a, b) -> str          str_int(i64) -> str      str_money(i64) -> str
//     str_chars(s, dst, max) -> len  str_from_chars(ptr, len) -> str
//     put$k(h, key..., value...) -> i32 ok      post$k(h, payload...) -> i32 ok
//     emit$k(h, event...) -> i32 ok             fresh$k(h) -> i64
// `sigil.abi` (JSON: AbiDescriptor in compile.ts) carries the literal table, the handle table and, per effect import,
// the shapes of its arguments, so any host can rebuild the values. src/wasm/host.ts is the reference adapter over
// the interpreter's Host (so the effect logs of both executions can be compared). An entry point (a function
// listed in a `program` form) is an ordinary export with this ABI, flagged `entry` in the FnReport.

import { Host, Val } from '../interp.js';
import { FnReport, MEM_BASE } from './compile.js';
import { WasmHost, readAbi } from './host.js';
import { LowerState, Raw, StrTable, liftVal, lowerVal } from './marshal.js';

export type { Raw } from './marshal.js';
export { StrTable, readList, writeList } from './marshal.js';

/** Per-instance state kept next to the exports (string table, host adapter). */
export const ENV = Symbol('sigil.env');
export interface Env {
  strings?: StrTable;
  host?: WasmHost;
}
export type Exports = Record<string, (...a: Raw[]) => Raw | Raw[] | void> & { [ENV]?: Env };

/**
 * Lower interpreter values to raw wasm arguments. Functions with list parameters need the instance's
 * `memory`: lists are marshalled into it and the lengths are checked against the declared bounds
 * (the compiled code trusts them, exactly as it trusts the declared ranges of scalar arguments).
 */
export function lowerArgs(fn: FnReport, args: Val[], memory?: WebAssembly.Memory, strings?: StrTable): Raw[] {
  if (!fn.compilable || !fn.params || !fn.repr) throw new Error(`${fn.name} is not compilable`);
  const out: Raw[] = [];
  const st: LowerState = { repr: fn.repr, memory, cursor: MEM_BASE, strings, who: '' };
  fn.params.forEach((p, i) => {
    st.who = p.name;
    lowerVal(args[i], p.shape, st, out);
  });
  if (fn.hasBase) {
    if (st.cursor - MEM_BASE !== fn.inputBytes) throw new Error('internal: input area mismatch');
    out.push(st.cursor); // scratch base
  }
  return out;
}

export function liftResult(fn: FnReport, raw: Raw | Raw[] | void, memory?: WebAssembly.Memory, strings?: StrTable): Val {
  const raws = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return liftVal(fn.result!, raws, { i: 0 }, { memory, strings });
}

/**
 * Instantiate a compiled module with the host adapter (src/wasm/host.ts) bound to `host`.
 * The returned exports carry the string table and adapter under the ENV symbol (used by callCompiled).
 */
export async function instantiate(bytes: Uint8Array, host: Host = new Host(1)): Promise<Exports> {
  const mod = await WebAssembly.compile(new Uint8Array(bytes)); // also validates the module
  const wh = new WasmHost(readAbi(mod), host);
  const instance = await WebAssembly.instantiate(mod, wh.imports(mod));
  wh.memory = (instance.exports as unknown as { memory?: WebAssembly.Memory }).memory;
  return { ...(instance.exports as unknown as Exports), [ENV]: { strings: wh.strings, host: wh } };
}

export function callCompiled(fn: FnReport, exports: Exports, args: Val[]): Val {
  const memory = (exports as unknown as { memory?: WebAssembly.Memory }).memory;
  const strings = exports[ENV]?.strings;
  strings?.reset();
  return liftResult(fn, exports[fn.name](...lowerArgs(fn, args, memory, strings)), memory, strings);
}
