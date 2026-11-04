import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseProgram, parsePolicy } from '../src/parse.js';
import { printProgram } from '../src/print/sexp.js';
import { SigilError } from '../src/sexpr.js';

const app = readFileSync(new URL('../examples/invoicing/app.sigil', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../examples/invoicing/policy.sigil', import.meta.url), 'utf8');

describe('parser', () => {
  it('parses the invoicing example', () => {
    const p = parseProgram(app);
    expect([...p.fns.keys()]).toEqual(['gross', 'discount', 'price-invoice', 'receipt', 'issue-invoice']);
    expect(p.entries).toEqual(['issue-invoice']);
    expect(p.targets).toEqual(['server', 'browser']);
    expect(p.binds.get('net:mail')?.caveats.connect).toEqual(['https://mail.acme.com']);
    expect(p.fns.get('issue-invoice')?.needs).toEqual(['store:invoices', 'net:mail', 'audit', 'rand']);
  });

  it('round-trips through the canonical printer', () => {
    const p1 = parseProgram(app);
    const text = printProgram(p1);
    const p2 = parseProgram(text);
    expect(p2.types).toEqual(p1.types);
    expect([...p2.fns.values()]).toEqual([...p1.fns.values()]);
    expect([...p2.validators.values()]).toEqual([...p1.validators.values()]);
    // and printing is a fixed point
    expect(printProgram(p2)).toBe(text);
  });

  it('parses the policy', () => {
    const pol = parsePolicy(policy);
    expect(pol.sinks.get('net:mail')?.accepts).toBe('pii');
    expect(pol.sinks.get('audit')?.accepts).toBe('internal');
    expect(pol.allow.find((a) => a.kind === 'net')?.pattern).toBe('https://mail.acme.com');
  });

  it('reports positioned syntax errors', () => {
    expect(() => parseProgram('(fn f (in) (out Unit) (add 1 2)')).toThrow(/unclosed/);
    expect(() => parseProgram('(fn f (in) (out Unit))')).toThrow(/no body/);
    expect(() => parseProgram('(type X (Int 5 1))')).toThrow(SigilError);
    expect(() => parseProgram('(fn f (in) (out Unit) (let [x] x))')).toThrow(/let/);
  });
});
