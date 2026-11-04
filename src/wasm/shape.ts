// Value shapes of the Wasm backend: how a Sigil type is laid out as a flat sequence of Wasm "leaves".
//
//   Int          1 leaf  (i32 or i64 per function representation)
//   Bool, enum   1 leaf  (i32; enum = index into the case list)
//   Str          1 leaf  (i32 handle into a host-owned string table)
//   Unit         0 leaves
//   record       the leaves of its fields, in declaration order
//   Result       1 tag leaf (i32: 0 = ok, 1 = err), then the ok payload's leaves, then the err payload's leaves.
//                The payload of the inactive side is all zeros (so structural equality can compare every leaf).
//   List         2 leaves (i32 ptr, i32 len) into linear memory; elements are fixed-stride arrays of 8-byte slots,
//                one i64 slot per scalar leaf of the element (Int, Bool, enum, Str handle)
//
// Function parameters are the concatenation of their leaves; results are returned with Wasm multi-value.

import { Program, Type, resolveType } from '../ast.js';
import { ValType } from './encode.js';

export type Scalar = { t: 'int'; lo?: bigint; hi?: bigint } | { t: 'bool' } | { t: 'enum'; cases: string[] } | { t: 'str'; max?: number };
export interface ElemLeaf {
  path: string;
  kind: Scalar;
  slot: number;
  lo?: bigint;
  hi?: bigint;
}
/** Memory layout of one list element: `stride` 8-byte slots, one per scalar leaf. */
export interface ElemLayout {
  stride: number;
  leaves: ElemLeaf[];
  key: string;
  elem: Shape; // the element's shape (a scalar or a record of scalars)
}
export type Shape =
  | Scalar
  | { t: 'unit' }
  | { t: 'rec'; name: string; fields: { name: string; shape: Shape }[] }
  | { t: 'result'; ok: Shape; err: Shape }
  | { t: 'list'; layout: ElemLayout; min: number; max: number };
export type Kind = Shape;
export type ListShape = Extract<Shape, { t: 'list' }>;

/** Inputs plus scratch above this many bytes are refused (a list type with an absurd declared maximum). */
export const MAX_MEMORY_BYTES = 16 * 1024 * 1024;
export const MEM_BASE = 16; // inputs start here (keeps address 0 unused)
export const SLOT = 8;

export class NotCompilable extends Error {}
export const no = (reason: string): never => {
  throw new NotCompilable(reason);
};

export const showShape = (s: Shape): string => {
  switch (s.t) {
    case 'enum':
      return `enum(${s.cases.join('|')})`;
    case 'list':
      return `list(${s.layout.key})`;
    case 'rec':
      return `rec${s.name ? ' ' + s.name : ''}(${s.fields.map((f) => `${f.name}:${showShape(f.shape)}`).join(', ')})`;
    case 'result':
      return `Result(${showShape(s.ok)}, ${showShape(s.err)})`;
    default:
      return s.t;
  }
};

const sameCases = (a: string[], b: string[]) => a.length === b.length && a.every((c, i) => c === b[i]);
/** Structural equality of shapes (ignores integer ranges, string maxima and record type names). */
export function sameShape(a: Shape, b: Shape): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'enum':
      return sameCases(a.cases, (b as typeof a).cases);
    case 'list':
      return a.layout.key === (b as typeof a).layout.key;
    case 'rec': {
      const bb = b as typeof a;
      return a.fields.length === bb.fields.length && a.fields.every((f, i) => f.name === bb.fields[i].name && sameShape(f.shape, bb.fields[i].shape));
    }
    case 'result':
      return sameShape(a.ok, (b as typeof a).ok) && sameShape(a.err, (b as typeof a).err);
    default:
      return true;
  }
}

/** Number of Wasm leaves. */
export function nleaves(s: Shape): number {
  switch (s.t) {
    case 'unit':
      return 0;
    case 'rec':
      return s.fields.reduce((n, f) => n + nleaves(f.shape), 0);
    case 'result':
      return 1 + nleaves(s.ok) + nleaves(s.err);
    case 'list':
      return 2;
    default:
      return 1;
  }
}

/** Wasm value types of the leaves, given the function's integer representation. */
export function wtypes(s: Shape, int: ValType): ValType[] {
  switch (s.t) {
    case 'unit':
      return [];
    case 'int':
      return [int];
    case 'rec':
      return s.fields.flatMap((f) => wtypes(f.shape, int));
    case 'result':
      return ['i32', ...wtypes(s.ok, int), ...wtypes(s.err, int)];
    case 'list':
      return ['i32', 'i32'];
    default:
      return ['i32'];
  }
}

/** For each leaf: is it an Int (the only leaf type whose width depends on the function's representation)? */
export function intLeaves(s: Shape): boolean[] {
  switch (s.t) {
    case 'unit':
      return [];
    case 'int':
      return [true];
    case 'rec':
      return s.fields.flatMap((f) => intLeaves(f.shape));
    case 'result':
      return [false, ...intLeaves(s.ok), ...intLeaves(s.err)];
    case 'list':
      return [false, false];
    default:
      return [false];
  }
}

