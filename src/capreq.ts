// Capability tokens for requests between processes (docs/EXPERIMENT.md, Extension 4, C3).
//
// A token is minted by the process that owns an object, for one (actor, object), and handed to that actor by the host.
// It is single-use, bound to (actor, object, issuer) and not forwardable: it is only valid when presented by the actor it
// was minted for, so copying the string to another process (or into a message) does nothing.
// The store is host state. Processes only ever hold token strings; they cannot mint, read or alter the table.

import { randomBytes } from 'node:crypto';

export type Presentation = { ok: true } | { ok: false; reason: 'unknown' | 'spent' | 'wrong-actor' | 'wrong-object' | 'wrong-issuer' };

interface Rec { issuer: string; actor: string; object: string; spent: boolean }

export class CapStore {
  private recs = new Map<string, Rec>();
  /** owners: object -> the one process allowed to issue tokens for it. */
  constructor(private owners: Map<string, string>) {}

  mint(issuer: string, actor: string, object: string): string {
    if (this.owners.get(object) !== issuer) throw new Error(`${issuer} does not own ${object} and cannot mint tokens for it`);
    const token = randomBytes(16).toString('hex');
    this.recs.set(token, { issuer, actor, object, spent: false });
    return token;
  }

  /** Check and spend in one step (no await between them, so concurrent presentations cannot both succeed). A failed presentation spends nothing. */
  present(token: string, actor: string, object: string): Presentation {
    const r = this.recs.get(token);
    if (!r) return { ok: false, reason: 'unknown' };
    if (r.spent) return { ok: false, reason: 'spent' };
    if (r.actor !== actor) return { ok: false, reason: 'wrong-actor' };
    if (r.object !== object) return { ok: false, reason: 'wrong-object' };
    if (this.owners.get(object) !== r.issuer) return { ok: false, reason: 'wrong-issuer' };
    r.spent = true;
    return { ok: true };
  }
}
