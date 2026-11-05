import { describe, expect, it } from 'vitest';
import { Ledger, Refused } from '../src/ledger.js';
import { parsePolicy } from '../src/parse.js';

const POL = parsePolicy(`(policy (allow audit) (sink audit (accepts internal))
  (declassify a (from pii) (to internal) (reason "r") (max-bits 1))
  (declassify b (from pii) (to internal) (reason "r") (max-bits 1))
  (declassify nobits (from pii) (to internal) (reason "r")))`);
const R = (declassifier: string, subject = 'c1') => ({ declassifier, source: 'Payment.card', subject });

describe('ledger', () => {
  it('none never refuses but logs', () => {
    const l = Ledger.fromPolicy(POL, 'none', 2);
    for (let i = 0; i < 10; i++) expect(l.charge(R('a'))).toBe(true);
    expect(l.log).toHaveLength(10);
  });
  it('per-declassifier: budget per (declassifier, subject), no refill, refusals are not charged', () => {
    const l = Ledger.fromPolicy(POL, 'per-declassifier', 3);
    for (let i = 0; i < 3; i++) expect(l.charge(R('a'))).toBe(true);
    expect(l.charge(R('a'))).toBe(false);
    expect(l.charge(R('a'))).toBe(false);
    expect(l.used(R('a'))).toBe(3);
    expect(l.charge(R('b'))).toBe(true); // another declassifier has its own budget (the C2 hole)
    expect(l.charge(R('a', 'c2'))).toBe(true); // another subject too
    expect(() => {
      for (let i = 0; i < 5; i++) l.require(R('a'));
    }).toThrow(Refused);
  });
  it('per-source-subject: declassifiers over the same field share one budget', () => {
    const l = Ledger.fromPolicy(POL, 'per-source-subject', 3);
    expect(l.charge(R('a'))).toBe(true);
    expect(l.charge(R('b'))).toBe(true);
    expect(l.charge(R('a'))).toBe(true);
    expect(l.charge(R('b'))).toBe(false);
    expect(l.charge({ declassifier: 'a', source: 'Payment.id', subject: 'c1' })).toBe(true); // other field
  });
  it('a declassifier without max-bits cannot be charged', () => {
    const l = Ledger.fromPolicy(POL, 'per-declassifier', 3);
    expect(() => l.charge(R('nobits'))).toThrow(/no max-bits/);
    expect(() => l.charge(R('missing'))).toThrow(/unknown declassifier/);
  });
});
