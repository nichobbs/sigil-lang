// Size of the delivered code, per task and arm: tokens (o200k_base and cl100k_base; both are OpenAI vocabularies, so only the
// ratios mean anything), non-blank non-comment lines, characters. Reads every scored run with m1 = true from pilot.jsonl whose
// workspace still exists, plus the reference solutions. Comments and blank lines are stripped so that style does not decide.
//
//   npx tsx experiments/solution-size.ts [--md]

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { encode as o200k } from 'gpt-tokenizer/encoding/o200k_base';
import { encode as cl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { taskDir } from './run.js';

const WORK = process.env.EXP_WORK ?? '/home/claude/exp-work';
type Lang = 'sigil' | 'ts';

export function stripComments(src: string, lang: Lang): string {
  let s = src;
  if (lang === 'ts') s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');
  else s = s.replace(/(^|[^"\\]);.*$/gm, '$1');
  return s.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '').join('\n');
}

export interface Size { o200k: number; cl100k: number; lines: number; chars: number }
export function measure(src: string, lang: Lang): Size {
  const s = stripComments(src, lang);
  return { o200k: o200k(s).length, cl100k: cl100k(s).length, lines: s.split('\n').length, chars: s.length };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

/** Tokens of the test files an agent wrote itself (provided scenarios.* files are not the agent's work and are reported separately). */
function ownTestTokens(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts') && !f.startsWith('scenarios.'))
    .reduce((a, f) => a + measure(readFileSync(join(dir, f), 'utf8'), 'ts').o200k, 0);
}

interface Rec { task: string; lang: Lang; model: string; run: number; m1: boolean }

if (process.argv[1]?.endsWith('solution-size.ts')) {
  const recs = readFileSync(new URL('./results/pilot.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Rec);
  const rows: { task: string; lang: Lang; model: string; run: number; size: Size; tests: number }[] = [];
  for (const r of recs) {
    if (!r.m1) continue;
    const dir = join(WORK, `${r.task}-${r.lang}-${r.model}-r${r.run}`);
    const f = r.lang === 'sigil' ? join(dir, 'task', 'app.sigil') : join(dir, 'solution.ts');
    if (!existsSync(f)) continue;
    rows.push({ task: r.task, lang: r.lang, model: r.model, run: r.run, size: measure(readFileSync(f, 'utf8'), r.lang), tests: r.lang === 'ts' ? ownTestTokens(dir) : 0 });
  }
  const tasks = [...new Set(rows.map((r) => r.task))].sort();
  const md = process.argv.includes('--md');
  const line = (c: (string | number)[]) => (md ? `| ${c.join(' | ')} |` : c.map((x) => String(x).padEnd(10)).join(''));
  console.log(line(['task', 'ref sigil', 'ref ts', 'ref ratio', 'agent sigil', 'agent ts', 'agent ratio', 'ts+tests', 'ratio+tests', 'n(s/t)']));
  if (md) console.log('|---|---|---|---|---|---|---|---|---|---|');
  const ratios: number[] = [];
  const refRatios: number[] = [];
  const ratiosT: number[] = [];
  for (const t of tasks) {
    const td = taskDir(t);
    const rs = join(td, 'ref/sigil/app.sigil');
    const rt = join(td, 'ref/ts/solution.ts');
    const hasRef = existsSync(rs) && existsSync(rt); // C1 has no reference solutions
    const refS = hasRef ? measure(readFileSync(rs, 'utf8'), 'sigil').o200k : NaN;
    const refT = hasRef ? measure(readFileSync(rt, 'utf8'), 'ts').o200k : NaN;
    const s = rows.filter((r) => r.task === t && r.lang === 'sigil').map((r) => r.size.o200k);
    const x = rows.filter((r) => r.task === t && r.lang === 'ts').map((r) => r.size.o200k);
    const xt = rows.filter((r) => r.task === t && r.lang === 'ts').map((r) => r.size.o200k + r.tests);
    const ratio = median(s) / median(x);
    const ratioT = median(s) / median(xt);
    if (Number.isFinite(ratioT)) ratiosT.push(ratioT);
    if (Number.isFinite(ratio)) ratios.push(ratio);
    if (hasRef) refRatios.push(refS / refT);
    console.log(line([t, hasRef ? refS : '-', hasRef ? refT : '-', hasRef ? (refS / refT).toFixed(2) : '-', Number.isFinite(median(s)) ? median(s) : '-', Number.isFinite(median(x)) ? median(x) : '-', Number.isFinite(ratio) ? ratio.toFixed(2) : '-', Number.isFinite(median(xt)) ? median(xt) : '-', Number.isFinite(ratioT) ? ratioT.toFixed(2) : '-', `${s.length}/${x.length}`]));
  }
  const gm = (xs: number[]) => Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length);
  console.log(`\nGeometric mean sigil/ts token ratio: reference ${gm(refRatios).toFixed(2)} (${refRatios.length} tasks), agent runs ${gm(ratios).toFixed(2)} (${ratios.length} tasks)`);
  console.log(`With the tests the TS agents wrote themselves counted as part of the TS delivery: ${gm(ratiosT).toFixed(2)} (${ratiosT.length} tasks)`);
  for (const model of ['sonnet', 'haiku']) {
    const rr: number[] = [];
    const rrT: number[] = [];
    for (const t of tasks) {
      const s = rows.filter((r) => r.task === t && r.lang === 'sigil' && r.model === model).map((r) => r.size.o200k);
      const x = rows.filter((r) => r.task === t && r.lang === 'ts' && r.model === model).map((r) => r.size.o200k);
      const xt = rows.filter((r) => r.task === t && r.lang === 'ts' && r.model === model).map((r) => r.size.o200k + r.tests);
      if (s.length && x.length) { rr.push(median(s) / median(x)); rrT.push(median(s) / median(xt)); }
    }
    if (rr.length) console.log(`  ${model}: ${gm(rr).toFixed(2)} code only, ${gm(rrT).toFixed(2)} with TS tests, over ${rr.length} tasks`);
  }
}
