// Deploy gate (docs/GATE.md): admission control for an agent-only platform.
//
// The trusted unit is (program hash, spec hash). A unit is stored content-addressed in a registry; an attester signs
// evidence (check, scenarios, mutation) bound to those hashes; an approver signs an approval for the pair; an agent signs
// a deploy request for a system.sigil. `admit` accepts the deploy only if all of that lines up against a trust file and
// the static composition check (src/system.ts) passes. Every decision, accept or reject, goes to an append-only audit log.
//
// This is a prototype of the policy decisions, not a runtime: nothing here schedules or isolates a process.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { join } from 'node:path';
import { check, errors } from './check.js';
import { runMutation } from './mutate.js';
import { parsePolicy, parseProgram } from './parse.js';
import { DEFAULT_SUITE, parseFeature, parseGlossary, runSuite } from './scenario.js';
import { SigilError } from './sexpr.js';
import { checkSystem, parseSystem } from './system.js';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---- units ---------------------------------------------------------------------------------------------------------

export type Files = Record<string, string>;
export interface UnitHashes { program: string; spec: string }
const canon = (files: Files, names: string[]) => names.map((n) => `${n}\n${(files[n] ?? '').length}\n${files[n] ?? ''}`).join('\n');
const PROGRAM = ['app.sigil', 'policy.sigil'];
const SPEC = ['glossary.sigil', 'feature'];

/** Read a program directory into normalised files (the one .feature file is stored as "feature"). */
export function readUnit(dir: string): Files {
  const names = readdirSync(dir);
  const feature = names.filter((f) => f.endsWith('.feature'));
  if (feature.length !== 1) throw new SigilError(`${dir}: expected exactly one .feature file, found ${feature.length}`);
  if (names.includes('proposed-policy.sigil')) throw new SigilError(`${dir}: proposed-policy.sigil is pending human approval; a unit with pending declassifiers cannot be attested`);
  const out: Files = { feature: readFileSync(join(dir, feature[0]), 'utf8') };
  for (const n of ['app.sigil', 'policy.sigil', 'glossary.sigil']) {
    if (!names.includes(n)) throw new SigilError(`${dir}: missing ${n}`);
    out[n] = readFileSync(join(dir, n), 'utf8');
  }
  return out;
}
export const hashUnit = (f: Files): UnitHashes => ({ program: sha256(canon(f, PROGRAM)), spec: sha256(canon(f, SPEC)) });
const unitKey = (h: UnitHashes) => `${h.program}.${h.spec}`;

// ---- keys and signatures -------------------------------------------------------------------------------------------

export interface KeyPair { pub: string; priv: string }
export function keygen(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'), priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex') };
}
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k as keyof typeof v])}`).join(',')}}` : JSON.stringify(v);

export interface Signed<T> { payload: T; by: string; sig: string }
export function signPayload<T extends { kind: string }>(payload: T, key: KeyPair): Signed<T> {
  const priv = createPrivateKey({ key: Buffer.from(key.priv, 'hex'), format: 'der', type: 'pkcs8' });
  return { payload, by: key.pub, sig: edSign(null, Buffer.from(stable(payload)), priv).toString('hex') };
}
export function verifySigned<T extends { kind: string }>(s: Signed<T>): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(s.by, 'hex'), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(stable(s.payload)), pub, Buffer.from(s.sig, 'hex'));
  } catch {
    return false;
  }
}

// ---- evidence, approval, deploy request ----------------------------------------------------------------------------

export interface Evidence {
  kind: 'evidence';
  program: string;
  spec: string;
  check: { errors: number };
  suite: { total: number; failed: number };
  mutation: { total: number; killed: number; survivors: number };
}
export interface Approval { kind: 'approval'; program: string; spec: string }
export interface DeployRequest { kind: 'deploy'; name: string; system: string }

export function gatherEvidence(files: Files): Evidence {
  const h = hashUnit(files);
  const prog = parseProgram(files['app.sigil']);
  const pol = parsePolicy(files['policy.sigil']);
  const feature = parseFeature(files.feature);
  const res = check(prog, pol);
  const g = parseGlossary(files['glossary.sigil'], prog);
  const suite = runSuite(prog, feature, g, res, DEFAULT_SUITE);
  const m = runMutation(prog, pol, feature, (p) => parseGlossary(files['glossary.sigil'], p));
  return {
    kind: 'evidence',
    ...h,
    check: { errors: errors(res).length },
    suite: { total: suite.results.length, failed: suite.results.filter((r) => r.status !== 'pass').length },
    mutation: { total: m.total, killed: m.killedByChecker + m.killedByScenarios + m.killedByContractsOnly, survivors: m.survivors.length },
  };
}

// ---- registry ------------------------------------------------------------------------------------------------------

