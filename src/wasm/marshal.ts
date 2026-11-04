// Marshalling between interpreter values (Val) and raw Wasm values, driven by shapes (see shape.ts).

import { Val, enumVal, errVal, okVal } from '../interp.js';
import { ElemLayout, MEM_BASE, Scalar, SLOT, Shape, nleaves } from './shape.js';

export type Raw = number | bigint;

/** Host-owned string table. Handle 0 is the empty string; handles 1..n are the module's literals. */
export class StrTable {
  items: string[];
  private index = new Map<string, number>();
  private fixed: number;
  constructor(literals: string[] = []) {
    this.items = ['', ...literals];
    this.items.forEach((s, i) => this.index.has(s) || this.index.set(s, i));
    this.fixed = this.items.length;
  }
  intern(s: string): number {
    const hit = this.index.get(s);
    if (hit !== undefined) return hit;
    this.items.push(s);
    this.index.set(s, this.items.length - 1);
    return this.items.length - 1;
  }
  get(h: number): string {
    if (!Number.isInteger(h) || h < 0 || h >= this.items.length) throw new Error(`invalid string handle ${h}`);
    return this.items[h];
  }
  /** Forget the strings created since construction (between calls). */
  reset(): void {
    for (let i = this.fixed; i < this.items.length; i++) if (this.index.get(this.items[i]) === i) this.index.delete(this.items[i]);
    this.items.length = this.fixed;
  }
}

export interface LowerState {
  repr: 'i32' | 'i64';
  memory?: WebAssembly.Memory;
  cursor: number; // next free byte of the input area
  strings?: StrTable;
  who: string;
}

const isRec = (v: Val): v is Extract<Val, { $: 'rec' }> => !!v && typeof v === 'object' && !Array.isArray(v) && v.$ === 'rec';

function scalarSlot(v: Val, k: Scalar, strings?: StrTable): bigint {
  switch (k.t) {
    case 'int':
      if (typeof v !== 'bigint') throw new Error(`expected Int, got ${String(v)}`);
      return v;
    case 'bool':
      return v === true ? 1n : 0n;
    case 'enum': {
      const tag = v && typeof v === 'object' && !Array.isArray(v) && v.$ === 'enum' ? v.tag : undefined;
      const i = tag === undefined ? -1 : k.cases.indexOf(tag);
      if (i < 0) throw new Error(`expected enum ${k.cases.join('|')}`);
      return BigInt(i);
    }
    case 'str':
      if (typeof v !== 'string') throw new Error(`expected Str, got ${String(v)}`);
      if (!strings) throw new Error('string values need a string table');
      return BigInt(strings.intern(v));
  }
}

/** The scalar slots of one list element, in layout order. */
function elemSlots(shape: Shape, v: Val, strings: StrTable | undefined, out: bigint[]): void {
  switch (shape.t) {
    case 'unit':
      return;
    case 'rec':
      if (!isRec(v)) throw new Error('expected record');
      for (const f of shape.fields) elemSlots(f.shape, v.fields[f.name], strings, out);
      return;
    case 'int':
    case 'bool':
    case 'enum':
    case 'str':
      out.push(scalarSlot(v, shape, strings));
      return;
    default:
      throw new Error('list elements must be scalars or records of scalars');
  }
}

/** Write a Sigil list into linear memory at `addr` in the compiled layout. Returns the bytes used. */
export function writeList(view: DataView, addr: number, layout: ElemLayout, xs: Val, strings?: StrTable): number {
  if (!Array.isArray(xs)) throw new Error('expected a list');
  xs.forEach((x, i) => {
    const slots: bigint[] = [];
    elemSlots(layout.elem, x, strings, slots);
    slots.forEach((s, k) => view.setBigInt64(addr + (i * layout.stride + k) * SLOT, s, true));
  });
  return xs.length * layout.stride * SLOT;
}

function liftScalar(raw: bigint, k: Scalar, strings?: StrTable): Val {
  switch (k.t) {
    case 'int':
      return raw;
    case 'bool':
      return raw !== 0n;
    case 'enum':
      return enumVal(k.cases[Number(raw)]);
    case 'str':
      if (!strings) throw new Error('string values need a string table');
      return strings.get(Number(raw));
  }
}

function liftElem(shape: Shape, next: () => bigint, strings?: StrTable): Val {
  switch (shape.t) {
    case 'unit':
      return null;
    case 'rec':
      return { $: 'rec', type: shape.name, fields: Object.fromEntries(shape.fields.map((f) => [f.name, liftElem(f.shape, next, strings)])) };
    case 'int':
    case 'bool':
    case 'enum':
    case 'str':
      return liftScalar(next(), shape, strings);
    default:
      throw new Error('list elements must be scalars or records of scalars');
  }
}

