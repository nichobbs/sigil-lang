// Syntax comparison: the same AST rendered five ways, measured with a tokenizer proxy,
// plus a fragility experiment (what does a single dropped token do?).
//
// Caveat on tokens: gpt-tokenizer implements OpenAI's BPE vocabularies, not any Claude tokenizer.
// Relative differences between syntaxes are indicative; absolute counts are not.

import { encode as encCl } from 'gpt-tokenizer/encoding/cl100k_base';
import { decode as decO, encode as encO } from 'gpt-tokenizer/encoding/o200k_base';
import { Expr, Policy, Program, countNodes } from './ast.js';
import { check, errors } from './check.js';
import { braces } from './print/braces.js';
import { compact } from './print/compact.js';
import { Syntax, arityTable, bigintReplacer, positionalArgs } from './print/common.js';
import { jsonSyntax, parseJsonExpr } from './print/json.js';
import { PolishError, parsePolishExpr, polish, tokenizePolish } from './print/polish.js';
import { sexpVerbose } from './print/sexp.js';
import { parseExpr } from './parse.js';
import { readAll } from './sexpr.js';

export const SYNTAXES: Syntax[] = [sexpVerbose, compact, polish, braces, jsonSyntax];

export interface Row {
  name: string;
  blurb: string;
  chars: number;
  tokCl: number;
  tokO: number;
  typesO: number;
  validatorsO: number;
  fnsO: number;
  tokPerNode: number;
  punctShare: number; // share of o200k tokens that are pure punctuation/whitespace delimiters
  atomsConserved: boolean;
}

// ---- atom conservation: every identifier/literal in the AST must survive printing ---------------

function lexemes(text: string): Map<string, number> {
  const m = new Map<string, number>();
  // dotted paths (c.email) are split so syntaxes that store name and path separately compare equal
  for (const t of text.match(/"(?:[^"\\]|\\.)*"|[A-Za-z_][\w\-:.]*|\d+/g) ?? []) {
    // JSON quotes identifiers ("sum"), so a quoted token also counts as its bare inner text
    const parts = t.startsWith('"') ? [t, ...(/^"[\w\-:]+"$/.test(t) ? [t.slice(1, -1)] : [])] : t.split('.');
    for (const part of parts) if (part) m.set(part, (m.get(part) ?? 0) + 1);
  }
  return m;
}

function atomsOf(prog: Program, e: Expr, out: Map<string, number>) {
  const add = (s: string) => out.set(s, (out.get(s) ?? 0) + 1);
  const a = arityTable(prog);
  const walk = (x: Expr) => {
    switch (x.k) {
      case 'int':
        add(x.v.toString());
        break;
      case 'str':
        add(JSON.stringify(x.v));
        break;
      case 'bool':
        break;
      case 'var':
        [x.name, ...x.path].forEach(add);
        break;
      case 'call':
        if (prog.fns.has(x.fn) || prog.types.has(x.fn)) add(x.fn);
        positionalArgs(a, x).forEach(walk);
        break;
      case 'let':
        x.binds.forEach((b) => (add(b.name), walk(b.value)));
        x.body.forEach(walk);
        break;
      case 'match':
        walk(x.scrut);
        x.arms.forEach((r) => (add(r.tag), r.bind && add(r.bind), walk(r.body)));
        break;
      case 'if':
        walk(x.cond);
        walk(x.then);
        walk(x.else);
        break;
      case 'lam':
        x.params.forEach(add);
        walk(x.body);
        break;
      case 'do':
        x.body.forEach(walk);
        break;
      case 'try':
        walk(x.expr);
        add(x.onErr);
        break;
    }
  };
  walk(e);
}

function conserved(prog: Program, fnsText: string): boolean {
  const want = new Map<string, number>();
  for (const f of prog.fns.values()) {
    atomsOf(prog, f.body, want);
    f.ensures.forEach((e) => atomsOf(prog, e, want));
  }
  const have = lexemes(fnsText);
  for (const [k, n] of want) if ((have.get(k) ?? 0) < n) return false;
  return true;
}

export function compareSyntaxes(prog: Program): Row[] {
  const nodes = [...prog.fns.values()].reduce((n, f) => n + countNodes(f.body) + f.ensures.reduce((m, e) => m + countNodes(e), 0), 0);
  return SYNTAXES.map((s) => {
    const sec = s.sections(prog);
    const all = [sec.types, sec.validators, sec.fns].join('\n');
    const toks = encO(all);
    const punct = toks.filter((t) => /^[\s()\[\]{};,]+$/.test(decO([t]))).length;
    const fnsO = encO(sec.fns).length;
    return {
      name: s.name,
      blurb: s.blurb,
      chars: all.length,
      tokCl: encCl(all).length,
      tokO: toks.length,
      typesO: encO(sec.types).length,
      validatorsO: encO(sec.validators).length,
      fnsO,
      tokPerNode: fnsO / nodes,
      punctShare: punct / toks.length,
      atomsConserved: conserved(prog, sec.fns),
    };
  });
}

