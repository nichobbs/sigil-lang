// The docs app on compiled Wasm must be indistinguishable from the same app on the reference interpreter:
// same outcomes, same stored documents, same audit log, same view models, over long random request sequences,
// including store failures and out-of-range input.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryAuditLog, MemoryDocStore, type Json } from '../src/adapters.js';
import { DocsEngine, seed, type Actor, type Op } from '../src/engine.js';
import { handle } from '../src/http.js';
import { SqliteAuditLog, SqliteDocStore, openDb } from '../src/sqlite.js';
import { reportsFromJson } from '../src/wasmio.js';
import { mulberry32 } from '../../../src/interp.js';

const dir = new URL('..', import.meta.url).pathname;
const SRC = readFileSync(`${dir}sigil/app.sigil`, 'utf8');
let bytes: Uint8Array;
let reports: ReturnType<typeof reportsFromJson>;

beforeAll(() => {
  execFileSync('npx', ['tsx', `${dir}build-wasm.ts`], { stdio: 'pipe' });
  bytes = readFileSync(`${dir}web/app.wasm`);
  reports = reportsFromJson(readFileSync(`${dir}web/app.reports.json`, 'utf8'));
}, 120_000);

const memStack = () => {
  const store = new MemoryDocStore();
  seed(store);
  return { store, audit: new MemoryAuditLog() };
};

describe('docs app: wasm engine vs interpreter engine', () => {
  it('runs as compiled wasm (not silently falling back)', async () => {
    const { store, audit } = memStack();
    const e = await DocsEngine.withWasm(SRC, store, audit, bytes, reports);
    expect(e.mode).toBe('wasm');
    expect(e.act({ id: 10, role: 'Editor' }, 1, 'Update', { title: 'Via wasm', size: 5 })).toEqual({ kind: 'ok', receipt: { doc: 1, status: 'Draft', size: 5 } });
    expect(store.get(1)).toMatchObject({ title: 'Via wasm', size: 5 });
    expect(audit.all()).toEqual([{ actor: 10, doc: 1, op: 'Update' }]);
  });

  it('agree on 400 random requests per seed (outcomes, stored docs, audit logs, views, store failures)', async () => {
    const roles = ['Viewer', 'Editor', 'Admin'] as const;
    const ops: Op[] = ['Update', 'Delete', 'Publish'];
    const titles = ['', 'plain', 'café 中文', '<b>x</b>', 'a'.repeat(300), 'quote"s\nnewline'];
    const seen = new Set<string>();
    for (const seedN of [1, 2, 3]) {
      const rnd = mulberry32(seedN);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
      const a = memStack();
      const b = memStack();
      const c = openDb();
      const cs = new SqliteDocStore(c);
      seed(cs);
      const ei = new DocsEngine(SRC, a.store, a.audit);
      const ew = await DocsEngine.withWasm(SRC, b.store, b.audit, bytes, reports);
      const ews = await DocsEngine.withWasm(SRC, cs, new SqliteAuditLog(c), bytes, reports);
      for (let i = 0; i < 400; i++) {
        const actor: Actor = { id: pick([1, 5, 10, 11, 9007199254740991]), role: pick(roles) };
        const id = pick([1, 2, 3, 4]);
        const op = pick(ops);
        const size = pick([0, 1, 799, 800, 49999, 50000, 50001, 1000000, 1000001, -1]);
        const failing = rnd() < 0.1;
        a.store.failing = failing;
        b.store.failing = failing;
        cs.failing = failing;
        const payload = { title: pick(titles), size };
        const ra = ei.act(actor, id, op, payload);
        seen.add(ra.kind === 'refused' ? `refused:${ra.reason}` : ra.kind);
        expect(ew.act(actor, id, op, payload), `seed ${seedN} step ${i}`).toEqual(ra);
        expect(ews.act(actor, id, op, payload), `seed ${seedN} step ${i} (sqlite)`).toEqual(ra);
        const va = ei.view(actor, id);
        expect(ew.view(actor, id)).toEqual(va);
        expect(ews.view(actor, id)).toEqual(va);
      }
      expect(b.audit.all()).toEqual(a.audit.all());
      expect(ews.auditLog()).toEqual(a.audit.all());
      for (const id of [1, 2, 3, 4]) {
        expect(b.store.get(id)).toEqual(a.store.get(id));
        expect(cs.get(id)).toEqual(a.store.get(id));
      }
    }
    // The random walk must actually reach every kind of outcome, or the agreement above proves little.
    for (const k of ['ok', 'not-found', 'bad-input', 'refused:NotAllowed', 'refused:Gone', 'refused:TooLong', 'refused:AlreadyPublished', 'refused:EmptyBody', 'refused:StoreFailed']) expect(seen, k).toContain(k);
  }, 120_000);

  it('the HTTP layer gives identical responses on wasm', async () => {
    const a = memStack();
    const b = memStack();
    const ei = new DocsEngine(SRC, a.store, a.audit);
    const ew = await DocsEngine.withWasm(SRC, b.store, b.audit, bytes, reports);
    const h = (x: Actor) => ({ 'x-actor-id': String(x.id), 'x-actor-role': x.role });
    const admin: Actor = { id: 1, role: 'Admin' };
    const steps: { m: string; p: string; who: Actor; body?: Json }[] = [
      { m: 'PATCH', p: '/docs/1', who: { id: 10, role: 'Editor' }, body: { title: 'T', size: 60000 } },
      { m: 'POST', p: '/docs/3/publish', who: admin },
      { m: 'POST', p: '/docs/2/publish', who: admin },
      { m: 'DELETE', p: '/docs/1', who: { id: 5, role: 'Viewer' } },
      { m: 'DELETE', p: '/docs/1', who: admin },
      { m: 'DELETE', p: '/docs/1', who: admin },
      { m: 'GET', p: '/docs/1', who: admin },
      { m: 'GET', p: '/audit', who: admin },
    ];
    for (const s of steps) expect(handle(ew, { method: s.m, path: s.p, headers: h(s.who), body: s.body })).toEqual(handle(ei, { method: s.m, path: s.p, headers: h(s.who), body: s.body }));
  });
});
