// Practice harness copied into the agent's workspace. Runs the visible checks (checks.mjs) against auth.mjs.
import { pathToFileURL } from 'node:url';
import { visible } from './checks.mjs';
const mod = await import(pathToFileURL(new URL('./auth.mjs', import.meta.url).pathname).href);
let pass = 0;
for (const c of visible) {
  try { await c.run(mod.default); pass++; console.log(`PASS ${c.name}`); } catch (e) { console.log(`FAIL ${c.name}: ${String((e && e.message) || e).split('\n')[0]}`); }
}
console.log(JSON.stringify({ passed: pass, total: visible.length }));
