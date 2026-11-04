import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Program, Type, resolveType } from '../src/ast.js';
import { check } from '../src/check.js';
import { Host, Interp, Val, enumVal, eqVal, mulberry32, showVal } from '../src/interp.js';
import { parsePolicy, parseProgram } from '../src/parse.js';
import { callCompiled, instantiate, lowerArgs, readList, writeList } from '../src/wasm/abi.js';
import { CompileResult, MAX_MEMORY_BYTES, compileProgram } from '../src/wasm/compile.js';

const APP = readFileSync(new URL('../examples/invoicing/app.sigil', import.meta.url), 'utf8');
const POLICY = readFileSync(new URL('../examples/invoicing/policy.sigil', import.meta.url), 'utf8');

const FIXTURE = `
(type Cents (Int 0 1000000000000000))
(type Plan  (var Free Pro Enterprise))
(type Sku   (Str :validated))
(type Line  (rec (sku Sku) (unit (Int 0 1000000000)) (qty (Int 1 1000))))
(type Pt    (rec (x (Int -1000 1000)) (y (Int -1000 1000)) (on Bool) (plan Plan)))

(fn count-big
  (in (ls (List Line 0 200)))
  (out (Int 0 200))
  (len (filter ls (fn (l) (> l.unit 500000000)))))

(fn n-lines
  (in (ls (List Line 1 200)))
  (out (Int 1 200))
  (len ls))

(fn big-total
  (in (ls (List Line 0 200)) (floor (Int 0 1000000000)))
  (out Cents)
  (sum (map (filter ls (fn (l) (>= l.unit floor))) (fn (l) (mul l.unit l.qty)))))

(fn gross0
  (in (ls (List Line 0 200)))
  (out Cents)
  (sum (map ls (fn (l) (mul l.unit l.qty)))))

(fn gross-of-big
  (in (ls (List Line 0 200)))
  (out Cents)
  (gross0 (filter ls (fn (l) (>= l.qty 500)))))

(fn pt-score
  (in (ps (List Pt 0 40)))
  (out (Int -80000 80000))
  (sum (map (filter ps (fn (p) (and p.on (not (= p.plan Free)))))
            (fn (p) (sub p.x (div-floor p.y 3))))))

(fn bools
  (in (xs (List Bool 0 50)))
  (out (Int 0 50))
  (len (filter xs (fn (b) b))))

(fn plans
  (in (ps (List Plan 0 30)))
  (out (Int 0 30))
  (len (filter ps (fn (p) (= p Pro)))))

(fn ints
  (in (xs (List (Int -1000000 1000000) 0 60)) (k (Int -50 50)))
  (out (Int -100000000 100000000))
  (let [m (map xs (fn (v) (add v k)))
        pos (filter m (fn (v) (> v 0)))]
    (add (sum pos) (len m))))

(fn lit
  (in (a (Int 0 100)) (b (Int 0 100)))
  (out (Int 0 602))
  (add (sum (list a b (add a b))) (len (list a b))))

(fn nested-lam
  (in (ls (List Line 0 30)) (cap (Int 0 1000)))
  (out (Int 0 40000))
  (sum (map ls (fn (l) (min l.qty cap)))))

(fn str-list (in (xs (List Sku 1 5))) (out (Int 1 5)) (len xs))
(fn res-fn (in (a (Int 0 5))) (out (Result (Int 0 5) (var Bad))) (ok a))
(fn cap-fn (in (a (Int 0 5))) (out (Int 0 5)) (needs audit) a)
(fn huge (in (ls (List Line 0 100000000))) (out (Int 0 100000000)) (len ls))
(fn huge-scratch
  (in (xs (List (Int 0 9) 0 1000000)))
  (out (Int 0 1000000))
  (len (filter (map xs (fn (v) v)) (fn (v) (> v 1)))))
(fn list-result (in (ls (List Line 0 5))) (out (List Line 0 5)) ls)
(fn nested-list (in (xs (List (List (Int 0 9) 0 3) 0 3))) (out (Int 0 3)) (len xs))
(fn str-field-read (in (ls (List Line 1 5))) (out (Int 0 5)) (len (filter ls (fn (l) (= l.sku l.sku)))))
`;

