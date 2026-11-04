// Machine-verifies every fenced example in docs/LANGUAGE.md.
//
//   ```sigil          first block is the shared prelude; later blocks accumulate onto it (types, fns,
//                     validators, program wiring). Each must parse, print/re-parse to a fixed point, and
//                     check with no errors, no warnings and no unproved or failed obligations
//                     (`ensures` are discharged by SMT).
//   ```sigil-error    checked against everything accumulated so far, NOT added to it. Must start with a
//                     `; expect: E-xxx` comment; the checker must report exactly that error code.
//   ```sigil-policy   accumulates into the policy (human-owned policy.sigil).
//   ```sigil-glossary / ```sigil-feature   run together as a scenario suite against the accumulated
//                     program; every example, rule, property and privacy check must pass.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import { parsePolicy, parseProgram } from '../src/parse.js';
import { printProgram } from '../src/print/sexp.js';
import { DEFAULT_SUITE, parseFeature, parseGlossary, runSuite } from '../src/scenario.js';
import { proveEnsures } from '../src/smt.js';

const spec = readFileSync(new URL('../docs/LANGUAGE.md', import.meta.url), 'utf8');

interface Block {
  tag: string;
  body: string;
  line: number;
}
const blocks: Block[] = [];
for (const m of spec.matchAll(/^```(sigil[\w-]*)\n([\s\S]*?)^```$/gm)) {
  blocks.push({ tag: m[1], body: m[2], line: spec.slice(0, m.index).split('\n').length });
}

async function problems(src: string, policy: string): Promise<{ errors: string[]; others: string[] }> {
  const prog = parseProgram(src);
  const res = check(prog, parsePolicy(policy));
  const errors = [...new Set(res.diags.filter((d) => d.level === 'error').map((d) => d.code))];
  const others = res.diags.filter((d) => d.level === 'warn').map((d) => `${d.code} ${d.fn}: ${d.msg}`);
  for (const ev of res.evidence.values()) {
    for (const o of ev.obligations) if (o.status !== 'proved' && o.kind !== 'ensures') others.push(`${o.status} ${o.desc} (${o.note ?? ''})`);
  }
  const open = new Set<string>();
  for (const ev of res.evidence.values()) ev.obligations.filter((o) => o.kind === 'ensures').forEach((o, i) => o.status !== 'proved' && open.add(`${ev.fn}#${i}`));
  if (open.size) {
    for (const r of await proveEnsures(prog, (fn, i) => open.has(`${fn}#${i}`))) if (r.status !== 'proved') others.push(`ensures ${r.fn}#${r.index}: ${r.status}`);
  }
  return { errors, others };
}

function fixedPoint(src: string) {
  const p1 = parseProgram(src);
  const t1 = printProgram(p1);
  const p2 = parseProgram(t1);
  expect(printProgram(p2)).toBe(t1);
  expect(p2.types).toEqual(p1.types);
  expect([...p2.fns.values()]).toEqual([...p1.fns.values()]);
  expect([...p2.validators.values()]).toEqual([...p1.validators.values()]);
}

describe('docs/LANGUAGE.md examples', () => {
  it('has the required blocks', () => {
    expect(blocks[0]?.tag).toBe('sigil');
    const errs = blocks.filter((b) => b.tag === 'sigil-error').map((b) => /; expect: (E-[\w-]+)/.exec(b.body)?.[1]);
    expect(errs.every(Boolean)).toBe(true);
    for (const c of ['E-flow', 'E-integrity', 'E-cap']) expect(errs).toContain(c);
  });

  it('every block parses, round-trips, and checks as it claims', async () => {
    let acc = '';
    let policy = '';
    let glossary = '';
    let feature = '';
    let prog = '';
    for (const b of blocks) {
      const where = `LANGUAGE.md:${b.line} (${b.tag})`;
      if (b.tag === 'sigil') {
        const next = acc + '\n' + b.body;
        fixedPoint(b.body);
        const r = await problems(next, policy);
        expect(r, where).toEqual({ errors: [], others: [] });
        acc = next;
      } else if (b.tag === 'sigil-error') {
        const code = /; expect: (E-[\w-]+)/.exec(b.body)![1];
        fixedPoint(b.body);
        const r = await problems(acc + '\n' + b.body, policy);
        expect(r.errors, where).toEqual([code]);
      } else if (b.tag === 'sigil-policy') {
        policy += '\n' + b.body;
        parsePolicy(policy);
      } else if (b.tag === 'sigil-glossary') {
        glossary = b.body;
        prog = acc;
      } else if (b.tag === 'sigil-feature') {
        feature = b.body;
      } else throw new Error(`${where}: unknown tag`);
    }
    // Scenario suite: glossary + feature against the accumulated program.
    expect(glossary && feature).toBeTruthy();
    const p = parseProgram(prog);
    const pol = parsePolicy(policy);
    const res = check(p, pol);
    const suite = runSuite(p, parseFeature(feature), parseGlossary(glossary, p), res, DEFAULT_SUITE);
    const failed = suite.results.filter((r) => r.status !== 'pass');
    expect(failed).toEqual([]);
    expect(suite.results.length).toBeGreaterThanOrEqual(5);
    expect(suite.results.map((r) => r.kind).sort()).toEqual(['always', 'example', 'example', 'privacy', 'rule']);
  }, 60000);
});
