import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, errors } from '../src/check.js';
import { parsePolicy, parseProgram } from '../src/parse.js';

const read = (p: string) => readFileSync(new URL(`../examples/invoicing/${p}`, import.meta.url), 'utf8');
export const APP = read('app.sigil');
export const POLICY = read('policy.sigil');

const run = (app: string, policy = POLICY) => check(parseProgram(app), parsePolicy(policy));

describe('range analysis (intervals)', () => {
  const r = run(APP);

  it('the invoicing example has no errors', () => {
    expect(errors(r)).toEqual([]);
  });

  it('proves the Cents bound on gross without runtime checks', () => {
    const ev = r.evidence.get('gross')!;
    const o = ev.obligations.find((x) => x.desc.startsWith('out in'))!;
    expect(o.status).toBe('proved');
    expect(o.note).toContain('[0, 200000000000000]');
  });

  it('proves the discounted price fits Cents and derives an i64 representation', () => {
    const ev = r.evidence.get('price-invoice')!;
    expect(ev.obligations.find((x) => x.desc.startsWith('out in'))!.status).toBe('proved');
    expect(ev.obligations.find((x) => x.kind === 'div')!.status).toBe('proved');
    expect(ev.repr).toBe('i64'); // intermediate product reaches 2e16: too big for i32, fine for i64
    expect(ev.maxAbs).toBe(20000000000000000n);
  });

  it('cannot prove the relational postcondition with intervals alone (the finding)', () => {
    const ens = r.evidence.get('price-invoice')!.obligations.find((x) => x.kind === 'ensures')!;
    expect(ens.status).toBe('unproved');
  });

  it('rejects a Cents bound that is too small', () => {
    const bad = APP.replace('(type Cents  (Int 0 1000000000000000))', '(type Cents  (Int 0 1000000000000))');
    const res = run(bad);
    const o = res.evidence.get('gross')!.obligations.find((x) => x.desc.startsWith('out in'))!;
    expect(o.status).toBe('unproved');
  });

  it('flags a divisor that may be zero', () => {
    const bad = APP + `\n(fn bad-div (in (p Plan) (ls (List Line 1 200))) (out Cents) (div-floor (gross ls) (discount p)))`;
    const res = run(bad);
    expect(res.evidence.get('bad-div')!.obligations.find((x) => x.kind === 'div')!.status).toBe('unproved');
  });

  it('reports non-exhaustive matches', () => {
    const bad = APP.replace('(match p (Free 0) (Pro 10) (Enterprise 20))', '(match p (Free 0) (Pro 10))');
    const res = run(bad);
    expect(errors(res).some((d) => d.code === 'E-match' && d.msg.includes('Enterprise'))).toBe(true);
  });
});

describe('capabilities and wiring', () => {
  it('rejects a capability used without declaring it in needs', () => {
    const bad = APP.replace('(needs store:invoices net:mail audit rand)', '(needs store:invoices net:mail rand)');
    const res = run(bad);
    expect(errors(res).some((d) => d.code === 'E-cap' && d.msg.includes('audit'))).toBe(true);
  });

  it('rejects a binding that exceeds the policy ceiling', () => {
    const bad = APP.replace('https://mail.acme.com', 'https://evil.example.com');
    const res = run(bad);
    expect(errors(res).some((d) => d.code === 'E-policy')).toBe(true);
  });

  it('checks target portability of bound capabilities', () => {
    const bad = APP.replace('(targets server browser)', '(targets server browser native)') +
      `\n(fn uses-fs (in (x Cents)) (out Cents) (needs fs:tmp) x)\n(program p2 (entry uses-fs (bind fs:tmp (fs (path "/tmp")))))`;
    const res = run(bad, POLICY.replace('(allow rand)', '(allow rand)\n  (allow fs)'));
    expect(errors(res).some((d) => d.code === 'E-target' && d.msg.includes('browser'))).toBe(true);
  });
});

describe('information flow', () => {
  const r = run(APP);

  it('the customer name reaches only the mail sink', () => {
    const sinks = r.flows.filter((f) => f.src === 'Customer.name').map((f) => f.sink);
    expect(sinks).toEqual(['net:mail']);
  });

  it('the plan (internal) reaches store and mail, but never audit', () => {
    const sinks = r.flows.filter((f) => f.src === 'Customer.plan').map((f) => f.sink).sort();
    expect(sinks).toEqual(['net:mail', 'store:invoices']);
  });

  it('rejects PII flowing to a telemetry sink with a counterexample path', () => {
    const bad =
      APP +
      `
(type Event (rec (name Str) (who Email :pii)))
(fn track (in (c Customer)) (out Unit) (needs net:telemetry) (post net:telemetry (Event "issued" c.email)))
(program telemetry (entry track (bind net:telemetry (net (connect "https://mail.acme.com")))))`;
    const res = run(bad, POLICY.replace('(sink audit', '(sink net:telemetry (accepts internal))\n  (sink audit'));
    const d = errors(res).find((x) => x.code === 'E-flow' && x.msg.includes('net:telemetry'))!;
    expect(d).toBeTruthy();
    expect(d.paths![0].src).toBe('Customer.email');
    expect(d.paths![0].path.join(' ')).toContain('c.email');
    expect(d.paths![0].path.join(' ')).toContain('-> net:telemetry');
  });

  it('denies by default: a sink with no policy accepts only public data', () => {
    const noPolicy = POLICY.replace('(sink net:mail       (accepts pii))', '');
    const res = run(APP, noPolicy);
    expect(errors(res).some((d) => d.code === 'E-flow' && d.msg.includes('deny by default'))).toBe(true);
  });

  it('rejects pii flowing into a field declared public (label laundering)', () => {
    const bad = APP.replace('(Mail :to c.email\n        :subject (text "Invoice " i.id)', '(Mail :to c.email\n        :subject (text "Invoice " c.name)');
    const res = run(bad);
    const d = errors(res).find((x) => x.code === 'E-flow' && x.msg.includes('Mail.subject'))!;
    expect(d).toBeTruthy();
    expect(d.paths![0].src).toBe('Customer.name');
  });

  it('rejects an untrusted string as a recipient (control position needs a validator)', () => {
    const bad = APP.replace('(Mail :to c.email', '(Mail :to c.name');
    const res = run(bad);
    expect(errors(res).some((d) => d.code === 'E-integrity' && d.msg.includes('Mail.to'))).toBe(true);
  });

  it('implicit flows: branching on internal data taints the result', () => {
    const src =
      APP +
      `\n(fn leak (in (c Customer)) (out Unit) (needs audit) (if (= c.plan Pro) (emit audit (Issued 1)) (emit audit (Issued 2))))`;
    const ok = run(src);
    // audit accepts internal, so branching on plan (internal) is allowed...
    expect(errors(ok).filter((d) => d.fn === 'leak')).toEqual([]);
    // ...but not once the audit sink is tightened to public.
    const strict = run(src, POLICY.replace('(sink audit          (accepts internal))', '(sink audit (accepts public))'));
    expect(errors(strict).some((d) => d.fn === 'leak' && d.code === 'E-flow')).toBe(true);
  });
});

describe('names and arity', () => {
  it('reports unknown names, fields and wrong arity', () => {
    const bad = APP + `\n(fn broken (in (c Customer)) (out Cents) (add c.nope (frobnicate 1) (gross)))`;
    const res = run(bad);
    const codes = errors(res).filter((d) => d.fn === 'broken').map((d) => d.code);
    expect(codes).toContain('E-field');
    expect(codes).toContain('E-name');
    expect(codes).toContain('E-arity');
  });
});
