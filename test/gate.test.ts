import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Admission, DeployRequest, Evidence, Files, Registry, Trust, admit, gateMain, gatherEvidence, hashUnit, keygen, readUnit, sha256, signPayload, verifySigned } from '../src/gate.js';

const EX = join(__dirname, '..', 'examples', 'invoicing');
const tmp = () => mkdtempSync(join(tmpdir(), 'gate-'));
const K = { attester: keygen(), approver: keygen(), agent: keygen(), rogue: keygen() };
const trust: Trust = { attesters: { ci: K.attester.pub }, approvers: { owner: K.approver.pub }, agents: { deployer: K.agent.pub } };
let files: Files, evidence: Evidence;
beforeAll(() => {
  files = readUnit(EX);
  evidence = gatherEvidence(files);
}, 60000);

const systemFor = (f: Files, extra = '') => {
  const h = hashUnit(f);
  return `(system inv (approved "${h.program}" "${h.spec}") (process billing (program "${h.program}") (spec "${h.spec}") (reads internal)) ${extra})`;
};
const req = (src: string, key = K.agent) => signPayload({ kind: 'deploy', name: 'inv', system: sha256(src) } as DeployRequest, key);
function setup(opts: { evidence?: Evidence | null; approve?: boolean; attesterKey?: typeof K.agent } = {}) {
  const reg = new Registry(tmp());
  const h = reg.putUnit(files);
  if (opts.evidence !== null) reg.addEvidence(signPayload(opts.evidence ?? evidence, opts.attesterKey ?? K.attester));
  if (opts.approve !== false) reg.addApproval(signPayload({ kind: 'approval', ...h }, K.approver));
  return { reg, h };
}
const codes = (a: Admission) => [...new Set(a.diags.map((d) => d.code))].sort();

