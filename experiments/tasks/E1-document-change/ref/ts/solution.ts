// E1 document service (DOC-142): reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

type Role = 'Viewer' | 'Editor' | 'Admin';
type Status = 'Draft' | 'Published' | 'Deleted';
type Op = 'Update' | 'Delete' | 'Publish';
interface Actor {
  id: number;
  role: Role;
}
interface Doc {
  id: number;
  owner: number;
  title: string;
  size: number;
  status: Status;
}
interface Request {
  op: Op;
  title: string;
  size: number;
}
interface Args {
  actor: Actor;
  doc: Doc;
  req: Request;
}
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}

const MAX_SIZE = 50_000;

function authorised({ actor, doc, req }: Args): boolean {
  switch (actor.role) {
    case 'Viewer':
      return false;
    case 'Editor':
      return actor.id === doc.owner && !(req.op === 'Delete' && doc.status === 'Published');
    case 'Admin':
      return true;
  }
}

function refusal(args: Args): string | null {
  const { doc, req } = args;
  if (!authorised(args)) return 'NotAllowed';
  if (doc.status === 'Deleted') return 'Gone';
  if (req.op === 'Update' && req.size > MAX_SIZE) return 'TooLong';
  if (req.op === 'Publish') {
    if (doc.status === 'Published') return 'AlreadyPublished';
    if (doc.size === 0) return 'EmptyBody';
  }
  return null;
}

function apply({ doc, req }: Args): Doc {
  switch (req.op) {
    case 'Update':
      return { id: doc.id, owner: doc.owner, title: req.title, size: req.size, status: doc.status };
    case 'Delete':
      return { id: doc.id, owner: doc.owner, title: doc.title, size: doc.size, status: 'Deleted' };
    case 'Publish':
      return { id: doc.id, owner: doc.owner, title: doc.title, size: doc.size, status: 'Published' };
  }
}

export default async function run(args: Args, host: Host) {
  const { actor, doc, req } = args;
  const reason = refusal(args);
  if (reason !== null) {
    await host.audit.emit('audit', { actor: actor.id, doc: doc.id, op: req.op, reason });
    return { err: reason };
  }
  const next = apply(args);
  const stored = await host.store.put('store:docs', doc.id, next);
  if (!stored.ok) return { err: 'StoreFailed' };
  await host.audit.emit('audit', { actor: actor.id, doc: doc.id, op: req.op });
  return { ok: { doc: next.id, status: next.status, size: next.size } };
}
