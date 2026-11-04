// Stage 3: `needs` functions compile with imported host functions per capability operation. The JS host adapter
// (src/wasm/host.ts) runs them on the interpreter's Host class, so the effect logs of the interpreter and of the
// compiled Wasm are compared entry by entry, including injected failures.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Host, Interp, enumVal, errVal, okVal } from '../src/interp.js';
import { ENV, callCompiled, instantiate } from '../src/wasm/abi.js';
import { build } from './helpers/wasm-diff.js';
import { differentialEffects } from './helpers/wasm-effects.js';

const POLICY = `
(policy
  (allow store (ns "app/*"))
  (allow net (connect "https://mail.acme.com"))
  (allow audit)
  (allow rand)
  (sink store:s (accepts pii))
  (sink net:mail (accepts pii))
  (sink audit (accepts internal))
  (sink rand (accepts public)))
`;

const FIXTURE = `
(type Id (Int 0 1000000))
(type Err (var StoreFailed MailFailed Bad))
(type Rec (rec (id Id) (name Str :pii) (n (Int 0 100))))
(type Ev (rec (id Id) (tag Str)))
(type Mail (rec (to Str :pii) (body Str :pii)))
(type Batch (rec (ids (List Id 0 5)) (note Str)))

(fn log-it (in (r Rec)) (out Unit) (needs audit) (emit audit (Ev r.id "seen")))
(fn log-two (in (r Rec)) (out Unit) (needs audit) (do (emit audit (Ev r.id "a")) (emit audit (Ev r.id "b"))))
(fn store-try (in (r Rec)) (out (Result Id Err)) (needs store:s audit)
  (do (try (put store:s r.id r) :on-err StoreFailed)
      (emit audit (Ev r.id "stored"))
      (ok r.id)))
(fn post-match (in (r Rec)) (out Bool) (needs net:mail)
  (match (post net:mail (Mail r.name "hi")) (ok _ true) (err _ false)))
(fn notify (in (r Rec)) (out (Result Id Err)) (needs net:mail audit store:s)
  (match (post net:mail (Mail r.name (text "Hello " r.name)))
    (ok _ (do (try (put store:s r.id r) :on-err StoreFailed)
              (emit audit (Ev r.id "sent"))
              (ok r.id)))
    (err _ (do (emit audit (Ev r.id "mail-failed")) (err MailFailed)))))
(fn notify-twice (in (a Rec) (b Rec)) (out (Result Id Err)) (needs net:mail audit store:s)
  (let [x (try (notify a) :on-err Bad)
        y (try (notify b) :on-err MailFailed)]
    (ok (min 1000000 (add x y)))))
(fn fresh-id (in (r Rec)) (out (Int 0 9007199254740991)) (needs rand) (fresh rand))
(fn fresh-pair (in (r Rec)) (out (Int 0 18014398509481982)) (needs rand) (add (fresh rand) (fresh rand)))
(fn fresh-rec (in (r Rec)) (out (Result Id Err)) (needs rand store:s)
  (let [k (fresh rand)] (do (try (put store:s k r) :on-err StoreFailed) (ok r.id))))
(fn emit-batch (in (ids (List Id 0 5))) (out Unit) (needs audit) (emit audit (Batch ids "n")))
(fn emit-each (in (ids (List Id 0 5))) (out (List (Int 0 1) 0 5)) (needs audit)
  (map ids (fn (i) (do (emit audit (Ev i "each")) 0))))
(fn guarded (in (r Rec)) (out Bool) (needs audit)
  (and (> r.n 50) (do (emit audit (Ev r.id "guard")) true)))
(fn guarded-or (in (r Rec)) (out Bool) (needs audit)
  (or (> r.n 50) (do (emit audit (Ev r.id "guard-or")) false)))
(fn get-it (in (r Rec)) (out Id) (needs store:s) (get store:s r.id))

(fn store-wrong-type (in (r Rec)) (out (Result Unit Err)) (needs store:s) (put store:s r.id r))

(program app
  (targets server)
  (entry notify
    (bind store:s (store (ns "app/s")))
    (bind net:mail (net (connect "https://mail.acme.com")))
    (bind audit (audit))
    (bind rand (rand seeded))))
`;

