// JSON conventions shared by both runners (see experiments/README.md, "Value encoding").

import { Program, Type, resolveType } from '../../src/ast.js';
import { Val, enumVal, errVal, okVal } from '../../src/interp.js';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Deep-copy a value that must be plain JSON data. Throws a descriptive error otherwise. */
export function toJson(v: unknown, path = '$'): Json {
  if (v === null) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      if (!Number.isFinite(v)) throw new Error(`${path}: non-finite number`);
      if (Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error(`${path}: integer beyond 2^53`);
      return v;
    case 'bigint':
      throw new Error(`${path}: bigint is not JSON (use number)`);
    case 'undefined':
      throw new Error(`${path}: undefined`);
    case 'object': {
      if (Array.isArray(v)) return v.map((x, i) => toJson(x, `${path}[${i}]`));
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error(`${path}: not a plain object`);
      const out: { [k: string]: Json } = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined) continue; // absent, like JSON.stringify
        out[k] = toJson(x, `${path}.${k}`);
      }
      return out;
    }
    default:
      throw new Error(`${path}: ${typeof v} is not JSON`);
  }
}

/** Structural equality, object key order ignored. Returns the path of the first difference, or null. */
export function firstDiff(a: Json, b: Json, path = '$'): string | null {
  if (a === b) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return path;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return path;
    if (a.length !== b.length) return `${path}.length`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join('\0') !== kb.join('\0')) {
    const missing = kb.find((k) => !(k in a));
    const extra = ka.find((k) => !(k in b));
    return missing !== undefined ? `${path}.${missing} (missing)` : `${path}.${extra} (unexpected)`;
  }
  for (const k of ka) {
    const d = firstDiff((a as Record<string, Json>)[k], (b as Record<string, Json>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

export const show = (v: unknown, n = 240): string => {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > n ? s.slice(0, n) + '...' : s;
};

/** Sigil runtime value -> JSON. Enums become their case name, Result becomes {ok}/{err}, unit is null. */
export function encodeVal(v: Val, path = '$'): Json {
  if (v === null) return null;
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${path}: integer beyond 2^53`);
    return Number(v);
  }
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x, i) => encodeVal(x, `${path}[${i}]`));
  switch (v.$) {
    case 'enum':
      return v.tag;
    case 'ok':
      return { ok: encodeVal(v.v, `${path}.ok`) };
    case 'err':
      return { err: encodeVal(v.v, `${path}.err`) };
    case 'rec': {
      const o: { [k: string]: Json } = {};
      for (const [k, x] of Object.entries(v.fields)) o[k] = encodeVal(x, `${path}.${k}`);
      return o;
    }
  }
}

/** JSON -> Sigil runtime value, guided by a declared type. */
export function decodeVal(prog: Program, t: Type, j: Json, path = '$', name = ''): Val {
  if (t.k === 'named') return decodeVal(prog, resolveType(prog, t), j, path, t.name);
  const bad = (m: string): never => {
    throw new Error(`${path}: ${m}`);
  };
  switch (t.k) {
    case 'int':
      if (typeof j !== 'number' || !Number.isInteger(j)) return bad(`expected integer, got ${show(j, 40)}`);
      return BigInt(j);
    case 'str':
      return typeof j === 'string' ? j : bad('expected string');
    case 'bool':
      return typeof j === 'boolean' ? j : bad('expected boolean');
    case 'unit':
      return null;
    case 'enum':
      if (typeof j !== 'string' || !t.cases.includes(j)) return bad(`expected one of ${t.cases.join('|')}, got ${show(j, 40)}`);
      return enumVal(j);
    case 'list':
      if (!Array.isArray(j)) return bad('expected array');
      return j.map((x, i) => decodeVal(prog, t.elem, x, `${path}[${i}]`));
    case 'rec': {
      if (j === null || typeof j !== 'object' || Array.isArray(j)) return bad('expected object');
      const fields: Record<string, Val> = {};
      for (const f of t.fields) {
        if (!(f.name in j)) return bad(`missing field ${f.name}`);
        fields[f.name] = decodeVal(prog, f.type, (j as Record<string, Json>)[f.name], `${path}.${f.name}`);
      }
      return { $: 'rec', type: name, fields };
    }
    case 'result': {
      if (j === null || typeof j !== 'object' || Array.isArray(j)) return bad('expected {ok} or {err}');
      if ('ok' in j) return okVal(decodeVal(prog, t.ok, (j as Record<string, Json>).ok, `${path}.ok`));
      if ('err' in j) return errVal(decodeVal(prog, t.err, (j as Record<string, Json>).err, `${path}.err`));
      return bad('expected {ok} or {err}');
    }
    default:
      return bad(`unsupported type ${(t as { k: string }).k}`);
  }
}
