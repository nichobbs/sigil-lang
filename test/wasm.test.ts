import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Program, Type, resolveType } from '../src/ast.js';
import { CheckResult, check, errors } from '../src/check.js';
import { Host, Interp, Val, enumVal, eqVal, mulberry32, showVal } from '../src/interp.js';
import { parsePolicy, parseProgram } from '../src/parse.js';
import { callCompiled, instantiate } from '../src/wasm/abi.js';
import { CompileOptions, CompileResult, compileProgram } from '../src/wasm/compile.js';
import { sleb, uleb } from '../src/wasm/encode.js';

const read = (p: string) => readFileSync(new URL(`../examples/invoicing/${p}`, import.meta.url), 'utf8');
const APP = read('app.sigil');
const POLICY = read('policy.sigil');

// A pure numeric fixture: a price-style computation (mul, div-floor, match), floor division with
// negative numerators and negative divisors, and a mix of let/if/min/max/neg/comparisons/bools/enums.
const FIXTURE = `
(type Cents (Int 0 1000000000000000))
(type Pct   (Int 0 100))
(type Plan  (var Free Pro Enterprise))
(type Tier  (var Low High))
(type Item  (rec (unit (Int 0 1000000000)) (qty (Int 1 1000))))

(fn line-price
  (in (p Plan) (it Item))
  (out Cents)
  (div-floor (mul (mul it.unit it.qty) (sub 100 (match p (Free 0) (Pro 10) (Enterprise 20)))) 100))

(fn floor-pos
  (in (a (Int -1000 1000)) (b (Int 1 7)))
  (out (Int -1000 1000))
  (div-floor a b))

(fn floor-neg
  (in (a (Int -100000 100000)) (b (Int -9 -1)))
  (out (Int -100000 100000))
  (div-floor a b))

(fn mixed
  (in (x (Int -50000 50000)) (y (Int -50000 50000)) (flag Bool))
  (out (Int -200000 200000))
  (let [d (sub x y)
        m (max d (neg y))]
    (if (and flag (< x y))
        (min m 7)
        (sub m (div-floor d 3)))))

(fn pred
  (in (x (Int -10 10)) (y (Int -10 10)) (p Plan))
  (out Bool)
  (or (and (>= x y) (not (= x 0))) (= y 3) (= p Pro)))

(fn tier-of
  (in (x (Int -100 100)))
  (out Tier)
  (if (< x 0) Low High))

(fn wide
  (in (a (Int 0 3000000000)))
  (out (Int 0 3000000000))
  a)

(fn sum-line
  (in (ls (List Item 1 10)))
  (out (Int 0 100000000000000))
  (sum (map ls (fn (l) (mul l.unit l.qty)))))

(fn calls-other
  (in (p Plan))
  (out Pct)
  (line-price-pct p))

(fn line-price-pct
  (in (p Plan))
  (out Pct)
  (match p (Free 0) (Pro 10) (Enterprise 20)))

(fn unsafe-div
  (in (a (Int 0 100)) (b (Int 0 5)))
  (out (Int 0 100))
  (div-floor a b))
`;

function build(src: string, opts: CompileOptions = {}) {
  const prog = parseProgram(src);
  const res = check(prog, parsePolicy('(policy)'));
  return { prog, res, out: compileProgram(prog, res, opts) };
}

// ---------------------------------------------------------------------------
// Boundary-biased seeded input generation
// ---------------------------------------------------------------------------

function genInt(rnd: () => number, lo: bigint, hi: bigint): bigint {
  const inR = (v: bigint) => v >= lo && v <= hi;
  const r = rnd();
  if (r < 0.35) {
    const c = [lo, hi, lo + 1n, hi - 1n, 0n, 1n, -1n, -2n, 2n, 7n, -7n, (lo + hi) / 2n].filter(inR);
    return c[Math.floor(rnd() * c.length)];
  }
  if (r < 0.55) {
    const off = BigInt(Math.floor(rnd() * 16));
    return rnd() < 0.5 ? lo + off > hi ? hi : lo + off : hi - off < lo ? lo : hi - off;
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
    case 'enum':
      return enumVal(r.cases[Math.floor(rnd() * r.cases.length)]);
    case 'rec':
      return { $: 'rec', type: t.k === 'named' ? t.name : '', fields: Object.fromEntries(r.fields.map((f) => [f.name, genVal(prog, f.type, rnd)])) };
    default:
      throw new Error(`cannot generate ${r.k}`);
  }
}

