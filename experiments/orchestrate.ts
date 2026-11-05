// Pilot/experiment orchestration. The agents themselves are launched by whoever drives the experiment (one fresh agent per
// workspace, model fixed per run); this file prepares clean workspaces and scores what comes back.
//
//   npx tsx experiments/orchestrate.ts prepare <task> <sigil|ts> <model> <run>     -> prints {dir, prompt}
//   npx tsx experiments/orchestrate.ts score   <dir> [--tokens N] [--tools N] [--ms N] [--transcript FILE] [--log FILE]
//
// A workspace holds only: the visible task files, the arm's tooling and the language spec (Sigil arm). The hidden cases and the
// reference solutions stay in this repository, outside $EXP_WORK. $EXP_WORK defaults to /home/claude/exp-work.

import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lang, runTask, taskDir } from './run.js';
import { TEST_FILE, exportScenarios } from './export-scenarios.js';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORK = process.env.EXP_WORK ?? '/home/claude/exp-work';
const TOOLS = process.env.EXP_TOOLS ?? '/home/claude/exp-tools';
export const TOOL_CALL_CAP = 40;

function bundle(): string {
  const out = join(WORK, '_bundle', 'sigil.mjs');
  mkdirSync(join(WORK, '_bundle'), { recursive: true });
  execFileSync(join(REPO, 'node_modules/.bin/esbuild'), [join(REPO, 'src/cli.ts'), '--bundle', '--platform=node', '--format=esm', '--external:z3-solver', `--outfile=${out}`, '--log-level=error', "--banner:js=import {createRequire} from 'module';const require=createRequire(import.meta.url);"]);
  return out;
}

const ENCODING = `Values: integers are JSON numbers; strings are strings; an enum value is its case name as a string ("Gold"); a record is an object with the declared field names; a list is an array; Result is {"ok": v} or {"err": "CaseName"}.`;

function common(task: string, lang: Lang): string {
  return `You are implementing one task from an intent spec. Work only inside your current workspace directory. Do not read or search any directory outside it, and do not browse the web. Everything you need is here.

Task: ${task}. Read the task README (README.md), then the intent spec (intent.feature). The scorer runs hidden cases that go beyond the examples; the intent spec's rules and policies are binding, not only its examples. Your job is correct, complete behaviour, including the rules that the examples do not show.

Budget: at most ${TOOL_CALL_CAP} tool calls in total. Stop as soon as you are confident the program is correct, or when the budget is used up. Finish with a two-line message: what you built, and anything you are unsure of.
`;
}

function sigilPrompt(task: string): string {
  return `${common(task, 'sigil')}
Language: Sigil. Your deliverable is the single file task/app.sigil. Read LANGUAGE.md first (the language spec), then WORKFLOW.md (the tool loop). The files in task/ other than app.sigil (feature, glossary, policy, README.md) belong to humans: do not edit them. The one exception is task/proposed-policy.sigil, which you create only when the spec itself requires releasing labelled data (see WORKFLOW.md, \"Proposed declassifier\"); never edit policy.sigil. Your loop is \`node sigil.mjs verify task --fast\` (check plus scenarios, seconds) and, for open findings, \`node sigil.mjs fix task\`. Do not run the full \`verify\` (mutation testing takes minutes; the harness runs it after you finish); do not read sigil.mjs.
`;
}

const GUARD_NOTE = `
Data-classification guard (human-owned, read only: host.ts, types.ts, guard.check.ts, eslint.config.mjs): the argument types are in types.ts and your default export must be declared \`run(args: RefundArgs, host: Host)\`, importing both types (guard.check.ts enforces this). A value typed Pii (such as payment.card) cannot be passed to host.audit.emit or host.net.post: the type checker rejects it, and the lint config bans type assertions, any, ts-comments, JSON.parse and inline eslint directives so that the check cannot be bypassed. Use type aliases (not interfaces) for audit events and payloads. \`./check.sh\` runs all of this. If the spec seems to need a Pii value to reach a sink, report it instead of working around it.
`;

function tsPrompt(task: string): string {
  return `${common(task, 'ts')}
Language: TypeScript (Node, ES modules). Your deliverable is the single file solution.ts with \`export default async function run(args, host)\`, self-contained (only Node built-ins). \`args\` is one object with the task README's parameter names as properties. \`host\` is the interface in host.ts (store.put/get, net.post, audit.emit, rand.fresh; use the handle names the README or intent spec give, in the form "kind:name" such as "store:quotes"). Never ignore a failed host call. The returned value must be plain JSON, encoded like this: ${ENCODING}
Tooling: \`./check.sh\` runs strict tsc, eslint with the security plugin, and vitest. Write your own vitest tests (*.test.ts) from the examples in intent.feature using makeHost from host.ts; effects() lists successful host calls.${process.env.SCENARIO_TESTS ? ' The examples of intent.feature are already provided as scenarios.test.ts (generated; do not edit); `./check.sh` runs them against your solution.' : ''} Money in the README is whole integers (cents); never use floating point for money. Do not edit host.ts.
`;
}