describe('wasm effects: host imports per capability operation', () => {
  const { prog, out } = build(FIXTURE, POLICY);
  const rep = (n: string) => out.fns.find((f) => f.name === n)!;
  const COMPILABLE = [
    'log-it', 'log-two', 'store-try', 'post-match', 'notify', 'notify-twice', 'fresh-id', 'fresh-pair', 'fresh-rec',
    'emit-batch', 'emit-each', 'guarded', 'guarded-or',
  ];

  it('compiles functions with needs and the module validates', () => {
    for (const n of COMPILABLE) expect(rep(n).compilable, `${n}: ${rep(n).reason}`).toBe(true);
    expect(WebAssembly.validate(new Uint8Array(out.bytes))).toBe(true);
    expect(rep('notify').needs).toEqual(['net:mail', 'audit', 'store:s']);
    expect(rep('notify').entry).toBe(true);
    expect(out.entries).toEqual(['notify']);
  });

  it('refuses get (the interpreter cannot run it) and a body whose Result type does not match the declared one', () => {
    expect(rep('get-it').compilable).toBe(false);
    expect(rep('store-wrong-type').compilable).toBe(false);
    expect(rep('store-wrong-type').reason).toMatch(/body is Result|declared result/);
  });

  it('the module declares one host import per operation and argument shape, described in sigil.abi', async () => {
    const mod = await WebAssembly.compile(new Uint8Array(out.bytes));
    const names = WebAssembly.Module.imports(mod).map((i) => i.name);
    for (const op of ['put', 'post', 'emit', 'fresh']) expect(names.some((n) => n.startsWith(`${op}$`))).toBe(true);
    expect(out.abi.handles).toEqual(expect.arrayContaining(['audit', 'store:s', 'net:mail', 'rand']));
    // two different emit argument shapes (Ev and Batch) get two imports
    expect(out.abi.effects.filter((e) => e.op === 'emit').length).toBe(2);
    expect(out.abi.effects.find((e) => e.op === 'fresh')!.args).toEqual([]);
  });

  it('known run: notify posts, stores and emits in order; a failing post emits the refusal instead', async () => {
    const host = new Host(1);
    const ex = await instantiate(out.bytes, host);
    const r = { $: 'rec' as const, type: 'Rec', fields: { id: 7n, name: 'Ada', n: 3n } };
    expect(callCompiled(rep('notify'), ex, [r])).toEqual(okVal(7n));
    expect(host.log.map((o) => `${o.handle}.${o.op}`)).toEqual(['net:mail.post', 'store:s.put', 'audit.emit']);
    expect(host.sent('net:mail')).toEqual([{ $: 'rec', type: 'Mail', fields: { to: 'Ada', body: 'Hello Ada' } }]);
    expect(host.stored('store:s')).toEqual([r]);
    expect(host.emitted('audit')).toEqual([{ $: 'rec', type: 'Ev', fields: { id: 7n, tag: 'sent' } }]);
    const h2 = new Host(1);
    h2.fail('net:mail', 'post');
    ex[ENV]!.host!.host = h2;
    expect(callCompiled(rep('notify'), ex, [r])).toEqual(errVal(enumVal('MailFailed')));
    expect(h2.log.map((o) => `${o.handle}.${o.op}.${o.ok}`)).toEqual(['net:mail.post.false', 'audit.emit.true']);
    const h3 = new Host(1);
    h3.fail('store:s', 'put');
    ex[ENV]!.host!.host = h3;
    expect(callCompiled(rep('notify'), ex, [r])).toEqual(errVal(enumVal('StoreFailed')));
    expect(h3.emitted('audit')).toEqual([]); // try returned before the emit
  });

  it('fresh values come from the same seeded generator in the same order as the interpreter', async () => {
    const hostI = new Host(42);
    const hostW = new Host(42);
    const ex = await instantiate(out.bytes, hostW);
    const r = { $: 'rec' as const, type: 'Rec', fields: { id: 1n, name: '', n: 0n } };
    const want = [1, 2, 3].map(() => new (class extends Object {})() && hostI.call('rand', 'fresh', []));
    const got = [1, 2, 3].map(() => callCompiled(rep('fresh-id'), ex, [r]));
    expect(got).toEqual(want);
  });

  it('a failing fresh: the interpreter continues with an err value where an Int is declared, compiled code traps (documented difference)', async () => {
    const hostI = new Host(1);
    hostI.fail('rand', 'fresh');
    const r = { $: 'rec' as const, type: 'Rec', fields: { id: 1n, name: '', n: 0n } };
    const hostW = new Host(1);
    hostW.fail('rand', 'fresh');
    const ex = await instantiate(out.bytes, hostW);
    // both reject the run (the interpreter on the result's declared range, the compiled code in the host call)
    expect(() => new Interp(prog, hostI).callFn('fresh-id', [r])).toThrow(/expected Int/);
    expect(() => callCompiled(rep('fresh-id'), ex, [r])).toThrow(/fresh failed/);
  });

  for (const name of COMPILABLE) {
    it(`differential (result and effect log, with injected failures): ${name}`, async () => {
      const d = await differentialEffects(prog, out, name, { n: 200 });
      expect(d.mismatches).toEqual([]);
      expect(d.runs).toBe(200);
      if (!['fresh-id', 'fresh-pair'].includes(name)) expect(d.failedRuns).toBeGreaterThan(10);
    });
  }

  it('the effect-log differential exercises both outcomes of notify, including each failure path', async () => {
    const d = await differentialEffects(prog, out, 'notify', { n: 300 });
    expect(d.mismatches).toEqual([]);
    expect(d.outcomes.get('ok')).toBeGreaterThan(20);
    expect(d.outcomes.get('err MailFailed')).toBeGreaterThan(10);
    expect(d.outcomes.get('err StoreFailed')).toBeGreaterThan(5);
    expect(d.ops.get('net:mail.post (failed)')).toBeGreaterThan(5);
    expect(d.ops.get('audit.emit')).toBeGreaterThan(20);
  });
});

