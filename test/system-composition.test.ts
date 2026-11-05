import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { checkSystem, parseSystem } from '../src/system.js';
import { SigilError } from '../src/sexpr.js';

const D = join(__dirname, '..', 'experiments', 'tasks', 'C0-composition');
const load = (dir: string) => readdirSync(join(D, dir)).sort().map((f) => ({ f, src: readFileSync(join(D, dir, f), 'utf8') }));
// The exact set of codes each violating graph produces (v5 also trips the sink check on b, which holds pii after upgrade).
const EXACT: Record<string, string[]> = {
  'v1-pii-to-public-edge.sigil': ['E-chan-label'],
  'v2-sink-below-reachable.sigil': ['E-sink'],
  'v3-declassifier-bypass.sigil': ['E-declass'],
  'v4-stale-spec-hash.sigil': ['E-approval'],
  'v5-ceiling-after-upgrade.sigil': ['E-ceiling', 'E-sink'],
  'v6-undeclared-process.sigil': ['E-chan-undeclared'],
};
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
    it(`rejects ${f} with exactly ${EXACT[f].join(', ')}`, () => {
      const codes = [...new Set(checkSystem(parseSystem(src)).map((d) => d.code))].sort();
      expect(codes).toEqual(EXACT[f]);
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
  const sys = (body: string) => `(system t (approved "p" "s") ${body})`;
  const P = (name: string, extra = '') => `(process ${name} (program "p") (spec "s") ${extra})`;
  const codes = (src: string) => [...new Set(checkSystem(parseSystem(src)).map((d) => d.code))].sort();
  it('rejects an undeclared declassifier on a channel', () => {
    expect(codes(sys(`${P('a', '(reads pii)')} ${P('b', '(in internal)')} (channel a b (carries internal) (via nope))`))).toEqual(['E-declass']);
  });
  it('rejects a sender that holds more than the declassifier may release, even when the host is right', () => {
    expect(codes(sys(`(declassifier d (from internal) (to public) (hosted-in a)) ${P('a', '(reads pii)')} ${P('b')} (channel a b (carries public) (via d))`))).toEqual(['E-declass']);
  });
  it('accepts a declassifier applied to a sender holding less than its from (documented)', () => {
    expect(codes(sys(`(declassifier d (from pii) (to public) (hosted-in a)) ${P('a', '(reads internal)')} ${P('b')} (channel a b (carries public) (via d))`))).toEqual([]);
  });
  it('rejects a declassifier that raises a label', () => {
    expect(codes(sys(`(declassifier d (from public) (to pii) (hosted-in a)) ${P('a')}`))).toEqual(['E-declass']);
  });
  it('input ceiling and sink checks fire independently of each other', () => {
    expect(codes(sys(`${P('a', '(reads internal)')} ${P('b', '(in public)')} (channel a b (carries internal))`))).toEqual(['E-ceiling']);
    expect(codes(sys(`${P('a', '(reads secret) (sink log internal)')}`))).toEqual(['E-sink']);
  });
  it('rejects duplicate declassifiers, duplicate approved entries and duplicate sinks', () => {
    const d = '(declassifier d (from pii) (to internal) (hosted-in a))';
    expect(() => parseSystem(sys(`${d} ${d} ${P('a')}`))).toThrow(/duplicate declassifier d/);
    expect(() => parseSystem(`(system t (approved "p" "s") (approved "p" "s") ${P('a')})`)).toThrow(/duplicate approved entry/);
    expect(() => parseSystem(sys(P('a', '(sink x public) (sink x internal)')))).toThrow(/duplicate sink x/);
  });
  it('sigil system check exits 0 when accepted, 1 when rejected, 2 when malformed or misused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sigil-sys-'));
    const run = (src: string | null, ...extra: string[]) => {
      const f = join(dir, 'system.sigil');
      if (src !== null) writeFileSync(f, src);
      return spawnSync('npx', ['tsx', 'src/cli.ts', 'system', 'check', ...(src === null ? extra : [f])], { encoding: 'utf8' });
    };
    const ok = run(readFileSync(join(D, 'safe', 's1-public-pipeline.sigil'), 'utf8'));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('OK');
    const bad = run(readFileSync(join(D, 'violating', 'v1-pii-to-public-edge.sigil'), 'utf8'));
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('REJECTED');
    expect(run('(system')).toHaveProperty('status', 2);
    expect(run(null).status).toBe(2); // no file argument
  }, 60000);
  it('rejects a declassifier hosted in a different process than the sender (inline second bypass case)', () => {
    expect(codes(sys(`(declassifier d (from pii) (to internal) (hosted-in b)) ${P('a', '(reads pii)')} ${P('b', '(in internal)')} (channel a b (carries internal) (via d))`))).toEqual(['E-declass']);
  });
});
