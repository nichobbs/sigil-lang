// Shared helpers for the Wasm differential tests: seeded boundary-biased value generation and a runner that
// executes the same inputs on the reference interpreter and on the compiled module and compares everything observable.

import { expect } from 'vitest';
import { Program, Type, resolveType } from '../../src/ast.js';
import { check } from '../../src/check.js';
import { Host, Interp, Val, enumVal, eqVal, errVal, mulberry32, okVal, showVal } from '../../src/interp.js';
import { parsePolicy, parseProgram } from '../../src/parse.js';
import { callCompiled, instantiate } from '../../src/wasm/abi.js';
import { CompileOptions, CompileResult, compileProgram } from '../../src/wasm/compile.js';

export function build(src: string, policy = '(policy)', opts: CompileOptions = {}) {
  const prog = parseProgram(src);
  const res = check(prog, parsePolicy(policy));
  return { prog, res, out: compileProgram(prog, res, opts) };
}

export function genInt(rnd: () => number, lo: bigint, hi: bigint): bigint {
  const inR = (v: bigint) => v >= lo && v <= hi;
  const r = rnd();
  if (r < 0.35) {
    const c = [lo, hi, lo + 1n, hi - 1n, 0n, 1n, -1n, -2n, 2n, 7n, -7n, 1000n, 1001n, 999n, (lo + hi) / 2n].filter(inR);
    return c[Math.floor(rnd() * c.length)];
  }
  if (r < 0.55) {
    const off = BigInt(Math.floor(rnd() * 16));
    return rnd() < 0.5 ? (lo + off > hi ? hi : lo + off) : hi - off < lo ? lo : hi - off;
  }
  const span = hi - lo + 1n;
  let big = 0n;
  for (let i = 0; i < 4; i++) big = (big << 32n) | BigInt(Math.floor(rnd() * 4294967296));
  return lo + (big % span);
}

export const STR_POOL = ['', 'a', 'Ada', 'a@x.com', 'hello world', 'ünï', 'Ada', '日本', '😀x', 'x'];

export function genVal(prog: Program, t: Type, rnd: () => number): Val {
  const r = resolveType(prog, t);
  switch (r.k) {
    case 'int':
      return genInt(rnd, r.lo, r.hi);
    case 'bool':
      return rnd() < 0.5;
    case 'unit':
      return null;
    case 'str': {
      const s = STR_POOL[Math.floor(rnd() * STR_POOL.length)];
      return r.max !== undefined ? Array.from(s).slice(0, r.max).join('') : s;
    }
    case 'enum':
      return enumVal(r.cases[Math.floor(rnd() * r.cases.length)]);
    case 'rec':
      return { $: 'rec', type: t.k === 'named' ? t.name : '', fields: Object.fromEntries(r.fields.map((f) => [f.name, genVal(prog, f.type, rnd)])) };
    case 'result':
      return rnd() < 0.5 ? okVal(genVal(prog, r.ok, rnd)) : errVal(genVal(prog, r.err, rnd));
    case 'list': {
      const pick = rnd();
      const len = pick < 0.15 ? r.min : pick < 0.3 ? r.max : pick < 0.4 ? Math.min(r.max, r.min + 1) : pick < 0.5 ? Math.max(r.min, r.max - 1) : r.min + Math.floor(rnd() * (r.max - r.min + 1));
      const extreme = rnd() < 0.2;
      return Array.from({ length: len }, () => {
        if (!extreme) return genVal(prog, r.elem, rnd);
        const saved = rnd;
        return genVal(prog, r.elem, () => (saved() < 0.5 ? 0.9999999 : 0));
      });
    }
    default:
      throw new Error(`cannot generate ${r.k}`);
  }
}

export interface DiffOptions {
  n?: number;
  seed?: number;
  /** Generate arguments (default: random values of the declared parameter types). */
  args?: (rnd: () => number, i: number) => Val[];
}
export interface DiffResult {
  runs: number;
  mismatches: string[];
  inputs: Val[][];
  wants: Val[];
}

const unitResult = (prog: Program, name: string) => resolveType(prog, prog.fns.get(name)!.out).k === 'unit';

/** Run the reference interpreter and the compiled Wasm on the same inputs and compare results. */
export async function differential(prog: Program, out: CompileResult, name: string, o: DiffOptions = {}): Promise<DiffResult> {
  const n = o.n ?? 300;
  const report = out.fns.find((f) => f.name === name)!;
  expect(report.compilable, `${name}: ${report.reason}`).toBe(true);
  const exports = await instantiate(out.bytes);
  const fd = prog.fns.get(name)!;
  const rnd = mulberry32(o.seed ?? 4242);
  const res: DiffResult = { runs: 0, mismatches: [], inputs: [], wants: [] };
  for (let i = 0; i < n; i++) {
    const args = o.args ? o.args(rnd, i) : fd.params.map((p) => genVal(prog, p.type, rnd));
    const want = new Interp(prog, new Host(1)).callFn(name, args);
    const got = callCompiled(report, exports, args);
    res.runs++;
    res.inputs.push(args);
    res.wants.push(want);
    // a failed `emit` makes the interpreter return an err Result where Unit is declared; Unit carries no information
    if (!(unitResult(prog, name) || eqVal(want, got))) res.mismatches.push(`${name}(${args.map(showVal).join(', ').slice(0, 300)}): interpreter ${showVal(want)}, wasm ${showVal(got)}`);
  }
  return res;
}