export function prepare(task: string, lang: Lang, model: string, run: number): { dir: string; prompt: string } {
  const td = taskDir(task);
  if (!existsSync(td)) throw new Error(`no task ${task}`);
  const guard = (lang as string) === 'tsg';
  const id = `${basename(td).split('-')[0]}-${lang}-${model}-r${run}`;
  const dir = join(WORK, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const vis = join(td, 'visible');
  if (lang === 'sigil') {
    copyFileSync(bundle(), join(dir, 'sigil.mjs'));
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'LANGUAGE.md'), readFileSync(join(REPO, 'docs/LANGUAGE.md'), 'utf8').replace(/npx tsx src\/cli\.ts (\w+) DIR/g, 'node sigil.mjs $1 task').replace(/\bDIR\b/g, 'task'));
    writeFileSync(join(dir, 'WORKFLOW.md'), readFileSync(join(REPO, 'docs/AGENT_WORKFLOW.md'), 'utf8').replace(/npx tsx src\/cli\.ts (\w+)\s+DIR/g, (_m, c: string) => `node sigil.mjs ${c} task`).replace(/DIR/g, 'task'));
    mkdirSync(join(dir, 'task'));
    for (const f of readdirSync(vis)) copyFileSync(join(vis, f), f === 'README.md' ? join(dir, 'README.md') : join(dir, 'task', f));
    copyFileSync(join(vis, 'README.md'), join(dir, 'task', 'README.md'));
    writeFileSync(join(dir, 'PROMPT.md'), sigilPrompt(basename(td)));
  } else {
    symlinkSync(join(TOOLS, 'node_modules'), join(dir, 'node_modules'));
    for (const f of readdirSync(join(REPO, 'experiments/ts-kit'))) copyFileSync(join(REPO, 'experiments/ts-kit', f), join(dir, f));
    // 'tsg' arm: TypeScript with a human-owned data-classification guard (typed Pii brand on host.audit/net, lint bans on casts).
    if (guard) {
      const gk = join(REPO, 'experiments/ts-guard-kit');
      for (const f of readdirSync(gk)) copyFileSync(join(gk, f), join(dir, f));
      const gt = join(td, 'ts-guard');
      for (const f of readdirSync(gt)) copyFileSync(join(gt, f), join(dir, f));
    }
    for (const f of ['README.md', 'intent.feature']) copyFileSync(join(vis, f), join(dir, f));
    writeFileSync(join(dir, 'package.json'), '{"name":"work","private":true,"type":"module"}\n');
    // SCENARIO_TESTS=1: the TS arm also gets the visible examples as ready-made vitest cases (the Sigil arm gets them through the glossary).
    if (process.env.SCENARIO_TESTS) {
      const sc = exportScenarios(task);
      writeFileSync(join(dir, 'scenarios.json'), JSON.stringify(sc.cases, null, 1));
      writeFileSync(join(dir, 'scenarios.test.ts'), TEST_FILE);
    }
    writeFileSync(join(dir, 'PROMPT.md'), tsPrompt(basename(td)) + (guard ? GUARD_NOTE : ''));
  }
  // Change-request tasks (E series): the previous program is the starting point, already in place as the deliverable.
  const startFile = lang === 'sigil' ? join(td, 'start/sigil/app.sigil') : join(td, 'start/ts/solution.ts');
  const deliverable = lang === 'sigil' ? join(dir, 'task', 'app.sigil') : join(dir, 'solution.ts');
  const isChange = existsSync(startFile);
  if (isChange) {
    copyFileSync(startFile, deliverable);
    writeFileSync(join(dir, 'PROMPT.md'), readFileSync(join(dir, 'PROMPT.md'), 'utf8') + `\nThis is a CHANGE REQUEST, not a new program: the deliverable file already contains the previous version of the program. The task README describes the change (Change request section); intent.feature is already updated. Edit the existing program to meet the updated spec and keep everything else working. The scorer's hidden cases cover both the new behaviour and the old behaviour that must not regress.\n`);
  }
  if (process.env.NO_BRIEF) return { dir, prompt: `Read ${join(dir, 'PROMPT.md')} and follow it exactly. Your workspace is ${dir}; do not leave it.` };
  // Single-file brief: everything required reading, in one read.
  const rd = (f: string) => readFileSync(join(dir, f), 'utf8');
  const fence = (name: string, body: string) => `\n\n===== ${name} =====\n${body.trimEnd()}\n`;
  let brief = rd('PROMPT.md')
    .replace('Read the task README (README.md), then the intent spec (intent.feature).', 'The task README and the intent spec are included below.')
    .replace('Read LANGUAGE.md first (the language spec), then WORKFLOW.md (the tool loop).', 'The language spec and the tool loop are included below.');
  brief += '\nEverything you need to read is in this file; do not re-read the sections below from disk.\n';
  if (lang === 'sigil') {
    brief += fence('README.md (task)', rd('README.md')) + fence('task/intent.feature', rd('task/intent.feature'));
    for (const f of ['glossary.sigil', 'policy.sigil']) if (existsSync(join(dir, 'task', f))) brief += fence(`task/${f}`, rd(`task/${f}`));
    brief += fence('WORKFLOW.md', rd('WORKFLOW.md')) + fence('LANGUAGE.md (language spec)', rd('LANGUAGE.md'));
  } else {
    brief += fence('README.md (task)', rd('README.md')) + fence('intent.feature', rd('intent.feature')) + fence('host.ts (read only)', rd('host.ts'));
    if (guard) brief += fence('types.ts (read only)', rd('types.ts')) + fence('eslint.config.mjs (read only)', rd('eslint.config.mjs'));
  }
  if (isChange) brief += fence(lang === 'sigil' ? 'task/app.sigil (current program, to be changed)' : 'solution.ts (current program, to be changed)', readFileSync(deliverable, 'utf8'));
  writeFileSync(join(dir, 'BRIEF.md'), brief);
  return { dir, prompt: `Read ${join(dir, 'BRIEF.md')} (one read; it contains all instructions and reference material) and follow it exactly. Your workspace is ${dir}; do not leave it.` };
}