export class Registry {
  constructor(readonly dir: string) {
    for (const d of ['units', 'evidence', 'approvals', 'releases']) mkdirSync(join(dir, d), { recursive: true });
  }
  private p(...s: string[]) { return join(this.dir, ...s); }
  putUnit(files: Files): UnitHashes {
    const h = hashUnit(files);
    mkdirSync(this.p('units', unitKey(h)), { recursive: true });
    writeFileSync(this.p('units', unitKey(h), 'unit.json'), JSON.stringify({ files }));
    return h;
  }
  /** Load a unit and re-hash it: the caller gets exactly the bytes that were attested, or an error. */
  loadUnit(h: UnitHashes): Files {
    const f = this.p('units', unitKey(h), 'unit.json');
    if (!existsSync(f)) throw new SigilError(`unit ${unitKey(h).slice(0, 12)} is not in the registry`);
    const files = (JSON.parse(readFileSync(f, 'utf8')) as { files: Files }).files;
    const actual = hashUnit(files);
    if (actual.program !== h.program || actual.spec !== h.spec) throw new SigilError(`unit ${unitKey(h).slice(0, 12)}: stored bytes hash to ${unitKey(actual).slice(0, 12)} (registry content was altered)`);
    return files;
  }
  private list<T>(kind: string, h: UnitHashes): T[] {
    const f = this.p(kind, `${unitKey(h)}.json`);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T[]) : [];
  }
  private add<T>(kind: string, h: UnitHashes, v: T) {
    writeFileSync(this.p(kind, `${unitKey(h)}.json`), JSON.stringify([...this.list<T>(kind, h), v]));
  }
  addEvidence(s: Signed<Evidence>) { this.add('evidence', s.payload, s); }
  addApproval(s: Signed<Approval>) { this.add('approvals', s.payload, s); }
  evidence(h: UnitHashes) { return this.list<Signed<Evidence>>('evidence', h); }
  approvals(h: UnitHashes) { return this.list<Signed<Approval>>('approvals', h); }
  putRelease(id: string, r: unknown) { writeFileSync(this.p('releases', `${id}.json`), JSON.stringify(r, null, 2)); }
  audit(entry: Record<string, unknown>) { appendFileSync(this.p('audit.jsonl'), `${JSON.stringify(entry)}\n`); }
}

// ---- trust and admission -------------------------------------------------------------------------------------------

export interface Trust {
  attesters: Record<string, string>;
  approvers: Record<string, string>;
  agents: Record<string, string>;
  policy?: { minKill?: number; maxSurvivors?: number };
}
export interface GateDiag { code: string; msg: string }
export interface Admission { ok: boolean; diags: GateDiag[]; release?: { name: string; system: string; deployedBy: string; units: { process: string; program: string; spec: string; evidence: string; approvedBy: string[] }[] } }

const nameOf = (m: Record<string, string>, pub: string) => Object.keys(m).find((k) => m[k] === pub);

export function admit(systemSrc: string, reg: Registry, trust: Trust, request: Signed<DeployRequest>, now = new Date().toISOString()): Admission {
  const diags: GateDiag[] = [];
  const bad = (code: string, msg: string) => diags.push({ code, msg });
  const sysHash = sha256(systemSrc);
  const deployer = nameOf(trust.agents, request.by);
  const minKill = trust.policy?.minKill ?? 1;
  const maxSurv = trust.policy?.maxSurvivors ?? 0;

  if (!verifySigned(request)) bad('G-deployer', 'deploy request signature is invalid');
  else if (!deployer) bad('G-deployer', 'deploy request is not signed by a listed agent key (humans and unknown keys cannot deploy)');
  if (request.payload.system !== sysHash) bad('G-deployer', 'deploy request signs a different system.sigil than the one submitted');

  let sys: ReturnType<typeof parseSystem> | undefined;
  try {
    sys = parseSystem(systemSrc);
    if (!sys.processes.length) bad('G-malformed', 'system declares no processes; there is nothing to admit');
    for (const d of checkSystem(sys)) bad(d.code, d.msg);
  } catch (e) {
    bad('G-malformed', e instanceof SigilError ? e.message : String(e));
  }

  const units: NonNullable<Admission['release']>['units'] = [];
  for (const p of sys?.processes ?? []) {
    const h = { program: p.program, spec: p.spec };
    const tag = `process ${p.name} (${p.program.slice(0, 8)}/${p.spec.slice(0, 8)})`;
    try {
      reg.loadUnit(h);
    } catch (e) {
      bad(/not in the registry/.test(String(e)) ? 'G-unit-missing' : 'G-unit-tamper', `${tag}: ${(e as Error).message}`);
      continue;
    }
    const good = reg.evidence(h).filter((s) => {
      const who = nameOf(trust.attesters, s.by);
      return verifySigned(s) && who && s.payload.program === h.program && s.payload.spec === h.spec;
    });
    if (!good.length) bad('G-evidence', `${tag}: no evidence signed by a trusted attester and bound to these hashes`);
    const best = good.find((s) => s.payload.check.errors === 0 && s.payload.suite.failed === 0 && s.payload.mutation.total > 0 && s.payload.mutation.killed / s.payload.mutation.total >= minKill && s.payload.mutation.survivors <= maxSurv);
    if (good.length && !best) {
      const e = good[good.length - 1].payload;
      if (e.check.errors || e.suite.failed) bad('G-evidence', `${tag}: evidence shows ${e.check.errors} check error(s) and ${e.suite.failed} failing scenario(s)`);
      else bad('G-mutation', `${tag}: mutation kill ${e.mutation.killed}/${e.mutation.total} with ${e.mutation.survivors} survivor(s); policy needs kill rate >= ${minKill} and <= ${maxSurv} survivor(s)`);
    }
    const approvers = new Set<string>();
    for (const a of reg.approvals(h)) {
      if (!verifySigned(a) || a.payload.program !== h.program || a.payload.spec !== h.spec) continue;
      const who = nameOf(trust.approvers, a.by);
      if (who) approvers.add(who);
    }
    if (!approvers.size) bad('G-approval', `${tag}: no signed approval from a trusted approver`);
    if (deployer && [...approvers].some((a) => trust.approvers[a] === request.by)) bad('G-role-conflict', `${tag}: the deploying key also approved this unit (approval and deploy must be different principals)`);
    if (best && approvers.size) units.push({ process: p.name, program: h.program, spec: h.spec, evidence: sha256(stable(best)), approvedBy: [...approvers].sort() });
  }
  const roles: [string, Record<string, string>][] = [['attester', trust.attesters], ['approver', trust.approvers], ['agent', trust.agents]];
  for (let i = 0; i < roles.length; i++)
    for (let j = i + 1; j < roles.length; j++)
      if (Object.values(roles[i][1]).some((k) => Object.values(roles[j][1]).includes(k))) bad('G-role-conflict', `trust file lists one key as both ${roles[i][0]} and ${roles[j][0]}`);

  const ok = diags.length === 0;
  const release = ok && sys ? { name: sys.name, system: sysHash, deployedBy: deployer!, units } : undefined;
  if (release) reg.putRelease(sysHash, release);
  reg.audit({ at: now, event: ok ? 'admit' : 'reject', system: sysHash, name: sys?.name, by: deployer ?? `unknown:${request.by.slice(-8)}`, codes: [...new Set(diags.map((d) => d.code))] });
  return { ok, diags, release };
}

