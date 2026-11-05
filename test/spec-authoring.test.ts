import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { coverage, diffGlossary, effects, gate, parseApprovals, parseEntries, parseOwners, policyNotes, proposalHash, renderReview, requiredRoles, sinkPolicy, tags, treeDiff, declaredDeclassifiers } from '../src/spec.js';

const BASE = `(glossary
  (given "a {role:Role} actor {id:Int}" (set actor (Actor id role)))
  (given "the payment store is unavailable" (fail store:payments put))
  (when "{amount:Money} is refunded" (call result refund actor payment amount))
  (then "the refund succeeds" (expect (match result (ok r true) (err e false))))
  (then "an audit event records the refund of {amount:Money}"
    (expect (= (emitted audit) (list (RefundIssued actor.id payment.id amount)))))
  (always "A refund must be at least 1 cent."
    (forall ((p Payment)) (= (refund p 0) (err BadAmount))))
  (privacy "The card never appears in the audit log." (source Payment.card) (run refund)))`;

const OWNERS = `(owners (owner nic) (reviewers (privacy alice bob) (qa carol))
  (require (privacy privacy) (declassified privacy) (sink-observation privacy) (removal qa) (property qa)))`;

const withAudit = (extra: string) => BASE.replace('amount)))))', `amount ${extra})))))`);

describe('spec: entries, effects, tags', () => {
  it('derives effects structurally', () => {
    const e = parseEntries(BASE);
    expect(effects(e[4])).toEqual(['builds RefundIssued(actor.id payment.id amount)', 'observes emitted audit']);
    expect(effects(e[1])).toEqual(['injects failure store:payments put']);
    expect(tags(e[0])).toEqual(['fixture']);
    expect(tags(e[4])).toEqual(['sink-observation']);
    expect(tags(e[5])).toEqual(['property']);
    expect(tags(e[6])).toContain('privacy');
  });

  it('constructors in fixtures and property inputs are not sink observations; only inside expect', () => {
    const e = parseEntries('(glossary (given "g" (set a (Actor 1 Admin))) (then "t" (expect (= (emitted audit) (list (Ev 1))))))');
    expect(tags(e[0])).toEqual(['fixture']);
    expect(tags(e[1])).toEqual(['sink-observation']);
  });

  it('rejects duplicates and unknown heads', () => {
    expect(() => parseEntries('(glossary (given "x" (set a 1)) (given "x" (set a 2)))')).toThrow(/duplicate/);
    expect(() => parseEntries('(glossary (nope "x"))')).toThrow(/unknown glossary entry/);
  });
});

describe('spec: diff', () => {
  const base = parseEntries(BASE);
  it('no change, no diff', () => expect(diffGlossary(base, parseEntries(BASE))).toEqual([]));

  it('an added audit field is a changed sink-observation with an effect delta', () => {
    const d = diffGlossary(base, parseEntries(withAudit('(digit-sum payment.card)')));
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe('changed');
    expect(d[0].tags).toEqual(['sink-observation']);
    expect(d[0].effectDelta).toEqual(['+ builds RefundIssued(actor.id payment.id amount (digit-sum payment.card))', '- builds RefundIssued(actor.id payment.id amount)']);
  });

  it('removing a property or privacy rule carries the removal tag', () => {
    const without = parseEntries(BASE.replace(/\n  \(always[\s\S]*?BadAmount\)\)\)\)/, ''));
    const d = diffGlossary(base, without);
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe('removed');
    expect(d[0].tags).toEqual(['property', 'removal']);
  });

  it('adding a declassified exemption to a privacy rule is tagged declassified', () => {
    const d = diffGlossary(base, parseEntries(BASE.replace('(run refund)', '(declassified card-band) (run refund)')));
    expect(d[0].tags).toContain('declassified');
  });
});

