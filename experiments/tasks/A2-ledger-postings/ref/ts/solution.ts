// A2 ledger postings: reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

type AcctKind = 'Checking' | 'Savings';
type PostingKind = 'Credit' | 'Debit' | 'Fee';
type PostingError = 'AcctFrozen' | 'Insufficient' | 'OverLimit' | 'StoreFailed';
interface Account {
  id: number;
  kind: AcctKind;
  status: 'Open' | 'Frozen';
  balance: number;
  spent: number;
}
interface Posting {
  kind: PostingKind;
  amount: number;
}
interface Args {
  acct: Account;
  posting: Posting;
}
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}

const MAX = 1_000_000_000_000;
const DAILY_LIMIT = 200_000;
const overdraftLimit = (k: AcctKind) => (k === 'Checking' ? 50_000 : 0);

export default async function run({ acct, posting }: Args, host: Host) {
  const reject = async (why: PostingError) => {
    await host.audit.emit('audit', { acct: acct.id, reason: why });
    return { err: why };
  };
  const { kind, amount } = posting;
  const frozen = acct.status === 'Frozen';
  const overLimit = kind === 'Debit' && acct.spent + amount > DAILY_LIMIT;
  const overdraws = kind !== 'Credit' && acct.balance - amount < -overdraftLimit(acct.kind);
  if (kind !== 'Credit' && frozen) return reject('AcctFrozen');
  if (overLimit) return reject('OverLimit');
  if (overdraws) return reject('Insufficient');

  const balance = kind === 'Credit' ? Math.min(MAX, acct.balance + amount) : acct.balance - amount;
  const spent = kind === 'Debit' ? Math.min(MAX, acct.spent + amount) : acct.spent;
  const updated = { id: acct.id, kind: acct.kind, status: acct.status, balance, spent };
  const put = await host.store.put('store:ledger', updated.id, updated);
  if (!put.ok) return { err: 'StoreFailed' };
  await host.audit.emit('audit', { acct: acct.id, kind, amount, balance });
  return { ok: { acct: acct.id, balance } };
}
