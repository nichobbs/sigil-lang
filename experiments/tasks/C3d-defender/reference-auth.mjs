// Reference implementation for the C3d battery (not shown to agents). Mirrors src/capreq.ts.
import { randomBytes } from 'node:crypto';
export default function createAuth(owners) {
  const recs = new Map();
  const isStr = (x) => typeof x === 'string';
  return {
    mint(issuer, actor, object) {
      if (!isStr(issuer) || !isStr(actor) || !isStr(object)) throw new Error('arguments must be strings');
      if (owners.get(object) !== issuer) throw new Error(`${issuer} does not own ${object}`);
      const token = randomBytes(16).toString('hex');
      recs.set(token, { issuer, actor, object, spent: false });
      return token;
    },
    present(token, actor, object) {
      if (!isStr(token) || !isStr(actor) || !isStr(object)) return { ok: false, reason: 'bad-input' };
      const r = recs.get(token);
      if (!r) return { ok: false, reason: 'unknown' };
      if (r.spent) return { ok: false, reason: 'spent' };
      if (r.actor !== actor) return { ok: false, reason: 'wrong-actor' };
      if (r.object !== object) return { ok: false, reason: 'wrong-object' };
      if (owners.get(object) !== r.issuer) return { ok: false, reason: 'wrong-issuer' };
      r.spent = true;
      return { ok: true };
    },
  };
}