/** Read `len` elements back from linear memory. */
export function readList(view: DataView, addr: number, len: number, layout: ElemLayout, strings?: StrTable): Val[] {
  const out: Val[] = [];
  for (let i = 0; i < len; i++) {
    let k = 0;
    out.push(liftElem(layout.elem, () => view.getBigInt64(addr + (i * layout.stride + k++) * SLOT, true), strings));
  }
  return out;
}

const zeroRaw = (n: number, repr: 'i32' | 'i64', s: Shape): Raw[] => {
  void n;
  return zerosOf(s, repr);
};
function zerosOf(s: Shape, repr: 'i32' | 'i64'): Raw[] {
  switch (s.t) {
    case 'unit':
      return [];
    case 'int':
      return [repr === 'i64' ? 0n : 0];
    case 'rec':
      return s.fields.flatMap((f) => zerosOf(f.shape, repr));
    case 'result':
      return [0, ...zerosOf(s.ok, repr), ...zerosOf(s.err, repr)];
    case 'list':
      return [0, 0];
    default:
      return [0];
  }
}

/** Lower an interpreter value to the raw leaves of `shape`. */
export function lowerVal(v: Val, shape: Shape, st: LowerState, out: Raw[]): void {
  switch (shape.t) {
    case 'unit':
      return;
    case 'int':
      if (typeof v !== 'bigint') throw new Error(`expected Int, got ${String(v)}`);
      out.push(st.repr === 'i64' ? v : Number(v));
      return;
    case 'bool':
    case 'enum':
    case 'str': {
      const s = scalarSlot(v, shape, st.strings);
      out.push(Number(s));
      return;
    }
    case 'rec':
      if (!isRec(v)) throw new Error(`expected record at ${st.who}`);
      for (const f of shape.fields) lowerVal(v.fields[f.name], f.shape, st, out);
      return;
    case 'result': {
      if (!v || typeof v !== 'object' || Array.isArray(v) || (v.$ !== 'ok' && v.$ !== 'err')) throw new Error(`expected Result at ${st.who}`);
      if (v.$ === 'ok') {
        out.push(0);
        lowerVal(v.v, shape.ok, st, out);
        out.push(...zeroRaw(0, st.repr, shape.err));
      } else {
        out.push(1);
        out.push(...zeroRaw(0, st.repr, shape.ok));
        lowerVal(v.v, shape.err, st, out);
      }
      return;
    }
    case 'list': {
      if (!st.memory) throw new Error(`${st.who} has list parameters: pass the instance's memory`);
      if (!Array.isArray(v)) throw new Error(`expected a list for ${st.who}`);
      if (v.length < shape.min || v.length > shape.max) throw new Error(`${st.who}: length ${v.length} outside declared ${shape.min}..${shape.max}`);
      writeList(new DataView(st.memory.buffer), st.cursor, shape.layout, v, st.strings);
      out.push(st.cursor, v.length);
      st.cursor += shape.max * shape.layout.stride * SLOT;
      return;
    }
  }
}

/** Lift raw leaves (consumed from `raws` starting at `pos.i`) to an interpreter value. */
export function liftVal(shape: Shape, raws: Raw[], pos: { i: number }, ctx: { memory?: WebAssembly.Memory; strings?: StrTable }): Val {
  switch (shape.t) {
    case 'unit':
      return null;
    case 'int':
      return BigInt(raws[pos.i++]);
    case 'bool':
      return raws[pos.i++] !== 0;
    case 'enum':
      return enumVal(shape.cases[Number(raws[pos.i++])]);
    case 'str':
      if (!ctx.strings) throw new Error('string values need a string table');
      return ctx.strings.get(Number(raws[pos.i++]));
    case 'rec':
      return { $: 'rec', type: shape.name, fields: Object.fromEntries(shape.fields.map((f) => [f.name, liftVal(f.shape, raws, pos, ctx)])) };
    case 'result': {
      const tag = Number(raws[pos.i++]);
      if (tag === 0) {
        const v = liftVal(shape.ok, raws, pos, ctx);
        pos.i += nleaves(shape.err);
        return okVal(v);
      }
      pos.i += nleaves(shape.ok);
      return errVal(liftVal(shape.err, raws, pos, ctx));
    }
    case 'list': {
      if (!ctx.memory) throw new Error('list results need the instance memory');
      const ptr = Number(raws[pos.i++]);
      const len = Number(raws[pos.i++]);
      return readList(new DataView(ctx.memory.buffer), ptr, len, shape.layout, ctx.strings);
    }
  }
}

export { MEM_BASE };