function build(src: string, policy = '(policy)') {
  const prog = parseProgram(src);
  const res = check(prog, parsePolicy(policy));
  return { prog, res, out: compileProgram(prog, res) };
}

// ---------------------------------------------------------------------------
// Boundary-biased seeded generation, including lists of every length from min to max
// ---------------------------------------------------------------------------

function genInt(rnd: () => number, lo: bigint, hi: bigint): bigint {
  const inR = (v: bigint) => v >= lo && v <= hi;
  const r = rnd();
  if (r < 0.4) {
    const c = [lo, hi, lo + 1n, hi - 1n, 0n, 1n, -1n, 500000000n, 499999999n, 500000001n, 499n, 500n, (lo + hi) / 2n].filter(inR);
    return c[Math.floor(rnd() * c.length)];
  }
  const span = hi - lo + 1n;
  let big = 0n;
  for (let i = 0; i < 4; i++) big = (big << 32n) | BigInt(Math.floor(rnd() * 4294967296));
  return lo + (big % span);
}

function genVal(prog: Program, t: Type, rnd: () => number): Val {
  const r = resolveType(prog, t);
  switch (r.k) {
    case 'int':
      return genInt(rnd, r.lo, r.hi);
    case 'bool':
      return rnd() < 0.5;
    case 'str':
      return `W-${Math.floor(rnd() * 1000)}`;
    case 'enum':
      return enumVal(r.cases[Math.floor(rnd() * r.cases.length)]);
    case 'rec':
      return { $: 'rec', type: t.k === 'named' ? t.name : '', fields: Object.fromEntries(r.fields.map((f) => [f.name, genVal(prog, f.type, rnd)])) };
    case 'list': {
      const pick = rnd();
      const len = pick < 0.15 ? r.min : pick < 0.3 ? r.max : pick < 0.4 ? Math.min(r.max, r.min + 1) : pick < 0.5 ? Math.max(r.min, r.max - 1) : r.min + Math.floor(rnd() * (r.max - r.min + 1));
      // A quarter of the lists are all-boundary (every element at an extreme), to hit the largest sums.
      const extreme = rnd() < 0.25;
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

async function differential(prog: Program, out: CompileResult, name: string, n = 300, seed = 4242): Promise<{ mismatches: string[]; lens: Set<number> }> {
  const report = out.fns.find((f) => f.name === name)!;
  expect(report.compilable, `${name}: ${report.reason}`).toBe(true);
  const exports = await instantiate(out.bytes);
  const fd = prog.fns.get(name)!;
  const rnd = mulberry32(seed);
  const mismatches: string[] = [];
  const lens = new Set<number>();
  for (let i = 0; i < n; i++) {
    const args = fd.params.map((p) => genVal(prog, p.type, rnd));
    for (const a of args) if (Array.isArray(a)) lens.add(a.length);
    const want = new Interp(prog, new Host(1)).callFn(name, args);
    const got = callCompiled(report, exports, args);
    if (!eqVal(want, got)) mismatches.push(`${name}(${args.map(showVal).join(', ').slice(0, 200)}): interpreter ${showVal(want)}, wasm ${showVal(got)}`);
  }
  return { mismatches, lens };
}

const line = (unit: bigint, qty: bigint, sku = 'W-1'): Val => ({ $: 'rec', type: 'Line', fields: { sku, unit, qty } });

// ---------------------------------------------------------------------------

describe('wasm lists: invoicing example', () => {
  const { prog, out } = build(APP, POLICY);
  const rep = (n: string) => out.fns.find((f) => f.name === n)!;

  it('gross and price-invoice compile (i64) and the module validates', () => {
    expect(rep('gross').compilable, rep('gross').reason).toBe(true);
    expect(rep('price-invoice').compilable, rep('price-invoice').reason).toBe(true);
    expect(rep('gross').repr).toBe('i64');
    expect(rep('price-invoice').repr).toBe('i64');
    expect(WebAssembly.validate(new Uint8Array(out.bytes))).toBe(true);
  });

  it('memory layout: 200 Lines of (unit, qty) = 3200 bytes of input; scratch is the map output', () => {
    // Line.sku (a string) is not stored; stride = 2 slots.
    expect(rep('gross').inputBytes).toBe(200 * 2 * 8);
    expect(rep('gross').scratchBytes).toBe(200 * 1 * 8);
    // price-invoice calls gross with its own list: the callee's scratch sits above the caller's.
    expect(rep('price-invoice').scratchBytes).toBe(200 * 8);
    expect(out.memPages).toBe(1);
  });

  it('still refuses strings and capabilities', () => {
    expect(rep('receipt').compilable).toBe(false);
    expect(rep('receipt').reason).toMatch(/str/);
    expect(rep('issue-invoice').compilable).toBe(false);
    expect(rep('issue-invoice').reason).toMatch(/capabilit/);
  });

  it('known values at the extremes: 200 lines of unit 1e9, qty 1000', async () => {
    const ex = await instantiate(out.bytes);
    const full = Array.from({ length: 200 }, () => line(1_000_000_000n, 1000n));
    expect(callCompiled(rep('gross'), ex, [full])).toBe(200n * 1_000_000_000n * 1000n);
    const pro = enumVal('Pro');
    const want = (200n * 1_000_000_000n * 1000n * 90n) / 100n;
    expect(callCompiled(rep('price-invoice'), ex, [pro, full])).toBe(want);
    expect(new Interp(prog, new Host(1)).callFn('price-invoice', [pro, full])).toBe(want);
    // minimum length, smallest values
    expect(callCompiled(rep('gross'), ex, [[line(0n, 1n)]])).toBe(0n);
    expect(callCompiled(rep('price-invoice'), ex, [enumVal('Free'), [line(1n, 1n)]])).toBe(1n);
    expect(callCompiled(rep('price-invoice'), ex, [enumVal('Enterprise'), [line(1n, 1n)]])).toBe(0n); // floor(80/100)
  });

  for (const name of ['gross', 'price-invoice']) {
    it(`differential: ${name} (lengths 1..200, boundary-biased values)`, async () => {
      const d = await differential(prog, out, name, 300);
      expect(d.mismatches).toEqual([]);
      expect(d.lens.has(1)).toBe(true);
      expect(d.lens.has(200)).toBe(true);
      expect(d.lens.has(199)).toBe(true);
      expect(d.lens.size).toBeGreaterThan(40);
    });
  }

  it('exports memory alongside the functions', async () => {
    const ex = await instantiate(out.bytes);
    expect(Object.keys(ex).sort()).toEqual(['discount', 'gross', 'memory', 'price-invoice']);
  });
});

describe('wasm lists: fixture', () => {
  const { prog, out } = build(FIXTURE);
  const rep = (n: string) => out.fns.find((f) => f.name === n)!;
  const COMPILABLE = ['count-big', 'n-lines', 'big-total', 'gross0', 'gross-of-big', 'pt-score', 'bools', 'plans', 'ints', 'lit', 'nested-lam'];

  it('compiles the list functions and the module validates', () => {
    for (const n of COMPILABLE) expect(rep(n).compilable, `${n}: ${rep(n).reason}`).toBe(true);
    expect(WebAssembly.validate(new Uint8Array(out.bytes))).toBe(true);
  });

  it('uses i32 where the checker proves it is enough, and passes lists between functions', () => {
    expect(rep('n-lines').repr).toBe('i32');
    expect(rep('count-big').repr).toBe('i32');
    expect(rep('plans').repr).toBe('i32');
    expect(rep('gross-of-big').repr).toBe('i64');
    // gross-of-big: filter output (200 * 2 slots) + the callee's map scratch above it
    expect(rep('gross-of-big').scratchBytes).toBe(200 * 2 * 8 + 200 * 8);
  });

  for (const name of COMPILABLE) {
    it(`differential: ${name}`, async () => {
      const d = await differential(prog, out, name);
      expect(d.mismatches).toEqual([]);
    });
  }

  it('filter and len cover empty, singleton and full lists exactly', async () => {
    const ex = await instantiate(out.bytes);
    const cb = rep('count-big');
    const big = line(500_000_001n, 1n);
    const edge = line(500_000_000n, 1n);
    expect(callCompiled(cb, ex, [[]])).toBe(0n);
    expect(callCompiled(cb, ex, [[edge]])).toBe(0n);
    expect(callCompiled(cb, ex, [[big]])).toBe(1n);
    expect(callCompiled(cb, ex, [Array.from({ length: 200 }, () => big)])).toBe(200n);
    expect(callCompiled(rep('n-lines'), ex, [Array.from({ length: 200 }, () => edge)])).toBe(200n);
  });

  it('a list of 200 can be passed repeatedly: scratch is reused, nothing leaks between calls', async () => {
    const ex = await instantiate(out.bytes);
    const g = rep('gross0');
    const a = Array.from({ length: 200 }, () => line(1_000_000_000n, 1000n));
    const b = [line(3n, 4n)];
    expect(callCompiled(g, ex, [a])).toBe(200n * 1_000_000_000_000n);
    expect(callCompiled(g, ex, [b])).toBe(12n);
    expect(callCompiled(g, ex, [a])).toBe(200n * 1_000_000_000_000n);
  });

  it('marshalling round-trips and enforces the declared bounds', async () => {
    const ex = await instantiate(out.bytes);
    const r = rep('pt-score');
    const pt = (x: bigint, y: bigint, on: boolean, plan: string): Val => ({ $: 'rec', type: 'Pt', fields: { x, y, on, plan: enumVal(plan) } });
    const xs = [pt(-5n, 7n, true, 'Pro'), pt(1000n, -1000n, false, 'Free')];
    const mem = ex.memory as unknown as WebAssembly.Memory;
    const layout = (r.params![0].leaves[0].kind as any).layout;
    writeList(new DataView(mem.buffer), 64, layout, xs);
    const back = readList(new DataView(mem.buffer), 64, 2, layout);
    expect(back.map((v) => showVal(v).replace(/Pt/g, ""))).toEqual(xs.map((v) => showVal(v).replace(/Pt/g, "")));
    expect(() => lowerArgs(r, [Array.from({ length: 41 }, () => xs[0])], mem)).toThrow(/outside declared/);
    expect(() => lowerArgs(rep('n-lines'), [[]], mem)).toThrow(/outside declared/); // min is 1
    expect(() => lowerArgs(r, [xs])).toThrow(/memory/);
  });

  it('refuses the still-unsupported things, with reasons', () => {
    expect(rep('str-list').compilable).toBe(false);
    expect(rep('str-list').reason).toMatch(/str/);
    expect(rep('res-fn').compilable).toBe(false);
    expect(rep('res-fn').reason).toMatch(/Result|result|ok/);
    expect(rep('cap-fn').compilable).toBe(false);
    expect(rep('cap-fn').reason).toMatch(/capabilit/);
    expect(rep('list-result').compilable).toBe(false);
    expect(rep('list-result').reason).toMatch(/result has type list/);
    expect(rep('nested-list').compilable).toBe(false);
    expect(rep('nested-list').reason).toMatch(/nested list/);
  });

  it('refuses reading an unstored string field', () => {
    expect(rep('str-field-read').compilable).toBe(false);
    expect(rep('str-field-read').reason).toMatch(/l\.sku|not a scalar/);
  });

  it('refuses lists whose declared maximum would need unreasonable memory', () => {
    expect(rep('huge').compilable).toBe(false);
    expect(rep('huge').reason).toMatch(/byte limit/);
    expect(rep('huge-scratch').compilable).toBe(false);
    expect(rep('huge-scratch').reason).toMatch(/byte limit/);
    expect(MAX_MEMORY_BYTES).toBe(16 * 1024 * 1024);
  });

  it('every compiled list function stays within its declared memory size', () => {
    for (const n of COMPILABLE) {
      const r = rep(n);
      if (!r.hasBase) continue;
      expect(16 + r.inputBytes! + r.scratchBytes!).toBeLessThanOrEqual(out.memPages! * 65536);
    }
  });
});
