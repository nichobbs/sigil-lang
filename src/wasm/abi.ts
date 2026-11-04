// Calling convention between interpreter values and compiled Wasm functions.
//   Int  -> i32 (Number) or i64 (BigInt), per FnReport.repr
//   Bool -> i32 0/1
//   enum -> i32 index into the type's case list
//   record parameters are flattened to one scalar parameter per leaf field, in declaration order.
//   List parameters are two i32 parameters (ptr, len) into the exported "memory". Each element is `stride`
//   8-byte little-endian slots (one i64 per scalar field, in declaration order; string fields are not
//   stored). List inputs are placed from MEM_BASE, each reserving its declared maximum length; a trailing
//   i32 parameter gives the start of scratch memory (just after the inputs).

import { Val, enumVal } from '../interp.js';
import { ElemLayout, FnReport, Kind, MEM_BASE, SLOT } from './compile.js';

export type Raw = number | bigint;

function slotValue(v: Val, kind: Kind): bigint {
  switch (kind.t) {
    case 'int':
      if (typeof v !== 'bigint') throw new Error(`expected Int, got ${String(v)}`);
      return v;
    case 'bool':
      return v === true ? 1n : 0n;
    case 'enum': {
      const tag = v && typeof v === 'object' && !Array.isArray(v) && v.$ === 'enum' ? v.tag : undefined;
      const i = tag === undefined ? -1 : kind.cases.indexOf(tag);
      if (i < 0) throw new Error(`expected enum ${kind.cases.join('|')}`);
      return BigInt(i);
    }
    default:
      throw new Error('list elements must be scalar');
  }
}

function field(v: Val, path: string): Val {
  if (!path) return v;
  for (const seg of path.split('.')) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || v.$ !== 'rec') throw new Error(`expected record at ${path}`);
    v = v.fields[seg];
  }
  return v;
}

/** Write a Sigil list into linear memory at `addr` in the compiled layout. Returns the bytes used. */
export function writeList(view: DataView, addr: number, layout: ElemLayout, xs: Val): number {
  if (!Array.isArray(xs)) throw new Error('expected a list');
  xs.forEach((x, i) => {
    for (const l of layout.leaves) view.setBigInt64(addr + (i * layout.stride + l.slot) * SLOT, slotValue(field(x, l.path), l.kind), true);
  });
  return xs.length * layout.stride * SLOT;
}

/** Read `len` elements back from linear memory (string fields were not stored, so records omit them). */
export function readList(view: DataView, addr: number, len: number, layout: ElemLayout): Val[] {
  const out: Val[] = [];
  for (let i = 0; i < len; i++) {
    const rec: Record<string, any> = {};
    let scalar: Val | undefined;
    for (const l of layout.leaves) {
      const raw = view.getBigInt64(addr + (i * layout.stride + l.slot) * SLOT, true);
      const v: Val = l.kind.t === 'int' ? raw : l.kind.t === 'bool' ? raw !== 0n : l.kind.t === 'enum' ? enumVal(l.kind.cases[Number(raw)]) : false;
      if (!l.path) scalar = v;
      else {
        const segs = l.path.split('.');
        let o = rec;
        for (const sg of segs.slice(0, -1)) o = (o[sg] ??= { $: 'rec', type: '', fields: {} }).fields;
        o[segs[segs.length - 1]] = v;
      }
    }
    out.push(scalar !== undefined ? scalar : { $: 'rec', type: '', fields: rec });
  }
  return out;
}

function lowerLeaf(v: Val, kind: Kind, repr: 'i32' | 'i64'): Raw {
  switch (kind.t) {
    case 'list':
      throw new Error('list parameters are lowered with lowerArgs');
    case 'int':
      if (typeof v !== 'bigint') throw new Error(`expected Int, got ${String(v)}`);
      return repr === 'i64' ? v : Number(v);
    case 'bool':
      return v === true ? 1 : 0;
    case 'enum': {
      const tag = v && typeof v === 'object' && !Array.isArray(v) && v.$ === 'enum' ? v.tag : undefined;
      const i = tag === undefined ? -1 : kind.cases.indexOf(tag);
      if (i < 0) throw new Error(`expected enum ${kind.cases.join('|')}`);
      return i;
    }
  }
}

/**
 * Lower interpreter values to raw wasm arguments. Functions with list parameters need the instance's
 * `memory`: lists are marshalled into it and the lengths are checked against the declared bounds
 * (the compiled code trusts them, exactly as it trusts the declared ranges of scalar arguments).
 */
export function lowerArgs(fn: FnReport, args: Val[], memory?: WebAssembly.Memory): Raw[] {
  if (!fn.compilable || !fn.params || !fn.repr) throw new Error(`${fn.name} is not compilable`);
  const out: Raw[] = [];
  let cursor = MEM_BASE;
  fn.params.forEach((p, i) => {
    for (const leaf of p.leaves) {
      if (leaf.kind.t === 'list') {
        if (!memory) throw new Error(`${fn.name} has list parameters: pass the instance's memory`);
        const xs = args[i];
        if (!Array.isArray(xs)) throw new Error(`expected a list for ${p.name}`);
        const { min, max, layout } = leaf.kind;
        if (xs.length < min || xs.length > max) throw new Error(`${p.name}: length ${xs.length} outside declared ${min}..${max}`);
        writeList(new DataView(memory.buffer), cursor, layout, xs);
        out.push(cursor, xs.length);
        cursor += max * layout.stride * SLOT;
        continue;
      }
      let v: Val = args[i];
      if (leaf.path) {
        for (const seg of leaf.path.split('.')) {
          if (!v || typeof v !== 'object' || Array.isArray(v) || v.$ !== 'rec') throw new Error(`expected record at ${p.name}`);
          v = v.fields[seg];
        }
      }
      out.push(lowerLeaf(v, leaf.kind, fn.repr!));
    }
  });
  if (fn.hasBase) {
    if (cursor - MEM_BASE !== fn.inputBytes) throw new Error('internal: input area mismatch');
    out.push(cursor); // scratch base
  }
  return out;
}

export function liftResult(fn: FnReport, raw: Raw): Val {
  const k = fn.result!;
  switch (k.t) {
    case 'int':
      return BigInt(raw);
    case 'bool':
      return raw !== 0;
    case 'enum':
      return enumVal(k.cases[Number(raw)]);
    case 'list':
      throw new Error('list results are not supported');
  }
}

export async function instantiate(bytes: Uint8Array): Promise<Record<string, (...a: Raw[]) => Raw>> {
  const mod = await WebAssembly.compile(new Uint8Array(bytes)); // also validates the module
  const instance = await WebAssembly.instantiate(mod, {});
  return instance.exports as unknown as Record<string, (...a: Raw[]) => Raw>;
}

export function callCompiled(fn: FnReport, exports: Record<string, (...a: Raw[]) => Raw>, args: Val[]): Val {
  const memory = (exports as unknown as { memory?: WebAssembly.Memory }).memory;
  return liftResult(fn, exports[fn.name](...lowerArgs(fn, args, memory)));
}