describe('spec: gate', () => {
  const owners = parseOwners(OWNERS);
  const base = parseEntries(BASE);
  const changes = diffGlossary(base, parseEntries(withAudit('(digit-sum payment.card)')));
  const hash = proposalHash(BASE, withAudit('(digit-sum payment.card)'));
  const ap = (by: string, role: string, proposal = hash) => `(approve (proposal "${proposal}") (by ${by}) (role ${role}) (at "t"))`;

  it('requires the owner always, and a privacy reviewer for sink observation', () => {
    expect(requiredRoles(changes, owners).map((r) => r.role).sort()).toEqual(['owner', 'privacy']);
  });

  it('owner alone is not enough', () => {
    const g = gate(changes, owners, parseApprovals(ap('nic', 'owner')), hash);
    expect(g.ok).toBe(false);
    expect(g.missing.map((m) => m.role)).toEqual(['privacy']);
  });

  it('owner plus a listed privacy reviewer passes', () => {
    const g = gate(changes, owners, parseApprovals(`${ap('nic', 'owner')}\n${ap('alice', 'privacy')}`), hash);
    expect(g.ok).toBe(true);
  });

  it('the owner cannot sign as a reviewer role they are not listed in', () => {
    const g = gate(changes, owners, parseApprovals(`${ap('nic', 'owner')}\n${ap('nic', 'privacy')}`), hash);
    expect(g.ok).toBe(false);
    expect(g.ignored.join()).toMatch(/not listed as privacy/);
  });

  it('an approval for an earlier version of the proposal does not count', () => {
    const stale = proposalHash(BASE, withAudit('(digit-sum payment.id)'));
    const g = gate(changes, owners, parseApprovals(`${ap('nic', 'owner')}\n${ap('alice', 'privacy', stale)}`), hash);
    expect(g.ok).toBe(false);
    expect(g.ignored.join()).toMatch(/different or since-edited/);
  });

  it('a fixture-only change needs only the owner', () => {
    const p = BASE.replace('(set actor (Actor id role))', '(set actor (Actor id role))\n    (default x 1)');
    const ch = diffGlossary(base, parseEntries(p));
    expect(requiredRoles(ch, owners).map((r) => r.role)).toEqual(['owner']);
  });

  it('owners file with a required role that has no reviewers is rejected', () => {
    expect(() => parseOwners('(owners (owner nic) (require (privacy privacy)))')).toThrow(/no reviewers/);
  });
});

describe('spec: coverage', () => {
  const feature = `Feature: x
  Always: A refund must be at least 1 cent.
  Example: e
    Given a Support actor 11
    When $5.00 is refunded
    Then the refund succeeds
    And something nobody bound`;
  it('reports unbound steps, unused phrases and missing paragraphs', () => {
    const c = coverage(feature, parseEntries(BASE));
    expect(c.unbound).toEqual(['something nobody bound']);
    expect(c.unused).toContain('given the payment store is unavailable');
    expect(c.missingParagraphs).toEqual(['privacy The card never appears in the audit log.']);
  });
});

describe('spec: CLI end to end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-spec-'));
  const cli = (...a: string[]) => {
    try {
      return { code: 0, out: execFileSync('npx', ['tsx', 'src/cli.ts', 'spec', ...a], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return { code: x.status ?? 1, out: `${x.stdout ?? ''}${x.stderr ?? ''}` };
    }
  };
  writeFileSync(join(dir, 'glossary.sigil'), BASE);
  writeFileSync(join(dir, 'spec.owners'), OWNERS);

  it('init, direct edit detected, proposal blocked until signed, then promoted', () => {
    expect(cli('init', dir, '--as', 'mallory').code).toBe(2);
    expect(cli('init', dir, '--as', 'nic').code).toBe(0);
    expect(cli('check', dir).code).toBe(0);

    writeFileSync(join(dir, 'proposed-glossary.sigil'), withAudit('(digit-sum payment.card)'));
    const rev = cli('review', dir);
    expect(rev.out).toContain('NOT READY');
    expect(rev.out).toContain('builds RefundIssued(actor.id payment.id amount (digit-sum payment.card))');

    expect(cli('promote', dir).code).toBe(1);
    expect(cli('approve', dir, '--as', 'nic', '--role', 'owner').code).toBe(0);
    expect(cli('approve', dir, '--as', 'nic', '--role', 'privacy').code).toBe(2);
    expect(cli('promote', dir).code).toBe(1);
    expect(cli('approve', dir, '--as', 'bob', '--role', 'privacy').code).toBe(0);
    expect(cli('review', dir).out).toContain('READY TO PROMOTE');

    const p = cli('promote', dir);
    expect(p.code).toBe(0);
    expect(existsSync(join(dir, 'proposed-glossary.sigil'))).toBe(false);
    expect(readFileSync(join(dir, 'glossary.sigil'), 'utf8')).toContain('digit-sum');
    expect(cli('check', dir).code).toBe(0);
  });

  it('editing glossary.sigil directly fails check', () => {
    writeFileSync(join(dir, 'glossary.sigil'), `${readFileSync(join(dir, 'glossary.sigil'), 'utf8')}\n; sneaky`);
    expect(cli('check', dir).code).toBe(1);
  });
});

