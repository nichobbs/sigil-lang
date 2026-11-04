// C1 config parser: the TypeScript reference must score 100% and deliberately broken variants must be caught, with trap variants
// raising trapViolations. There is no Sigil reference for this task: the language has no way to look inside a Str (see
// experiments/tasks/C1-config-parser/ref/sigil/GAP.md), so the Sigil arm scores as a failure and there is nothing to test on that side.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTask } from '../experiments/run.js';

const C1 = 'C1-config-parser';
const C1_TS = `experiments/tasks/${C1}/ref/ts/solution.ts`;
const tmp = mkdtempSync(join(tmpdir(), 'sigil-exp-c1-'));

interface Variant {
  name: string;
  from: string; // exact text in the reference
  to: string;
  trap: boolean; // a trap case must fail
}

function variantFile(refPath: string, v: Variant, idx: number): string {
  const src = readFileSync(refPath, 'utf8');
  if (src.split(v.from).length !== 2) throw new Error(`variant "${v.name}": the reference must contain the text to replace exactly once`);
  const file = join(tmp, `ts-${idx}.ts`);
  writeFileSync(file, src.replace(v.from, v.to));
  return file;
}

const C1_TS_VARIANTS: Variant[] = [
  { name: 'off-by-one: the largest integer is refused', from: 'n >= INT_MIN && n <= INT_MAX', to: 'n >= INT_MIN && n < INT_MAX', trap: false },
  { name: 'off-by-one: a key of 64 characters is refused', from: 'key.length > KEY_MAX', to: 'key.length >= KEY_MAX', trap: false },
  { name: 'off-by-one: line numbers start at 0', from: 'line: n + 1, reason: r', to: 'line: n, reason: r', trap: false },
  { name: 'keys are compared without regard to case for duplicates', from: 'seen.has(r.key)', to: '[...seen].some((k) => k.toLowerCase() === r.key.toLowerCase())', trap: false },
  { name: 'wrong order: settings are returned reversed', from: 'return { ok: { settings } };', to: 'return { ok: { settings: settings.reverse() } };', trap: false },
  { name: 'a carriage return counts as a blank', from: "c === ' ' || c === '\\t'", to: "c === ' ' || c === '\\t' || c === '\\r'", trap: false },
  { name: 'text after the value is ignored', from: "if (rest < line.length && line[rest] !== '#') return 'BadValue';", to: '', trap: false },
  { name: 'missing effect: the settings found are dropped from the result', from: 'return { ok: { settings } };', to: 'return { ok: { settings: settings.slice(0, -1) } };', trap: false },
  {
    name: 'trap: comments are stripped before the line is read (a hash inside a string cuts it)',
    from: 'const r = parseLine(lines[n]);',
    to: "const r = parseLine(lines[n].replace(/#.*/, ''));",
    trap: true,
  },
  {
    name: 'trap: a duplicate key silently replaces the earlier setting',
    from: "if (seen.has(r.key)) return { err: { line: n + 1, reason: 'Duplicate' } };",
    to: 'if (seen.has(r.key)) settings.splice(settings.findIndex((s) => s.key === r.key), 1);',
    trap: true,
  },
  {
    name: 'trap: integers outside the declared range are accepted',
    from: "if (!(n >= INT_MIN && n <= INT_MAX)) return 'BadValue';",
    to: '',
    trap: true,
  },
];

describe('experiments harness: C1 config parser', () => {
  it('has no Sigil reference, only the documented gap', () => {
    expect(existsSync(`experiments/tasks/${C1}/ref/sigil/app.sigil`)).toBe(false);
    expect(existsSync(`experiments/tasks/${C1}/ref/sigil/GAP.md`)).toBe(true);
  });

  it('TypeScript reference passes 100%', async () => {
    const s = await runTask(C1, 'ts', C1_TS);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(28);
    expect(s.total).toBeLessThanOrEqual(45);
    expect(s.trapTotal).toBeGreaterThanOrEqual(2);
    expect(s.trapViolations).toBe(0);
  }, 30_000);

  it('TypeScript catches every broken variant (and flags trap violations)', async () => {
    const results = await Promise.all(C1_TS_VARIANTS.map((v, i) => runTask(C1, 'ts', variantFile(C1_TS, v, 100 + i))));
    results.forEach((s, i) => {
      const v = C1_TS_VARIANTS[i];
      expect(s.passed, v.name).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations, v.name).toBeGreaterThan(0);
    });
  }, 60_000);
});
