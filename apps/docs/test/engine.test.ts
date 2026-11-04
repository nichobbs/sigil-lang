import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DocsEngine, DEMO_DOCS, DOC_ERRORS, seed } from '../src/engine.js';
import { MemoryAuditLog, MemoryDocStore, type Json } from '../src/adapters.js';
import { handle } from '../src/http.js';
import { STATUS_OF } from '../src/routes.js';
import { SqliteAuditLog, SqliteDocStore, openDb } from '../src/sqlite.js';
import { makeServer } from '../src/server.js';

const SRC = readFileSync(new URL('../sigil/app.sigil', import.meta.url), 'utf8');
const mem = () => {
  const store = new MemoryDocStore();
  seed(store);
  const audit = new MemoryAuditLog();
  return { store, audit, engine: new DocsEngine(SRC, store, audit) };
};
const admin = { id: 1, role: 'Admin' as const };
const owner = { id: 10, role: 'Editor' as const };

describe('engine (load, decide, store)', () => {
  it('update stores the new record and audits Applied without the title', () => {
    const { engine, store, audit } = mem();
    const out = engine.act(owner, 1, 'Update', { title: 'Secret new title', size: 900 });
    expect(out).toEqual({ kind: 'ok', receipt: { doc: 1, status: 'Draft', size: 900 } });
    expect(store.get(1)).toEqual({ id: 1, owner: 10, title: 'Secret new title', size: 900, status: 'Draft' });
    expect(audit.all()).toEqual([{ actor: 10, doc: 1, op: 'Update' }]);
    expect(JSON.stringify(audit.all())).not.toContain('Secret');
  });
  it('a refusal stores nothing and audits the reason', () => {
    const { engine, store, audit } = mem();
    expect(engine.act({ id: 11, role: 'Editor' }, 1, 'Delete')).toEqual({ kind: 'refused', reason: 'NotAllowed' });
    expect((store.get(1) as { status: string }).status).toBe('Draft');
    expect(audit.all()).toEqual([{ actor: 11, doc: 1, op: 'Delete', reason: 'NotAllowed' }]);
  });
  it('a failing store gives StoreFailed and no audit', () => {
    const { engine, store, audit } = mem();
    store.failing = true;
    expect(engine.act(admin, 1, 'Publish')).toEqual({ kind: 'refused', reason: 'StoreFailed' });
    expect(audit.all()).toEqual([]);
  });
  it('unknown document is not-found; out-of-range input is bad-input', () => {
    const { engine } = mem();
    expect(engine.act(admin, 99, 'Delete')).toEqual({ kind: 'not-found' });
    expect(engine.act(admin, 1, 'Update', { title: 'x', size: 2_000_000 }).kind).toBe('bad-input');
  });
  it('view gates actions by role and state', () => {
    const { engine } = mem();
    expect(engine.view(owner, 1)).toMatchObject({ 'can-update': true, 'can-delete': true, 'can-publish': false });
    expect(engine.view(admin, 1)).toMatchObject({ 'can-publish': true });
    expect(engine.view(admin, 3)).toMatchObject({ 'can-publish': false }); // empty body
    expect(engine.view(admin, 2)).toMatchObject({ 'can-publish': false }); // already published
    expect(engine.view({ id: 5, role: 'Viewer' }, 1)).toMatchObject({ 'can-update': false, 'can-delete': false, 'can-publish': false });
  });
  it('every DocError has an HTTP status (exhaustive)', () => {
    for (const e of DOC_ERRORS) expect(STATUS_OF[e]).toBeGreaterThanOrEqual(400);
  });
});

describe('http layer', () => {
  const h = (a: { id: number; role: string }) => ({ 'x-actor-id': String(a.id), 'x-actor-role': a.role });
  it('maps outcomes to statuses', () => {
    const { engine } = mem();
    expect(handle(engine, { method: 'PATCH', path: '/docs/1', headers: h(owner), body: { title: 't', size: 60000 } }).status).toBe(413);
    expect(handle(engine, { method: 'POST', path: '/docs/3/publish', headers: h(admin) }).status).toBe(422);
    expect(handle(engine, { method: 'POST', path: '/docs/2/publish', headers: h(admin) }).status).toBe(409);
    expect(handle(engine, { method: 'DELETE', path: '/docs/1', headers: h({ id: 5, role: 'Viewer' }) }).status).toBe(403);
    expect(handle(engine, { method: 'DELETE', path: '/docs/1', headers: h(admin) }).status).toBe(200);
    expect(handle(engine, { method: 'GET', path: '/docs/1', headers: h(admin) }).body).toMatchObject({ status: 'Deleted' });
    expect(handle(engine, { method: 'DELETE', path: '/docs/1', headers: h(admin) }).status).toBe(410);
    expect(handle(engine, { method: 'GET', path: '/docs/77', headers: h(admin) }).status).toBe(404);
    expect(handle(engine, { method: 'GET', path: '/docs/1', headers: {} }).status).toBe(401);
    expect(handle(engine, { method: 'GET', path: '/nope', headers: h(admin) }).status).toBe(404);
  });
});

describe('differential: memory engine vs sqlite engine vs real HTTP server', () => {
  type Step = { actor: { id: number; role: string }; method: string; path: string; body?: Json };
  const steps: Step[] = [
    { actor: owner, method: 'PATCH', path: '/docs/1', body: { title: 'A', size: 10 } },
    { actor: { id: 11, role: 'Editor' }, method: 'DELETE', path: '/docs/1' },
    { actor: admin, method: 'POST', path: '/docs/1/publish' },
    { actor: admin, method: 'POST', path: '/docs/1/publish' },
    { actor: owner, method: 'PATCH', path: '/docs/1', body: { title: 'B', size: 70000 } },
    { actor: admin, method: 'DELETE', path: '/docs/2' },
    { actor: admin, method: 'PATCH', path: '/docs/2', body: { title: 'C', size: 1 } },
    { actor: admin, method: 'POST', path: '/docs/3/publish' },
  ];
  const hd = (a: Step['actor']) => ({ 'x-actor-id': String(a.id), 'x-actor-role': a.role });

  it('give identical statuses, bodies, stored documents and audit logs', async () => {
    const a = mem().engine;
    const db = openDb();
    const sstore = new SqliteDocStore(db);
    seed(sstore);
    const b = new DocsEngine(SRC, sstore, new SqliteAuditLog(db));
    const { server, engine: c } = makeServer();
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      for (const s of steps) {
        const ra = handle(a, { method: s.method, path: s.path, headers: hd(s.actor), body: s.body });
        const rb = handle(b, { method: s.method, path: s.path, headers: hd(s.actor), body: s.body });
        const rc = await fetch(`http://127.0.0.1:${port}${s.path}`, { method: s.method, headers: { ...hd(s.actor), 'content-type': 'application/json' }, body: s.body ? JSON.stringify(s.body) : undefined });
        expect({ status: rb.status, body: rb.body }).toEqual({ status: ra.status, body: ra.body });
        expect({ status: rc.status, body: await rc.json() }).toEqual({ status: ra.status, body: ra.body });
      }
      expect(b.auditLog()).toEqual(a.auditLog());
      expect(c.auditLog()).toEqual(a.auditLog());
      for (const d of DEMO_DOCS) {
        const id = (d as { id: number }).id;
        expect(b.view(admin, id)).toEqual(a.view(admin, id));
        expect(c.view(admin, id)).toEqual(a.view(admin, id));
      }
    } finally {
      server.close();
    }
  });
});
