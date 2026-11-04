// The trusted shell around the Sigil program: loads state through an adapter (Sigil has no read), runs the
// interpreter, and persists the effects the program requested through adapters. No business rule lives here.
//
// Pattern: "load, decide, store". The shell loads the document; Sigil decides and requests put/emit; the shell performs them.

import { parseProgram } from '../../../src/parse.js';
import { Host, Interp, RuntimeFault, UNIT, errVal, okVal, type Val } from '../../../src/interp.js';
import type { Program } from '../../../src/ast.js';
import { decodeVal, encodeVal, type Json } from '../../../experiments/lib/json.js';
import type { AuditLog, DocStore } from './adapters.js';

export type Role = 'Viewer' | 'Editor' | 'Admin';
export type Actor = { id: number; role: Role };
export type Op = 'Update' | 'Delete' | 'Publish';
export type DocError = 'NotAllowed' | 'Gone' | 'TooLong' | 'AlreadyPublished' | 'EmptyBody' | 'StoreFailed';
export const DOC_ERRORS: DocError[] = ['NotAllowed', 'Gone', 'TooLong', 'AlreadyPublished', 'EmptyBody', 'StoreFailed'];

export type ViewModel = { id: number; title: string; size: number; status: string; 'can-update': boolean; 'can-delete': boolean; 'can-publish': boolean };
export type Outcome =
  | { kind: 'ok'; receipt: { doc: number; status: string; size: number } }
  | { kind: 'refused'; reason: DocError }
  | { kind: 'not-found' }
  | { kind: 'bad-input'; message: string };

/** Host that performs the program's requested effects on adapters. Handles are fixed by the program's `bind`s. */
class AdapterHost extends Host {
  constructor(private store: DocStore, private audit: AuditLog) {
    super();
  }
  call(handle: string, op: string, args: Val[]): Val {
    if (handle === 'store:docs' && op === 'put') {
      const ok = this.store.put(Number(args[0] as bigint), encodeVal(args[1]));
      this.log.push({ handle, op, args, ok });
      return ok ? okVal(UNIT) : errVal(UNIT);
    }
    if (handle === 'audit' && op === 'emit') {
      this.audit.emit(encodeVal(args[0]));
      this.log.push({ handle, op, args, ok: true });
      return UNIT;
    }
    throw new RuntimeFault(`host: no adapter for ${handle}.${op}`);
  }
}

export class DocsEngine {
  private prog: Program;
  constructor(source: string, private store: DocStore, private audit: AuditLog) {
    this.prog = parseProgram(source);
  }

  private run(fn: string, args: Json[]): Val {
    const f = this.prog.fns.get(fn);
    if (!f) throw new Error(`program has no function ${fn}`);
    const vals = f.params.map((p, i) => decodeVal(this.prog, p.type, args[i], p.name));
    return new Interp(this.prog, new AdapterHost(this.store, this.audit)).callFn(fn, vals);
  }

  /** The program's view model for this actor and document. */
  view(actor: Actor, docId: number): ViewModel | null {
    const doc = this.store.get(docId);
    if (doc === null) return null;
    return encodeVal(this.run('doc-view', [actor, doc])) as ViewModel;
  }

  act(actor: Actor, docId: number, op: Op, payload: { title?: string; size?: number } = {}): Outcome {
    const doc = this.store.get(docId);
    if (doc === null) return { kind: 'not-found' };
    const req = { op, title: payload.title ?? '', size: payload.size ?? 0 };
    let out: Json;
    try {
      out = encodeVal(this.run('handle-request', [actor, doc, req]));
    } catch (e) {
      // Argument decoding (e.g. a size outside 0..1000000) is the shell's input check, not a program decision.
      if (e instanceof Error && !(e instanceof RuntimeFault) && /expected|outside|missing/.test(e.message)) return { kind: 'bad-input', message: e.message };
      throw e;
    }
    const r = out as { ok?: { doc: number; status: string; size: number }; err?: DocError };
    return r.ok ? { kind: 'ok', receipt: r.ok } : { kind: 'refused', reason: r.err as DocError };
  }

  auditLog(): Json[] {
    return this.audit.all();
  }
}

export const DEMO_DOCS: Json[] = [
  { id: 1, owner: 10, title: 'Q3 plan', size: 800, status: 'Draft' },
  { id: 2, owner: 11, title: 'Handbook', size: 12000, status: 'Published' },
  { id: 3, owner: 10, title: 'Empty draft', size: 0, status: 'Draft' },
];

export function seed(store: DocStore, docs: Json[] = DEMO_DOCS): void {
  for (const d of docs) store.put((d as { id: number }).id, d);
}
