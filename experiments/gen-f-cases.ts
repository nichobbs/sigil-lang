// Builds hidden cases for the self-hosting probe tasks F1 (s-expression reader) and F2 (Wasm emitter) from their TypeScript references.
// F2 outputs are also instantiated with WebAssembly and evaluated against a direct interpreter of the expression, as an independent check.
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, 'tasks');
const load = async (t: string) => (await import(pathToFileURL(`${root}/${t}/ref/ts/solution.ts`).href)).default;
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const empty = { stored: [], sent: [], emitted: [] };

// ---- F1 ----
const f1 = await load('F1-sexp-reader');
const f1cases: [string, string][] = [
  ['single atom', 'hello'], ['atom with surrounding whitespace', '  \t hello \n'], ['empty form', '()'], ['nested empty forms', '(()())'],
  ['form with atoms', '(a b c)'], ['nested forms', '(add 1 (mul 2 3))'], ['deeply nested', '((((a))))'], ['text node', '"a (b) ; c"'],
  ['text with newline', '("a\nb" c)'], ['empty text', '""'], ['comment inside form', '(a ; c)\n b)'], ['comment at end of line then close', '(a ;x\n)'],
  ['atom stops at quote', '(a"b"c)'], ['atom stops at paren', '(ab(cd)ef)'], ['semicolon ends atom', '(ab;cd\nef)'], ['unicode atoms count characters', '(héllo wörld)'],
  ['unicode in text', '("日本語" x)'], ['tab and newline separators', '(a\tb\nc)'], ['only comment', '; nothing'], ['empty source', ''], ['only spaces', '   '],
  ['stray close at start', ')'], ['stray close after form', '(a))'], ['trailing atom after form', '(a) b'], ['trailing form after atom', 'a (b)'], ['two atoms', 'a b'],
  ['trailing text', '(a) "x"'], ['unclosed simple', '(a'], ['unclosed nested', '(a (b)'], ['unclosed with comment', '(a ; ) \n'], ['unterminated text', '"abc'],
  ['unterminated text inside form', '(a "b)'], ['stray before unterminated', ') "x'], ['trailing before unclosed', 'a (b'], ['unterminated before trailing check', '(a) "x'],
  ['exactly 60 nodes', '(' + 'a '.repeat(59) + ')'], ['61 nodes is TooBig', '(' + 'a '.repeat(60) + ')'], ['60 nested atoms inside two forms', '(' + 'a '.repeat(57) + '(b))'],
  ['TooBig reported before a later Stray', '(' + 'a '.repeat(60) + '))'], ['TooBig reported before Unclosed', '(' + 'a '.repeat(61)], ['120 characters exactly', '(' + 'a'.repeat(118) + ')'],
  ['wide siblings parent indexes', '(a (b c) (d (e f)) g)'], ['arity counts only direct children', '((a b) (c d e) f)'],
];
const atoms = ['a', 'bb', '1', 'x-y', '"t"', '"te st"', '()', '(a)', '(a b)', '; c\n', ' ', '\t', '\n'];
for (let n = 0; n < 20; n++) {
  let s = '(';
  const depth: number[] = [];
  for (let i = 0; i < 6 + Math.floor(rnd() * 12); i++) s += pick(atoms) + (rnd() < 0.5 ? ' ' : '');
  s += ')';
  f1cases.push([`random form ${n}`, s.slice(0, 120)]);
}
const f1out = [] as unknown[];
for (const [name, src] of f1cases) {
  const result = await f1({ src });
  f1out.push({ name, args: { src }, host: { seed: 1 }, expect: { result, effects: empty } });
}
mkdirSync(`${root}/F1-sexp-reader/hidden`, { recursive: true });
writeFileSync(`${root}/F1-sexp-reader/hidden/cases.json`, JSON.stringify({ entry: 'read-sexp', cases: f1out }, null, 1) + '\n');

