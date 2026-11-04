// Effect-log differential testing: the same inputs, host seeds and injected failures go through the interpreter and
// the compiled module (with the JS host adapter), and the result and the complete effect log must be identical.

import { expect } from 'vitest';
import { Expr, Program, Type, resolveType } from '../../src/ast.js';
import { CAP_OPS } from '../../src/caps.js';
import { Host, Interp, Observation, Val, eqVal, errVal, mulberry32, okVal, showVal } from '../../src/interp.js';
import { ENV, callCompiled, instantiate } from '../../src/wasm/abi.js';
import { CompileResult } from '../../src/wasm/compile.js';
import { DiffOptions, genInt, genVal } from './wasm-diff.js';

export type GenMode = 'wide' | 'medium' | 'small';

/** Like genVal, but integers can be drawn from a small or medium range so that business thresholds are crossed both ways. */
export function genValMode(prog: Program, t: Type, rnd: () => number, mode: GenMode): Val {
  if (mode === 'wide') return genVal(prog, t, rnd);
  const r = resolveType(prog, t);
  const hi = mode === 'small' ? 60n : 3000n;
  switch (r.k) {
    case 'int': {
      const lo2 = r.lo < 0n ? (mode === 'small' ? -20n : -3000n) : r.lo;
      const a = lo2 > r.lo ? lo2 : r.lo;
      const b = hi < r.hi ? hi : r.hi;
      if (a > b || rnd() < 0.2) return genInt(rnd, r.lo, r.hi);
      return a + BigInt(Math.floor(rnd() * Number(b - a + 1n)));
    }
    case 'rec':
      return { $: 'rec', type: t.k === 'named' ? t.name : '', fields: Object.fromEntries(r.fields.map((f) => [f.name, genValMode(prog, f.type, rnd, mode)])) };
    case 'result':
      return rnd() < 0.5 ? okVal(genValMode(prog, r.ok, rnd, mode)) : errVal(genValMode(prog, r.err, rnd, mode));
    case 'list': {
      const len = r.min + Math.floor(rnd() * (Math.min(r.max, mode === 'small' ? r.min + 6 : r.max) - r.min + 1));
      return Array.from({ length: len }, () => genValMode(prog, r.elem, rnd, mode));
    }
    default:
      return genVal(prog, t, rnd);
  }
}

/** Every (handle, op) pair used by a function and everything it calls. */
export function capPairs(prog: Program, name: string, seen = new Set<string>(), out = new Set<string>()): string[] {
  if (seen.has(name)) return [...out];
  seen.add(name);
  const walkE = (e: Expr) => {
    switch (e.k) {
      case 'call':
        if (e.fn in CAP_OPS && e.args[0]?.k === 'var') out.add(`${e.args[0].name}.${e.fn}`);
        else if (prog.fns.has(e.fn)) capPairs(prog, e.fn, seen, out);
        e.args.forEach(walkE);
        e.kw.forEach((k) => walkE(k.value));
        break;
      case 'let':
        e.binds.forEach((b) => walkE(b.value));
        e.body.forEach(walkE);
        break;
      case 'match':
        walkE(e.scrut);
        e.arms.forEach((a) => walkE(a.body));
        break;
      case 'if':
        walkE(e.cond);
        walkE(e.then);
        walkE(e.else);
        break;
      case 'lam':
        walkE(e.body);
        break;
      case 'do':
        e.body.forEach(walkE);
        break;
      case 'try':
        walkE(e.expr);
        break;
    }
  };
  walkE(prog.fns.get(name)!.body);
  return [...out];
}

