// C4 room booking conflicts: reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

type Role = 'Staff' | 'Manager';
type Status = 'Tentative' | 'Confirmed';
interface Booking {
  id: number;
  start: number;
  end: number;
  status: Status;
}
interface Args {
  existing: Booking[];
  id: number;
  start: number;
  end: number;
  buffer: number;
  role: Role;
}
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}

const WEEK = 10080;

const refuse = (reason: string, blocker = 0) => ({ err: { reason, blocker } });

export default async function run({ existing, id, start, end, buffer, role }: Args, host: Host) {
  if (end <= start || end > WEEK) return refuse('BadRange');

  const hits = existing.filter((b) => start < b.end + buffer && b.start < end + buffer);
  const blockers = hits.filter((b) => role === 'Staff' || b.status === 'Confirmed');
  if (blockers.length > 0) return refuse('Conflict', Math.min(...blockers.map((b) => b.id)));

  const displaced = hits.map((b) => b.id);
  const booking = { id, start, end, status: role === 'Manager' ? 'Confirmed' : 'Tentative' };
  const stored = await host.store.put('store:bookings', id, booking);
  if (!stored.ok) return refuse('StoreFailed');
  await host.audit.emit('audit', { role, id, displaced });
  return { ok: { id, displaced } };
}
