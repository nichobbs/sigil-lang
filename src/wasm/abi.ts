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

import { Val } from '../interp.js';
import { FnReport, MEM_BASE } from './compile.js';
import { LowerState, Raw, StrTable, liftVal, lowerVal } from './marshal.js';

export { Raw, StrTable, readList, writeList } from './marshal.js';

/** Per-instance state kept next to the exports (string table, host adapter). */
export const ENV = Symbol('sigil.env');
export interface Env {
  strings?: StrTable;
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

export async function instantiate(bytes: Uint8Array): Promise<Exports> {
  const mod = await WebAssembly.compile(new Uint8Array(bytes)); // also validates the module
  const instance = await WebAssembly.instantiate(mod, {});
  return { ...(instance.exports as unknown as Exports) };
}

export function callCompiled(fn: FnReport, exports: Exports, args: Val[]): Val {
  const memory = (exports as unknown as { memory?: WebAssembly.Memory }).memory;
  const strings = exports[ENV]?.strings;
  strings?.reset();
  return liftResult(fn, exports[fn.name](...lowerArgs(fn, args, memory, strings)), memory, strings);
}
