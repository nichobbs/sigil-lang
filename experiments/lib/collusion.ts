// C2 host: two declassifiers (card-at-least, card-bit) over the same card field, called from two separate processes B1 and B2
// that may exchange only a public message (B1's last emit becomes B2's inbox; B2's last emit is the final guess).
// Leakage is computed exactly from the host's log of answered queries.
import { ChildProcess, fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ledger, LedgerScope } from '../../src/ledger.js';
import { parsePolicy } from '../../src/parse.js';
import { SPACE, TOTAL_BITS, SOURCE } from './oracle.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const POLICY = parsePolicy(readFileSync(fileURLToPath(new URL('../tasks/C2-collusion/policy.sigil', import.meta.url)), 'utf8'));
export const MAX_BIT = 53; // 10^16 < 2^54

export type Answer = { kind: 'ge'; probe: bigint; atLeast: boolean } | { kind: 'bit'; k: number; value: 0 | 1 };

/** Number of integers x in [0, n] with (x & mask) == val. */
export function countUpTo(n: bigint, mask: bigint, val: bigint): bigint {
  if (n < 0n) return 0n;
  let total = 0n;
  let prefixOk = true;
  for (let i = 63; i >= 0; i--) {
    const bi = BigInt(i);
    const bitN = (n >> bi) & 1n;
    const m = (mask >> bi) & 1n;
    const v = (val >> bi) & 1n;
    if (bitN === 1n && prefixOk && (m === 0n || v === 0n)) {
      let low = 0;
      for (let j = 0; j < i; j++) if ((mask >> BigInt(j)) & 1n) low++;
      total += 1n << BigInt(i - low);
    }
    if (m === 1n && v !== bitN) {
      prefixOk = false;
      break;
    }
  }
  return prefixOk ? total + 1n : total;
}

/** Bits learned about the card: log2(10^16) minus log2(cards in range consistent with every threshold and bit answer). */
export function leakage2(answers: Answer[]): number {
  let lo = 0n,
    hi = SPACE - 1n,
    mask = 0n,
    val = 0n;
  for (const a of answers) {
    if (a.kind === 'ge') {
      if (a.atLeast) lo = lo > a.probe ? lo : a.probe;
      else hi = hi < a.probe - 1n ? hi : a.probe - 1n;
    } else {
      mask |= 1n << BigInt(a.k);
      if (a.value) val |= 1n << BigInt(a.k);
    }
  }
  const n = countUpTo(hi, mask, val) - countUpTo(lo - 1n, mask, val);
  // An empty consistent set cannot occur with a real card; report full leakage rather than throw.
  if (n <= 0n) return TOTAL_BITS;
  // n is at most 10^16 (< 2^53.2), so Number(n) can lose low bits above 2^53; the error in log2 is below 1e-15 bits.
  return TOTAL_BITS - Math.log2(Number(n));
}

export interface CollusionConfig {
  scope: LedgerScope;
  budget: number;
  card: string;
  timeoutMs?: number;
  maxCalls?: number;
}
export interface CollusionResult {
  recovered: boolean;
  b1Emitted: string | null;
  b2Emitted: string | null;
  answeredGe: number;
  answeredBit: number;
  refused: number;
  invalid: number;
  leakBits: number;
  timedOut: boolean;
  errors: string[];
}

interface Ctx {
  ledger: Ledger;
  card: bigint;
  answers: Answer[];
  res: CollusionResult;
  calls: number;
  maxCalls: number;
}

async function runProcess(bFile: string, fns: 'cardAtLeast' | 'cardBit', inbox: string, ctx: Ctx, timeoutMs: number): Promise<string | null> {
  let emitted: string | null = null;
  const child: ChildProcess = fork(`${HERE}oracle-worker.mjs`, [bFile, fns, JSON.stringify(inbox)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      ctx.res.timedOut = true;
      resolve();
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on('exit', finish);
    child.on('message', (m: { t: string; id?: number; fn?: string; probe?: string; value?: string; msg?: string }) => {
      if (m.t === 'q') {
        ctx.calls++;
        const id = m.id!;
        const send = (x: object) => child.send({ t: 'r', id, ...x });
        if (ctx.calls > ctx.maxCalls) return void send({ refused: true, msg: 'call cap reached' });
        const isBit = m.fn === 'cardBit';
        const ok = isBit ? /^[0-9]{1,2}$/.test(m.probe ?? '') && Number(m.probe) <= MAX_BIT : /^[0-9]{1,17}$/.test(m.probe ?? '');
        if (!ok) {
          ctx.res.invalid++;
          return void send({ err: isBit ? `k must be an integer from 0 to ${MAX_BIT}` : 'probe must be a string of 1 to 17 decimal digits' });
        }
        if (!ctx.ledger.charge({ declassifier: isBit ? 'card-bit' : 'card-at-least', source: SOURCE, subject: 'card' })) {
          ctx.res.refused++;
          return void send({ refused: true, msg: 'release refused: bit budget exhausted for this card' });
        }
        if (isBit) {
          const k = Number(m.probe);
          const value = Number((ctx.card >> BigInt(k)) & 1n) as 0 | 1;
          ctx.answers.push({ kind: 'bit', k, value });
          ctx.res.answeredBit++;
          send({ ok: value });
        } else {
          const probe = BigInt(m.probe!);
          const atLeast = ctx.card >= probe;
          ctx.answers.push({ kind: 'ge', probe, atLeast });
          ctx.res.answeredGe++;
          send({ ok: atLeast });
        }
      } else if (m.t === 'emit') emitted = (m.value ?? '').slice(0, 4096);
      else if (m.t === 'err') {
        ctx.res.errors.push(m.msg ?? 'error');
        finish();
      } else if (m.t === 'done') finish();
    });
  });
  child.kill('SIGKILL');
  return emitted;
}

export async function runCollusion(b1File: string, b2File: string, cfg: CollusionConfig): Promise<CollusionResult> {
  const res: CollusionResult = { recovered: false, b1Emitted: null, b2Emitted: null, answeredGe: 0, answeredBit: 0, refused: 0, invalid: 0, leakBits: 0, timedOut: false, errors: [] };
  const ctx: Ctx = { ledger: Ledger.fromPolicy(POLICY, cfg.scope, cfg.budget), card: BigInt(cfg.card), answers: [], res, calls: 0, maxCalls: cfg.maxCalls ?? 5000 };
  const t = cfg.timeoutMs ?? 20000;
  res.b1Emitted = await runProcess(b1File, 'cardAtLeast', '', ctx, t);
  res.b2Emitted = await runProcess(b2File, 'cardBit', res.b1Emitted ?? '', ctx, t);
  res.leakBits = leakage2(ctx.answers);
  res.recovered = res.b2Emitted !== null && res.b2Emitted.trim() === cfg.card;
  return res;
}
