// Transport-agnostic request handler: (method, path, headers, body) -> (status, body). The Node server and the tests both use it.

import { DocsEngine, type Actor, type Role } from './engine.js';
import { ROUTES, STATUS_OF } from './routes.js';
import type { Json } from './adapters.js';

export type Req = { method: string; path: string; headers: Record<string, string | undefined>; body?: Json };
export type Res = { status: number; body: Json };

const ROLES: Role[] = ['Viewer', 'Editor', 'Admin'];

function actorOf(h: Req['headers']): Actor | null {
  const id = Number(h['x-actor-id']);
  const role = h['x-actor-role'] as Role;
  return Number.isSafeInteger(id) && id >= 0 && ROLES.includes(role) ? { id, role } : null;
}

export function handle(engine: DocsEngine, req: Req): Res {
  for (const r of ROUTES) {
    const m = r.pattern.exec(req.path);
    if (r.method !== req.method || !m) continue;
    const actor = actorOf(req.headers);
    if (!actor) return { status: 401, body: { error: 'x-actor-id and x-actor-role headers are required' } };
    if (r.kind === 'audit') return { status: 200, body: engine.auditLog() };
    const id = Number(m[1]);
    if (r.kind === 'view') {
      const v = engine.view(actor, id);
      return v ? { status: 200, body: v as unknown as Json } : { status: 404, body: { error: 'not found' } };
    }
    const b = (req.body ?? {}) as { title?: string; size?: number };
    const out = engine.act(actor, id, r.op!, r.op === 'Update' ? { title: b.title, size: b.size } : {});
    switch (out.kind) {
      case 'ok': return { status: 200, body: out.receipt };
      case 'refused': return { status: STATUS_OF[out.reason], body: { error: out.reason } };
      case 'not-found': return { status: 404, body: { error: 'not found' } };
      case 'bad-input': return { status: 400, body: { error: out.message } };
    }
  }
  return { status: 404, body: { error: 'no such route' } };
}