interface DiffResult {
  runs: number;
  mismatches: string[];
  inputs: Val[][];
}

/** Run the reference interpreter and the compiled Wasm on the same inputs and compare. */
async function differential(prog: Program, out: CompileResult, name: string, n = 400, seed = 12345): Promise<DiffResult> {
  const report = out.fns.find((f) => f.name === name)!;
  expect(report.compilable, `${name}: ${report.reason}`).toBe(true);
  const exports = await instantiate(out.bytes);
  const fd = prog.fns.get(name)!;
  const rnd = mulberry32(seed);
  const res: DiffResult = { runs: 0, mismatches: [], inputs: [] };
  for (let i = 0; i < n; i++) {
    const args = fd.params.map((p) => genVal(prog, p.type, rnd));
    const want = new Interp(prog, new Host(1)).callFn(name, args);
    const got = callCompiled(report, exports, args);
    res.runs++;
    res.inputs.push(args);
    if (!eqVal(want, got)) res.mismatches.push(`${name}(${args.map(showVal).join(', ')}): interpreter ${showVal(want)}, wasm ${showVal(got)}`);
  }
  return res;
}

// ---------------------------------------------------------------------------

describe('wasm encoder primitives', () => {
  it('encodes LEB128 per the spec examples', () => {
    expect(uleb(624485)).toEqual([0xe5, 0x8e, 0x26]);
    expect(sleb(-123456)).toEqual([0xc0, 0xbb, 0x78]);
    expect(sleb(-1)).toEqual([0x7f]);
    expect(sleb(63)).toEqual([0x3f]);
    expect(sleb(64)).toEqual([0xc0, 0x00]);
    expect(sleb(-64)).toEqual([0x40]);
    expect(sleb(-65)).toEqual([0xbf, 0x7f]);
    expect(sleb(-(2n ** 63n))).toHaveLength(10);
  });
});

describe('wasm backend: invoicing example', () => {
  const prog = parseProgram(APP);
  const res = check(prog, parsePolicy(POLICY));
  const out = compileProgram(prog, res);
  const rep = (n: string) => out.fns.find((f) => f.name === n)!;

  it('the example checks clean', () => {
    expect(errors(res)).toEqual([]);
  });

  it('discount is compilable and the module validates', () => {
    expect(rep('discount').compilable).toBe(true);
    expect(rep('discount').repr).toBe('i32');
    expect(WebAssembly.validate(new Uint8Array(out.bytes))).toBe(true);
  });

  it('gross and price-invoice are not compilable (lists), with a reason', () => {
    for (const n of ['gross', 'price-invoice']) {
      expect(rep(n).compilable).toBe(false);
      expect(rep(n).reason).toMatch(/list/);
    }
  });

  it('receipt (strings) and issue-invoice (capabilities) are not compilable', () => {
    expect(rep('receipt').compilable).toBe(false);
    expect(rep('receipt').reason).toMatch(/str/);
    expect(rep('issue-invoice').compilable).toBe(false);
    expect(rep('issue-invoice').reason).toMatch(/capabilit/);
  });

  it('discount agrees with the interpreter on every Plan', async () => {
    const d = await differential(prog, out, 'discount', 30);
    expect(d.mismatches).toEqual([]);
  });

  it('only discount is exported', async () => {
    const ex = await instantiate(out.bytes);
    expect(Object.keys(ex)).toEqual(['discount']);
  });
});

