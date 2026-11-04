// Export a task's visible Example scenarios as concrete test cases for the TypeScript arm.
//
// The Sigil arm gets the intent spec's examples as executable scenarios through the glossary. The TypeScript arm used to get the same
// examples only as prose, so its agents had to write the tests themselves. This closes that gap: every Example in intent.feature is run
// through the glossary on the REFERENCE Sigil program (which passes the whole suite), the call it makes is captured as concrete
// arguments, and the reference's result and effect log become the expectation. The output is the visible examples only: no hidden case,
// no property and no trap is exported.
//
//   npx tsx experiments/export-scenarios.ts <task> [--out DIR]    writes scenarios.json and scenarios.test.ts into DIR (default: cwd)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseProgram } from '../src/parse.js';
import { Host, Interp, Val, evalIn } from '../src/interp.js';
import { parseFeature, parseGlossary } from '../src/scenario.js';
import { encodeVal, Json } from './lib/json.js';
import { taskDir } from './run.js';

export interface ScenarioCase {
  name: string;
  args: Record<string, Json>;
  fail: { handle: string; op: string }[];
  expect: { result: Json; stored: Json[]; sent: Json[]; emitted: Json[] };
}

export function exportScenarios(task: string): { entry: string; cases: ScenarioCase[]; skipped: string[] } {
  const td = taskDir(task);
  const prog = parseProgram(readFileSync(join(td, 'ref/sigil/app.sigil'), 'utf8'));
  const feature = parseFeature(readFileSync(join(td, 'visible/intent.feature'), 'utf8'));
  const g = parseGlossary(readFileSync(join(td, 'visible/glossary.sigil'), 'utf8'), prog);
  const cases: ScenarioCase[] = [];
  const skipped: string[] = [];
  let entry = '';
  for (const ex of feature.examples) {
    const host = new Host(1);
    const it = new Interp(prog, host);
    const vars = new Map<string, Val>();
    const fail: { handle: string; op: string }[] = [];
    let call: { fn: string; args: Val[] } | undefined;
    let ok = true;
    for (const st of ex.steps) {
      if (st.kind === 'then') continue; // expectations come from the reference run, below
      const phrase = g.phrases.find((p) => p.kind === st.kind && p.regex.test(st.text));
      if (!phrase) { ok = false; break; }
      const m = phrase.regex.exec(st.text)!;
      const caps = new Map(phrase.params.map((p, i) => [p.name, p.type.parse(m[i + 1])]));
      const scope = () => new Map<string, Val>([...vars, ...caps]);
      for (const a of phrase.actions) {
        if (a.a === 'set') vars.set(a.name, evalIn(it, a.expr, scope()));
        else if (a.a === 'default') { if (!vars.has(a.name)) vars.set(a.name, evalIn(it, a.expr, scope())); }
        else if (a.a === 'append') vars.set(a.name, [...((vars.get(a.name) as Val[] | undefined) ?? []), evalIn(it, a.expr, scope())]);
        else if (a.a === 'fail') fail.push({ handle: a.handle, op: a.op });
        else if (a.a === 'call') call = { fn: a.fn, args: a.args.map((x) => evalIn(it, x, scope())) };
      }
    }
    if (!ok || !call) { skipped.push(ex.title); continue; }
    entry = entry || call.fn;
    // Fresh host for the recorded run, with the same injected failures.
    const h2 = new Host(1);
    for (const f of fail) h2.fail(f.handle, f.op);
    const fn = prog.fns.get(call.fn)!;
    const result = new Interp(prog, h2).callFn(call.fn, call.args);
    const okLog = h2.log.filter((o) => o.ok);
    cases.push({
      name: ex.title,
      args: Object.fromEntries(fn.params.map((p, i) => [p.name, encodeVal(call!.args[i])])),
      fail,
      expect: {
        result: encodeVal(result),
        stored: okLog.filter((o) => o.op === 'put').map((o) => encodeVal(o.args[1])),
        sent: okLog.filter((o) => o.op === 'post').map((o) => encodeVal(o.args[0])),
        emitted: okLog.filter((o) => o.op === 'emit').map((o) => encodeVal(o.args[0])),
      },
    });
  }
  return { entry, cases, skipped };
}

const TEST_FILE = `// Visible examples of intent.feature as tests (generated from the glossary; do not edit). Add your own tests in other files.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import run from './solution.js';
import { makeHost } from './host.js';

type Case = { name: string; args: Record<string, unknown>; fail: { handle: string; op: string }[]; expect: { result: unknown; stored: unknown[]; sent: unknown[]; emitted: unknown[] } };
const cases = JSON.parse(readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8')) as Case[];

describe('examples from intent.feature', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const { host, effects } = makeHost({ fail: c.fail, seed: 1 });
      const result = await run(c.args as never, host);
      expect(result).toEqual(c.expect.result);
      const e = effects();
      expect(e.stored).toEqual(c.expect.stored);
      expect(e.sent).toEqual(c.expect.sent);
      expect(e.emitted).toEqual(c.expect.emitted);
    });
  }
});
`;

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [task] = process.argv.slice(2);
  const oi = process.argv.indexOf('--out');
  const out = resolve(oi >= 0 ? process.argv[oi + 1] : '.');
  const { entry, cases, skipped } = exportScenarios(task);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'scenarios.json'), JSON.stringify(cases, null, 1));
  writeFileSync(join(out, 'scenarios.test.ts'), TEST_FILE);
  console.log(`${task}: ${cases.length} scenario(s) for ${entry}${skipped.length ? `, skipped ${skipped.length}: ${skipped.join('; ')}` : ''}`);
}
export { TEST_FILE };
