// B1 tests: examples, always properties, privacy rules, integer boundaries.
import { describe, expect, it } from 'vitest';
import { makeHost } from './host';
import run from './solution';

type Role = 'Viewer' | 'Editor' | 'Admin';
type Status = 'Draft' | 'Published' | 'Deleted';
type Op = 'Update' | 'Delete' | 'Publish';
interface Doc { id: number; owner: number; title: string; size: number; status: Status }
interface Actor { id: number; role: Role }
interface Req { op: Op; title: string; size: number }

const MAX_ID = Number.MAX_SAFE_INTEGER;
const call = async (actor: Actor, doc: Doc, req: Req, failStore = false) => {
  const { host, effects } = makeHost(failStore ? { fail: [{ handle: 'store:docs', op: 'put' }] } : {});
  const res = await run({ actor, doc, req }, host);
  return { res, eff: effects() };
};
const D = (status: Status, size: number, owner = 5, title = 'T'): Doc => ({ id: 101, owner, title, size, status });
const R = (op: Op, title = '', size = 0): Req => ({ op, title, size });
const ADMIN: Actor = { id: 1, role: 'Admin' };

let seed = 12345;
const rnd = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const id = () => pick([0, 1, 2, 3, MAX_ID, Math.floor(rnd() * MAX_ID)]);
const size = () => pick([0, 1, 49999, 50000, 50001, 1000000, Math.floor(rnd() * 1000001)]);
const text = () => pick(['', 'a', 'Q3 plan', `t${Math.floor(rnd() * 1e9)}`]);
const gen = () => {
  const actor: Actor = { id: id(), role: pick(['Viewer', 'Editor', 'Admin'] as const) };
  const owner = rnd() < 0.4 ? actor.id : id();
  const doc: Doc = { id: id(), owner, title: text(), size: size(), status: pick(['Draft', 'Published', 'Deleted'] as const) };
  const req = R(pick(['Update', 'Delete', 'Publish'] as const), text(), size());
  return { actor, doc, req };
};
const forAll = async (f: (c: ReturnType<typeof gen>) => Promise<void>) => {
  for (let i = 0; i < 400; i++) await f(gen());
};

describe('examples', () => {
  const ed: Actor = { id: 5, role: 'Editor' };
  const viewer: Actor = { id: 7, role: 'Viewer' };
  const cases: [string, Actor, Doc, Req, boolean, unknown, unknown?][] = [
    ['editor updates own', ed, D('Draft', 800, 5, 'Q3 plan'), R('Update', 'Q3 plan v2', 1200), false, { ok: { doc: 101, status: 'Draft', size: 1200 } }, { ...D('Draft', 1200, 5, 'Q3 plan v2') }],
    ['admin updates published', ADMIN, D('Published', 5000, 5, 'Handbook'), R('Update', 'Handbook', 5100), false, { ok: { doc: 101, status: 'Published', size: 5100 } }, D('Published', 5100, 5, 'Handbook')],
    ['editor deletes own', ed, D('Published', 300, 5, 'Old notes'), R('Delete'), false, { ok: { doc: 101, status: 'Deleted', size: 300 } }, D('Deleted', 300, 5, 'Old notes')],
    ['admin publishes draft', ADMIN, D('Draft', 450, 5, 'Launch post'), R('Publish'), false, { ok: { doc: 101, status: 'Published', size: 450 } }, D('Published', 450, 5, 'Launch post')],
    ['viewer cannot', viewer, D('Draft', 10, 7), R('Delete'), false, { err: 'NotAllowed' }],
    ['editor cannot publish', ed, D('Draft', 10), R('Publish'), false, { err: 'NotAllowed' }],
    ['too long', ed, D('Draft', 10), R('Update', 'Book', 50001), false, { err: 'TooLong' }],
    ['deleted is gone', ed, D('Deleted', 10), R('Update', 'Back', 20), false, { err: 'Gone' }],
    ['already published', ADMIN, D('Published', 10), R('Publish'), false, { err: 'AlreadyPublished' }],
    ['store failed', ed, D('Draft', 10), R('Delete'), true, { err: 'StoreFailed' }],
  ];
  it.each(cases)('%s', async (_n, actor, doc, req, fail, result, stored) => {
    const { res, eff } = await call(actor, doc, req, fail);
    expect(res).toEqual(result);
    expect(eff.stored).toEqual(stored === undefined ? [] : [stored]);
    const err = (result as { err?: string }).err;
    const base = { actor: actor.id, doc: 101, op: req.op };
    expect(eff.emitted).toEqual(fail ? [] : err ? [{ ...base, reason: err }] : [base]);
  });
});

