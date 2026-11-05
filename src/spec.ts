// Spec authoring workflow: a spec-author agent proposes glossary changes, tooling renders what they
// would allow, named humans approve, and `promote` is the only way glossary.sigil changes.
// This module is pure (strings in, data out); spec-cli.ts does the file work.
// It reads the glossary at S-expression level on purpose: a proposal must be reviewable before an
// app.sigil exists, so nothing here needs the type environment.

import { createHash } from 'node:crypto';
import { isList, isSym, readAll, SExp, sexpToString, SigilError } from './sexpr.js';

export type Head = 'given' | 'when' | 'then' | 'rule' | 'always' | 'privacy';
const HEADS: Head[] = ['given', 'when', 'then', 'rule', 'always', 'privacy'];

export interface Entry {
  key: string; // "<head> <normalised phrase or paragraph>"
  head: Head;
  text: string;
  src: string; // canonical printed form, used for equality and display
  sexp: SExp;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function parseEntries(src: string): Entry[] {
  const forms = readAll(src);
  if (forms.length !== 1 || !isList(forms[0]) || !isSym(forms[0].items[0], 'glossary')) throw new SigilError('expected a single (glossary ...) form');
  const out: Entry[] = [];
  for (const e of forms[0].items.slice(1)) {
    if (!isList(e) || !isSym(e.items[0])) throw new SigilError('glossary entry', e.pos);
    const head = e.items[0].v as Head;
    if (!HEADS.includes(head)) throw new SigilError(`unknown glossary entry ${head}`, e.pos);
    const t = e.items[1];
    if (!t || t.t !== 'str') throw new SigilError(`${head}: expected a quoted phrase`, e.pos);
    const text = norm(t.v);
    out.push({ key: `${head} ${text}`, head, text, src: sexpToString(e), sexp: e });
  }
  const seen = new Set<string>();
  for (const e of out) {
    if (seen.has(e.key)) throw new SigilError(`duplicate glossary entry: ${e.key}`);
    seen.add(e.key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Effects: what an entry lets the spec observe or demand, derived structurally.
// ---------------------------------------------------------------------------

export function effects(e: Entry): string[] {
  const out = new Set<string>();
  // Constructors only matter where they are compared with something observed: (expect ...). A constructor
  // in a fixture (set actor (Actor id role)) or in a property's generated inputs builds a test input.
  const walk = (s: SExp, inExpect = false) => {
    if (!isList(s)) return;
    const h = s.items[0];
    const ex = inExpect || (isSym(h) && h.v === 'expect');
    if (isSym(h)) {
      if ((h.v === 'emitted' || h.v === 'stored' || h.v === 'sent') && isSym(s.items[1])) out.add(`observes ${h.v} ${s.items[1].v}`);
      if (h.v === 'fail' && isSym(s.items[1]) && isSym(s.items[2])) out.add(`injects failure ${s.items[1].v} ${s.items[2].v}`);
      if (h.v === 'call' && isSym(s.items[2])) out.add(`calls ${s.items[2].v}`);
      // A constructor application such as (RefundIssued actor.id payment.id amount reason): its field list is part of the contract.
      if (ex && /^[A-Z]/.test(h.v) && s.items.length > 1) out.add(`builds ${h.v}(${s.items.slice(1).map(sexpToString).join(' ')})`);
      if (h.v === 'declassified') out.add(`exempts declassifier(s) ${s.items.slice(1).map(sexpToString).join(' ')} from the privacy check`);
      if (h.v === 'allow' && e.head === 'privacy') out.add(`allows sink(s) ${s.items.slice(1).map(sexpToString).join(' ')} to see the source`);
      if (h.v === 'source' && e.head === 'privacy') out.add(`protects ${sexpToString(s.items[1])}`);
    }
    s.items.forEach((x) => walk(x, ex));
  };
  walk(e.sexp);
  if (e.head === 'always') out.add('asserts a property over generated inputs');
  if (e.head === 'rule') out.add('binds a decision table to a function');
  return [...out].sort();
}

export function tags(e: Entry): string[] {
  const t = new Set<string>();
  const fx = effects(e);
  if (e.head === 'privacy') t.add('privacy');
  if (fx.some((x) => x.startsWith('exempts'))) t.add('declassified');
  if (fx.some((x) => x.startsWith('allows sink'))) t.add('privacy-allow');
  if (fx.some((x) => x.startsWith('observes') || x.startsWith('builds'))) t.add('sink-observation');
  if (fx.some((x) => x.startsWith('injects'))) t.add('fault-injection');
  if (e.head === 'always') t.add('property');
  if (e.head === 'rule') t.add('decision-table');
  if (!t.size) t.add('fixture');
  return [...t].sort();
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type Change =
  | { kind: 'added'; after: Entry; tags: string[]; effectDelta: string[] }
  | { kind: 'removed'; before: Entry; tags: string[]; effectDelta: string[] }
  | { kind: 'changed'; before: Entry; after: Entry; tags: string[]; effectDelta: string[] };

const delta = (b: string[], a: string[]) => [...a.filter((x) => !b.includes(x)).map((x) => `+ ${x}`), ...b.filter((x) => !a.includes(x)).map((x) => `- ${x}`)];

export function diffGlossary(base: Entry[], proposed: Entry[]): Change[] {
  const bm = new Map(base.map((e) => [e.key, e]));
  const pm = new Map(proposed.map((e) => [e.key, e]));
  const out: Change[] = [];
  for (const p of proposed) {
    const b = bm.get(p.key);
    if (!b) out.push({ kind: 'added', after: p, tags: tags(p), effectDelta: delta([], effects(p)) });
    else if (b.src !== p.src) {
      const tg = [...new Set([...tags(b), ...tags(p)])].sort();
      out.push({ kind: 'changed', before: b, after: p, tags: tg, effectDelta: delta(effects(b), effects(p)) });
    }
  }
  for (const b of base) {
    // Dropping a check weakens the spec, so any removal other than a pure fixture carries the removal tag.
    if (!pm.has(b.key)) out.push({ kind: 'removed', before: b, tags: [...new Set([...tags(b), 'removal'])].sort(), effectDelta: delta(effects(b), []) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Feature coverage (approximate: placeholders match anything; `verify` is the exact check)
// ---------------------------------------------------------------------------

const phraseRx = (text: string) =>
  new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\w+:\w+\\\}/g, '.+?') + '$');

export interface Coverage {
  unbound: string[]; // feature steps no proposed phrase matches
  unused: string[]; // phrases no feature step uses
  missingParagraphs: string[]; // always/privacy/rule text not present in the feature
}

export function coverage(feature: string, entries: Entry[]): Coverage {
  const steps = [...feature.matchAll(/^\s*(?:Given|When|Then|And|But)\s+(.+?)\s*$/gm)].map((m) => norm(m[1]));
  const phrases = entries.filter((e) => e.head === 'given' || e.head === 'when' || e.head === 'then');
  const rx = phrases.map((p) => ({ p, rx: phraseRx(p.text) }));
  const unbound = [...new Set(steps)].filter((s) => !rx.some((r) => r.rx.test(s)));
  const unused = rx.filter((r) => !steps.some((s) => r.rx.test(s))).map((r) => r.p.key);
  const flat = norm(feature);
  const missingParagraphs = entries.filter((e) => e.head === 'always' || e.head === 'privacy' || e.head === 'rule').filter((e) => !flat.includes(e.text)).map((e) => e.key);
  return { unbound, unused, missingParagraphs };
}

// ---------------------------------------------------------------------------
// Owners, approvals, promotion gate
// ---------------------------------------------------------------------------

export interface Owners {
  owner: string;
  reviewers: Map<string, string[]>; // role -> names
  require: Map<string, string>; // tag -> role (or 'owner')
}

export function parseOwners(src: string): Owners {
  const forms = readAll(src);
  if (forms.length !== 1 || !isList(forms[0]) || !isSym(forms[0].items[0], 'owners')) throw new SigilError('spec.owners: expected a single (owners ...) form');
  const o: Owners = { owner: '', reviewers: new Map(), require: new Map() };
  for (const c of forms[0].items.slice(1)) {
    if (!isList(c) || !isSym(c.items[0])) throw new SigilError('spec.owners clause', c.pos);
    const h = c.items[0].v;
    const name = (s: SExp | undefined) => (s && (s.t === 'sym' || s.t === 'str') ? s.v : (() => { throw new SigilError('expected a name', c.pos); })());
    if (h === 'owner') o.owner = name(c.items[1]);
    else if (h === 'reviewers') {
      for (const r of c.items.slice(1)) {
        if (!isList(r)) throw new SigilError('(reviewers (role name ...) ...)', c.pos);
        const [role, ...names] = r.items.map(name);
        if (role === 'owner') throw new SigilError('"owner" is a reserved role', r.pos);
        o.reviewers.set(role, names);
      }
    } else if (h === 'require') {
      for (const r of c.items.slice(1)) {
        if (!isList(r) || r.items.length !== 2) throw new SigilError('(require (tag role) ...)', c.pos);
        o.require.set(name(r.items[0]), name(r.items[1]));
      }
    } else throw new SigilError(`spec.owners: unknown clause ${h}`, c.pos);
  }
  if (!o.owner) throw new SigilError('spec.owners: (owner NAME) is required');
  for (const [tag, role] of o.require) if (role !== 'owner' && !o.reviewers.has(role)) throw new SigilError(`spec.owners: (require (${tag} ${role})) names a role with no reviewers`);
  return o;
}

export interface Approval {
  proposal: string;
  by: string;
  role: string;
  at: string;
}

export function parseApprovals(src: string): Approval[] {
  if (!src.trim()) return [];
  return readAll(src).map((f) => {
    if (!isList(f) || !isSym(f.items[0], 'approve')) throw new SigilError('spec.approvals: expected (approve ...)');
    const get = (k: string) => {
      const c = f.items.slice(1).find((x) => isList(x) && isSym(x.items[0], k));
      const v = c && isList(c) ? c.items[1] : undefined;
      if (!v || (v.t !== 'sym' && v.t !== 'str')) throw new SigilError(`spec.approvals: missing ${k}`, f.pos);
      return v.v;
    };
    return { proposal: get('proposal'), by: get('by'), role: get('role'), at: get('at') };
  });
}

export const approvalLine = (a: Approval) => `(approve (proposal "${a.proposal}") (by ${a.by}) (role ${a.role}) (at "${a.at}"))\n`;

/** Hash binds an approval to this exact base and this exact proposal: any later edit invalidates it. */
export const proposalHash = (baseSrc: string, proposedSrc: string) =>
  sha256(`${parseEntries(baseSrc).map((e) => e.src).join('\n')}\n---\n${parseEntries(proposedSrc).map((e) => e.src).join('\n')}`);

export function requiredRoles(changes: Change[], o: Owners): { role: string; because: string[] }[] {
  const need = new Map<string, Set<string>>([['owner', new Set(['every promotion'])]]);
  for (const c of changes)
    for (const t of c.tags) {
      const r = o.require.get(t);
      if (!r) continue;
      if (!need.has(r)) need.set(r, new Set());
      need.get(r)!.add(t);
    }
  return [...need].map(([role, because]) => ({ role, because: [...because].sort() }));
}

export interface Gate {
  ok: boolean;
  satisfied: { role: string; by: string }[];
  missing: { role: string; because: string[]; candidates: string[] }[];
  ignored: string[]; // approvals that did not count, with the reason
}

export function gate(changes: Change[], o: Owners, approvals: Approval[], hash: string): Gate {
  const g: Gate = { ok: true, satisfied: [], missing: [], ignored: [] };
  const valid = approvals.filter((a) => {
    if (a.proposal !== hash) return (g.ignored.push(`${a.by} (${a.role}): approval is for a different or since-edited proposal`), false);
    const members = a.role === 'owner' ? [o.owner] : (o.reviewers.get(a.role) ?? []);
    if (!members.includes(a.by)) return (g.ignored.push(`${a.by} is not listed as ${a.role} in spec.owners`), false);
    return true;
  });
  for (const r of requiredRoles(changes, o)) {
    const hit = valid.find((a) => a.role === r.role);
    if (hit) g.satisfied.push({ role: r.role, by: hit.by });
    else {
      g.ok = false;
      g.missing.push({ ...r, candidates: r.role === 'owner' ? [o.owner] : (o.reviewers.get(r.role) ?? []) });
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Review packet
// ---------------------------------------------------------------------------

export function renderReview(opts: { changes: Change[]; cov?: Coverage; gate: Gate; hash: string; owners: Owners }): string {
  const { changes, cov, gate: g, hash, owners } = opts;
  const L: string[] = [];
  L.push(`# Glossary proposal ${hash.slice(0, 12)}`, '');
  if (!changes.length) {
    L.push('No differences from glossary.sigil.');
    return L.join('\n');
  }
  const count = (k: string) => changes.filter((c) => c.kind === k).length;
  L.push(`${count('added')} added, ${count('changed')} changed, ${count('removed')} removed.`, '');

  const risky = changes.filter((c) => c.tags.some((t) => owners.require.has(t)));
  L.push('## What this proposal would allow', '');
  const fx = changes.flatMap((c) => c.effectDelta);
  if (!fx.length) L.push('No change to observable effects (fixtures only).');
  for (const x of [...new Set(fx)]) L.push(`- ${x}`);
  L.push('');

  L.push('## Changes', '');
  for (const c of changes) {
    const e = c.kind === 'removed' ? c.before : c.after;
    L.push(`### ${c.kind.toUpperCase()}: ${e.head} "${e.text}"`);
    L.push(`tags: ${c.tags.join(', ')}${c.tags.some((t) => owners.require.has(t)) ? `   (needs: ${[...new Set(c.tags.map((t) => owners.require.get(t)).filter(Boolean))].join(', ')})` : ''}`);
    if (c.effectDelta.length) L.push('effects:', ...c.effectDelta.map((x) => `  ${x}`));
    if (c.kind === 'changed') L.push('before:', '```', c.before.src, '```');
    L.push(c.kind === 'removed' ? 'removed:' : 'after:', '```', (c.kind === 'removed' ? c.before : c.after).src, '```', '');
  }

  if (cov) {
    L.push('## Coverage against the feature file (approximate; verify is exact)', '');
    if (!cov.unbound.length && !cov.unused.length && !cov.missingParagraphs.length) L.push('Every step is bound, every phrase is used, every property paragraph is in the feature.');
    for (const s of cov.unbound) L.push(`- UNBOUND step: ${s}`);
    for (const s of cov.missingParagraphs) L.push(`- NOT IN FEATURE: ${s}`);
    for (const s of cov.unused) L.push(`- unused phrase: ${s}`);
    L.push('');
  }

  L.push('## Sign-off', '');
  L.push(`Highest-risk changes: ${risky.length ? risky.length : 'none'}.`);
  for (const s of g.satisfied) L.push(`- [x] ${s.role}: ${s.by}`);
  for (const m of g.missing) L.push(`- [ ] ${m.role} (${m.because.join(', ')}); one of: ${m.candidates.join(', ')}`);
  for (const i of g.ignored) L.push(`- ignored: ${i}`);
  L.push('', g.ok ? 'READY TO PROMOTE' : 'NOT READY: sign-off incomplete');
  return L.join('\n');
}
