// The trust boundary of a compiled module: every export validates its arguments against their declared types before
// any unchecked code runs (src/wasm/validate.ts), and rejects out-of-range or malformed input the same way the
// interpreter's contract check does (ContractViolation with the same reason and the same `where` path).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContractViolation, Host, Interp, RuntimeFault, Val, enumVal, errVal, mulberry32, okVal } from '../src/interp.js';
import { parsePolicy, parseProgram } from '../src/parse.js';
import { check } from '../src/check.js';
import { ABI_VERSION, ENV, Exports, callCompiled, instantiate, isValidated, lowerArgs, readAbi } from '../src/wasm/abi.js';
import { compileProgram } from '../src/wasm/compile.js';
import { WasmHost } from '../src/wasm/host.js';
import { badVariants, bothSides, isRejection, showArgs } from './helpers/wasm-bad.js';
import { build, genVal } from './helpers/wasm-diff.js';

const POLICY = `
(policy
  (allow rand)
  (sink rand (accepts public)))
`;

const FIXTURE = `
(type Small (Int -5 5))
(type Plan  (var Free Pro Team))
(type Note  (Str :max 4))
(type Pt    (rec (x Small) (on Bool) (plan Plan)))
(type Item  (rec (id (Int 1 100)) (plan Plan) (label Note)))
(type Inner (rec (n (Int 0 9))))
(type Outer (rec (inner Inner) (k Plan)))
(type Err   (var Bad Worse))

(fn add1 (in (n Small)) (out (Int -4 6)) (add n 1))
(fn wide (in (n (Int -9007199254740991 9007199254740991))) (out (Int -9007199254740990 9007199254740992)) (add n 1))
(fn flag (in (b Bool)) (out Bool) (not b))
(fn plan-ix (in (p Plan)) (out (Int 0 2)) (match p (Free 0) (Pro 1) (Team 2)))
(fn note-len (in (s Note)) (out (Int 0 4)) (len (chars s)))
(fn any-str (in (s Str)) (out Bool) (= s "x"))
(fn nested (in (o Outer)) (out (Int 0 9)) o.inner.n)
(fn res-val (in (r (Result Small Err))) (out (Int -5 5)) (match r (ok v v) (err _ 0)))
(fn pt-sum (in (ps (List Pt 1 4))) (out (Int -20 20)) (sum (map ps (fn (p) p.x))))
(fn item-count (in (xs (List Item 0 3)) (k Plan)) (out (Int 0 3)) (len (filter xs (fn (i) (= i.plan k)))))
(fn fresh-small (in (n Small)) (out (Int 0 9007199254740991)) (needs rand) (fresh rand))

(program app
  (targets server)
  (entry fresh-small
    (bind rand (rand seeded))))
`;

const { prog, out } = build(FIXTURE, POLICY);
const rep = (n: string) => {
  const r = out.fns.find((f) => f.name === n)!;
  expect(r.compilable, `${n}: ${r.reason}`).toBe(true);
  return r;
};
const rec = (type: string, fields: Record<string, Val>): Val => ({ $: 'rec', type, fields });
const pt = (x: bigint, on = true, plan = 'Pro') => rec('Pt', { x, on, plan: enumVal(plan) });
const item = (id: bigint, plan: string, label: string) => rec('Item', { id, plan: enumVal(plan), label });

/** Expect both backends to reject with a ContractViolation of this reason at this place; returns the wasm error. */
function bothReject(ex: Exports, name: string, args: Val[], reason: string, where: string, byModule = true) {
  const r = bothSides(prog, rep(name), ex, args);
  expect(isRejection(r.interp) && r.interp, `interp ${name}(${showArgs(args)})`).toMatchObject({ contract: true, reason, where });
  expect(isRejection(r.wasm) && r.wasm, `wasm ${name}(${showArgs(args)})`).toMatchObject({ contract: true, reason, where });
  expect(r.byModule, `rejected by the module itself (not the JS adapter): ${name}(${showArgs(args)})`).toBe(byModule);
  return r.wasm as { message: string };
}

