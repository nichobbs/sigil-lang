// Calling convention between interpreter values and compiled Wasm functions.
//   Int  -> i32 (Number) or i64 (BigInt), per FnReport.repr
//   Bool -> i32 0/1
//   enum -> i32 index into the type's case list
//   record parameters are flattened to one scalar parameter per leaf field, in declaration order.

import { Val, enumVal } from '../interp.js';
import { FnReport, Kind } from './compile.js';

export type Raw = number | bigint;

function lowerLeaf(v: Val, kind: Kind, repr: 'i32' | 'i64'): Raw {
  switch (kind.t) {
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

export function lowerArgs(fn: FnReport, args: Val[]): Raw[] {
  if (!fn.compilable || !fn.params || !fn.repr) throw new Error(`${fn.name} is not compilable`);
  const out: Raw[] = [];
  fn.params.forEach((p, i) => {
    for (const leaf of p.leaves) {
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
  }
}

export async function instantiate(bytes: Uint8Array): Promise<Record<string, (...a: Raw[]) => Raw>> {
  const mod = await WebAssembly.compile(new Uint8Array(bytes)); // also validates the module
  const instance = await WebAssembly.instantiate(mod, {});
  return instance.exports as unknown as Record<string, (...a: Raw[]) => Raw>;
}

export function callCompiled(fn: FnReport, exports: Record<string, (...a: Raw[]) => Raw>, args: Val[]): Val {
  return liftResult(fn, exports[fn.name](...lowerArgs(fn, args)));
}
