// The single scoring function used by both runners. A runner only has to turn a case into an Outcome.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Effects, HostConfig } from './host.js';
import { Json, firstDiff, show } from './json.js';

export interface Case {
  name: string;
  trap?: boolean;
  args: Record<string, Json>;
  host?: HostConfig;
  expect: { result: Json; effects?: Partial<Effects>; forbid?: string[] };
}
export interface CaseFile {
  entry: string;
  cases: Case[];
}
export type Outcome = { result: Json; effects: Effects } | { error: string };

export interface Failure {
  name: string;
  trap: boolean;
  reason: string;
}
export interface Score {
  total: number;
  passed: number;
  trapTotal: number;
  trapViolations: number;
  failures: Failure[];
}

export function loadCases(hiddenDir: string): CaseFile {
  const file = join(hiddenDir, 'cases.json');
  const cf = JSON.parse(readFileSync(file, 'utf8')) as CaseFile;
  if (typeof cf.entry !== 'string' || !Array.isArray(cf.cases) || cf.cases.length === 0) throw new Error(`${file}: expected {entry, cases:[...]}`);
  const seen = new Set<string>();
  for (const c of cf.cases) {
    if (!c.name || seen.has(c.name)) throw new Error(`${file}: missing or duplicate case name ${JSON.stringify(c.name)}`);
    seen.add(c.name);
    if (!c.args || !c.expect || !('result' in c.expect)) throw new Error(`${file}: case ${c.name} needs args and expect.result`);
  }
  return cf;
}

/** Compare one outcome to one case's expectation. Returns a failure reason, or null if it passes. */
export function judge(c: Case, o: Outcome): string | null {
  if ('error' in o) return o.error;
  const rd = firstDiff(o.result, c.expect.result);
  if (rd) return `result differs at ${rd}: expected ${show(c.expect.result)}, got ${show(o.result)}`;
  for (const k of ['stored', 'sent', 'emitted'] as const) {
    const want = (c.expect.effects?.[k] ?? []) as Json[];
    const d = firstDiff(o.effects[k], want);
    if (d) return `${k} differs at ${d}: expected ${show(want)}, got ${show(o.effects[k])}`;
  }
  const blob = JSON.stringify(o.effects);
  for (const s of c.expect.forbid ?? []) {
    if (blob.includes(JSON.stringify(s).slice(1, -1))) return `forbidden value ${show(s)} reached an effect: ${show(o.effects)}`;
  }
  return null;
}

export async function score(cf: CaseFile, exec: (c: Case) => Promise<Outcome>): Promise<Score> {
  const failures: Failure[] = [];
  for (const c of cf.cases) {
    let reason: string | null;
    try {
      reason = judge(c, await exec(c));
    } catch (e) {
      reason = `harness-isolated error: ${(e as Error).message}`;
    }
    if (reason !== null) failures.push({ name: c.name, trap: !!c.trap, reason: reason.slice(0, 600) });
  }
  const traps = cf.cases.filter((c) => c.trap).length;
  return {
    total: cf.cases.length,
    passed: cf.cases.length - failures.length,
    trapTotal: traps,
    trapViolations: failures.filter((f) => f.trap).length,
    failures,
  };
}

/** A solution that cannot be loaded at all fails every case with the same reason. */
export function allFail(cf: CaseFile, reason: string): Score {
  return {
    total: cf.cases.length,
    passed: 0,
    trapTotal: cf.cases.filter((c) => c.trap).length,
    trapViolations: cf.cases.filter((c) => c.trap).length,
    failures: cf.cases.map((c) => ({ name: c.name, trap: !!c.trap, reason })),
  };
}
