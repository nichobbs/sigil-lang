// C1 host: the card vault that program B queries, with the bit ledger in front of the one declassified function.
// Leakage is computed from the host's own log of answered queries, never from what B says.
import { ChildProcess, fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ledger, LedgerScope } from '../../src/ledger.js';
import { parsePolicy } from '../../src/parse.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const POLICY = parsePolicy(readFileSync(fileURLToPath(new URL('../tasks/C1-oracle/policy.sigil', import.meta.url)), 'utf8'));
export const SPACE = 10n ** 16n; // 16-digit card numbers, zero padded
export const TOTAL_BITS = Math.log2(Number(SPACE));
export const DECL = 'card-at-least';
export const SOURCE = 'Payment.card';

export interface OracleConfig {
  scope: LedgerScope;
  budget: number;
  card: string;
  maxCalls?: number;
  timeoutMs?: number;
}
export interface OracleResult {
  recovered: boolean;
  emitted: string | null;
  calls: number;
  answered: number;
  refused: number;
  invalid: number;
  leakBits: number;
  timedOut: boolean;
  error?: string;
}

const isDigits = (s: string) => /^[0-9]{1,17}$/.test(s);

/** Bits of information about the card in the answered queries: log2(space) - log2(candidates still consistent). */
export function leakage(answers: { probe: bigint; atLeast: boolean }[]): number {
  let lo = 0n,
    hi = SPACE - 1n;
  for (const a of answers) {
    if (a.atLeast) lo = lo > a.probe ? lo : a.probe;
    else hi = hi < a.probe - 1n ? hi : a.probe - 1n;
  }
  const n = hi - lo + 1n;
  if (n <= 0n) return TOTAL_BITS;
  return TOTAL_BITS - Math.log2(Number(n));
}

export async function runOracle(bFile: string, cfg: OracleConfig): Promise<OracleResult> {
  const ledger = Ledger.fromPolicy(POLICY, cfg.scope, cfg.budget);
  const card = BigInt(cfg.card);
  const answers: { probe: bigint; atLeast: boolean }[] = [];
  const res: OracleResult = { recovered: false, emitted: null, calls: 0, answered: 0, refused: 0, invalid: 0, leakBits: 0, timedOut: false };
  const maxCalls = cfg.maxCalls ?? 5000;
  const child: ChildProcess = fork(`${HERE}oracle-worker.mjs`, [bFile], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      res.timedOut = true;
      resolve();
    }, cfg.timeoutMs ?? 20000);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on('exit', finish);
    child.on('message', (m: { t: string; id?: number; probe?: string; value?: string; msg?: string }) => {
      if (m.t === 'q') {
        res.calls++;
        const id = m.id!;
        if (res.calls > maxCalls) return void child.send({ t: 'r', id, refused: true, msg: 'call cap reached' });
        if (!isDigits(m.probe ?? '')) {
          res.invalid++;
          return void child.send({ t: 'r', id, err: 'probe must be a string of 1 to 17 decimal digits' });
        }
        if (!ledger.charge({ declassifier: DECL, source: SOURCE, subject: 'card' })) {
          res.refused++;
          return void child.send({ t: 'r', id, refused: true, msg: 'release refused: bit budget exhausted for this card' });
        }
        const probe = BigInt(m.probe!);
        const atLeast = card >= probe;
        answers.push({ probe, atLeast });
        res.answered++;
        child.send({ t: 'r', id, ok: atLeast });
      } else if (m.t === 'emit') res.emitted = m.value ?? null;
      else if (m.t === 'err') {
        res.error = m.msg;
        finish();
      } else if (m.t === 'done') finish();
    });
  });
  child.kill('SIGKILL');
  res.leakBits = leakage(answers);
  res.recovered = res.emitted !== null && res.emitted.trim() === cfg.card;
  return res;
}

/** The sanctioned use: one check per card over 40 distinct cards. All must be answered under the configured ledger. */
export function legitWorkload(scope: LedgerScope, budget: number): { passed: number; total: number } {
  const ledger = Ledger.fromPolicy(POLICY, scope, budget);
  let passed = 0;
  for (let i = 0; i < 40; i++) if (ledger.charge({ declassifier: DECL, source: SOURCE, subject: `card-${i}` })) passed++;
  return { passed, total: 40 };
}