describe('wasm effects: the invoicing example (fresh, put, post, emit, try, match)', () => {
  const read = (p: string) => readFileSync(new URL(`../examples/invoicing/${p}`, import.meta.url), 'utf8');
  const { prog, out } = build(read('app.sigil'), read('policy.sigil'));
  it('issue-invoice compiles as an entry and agrees with the interpreter, effects included', async () => {
    const rep = out.fns.find((f) => f.name === 'issue-invoice')!;
    expect(rep.compilable, rep.reason).toBe(true);
    expect(rep.entry).toBe(true);
    const d = await differentialEffects(prog, out, 'issue-invoice', { n: 250 });
    expect(d.mismatches).toEqual([]);
    expect(d.ops.get('rand.fresh')).toBeGreaterThan(50);
    expect(d.outcomes.get('ok')).toBeGreaterThan(10);
    expect([...d.outcomes.keys()].some((k) => k.startsWith('err'))).toBe(true);
  });
});

describe('wasm effects: the differential test catches a broken compiler', () => {
  const muts: [Parameters<typeof build>[2] & object, string[]][] = [
    [{ mutation: 'put-flag-inverted' }, ['store-try', 'notify']],
    [{ mutation: 'emit-dropped' }, ['log-it', 'notify']],
    [{ mutation: 'effect-handle-swapped' }, ['log-it', 'store-try']],
  ];
  for (const [opts, names] of muts) {
    it(`mutation ${opts.mutation} is detected`, async () => {
      const { prog, out } = build(FIXTURE, POLICY, opts);
      for (const name of names) {
        const d = await differentialEffects(prog, out, name, { n: 60 });
        expect(d.mismatches.length, `${name} should expose ${opts.mutation}`).toBeGreaterThan(0);
      }
    });
  }
});
