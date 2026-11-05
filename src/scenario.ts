// Human-facing scenario layer: a strict Gherkin-style grammar whose every sentence must match a
// typed phrase in the glossary. Compiles to executable tests on the reference interpreter.
//
//   Feature / Rule (decision table) / Example (Given-When-Then) / Always / Privacy / Unresolved
//
// There are no loops or conditionals here on purpose: if a scenario wants one, the behaviour
// belongs in a Rule table or a property.

import { Expr, Program, Type, resolveType } from './ast.js';
import { CheckResult } from './check.js';
import {
  ContractViolation,
  Host,
  Interp,
  RuntimeFault,
  Val,
  enumVal,
  eqVal,
  evalIn,
  mulberry32,
  showVal,
} from './interp.js';
import { parseExpr, parseType } from './parse.js';
import { SExp, SigilError, isKeyword, isList, isSym, readAll, sexpToString } from './sexpr.js';

// ---------------------------------------------------------------------------
// Feature file
// ---------------------------------------------------------------------------

export interface Step {
  kind: 'given' | 'when' | 'then';
  text: string;
  line: number;
}
export interface Example {
  title: string;
  steps: Step[];
  line: number;
}
export interface Rule {
  title: string;
  header: string[];
  rows: string[][];
  line: number;
}
export interface Para {
  text: string;
  line: number;
}
export interface Feature {
  title: string;
  rules: Rule[];
  examples: Example[];
  always: Para[];
  privacy: Para[];
  unresolved: Para[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parseFeature(src: string): Feature {
  const f: Feature = { title: '', rules: [], examples: [], always: [], privacy: [], unresolved: [] };
  let cur: { kind: 'rule' | 'example' | 'para'; target?: Para[]; obj?: Rule | Example | Para } | null = null;
  let prevKind: Step['kind'] = 'given';
  const lines = src.split('\n');
  const KW = /^(Feature|Rule|Example|Scenario|Always|Privacy|Unresolved):\s*(.*)$/;
  const STEP = /^(Given|When|Then|And|But)\s+(.*)$/;

  lines.forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (t === '') {
      if (cur?.kind === 'para') cur = null;
      return;
    }
    if (t.startsWith('#')) return;
    const kw = KW.exec(t);
    if (kw) {
      const [, k, rest] = kw;
      switch (k) {
        case 'Feature':
          f.title = norm(rest);
          cur = null;
          return;
        case 'Rule': {
          const r: Rule = { title: norm(rest), header: [], rows: [], line };
          f.rules.push(r);
          cur = { kind: 'rule', obj: r };
          return;
        }
        case 'Example':
        case 'Scenario': {
          const ex: Example = { title: norm(rest), steps: [], line };
          f.examples.push(ex);
          cur = { kind: 'example', obj: ex };
          prevKind = 'given';
          return;
        }
        default: {
          const target = k === 'Always' ? f.always : k === 'Privacy' ? f.privacy : f.unresolved;
          const p: Para = { text: norm(rest), line };
          target.push(p);
          cur = { kind: 'para', target, obj: p };
          return;
        }
      }
    }
    if (t.startsWith('|')) {
      if (cur?.kind !== 'rule') throw new SigilError(`feature:${line}: table row outside a Rule`);
      const cells = t.split('|').slice(1, -1).map(norm);
      const r = cur.obj as Rule;
      if (r.header.length === 0) r.header = cells;
      else r.rows.push(cells);
      return;
    }
    const st = STEP.exec(t);
    if (st && cur?.kind === 'example') {
      const word = st[1];
      const kind: Step['kind'] = word === 'Given' ? 'given' : word === 'When' ? 'when' : word === 'Then' ? 'then' : prevKind;
      prevKind = kind;
      (cur.obj as Example).steps.push({ kind, text: norm(st[2]), line });
      return;
    }
    if (cur?.kind === 'para') {
      const p = cur.obj as Para;
      p.text = norm(p.text + ' ' + t);
      return;
    }
    throw new SigilError(`feature:${line}: cannot parse line: ${t}`);
  });
  return f;
}

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

