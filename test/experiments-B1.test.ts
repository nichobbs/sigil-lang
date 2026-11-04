// B1 (document service): both reference solutions must pass 100%, and deliberately broken variants must be caught,
// with trap variants raising trapViolations. If a variant here stops being caught, the hidden cases got weaker.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTask } from '../experiments/run.js';

const B1 = 'B1-document-service';
const B1_SIGIL = `experiments/tasks/${B1}/ref/sigil/app.sigil`;
const B1_TS = `experiments/tasks/${B1}/ref/ts/solution.ts`;
const tmp = mkdtempSync(join(tmpdir(), 'sigil-exp-b1-'));

interface Variant {
  name: string;
  edits: [from: string, to: string][]; // each `from` must occur exactly once in the reference
  trap: boolean; // a trap case must fail
}

function variantFile(refPath: string, v: Variant, ext: 'sigil' | 'ts', idx: number): string {
  let src = readFileSync(refPath, 'utf8');
  for (const [from, to] of v.edits) {
    if (src.split(from).length !== 2) throw new Error(`variant "${v.name}": the reference must contain the text to replace exactly once: ${from}`);
    src = src.replace(from, to);
  }
  const file = join(tmp, `${ext}-${idx}.${ext}`);
  writeFileSync(file, src);
  return file;
}

const SIGIL_VARIANTS: Variant[] = [
  { name: 'off-by-one: exactly the maximum size is TooLong', edits: [['(> r.size 50000)', '(>= r.size 50000)']], trap: false },
  {
    name: 'Gone is checked before the authorisation',
    edits: [['(if (not (authorised a d r.op))', '(if (and (not (= d.status Deleted)) (not (authorised a d r.op)))']],
    trap: false,
  },
  {
    name: 'EmptyBody is reported before AlreadyPublished',
    edits: [
      [
        '(if (= d.status Published)\n                   (err AlreadyPublished)\n                   (if (= d.size 0) (err EmptyBody) (ok true)))',
        '(if (= d.size 0)\n                   (err EmptyBody)\n                   (if (= d.status Published) (err AlreadyPublished) (ok true)))',
      ],
    ],
    trap: false,
  },
  { name: 'update keeps the old title', edits: [['(Update (Doc d.id d.owner r.title r.size d.status))', '(Update (Doc d.id d.owner d.title r.size d.status))']], trap: false },
  { name: 'delete takes the size from the request', edits: [['(Delete (Doc d.id d.owner d.title d.size Deleted))', '(Delete (Doc d.id d.owner d.title r.size Deleted))']], trap: false },
  { name: 'missing effect: no Applied audit event', edits: [['(emit audit (Applied actor.id doc.id req.op))', '']], trap: false },
  { name: 'missing effect: the new document is not stored', edits: [['(try (put store:docs doc.id nd) :on-err StoreFailed)', '']], trap: false },
  {
    name: 'refusals are not audited',
    edits: [['(err e (do (emit audit (Refused actor.id doc.id req.op e))\n               (err e)))', '(err e (err e))']],
    trap: false,
  },
  {
    name: 'title leaks into the Applied audit event',
    edits: [
      ['(type Applied (rec (actor Id) (doc Id) (op Op)))', '(type Applied (rec (actor Id) (doc Id) (op Op) (title Str)))'],
      ['(Applied actor.id doc.id req.op)', '(Applied actor.id doc.id req.op nd.title)'],
    ],
    trap: false,
  },
  {
    name: 'trap: an Admin may act on a Deleted document',
    edits: [['(if (= d.status Deleted)\n      (err Gone)', '(if (and (= d.status Deleted) (not (= a.role Admin)))\n      (err Gone)']],
    trap: true,
  },
  {
    name: 'trap: an Editor may delete someone else\'s document',
    edits: [['(Editor (and (= a.id d.owner) (not (= op Publish))))', '(Editor (match op (Update (= a.id d.owner)) (Delete true) (Publish false)))']],
    trap: true,
  },
  {
    name: 'trap: the document title leaks into the refusal audit event',
    edits: [
      ['(type Refused (rec (actor Id) (doc Id) (op Op) (reason DocError)))', '(type Refused (rec (actor Id) (doc Id) (op Op) (reason DocError) (title Str)))'],
      ['(Refused actor.id doc.id req.op e)', '(Refused actor.id doc.id req.op e doc.title)'],
    ],
    trap: true,
  },
];

