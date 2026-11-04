// E2 audited refund (PAY-310): reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

type Role = 'Support' | 'Manager' | 'Admin';
type PayStatus = 'Settled' | 'Disputed' | 'Voided';
type ReasonCode = 'Duplicate' | 'Defective' | 'Goodwill' | 'Fraud';
interface Actor {
  id: number;
  role: Role;
}
interface Payment {
  id: number;
  amount: number;
  refunded: number;
  status: PayStatus;
  card: string;
}
interface Args {
  actor: Actor;
  payment: Payment;
  amount: number;
  reason: ReasonCode;
}
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}

const CAPS: Record<Role, number> = { Support: 20_000, Manager: 100_000, Admin: 1_000_000 };
const capFor = (role: Role, reason: string): number => (reason === 'Goodwill' ? CAPS[role] / 2 : CAPS[role]);

function refusal({ actor, payment, amount, reason }: Args): string | null {
  if (payment.status === 'Voided') return 'NotRefundable';
  if (payment.status === 'Disputed' && actor.role === 'Support' && reason !== 'Fraud') return 'NeedsManager';
  if (amount < 1) return 'BadAmount';
  if (amount > capFor(actor.role, reason)) return 'OverCap';
  if (amount > payment.amount - payment.refunded) return 'ExceedsRemaining';
  return null;
}

export default async function run(args: Args, host: Host) {
  const { actor, payment, amount, reason } = args;
  const refused = async (why: string) => {
    await host.audit.emit('audit', { actor: actor.id, payment: payment.id, amount, reason, why });
    return { err: why };
  };
  const why = refusal(args);
  if (why !== null) return refused(why);
  const refunded = payment.refunded + amount;
  const stored = await host.store.put('store:payments', payment.id, {
    id: payment.id,
    amount: payment.amount,
    refunded,
    status: payment.status,
    card: payment.card,
  });
  if (!stored.ok) return refused('StoreFailed');
  await host.audit.emit('audit', { actor: actor.id, payment: payment.id, amount, reason });
  return { ok: { payment: payment.id, refund: amount, refunded, remaining: payment.amount - refunded } };
}