describe('validating export wrappers: ABI', () => {
  it('modules are flagged validated (ABI version 2) and declare their check sites', async () => {
    expect(ABI_VERSION).toBe(2);
    expect(out.abi.version).toBe(2);
    expect(out.abi.validated).toBe(true);
    expect(isValidated(out.abi)).toBe(true);
    const mod = await WebAssembly.compile(new Uint8Array(out.bytes));
    expect(isValidated(mod)).toBe(true);
    expect(readAbi(mod).checks).toEqual(out.abi.checks);
    expect(out.abi.checks!.length).toBeGreaterThan(10);
    expect(new Set(out.abi.checks!.map((c) => c.reason))).toEqual(new Set(['range', 'type', 'enum', 'str-max', 'encoding', 'list-length', 'memory', 'host-result']));
    expect(isValidated({ version: 1, strings: [], handles: [], effects: [] })).toBe(false);
  });

  it('only the wrappers (and the memory) are exported: the unchecked bodies are internal', async () => {
    const mod = await WebAssembly.compile(new Uint8Array(out.bytes));
    const names = WebAssembly.Module.exports(mod).map((e) => e.name).sort();
    expect(names).toEqual([...out.fns.filter((f) => f.compilable).map((f) => f.name), 'memory'].sort());
    const imports = WebAssembly.Module.imports(mod).map((i) => i.name);
    expect(imports).toContain('contract_violation');
    expect(imports).toContain('str_len');
  });
});

describe('validating export wrappers: each check, against the interpreter', () => {
  it('Int ranges (scalar, i32 and i64, nested record fields, Result payloads, list elements)', async () => {
    const ex = await instantiate(out.bytes);
    expect(callCompiled(rep('add1'), ex, [5n])).toBe(6n);
    const m = bothReject(ex, 'add1', [6n], 'range', 'add1(n)');
    expect(m.message).toBe('add1(n): 6 outside [-5, 5]'); // word for word the interpreter's message
    bothReject(ex, 'add1', [-6n], 'range', 'add1(n)');
    bothReject(ex, 'add1', [2n ** 40n], 'range', 'add1(n)', false); // has no i32 encoding: the adapter refuses it
    bothReject(ex, 'wide', [9007199254740992n], 'range', 'wide(n)');
    bothReject(ex, 'nested', [rec('Outer', { inner: rec('Inner', { n: 10n }), k: enumVal('Free') })], 'range', 'nested(o).inner.n');
    bothReject(ex, 'res-val', [okVal(7n)], 'range', 'res-val(r).ok');
    bothReject(ex, 'pt-sum', [[pt(1n), pt(9n)]], 'range', 'pt-sum(ps)[1].x');
    bothReject(ex, 'item-count', [[item(1n, 'Pro', 'a'), item(0n, 'Pro', 'b')], enumVal('Pro')], 'range', 'item-count(xs)[1].id');
  });

  it('enum cases (scalar, record field, list element, second parameter)', async () => {
    const ex = await instantiate(out.bytes);
    bothReject(ex, 'plan-ix', [enumVal('Gold')], 'enum', 'plan-ix(p)');
    bothReject(ex, 'nested', [rec('Outer', { inner: rec('Inner', { n: 1n }), k: enumVal('Gold') })], 'enum', 'nested(o).k');
    bothReject(ex, 'pt-sum', [[pt(1n, true, 'Gold')]], 'enum', 'pt-sum(ps)[0].plan');
    bothReject(ex, 'item-count', [[item(1n, 'Pro', 'a')], enumVal('Gold')], 'enum', 'item-count(k)');
  });

  it('Str :max (scalar and list element) and string handle validity', async () => {
    const ex = await instantiate(out.bytes);
    expect(callCompiled(rep('note-len'), ex, ['😀😀😀😀'])).toBe(4n);
    const m = bothReject(ex, 'note-len', ['abcde'], 'str-max', 'note-len(s)');
    expect(m.message).toBe('note-len(s): string of 5 characters exceeds :max 4');
    bothReject(ex, 'note-len', ['😀😀😀😀😀'], 'str-max', 'note-len(s)'); // code points, not UTF-16 units
    bothReject(ex, 'item-count', [[item(1n, 'Pro', 'a'), item(2n, 'Free', 'toolong')], enumVal('Pro')], 'str-max', 'item-count(xs)[1].label');
    expect(callCompiled(rep('any-str'), ex, ['y'.repeat(10_000)])).toBe(false); // no :max: any length
  });

  it('list lengths: above max, below min, and the empty list where min is 1', async () => {
    const ex = await instantiate(out.bytes);
    bothReject(ex, 'pt-sum', [[pt(1n), pt(1n), pt(1n), pt(1n), pt(1n)]], 'list-length', 'pt-sum(ps)');
    bothReject(ex, 'pt-sum', [[]], 'list-length', 'pt-sum(ps)');
    bothReject(ex, 'item-count', [Array.from({ length: 4 }, (_, i) => item(BigInt(i + 1), 'Pro', 'a')), enumVal('Pro')], 'list-length', 'item-count(xs)');
    // the length is checked before the elements, as in the interpreter
    bothReject(ex, 'pt-sum', [[pt(99n), pt(1n), pt(1n), pt(1n), pt(1n)]], 'list-length', 'pt-sum(ps)');
  });

  it('values of the wrong kind are refused by the adapter with the same reason (they have no encoding)', async () => {
    const ex = await instantiate(out.bytes);
    bothReject(ex, 'flag', [1n], 'type', 'flag(b)', false);
    bothReject(ex, 'add1', ['1'], 'type', 'add1(n)', false);
    bothReject(ex, 'nested', [5n], 'type', 'nested(o)', false);
    bothReject(ex, 'res-val', [3n], 'type', 'res-val(r)', false);
    bothReject(ex, 'pt-sum', ['xs'], 'type', 'pt-sum(ps)', false);
  });
});