const TS_VARIANTS: Variant[] = [
  { name: 'off-by-one: exactly the maximum size is TooLong', edits: [['req.size > MAX_SIZE', 'req.size >= MAX_SIZE']], trap: false },
  {
    name: 'Gone is checked before the authorisation',
    edits: [["if (!authorised(args)) return 'NotAllowed';\n  if (doc.status === 'Deleted') return 'Gone';", "if (doc.status === 'Deleted') return 'Gone';\n  if (!authorised(args)) return 'NotAllowed';"]],
    trap: false,
  },
  {
    name: 'EmptyBody is reported before AlreadyPublished',
    edits: [["if (doc.status === 'Published') return 'AlreadyPublished';\n    if (doc.size === 0) return 'EmptyBody';", "if (doc.size === 0) return 'EmptyBody';\n    if (doc.status === 'Published') return 'AlreadyPublished';"]],
    trap: false,
  },
  { name: 'update keeps the old title', edits: [['title: req.title, size: req.size', 'title: doc.title, size: req.size']], trap: false },
  {
    name: 'delete takes the size from the request',
    edits: [["return { id: doc.id, owner: doc.owner, title: doc.title, size: doc.size, status: 'Deleted' };", "return { id: doc.id, owner: doc.owner, title: doc.title, size: req.size, status: 'Deleted' };"]],
    trap: false,
  },
  { name: 'missing effect: no Applied audit event', edits: [["await host.audit.emit('audit', { actor: actor.id, doc: doc.id, op: req.op });", '']], trap: false },
  { name: 'missing effect: the new document is not stored', edits: [["const stored = await host.store.put('store:docs', doc.id, next);", 'const stored = { ok: true };']], trap: false },
  { name: 'refusals are not audited', edits: [["await host.audit.emit('audit', { actor: actor.id, doc: doc.id, op: req.op, reason });", '']], trap: false },
  {
    name: 'title leaks into the Applied audit event',
    edits: [["await host.audit.emit('audit', { actor: actor.id, doc: doc.id, op: req.op });", "await host.audit.emit('audit', { actor: actor.id, doc: doc.id, op: req.op, title: doc.title });"]],
    trap: false,
  },
  { name: 'trap: an Admin may act on a Deleted document', edits: [["if (doc.status === 'Deleted') return 'Gone';", "if (doc.status === 'Deleted' && actor.role !== 'Admin') return 'Gone';"]], trap: true },
  {
    name: "trap: an Editor may delete someone else's document",
    edits: [["return actor.id === doc.owner && req.op !== 'Publish';", "return req.op === 'Delete' || (actor.id === doc.owner && req.op !== 'Publish');"]],
    trap: true,
  },
  {
    name: 'trap: the document title leaks into the refusal audit event',
    edits: [["{ actor: actor.id, doc: doc.id, op: req.op, reason }", '{ actor: actor.id, doc: doc.id, op: req.op, reason, title: doc.title }']],
    trap: true,
  },
];

describe('experiments harness: B1 document service', () => {
  it('Sigil reference passes 100%', async () => {
    const s = await runTask(B1, 'sigil', B1_SIGIL);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.total).toBeGreaterThanOrEqual(28);
    expect(s.total).toBeLessThanOrEqual(45);
    expect(s.trapTotal).toBeGreaterThanOrEqual(2);
    expect(s.trapViolations).toBe(0);
  });

  SIGIL_VARIANTS.forEach((v, i) => {
    it(`Sigil catches: ${v.name}`, async () => {
      const s = await runTask(B1, 'sigil', variantFile(B1_SIGIL, v, 'sigil', 100 + i));
      expect(s.passed).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations).toBeGreaterThan(0);
    });
  });

  it('TypeScript reference passes 100%', async () => {
    const s = await runTask(B1, 'ts', B1_TS);
    expect(s.failures).toEqual([]);
    expect(s.passed).toBe(s.total);
    expect(s.trapViolations).toBe(0);
  }, 30_000);

  it('TypeScript catches every broken variant (and flags trap violations)', async () => {
    const results = await Promise.all(TS_VARIANTS.map((v, i) => runTask(B1, 'ts', variantFile(B1_TS, v, 'ts', 100 + i))));
    results.forEach((s, i) => {
      const v = TS_VARIANTS[i];
      expect(s.passed, v.name).toBeLessThan(s.total);
      if (v.trap) expect(s.trapViolations, v.name).toBeGreaterThan(0);
    });
  }, 30_000);
});
