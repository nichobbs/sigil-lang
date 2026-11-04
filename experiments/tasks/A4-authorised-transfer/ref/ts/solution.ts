// A4 authorised transfer: reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

type Role = 'Customer' | 'Teller' | 'Admin';
interface Actor {
  id: number;
  role: Role;
}
interface Account {
  id: number;
  owner: number;
  balance: number;
}
interface Args {
  actor: Actor;
  src: Account;
  dst: Account;
  amount: number;
  approved: boolean;
}
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}

const APPROVAL_LIMIT = 1_000_000;

function mayDebit(actor: Actor, src: Account): boolean {
  return actor.role !== 'Customer' || actor.id === src.owner;
}

function refusal({ actor, src, dst, amount, approved }: Args): string | null {
  if (!mayDebit(actor, src)) return 'NotAllowed';
  if (src.id === dst.id) return 'SameAccount';
  if (amount < 1) return 'BadAmount';
  if (amount > APPROVAL_LIMIT && !(actor.role === 'Admin' && approved)) return 'NeedsApproval';
  if (amount > src.balance) return 'Insufficient';
  return null;
}

export default async function run(args: Args, host: Host) {
  const { actor, src, dst, amount } = args;
  const reason = refusal(args);
  if (reason !== null) {
    await host.audit.emit('audit', { actor: actor.id, src: src.id, dst: dst.id, amount, reason });
    return { err: reason };
  }
  const srcBalance = src.balance - amount;
  const dstBalance = dst.balance + amount;
  const a = await host.store.put('store:accounts', src.id, { id: src.id, owner: src.owner, balance: srcBalance });
  if (!a.ok) return { err: 'StoreFailed' };
  const b = await host.store.put('store:accounts', dst.id, { id: dst.id, owner: dst.owner, balance: dstBalance });
  if (!b.ok) return { err: 'StoreFailed' };
  await host.audit.emit('audit', { actor: actor.id, src: src.id, dst: dst.id, amount });
  return { ok: { src: src.id, dst: dst.id, amount, srcBalance, dstBalance } };
}