describe('validating export wrappers: raw calls that bypass the JS adapter', () => {
  /** Call an export with raw Wasm values and return the ContractViolation it raised. */
  const raw = async (name: string, f: (ex: Exports, mem: WebAssembly.Memory) => unknown[]) => {
    const ex = await instantiate(out.bytes);
    const mem = ex.memory as unknown as WebAssembly.Memory;
    try {
      (ex[name] as (...a: unknown[]) => unknown)(...f(ex, mem));
    } catch (e) {
      return e as ContractViolation;
    }
    throw new Error(`${name} accepted the raw arguments`);
  };

  it('Bool, enum and Result tag encodings, Str handles', async () => {
    expect(await raw('flag', () => [2])).toMatchObject({ reason: 'type', where: 'flag(b)', message: 'flag(b): expected Bool' });
    expect(await raw('flag', () => [-1])).toMatchObject({ reason: 'type', where: 'flag(b)' });
    expect(await raw('plan-ix', () => [3])).toMatchObject({ reason: 'enum', where: 'plan-ix(p)' });
    expect(await raw('plan-ix', () => [-1])).toMatchObject({ reason: 'enum', where: 'plan-ix(p)' });
    expect(await raw('any-str', () => [12345])).toMatchObject({ reason: 'type', where: 'any-str(s)', message: 'any-str(s): expected Str, got invalid string handle 12345' });
    expect(await raw('res-val', () => [2, 0])).toMatchObject({ reason: 'type', where: 'res-val(r)', message: 'res-val(r): expected Result' });
    // the inactive side of a Result must be zero (structural equality compares every leaf)
    expect(await raw('res-val', () => [1, 3])).toMatchObject({ reason: 'encoding', where: 'res-val(r).ok' });
    expect(await raw('wide', () => [2n ** 62n])).toMatchObject({ reason: 'range', where: 'wide(n)' });
  });

  it('list memory: a length that is negative or over max, a pointer into scratch or past the memory, a bad scratch base', async () => {
    const r = rep('pt-sum');
    const base = 16 + r.inputBytes!;
    expect(await raw('pt-sum', () => [16, -1, base])).toMatchObject({ reason: 'list-length', where: 'pt-sum(ps)', message: 'pt-sum(ps): length -1 outside [1, 4]' });
    expect(await raw('pt-sum', () => [16, 1000, base])).toMatchObject({ reason: 'list-length' });
    expect(await raw('pt-sum', () => [base - 8, 2, base])).toMatchObject({ reason: 'memory', where: 'pt-sum(ps)' }); // overlaps scratch
    expect(await raw('pt-sum', () => [-8, 1, base])).toMatchObject({ reason: 'memory', where: 'pt-sum(ps)' }); // 0xfffffff8 unsigned
    expect(await raw('pt-sum', (_, mem) => [16, 1, mem.buffer.byteLength])).toMatchObject({ reason: 'memory', where: 'pt-sum(scratch base)' });
    expect(await raw('pt-sum', () => [16, 1, -1])).toMatchObject({ reason: 'memory', where: 'pt-sum(scratch base)' });
  });

  it('element slots are checked as i64 (a slot that would wrap to an in-range i32 is still refused)', async () => {
    const ex = await instantiate(out.bytes);
    const mem = ex.memory as unknown as WebAssembly.Memory;
    const r = rep('pt-sum');
    const v = new DataView(mem.buffer);
    v.setBigInt64(16, 2n ** 32n + 1n, true); // x: wraps to 1 as an i32
    v.setBigInt64(24, 1n, true);
    v.setBigInt64(32, 0n, true);
    expect(() => (ex['pt-sum'] as (...a: number[]) => unknown)(16, 1, 16 + r.inputBytes!)).toThrow(/pt-sum\(ps\)\[0\]\.x: 4294967297 outside \[-5, 5\]/);
    v.setBigInt64(16, 0n, true);
    v.setBigInt64(24, 2n, true); // on: not 0/1
    expect(() => (ex['pt-sum'] as (...a: number[]) => unknown)(16, 1, 16 + r.inputBytes!)).toThrow(/pt-sum\(ps\)\[0\]\.on: expected Bool/);
  });

  it('traps even when the host import returns instead of throwing', async () => {
    const mod = await WebAssembly.compile(new Uint8Array(out.bytes));
    const wh = new WasmHost(readAbi(mod), new Host(1));
    const imports = wh.imports(mod) as { host: Record<string, WebAssembly.ImportValue> };
    imports.host.contract_violation = () => {};
    const inst = await WebAssembly.instantiate(mod, imports);
    expect(() => (inst.exports.add1 as (n: number) => number)(6)).toThrow(WebAssembly.RuntimeError);
    expect((inst.exports.add1 as (n: number) => number)(5)).toBe(6);
  });

  it('lowerArgs without forward still refuses an over-long list itself (as before)', async () => {
    const ex = await instantiate(out.bytes);
    const mem = ex.memory as unknown as WebAssembly.Memory;
    expect(() => lowerArgs(rep('pt-sum'), [[pt(1n), pt(1n), pt(1n), pt(1n), pt(1n)]], mem)).toThrow(ContractViolation);
    expect(() => lowerArgs(rep('pt-sum'), [[pt(1n), pt(1n), pt(1n), pt(1n), pt(1n)]], mem, undefined, { forward: true })).not.toThrow();
  });
});