describe('spec: promote edge cases', () => {
  const cli = (...a: string[]) => {
    const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'spec', ...a], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  };
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), 'sigil-spec-edge-'));
    writeFileSync(join(d, 'glossary.sigil'), BASE);
    writeFileSync(join(d, 'spec.owners'), OWNERS);
    // A fixture-only change: only the owner has to sign.
    writeFileSync(join(d, 'proposed-glossary.sigil'), BASE.replace('(set actor (Actor id role))', '(set actor (Actor id role))\n    (default x 1)'));
    return d;
  };

  it('promote without spec.history still works but warns that there is no tamper check', () => {
    const d = fresh();
    expect(cli('approve', d, '--as', 'nic', '--role', 'owner').code).toBe(0);
    const r = cli('promote', d);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no spec\.history.*no tamper check/);
    expect(existsSync(join(d, 'spec.history'))).toBe(true); // promote starts the history
    expect(cli('check', d).code).toBe(0);
  });

  it('a promote that dies after recording history but before writing the glossary is flagged by check', () => {
    const d = fresh();
    expect(cli('init', d, '--as', 'nic').code).toBe(0);
    // Simulate the crash window: the history line for the new glossary exists, glossary.sigil is still the old one.
    const proposed = readFileSync(join(d, 'proposed-glossary.sigil'), 'utf8');
    appendFileSync(join(d, 'spec.history'), `(promoted (glossary-sha "${createHash('sha256').update(proposed).digest('hex')}") (proposal "x") (by nic) (at "t"))\n`);
    const r = cli('check', d);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/differs from the last promoted version/);
  });
});