// ---- F2 ----
const f2 = await load('F2-wasm-emit');
type E = { op: string; val: number };
const C = (v: number): E => ({ op: 'Const', val: v });
const O = (op: string): E => ({ op, val: 0 });
const f2cases: [string, E[]][] = [
  ['constant', [C(5)]], ['zero', [C(0)]], ['minus one', [C(-1)]], ['63 fits one byte', [C(63)]], ['64 needs two bytes', [C(64)]], ['minus 64 one byte', [C(-64)]],
  ['minus 65 two bytes', [C(-65)]], ['8191', [C(8191)]], ['8192', [C(8192)]], ['minus 8192', [C(-8192)]], ['minus 8193', [C(-8193)]], ['1000000 max', [C(1000000)]],
  ['minus 1000000 min', [C(-1000000)]], ['param0', [O('Param0')]], ['param1', [O('Param1')]], ['add params', [O('Param0'), O('Param1'), O('Add')]],
  ['sub operand order', [O('Param0'), O('Param1'), O('Sub')]], ['mul consts', [C(3), C(4), O('Mul')]], ['nested', [C(1), C(2), O('Add'), C(3), O('Mul'), O('Param0'), O('Sub')]],
  ['ignored val on param', [{ op: 'Param0', val: 999 }]], ['ignored val on add', [C(1), C(2), { op: 'Add', val: -5 }]],
  ['underflow immediately', [O('Add')]], ['underflow after one', [C(1), O('Mul')]], ['underflow in order before shape', [C(1), O('Sub'), C(2), C(3)]],
  ['two values left', [C(1), C(2)]], ['three values left', [O('Param0'), O('Param1'), C(1)]], ['underflow beats bad shape', [C(1), C(2), C(3), O('Add'), O('Add'), O('Add')]],
  ['long chain of adds', [C(1), ...Array.from({ length: 19 }).flatMap(() => [C(2), O('Add')])]],
  ['max length 40 nodes', [C(7), ...Array.from({ length: 19 }).flatMap((_, i) => [C(i * 1000), O('Sub')]), C(0)].slice(0, 39).concat([O('Add')])],
  ['code length crosses 127 bytes', [C(1000000), ...Array.from({ length: 18 }).flatMap(() => [C(-1000000), O('Add')])]],
];
for (let n = 0; n < 15; n++) {
  const body: E[] = [rnd() < 0.5 ? C(Math.floor(rnd() * 2000001) - 1000000) : O(pick(['Param0', 'Param1']))];
  let depth = 1;
  for (let i = 0; i < 2 + Math.floor(rnd() * 14); i++) {
    if (depth >= 2 && rnd() < 0.5) { body.push(O(pick(['Add', 'Sub', 'Mul']))); depth -= 1; }
    else { body.push(rnd() < 0.6 ? C(Math.floor(rnd() * 2000001) - 1000000) : O(pick(['Param0', 'Param1']))); depth += 1; }
  }
  while (depth > 1) { body.push(O(pick(['Add', 'Sub', 'Mul']))); depth -= 1; }
  f2cases.push([`random expression ${n}`, body]);
}
const evalExpr = (nodes: E[], a: bigint, b: bigint): bigint => {
  const st: bigint[] = [];
  for (const n of nodes) {
    if (n.op === 'Const') st.push(BigInt(n.val)); else if (n.op === 'Param0') st.push(a); else if (n.op === 'Param1') st.push(b);
    else { const y = st.pop() as bigint, x = st.pop() as bigint; st.push(BigInt.asIntN(64, n.op === 'Add' ? x + y : n.op === 'Sub' ? x - y : x * y)); }
  }
  return st[0];
};
const f2out = [] as unknown[];
let checked = 0;
for (const [name, nodes] of f2cases) {
  if (nodes.length > 40) throw new Error(`${name}: ${nodes.length} nodes`);
  const result = await f2({ nodes });
  if ('ok' in result) {
    if (result.ok.length > 400) throw new Error(`${name}: ${result.ok.length} bytes`);
    const inst = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(result.ok)));
    const f = inst.exports.f as (a: bigint, b: bigint) => bigint;
    for (const [a, b] of [[3n, 5n], [-7n, 11n], [123456789n, -987654321n]]) {
      if (f(a, b) !== evalExpr(nodes, a, b)) throw new Error(`${name}: wasm disagrees at (${a},${b})`);
    }
    checked += 1;
  }
  f2out.push({ name, args: { nodes }, host: { seed: 1 }, expect: { result, effects: empty } });
}
mkdirSync(`${root}/F2-wasm-emit/hidden`, { recursive: true });
writeFileSync(`${root}/F2-wasm-emit/hidden/cases.json`, JSON.stringify({ entry: 'emit-module', cases: f2out }, null, 1) + '\n');
console.log(`F1 ${f1out.length} cases, F2 ${f2out.length} cases (${checked} modules instantiated and evaluated)`);
