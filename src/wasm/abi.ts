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
//
// Trust model (ABI version 2, `validated: true` in `sigil.abi`; see validate.ts for the full list of checks):
//   - Every export is a validating wrapper. Before any unchecked code runs it checks each argument against its
//     declared type, in the interpreter's order: Int ranges (also inside records, Results and list elements), Bool
//     0/1, enum case indices, Str handles live and within :max (host import str_len), Result tags and zero inactive
//     sides, list lengths within min..max, list memory below the scratch base, and the scratch base plus the
//     function's scratch inside the memory. A violation calls contract_violation(site, index, value), then traps.
//   - The compiled function bodies (plain wrapping arithmetic, relying on the checker's proofs) are internal: they
//     are not exported, so no caller can reach them with unvalidated arguments. Calls between compiled functions
//     stay direct and unchecked (the checker proved the callee's parameter ranges at every call site).
//   - Host results the code relies on are checked too: fresh (0..9007199254740991) and the str_chars count; str_eq
//     is normalised to 0/1. Still trusted: the host's string table (handles returned by str_concat, str_int,
//     str_money and str_from_chars, and the strings behind them), the success flags of put/post/emit (any nonzero
//     is success, so they cannot break an invariant), and the host's own writes into memory (str_chars), since a host
//     can write to the exported memory at any time anyway. `ensures` is not checked at run time (as before).
//   - Version 1 modules (no `validated` flag) exported the unchecked functions directly: a caller had to validate
//     every argument itself. isValidated() tells the two apart.

import { Host, Val } from '../interp.js';
import { ABI_VERSION, AbiDescriptor, FnReport, MEM_BASE } from './compile.js';
import { WasmHost, readAbi } from './host.js';
import { LowerState, Raw, StrTable, liftVal, lowerVal } from './marshal.js';

export type { Raw } from './marshal.js';
export type { CheckReason, CheckSite } from './validate.js';
export { ABI_VERSION };
export { contractError, readAbi } from './host.js';

/** True when the module's exports validate their arguments (ABI version 2 or later with the `validated` flag). */
export function isValidated(abi: AbiDescriptor | WebAssembly.Module): boolean {
  const a = abi instanceof WebAssembly.Module ? readAbi(abi) : abi;
  return a.version >= 2 && a.validated === true;
}
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
 * `memory`: lists are marshalled into it. By default the lengths are also checked here against the declared bounds;
 * with `forward` every encodable value goes to the module, whose validating wrapper is then the one that rejects it
 * (see marshal.ts LowerState.forward). A value with no encoding (wrong kind, too wide) is always rejected here, with
 * the interpreter's ContractViolation.
 */
export function lowerArgs(fn: FnReport, args: Val[], memory?: WebAssembly.Memory, strings?: StrTable, opts: { forward?: boolean } = {}): Raw[] {
  if (!fn.compilable || !fn.params || !fn.repr) throw new Error(`${fn.name} is not compilable`);
  const out: Raw[] = [];
  const st: LowerState = { repr: fn.repr, memory, cursor: MEM_BASE, strings, who: '', forward: opts.forward };
  fn.params.forEach((p, i) => {
    st.who = `${fn.name}(${p.name})`;
    lowerVal(args[i], p.shape, st, out);
  });
  if (fn.hasBase) {
    if (st.cursor - MEM_BASE < fn.inputBytes!) throw new Error('internal: input area mismatch');
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

/**
 * Call a compiled function with interpreter values. Arguments are forwarded to the module's validating export, so an
 * argument outside its declared type fails with the interpreter's ContractViolation (same reason and `where`),
 * raised by the module through contract_violation, or by the adapter for a value with no encoding at all.
 */
export function callCompiled(fn: FnReport, exports: Exports, args: Val[]): Val {
  const memory = (exports as unknown as { memory?: WebAssembly.Memory }).memory;
  const strings = exports[ENV]?.strings;
  strings?.reset();
  return liftResult(fn, exports[fn.name](...lowerArgs(fn, args, memory, strings, { forward: true })), memory, strings);
}