type Action =
  | { a: 'set' | 'default' | 'append'; name: string; expr: Expr }
  | { a: 'call'; name: string; fn: string; args: Expr[] }
  | { a: 'fail'; handle: string; op: string }
  | { a: 'expect'; expr: Expr };

interface PhraseType {
  rx: string;
  parse: (s: string) => Val;
}

interface Phrase {
  kind: 'given' | 'when' | 'then';
  pattern: string;
  regex: RegExp;
  params: { name: string; type: PhraseType }[];
  actions: Action[];
}

export interface RuleBinding {
  title: string;
  fn: string;
  cols: string[];
}
export interface AlwaysBinding {
  text: string;
  vars: { name: string; type: Type }[];
  body: Expr;
}
export interface PrivacyBinding {
  text: string;
  source: string;
  allow: string[];
  /** Declassifiers the human accepts for this rule: flows via exactly these are exempt from the two-run check. */
  declassified: string[];
  run: string;
}

export interface Glossary {
  phrases: Phrase[];
  rules: Map<string, RuleBinding>;
  always: Map<string, AlwaysBinding>;
  privacy: Map<string, PrivacyBinding>;
}

const money = (s: string): bigint => {
  const [d, c = ''] = s.split('.');
  return BigInt(d) * 100n + BigInt((c + '00').slice(0, 2));
};

export function phraseType(prog: Program, name: string): PhraseType {
  switch (name) {
    case 'Int':
      return { rx: '(-?\\d+)', parse: (s) => BigInt(s) };
    case 'Str':
      return { rx: '"([^"]*)"', parse: (s) => s };
    case 'Money':
      return { rx: '\\$(\\d+(?:\\.\\d{1,2})?)', parse: money };
    case 'Pct':
      return { rx: '(\\d+)%', parse: (s) => BigInt(s) };
  }
  const t = prog.types.get(name);
  if (!t) throw new SigilError(`glossary: unknown placeholder type ${name}`);
  const r = resolveType(prog, t);
  if (r.k === 'enum') return { rx: `(${r.cases.join('|')})`, parse: (s) => enumVal(s) };
  if (r.k === 'int')
    return {
      rx: '(-?\\d+)',
      parse: (s) => {
        const v = BigInt(s);
        if (v < r.lo || v > r.hi) throw new SigilError(`${v} is not a valid ${name} (range ${r.lo}..${r.hi})`);
        return v;
      },
    };
  if (r.k === 'str' && r.validated) {
    const v = [...prog.validators.values()].find((x) => x.out.k === 'named' && x.out.name === name);
    if (!v) throw new SigilError(`glossary: no validator produces ${name}`);
    const re = new RegExp(v.regex);
    return {
      rx: '"([^"]*)"',
      parse: (s) => {
        if (!re.test(s)) throw new SigilError(`${JSON.stringify(s)} is not a valid ${name} (validator ${v.name})`);
        return s;
      },
    };
  }
  throw new SigilError(`glossary: type ${name} cannot be used as a phrase placeholder`);
}

function compilePattern(prog: Program, pattern: string) {
  const params: { name: string; type: PhraseType }[] = [];
  let rx = '';
  let last = 0;
  const re = /\{(\w+):(\w+)\}/g;
  for (let m = re.exec(pattern); m; m = re.exec(pattern)) {
    rx += pattern.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pt = phraseType(prog, m[2]);
    params.push({ name: m[1], type: pt });
    rx += pt.rx;
    last = m.index + m[0].length;
  }
  rx += pattern.slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { regex: new RegExp(`^${rx}$`), params };
}

