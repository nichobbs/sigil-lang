// Build step: check the Sigil project, compile it to Wasm, write app.wasm and app.reports.json next to the UI.
// Refuses to write anything unless the program checks clean and every function the shell calls is compiled.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check, errors } from '../../src/check.js';
import { parsePolicy, parseProgram } from '../../src/parse.js';
import { compileProgram } from '../../src/wasm/compile.js';
import { reportsToJson } from './src/wasmio.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const SHELL_FNS = ['handle-request', 'doc-view'];

const prog = parseProgram(readFileSync(`${HERE}sigil/app.sigil`, 'utf8'));
const pol = parsePolicy(readFileSync(`${HERE}sigil/policy.sigil`, 'utf8'));
const res = check(prog, pol);
const errs = errors(res);
if (errs.length) throw new Error(`checker errors: ${errs.map((e) => e.code).join(', ')}`);
const out = compileProgram(prog, res);
for (const n of SHELL_FNS) {
  const f = out.fns.find((x) => x.name === n);
  if (!f?.compilable) throw new Error(`${n} is not compilable: ${f?.reason ?? 'missing'}`);
}
writeFileSync(`${HERE}web/app.wasm`, out.bytes);
writeFileSync(`${HERE}web/app.reports.json`, reportsToJson(out.fns, SHELL_FNS));
console.log(`wrote app.wasm (${out.bytes.length} bytes) and app.reports.json; ${out.fns.filter((f) => f.compilable).length}/${out.fns.length} functions compiled, entries: ${out.entries.join(', ')}`);
