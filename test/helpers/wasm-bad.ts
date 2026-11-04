// Malformed inputs for the validating-wrapper tests: values that violate their declared type in exactly one place
// (an Int just outside its range or far outside it, an unknown enum case, an over-long Str, a list one too long or
// too short, a value of the wrong kind), placed anywhere inside records, Results and list elements.

import { Program, Type, resolveType } from '../../src/ast.js';
import { ContractViolation, Host, Interp, Val, enumVal, errVal, okVal, showVal } from '../../src/interp.js';
import { ENV, Exports, callCompiled } from '../../src/wasm/abi.js';
import { FnReport } from '../../src/wasm/compile.js';
import { genVal } from './wasm-diff.js';

export interface Bad {
  val: Val;
  label: string;
}

/** One-violation variants of a value of type `t` (`ok` is a valid value of `t`, used for the parts left intact). */
export function badVariants(prog: Program, t: Type, ok: Val, rnd: () => number, depth = 0): Bad[] {
  const r = resolveType(prog, t);
  switch (r.k) {
    case 'int':
      return [
        { val: r.lo - 1n, label: `${r.lo - 1n} (lo - 1)` },
        { val: r.hi + 1n, label: `${r.hi + 1n} (hi + 1)` },
        { val: 2n ** 70n, label: '2^70 (wider than i64)' },
        { val: 'seven', label: 'a Str for an Int' },
      ];
    case 'bool':
      return [{ val: 1n, label: 'an Int for a Bool' }];
    case 'enum':
      return [
        { val: enumVal('NoSuchCase'), label: 'unknown enum case' },
        { val: 3n, label: 'an Int for an enum' },
      ];
    case 'str':
      return [
        ...(r.max !== undefined
          ? [
              { val: 'x'.repeat(r.max + 1), label: `Str of ${r.max + 1} chars (:max ${r.max})` },
              { val: '😀'.repeat(r.max + 1), label: `Str of ${r.max + 1} astral chars (:max ${r.max})` },
            ]
          : []),
        { val: 5n, label: 'an Int for a Str' },
      ];
    case 'unit':
      return [];
    case 'rec': {
      const okRec = ok as Extract<Val, { $: 'rec' }>;
      const out: Bad[] = [{ val: true, label: 'a Bool for a record' }];
      for (const f of r.fields) {
        for (const b of badVariants(prog, f.type, okRec.fields[f.name], rnd, depth + 1)) {
          out.push({ val: { $: 'rec', type: okRec.type, fields: { ...okRec.fields, [f.name]: b.val } }, label: `.${f.name}: ${b.label}` });
        }
      }
      return out;
    }
    case 'result': {
      const okV = genVal(prog, r.ok, rnd);
      const errV = genVal(prog, r.err, rnd);
      return [
        { val: 0n, label: 'an Int for a Result' },
        ...badVariants(prog, r.ok, okV, rnd, depth + 1).map((b) => ({ val: okVal(b.val), label: `.ok: ${b.label}` })),
        ...badVariants(prog, r.err, errV, rnd, depth + 1).map((b) => ({ val: errVal(b.val), label: `.err: ${b.label}` })),
      ];
    }
    case 'list': {
      const xs = ok as Val[];
      const elem = () => genVal(prog, r.elem, rnd);
      const out: Bad[] = [
        { val: Array.from({ length: r.max + 1 }, elem), label: `length ${r.max + 1} (max ${r.max})` },
        { val: 'not a list', label: 'a Str for a list' },
      ];
      if (r.min > 0) out.push({ val: Array.from({ length: r.min - 1 }, elem), label: `length ${r.min - 1} (min ${r.min})` });
      // one bad element, in the middle of an otherwise valid list
      const base = xs.length ? xs : r.max > 0 ? [elem()] : [];
      if (base.length) {
        const i = Math.floor(rnd() * base.length);
        for (const b of badVariants(prog, r.elem, base[i], rnd, depth + 1)) {
          const copy = [...base];
          copy[i] = b.val;
          out.push({ val: copy, label: `[${i}]${b.label.startsWith('.') ? '' : ': '}${b.label}` });
        }
      }
      return out;
    }
    default:
      return [];
  }
}

export interface Rejection {
  reason?: string;
  where?: string;
  message: string;
  contract: boolean;
}

const asRejection = (e: unknown): Rejection => {
  const c = e instanceof ContractViolation;
  return { reason: c ? e.reason : undefined, where: c ? e.where : undefined, message: (e as Error).message, contract: c };
};

/** Run one call on both backends; each side either returns or is rejected. */
export function bothSides(prog: Program, rep: FnReport, ex: Exports, args: Val[]): { interp: Rejection | Val; wasm: Rejection | Val; byModule: boolean } {
  const wh = ex[ENV]!.host!;
  const before = wh.violations;
  let interp: Rejection | Val;
  let wasm: Rejection | Val;
  try {
    interp = new Interp(prog, new Host(1)).callFn(rep.name, args);
  } catch (e) {
    interp = asRejection(e);
  }
  try {
    wasm = callCompiled(rep, ex, args);
  } catch (e) {
    wasm = asRejection(e);
  }
  return { interp, wasm, byModule: wh.violations > before };
}

export const isRejection = (x: unknown): x is Rejection => !!x && typeof x === 'object' && 'contract' in (x as object) && 'message' in (x as object);

export const showArgs = (args: Val[]) => args.map(showVal).join(', ').slice(0, 300);
