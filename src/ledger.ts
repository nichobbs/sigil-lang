// Bit ledger (docs/EXPERIMENT.md, Extension 4): a runtime budget on how many bits declassifiers may release.
// Each released answer is charged the declassifier's declared `max-bits`. Budgets do not refill (identifiers).
//   none               never refuses (only logs)
//   per-declassifier   one budget per (declassifier, subject)
//   per-source-subject one budget per (source field, subject): all declassifiers over the same field share it
// A refused call is not charged. The log records every request, so leakage can be computed afterwards without
// trusting the caller.

import { Policy } from './ast.js';

export type LedgerScope = 'none' | 'per-declassifier' | 'per-source-subject';

export interface LedgerRequest {
  declassifier: string;
  source: string; // the labelled field the data came from, e.g. Payment.card
  subject: string; // whose data, e.g. a card id
}
export interface LedgerEntry extends LedgerRequest {
  bits: number;
  ok: boolean;
}

export class Refused extends Error {
  constructor(public req: LedgerRequest) {
    super(`release refused: budget exhausted for ${req.source} of ${req.subject} (via ${req.declassifier})`);
    this.name = 'Refused';
  }
}

export class Ledger {
  readonly log: LedgerEntry[] = [];
  private spent = new Map<string, number>();
  constructor(
    readonly scope: LedgerScope,
    readonly budgetBits: number,
    private bitsOf: (declassifier: string) => number,
  ) {}

  static fromPolicy(policy: Policy, scope: LedgerScope, budgetBits: number): Ledger {
    return new Ledger(scope, budgetBits, (name) => {
      const d = policy.declassifiers.get(name);
      if (!d) throw new Error(`unknown declassifier ${name}`);
      if (d.maxBits === undefined) throw new Error(`declassifier ${name} has no max-bits, so its release cannot be charged`);
      return d.maxBits;
    });
  }

  private key(r: LedgerRequest): string {
    return this.scope === 'per-declassifier' ? `${r.declassifier}|${r.subject}` : `${r.source}|${r.subject}`;
  }

  /** Returns true and charges if the release is allowed; false (no charge) if it would exceed the budget. */
  charge(r: LedgerRequest): boolean {
    const bits = this.bitsOf(r.declassifier);
    if (this.scope === 'none') {
      this.log.push({ ...r, bits, ok: true });
      return true;
    }
    const k = this.key(r);
    const used = this.spent.get(k) ?? 0;
    const ok = used + bits <= this.budgetBits;
    if (ok) this.spent.set(k, used + bits);
    this.log.push({ ...r, bits, ok });
    return ok;
  }

  /** Throws Refused instead of returning false. */
  require(r: LedgerRequest): void {
    if (!this.charge(r)) throw new Refused(r);
  }

  used(r: LedgerRequest): number {
    return this.spent.get(this.key(r)) ?? 0;
  }
}
