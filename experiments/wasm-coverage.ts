#!/usr/bin/env tsx
// Wasm backend coverage over the reference programs (experiments/tasks/*/ref/sigil/app.sigil).
// For each task: parse, check against the task's visible policy, compile, and count how many functions and
// how many `program` entry points compile. Usage: tsx experiments/wasm-coverage.ts [--reasons]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../src/check.js';
import { parsePolicy, parseProgram } from '../src/parse.js';
import { compileProgram } from '../src/wasm/compile.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'tasks');
const showReasons = process.argv.includes('--reasons');

export interface TaskCoverage {
  task: string;
  fns: number;
  fnsCompiled: number;
  entries: number;
  entriesCompiled: number;
  reasons: { fn: string; entry: boolean; reason: string }[];
}

export function coverage(): TaskCoverage[] {
  const out: TaskCoverage[] = [];
  for (const dir of readdirSync(root).sort()) {
    const app = join(root, dir, 'ref', 'sigil', 'app.sigil');
    if (!existsSync(app)) continue; // e.g. C1 has only a GAP.md
    const prog = parseProgram(readFileSync(app, 'utf8'));
    const polFile = join(root, dir, 'visible', 'policy.sigil');
    const pol = parsePolicy(existsSync(polFile) ? readFileSync(polFile, 'utf8') : '(policy)');
    const res = check(prog, pol);
    const cr = compileProgram(prog, res);
    const entries = new Set(prog.entries);
    out.push({
      task: dir.split('-')[0],
      fns: cr.fns.length,
      fnsCompiled: cr.fns.filter((f) => f.compilable).length,
      entries: entries.size,
      entriesCompiled: [...entries].filter((e) => cr.fns.find((f) => f.name === e)?.compilable).length,
      reasons: cr.fns.filter((f) => !f.compilable).map((f) => ({ fn: f.name, entry: entries.has(f.name), reason: f.reason ?? '?' })),
    });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = coverage();
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`${pad('task', 6)} ${pad('functions', 12)} entry points`);
  let f = 0, fc = 0, e = 0, ec = 0;
  for (const r of rows) {
    console.log(`${pad(r.task, 6)} ${pad(`${r.fnsCompiled}/${r.fns}`, 12)} ${r.entriesCompiled}/${r.entries}`);
    f += r.fns; fc += r.fnsCompiled; e += r.entries; ec += r.entriesCompiled;
    if (showReasons) for (const x of r.reasons) console.log(`        ${x.entry ? '[entry] ' : ''}${x.fn}: ${x.reason.slice(0, 150)}`);
  }
  console.log(`${pad('total', 6)} ${pad(`${fc}/${f}`, 12)} ${ec}/${e}`);
}
