// B4 record import: reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

interface Raw {
  id: number;
  quantity: number;
  unitPrice: number;
  category: number;
  note: string;
}
interface Args {
  records: Raw[];
  imported: number[];
}
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}

const MAX_QUANTITY = 1000;
const MAX_PRICE = 10_000_000;

const REASONS = ['BadId', 'BadQuantity', 'BadPrice', 'UnknownCategory', 'AlreadyImported', 'DuplicateInBatch', 'StoreFailed'] as const;
type Reason = (typeof REASONS)[number];

function rejection(r: Raw, records: Raw[], done: Set<number>): Reason | null {
  if (r.id < 1) return 'BadId';
  if (r.quantity < 1 || r.quantity > MAX_QUANTITY) return 'BadQuantity';
  if (r.unitPrice < 1 || r.unitPrice > MAX_PRICE) return 'BadPrice';
  if (r.category < 0 || r.category > 9) return 'UnknownCategory';
  if (done.has(r.id)) return 'AlreadyImported';
  if (records.filter((x) => x.id === r.id).length > 1) return 'DuplicateInBatch';
  return null;
}

export default async function run({ records, imported }: Args, host: Host) {
  const done = new Set(imported);
  const counts: Record<Reason, number> = {
    BadId: 0,
    BadQuantity: 0,
    BadPrice: 0,
    UnknownCategory: 0,
    AlreadyImported: 0,
    DuplicateInBatch: 0,
    StoreFailed: 0,
  };
  let ok = 0;
  for (const r of records) {
    const why = rejection(r, records, done);
    if (why !== null) {
      counts[why]++;
      continue;
    }
    const clean = {
      id: r.id,
      quantity: r.quantity,
      unitPrice: r.unitPrice,
      category: r.category,
      lineTotal: r.quantity * r.unitPrice,
    };
    const res = await host.store.put('store:records', clean.id, clean);
    if (res.ok) ok++;
    else counts.StoreFailed++;
  }
  await host.audit.emit('audit', { received: records.length, imported: ok, rejected: records.length - ok });
  return {
    imported: ok,
    badId: counts.BadId,
    badQuantity: counts.BadQuantity,
    badPrice: counts.BadPrice,
    unknownCategory: counts.UnknownCategory,
    alreadyImported: counts.AlreadyImported,
    duplicateInBatch: counts.DuplicateInBatch,
    storeFailed: counts.StoreFailed,
  };
}
