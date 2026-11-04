// Scoring entry point.
//   npx tsx experiments/run.ts <taskId> <sigil|ts> <path-to-solution>
//   import { runTask } from './experiments/run.js'
// Prints (CLI) and returns { total, passed, trapTotal, trapViolations, failures: [{name, trap, reason}] }.
// Hidden cases are read from $EXPERIMENT_HIDDEN_DIR (the directory holding cases.json), default
// experiments/tasks/<taskId>/hidden, so an orchestrator can keep them outside the agent's workspace.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSigil } from './lib/sigil-runner.js';
import { Score, allFail, loadCases } from './lib/score.js';
import { runTs } from './lib/ts-runner.js';

export type { Score } from './lib/score.js';
export type Lang = 'sigil' | 'ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** experiments/tasks/<id>, where <id> may also be just the prefix before the first dash (A1 for A1-tiered-pricing). */
export function taskDir(taskId: string): string {
  const exact = join(ROOT, 'tasks', taskId);
  if (existsSync(exact)) return exact;
  const dirs = existsSync(join(ROOT, 'tasks')) ? readdirSync(join(ROOT, 'tasks')).filter((d) => d.startsWith(`${taskId}-`)) : [];
  return dirs.length === 1 ? join(ROOT, 'tasks', dirs[0]) : exact;
}

export interface RunOptions {
  hiddenDir?: string;
  timeoutMs?: number;
}

export async function runTask(taskId: string, lang: Lang, solution: string, opts: RunOptions = {}): Promise<Score> {
  if (lang !== 'sigil' && lang !== 'ts') throw new Error(`language must be sigil or ts, got ${lang}`);
  const hidden = resolve(opts.hiddenDir ?? process.env.EXPERIMENT_HIDDEN_DIR ?? join(taskDir(taskId), 'hidden'));
  const cf = loadCases(hidden); // a missing or malformed case file is a harness error, not a solution failure

  let file = resolve(solution);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, lang === 'sigil' ? 'app.sigil' : 'solution.ts');
  if (!existsSync(file)) return allFail(cf, `solution not found: ${solution}`);

  if (lang === 'sigil') return runSigil(cf, readFileSync(file, 'utf8'));
  return runTs(cf, file, opts.timeoutMs ?? 2000);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [taskId, lang, path] = process.argv.slice(2);
  if (!taskId || !lang || !path) {
    console.error('usage: npx tsx experiments/run.ts <taskId> <sigil|ts> <path-to-solution>');
    process.exit(2);
  }
  runTask(taskId, lang as Lang, path).then(
    (s) => {
      console.log(JSON.stringify(s, null, 2));
      process.exit(s.passed === s.total ? 0 : 1);
    },
    (e) => {
      console.error(`harness error: ${(e as Error).message}`);
      process.exit(2);
    },
  );
}