const sameLog = (a: Observation[], b: Observation[]): string | null => {
  if (a.length !== b.length) return `log length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.handle !== y.handle || x.op !== y.op || x.ok !== y.ok || x.args.length !== y.args.length || !x.args.every((v, k) => eqVal(v, y.args[k]))) {
      return `log[${i}]: interpreter ${x.handle}.${x.op}(${x.args.map(showVal).join(', ')}) ok=${x.ok}, wasm ${y.handle}.${y.op}(${y.args.map(showVal).join(', ')}) ok=${y.ok}`;
    }
  }
  return null;
};

export interface EffectDiffResult {
  runs: number;
  mismatches: string[];
  /** Outcomes seen, as short strings (e.g. "ok", "err NeedsApproval", "throws"), for coverage assertions. */
  outcomes: Map<string, number>;
  /** Effect operations seen across all runs, as "handle.op" (with " (failed)" for injected failures). */
  ops: Map<string, number>;
  failedRuns: number;
}

const isUnit = (prog: Program, name: string) => resolveType(prog, prog.fns.get(name)!.out).k === 'unit';

/**
 * Run the same inputs, host seeds and injected failures through the interpreter and the compiled module and compare
 * the result (or that both fail) and the complete effect log (handle, operation, arguments, success).
 */
export async function differentialEffects(prog: Program, out: CompileResult, name: string, o: DiffOptions & { failP?: number; failOps?: string[] } = {}): Promise<EffectDiffResult> {
  const n = o.n ?? 300;
  const report = out.fns.find((f) => f.name === name)!;
  expect(report.compilable, `${name}: ${report.reason}`).toBe(true);
  const exports = await instantiate(out.bytes, new Host(1));
  const wasmHost = exports[ENV]!.host!;
  const fd = prog.fns.get(name)!;
  const rnd = mulberry32(o.seed ?? 777);
  // `fresh` is not failed by default: the interpreter continues with an err value in an Int position (a documented
  // difference; see src/wasm/host.ts and the dedicated test).
  const failOps = o.failOps ?? ['put', 'post', 'emit'];
  const pairs = capPairs(prog, name).filter((p) => failOps.includes(p.slice(p.lastIndexOf('.') + 1)));
  const res: EffectDiffResult = { runs: 0, mismatches: [], outcomes: new Map(), ops: new Map(), failedRuns: 0 };
  const modes: GenMode[] = ['wide', 'medium', 'small'];
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (let i = 0; i < n; i++) {
    const mode = modes[Math.floor(rnd() * 3)];
    const args = o.args ? o.args(rnd, i) : fd.params.map((p) => genValMode(prog, p.type, rnd, mode));
    const hostSeed = 1 + Math.floor(rnd() * 1000);
    const failing = pairs.filter(() => rnd() < (o.failP ?? 0.3));
    const hostI = new Host(hostSeed);
    const hostX = new Host(hostSeed);
    for (const f of failing) {
      const cut = f.lastIndexOf('.');
      hostI.fail(f.slice(0, cut), f.slice(cut + 1));
      hostX.fail(f.slice(0, cut), f.slice(cut + 1));
    }
    wasmHost.host = hostX;
    let want: Val | undefined;
    let wantErr: string | undefined;
    try {
      want = new Interp(prog, hostI).callFn(name, args);
    } catch (e) {
      wantErr = (e as Error).message;
    }
    let got: Val | undefined;
    let gotErr: string | undefined;
    try {
      got = callCompiled(report, exports, args);
    } catch (e) {
      gotErr = (e as Error).message;
    }
    res.runs++;
    const w = want as { $?: string; v?: Val } | null | undefined;
    const isObj = !!w && typeof w === 'object' && !Array.isArray(w);
    bump(res.outcomes, wantErr !== undefined ? 'throws' : isObj && w.$ === 'err' ? `err ${showVal(w.v ?? null)}` : isObj && w.$ === 'ok' ? 'ok' : 'value');
    if (failing.length) res.failedRuns++;
    for (const ob of hostI.log) bump(res.ops, `${ob.handle}.${ob.op}${ob.ok ? '' : ' (failed)'}`);
    const ctx = `${name}(${args.map(showVal).join(', ').slice(0, 300)}) seed=${hostSeed} failing=[${failing}]`;
    if ((wantErr === undefined) !== (gotErr === undefined)) {
      res.mismatches.push(`${ctx}: interpreter ${wantErr ?? showVal(want!)}, wasm ${gotErr ?? showVal(got!)}`);
      continue;
    }
    if (wantErr === undefined && !(isUnit(prog, name) || eqVal(want!, got!))) res.mismatches.push(`${ctx}: interpreter ${showVal(want!)}, wasm ${showVal(got!)}`);
    const logDiff = sameLog(hostI.log, hostX.log);
    if (logDiff) res.mismatches.push(`${ctx}: ${logDiff}`);
  }
  return res;
}