function parseAction(s: SExp): Action {
  if (!isList(s) || !isSym(s.items[0])) throw new SigilError('glossary action must be a list', s.pos);
  const h = (s.items[0] as { v: string }).v;
  const name = (i: number) => {
    const x = s.items[i];
    if (!isSym(x)) throw new SigilError(`${h}: expected a name`, s.pos);
    return x.v;
  };
  switch (h) {
    case 'set':
    case 'default':
    case 'append':
      return { a: h, name: name(1), expr: parseExpr(s.items[2]) };
    case 'call':
      return { a: 'call', name: name(1), fn: name(2), args: s.items.slice(3).map(parseExpr) };
    case 'fail':
      return { a: 'fail', handle: name(1), op: name(2) };
    case 'expect':
      return { a: 'expect', expr: parseExpr(s.items[1]) };
    default:
      throw new SigilError(`unknown glossary action ${h} (allowed: set default append call fail expect)`, s.pos);
  }
}

export function parseGlossary(src: string, prog: Program): Glossary {
  const g: Glossary = { phrases: [], rules: new Map(), always: new Map(), privacy: new Map() };
  const forms = readAll(src);
  if (forms.length !== 1 || !isList(forms[0]) || !isSym(forms[0].items[0], 'glossary')) throw new SigilError('expected a single (glossary ...) form');
  for (const e of forms[0].items.slice(1)) {
    if (!isList(e) || !isSym(e.items[0])) throw new SigilError('glossary entry', e.pos);
    const h = (e.items[0] as { v: string }).v;
    const text = e.items[1];
    if (!text || text.t !== 'str') throw new SigilError(`${h}: expected a quoted phrase`, e.pos);
    const key = norm(text.v);
    switch (h) {
      case 'given':
      case 'when':
      case 'then': {
        const { regex, params } = compilePattern(prog, key);
        g.phrases.push({ kind: h, pattern: key, regex, params, actions: e.items.slice(2).map(parseAction) });
        break;
      }
      case 'rule': {
        const fn = e.items[2];
        const cols = e.items[3];
        if (!isSym(fn) || !isList(cols)) throw new SigilError('(rule "title" fn (ColType ...))', e.pos);
        g.rules.set(key, { title: key, fn: fn.v, cols: cols.items.map((c) => (isSym(c) ? c.v : '?')) });
        break;
      }
      case 'always': {
        const fa = e.items[2];
        if (!isList(fa) || !isSym(fa.items[0], 'forall') || !isList(fa.items[1])) throw new SigilError('(always "text" (forall ((x T)...) body))', e.pos);
        const vars = fa.items[1].items.map((b) => {
          if (!isList(b) || !isSym(b.items[0])) throw new SigilError('forall binder is (name Type)', b.pos);
          return { name: (b.items[0] as { v: string }).v, type: parseType(b.items[1]) };
        });
        g.always.set(key, { text: key, vars, body: parseExpr(fa.items[2]) });
        break;
      }
      case 'privacy': {
        const b: Partial<PrivacyBinding> = { text: key, allow: [], declassified: [] };
        for (const c of e.items.slice(2)) {
          if (!isList(c) || !isSym(c.items[0])) throw new SigilError('privacy clause', c.pos);
          const tag = (c.items[0] as { v: string }).v;
          if (tag === 'source') b.source = sexpToString(c.items[1]);
          else if (tag === 'allow') b.allow = c.items.slice(1).map(sexpToString);
          else if (tag === 'declassified') b.declassified = c.items.slice(1).map(sexpToString);
          else if (tag === 'run') b.run = sexpToString(c.items[1]);
          else throw new SigilError(`unknown privacy clause ${tag}`, c.pos);
        }
        if (!b.source || !b.run) throw new SigilError('privacy needs (source ...) and (run ...)', e.pos);
        g.privacy.set(key, b as PrivacyBinding);
        break;
      }
      default:
        throw new SigilError(`unknown glossary entry ${h}`, e.pos);
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Generators (type-directed, seeded; boundary-biased for ranges)
// ---------------------------------------------------------------------------

// Integer literals (and their neighbours) that appear in the property under test. A boundary in the formal
// text (for example a cap of 20000) is almost never hit by uniform sampling of a huge range, so ints are
// sometimes drawn from these values. Set for the duration of a property run.
let hintPool: bigint[] = [];

function collectInts(e: Expr, out: Set<bigint>): void {
  switch (e.k) {
    case 'int':
      out.add(e.v);
      return;
    case 'call':
      e.args.forEach((a) => collectInts(a, out));
      e.kw.forEach((k) => collectInts(k.value, out));
      return;
    case 'let':
      e.binds.forEach((b) => collectInts(b.value, out));
      e.body.forEach((b) => collectInts(b, out));
      return;
    case 'match':
      collectInts(e.scrut, out);
      e.arms.forEach((a) => collectInts(a.body, out));
      return;
    case 'if':
      collectInts(e.cond, out);
      collectInts(e.then, out);
      collectInts(e.else, out);
      return;
    case 'lam':
      collectInts(e.body, out);
      return;
    case 'do':
      e.body.forEach((b) => collectInts(b, out));
      return;
    case 'try':
      collectInts(e.expr, out);
      return;
    default:
      return;
  }
}

export function gen(prog: Program, t: Type, rnd: () => number): Val {
  const r = resolveType(prog, t);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  switch (r.k) {
    case 'int': {
      const u = rnd();
      if (hintPool.length && u > 0.8) {
        const inRange = hintPool.filter((h) => h >= r.lo && h <= r.hi);
        if (inRange.length) return pick(inRange);
      }
      if (u < 0.15) return r.lo;
      if (u < 0.3) return r.hi;
      if (u < 0.35 && r.hi > r.lo) return r.lo + 1n;
      if (u < 0.4 && r.hi > r.lo) return r.hi - 1n;
      const span = r.hi - r.lo + 1n;
      const big = BigInt(Math.floor(rnd() * Number.MAX_SAFE_INTEGER)) * BigInt(Math.floor(rnd() * 1_000_000)) + BigInt(Math.floor(rnd() * Number.MAX_SAFE_INTEGER));
      return r.lo + (big % span);
    }
    case 'bool':
      return rnd() < 0.5;
    case 'unit':
      return null;
    case 'enum':
      return enumVal(pick(r.cases));
    case 'str': {
      if (r.validated) {
        const name = t.k === 'named' ? t.name : undefined;
        const v = [...prog.validators.values()].find((x) => x.out.k === 'named' && x.out.name === name);
        if (!v || !v.samples.length) throw new SigilError(`no samples to generate a ${name ?? 'validated string'}; add (sample ...) to its validator`);
        return pick(v.samples);
      }
      const alphabet = ['a', 'Z', '0', ' ', 'é', '"', '\n', '<', '>', "'", ';', '%'];
      const n = Math.min(r.max ?? 12, Math.floor(rnd() * 12));
      return Array.from({ length: n }, () => pick(alphabet)).join('');
    }
    case 'list': {
      const u = rnd();
      const n = u < 0.2 ? r.min : u < 0.4 ? r.max : r.min + Math.floor(rnd() * (Math.min(r.max, r.min + 40) - r.min + 1));
      return Array.from({ length: n }, () => gen(prog, r.elem, rnd));
    }
    case 'rec': {
      const fields: Record<string, Val> = {};
      for (const f of r.fields) fields[f.name] = gen(prog, f.type, rnd);
      return { $: 'rec', type: t.k === 'named' ? t.name : 'rec', fields };
    }
    case 'result':
      return rnd() < 0.5 ? { $: 'ok', v: gen(prog, r.ok, rnd) } : { $: 'err', v: gen(prog, r.err, rnd) };
    case 'named':
      throw new Error('unreachable');
  }
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

// ---------------------------------------------------------------------------
// Running a suite
// ---------------------------------------------------------------------------

export type ResultKind = 'example' | 'rule' | 'always' | 'privacy';
export interface TestResult {
  kind: ResultKind;
  title: string;
  status: 'pass' | 'fail' | 'error';
  message?: string;
  cases?: number;
  note?: string;
  /** Privacy only: declassifiers involved in the source's flows. Non-empty means NOT strict noninterference. */
  declassifiers?: string[];
}

export interface SuiteOptions {
  propCases: number;
  privacyCases: number;
  contracts: boolean; // runtime range/requires/ensures checks (off = attribute kills to the scenarios alone)
}
export const DEFAULT_SUITE: SuiteOptions = { propCases: 500, privacyCases: 100, contracts: true };
const ic = (o: SuiteOptions) => ({ contracts: o.contracts, fuel: 5_000_000 });

export interface SuiteOutput {
  results: TestResult[];
  unresolved: Para[];
  ensuresStats: Map<string, number>;
}

function nearest(g: Glossary, kind: Step['kind'], text: string): string[] {
  const toks = (s: string) => new Set(s.toLowerCase().replace(/\{\w+:\w+\}/g, ' ').split(/[^a-z0-9]+/).filter(Boolean));
  const a = toks(text);
  return g.phrases
    .filter((p) => p.kind === kind)
    .map((p) => {
      const b = toks(p.pattern);
      const inter = [...a].filter((x) => b.has(x)).length;
      return { p: p.pattern, s: inter / (a.size + b.size - inter || 1) };
    })
    .sort((x, y) => y.s - x.s)
    .slice(0, 3)
    .map((x) => x.p);
}

function runExample(prog: Program, g: Glossary, ex: Example, o: SuiteOptions): TestResult {
  const host = new Host(hash(ex.title));
  const it = new Interp(prog, host, ic(o));
  const vars = new Map<string, Val>();
  const base: TestResult = { kind: 'example', title: ex.title, status: 'pass' };

  for (const st of ex.steps) {
    const phrase = g.phrases.find((p) => p.kind === st.kind && p.regex.test(st.text));
    if (!phrase) {
      const near = nearest(g, st.kind, st.text);
      return { ...base, status: 'error', message: `line ${st.line}: no ${st.kind} phrase matches "${st.text}". Nearest: ${near.map((n) => `"${n}"`).join(', ') || '(none)'}` };
    }
    let caps: Map<string, Val>;
    try {
      const m = phrase.regex.exec(st.text)!;
      caps = new Map(phrase.params.map((p, i) => [p.name, p.type.parse(m[i + 1])]));
    } catch (e) {
      return { ...base, status: 'error', message: `line ${st.line}: ${(e as Error).message}` };
    }
    const scope = () => new Map<string, Val>([...vars, ...caps]);
    try {
      for (const a of phrase.actions) {
        switch (a.a) {
          case 'set':
            vars.set(a.name, evalIn(it, a.expr, scope()));
            break;
          case 'default':
            if (!vars.has(a.name)) vars.set(a.name, evalIn(it, a.expr, scope()));
            break;
          case 'append': {
            const cur = (vars.get(a.name) as Val[] | undefined) ?? [];
            vars.set(a.name, [...cur, evalIn(it, a.expr, scope())]);
            break;
          }
          case 'call':
            vars.set(a.name, it.callFn(a.fn, a.args.map((x) => evalIn(it, x, scope()))));
            break;
          case 'fail':
            host.fail(a.handle, a.op);
            break;
          case 'expect': {
            const v = evalIn(it, a.expr, scope());
            if (v !== true) {
              const shown = [...vars].filter(([k]) => ['total', 'result', 'plan'].includes(k)).map(([k, x]) => `${k}=${showVal(x)}`).join(' ');
              return { ...base, status: 'fail', message: `line ${st.line}: "${st.text}" failed${shown ? ` (${shown})` : ''}` };
            }
          }
        }
      }
    } catch (e) {
      if (e instanceof ContractViolation || e instanceof RuntimeFault) return { ...base, status: 'fail', message: `line ${st.line}: ${e.message}` };
      throw e;
    }
  }
  collectEnsures(it, ensuresAcc);
  return base;
}

// Accumulates passing runtime `ensures` checks across the whole suite (evidence: "tested N").
let ensuresAcc = new Map<string, number>();
function collectEnsures(it: Interp, acc: Map<string, number>) {
  for (const [k, n] of it.ensuresStats) acc.set(k, (acc.get(k) ?? 0) + n);
}

function parseCell(prog: Program, type: string, cell: string): Val {
  const pt = phraseType(prog, type);
  const m = new RegExp(`^${pt.rx.replace(/^\^|\$$/g, '')}$`).exec(cell.replace(/^"(.*)"$/, '"$1"'));
  if (!m) {
    // enum cells and quoted strings are written bare in tables
    if (type !== 'Str' && new RegExp(`^${pt.rx}$`).test(cell)) return pt.parse(new RegExp(`^${pt.rx}$`).exec(cell)![1]);
    throw new SigilError(`cell "${cell}" is not a valid ${type}`);
  }
  return pt.parse(m[1]);
}

function runRule(prog: Program, g: Glossary, rule: Rule, o: SuiteOptions): TestResult {
  const base: TestResult = { kind: 'rule', title: rule.title, status: 'pass', cases: rule.rows.length };
  const b = g.rules.get(rule.title);
  if (!b) return { ...base, status: 'error', message: `no glossary binding for Rule "${rule.title}"` };
  if (rule.header.length !== b.cols.length) return { ...base, status: 'error', message: `table has ${rule.header.length} columns, glossary binds ${b.cols.length}` };
  const host = new Host(hash(rule.title));
  const it = new Interp(prog, host, ic(o));
  const seen = new Set<string>();
  try {
    for (const row of rule.rows) {
      const vals = row.map((c, i) => parseCell(prog, b.cols[i], c));
      const args = vals.slice(0, -1);
      const want = vals[vals.length - 1];
      const key = args.map(showVal).join(',');
      if (seen.has(key)) return { ...base, status: 'fail', message: `overlapping rows for ${key}` };
      seen.add(key);
      const got = it.callFn(b.fn, args);
      if (!eqVal(got, want)) return { ...base, status: 'fail', message: `${b.fn}(${args.map(showVal).join(', ')}) = ${showVal(got)}, table says ${showVal(want)}` };
    }
    // exhaustiveness over a single enum argument column
    if (b.cols.length === 2) {
      const t = prog.types.get(b.cols[0]);
      if (t && t.k === 'enum') {
        const missing = t.cases.filter((c) => !seen.has(c));
        if (missing.length) return { ...base, status: 'fail', message: `table is not exhaustive: missing ${missing.join(', ')}` };
      }
    }
  } catch (e) {
    if (e instanceof SigilError || e instanceof ContractViolation || e instanceof RuntimeFault) return { ...base, status: 'error', message: e.message };
    throw e;
  }
  collectEnsures(it, ensuresAcc);
  return base;
}

function runAlways(prog: Program, g: Glossary, p: Para, n: number, o: SuiteOptions): TestResult {
  const base: TestResult = { kind: 'always', title: p.text, status: 'pass', cases: n };
  const b = g.always.get(p.text.replace(/\.$/, '')) ?? g.always.get(p.text);
  const bb = b ?? [...g.always.values()].find((x) => norm(x.text).replace(/\.$/, '') === p.text.replace(/\.$/, ''));
  if (!bb) return { ...base, status: 'error', message: 'no glossary binding for this property' };
  const rnd = mulberry32(hash(p.text));
  const it = new Interp(prog, new Host(1), ic(o));
  const lits = new Set<bigint>();
  collectInts(bb.body, lits);
  hintPool = [...lits].flatMap((l) => [l - 1n, l, l + 1n]);
  try {
    for (let i = 0; i < n; i++) {
      const env = new Map<string, Val>(bb.vars.map((v) => [v.name, gen(prog, v.type, rnd)]));
      try {
        if (evalIn(it, bb.body, env) !== true) {
          return { ...base, status: 'fail', cases: i + 1, message: `counterexample: ${[...env].map(([k, v]) => `${k}=${showVal(v)}`).join(' ').slice(0, 300)}` };
        }
      } catch (e) {
        if (e instanceof ContractViolation || e instanceof RuntimeFault) return { ...base, status: 'fail', cases: i + 1, message: `${e.message}` };
        throw e;
      }
    }
  } finally {
    hintPool = [];
  }
  collectEnsures(it, ensuresAcc);
  return base;
}

function replaceField(v: Val, typeName: string, field: string, nv: Val): Val {
  if (Array.isArray(v)) return v.map((x) => replaceField(x, typeName, field, nv));
  if (v && typeof v === 'object') {
    if (v.$ === 'rec') {
      const fields: Record<string, Val> = {};
      for (const [k, x] of Object.entries(v.fields)) fields[k] = v.type === typeName && k === field ? nv : replaceField(x, typeName, field, nv);
      return { $: 'rec', type: v.type, fields };
    }
  }
  return v;
}

function runPrivacy(prog: Program, g: Glossary, p: Para, n: number, o: SuiteOptions, check?: CheckResult): TestResult {
  const base: TestResult = { kind: 'privacy', title: p.text, status: 'pass', cases: n };
  const b = [...g.privacy.values()].find((x) => norm(x.text) === p.text);
  if (!b) return { ...base, status: 'error', message: 'no glossary binding for this privacy rule' };
  const [typeName, field] = b.source.split('.');
  const fn = prog.fns.get(b.run);
  if (!fn) return { ...base, status: 'error', message: `unknown function ${b.run}` };
  const rt = prog.types.get(typeName);
  const ft = rt && rt.k === 'rec' ? rt.fields.find((f) => f.name === field) : undefined;
  if (!ft) return { ...base, status: 'error', message: `unknown source ${b.source}` };

  // Static half: the flow matrix must show the source reaching only allowed sinks.
  // A flow that passed a declassifier is exempt only if the privacy binding names EVERY declassifier on it
  // (a human decision in the glossary); otherwise it is an ordinary violation, with a hint.
  const notes: string[] = [];
  const exempt = new Set<string>(); // sinks excluded from the two-run comparison, solely because of accepted declassifiers
  let involved: string[] = [];
  if (check) {
    const edges = check.flows.filter((f) => f.src === b.source);
    const viaAccepted = (f: (typeof edges)[number]) => !!f.via && f.via.every((v) => b.declassified.includes(v.name));
    const bad = edges.filter((f) => !b.allow.includes(f.sink) && !viaAccepted(f));
    if (bad.length) {
      const desc = (f: (typeof edges)[number]) => (f.via ? `${f.sink} via declassify ${f.via.map((v) => v.name).join(', ')} (not accepted by this rule; add (declassified ${f.via.map((v) => v.name).join(' ')}) to its glossary binding if a human agrees)` : f.sink);
      return { ...base, status: 'fail', message: `static: ${b.source} reaches ${bad.map(desc).join('; ')} (allowed: ${b.allow.join(', ') || 'none'})` };
    }
    for (const f of edges) if (!b.allow.includes(f.sink) && viaAccepted(f)) exempt.add(f.sink);
    involved = [...new Set(edges.flatMap((f) => (f.via ?? []).map((v) => v.name)))];
    notes.push(`static: ${b.source} reaches {${[...new Set(edges.map((f) => f.sink))].join(', ')}}`);
  }
  const open = new Set([...b.allow, ...exempt]);

  // Dynamic half: two runs differing only in the source field; all non-allowed sinks must agree.
  const rnd = mulberry32(hash(p.text));
  let influenced = 0;
  for (let i = 0; i < n; i++) {
    const args = fn.params.map((pa) => gen(prog, pa.type, rnd));
    let alt = gen(prog, ft.type, rnd);
    for (let k = 0; k < 10 && eqVal(alt, (args.find((a) => a && typeof a === 'object' && !Array.isArray(a) && a.$ === 'rec' && a.type === typeName) as { fields: Record<string, Val> } | undefined)?.fields[field] ?? null); k++) alt = gen(prog, ft.type, rnd);
    const args2 = args.map((a) => replaceField(a, typeName, field, alt));
    const run = (xs: Val[]) => {
      const host = new Host(i + 1);
      const it = new Interp(prog, host, ic(o));
      const out = it.callFn(fn.name, xs);
      return { out, log: host.log };
    };
    let r1, r2;
    try {
      r1 = run(args);
      r2 = run(args2);
    } catch (e) {
      if (e instanceof ContractViolation || e instanceof RuntimeFault) return { ...base, status: 'error', cases: i, message: e.message };
      throw e;
    }
    const strip = (l: typeof r1.log) => l.filter((o) => !open.has(o.handle));
    const allowed = (l: typeof r1.log) => l.filter((o) => open.has(o.handle));
    const same = (x: typeof r1.log, y: typeof r1.log) => x.length === y.length && x.every((o, j) => o.handle === y[j].handle && o.op === y[j].op && o.ok === y[j].ok && o.args.length === y[j].args.length && o.args.every((a, k) => eqVal(a, y[j].args[k])));
    if (!eqVal(r1.out, r2.out) || !same(strip(r1.log), strip(r2.log))) {
      const diff = strip(r1.log).find((o, j) => !strip(r2.log)[j] || !same([o], [strip(r2.log)[j]]));
      return { ...base, status: 'fail', cases: i + 1, message: `changing ${b.source} changed observable behaviour outside {${b.allow.join(', ')}}${diff ? ` (first difference at ${diff.handle}.${diff.op})` : ''}` };
    }
    if (!same(allowed(r1.log), allowed(r2.log))) influenced++;
  }
  if (influenced === 0) notes.push('WARNING: vacuous (the field never influenced an allowed sink in these runs)');
  else notes.push(`field influenced the allowed sink in ${influenced}/${n} runs`);
  if (involved.length) {
    // Not strict noninterference: say so, and say exactly which part was exempted.
    const ex = [...exempt];
    notes.unshift(
      `PASS MODULO DECLASSIFIER${involved.length > 1 ? 'S' : ''} ${involved.join(', ')}: ` +
        (ex.length
          ? `strict noninterference does NOT hold; sink(s) ${ex.join(', ')} were excluded from the two-run comparison because every flow from ${b.source} to them passes an accepted declassifier (sink granularity; the static matrix guarantees no direct flow reaches them)`
          : `the declassified flow(s) reach only allowed sink(s), so non-allowed sinks are still checked strictly`),
    );
  }
  return { ...base, note: notes.join('; '), ...(involved.length ? { declassifiers: involved } : {}) };
}

export function runSuite(prog: Program, feature: Feature, g: Glossary, check?: CheckResult, opts: SuiteOptions = DEFAULT_SUITE): SuiteOutput {
  ensuresAcc = new Map();
  const results: TestResult[] = [];
  for (const r of feature.rules) results.push(runRule(prog, g, r, opts));
  for (const ex of feature.examples) results.push(runExample(prog, g, ex, opts));
  for (const a of feature.always) results.push(runAlways(prog, g, a, opts.propCases, opts));
  for (const p of feature.privacy) results.push(runPrivacy(prog, g, p, opts.privacyCases, opts, check));
  return { results, unresolved: feature.unresolved, ensuresStats: new Map(ensuresAcc) };
}

export { isKeyword };
