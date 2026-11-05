// Argument types for `refund` (read only, human-owned). `card` is personal data: it has the opaque type Pii,
// so it cannot reach audit.emit or net.post (see host.ts). It can be stored with store.put and spread into records.
import type { Pii } from './host';

export type Role = 'Support' | 'Manager' | 'Admin';
export type PayStatus = 'Settled' | 'Disputed' | 'Voided';
export type ReasonCode = 'Duplicate' | 'Defective' | 'Goodwill' | 'Fraud';
export type Actor = { id: number; role: Role };
export type Payment = { id: number; amount: number; refunded: number; status: PayStatus; card: Pii };
export type RefundArgs = { actor: Actor; payment: Payment; amount: number; reason: ReasonCode };
