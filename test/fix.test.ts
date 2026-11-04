import { describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import { parsePolicy, parseProgram } from '../src/parse.js';

const POLICY = '(policy)';
const TYPES = `
(type Cents (Int 0 1000000000000000))
(type Qty (Int 0 1000))
`;
const run = (app: string) => check(parseProgram(app), parsePolicy(POLICY));
const open = (app: string, fn: string) => run(app).evidence.get(fn)!.obligations.filter((o) => o.status !== 'proved');

/** Apply the first available fix for `fn` to the source text and return the new source. */
function applyFirst(app: string, fn: string): string {
  const o = open(app, fn).find((x) => x.fix);
  if (!o?.fix) throw new Error(`no fix for ${fn}`);
  // The printed expression can be short (a bare variable), so edit only inside the named function, as an agent would.
  const start = app.indexOf(`(fn ${fn} `);
  const at = app.indexOf(o.fix.old, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(at).toBeGreaterThan(start);
  return app.slice(0, at) + o.fix.new + app.slice(at + o.fix.old.length);
}

/** Keep applying fixes until nothing is open (a function can need several, in order). */
function fixAll(app: string, fn: string): string {
  for (let i = 0; i < 5 && open(app, fn).some((o) => o.fix); i++) app = applyFirst(app, fn);
  return app;
}

describe('sigil fix: every suggested edit makes its obligation provable', () => {
  const cases: [string, string, string][] = [
    ['subtraction below zero', 'gap', `${TYPES}(fn gap (in (a Cents) (b Cents)) (out Cents) (sub a b))`],
    ['sum above the type', 'tot', `${TYPES}(fn tot (in (a Cents) (b Cents)) (out Cents) (add a b))`],
    ['a divisor that may be zero (and the result bound after it)', 'avg', `${TYPES}(fn avg (in (t Cents) (n Qty)) (out Cents) (div-floor t n))`],
    ['an unclamped fold step', 'sumup', `${TYPES}(fn sumup (in (xs (List Qty 0 50))) (out Cents) (fold xs Cents 0 (fn (acc x) (add acc x))))`],
    ['a list that may exceed its bound', 'cap', `${TYPES}(fn cap (in (xs (List Qty 0 80))) (out (List Qty 0 50)) (filter xs (fn (x) (> x 0))))`],
    ['a record field', 'mk', `${TYPES}(type R (rec (v Qty)))\n(fn mk (in (a Qty) (b Qty)) (out R) (R (add a b)))`],
    ['an argument to another function', 'outer', `${TYPES}(fn inner (in (q Qty)) (out Qty) q)\n(fn outer (in (a Qty) (b Qty)) (out Qty) (inner (add a b)))`],
  ];
  for (const [name, fn, app] of cases) {
    it(name, () => {
      expect(open(app, fn).length).toBeGreaterThan(0);
      const fixed = fixAll(app, fn);
      expect(open(fixed, fn)).toEqual([]);
    });
  }

  it('does not suggest a clamp for a value that is always out of range (that is a logic error)', () => {
    const app = `${TYPES}(fn bad (in (a Qty)) (out Qty) (add a 5000))`;
    const o = open(app, 'bad')[0];
    expect(o.status).toBe('failed');
    expect(o.fix).toBeUndefined();
  });

  it('a clamp wraps only the tail of a let body, not the bindings', () => {
    const app = `${TYPES}(fn f (in (a Cents) (b Cents)) (out Cents) (let [d (sub a b)] d))`;
    const fixed = applyFirst(app, 'f');
    expect(fixed).toContain('(max 0 d)');
  });
});
