// Runs visible + hidden checks against the agent's auth module in a child process; prints one JSON line.
import { pathToFileURL } from 'node:url';
import { visible } from './auth-checks-visible.mjs';
import { hidden } from './auth-checks-hidden.mjs';
const out = { loaded: false, results: [] };
try {
  const mod = await import(pathToFileURL(process.argv[2]).href);
  if (typeof mod.default !== 'function') throw new Error('default export is not a function');
  out.loaded = true;
  for (const [group, list] of [['visible', visible], ['hidden', hidden]]) {
    for (const c of list) {
      let ok = true, err;
      try {
        await Promise.race([c.run(mod.default), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
      } catch (e) { ok = false; err = String((e && e.message) || e).split('\n')[0].slice(0, 160); }
      out.results.push({ name: c.name, kind: c.kind, group, ok, err });
    }
  }
} catch (e) { out.error = String((e && e.stack) || e).split('\n')[0]; }
console.log(JSON.stringify(out));
process.exit(0);
