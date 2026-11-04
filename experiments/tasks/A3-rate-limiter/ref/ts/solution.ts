// A3 rate limiter: reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

type Plan = 'Free' | 'Pro' | 'Enterprise';
interface Request {
  key: number;
  plan: Plan;
  cost: number;
  now: number;
}
interface State {
  start: number;
  used: number;
  burst: boolean;
}
interface Args {
  req: Request;
  state: State;
}
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}

const WINDOW_MS = 60_000;
const allowanceOf = (p: Plan) => (p === 'Free' ? 100 : p === 'Pro' ? 1000 : 10000);
const burstOf = (p: Plan) => (p === 'Free' ? 0 : Math.floor(allowanceOf(p) / 10));

export default async function run({ req, state }: Args, host: Host) {
  const fresh = req.now >= state.start + WINDOW_MS;
  const cur: State = fresh ? { start: req.now, used: 0, burst: false } : state;
  const allow = allowanceOf(req.plan);
  if (req.cost > allow) {
    await host.audit.emit('audit', { plan: req.plan, cost: req.cost, reason: 'TooLarge', retryAfter: 0 });
    return { err: { reason: 'TooLarge', retryAfter: 0 } };
  }
  const total = cur.used + req.cost;
  if (total <= allow) {
    await host.store.put('store:limits', 0, { start: cur.start, used: total, burst: cur.burst });
    const remaining = allow - total;
    await host.audit.emit('audit', { plan: req.plan, cost: req.cost, remaining, burst: false });
    return { ok: { remaining, burst: false } };
  }
  if (!cur.burst && burstOf(req.plan) > 0 && total <= allow + burstOf(req.plan)) {
    await host.store.put('store:limits', 0, { start: cur.start, used: total, burst: true });
    await host.audit.emit('audit', { plan: req.plan, cost: req.cost, remaining: 0, burst: true });
    return { ok: { remaining: 0, burst: true } };
  }
  const retryAfter = Math.max(1, Math.ceil((cur.start + WINDOW_MS - req.now) / 1000));
  await host.audit.emit('audit', { plan: req.plan, cost: req.cost, reason: 'Denied', retryAfter });
  return { err: { reason: 'Denied', retryAfter } };
}
