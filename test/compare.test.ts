import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseProgram, parsePolicy } from '../src/parse.js';
import { compareSyntaxes, fragilityExperiment } from '../src/compare.js';
import { arityTable } from '../src/print/common.js';
import { parsePolishExpr, polish } from '../src/print/polish.js';
import { jsonSyntax, parseJsonExpr } from '../src/print/json.js';
import { bigintReplacer } from '../src/print/common.js';
import { check, errors } from '../src/check.js';

const prog = parseProgram(readFileSync('examples/invoicing/app.sigil', 'utf8'));
const pol = parsePolicy(readFileSync('examples/invoicing/policy.sigil', 'utf8'));
const key = (e: unknown) => JSON.stringify(e, bigintReplacer);

describe('syntax comparison', () => {
  it('every printer keeps all atoms of the program', () => {
    for (const r of compareSyntaxes(prog)) expect(r.atomsConserved, r.name).toBe(true);
  });
  it('prefix bodies re-parse to the same text, JSON to the same AST', () => {
    const a = arityTable(prog);
    for (const f of prog.fns.values()) {
      // prefix is positional, so keyword constructors come back positional: compare printed forms
      const text = polish.expr(prog, f.body);
      expect(polish.expr(prog, parsePolishExpr(text, a)), `prefix ${f.name}`).toBe(text);
      expect(key(parseJsonExpr(jsonSyntax.expr(prog, f.body))), `json ${f.name}`).toBe(key(f.body));
    }
  });
  it('fragility experiment accounts for every trial', () => {
    for (const r of fragilityExperiment(prog, pol)) expect(r.parseError + r.checkerError + r.silent + r.same).toBe(r.trials);
  });
  it('checker rejects arithmetic on a list', () => {
    const bad = parseProgram(readFileSync('examples/invoicing/app.sigil', 'utf8').replace('(mul l.unit l.qty)', '(mul ls l.qty)'));
    expect(errors(check(bad, pol)).some((d) => d.code === 'E-type')).toBe(true);
  });
});
