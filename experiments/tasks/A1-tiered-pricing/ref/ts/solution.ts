// A1 tiered pricing: reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

type Tier = 'Standard' | 'Silver' | 'Gold';
interface Line {
  sku: string;
  unit: number;
  qty: number;
}
interface Customer {
  id: number;
  name: string;
  email: string;
  tier: Tier;
  credit: number;
}
interface Args {
  id: number;
  cust: Customer;
  lines: Line[];
}
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}

const volumePct = (qty: number) => (qty < 10 ? 0 : qty < 50 ? 5 : qty < 200 ? 10 : 15);
const tierPct = (t: Tier) => (t === 'Gold' ? 10 : t === 'Silver' ? 5 : 0);

export default async function run({ id, cust, lines }: Args, host: Host) {
  const gross = lines.reduce((s, l) => s + l.unit * l.qty, 0);
  if (gross > 5_000_000) {
    await host.audit.emit('audit', { id, cust: cust.id });
    return { err: 'NeedsApproval' };
  }
  const subtotal = lines.reduce((s, l) => s + Math.floor((l.unit * l.qty * (100 - volumePct(l.qty))) / 100), 0);
  const afterTier = Math.floor((subtotal * (100 - tierPct(cust.tier))) / 100);
  const least = Math.floor((gross * 80 + 99) / 100);
  const total = Math.max(afterTier, least);
  const creditUsed = Math.min(cust.credit, total);
  const quote = { id, cust: cust.id, gross, total, creditUsed, due: total - creditUsed };
  const put = await host.store.put('store:quotes', quote.id, quote);
  if (!put.ok) return { err: 'StoreFailed' };
  await host.audit.emit('audit', { id, cust: cust.id, due: quote.due });
  return { ok: quote };
}
