// Browser entry. Two backends behind one interface: "local" runs the engine in the page over localStorage (the same Sigil
// program, interpreted), "remote" calls the Node server. ?backend=remote selects the latter.
import APP from '../sigil/app.sigil';
import { DocsEngine, seed, type Actor, type ViewModel } from './engine.js';
import { WebAuditLog, WebDocStore, type Json } from './adapters.js';
import { handle } from './http.js';
import { renderView } from './render.js';

type Reply = { status: number; body: Json };
interface Backend {
  call(actor: Actor, method: string, path: string, body?: Json): Promise<Reply>;
}

function local(): Backend {
  const store = new WebDocStore(localStorage);
  if (store.get(1) === null) seed(store);
  const engine = new DocsEngine(APP, store, new WebAuditLog(localStorage));
  return { call: async (actor, method, path, body) => handle(engine, { method, path, headers: { 'x-actor-id': String(actor.id), 'x-actor-role': actor.role }, body }) };
}

function remote(): Backend {
  return {
    call: async (actor, method, path, body) => {
      const r = await fetch(path, { method, headers: { 'x-actor-id': String(actor.id), 'x-actor-role': actor.role, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: (await r.json()) as Json };
    },
  };
}

const backend = new URLSearchParams(location.search).get('backend') === 'remote' ? remote() : local();
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const actor = (): Actor => ({ id: Number(($('actor-id') as HTMLInputElement).value), role: ($('actor-role') as HTMLSelectElement).value as Actor['role'] });

let inflight = 0; // exposed as data-busy so tests (and assistive tech) can wait for the page to settle
let generation = 0; // a refresh that is overtaken by a newer one must not touch the page

function refresh(message?: string): Promise<void> {
  document.body.dataset.busy = String(++inflight);
  return refreshNow(message).finally(() => (document.body.dataset.busy = String(--inflight)));
}

async function refreshNow(message?: string): Promise<void> {
  const mine = ++generation;
  shownActor = JSON.stringify(actor());
  const list = document.createDocumentFragment();
  for (const id of [1, 2, 3]) {
    const r = await backend.call(actor(), 'GET', `/docs/${id}`);
    if (r.status !== 200) continue;
    const act = async (method: string, path: string, body?: Json) => {
      const res = await backend.call(actor(), method, path, body);
      await refresh(res.status === 200 ? `ok (${res.status})` : `refused: ${(res.body as { error: string }).error} (${res.status})`);
    };
    list.append(renderView(r.body as unknown as ViewModel, { update: (title, size) => void act('PATCH', `/docs/${id}`, { title, size }), remove: () => void act('DELETE', `/docs/${id}`), publish: () => void act('POST', `/docs/${id}/publish`) }));
  }
  const a = await backend.call(actor(), 'GET', '/audit');
  if (mine !== generation) return;
  $('docs').replaceChildren(list);
  $('message').textContent = message ?? '';
  $('audit').textContent = JSON.stringify(a.body);
}

// A native change event also fires on blur (e.g. when the user clicks a button after editing the id); only a real change refreshes.
let shownActor = '';
for (const id of ['actor-id', 'actor-role']) $(id).addEventListener('change', () => { if (JSON.stringify(actor()) !== shownActor) void refresh(); });
$('backend').textContent = new URLSearchParams(location.search).get('backend') === 'remote' ? 'remote (Node server, SQLite)' : 'local (in-page, localStorage)';
void refresh();