describe('deploy gate', () => {
  it('hashes are stable and sensitive to every byte of program and spec', () => {
    const h = hashUnit(files);
    expect(hashUnit(readUnit(EX))).toEqual(h);
    expect(hashUnit({ ...files, 'app.sigil': files['app.sigil'] + ' ' }).program).not.toBe(h.program);
    expect(hashUnit({ ...files, 'app.sigil': files['app.sigil'] + ' ' }).spec).toBe(h.spec);
    expect(hashUnit({ ...files, 'glossary.sigil': files['glossary.sigil'] + ' ' }).spec).not.toBe(h.spec);
    expect(hashUnit({ ...files, feature: files.feature + ' ' }).spec).not.toBe(h.spec);
  });

  it('admits attested, approved units deployed by a listed agent, writes a release and audits it', () => {
    const { reg } = setup();
    const src = systemFor(files);
    const a = admit(src, reg, trust, req(src));
    expect(a.diags).toEqual([]);
    expect(a.ok).toBe(true);
    expect(a.release?.units[0].approvedBy).toEqual(['owner']);
    expect(existsSync(join(reg.dir, 'releases', `${sha256(src)}.json`))).toBe(true);
    expect(readFileSync(join(reg.dir, 'audit.jsonl'), 'utf8')).toMatch(/"event":"admit"/);
  });

  describe('who may deploy', () => {
    it('rejects an unknown key, a tampered request and a request for a different system', () => {
      const { reg } = setup();
      const src = systemFor(files);
      expect(codes(admit(src, reg, trust, req(src, K.rogue)))).toEqual(['G-deployer']);
      const forged = req(src);
      forged.payload.name = 'other';
      expect(codes(admit(src, reg, trust, forged))).toEqual(['G-deployer']);
      expect(codes(admit(src, reg, trust, req('(system x)')))).toContain('G-deployer');
    });
    it('does not let the approver deploy its own approval, or one key hold two roles', () => {
      const { reg } = setup();
      const src = systemFor(files);
      const t2: Trust = { ...trust, agents: { deployer: K.agent.pub, owner2: K.approver.pub } };
      expect(codes(admit(src, reg, t2, req(src, K.approver)))).toEqual(['G-role-conflict']);
      const t3: Trust = { ...trust, agents: { deployer: K.attester.pub } };
      expect(codes(admit(src, reg, t3, req(src, K.attester)))).toContain('G-role-conflict');
    });
  });

  describe('what is deployed is what was attested', () => {
    it('rejects a unit that is not in the registry', () => {
      const reg = new Registry(tmp());
      const src = systemFor(files);
      expect(codes(admit(src, reg, trust, req(src)))).toEqual(['G-unit-missing']);
    });
    it('rejects altered registry content (re-hash on load)', () => {
      const { reg, h } = setup();
      const f = join(reg.dir, 'units', `${h.program}.${h.spec}`, 'unit.json');
      writeFileSync(f, readFileSync(f, 'utf8').replace('"app.sigil":"', '"app.sigil":";x\\n'));
      const src = systemFor(files);
      expect(codes(admit(src, reg, trust, req(src)))).toEqual(['G-unit-tamper']);
      expect(() => reg.loadUnit(h)).toThrow(/altered/);
    });
    it('rejects a source edit made after attestation: new hashes carry no evidence or approval', () => {
      const { reg } = setup();
      const edited = { ...files, 'app.sigil': `${files['app.sigil']}\n` };
      reg.putUnit(edited);
      const src = systemFor(edited);
      expect(codes(admit(src, reg, trust, req(src)))).toEqual(['G-approval', 'G-evidence']);
    });
    it('a spec change invalidates approval of the old pair', () => {
      const { reg } = setup();
      const edited = { ...files, 'glossary.sigil': `${files['glossary.sigil']}\n` };
      reg.putUnit(edited);
      reg.addEvidence(signPayload({ ...evidence, ...hashUnit(edited) }, K.attester));
      const src = systemFor(edited);
      expect(codes(admit(src, reg, trust, req(src)))).toEqual(['G-approval']);
    });
  });

  describe('evidence', () => {
    it('rejects evidence from an untrusted key, with a bad signature, or bound to other hashes', () => {
      const src = systemFor(files);
      expect(codes(admit(src, setup({ attesterKey: K.rogue }).reg, trust, req(src)))).toEqual(['G-evidence']);
      const s = setup();
      const f = join(s.reg.dir, 'evidence', `${s.h.program}.${s.h.spec}.json`);
      const parsed = JSON.parse(readFileSync(f, 'utf8'));
      parsed[0].payload.mutation.killed = 999;
      writeFileSync(f, JSON.stringify(parsed));
      expect(codes(admit(src, s.reg, trust, req(src)))).toEqual(['G-evidence']);
      const other = setup({ evidence: { ...evidence, program: 'f'.repeat(64) } });
      expect(codes(admit(src, other.reg, trust, req(src)))).toEqual(['G-evidence']);
    });
    it('rejects signed evidence that shows failures, and enforces the mutation policy', () => {
      const src = systemFor(files);
      const failing = setup({ evidence: { ...evidence, check: { errors: 1 } } });
      expect(admit(src, failing.reg, trust, req(src)).diags[0].msg).toMatch(/1 check error/);
      const weak = setup({ evidence: { ...evidence, mutation: { total: 22, killed: 15, survivors: 7 } } });
      expect(codes(admit(src, weak.reg, trust, req(src)))).toEqual(['G-mutation']);
      const lax: Trust = { ...trust, policy: { minKill: 0.6, maxSurvivors: 7 } };
      expect(admit(src, weak.reg, lax, req(src)).ok).toBe(true);
    });
    it('does not accept an empty mutation run as a pass', () => {
      const src = systemFor(files);
      const s = setup({ evidence: { ...evidence, mutation: { total: 0, killed: 0, survivors: 0 } } });
      expect(codes(admit(src, s.reg, trust, req(src)))).toEqual(['G-mutation']);
    });
    it('signature verification rejects any payload edit', () => {
      const s = signPayload(evidence, K.attester);
      expect(verifySigned(s)).toBe(true);
      expect(verifySigned({ ...s, payload: { ...s.payload, suite: { total: 1, failed: 0 } } })).toBe(false);
      expect(verifySigned({ ...s, by: K.rogue.pub })).toBe(false);
      expect(verifySigned({ ...s, sig: 'zz' })).toBe(false);
    });
  });

  it('rejects a unit with no signed approval, and ignores an approval signed by a non-approver', () => {
    const src = systemFor(files);
    expect(codes(admit(src, setup({ approve: false }).reg, trust, req(src)))).toEqual(['G-approval']);
    const s = setup({ approve: false });
    s.reg.addApproval(signPayload({ kind: 'approval', ...s.h }, K.rogue));
    expect(codes(admit(src, s.reg, trust, req(src)))).toEqual(['G-approval']);
  });

  it('still runs the composition check: a gated unit cannot be wired across a label boundary', () => {
    const { reg } = setup();
    const h = hashUnit(files);
    const src = `(system inv (approved "${h.program}" "${h.spec}")
      (process a (program "${h.program}") (spec "${h.spec}") (reads pii))
      (process b (program "${h.program}") (spec "${h.spec}") (in public))
      (channel a b (carries public)))`;
    expect(codes(admit(src, reg, trust, req(src)))).toEqual(['E-chan-label']);
  });

  it('rejects malformed system files and audits every decision, with the principal', () => {
    const { reg } = setup();
    const bad = '(system';
    expect(codes(admit(bad, reg, trust, req(bad)))).toEqual(['G-malformed']);
    const ok = systemFor(files);
    admit(ok, reg, trust, req(ok, K.rogue));
    admit(ok, reg, trust, req(ok));
    const log = readFileSync(join(reg.dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.map((l) => l.event)).toEqual(['reject', 'reject', 'admit']);
    expect(log[1].by).toMatch(/^unknown:/);
    expect(log[2].by).toBe('deployer');
  });

  it('refuses to attest a unit with pending declassifiers', () => {
    const d = tmp();
    cpSync(EX, d, { recursive: true });
    writeFileSync(join(d, 'proposed-policy.sigil'), '');
    expect(() => readUnit(d)).toThrow(/pending human approval/);
  });

  it('CLI end to end: keygen, attest, approve, admit (exit 0), then a tampered system (exit 1), bad usage (exit 2)', () => {
    const d = tmp(), reg = join(d, 'reg');
    const key = (n: string) => { expect(gateMain(['keygen', join(d, n)])).toBe(0); return JSON.parse(readFileSync(join(d, n), 'utf8')).pub as string; };
    const t: Trust = { attesters: { ci: key('ci.key') }, approvers: { owner: key('owner.key') }, agents: { bot: key('bot.key') } };
    writeFileSync(join(d, 'trust.json'), JSON.stringify(t));
    expect(gateMain(['attest', EX, '--registry', reg, '--key', join(d, 'ci.key')])).toBe(0);
    expect(gateMain(['approve', EX, '--registry', reg, '--key', join(d, 'owner.key')])).toBe(0);
    const sys = join(d, 'system.sigil');
    writeFileSync(sys, systemFor(files));
    expect(gateMain(['admit', sys, '--registry', reg, '--trust', join(d, 'trust.json'), '--key', join(d, 'bot.key')])).toBe(0);
    expect(gateMain(['admit', sys, '--registry', reg, '--trust', join(d, 'trust.json'), '--key', join(d, 'ci.key')])).toBe(1);
    expect(gateMain(['admit'])).toBe(2);
    expect(gateMain(['nope'])).toBe(2);
  }, 60000);
});
