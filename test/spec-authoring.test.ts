import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { coverage, diffGlossary, effects, gate, parseApprovals, parseEntries, parseOwners, proposalHash, requiredRoles, tags } from '../src/spec.js';

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
