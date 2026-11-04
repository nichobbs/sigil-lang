// Stage 2: strings as opaque host handles (params, fields, lets, literals, equality, text/money/chars/from-chars),
// differential against the interpreter.

import { describe, expect, it } from 'vitest';
import { Val, enumVal, errVal, okVal } from '../src/interp.js';
import { callCompiled, instantiate } from '../src/wasm/abi.js';
import { readAbi } from '../src/wasm/host.js';
import { build, differential } from './helpers/wasm-diff.js';

const FIXTURE = `
(type Cents (Int 0 1000000000000))
(type Kind  (var Receipt Reminder Alert))
(type Err   (var Empty TooLong))
(type Email (Str :validated))
(type Note  (Str :max 20))
(type Cust  (rec (id (Int 0 1000)) (name Str :pii) (email Email :pii) (kind Kind)))
(type Line  (rec (sku Str) (unit (Int 0 1000000000)) (qty (Int 1 1000))))
(type Tagged (rec (label Str) (n (Int 0 10)) (tags (List Str 0 10))))
(validator parse-email (in (s Str)) (out Email) (regex "^[a-z.]+@[a-z.]+$") (sample "a@x.com"))

(fn name-of (in (c Cust)) (out Str) c.name)
(fn same-name (in (a Cust) (b Cust)) (out Bool) (= a.name b.name))
(fn is-ada (in (c Cust)) (out Bool) (= c.name "Ada"))
(fn kind-line (in (k Kind)) (out Str)
  (match k (Receipt "your receipt is ready") (Reminder "this is a reminder") (Alert "this is an alert")))
(fn greet (in (c Cust)) (out Str) (text "Hello " c.name ", " (kind-line c.kind)))
(fn show-all (in (n (Int -1000 1000)) (b Bool) (k Kind)) (out Str) (text "n=" n " b=" b " k=" k))
(fn show-wide (in (n (Int -9007199254740991 9007199254740991))) (out Str) (text n))
(fn text-none (in (a Bool)) (out Str) (if a (text) (text "x")))
(fn price-str (in (c Cents)) (out Str) (money c))
(fn signed-money (in (c (Int -100000 100000))) (out Str) (money c))
(fn mk-cust (in (id (Int 0 1000)) (nm Str) (em Email)) (out Cust) (Cust id nm em Receipt))
(fn rename (in (c Cust) (nm Str)) (out Cust) (Cust c.id nm c.email c.kind))
(fn lookup (in (c Cust)) (out (Result Str Err)) (if (= c.name "") (err Empty) (ok c.name)))
(fn lookup-eq (in (a Cust) (b Cust)) (out Bool) (= (lookup a) (lookup b)))
(fn try-name (in (c Cust)) (out (Result Str Err)) (let [n (try (lookup c) :on-err TooLong)] (ok (text n "!"))))
(fn skus-of (in (ls (List Line 0 10))) (out (List Str 0 10)) (map ls (fn (l) l.sku)))
(fn count-sku (in (ls (List Line 0 10)) (s Str)) (out (Int 0 10)) (len (filter ls (fn (l) (= l.sku s)))))
(fn pick-lines (in (ls (List Line 0 10))) (out (List Line 0 10)) (filter ls (fn (l) (> l.qty 500))))
(fn gross (in (ls (List Line 0 10))) (out (Int 0 10000000000000)) (sum (map ls (fn (l) (mul l.unit l.qty)))))
(fn tagged (in (ls (List Line 0 10))) (out Tagged)
  (Tagged (text "lines:" (len ls)) (len ls) (map ls (fn (l) l.sku))))
(fn rev-chars (in (n Note)) (out Str) (from-chars (map (chars n) (fn (c) c))))
(fn n-chars (in (n Note)) (out (Int 0 20)) (len (chars n)))
(fn shout (in (n Note)) (out Str)
  (from-chars (map (chars n) (fn (c) (if (and (>= c 97) (<= c 122)) (max 0 (sub c 32)) c)))))
(fn shout-unproved (in (n Note)) (out Str)
  (from-chars (map (chars n) (fn (c) (if (and (>= c 97) (<= c 122)) (sub c 32) c)))))
(fn code-sum (in (n Note)) (out (Int 0 22302060)) (sum (chars n)))
(fn lit-eq (in (a Str)) (out Bool) (or (= a "") (= a "x")))
(fn str-let (in (a Str) (b Str)) (out Str)
  (let [s (text a b) t (text s "!")] (if (= s "") "empty" t)))
(fn rec-eq (in (a Line) (b Line)) (out Bool) (= a b))
(fn email-pass (in (e Email)) (out Email) e)
(fn kind-is (in (k Kind)) (out Bool) (= (text k) "Reminder"))

(fn bad-text-rec (in (c Cust)) (out Str) (text c))
(fn bad-chars-nomax (in (s Str)) (out (Int 0 100)) (len (chars s)))
`;