describe('spec: edits inside entries and policy join', () => {
  const G = (body: string) => `(glossary ${body})`;
  const one = (src: string) => parseEntries(G(src))[0];
  const owners = parseOwners(OWNERS);

  it('lists a changed constant and tags it constant-change', () => {
    const a = G('(always "cap" (forall ((m Int)) (= (refund m) (> m 20000))))');
    const b = G('(always "cap" (forall ((m Int)) (= (refund m) (> m 200000))))');
    const d = diffGlossary(parseEntries(a), parseEntries(b));
    expect(d[0].kind === 'changed' && d[0].detail.join('\n')).toMatch(/20000 changed to 200000/);
    expect(d[0].tags).toContain('constant-change');
  });

  it('lists a removed expect line and tags it check-removed, and the removed field assertion shows as an effect', () => {
    const a = G('(then "x" (expect (= (len (emitted audit)) 1)) (expect (= (map (emitted audit) (fn (e) e.amount)) (list amount))))');
    const b = G('(then "x" (expect (= (len (emitted audit)) 1)))');
    const d = diffGlossary(parseEntries(a), parseEntries(b))[0];
    expect(d.kind === 'changed' && d.detail.some((x) => /removed \(expect/.test(x))).toBe(true);
    expect(d.tags).toContain('check-removed');
    expect(d.effectDelta).toEqual(['- asserts field amount of emitted audit']);
  });

  it('derives field and count assertions on observed sinks', () => {
    expect(effects(one('(then "x" (expect (= (map (emitted audit) (fn (e) e.reason)) (list r))) (expect (= (len (emitted audit)) 1)))'))).toEqual(
      expect.arrayContaining(['asserts field reason of emitted audit', 'asserts count of emitted audit', 'observes emitted audit']),
    );
  });

  it('treeDiff is empty for equal forms and reports an added conjunct', () => {
    const x = one('(always "p" (and a b))').sexp;
    expect(treeDiff(x, x)).toEqual([]);
    expect(treeDiff(x, one('(always "p" (and a b c))').sexp).join('')).toMatch(/added c/);
  });

  it('policy join warns when a privacy entry allows a sink the policy limits', () => {
    const pol = sinkPolicy('(policy (sink store:payments (accepts pii)) (sink audit (accepts internal)))');
    expect(pol.get('audit')).toEqual(['internal']);
    const a = G('(privacy "p" (source Payment.card) (allow store:payments) (run refund))');
    const b = G('(privacy "p" (source Payment.card) (allow store:payments) (allow audit) (run refund))');
    const ch = diffGlossary(parseEntries(a), parseEntries(b));
    expect(policyNotes(ch, pol).join('\n')).toMatch(/WARNING: policy.sigil limits sink audit to internal/);
    const text = renderReview({ changes: ch, gate: gate(ch, owners, [], 'h'), hash: 'h', owners, policy: pol });
    expect(text).toContain('## Policy notes');
  });

  it('review text no longer claims "no change" when entries were edited internally', () => {
    const a = G('(always "cap" (forall ((m Int)) (> m 20000)))');
    const b = G('(always "cap" (forall ((m Int)) (> m 200000)))');
    const ch = diffGlossary(parseEntries(a), parseEntries(b));
    const text = renderReview({ changes: ch, gate: gate(ch, owners, [], 'h'), hash: 'h', owners });
    expect(text).not.toContain('No change to observable effects');
    expect(text).toContain('## Edits inside entries');
  });

  it('a changed constant and a dropped conjunct are tagged from structured edits', () => {
    const d1 = diffGlossary(parseEntries(G('(always "p" (> m 1))')), parseEntries(G('(always "p" (> m 2))')))[0];
    expect(d1.tags).toContain('constant-change');
    const d2 = diffGlossary(parseEntries(G('(always "p" (and a b))')), parseEntries(G('(always "p" (and a))')))[0];
    expect(d2.tags).toContain('check-removed');
  });

  it('policy notes mention a removed check and an exempted declassifier that policy.sigil does not declare', () => {
    const pol = sinkPolicy('(policy (sink audit (accepts internal)))');
    const declared = declaredDeclassifiers('(policy (declassify qa-test-card (from pii) (to internal) (reason "r")))');
    expect([...declared]).toEqual(['qa-test-card']);
    const a = G('(privacy "p" (source Payment.card) (allow store:payments) (run refund))');
    const b = G('(privacy "p" (source Payment.card) (allow store:payments) (declassified made-up) (run refund))');
    expect(policyNotes(diffGlossary(parseEntries(a), parseEntries(b)), pol, declared).join('\n')).toMatch(/declassifier made-up is not declared in policy.sigil/);
    const c = G('(then "x" (expect (= (len (emitted audit)) 1)) (expect (= (map (emitted audit) (fn (e) e.amount)) (list amount))))');
    const e = G('(then "x" (expect (= (len (emitted audit)) 1)))');
    expect(policyNotes(diffGlossary(parseEntries(c), parseEntries(e)), pol, declared).join('\n')).toMatch(/check or observation was removed/);
  });
});

describe('spec: mutation regression', () => {
  it('review --mutation lists mutants a vacuous proposal stops killing', () => {
    const X = join(__dirname, '..', 'experiments', 'tasks');
    const dir = mkdtempSync(join(tmpdir(), 'sigil-mut-'));
    for (const f of ['glossary.sigil', 'intent.feature', 'policy.sigil', 'spec.owners']) writeFileSync(join(dir, f), readFileSync(join(X, 'X4-spec-review-hard', 'base', f)));
    writeFileSync(join(dir, 'proposed-glossary.sigil'), readFileSync(join(X, 'X4-spec-review-hard', 'proposals', 'Q02.sigil')));
    writeFileSync(join(dir, 'app.sigil'), readFileSync(join(X, 'D5-derived-open', 'ref', 'sigil', 'app.sigil')));
    const out = execFileSync('npx', ['tsx', 'src/cli.ts', 'spec', 'review', dir, '--mutation'], { encoding: 'utf8', stdio: 'pipe' });
    expect(out).toContain('## Mutation regression');
    expect(out).toContain('LOST: check-amount: < -> <=');
    const none = execFileSync('npx', ['tsx', 'src/cli.ts', 'spec', 'review', dir], { encoding: 'utf8', stdio: 'pipe' });
    expect(none).not.toContain('Mutation regression');
  }, 120000);
});