describe('wasm backend: numeric fixture', () => {
  const { prog, res, out } = build(FIXTURE);
  const rep = (n: string) => out.fns.find((f) => f.name === n)!;
  const COMPILABLE = ['line-price', 'floor-pos', 'floor-neg', 'mixed', 'pred', 'tier-of', 'wide'];

  it('the fixture checks without errors in the compilable functions', () => {
    const bad = errors(res).filter((d) => COMPILABLE.includes(d.fn));
    expect(bad).toEqual([]);
  });

  it('compiles the pure numeric functions and the module validates', () => {
    for (const n of COMPILABLE) expect(rep(n).compilable, `${n}: ${rep(n).reason}`).toBe(true);
    expect(WebAssembly.validate(new Uint8Array(out.bytes))).toBe(true);
  });

  it('uses the checker-derived representation', () => {
    expect(rep('line-price').repr).toBe('i64'); // 1e12 * 100 does not fit i32
    expect(rep('floor-pos').repr).toBe('i32');
    expect(rep('mixed').repr).toBe('i32');
  });

  it('the checker now counts parameter ranges, so no widening is needed (backend still guards against it)', () => {
    expect(rep('wide').checkerRepr).toBe('i64');
    expect(rep('wide').repr).toBe('i64');
    expect(rep('wide').widenedFromChecker).toBeFalsy();
  });

  it('refuses what is outside the subset, with reasons', () => {
    expect(rep('sum-line').compilable).toBe(false);
    expect(rep('sum-line').reason).toMatch(/list/);
    expect(rep('calls-other').compilable).toBe(false);
    expect(rep('calls-other').reason).toMatch(/user function/);
    expect(rep('unsafe-div').compilable).toBe(false);
    expect(rep('unsafe-div').reason).toMatch(/not proved/);
  });

  it('known floor-division values (negative numerators and divisors)', async () => {
    const ex = await instantiate(out.bytes);
    const f = ex['floor-pos'] as (a: number, b: number) => number;
    expect([f(-7, 2), f(7, 2), f(-1, 7), f(-14, 7), f(0, 3), f(-1000, 7)]).toEqual([-4, 3, -1, -2, 0, -143]);
    const g = ex['floor-neg'] as (a: number, b: number) => number;
    expect([g(7, -2), g(-7, -2), g(6, -3), g(-100000, -9)]).toEqual([-4, 3, -2, 11111]);
  });

  it('price-style line-price agrees with a hand computation', async () => {
    const ex = await instantiate(out.bytes);
    const f = ex['line-price'] as (p: number, unit: bigint, qty: bigint) => bigint;
    // Plan order: Free, Pro, Enterprise.  999 * 3 = 2997; Pro pays 90%: 269730/100 -> 2697 (floor)
    expect(f(1, 999n, 3n)).toBe(2697n);
    expect(f(2, 1_000_000_000n, 1000n)).toBe(800_000_000_000n);
    expect(f(0, 1n, 1n)).toBe(1n);
  });

  for (const name of COMPILABLE) {
    it(`differential: ${name} (400 seeded boundary-biased inputs, interpreter vs wasm)`, async () => {
      const d = await differential(prog, out, name);
      expect(d.mismatches).toEqual([]);
      expect(d.runs).toBe(400);
    });
  }

  it('the differential inputs actually cover negative numerators and sign-differing remainders', async () => {
    for (const name of ['floor-pos', 'floor-neg']) {
      const d = await differential(prog, out, name);
      let negNum = 0;
      let inexactNeg = 0; // trunc and floor disagree here
      for (const [a, b] of d.inputs as bigint[][]) {
        if (a < 0n) negNum++;
        if (a % b !== 0n && a < 0n !== b < 0n) inexactNeg++;
      }
      expect(negNum, name).toBeGreaterThan(50);
      expect(inexactNeg, name).toBeGreaterThan(30);
    }
  });
});

describe('wasm backend: the differential test catches a broken compiler', () => {
  it('truncating division instead of floor is detected on negative numerators', async () => {
    const { prog, out } = build(FIXTURE, { divMode: 'trunc' });
    for (const name of ['floor-pos', 'floor-neg', 'mixed']) {
      const d = await differential(prog, out, name);
      expect(d.mismatches.length, `${name} should expose trunc-vs-floor`).toBeGreaterThan(0);
    }
    // positive-only arithmetic is unaffected by the mutation, so it must still agree
    const lp = await differential(prog, out, 'line-price');
    expect(lp.mismatches).toEqual([]);
  });
});
