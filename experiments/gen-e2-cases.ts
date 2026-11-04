// Builds E2's hidden cases from B3's: same arguments, expectations recomputed from E2's TypeScript reference, plus new cases for the
// change request (reason-dependent caps, Support on Disputed with Fraud, OverCap before ExceedsRemaining). The Sigil reference is then
// cross-checked with `experiments/run.ts E2-refund-policy-change sigil ...`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { makeHost } from './lib/host.js';

const root = resolve(import.meta.dirname, 'tasks');
const old = JSON.parse(readFileSync(`${root}/B3-audited-refund/hidden/cases.json`, 'utf8'));
const run = (await import(pathToFileURL(`${root}/E2-refund-policy-change/ref/ts/solution.ts`).href)).default;

const P = (amount: number, refunded: number, status: string, card = '4242') => ({ id: 5001, amount, refunded, status, card });
const mk = (name: string, role: string, payment: ReturnType<typeof P>, amount: number, reason: string, extra: { trap?: boolean; fail?: boolean } = {}) => ({
  name,
  ...(extra.trap ? { trap: true } : {}),
  args: { actor: { id: 11, role }, payment, amount, reason },
  host: { seed: 1, ...(extra.fail ? { fail: [{ handle: 'store:payments', op: 'put' }] } : {}) },
});
const BIG = 1_000_000_000_000;
const added = [
  mk('goodwill support exactly the halved cap is allowed', 'Support', P(BIG, 0, 'Settled'), 10000, 'Goodwill'),
  mk('goodwill support one cent over the halved cap is OverCap', 'Support', P(BIG, 0, 'Settled'), 10001, 'Goodwill'),
  mk('goodwill manager exactly the halved cap is allowed', 'Manager', P(BIG, 0, 'Settled'), 50000, 'Goodwill'),
  mk('goodwill manager one cent over the halved cap is OverCap', 'Manager', P(BIG, 0, 'Settled'), 50001, 'Goodwill'),
  mk('goodwill admin exactly the halved cap is allowed', 'Admin', P(BIG, 0, 'Settled'), 500000, 'Goodwill'),
  mk('goodwill admin one cent over the halved cap is OverCap', 'Admin', P(BIG, 0, 'Settled'), 500001, 'Goodwill'),
  mk('defective support keeps the full cap', 'Support', P(BIG, 0, 'Settled'), 20000, 'Defective'),
  mk('duplicate manager keeps the full cap and is over at one more', 'Manager', P(BIG, 0, 'Settled'), 100001, 'Duplicate'),
  mk('fraud admin keeps the full cap', 'Admin', P(BIG, 0, 'Settled'), 1000000, 'Fraud'),
  mk('goodwill cap applies on a disputed payment for a manager', 'Manager', P(BIG, 0, 'Disputed'), 50001, 'Goodwill'),
  mk('support refunds a disputed payment as Fraud', 'Support', P(15000, 0, 'Disputed'), 6000, 'Fraud'),
  mk('support fraud on a disputed payment is still capped', 'Support', P(BIG, 0, 'Disputed'), 20001, 'Fraud'),
  mk('support fraud on a disputed payment exactly the cap', 'Support', P(BIG, 0, 'Disputed'), 20000, 'Fraud'),
  mk('support fraud on a disputed payment of nothing is BadAmount', 'Support', P(15000, 0, 'Disputed'), 0, 'Fraud'),
  mk('support fraud on a disputed payment beyond the remainder is ExceedsRemaining', 'Support', P(15000, 10000, 'Disputed'), 6000, 'Fraud'),
  mk('support disputed Defective is still NeedsManager', 'Support', P(15000, 0, 'Disputed'), 6000, 'Defective'),
  mk('support disputed Duplicate is still NeedsManager', 'Support', P(15000, 0, 'Disputed'), 6000, 'Duplicate'),
  mk('support disputed Goodwill over the cap is NeedsManager first', 'Support', P(15000, 0, 'Disputed'), 12000, 'Goodwill'),
  mk('support fraud on a voided payment is NotRefundable', 'Support', P(15000, 0, 'Voided'), 6000, 'Fraud'),
  mk('manager disputed Fraud is unchanged', 'Manager', P(15000, 0, 'Disputed'), 15000, 'Fraud'),
  mk('over the cap and beyond the remainder reports OverCap', 'Support', P(30000, 5000, 'Settled'), 25001, 'Defective'),
  mk('goodwill over the halved cap and beyond the remainder reports OverCap', 'Support', P(15000, 10000, 'Settled'), 10001, 'Goodwill'),
  mk('within the cap but beyond the remainder reports ExceedsRemaining', 'Support', P(15000, 10000, 'Settled'), 6000, 'Goodwill'),
  mk('admin over the cap on a nearly refunded payment reports OverCap', 'Admin', P(BIG, BIG - 5, 'Settled'), 1000001, 'Duplicate'),
  mk('store failure on a support fraud refund of a disputed payment', 'Support', P(15000, 0, 'Disputed'), 6000, 'Fraud', { fail: true }),
  mk('card digits never reach the audit event of a support fraud refund', 'Support', P(15000, 0, 'Disputed', '0042'), 6000, 'Fraud', { trap: true }),
  mk('card digits never reach the audit event of a goodwill OverCap refusal', 'Support', P(15000, 0, 'Settled', '0042'), 10001, 'Goodwill', { trap: true }),
];
const names = new Set((old.cases as any[]).map((c) => c.name));
const cases = [...old.cases, ...added.filter((c) => !names.has(c.name))];
for (const c of cases) {
  const { host, effects } = makeHost(c.host ?? {});
  const result = await run(JSON.parse(JSON.stringify(c.args)), host);
  const e = effects();
  c.expect = { result, effects: { stored: e.stored, sent: e.sent, emitted: e.emitted }, ...(c.expect?.forbid ? { forbid: c.expect.forbid } : {}) };
}
mkdirSync(`${root}/E2-refund-policy-change/hidden`, { recursive: true });
writeFileSync(`${root}/E2-refund-policy-change/hidden/cases.json`, JSON.stringify({ entry: old.entry, cases }, null, 1) + '\n');
console.log(`${cases.length} cases (${cases.filter((c) => c.trap).length} traps)`);
