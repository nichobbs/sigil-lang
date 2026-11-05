import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSystem, parseSystem } from '../src/system.js';
import { SigilError } from '../src/sexpr.js';

const D = join(__dirname, '..', 'experiments', 'tasks', 'C0-composition');
const load = (dir: string) => readdirSync(join(D, dir)).sort().map((f) => ({ f, src: readFileSync(join(D, dir, f), 'utf8') }));
const EXPECT: Record<string, string> = {
  'v1-pii-to-public-edge.sigil': 'E-chan-label',
  'v2-sink-below-reachable.sigil': 'E-sink',
  'v3-declassifier-bypass.sigil': 'E-declass',
  'v4-stale-spec-hash.sigil': 'E-approval',
  'v5-ceiling-after-upgrade.sigil': 'E-ceiling',
  'v6-undeclared-process.sigil': 'E-chan-undeclared',
};

describe('C0: composition check on seeded graphs', () => {
  it('has six safe and six violating graphs', () => {
    expect(load('safe')).toHaveLength(6);
    expect(load('violating')).toHaveLength(6);
  });
  for (const { f, src } of load('safe')) it(`accepts ${f}`, () => expect(checkSystem(parseSystem(src))).toEqual([]));
  for (const { f, src } of load('violating'))
    it(`rejects ${f} with ${EXPECT[f]}`, () => {
      const codes = checkSystem(parseSystem(src)).map((d) => d.code);
      expect(codes).toContain(EXPECT[f]);
    });
  it('is conservative: a process that holds pii cannot send a lower-labelled channel without a declassifier', () => {
    const src = `(system t (approved "p" "s") (process a (program "p") (spec "s") (reads pii)) (process b (program "p") (spec "s") (in internal)) (channel a b (carries internal)))`;
    expect(checkSystem(parseSystem(src)).map((d) => d.code)).toEqual(['E-chan-label']);
  });
  it('a declassifier must be hosted in the sending process and release no lower than its output label', () => {
    const base = (extra: string) => `(system t (approved "p" "s") (declassifier d (from pii) (to internal) (hosted-in b)) (process a (program "p") (spec "s") (reads pii)) (process b (program "p") (spec "s") (in internal)) ${extra})`;
    expect(checkSystem(parseSystem(base('(channel a b (carries internal) (via d))'))).some((d) => /hosted in b, not in a/.test(d.msg))).toBe(true);
    const low = `(system t (approved "p" "s") (declassifier d (from pii) (to internal) (hosted-in a)) (process a (program "p") (spec "s") (reads pii)) (process b (program "p") (spec "s")) (channel a b (carries public) (via d)))`;
    expect(checkSystem(parseSystem(low)).some((d) => /below d's output label/.test(d.msg))).toBe(true);
  });
  it('rejects malformed input', () => {
    for (const bad of ['(system)', '(system t (process a (program "p")))', '(system t (channel a b))', '(system t (nope))', '(system t (process a (program "p") (spec "s") (reads topsecret)))', '(system t (process a (program "p") (spec "s")) (process a (program "p") (spec "s")))'])
      expect(() => parseSystem(bad)).toThrow(SigilError);
  });
});