describe('validating export wrappers: host results the compiled code relies on', () => {
  async function withImport(name: string, impl: (...a: never[]) => unknown, host = new Host(1)) {
    const mod = await WebAssembly.compile(new Uint8Array(out.bytes));
    const wh = new WasmHost(readAbi(mod), host);
    const imports = wh.imports(mod) as { host: Record<string, WebAssembly.ImportValue> };
    imports.host[name] = impl;
    const inst = await WebAssembly.instantiate(mod, imports);
    wh.memory = inst.exports.memory as WebAssembly.Memory;
    return { ex: inst.exports as unknown as Record<string, (...a: unknown[]) => unknown>, wh };
  }

  it('fresh: a value outside 0..9007199254740991 is a host fault (RuntimeFault), not passed on', async () => {
    rep('fresh-small');
    const fresh = out.abi.effects.find((e) => e.op === 'fresh')!.import;
    for (const bad of [-1n, 9007199254740992n, -(2n ** 63n)]) {
      const { ex } = await withImport(fresh, (() => bad) as never);
      expect(() => ex['fresh-small'](0n)).toThrow(RuntimeFault);
      expect(() => ex['fresh-small'](0n)).toThrow(/rand\.fresh: host returned .* outside \[0, 9007199254740991\]/);
    }
    const { ex } = await withImport(fresh, (() => 9007199254740991n) as never);
    expect(ex['fresh-small'](0n)).toBe(9007199254740991n);
  });

  it('str_chars: a count above the Str :max is refused before it becomes a list length', async () => {
    const { ex, wh } = await withImport('str_chars', (() => 5) as never);
    const r = rep('note-len');
    const h = wh.strings.intern('ab');
    expect(() => ex['note-len'](h, 16 + (r.inputBytes ?? 0))).toThrow(/str_chars: host returned 5, outside \[0, 4\]/);
  });

  it('str_eq: any nonzero answer is true (normalised), so a Bool stays 0/1', async () => {
    const { ex, wh } = await withImport('str_eq', (() => 7) as never);
    expect(ex['any-str'](wh.strings.intern('x'))).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The 11 reference apps: malformed input at every place of every entry parameter

const root = new URL('../experiments/tasks/', import.meta.url).pathname;
const TASKS = ['A1-tiered-pricing', 'A2-ledger-postings', 'A3-rate-limiter', 'A4-authorised-transfer', 'B1-document-service', 'B2-notification-sender', 'B3-audited-refund', 'B4-record-import', 'C2-sales-report', 'C3-catalogue-search', 'C4-schedule-conflicts'];

function load(task: string) {
  const p = parseProgram(readFileSync(join(root, task, 'ref/sigil/app.sigil'), 'utf8'));
  const polFile = join(root, task, 'visible/policy.sigil');
  const res = check(p, parsePolicy(existsSync(polFile) ? readFileSync(polFile, 'utf8') : '(policy)'));
  return { prog: p, out: compileProgram(p, res) };
}

describe('validating export wrappers: reference apps reject malformed input like the interpreter', () => {
  for (const task of TASKS) {
    it(`${task}: every one-violation input to the entry is rejected by both, same reason and place`, async () => {
      const { prog: p, out: o } = load(task);
      expect(o.abi.validated).toBe(true);
      const entry = p.entries[0];
      const r = o.fns.find((f) => f.name === entry)!;
      expect(r.compilable, r.reason).toBe(true);
      const ex = await instantiate(o.bytes);
      const fd = p.fns.get(entry)!;
      const rnd = mulberry32(31337);
      let cases = 0;
      let byModule = 0;
      const mismatches: string[] = [];
      for (let round = 0; round < 3; round++) {
        const valid = fd.params.map((q) => genVal(p, q.type, rnd));
        fd.params.forEach((q, i) => {
          for (const b of badVariants(p, q.type, valid[i], rnd)) {
            const args = [...valid];
            args[i] = b.val;
            const s = bothSides(p, r, ex, args);
            cases++;
            if (s.byModule) byModule++;
            const ok = isRejection(s.interp) && isRejection(s.wasm) && s.interp.contract && s.wasm.contract && s.interp.reason === s.wasm.reason && s.interp.where === s.wasm.where;
            if (!ok) mismatches.push(`${q.name} ${b.label}: interp ${JSON.stringify(s.interp, (_, x) => (typeof x === 'bigint' ? String(x) : x)).slice(0, 200)}, wasm ${JSON.stringify(s.wasm, (_, x) => (typeof x === 'bigint' ? String(x) : x)).slice(0, 200)}`);
          }
        });
      }
      expect(mismatches.slice(0, 5)).toEqual([]);
      expect(cases).toBeGreaterThan(20);
      // many of them are encodable, so it is the module's own wrapper that refuses them (not the JS adapter, which
      // only refuses values with no encoding: the wrong kind, or an Int wider than the representation)
      expect(byModule / cases).toBeGreaterThan(0.25);
      // and valid inputs still run (the wrapper is transparent)
      const valid = fd.params.map((q) => genVal(p, q.type, rnd));
      const ok = bothSides(p, r, ex, valid);
      expect(isRejection(ok.wasm) && (ok.wasm.contract ? ok.wasm.message : ''), task).toBeFalsy();
    });
  }
});
