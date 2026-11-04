// Builds E1's hidden cases from B1's: same arguments, expectations recomputed from E1's TypeScript reference, plus new cases for the
// change request. The Sigil reference is then cross-checked against the result by `experiments/run.ts E1-document-change sigil ...`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { makeHost } from './lib/host.js';

const root = resolve(import.meta.dirname, 'tasks');
const old = JSON.parse(readFileSync(`${root}/B1-document-service/hidden/cases.json`, 'utf8'));
const run = (await import(pathToFileURL(`${root}/E1-document-change/ref/ts/solution.ts`).href)).default;

const rename: Record<string, string> = {
  'editor deletes own published document': 'editor cannot delete own published document',
  'editor cannot publish own document': 'editor publishes own draft',
  'editor publish of an already published own document is NotAllowed': 'editor publish of an already published own document is AlreadyPublished',
};
const D = (id: number, owner: number, status: string, size = 40) => ({ id, owner, title: `Title ${id}`, size, status });
const mk = (name: string, role: string, actor: number, doc: ReturnType<typeof D>, op: string, extra: { trap?: boolean; payload?: [string, number]; fail?: boolean } = {}) => ({
  name,
  ...(extra.trap ? { trap: true } : {}),
  args: { actor: { id: actor, role }, doc: { ...doc, id: 101 }, req: { op, title: extra.payload?.[0] ?? '', size: extra.payload?.[1] ?? 0 } },
  ...(extra.fail ? { host: { fail: [{ handle: 'store:docs', op: 'put' }] } } : {}),
});
const added = [
  mk('editor publishes own draft carrying a payload', 'Editor', 5, D(1, 5, 'Draft', 10), 'Publish', { payload: ['Other title', 999999] }),
  mk('editor publish of own empty draft is EmptyBody', 'Editor', 5, D(1, 5, 'Draft', 0), 'Publish'),
  mk('editor publish of own deleted document is Gone', 'Editor', 5, D(1, 5, 'Deleted', 10), 'Publish'),
  mk('editor publish of own empty published document is AlreadyPublished', 'Editor', 5, D(1, 5, 'Published', 0), 'Publish'),
  mk('editor publish of someone elses deleted document is NotAllowed, not Gone', 'Editor', 5, D(1, 9, 'Deleted', 10), 'Publish'),
  mk('editor publish of someone elses published document is NotAllowed', 'Editor', 5, D(1, 9, 'Published', 10), 'Publish'),
  mk('editor delete of someone elses published document is NotAllowed', 'Editor', 5, D(1, 9, 'Published', 10), 'Delete'),
  mk('editor delete of own published document ignores a large payload', 'Editor', 5, D(1, 5, 'Published', 10), 'Delete', { payload: ['x', 999999] }),
  mk('editor can still update own published document', 'Editor', 5, D(1, 5, 'Published', 10), 'Update', { payload: ['New', 20] }),
  mk('editor can still delete own draft with the store down', 'Editor', 5, D(1, 5, 'Draft', 10), 'Delete', { fail: true }),
  mk('editor publish with the store down', 'Editor', 5, D(1, 5, 'Draft', 10), 'Publish', { fail: true }),
  mk('admin still deletes a published document', 'Admin', 1, D(1, 5, 'Published', 10), 'Delete'),
  mk('admin still deletes own published document', 'Admin', 5, D(1, 5, 'Published', 10), 'Delete'),
  mk('viewer still cannot publish own document', 'Viewer', 5, D(1, 5, 'Draft', 10), 'Publish'),
  mk('a refusal of an editor deleting a published document does not audit titles', 'Editor', 5, { id: 101, owner: 5, title: 'Secret plan', size: 10, status: 'Published' }, 'Delete', { trap: true, payload: ['Hidden req', 3] }),
  mk('an editor publish does not audit titles', 'Editor', 5, { id: 101, owner: 5, title: 'Quarterly secret', size: 10, status: 'Draft' }, 'Publish', { trap: true, payload: ['Req secret', 3] }),
];
const base = (old.cases as any[]).map((c) => ({ ...c, name: rename[c.name] ?? c.name }));
const names = new Set(base.map((c) => c.name));
const fresh = added.filter((c) => !names.has(c.name));
const freshNames = new Set(fresh.map((c) => c.name));
const cases = [...base, ...fresh];

for (const c of cases) {
  const { host, effects } = makeHost(c.host ?? {});
  const result = await run(JSON.parse(JSON.stringify(c.args)), host);
  // A success stores the document (title included), so for it only the request title, which a publish ignores, is forbidden.
  const stores = result && 'ok' in result;
  const forbid = c.expect?.forbid ?? (c.trap && freshNames.has(c.name) ? [...(stores ? [] : [c.args.doc.title]), c.args.req.title].filter((s: string) => s.length > 3) : undefined);
  const e = effects();
  c.expect = { result, effects: { stored: e.stored, sent: e.sent, emitted: e.emitted }, ...(forbid ? { forbid } : {}) };
}
mkdirSync(`${root}/E1-document-change/hidden`, { recursive: true });
writeFileSync(`${root}/E1-document-change/hidden/cases.json`, JSON.stringify({ entry: old.entry, cases }, null, 1) + '\n');
console.log(`${cases.length} cases (${cases.filter((c) => c.trap).length} traps)`);