export function formatComparison(rows: Row[]): string {
  const base = rows.find((r) => r.name === 'ts-like')!;
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const lines = [
    '',
    '== Syntax comparison: same AST (types + validators + functions), five surface forms ======',
    `${pad('syntax', 14)} ${pad('chars', 6)} ${pad('cl100k', 7)} ${pad('o200k', 6)} ${pad('vs ts-like', 11)} ${pad('types', 6)} ${pad('valid.', 7)} ${pad('fns', 5)} ${pad('tok/node', 9)} ${pad('delims', 7)} atoms`,
  ];
  for (const r of rows) {
    const rel = `${(((r.tokO - base.tokO) / base.tokO) * 100).toFixed(0)}%`;
    lines.push(
      `${pad(r.name, 14)} ${pad(r.chars, 6)} ${pad(r.tokCl, 7)} ${pad(r.tokO, 6)} ${pad(rel, 11)} ${pad(r.typesO, 6)} ${pad(r.validatorsO, 7)} ${pad(r.fnsO, 5)} ${pad(r.tokPerNode.toFixed(2), 9)} ${pad((r.punctShare * 100).toFixed(0) + '%', 7)} ${r.atomsConserved ? 'ok' : 'LOST'}`,
    );
  }
  lines.push('', 'tokens: OpenAI BPE vocabularies as a proxy (not a Claude tokenizer); compare syntaxes, not absolute numbers.');
  lines.push('tok/node = o200k tokens in the functions section / expression nodes. delims = share of tokens that are pure punctuation.');
  lines.push('atoms = every identifier and literal in the function bodies survives printing (guards against a printer silently dropping content).');
  return lines.join('\n');
}

// ---- fragility: delete each token once, see what the toolchain does ----------------------------

type Outcome = 'parse-error' | 'checker-error' | 'silent-change' | 'same';

interface Codec {
  name: string;
  tokenize(s: string): string[];
  join(t: string[]): string;
  print(e: Expr): string;
  parse(s: string): Expr;
}

function codecs(prog: Program): Codec[] {
  const a = arityTable(prog);
  return [
    {
      name: 'sexp-verbose',
      tokenize: (s) => s.match(/"(?:[^"\\]|\\.)*"|[()\[\]]|[^\s()\[\]"]+/g) ?? [],
      // no space after '(' or before ')' keeps the deletion about tokens, not whitespace
      join: (t) => t.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/\[ /g, '[').replace(/ \]/g, ']'),
      print: (e) => sexpVerbose.expr(prog, e),
      parse: (s) => {
        const forms = readAll(s);
        if (forms.length !== 1) throw new Error('expected exactly one expression');
        return parseExpr(forms[0]);
      },
    },
    {
      name: 'prefix',
      tokenize: tokenizePolish,
      join: (t) => t.join(' '),
      print: (e) => polish.expr(prog, e),
      parse: (s) => parsePolishExpr(s, a),
    },
    {
      name: 'json-ast',
      tokenize: (s) => s.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|[^\s{}\[\],:"]+/g) ?? [],
      join: (t) => t.join(''),
      print: (e) => JSON.stringify(e, bigintReplacer),
      parse: parseJsonExpr,
    },
  ];
}

const key = (e: Expr) => JSON.stringify(e, bigintReplacer);

export interface FragilityRow {
  name: string;
  trials: number;
  parseError: number;
  checkerError: number;
  silent: number;
  same: number;
  examples: { before: string; after: string }[];
}

export function fragilityExperiment(prog: Program, pol: Policy = { allow: [], sinks: new Map() }): FragilityRow[] {
  const base = check(prog, pol);
  const baseErrors = errors(base).length;
  const out: FragilityRow[] = [];
  for (const c of codecs(prog)) {
    const row: FragilityRow = { name: c.name, trials: 0, parseError: 0, checkerError: 0, silent: 0, same: 0, examples: [] };
    for (const f of prog.fns.values()) {
      const orig = key(f.body);
      const toks = c.tokenize(c.print(f.body));
      for (let i = 0; i < toks.length; i++) {
        const mutated = c.join([...toks.slice(0, i), ...toks.slice(i + 1)]);
        row.trials++;
        let outcome: Outcome;
        let parsed: Expr | undefined;
        try {
          parsed = c.parse(mutated);
        } catch {
          outcome = 'parse-error';
          row.parseError++;
          continue;
        }
        if (key(parsed) === orig) {
          outcome = 'same';
          row.same++;
          continue;
        }
        try {
          const p2: Program = { ...prog, fns: new Map(prog.fns) };
          p2.fns.set(f.name, { ...f, body: parsed });
          outcome = errors(check(p2, pol)).length > baseErrors ? 'checker-error' : 'silent-change';
        } catch {
          outcome = 'checker-error';
        }
        if (outcome === 'checker-error') row.checkerError++;
        else {
          row.silent++;
          if (row.examples.length < 3) row.examples.push({ before: `${f.name}: delete token ${JSON.stringify(toks[i])}`, after: c.print(parsed).slice(0, 110) });
        }
      }
    }
    out.push(row);
  }
  return out;
}

export function formatFragility(rows: FragilityRow[]): string {
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const pct = (n: number, t: number) => `${((100 * n) / t).toFixed(1)}%`;
  const lines = [
    '',
    '== Fragility: delete each token of every function body once =============================',
    `${pad('syntax', 14)} ${pad('trials', 7)} ${pad('parse err', 11)} ${pad('checker err', 12)} ${pad('SILENT change', 14)} same`,
  ];
  for (const r of rows) {
    lines.push(`${pad(r.name, 14)} ${pad(r.trials, 7)} ${pad(pct(r.parseError, r.trials), 11)} ${pad(pct(r.checkerError, r.trials), 12)} ${pad(pct(r.silent, r.trials), 14)} ${pct(r.same, r.trials)}`);
  }
  for (const r of rows) {
    if (!r.examples.length) continue;
    lines.push('', `silent changes in ${r.name} (accepted as a different valid program):`);
    for (const x of r.examples) lines.push(`  ${x.before}\n     now: ${x.after}`);
  }
  lines.push('', 'SILENT = parses, passes the checker (no new errors), and means something different from the original.');
  return lines.join('\n');
}