/** The list shapes inside a shape, in leaf order (their (ptr, len) pairs appear in this order). */
export function listsOf(s: Shape): ListShape[] {
  switch (s.t) {
    case 'rec':
      return s.fields.flatMap((f) => listsOf(f.shape));
    case 'result':
      return [...listsOf(s.ok), ...listsOf(s.err)];
    case 'list':
      return [s];
    default:
      return [];
  }
}

/** Magnitudes of every declared integer range inside a shape (including list elements). */
export function magnitudes(s: Shape, out: bigint[] = []): bigint[] {
  switch (s.t) {
    case 'int':
      if (s.lo !== undefined) out.push(s.lo < 0n ? -s.lo : s.lo, s.hi! < 0n ? -s.hi! : s.hi!);
      break;
    case 'rec':
      s.fields.forEach((f) => magnitudes(f.shape, out));
      break;
    case 'result':
      magnitudes(s.ok, out);
      magnitudes(s.err, out);
      break;
    case 'list':
      magnitudes(s.layout.elem, out);
      break;
  }
  return out;
}

export function hasStr(s: Shape): boolean {
  switch (s.t) {
    case 'str':
      return true;
    case 'rec':
      return s.fields.some((f) => hasStr(f.shape));
    case 'result':
      return hasStr(s.ok) || hasStr(s.err);
    case 'list':
      return hasStr(s.layout.elem);
    default:
      return false;
  }
}

/** Layout of a list element. Elements are scalars or records of scalars. */
export function layoutOf(elem: Shape, what: string): ElemLayout {
  const leaves: ElemLeaf[] = [];
  const walkS = (x: Shape, path: string, w: string) => {
    switch (x.t) {
      case 'rec':
        for (const f of x.fields) walkS(f.shape, path ? `${path}.${f.name}` : f.name, `${w}.${f.name}`);
        return;
      case 'unit':
        return;
      case 'list':
        return no(`${w} is a nested list (not supported)`);
      case 'result':
        return no(`${w} is a Result inside a list element (not supported)`);
      default:
        leaves.push({ path, kind: x, slot: leaves.length, ...(x.t === 'int' && x.lo !== undefined ? { lo: x.lo, hi: x.hi } : {}) });
    }
  };
  walkS(elem, '', what);
  if (!leaves.length) no(`${what} has no scalar fields`);
  return { stride: leaves.length, leaves, key: leaves.map((l) => `${l.path}:${showShape(l.kind)}`).join(','), elem };
}

export interface ShapeOpts {
  /** Str is compiled as an opaque host handle. */
  strings: boolean;
}

export function shapeOf(prog: Program, t: Type, what: string, opts: ShapeOpts, depth = 0): Shape {
  if (depth > 16) return no(`${what}: type nesting too deep (recursive type?)`);
  const r = resolveType(prog, t);
  const name = t.k === 'named' ? t.name : '';
  switch (r.k) {
    case 'int':
      return { t: 'int', lo: r.lo, hi: r.hi };
    case 'bool':
      return { t: 'bool' };
    case 'enum':
      return { t: 'enum', cases: r.cases };
    case 'unit':
      return { t: 'unit' };
    case 'str':
      if (!opts.strings) return no(`${what} has type str, which is outside the compiled subset`);
      return { t: 'str', ...(r.max !== undefined ? { max: r.max } : {}) };
    case 'rec':
      return { t: 'rec', name, fields: r.fields.map((f) => ({ name: f.name, shape: shapeOf(prog, f.type, `${what}.${f.name}`, opts, depth + 1) })) };
    case 'result':
      return { t: 'result', ok: shapeOf(prog, r.ok, `${what}.ok`, opts, depth + 1), err: shapeOf(prog, r.err, `${what}.err`, opts, depth + 1) };
    case 'list': {
      const layout = layoutOf(shapeOf(prog, r.elem, `${what} element`, opts, depth + 1), `${what} element`);
      const bytes = r.max * layout.stride * SLOT;
      if (!Number.isFinite(r.max) || r.max < 0 || bytes > MAX_MEMORY_BYTES) no(`${what}: list maximum length ${r.max} needs ${bytes} bytes, over the ${MAX_MEMORY_BYTES} byte limit`);
      return { t: 'list', layout, min: r.min, max: r.max };
    }
    default:
      return no(`${what} has type ${(r as { k: string }).k}, which is outside the compiled subset`);
  }
}

/** The flattened leaves of a shape with dotted paths (for reports); result sides are `#tag`, `ok`, `err`. */
export function flatLeaves(s: Shape, path = ''): { path: string; kind: Shape; lo?: bigint; hi?: bigint }[] {
  const j = (seg: string) => (path ? `${path}.${seg}` : seg);
  switch (s.t) {
    case 'unit':
      return [];
    case 'rec':
      return s.fields.flatMap((f) => flatLeaves(f.shape, j(f.name)));
    case 'result':
      return [{ path: j('#tag'), kind: { t: 'bool' } }, ...flatLeaves(s.ok, j('ok')), ...flatLeaves(s.err, j('err'))];
    case 'int':
      return [{ path, kind: s, lo: s.lo, hi: s.hi }];
    default:
      return [{ path, kind: s }];
  }
}


/** JSON of shapes without integer ranges (bigint is not JSON): a stable key and the serialized ABI form. */
export const shapeJson = (v: unknown): string => JSON.stringify(v, (k, x) => (k === 'lo' || k === 'hi' ? undefined : x));