describe('always', () => {
  it('authorisation first', () =>
    forAll(async ({ actor, doc, req }) => {
      const denied =
        actor.role === 'Viewer' || (actor.role === 'Editor' && (actor.id !== doc.owner || req.op === 'Publish'));
      const { res } = await call(actor, doc, req);
      expect((res as { err?: string }).err === 'NotAllowed').toBe(denied);
      const plain = await call(actor, { ...doc, size: 0, status: 'Draft' }, R(req.op));
      expect((plain.res as { err?: string }).err === 'NotAllowed').toBe(denied);
    }));

  it('deleted is gone', () =>
    forAll(async ({ doc, req }) => {
      const d = { ...doc, status: 'Deleted' as const };
      expect((await call(ADMIN, d, req)).res).toEqual({ err: 'Gone' });
      if (req.op !== 'Publish')
        expect((await call({ id: d.owner, role: 'Editor' }, d, req)).res).toEqual({ err: 'Gone' });
    }));

  it('update', () =>
    forAll(async ({ doc, req }) => {
      if (doc.status === 'Deleted') return;
      const { res } = await call(ADMIN, doc, { ...req, op: 'Update' });
      expect(res).toEqual(
        req.size > 50000 ? { err: 'TooLong' } : { ok: { doc: doc.id, status: doc.status, size: req.size } },
      );
    }));

  it('delete and publish', () =>
    forAll(async ({ doc, req }) => {
      if (doc.status === 'Deleted') return;
      const del = await call(ADMIN, doc, { ...req, op: 'Delete' });
      expect(del.res).toEqual({ ok: { doc: doc.id, status: 'Deleted', size: doc.size } });
      expect(del.eff.stored).toEqual([{ ...doc, status: 'Deleted' }]);
      if (doc.status === 'Published' || doc.size === 0) return;
      const pub = await call(ADMIN, doc, { ...req, op: 'Publish' });
      expect(pub.res).toEqual({ ok: { doc: doc.id, status: 'Published', size: doc.size } });
      expect(pub.eff.stored).toEqual([{ ...doc, status: 'Published' }]);
    }));

  it('publish refusals and precedence', () =>
    forAll(async ({ doc, req }) => {
      const pub = { ...req, op: 'Publish' as const };
      const upd = { ...req, op: 'Update' as const, size: 60000 };
      const x = { ...doc, size: 0 };
      expect((await call(ADMIN, { ...doc, status: 'Published' }, pub)).res).toEqual({ err: 'AlreadyPublished' });
      expect((await call(ADMIN, { ...x, status: 'Draft' }, pub)).res).toEqual({ err: 'EmptyBody' });
      expect((await call({ id: 1, role: 'Viewer' }, { ...x, status: 'Deleted' }, upd)).res).toEqual({ err: 'NotAllowed' });
      expect((await call(ADMIN, { ...x, status: 'Deleted' }, upd)).res).toEqual({ err: 'Gone' });
      expect((await call(ADMIN, { ...x, status: 'Published' }, upd)).res).toEqual({ err: 'TooLong' });
      expect((await call(ADMIN, { ...x, status: 'Published' }, pub)).res).toEqual({ err: 'AlreadyPublished' });
    }));

  it('effects', () =>
    forAll(async ({ actor, doc, req }) => {
      const { res, eff } = await call(actor, doc, req);
      const base = { actor: actor.id, doc: doc.id, op: req.op };
      if (res.ok) {
        expect(res.ok.doc).toBe(doc.id);
        expect(eff.stored).toHaveLength(1);
        expect(eff.emitted).toEqual([base]);
      } else {
        expect(res.err).not.toBe('StoreFailed');
        expect(eff.stored).toEqual([]);
        expect(eff.emitted).toEqual([{ ...base, reason: res.err }]);
      }
    }));
});

describe('privacy', () => {
  it.each(['doc', 'req'] as const)('%s title never audited and never changes audit', (which) =>
    forAll(async ({ actor, doc, req }) => {
      const t = (s: string) => ({
        doc: { ...doc, title: which === 'doc' ? s : doc.title },
        req: { ...req, title: which === 'req' ? s : req.title },
      });
      const a = t('SECRET-alpha-1'), b = t('SECRET-beta-22');
      const ra = await call(actor, a.doc, a.req), rb = await call(actor, b.doc, b.req);
      expect(JSON.stringify(ra.eff.emitted)).not.toContain('SECRET');
      expect(ra.eff.emitted).toEqual(rb.eff.emitted);
      expect(ra.res).toEqual(rb.res);
    }));
});

describe('boundaries', () => {
  it.each([
    [0, 'ok'], [50000, 'ok'], [50001, 'TooLong'], [1000000, 'TooLong'],
  ] as const)('update to size %i', async (n, out) => {
    const { res } = await call(ADMIN, D('Draft', 1000000), R('Update', 'x', n));
    expect(res).toEqual(out === 'ok' ? { ok: { doc: 101, status: 'Draft', size: n } } : { err: out });
  });

  it('max ids and max size pass through', async () => {
    const doc = { id: MAX_ID, owner: MAX_ID, title: 'x', size: 1000000, status: 'Draft' as const };
    const { res, eff } = await call({ id: MAX_ID, role: 'Editor' }, doc, R('Delete'));
    expect(res).toEqual({ ok: { doc: MAX_ID, status: 'Deleted', size: 1000000 } });
    expect(eff.emitted).toEqual([{ actor: MAX_ID, doc: MAX_ID, op: 'Delete' }]);
    expect((await call({ id: 0, role: 'Editor' }, { ...doc, owner: 0, id: 0 }, R('Update', 'y', 0))).res).toEqual({
      ok: { doc: 0, status: 'Draft', size: 0 },
    });
  });
});