describe('wasm strings', () => {
  const { prog, out } = build(FIXTURE);
  const rep = (n: string) => out.fns.find((f) => f.name === n)!;
  const COMPILABLE = [
    'name-of', 'same-name', 'is-ada', 'kind-line', 'greet', 'show-all', 'show-wide', 'text-none', 'price-str', 'signed-money',
    'mk-cust', 'rename', 'lookup', 'lookup-eq', 'try-name', 'skus-of', 'count-sku', 'pick-lines', 'gross', 'tagged',
    'rev-chars', 'n-chars', 'shout', 'code-sum', 'lit-eq', 'str-let', 'rec-eq', 'email-pass', 'kind-is',
  ];

  it('compiles string-valued functions and the module validates', () => {
    for (const n of COMPILABLE) expect(rep(n).compilable, `${n}: ${rep(n).reason}`).toBe(true);
    expect(WebAssembly.validate(new Uint8Array(out.bytes))).toBe(true);
  });

  it('refuses what it cannot render or measure, with reasons', () => {
    expect(rep('bad-text-rec').compilable).toBe(false);
    expect(rep('bad-text-rec').reason).toMatch(/text of a rec/);
    expect(rep('bad-chars-nomax').compilable).toBe(false);
    // from-chars on elements the checker cannot prove are code points stays refused (obligations are not weakened)
    expect(rep('shout-unproved').compilable).toBe(false);
    expect(rep('shout-unproved').reason).toMatch(/not proved/);
  });

  it('the module describes its string literals and imports itself (custom section sigil.abi)', async () => {
    const mod = await WebAssembly.compile(new Uint8Array(out.bytes));
    const abi = readAbi(mod);
    expect(abi).toEqual(out.abi);
    expect(abi.strings).toEqual(expect.arrayContaining(['Hello ', 'Ada', 'your receipt is ready']));
    const imports = WebAssembly.Module.imports(mod).map((i) => i.name).sort();
    // contract_violation and str_len are used by the validating export wrappers (ABI version 2)
    expect(imports).toEqual(['contract_violation', 'str_chars', 'str_concat', 'str_eq', 'str_from_chars', 'str_int', 'str_len', 'str_money']);
    expect(abi.version).toBe(2);
    expect(abi.validated).toBe(true);
  });

  it('strings are copied and passed by handle: long strings cost nothing to pass around', async () => {
    const ex = await instantiate(out.bytes);
    const long = 'x'.repeat(100000);
    const c = (name: string): Val => ({ $: 'rec', type: 'Cust', fields: { id: 1n, name, email: 'a@x.com', kind: enumVal('Alert') } });
    expect(callCompiled(rep('name-of'), ex, [c(long)])).toBe(long);
    expect(callCompiled(rep('greet'), ex, [c('Ada')])).toBe('Hello Ada, this is an alert');
    expect(callCompiled(rep('shout'), ex, ['hello wörld'])).toBe('HELLO WöRLD'.replace('Ö', 'ö'));
    expect(callCompiled(rep('n-chars'), ex, ['😀x日'])).toBe(3n); // code points, not UTF-16 units
    expect(callCompiled(rep('signed-money'), ex, [-5n])).toBe('-$0.05');
    expect(callCompiled(rep('price-str'), ex, [123456n])).toBe('$1234.56');
    expect(callCompiled(rep('lookup'), ex, [c('')])).toEqual(errVal(enumVal('Empty')));
    expect(callCompiled(rep('lookup'), ex, [c('Bo')])).toEqual(okVal('Bo'));
  });

  for (const name of COMPILABLE) {
    it(`differential: ${name} (300 seeded inputs, interpreter vs wasm)`, async () => {
      const d = await differential(prog, out, name);
      expect(d.mismatches).toEqual([]);
      expect(d.runs).toBe(300);
    });
  }

  it('the differential inputs include empty, equal and non-BMP strings', async () => {
    const d = await differential(prog, out, 'str-let');
    const seen = new Set(d.inputs.flat().map(String));
    expect(seen.has('')).toBe(true);
    expect(seen.has('😀x')).toBe(true);
    expect(d.wants.some((w) => w === 'empty')).toBe(true);
  });
});

describe('wasm strings: the differential test catches a broken compiler', () => {
  it('string equality that is always true is detected', async () => {
    const { prog, out } = build(FIXTURE, '(policy)', { mutation: 'str-eq-true' });
    for (const name of ['is-ada', 'same-name', 'count-sku', 'lit-eq']) {
      const d = await differential(prog, out, name, { n: 100 });
      expect(d.mismatches.length, name).toBeGreaterThan(0);
    }
  });
});