// ---- CLI -----------------------------------------------------------------------------------------------------------

const flag = (a: string[], n: string) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
const readKey = (f: string): KeyPair => JSON.parse(readFileSync(f, 'utf8'));

export function gateMain(args: string[]): number {
  const [sub, target, ...rest] = args;
  const usage = 'usage: sigil gate keygen FILE | attest DIR --registry R --key K | approve DIR --registry R --key K | admit SYSTEM --registry R --trust T --key K';
  try {
    switch (sub) {
      case 'keygen': {
        if (!target) throw new SigilError(usage);
        const k = keygen();
        writeFileSync(target, JSON.stringify(k), { mode: 0o600 });
        console.log(`public key: ${k.pub}`);
        return 0;
      }
      case 'attest':
      case 'approve': {
        const regDir = flag(rest, '--registry'), keyFile = flag(rest, '--key');
        if (!target || !regDir || !keyFile) throw new SigilError(usage);
        const reg = new Registry(regDir), key = readKey(keyFile);
        const files = readUnit(target);
        const h = reg.putUnit(files);
        if (sub === 'attest') {
          const ev = gatherEvidence(files);
          reg.addEvidence(signPayload(ev, key));
          console.log(`attested ${h.program.slice(0, 12)}/${h.spec.slice(0, 12)}: check errors ${ev.check.errors}, scenarios failed ${ev.suite.failed}/${ev.suite.total}, mutants killed ${ev.mutation.killed}/${ev.mutation.total} (${ev.mutation.survivors} survived)`);
        } else {
          reg.addApproval(signPayload({ kind: 'approval', ...h }, key));
          console.log(`approved ${h.program.slice(0, 12)}/${h.spec.slice(0, 12)}`);
        }
        return 0;
      }
      case 'admit': {
        const regDir = flag(rest, '--registry'), trustFile = flag(rest, '--trust'), keyFile = flag(rest, '--key');
        if (!target || !regDir || !trustFile || !keyFile) throw new SigilError(usage);
        const src = readFileSync(target, 'utf8');
        const name = (() => { try { return parseSystem(src).name; } catch { return 'unparsed'; } })();
        const req = signPayload({ kind: 'deploy', name, system: sha256(src) } as DeployRequest, readKey(keyFile));
        const r = admit(src, new Registry(regDir), JSON.parse(readFileSync(trustFile, 'utf8')) as Trust, req);
        for (const d of r.diags) console.log(`${d.code}: ${d.msg}`);
        console.log(r.ok ? `ADMITTED ${r.release!.system.slice(0, 12)} (${r.release!.units.length} unit(s))` : `REJECTED (${r.diags.length})`);
        return r.ok ? 0 : 1;
      }
      default:
        console.error(usage);
        return 2;
    }
  } catch (e) {
    console.error(e instanceof SigilError ? e.message : String(e));
    return 2;
  }
}
