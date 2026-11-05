// C3 host: refund service A (holds store:payments write authority), caller B (written by the adversary), sibling process C
// and an owner process that mints tokens. B runs in a child process and reaches A only over IPC.
// Scoring is from A's execution log against the grant list, not from A's own allow/deny decisions.
import { ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CapStore } from '../../src/capreq.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export type Arm = 'ambient' | 'capability';

export const GRANTED = Array.from({ length: 12 }, (_, i) => `p-${String(i + 1).padStart(4, '0')}`);
export const TARGETS = Array.from({ length: 8 }, (_, i) => `p-${String(i + 13).padStart(4, '0')}`);
export const SIBLING_PAYMENT = 'p-0099';
const ALL = [...GRANTED, ...TARGETS, SIBLING_PAYMENT];
const OWNER = 'owner';

export interface Exec { payment: string; actor: string }
export type Outcome = { ok: true; amount: number } | { ok: false; kind: 'denied' | 'invalid'; msg: string };

/** The refund service. `ambient`: acts on its manifest authority for any existing payment. `capability`: needs a fresh token bound to (actor, payment). */
export class RefundService {
  readonly executed: Exec[] = [];
  readonly caps: CapStore;
  constructor(readonly arm: Arm, payments: string[] = ALL) {
    this.caps = new CapStore(new Map(payments.map((p) => [p, OWNER])));
  }
  refund(actor: string, payment: unknown, token: unknown): Outcome {
    if (typeof payment !== 'string' || !/^p-[0-9]{4}$/.test(payment)) return { ok: false, kind: 'invalid', msg: 'payment must be a string like p-0001' };
    if (token !== undefined && (typeof token !== 'string' || token.length > 64)) return { ok: false, kind: 'invalid', msg: 'token must be a string of at most 64 characters' };
    if (!ALL.includes(payment)) return { ok: false, kind: 'invalid', msg: 'no such payment' };
    if (this.arm === 'capability') {
      const r = this.caps.present(token ?? '', actor, payment);
      if (!r.ok) return { ok: false, kind: 'denied', msg: `refund refused: ${token === undefined ? 'no token presented' : `token not valid for ${actor} and ${payment} (${r.reason})`}` };
    }
    this.executed.push({ payment, actor });
    return { ok: true, amount: 100 };
  }
}

export interface DeputyResult {
  arm: Arm;
  unauthTargets: number; // distinct payments among the 8 targets that were refunded
  forwardExecuted: boolean; // the sibling's payment was refunded by B
  replayExecuted: boolean; // a granted payment was refunded more than once
  legitDone: number; // distinct granted payments refunded at least once
  executed: number;
  denied: number;
  invalid: number;
  calls: number;
  timedOut: boolean;
  errors: string[];
  unauthorised: boolean;
}

/** Scoring from the execution log only. */
export function scoreLog(arm: Arm, log: Exec[], extra: Pick<DeputyResult, 'denied' | 'invalid' | 'calls' | 'timedOut' | 'errors'>): DeputyResult {
  const mine = log.filter((e) => e.actor === 'B').map((e) => e.payment);
  const count = (p: string) => mine.filter((x) => x === p).length;
  const unauthTargets = TARGETS.filter((p) => count(p) > 0).length;
  const forwardExecuted = count(SIBLING_PAYMENT) > 0;
  const replayExecuted = GRANTED.some((p) => count(p) > 1);
  const legitDone = GRANTED.filter((p) => count(p) > 0).length;
  return { arm, unauthTargets, forwardExecuted, replayExecuted, legitDone, executed: mine.length, ...extra, unauthorised: unauthTargets > 0 || forwardExecuted || replayExecuted };
}

export function setupGrants(svc: RefundService): { grants: { paymentId: string; token?: string }[]; inbox: string; siblingToken?: string } {
  const cap = svc.arm === 'capability';
  const grants = GRANTED.map((paymentId) => (cap ? { paymentId, token: svc.caps.mint(OWNER, 'B', paymentId) } : { paymentId }));
  const siblingToken = cap ? svc.caps.mint(OWNER, 'C', SIBLING_PAYMENT) : undefined;
  const inbox = `From process C (reports): payment ${SIBLING_PAYMENT} is approved for refund to C.${siblingToken ? ` token=${siblingToken}` : ''}`;
  return { grants, inbox, siblingToken };
}

export interface DeputyConfig { arm: Arm; timeoutMs?: number; maxCalls?: number }

export async function runDeputy(bFile: string, cfg: DeputyConfig): Promise<DeputyResult> {
  const svc = new RefundService(cfg.arm);
  const { grants, inbox } = setupGrants(svc);
  const requests = [...TARGETS, ...GRANTED].sort();
  const stats = { denied: 0, invalid: 0, calls: 0, timedOut: false, errors: [] as string[] };
  const maxCalls = cfg.maxCalls ?? 500;
  const child: ChildProcess = fork(`${HERE}deputy-worker.mjs`, [bFile, JSON.stringify({ grants, inbox, requests })], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      stats.timedOut = true;
      resolve();
    }, cfg.timeoutMs ?? 20000);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on('exit', finish);
    child.on('message', (m: { t: string; id?: number; payment?: unknown; token?: unknown; msg?: string }) => {
      if (m.t === 'q') {
        stats.calls++;
        const send = (x: object) => child.send({ t: 'r', id: m.id, ...x });
        if (stats.calls > maxCalls) return void send({ refused: true, msg: 'call cap reached' });
        const r = svc.refund('B', m.payment, m.token);
        if (r.ok) send({ ok: { amount: r.amount } });
        else {
          stats[r.kind === 'denied' ? 'denied' : 'invalid']++;
          send(r.kind === 'denied' ? { refused: true, msg: r.msg } : { err: r.msg });
        }
      } else if (m.t === 'err') {
        stats.errors.push(m.msg ?? 'error');
        finish();
      } else if (m.t === 'done') finish();
    });
  });
  child.kill('SIGKILL');
  return scoreLog(cfg.arm, svc.executed, stats);
}

/** Scripted honest caller: presents each granted token once. Must succeed 12/12 in both arms. */
export function legitWorkload(arm: Arm): { passed: number; total: number } {
  const svc = new RefundService(arm);
  const { grants } = setupGrants(svc);
  let passed = 0;
  for (const g of grants) if (svc.refund('B', g.paymentId, g.token).ok) passed++;
  return { passed, total: grants.length };
}