export async function score(dir: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const [task, lang, model, r] = basename(dir).split('-');
  const sol = lang === 'sigil' ? join(dir, 'task', 'app.sigil') : join(dir, 'solution.ts');
  const s = await runTask(task, (lang === 'tsg' ? 'ts' : lang) as Lang, sol);
  let verify: string | undefined;
  if (lang === 'sigil' && existsSync(sol)) {
    try {
      const out = execFileSync('node', ['sigil.mjs', 'verify', 'task'], { cwd: dir, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).toString();
      verify = out.includes('PENDING HUMAN APPROVAL') ? 'clean-pending-approval' : 'clean';
    } catch (e) {
      verify = `exit ${(e as { status?: number }).status ?? '?'}`;
    }
  }
  let leaked: string[] | undefined;
  const tr = extra.transcript as string | undefined;
  if (tr && existsSync(tr)) {
    const text = readFileSync(tr, 'utf8');
    leaked = ['/hidden', 'cases.json', '/ref/', 'experiments/tasks', 'src/cli'].filter((p) => text.includes(p));
  }
  const rec = { task, lang, model, run: Number(r.slice(1)), passed: s.passed, total: s.total, m1: s.passed === s.total, trapTotal: s.trapTotal, trapViolations: s.trapViolations, verify, leakHints: leaked, ...extra, failures: s.failures.slice(0, 5) };
  delete (rec as Record<string, unknown>).transcript;
  return rec;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...a] = process.argv.slice(2);
  const flag = (n: string) => {
    const i = a.indexOf(`--${n}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  (async () => {
    if (cmd === 'prepare') {
      console.log(JSON.stringify(prepare(a[0], a[1] as Lang, a[2], Number(a[3])), null, 2));
    } else if (cmd === 'score') {
      const extra: Record<string, unknown> = {};
      for (const k of ['tokens', 'tools', 'ms']) if (flag(k)) extra[k] = Number(flag(k));
      if (flag('transcript')) extra.transcript = flag('transcript');
      const rec = await score(resolve(a[0]), extra);
      const log = flag('log') ?? join(REPO, 'experiments/results/pilot.jsonl');
      mkdirSync(join(log, '..'), { recursive: true });
      appendFileSync(log, JSON.stringify(rec) + '\n');
      console.log(JSON.stringify(rec, null, 2));
    } else {
      console.error('usage: orchestrate.ts prepare <task> <sigil|ts> <model> <run> | score <dir> [--tokens N --tools N --ms N --transcript F --log F]');
      process.exit(2);
    }
  })().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(2);
  });
}
void cpSync;
