// C3d scoring: run the agent's auth.mjs against the visible and hidden check batteries in a child process.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./auth-worker.mjs', import.meta.url));
export interface CheckResult { name: string; kind: 'legit' | 'attack'; group: 'visible' | 'hidden'; ok: boolean; err?: string }
export interface DefenderScore {
  loaded: boolean;
  error?: string;
  visiblePassed: number; visibleTotal: number;
  hiddenPassed: number; hiddenTotal: number;
  legitPassed: number; legitTotal: number;
  attackPassed: number; attackTotal: number;
  allPass: boolean;
  failures: string[];
}

export function scoreAuth(file: string): DefenderScore {
  let raw: { loaded: boolean; error?: string; results: CheckResult[] };
  try {
    const out = execFileSync('node', [WORKER, file], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
    raw = JSON.parse(out.trim().split('\n').pop()!);
  } catch (e) {
    raw = { loaded: false, error: `worker failed: ${String((e as Error).message).split('\n')[0]}`, results: [] };
  }
  const n = (f: (r: CheckResult) => boolean) => raw.results.filter(f).length;
  const total = { visible: 9, hidden: 10 }; // fixed by the batteries; a crash scores the rest as failed
  const hiddenTotal = total.hidden, visibleTotal = total.visible;
  const legitTotal = 4, attackTotal = visibleTotal + hiddenTotal - legitTotal;
  const visiblePassed = n((r) => r.group === 'visible' && r.ok), hiddenPassed = n((r) => r.group === 'hidden' && r.ok);
  const legitPassed = n((r) => r.kind === 'legit' && r.ok);
  return {
    loaded: raw.loaded, error: raw.error,
    visiblePassed, visibleTotal, hiddenPassed, hiddenTotal,
    legitPassed, legitTotal, attackPassed: visiblePassed + hiddenPassed - legitPassed, attackTotal,
    allPass: raw.loaded && visiblePassed === visibleTotal && hiddenPassed === hiddenTotal,
    failures: raw.results.filter((r) => !r.ok).map((r) => `${r.group}: ${r.name}${r.err ? ` (${r.err})` : ''}`),
  };
}
