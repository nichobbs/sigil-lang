import {
  Conf,
  CONFS,
  Declassifier,
  Expr,
  Field,
  FnDef,
  Policy,
  Program,
  Type,
  emptyProgram,
} from './ast.js';
import { kindOfHandle } from './caps.js';
import { SExp, SigilError, isKeyword, isList, isSym, readAll, sexpToString } from './sexpr.js';

const fail = (msg: string, at?: SExp): never => {
  throw new SigilError(msg, at?.pos);
};

function sym(s: SExp | undefined, what: string, at?: SExp): string {
  if (!s || s.t !== 'sym') return fail(`expected ${what}`, s ?? at);
  return s.v;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export function parseType(s: SExp): Type {
  if (s.t === 'sym') {
    switch (s.v) {
      case 'Str':
        return { k: 'str', validated: false };
      case 'Bool':
        return { k: 'bool' };
      case 'Unit':
        return { k: 'unit' };
      default:
        if (s.v.startsWith(':')) return fail(`unexpected keyword ${s.v} in type position`, s);
        return { k: 'named', name: s.v };
    }
  }
  if (s.t !== 'list' || s.items.length === 0) return fail('malformed type', s);
  const [head, ...rest] = s.items;
  const h = sym(head, 'type constructor', s);
  switch (h) {
    case 'Int': {
      if (rest.length !== 2 || rest[0].t !== 'int' || rest[1].t !== 'int') return fail('(Int lo hi) expects two integer literals', s);
      if (rest[0].v > rest[1].v) return fail('empty Int range', s);
      return { k: 'int', lo: rest[0].v, hi: rest[1].v };
    }
    case 'Str': {
      let validated = false;
      let max: number | undefined;
      for (let i = 0; i < rest.length; i++) {
        const r = rest[i];
        if (!isKeyword(r)) return fail('(Str ...) takes only flags (:validated, :max N)', r);
        if (r.v === ':validated') validated = true;
        else if (r.v === ':max') {
          const n = rest[++i];
          if (!n || n.t !== 'int' || n.v < 0n) return fail('(Str :max N) needs a non-negative integer literal', r);
          max = Number(n.v);
        } else return fail(`unknown Str flag ${r.v}`, s);
      }
      return max === undefined ? { k: 'str', validated } : { k: 'str', validated, max };
    }
    case 'var': {
      if (rest.length === 0) return fail('(var ...) needs at least one case', s);
      return { k: 'enum', cases: rest.map((r) => sym(r, 'case name', s)) };
    }
    case 'rec':
      return { k: 'rec', fields: rest.map(parseField) };
    case 'List': {
      if (rest.length !== 3 || rest[1].t !== 'int' || rest[2].t !== 'int') return fail('(List T min max)', s);
      const min = Number(rest[1].v);
      const max = Number(rest[2].v);
      if (min > max || min < 0) return fail('bad list length range', s);
      return { k: 'list', elem: parseType(rest[0]), min, max };
    }
    case 'Result': {
      if (rest.length !== 2) return fail('(Result Ok Err)', s);
      return { k: 'result', ok: parseType(rest[0]), err: parseType(rest[1]) };
    }
    default:
      return fail(`unknown type constructor ${h}`, s);
  }
}

function parseField(s: SExp): Field {
  if (s.t !== 'list' || s.items.length < 2) return fail('field is (name Type flags...)', s);
  const name = sym(s.items[0], 'field name', s);
  const type = parseType(s.items[1]);
  let conf: Conf = 'public';
  let control = false;
  for (const f of s.items.slice(2)) {
    if (!isKeyword(f)) return fail('field flags are keywords', f);
    const w = f.v.slice(1);
    if ((CONFS as string[]).includes(w)) conf = w as Conf;
    else if (w === 'control') control = true;
    else return fail(`unknown field flag ${f.v}`, f);
  }
  return { name, type, conf, control };
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export function parseExpr(s: SExp): Expr {
  switch (s.t) {
    case 'int':
      return { k: 'int', v: s.v };
    case 'str':
      return { k: 'str', v: s.v };
    case 'sym': {
      if (s.v === 'true') return { k: 'bool', v: true };
      if (s.v === 'false') return { k: 'bool', v: false };
      if (s.v.startsWith(':')) return fail(`unexpected keyword ${s.v}`, s);
      const parts = s.v.split('.');
      if (parts.some((p) => p === '')) return fail(`bad identifier ${s.v}`, s);
      return { k: 'var', name: parts[0], path: parts.slice(1) };
    }
    case 'list':
      return parseForm(s);
  }
}

function parseForm(s: Extract<SExp, { t: 'list' }>): Expr {
  if (s.items.length === 0) return fail('empty form', s);
  const head = s.items[0];
  const h = sym(head, 'function or form name', s);
  const rest = s.items.slice(1);
  switch (h) {
    case 'let': {
      const bl = rest[0];
      if (!isList(bl) || bl.items.length % 2 !== 0) return fail('(let [name expr ...] body...)', s);
      const binds: { name: string; value: Expr }[] = [];
      for (let i = 0; i < bl.items.length; i += 2) {
        binds.push({ name: sym(bl.items[i], 'binding name', bl), value: parseExpr(bl.items[i + 1]) });
      }
      if (rest.length < 2) return fail('let needs a body', s);
      return { k: 'let', binds, body: rest.slice(1).map(parseExpr) };
    }
    case 'match': {
      if (rest.length < 2) return fail('(match scrutinee (Tag body)...)', s);
      const arms = rest.slice(1).map((a) => {
        if (!isList(a) || (a.items.length !== 2 && a.items.length !== 3)) return fail('match arm is (Tag body) or (Tag bind body)', a);
        const tag = sym(a.items[0], 'arm tag', a);
        if (a.items.length === 2) return { tag, bind: null, body: parseExpr(a.items[1]) };
        return { tag, bind: sym(a.items[1], 'binder', a), body: parseExpr(a.items[2]) };
      });
      return { k: 'match', scrut: parseExpr(rest[0]), arms };
    }
    case 'if': {
      if (rest.length !== 3) return fail('(if cond then else)', s);
      return { k: 'if', cond: parseExpr(rest[0]), then: parseExpr(rest[1]), else: parseExpr(rest[2]) };
    }
    case 'fn': {
      const ps = rest[0];
      if (!isList(ps) || rest.length !== 2) return fail('lambda is (fn (params...) body)', s);
      return { k: 'lam', params: ps.items.map((p) => sym(p, 'parameter', ps)), body: parseExpr(rest[1]) };
    }
    case 'do': {
      if (rest.length === 0) return fail('empty do', s);
      return { k: 'do', body: rest.map(parseExpr) };
    }
    case 'declassify': {
      if (rest.length !== 2 || !isSym(rest[0]) || rest[0].v.startsWith(':') || rest[0].v.includes('.')) return fail('(declassify name expr), where name is declared in the policy', s);
      return { k: 'call', fn: 'declassify', args: [{ k: 'var', name: rest[0].v, path: [] }, parseExpr(rest[1])], kw: [] };
    }
    case 'try': {
      if (rest.length !== 3 || !isSym(rest[1], ':on-err')) return fail('(try expr :on-err Variant)', s);
      return { k: 'try', expr: parseExpr(rest[0]), onErr: sym(rest[2], 'error variant', s) };
    }
    default: {
      const args: Expr[] = [];
      const kw: { name: string; value: Expr }[] = [];
      for (let i = 0; i < rest.length; i++) {
        const r = rest[i];
        if (isKeyword(r)) {
          if (i + 1 >= rest.length) return fail(`keyword ${r.v} has no value`, r);
          kw.push({ name: r.v.slice(1), value: parseExpr(rest[++i]) });
        } else {
          if (kw.length) return fail('positional argument after keyword argument', r);
          args.push(parseExpr(r));
        }
      }
      return { k: 'call', fn: h, args, kw };
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level forms
// ---------------------------------------------------------------------------

const FN_CLAUSES = new Set(['in', 'out', 'needs', 'declassifies', 'requires', 'ensures']);

function parseFn(s: Extract<SExp, { t: 'list' }>): FnDef {
  const name = sym(s.items[1], 'function name', s);
  const fn: FnDef = { name, params: [], out: { k: 'unit' }, needs: [], declassifies: [], requires: [], ensures: [], body: { k: 'int', v: 0n } };
  let i = 2;
  let sawOut = false;
  for (; i < s.items.length; i++) {
    const c = s.items[i];
    if (!isList(c) || !isSym(c.items[0]) || !FN_CLAUSES.has((c.items[0] as { v: string }).v)) break;
    const tag = (c.items[0] as { v: string }).v;
    const body = c.items.slice(1);
    switch (tag) {
      case 'in':
        fn.params = body.map((p) => {
          if (!isList(p) || p.items.length !== 2) return fail('parameter is (name Type)', p);
          return { name: sym(p.items[0], 'parameter name', p), type: parseType(p.items[1]) };
        });
        break;
      case 'out':
        if (body.length !== 1) fail('(out Type)', c);
        fn.out = parseType(body[0]);
        sawOut = true;
        break;
      case 'needs':
        fn.needs = body.map((b) => sym(b, 'capability handle', c));
        break;
      case 'declassifies':
        fn.declassifies = body.map((b) => sym(b, 'declassifier name', c));
        break;
      case 'requires':
        fn.requires.push(...body.map(parseExpr));
        break;
      case 'ensures':
        fn.ensures.push(...body.map(parseExpr));
        break;
    }
  }
  if (!sawOut) fail(`fn ${name} needs an (out Type) clause`, s);
  const bodyForms = s.items.slice(i);
  if (bodyForms.length === 0) fail(`fn ${name} has no body`, s);
  const exprs = bodyForms.map(parseExpr);
  fn.body = exprs.length === 1 ? exprs[0] : { k: 'do', body: exprs };
  return fn;
}

export function parseProgram(src: string, into: Program = emptyProgram()): Program {
  const p = into;
  for (const form of readAll(src)) {
    if (!isList(form) || !isSym(form.items[0])) {
      fail('top-level form must be a list starting with a keyword', form);
      continue;
    }
    const head = (form.items[0] as { v: string }).v;
    switch (head) {
      case 'type': {
        const name = sym(form.items[1], 'type name', form);
        if (p.types.has(name)) fail(`duplicate type ${name}`, form);
        p.types.set(name, parseType(form.items[2]));
        break;
      }
      case 'fn': {
        const fn = parseFn(form);
        if (fn.name === 'declassify') fail('declassify is a reserved form name', form);
        if (p.fns.has(fn.name)) fail(`duplicate fn ${fn.name}`, form);
        p.fns.set(fn.name, fn);
        break;
      }
      case 'validator': {
        const name = sym(form.items[1], 'validator name', form);
        let param = 's';
        let out: Type | undefined;
        let regex: string | undefined;
        const samples: string[] = [];
        for (const c of form.items.slice(2)) {
          if (!isList(c) || !isSym(c.items[0])) {
            fail('validator clause', c);
            continue;
          }
          const tag = (c.items[0] as { v: string }).v;
          if (tag === 'in') {
            const pr = c.items[1];
            if (!isList(pr)) fail('(in (name Str))', c);
            else param = sym(pr.items[0], 'param', pr);
          } else if (tag === 'out') out = parseType(c.items[1]);
          else if (tag === 'sample') {
            for (const x of c.items.slice(1)) {
              if (x.t !== 'str') fail('(sample "..." ...)', x);
              else samples.push(x.v);
            }
          } else if (tag === 'regex') {
            const r = c.items[1];
            if (!r || r.t !== 'str') fail('(regex "...")', c);
            else regex = r.v;
          } else fail(`unknown validator clause ${tag}`, c);
        }
        if (!out || regex === undefined) return fail(`validator ${name} needs out and regex`, form);
        p.validators.set(name, { name, param, out, regex, samples });
        break;
      }
      case 'program': {
        p.names.push(sym(form.items[1], 'program name', form));
        for (const c of form.items.slice(2)) {
          if (!isList(c) || !isSym(c.items[0])) {
            fail('program clause', c);
            continue;
          }
          const tag = (c.items[0] as { v: string }).v;
          if (tag === 'targets') p.targets.push(...c.items.slice(1).map((t) => sym(t, 'target', c)));
          else if (tag === 'entry') {
            p.entries.push(sym(c.items[1], 'entry function', c));
            for (const b of c.items.slice(2)) {
              if (!isList(b) || !isSym(b.items[0], 'bind')) {
                fail('(bind handle (kind caveats...))', b);
                continue;
              }
              const handle = sym(b.items[1], 'handle', b);
              const spec = b.items[2];
              if (!isList(spec)) {
                fail('bind needs (kind caveats...)', b);
                continue;
              }
              const kind = sym(spec.items[0], 'capability kind', spec);
              if (kindOfHandle(handle) !== kind) fail(`handle ${handle} must be a ${kind} (name it ${kind}:name)`, b);
              const caveats: Record<string, string[]> = {};
              for (const cv of spec.items.slice(1)) {
                if (isSym(cv)) caveats[cv.v] = [];
                else if (isList(cv)) caveats[sym(cv.items[0], 'caveat', cv)] = cv.items.slice(1).map((x) => (x.t === 'str' ? x.v : sexpToString(x)));
                else fail('bad caveat', cv);
              }
              p.binds.set(handle, { handle, kind, caveats });
            }
          } else fail(`unknown program clause ${tag}`, c);
        }
        break;
      }
      default:
        fail(`unknown top-level form ${head}`, form);
    }
  }
  return p;
}

const DECL_FORM = '(declassify name (from conf) (to conf) (reason "...") [(fields Type.field ...)] [(fns fn ...)])';

function parseDeclassifier(c: Extract<SExp, { t: 'list' }>): Declassifier | undefined {
  if (c.items.length < 2 || !isSym(c.items[1])) return fail(DECL_FORM, c);
  const name = sym(c.items[1], 'declassifier name', c);
  const conf = (x: SExp | undefined, what: string): Conf => {
    const w = x && x.t === 'sym' ? x.v : '';
    if (!(CONFS as string[]).includes(w)) return fail(`${what}: unknown confidentiality ${w || '(missing)'}`, c);
    return w as Conf;
  };
  let from: Conf | undefined;
  let to: Conf | undefined;
  let reason: string | undefined;
  let fields: string[] | undefined;
  let fns: string[] | undefined;
  for (const cl of c.items.slice(2)) {
    if (!isList(cl) || !isSym(cl.items[0])) return fail(DECL_FORM, cl);
    const tag = (cl.items[0] as { v: string }).v;
    if (tag === 'from') from = conf(cl.items[1], 'from');
    else if (tag === 'to') to = conf(cl.items[1], 'to');
    else if (tag === 'reason') {
      const r = cl.items[1];
      if (!r || r.t !== 'str' || !r.v.trim() || cl.items.length !== 2) return fail('(reason "non-empty human-readable justification")', cl);
      reason = r.v;
    } else if (tag === 'fields') fields = cl.items.slice(1).map((x) => sym(x, 'Type.field', cl));
    else if (tag === 'fns') fns = cl.items.slice(1).map((x) => sym(x, 'function name', cl));
    else return fail(`unknown declassify clause ${tag}`, cl);
  }
  if (!from || !to || reason === undefined) return fail(`declassifier ${name} needs (from ...), (to ...) and a (reason "...")`, c);
  if (CONFS.indexOf(to) >= CONFS.indexOf(from)) return fail(`declassifier ${name}: (to ${to}) must be strictly lower than (from ${from})`, c);
  if ((fields && !fields.length) || (fns && !fns.length)) return fail(`declassifier ${name}: empty restriction list`, c);
  return { name, from, to, reason, fields, fns };
}

export function parsePolicy(src: string): Policy {
  const pol: Policy = { allow: [], sinks: new Map(), declassifiers: new Map() };
  for (const form of readAll(src)) {
    if (!isList(form) || !isSym(form.items[0], 'policy')) {
      fail('expected (policy ...)', form);
      continue;
    }
    for (const c of form.items.slice(1)) {
      if (!isList(c) || !isSym(c.items[0])) {
        fail('policy clause', c);
        continue;
      }
      const tag = (c.items[0] as { v: string }).v;
      if (tag === 'allow') {
        const kind = sym(c.items[1], 'capability kind', c);
        const scope = c.items[2];
        if (scope && isList(scope)) {
          const key = sym(scope.items[0], 'caveat key', scope);
          const pat = scope.items[1];
          pol.allow.push({ kind, key, pattern: pat && pat.t === 'str' ? pat.v : undefined });
        } else pol.allow.push({ kind });
      } else if (tag === 'sink') {
        const handle = sym(c.items[1], 'handle', c);
        const acc = c.items[2];
        if (!isList(acc) || !isSym(acc.items[0], 'accepts')) {
          fail('(sink handle (accepts conf))', c);
          continue;
        }
        const w = sym(acc.items[1], 'confidentiality level', acc);
        if (!(CONFS as string[]).includes(w)) fail(`unknown confidentiality ${w}`, acc);
        pol.sinks.set(handle, { accepts: w as Conf });
      } else if (tag === 'declassify') {
        const d = parseDeclassifier(c);
        if (d) {
          if (pol.declassifiers.has(d.name)) fail(`duplicate declassifier ${d.name}`, c);
          pol.declassifiers.set(d.name, d);
        }
      } else fail(`unknown policy clause ${tag}`, c);
    }
  }
  return pol;
}
