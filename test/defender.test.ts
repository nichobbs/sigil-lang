import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scoreAuth } from '../experiments/lib/defender.js';

const REF = join(__dirname, '..', 'experiments', 'tasks', 'C3d-defender', 'reference-auth.mjs');
const ref = readFileSync(REF, 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'defender-'));
const write = (name: string, src: string) => (writeFileSync(join(dir, name), src), join(dir, name));
// Each flawed variant edits the reference once and must fail the named check.
const variant = (name: string, from: string | RegExp, to: string) => {
  const src = ref.replace(from, to);
  expect(src).not.toBe(ref);
  return scoreAuth(write(`${name}.mjs`, src));
};

describe('C3d check batteries', () => {
  it('the reference implementation passes all 9 visible and 10 hidden checks', () => {
    const s = scoreAuth(REF);
    expect(s.failures).toEqual([]);
    expect(s).toMatchObject({ loaded: true, visiblePassed: 9, hiddenPassed: 10, legitPassed: 4, attackPassed: 15, allPass: true });
  });
  it('a missing or non-function module scores zero without crashing the scorer', () => {
    expect(scoreAuth(join(dir, 'nonexistent.mjs')).allPass).toBe(false);
    const s = scoreAuth(write('bad.mjs', 'export default 42;'));
    expect(s).toMatchObject({ loaded: false, allPass: false, visiblePassed: 0 });
  });
  it('a stub that throws scores as not loaded or failing', () => {
    expect(scoreAuth(write('stub.mjs', "export default function () { throw new Error('not implemented'); }")).allPass).toBe(false);
  });

  const flawed: [string, string | RegExp, string, string][] = [
    ['no-spent-flag', 'r.spent = true;', '', 'replaying a spent token'],
    ['burn-on-failure', "if (r.actor !== actor) return { ok: false, reason: 'wrong-actor' };", "if (r.actor !== actor) { r.spent = true; return { ok: false, reason: 'wrong-actor' }; }", 'failed presentation'],
    ['no-actor-check', "if (r.actor !== actor) return { ok: false, reason: 'wrong-actor' };", '', 'another actor'],
    ['no-object-check', "if (r.object !== object) return { ok: false, reason: 'wrong-object' };", '', 'another'],
    ['coerce-token', "if (!isStr(token) || !isStr(actor) || !isStr(object)) return { ok: false, reason: 'bad-input' };", 'token = String(token); actor = String(actor); object = String(object);', 'non-string'],
    ['no-owner-recheck', "if (owners.get(object) !== r.issuer) return { ok: false, reason: 'wrong-issuer' };", '', 'no longer owns'],
    ['counter-tokens', "const token = randomBytes(16).toString('hex');", 'const token = String(1000000000000000000 + recs.size);', 'unpredictable'],
    ['embed-names', "const token = randomBytes(16).toString('hex');", "const token = `${actor}-${object}-${randomBytes(8).toString('hex')}`;", 'unpredictable'],
    ['case-insensitive', 'const r = recs.get(token);', 'const r = recs.get(token.trim().toLowerCase());', 'altered copies'],
    ['anyone-can-mint', "if (owners.get(object) !== issuer) throw new Error(`${issuer} does not own ${object}`);", '', 'only the owner'],
  ];
  for (const [name, from, to, expected] of flawed)
    it(`fails the flawed variant ${name}`, () => {
      const s = variant(name, from, to);
      expect(s.allPass).toBe(false);
      expect(s.failures.join('|').toLowerCase()).toContain(expected.toLowerCase());
    });
  it('a check-then-await-then-spend implementation is caught by the concurrency check', () => {
    const src = ref.replace('r.spent = true;', 'await null; r.spent = true;').replace('present(token, actor, object) {', 'async present(token, actor, object) {');
    expect(scoreAuth(write('race.mjs', src)).failures.join('|')).toMatch(/concurrent/);
  });
  it('the hidden half adds failures the visible half does not see', () => {
    const s = variant('coerce2', "if (!isStr(token) || !isStr(actor) || !isStr(object)) return { ok: false, reason: 'bad-input' };", 'token = String(token); actor = String(actor); object = String(object);');
    expect(s.visiblePassed).toBe(9);
    expect(s.hiddenPassed).toBeLessThan(10);
  });
});
