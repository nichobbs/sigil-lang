// sigil spec <init|review|approve|promote|check> DIR [--as NAME] [--role ROLE] [--mutation]
//   init      adopt the current glossary.sigil: write spec.history so later edits are detectable
//   review    render the review packet for proposed-glossary.sigil (exit 0; READY/NOT READY is in the text)
//             --mutation also reruns mutation testing with both glossaries and lists mutants the proposal no longer catches
//   approve   record an approval of the current proposal by a named owner or reviewer
//   promote   if the sign-off rules in spec.owners are met, replace glossary.sigil with the proposal
//   check     fail (exit 1) if glossary.sigil was changed by anything other than promote (use in CI)

import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Approval, approvalLine, coverage, diffGlossary, gate, parseApprovals, parseEntries, parseOwners, proposalHash, renderReview, sha256, sinkPolicy, declaredDeclassifiers } from './spec.js';
import { parsePolicy, parseProgram } from './parse.js';
import { parseFeature, parseGlossary } from './scenario.js';
import { runMutation } from './mutate.js';
import { isList, isSym, readAll, SigilError } from './sexpr.js';

const GLOSSARY = 'glossary.sigil';
const PROPOSAL = 'proposed-glossary.sigil';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function state(dir: string) {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  const has = (f: string) => existsSync(join(dir, f));
  return { read, has };
}

function lastPromotedSha(history: string): string | undefined {
  if (!history.trim()) return undefined;
  const forms = readAll(history);
  const last = forms[forms.length - 1];
  if (!isList(last)) return undefined;
  const c = last.items.slice(1).find((x) => isList(x) && isSym(x.items[0], 'glossary-sha'));
  return c && isList(c) && c.items[1]?.t === 'str' ? c.items[1].v : undefined;
}

const historyLine = (sha: string, proposal: string, by: string) =>
  `(promoted (glossary-sha "${sha}") (proposal "${proposal}") (by ${by}) (at "${new Date().toISOString()}"))\n`;

export function specMain(args: string[]): number {
  const [sub, dir = '.'] = args;
  const { read, has } = state(dir);
  try {
    switch (sub) {
      case 'init': {
        const by = flag(args, '--as');
        if (!by) throw new SigilError('spec init needs --as NAME (the spec owner)');
        const owners = parseOwners(read('spec.owners'));
        if (by !== owners.owner) throw new SigilError(`only the spec owner (${owners.owner}) can adopt a glossary`);
        if (has('spec.history')) throw new SigilError('spec.history already exists');
        writeFileSync(join(dir, 'spec.history'), historyLine(sha256(read(GLOSSARY)), 'adopted', by));
        console.log('adopted glossary.sigil; later edits must go through spec promote');
        return 0;
      }
      case 'review': {
        const base = read(GLOSSARY);
        const prop = read(PROPOSAL);
        const owners = parseOwners(read('spec.owners'));
        const entries = parseEntries(prop);
        const changes = diffGlossary(parseEntries(base), entries);
        const hash = proposalHash(base, prop);
        const approvals = has('spec.approvals') ? parseApprovals(read('spec.approvals')) : [];
        const feat = readdirSync(dir).find((f) => f.endsWith('.feature'));
        const cov = feat ? coverage(read(feat), entries) : undefined;
        let mutation;
        if (args.includes('--mutation')) {
          if (!has('app.sigil') || !has('policy.sigil') || !feat) throw new SigilError('spec review --mutation needs app.sigil, policy.sigil and a .feature file in DIR');
          const prog = parseProgram(read('app.sigil'));
          const pol = parsePolicy(read('policy.sigil'));
          const ft = parseFeature(read(feat));
          const run = (g: string) => runMutation(prog, pol, ft, (p) => parseGlossary(g, p), { propCases: 150, privacyCases: 40 });
          const b = run(base);
          const r = run(prop);
          mutation = { total: b.total, baseKilled: b.killed.length, propKilled: r.killed.length, lost: b.killed.filter((k) => !r.killed.some((x) => x.id === k.id)).map((k) => `${k.fn}: ${k.desc}`) };
        }
        console.log(renderReview({ mutation, changes, cov, gate: gate(changes, owners, approvals, hash), hash, owners, policy: has('policy.sigil') ? sinkPolicy(read('policy.sigil')) : undefined, declared: has('policy.sigil') ? declaredDeclassifiers(read('policy.sigil')) : undefined }));
        return 0;
      }
      case 'approve': {
        const by = flag(args, '--as');
        const role = flag(args, '--role');
        if (!by || !role) throw new SigilError('spec approve needs --as NAME --role ROLE (use --role owner for the owner)');
        const base = read(GLOSSARY);
        const prop = read(PROPOSAL);
        const owners = parseOwners(read('spec.owners'));
        const members = role === 'owner' ? [owners.owner] : (owners.reviewers.get(role) ?? []);
        if (!members.includes(by)) throw new SigilError(`${by} is not listed as ${role} in spec.owners`);
        const a: Approval = { proposal: proposalHash(base, prop), by, role, at: new Date().toISOString() };
        appendFileSync(join(dir, 'spec.approvals'), approvalLine(a));
        console.log(`recorded: ${by} approves ${a.proposal.slice(0, 12)} as ${role}`);
        return 0;
      }
      case 'promote': {
        const base = read(GLOSSARY);
        const prop = read(PROPOSAL);
        const owners = parseOwners(read('spec.owners'));
        const changes = diffGlossary(parseEntries(base), parseEntries(prop));
        const hash = proposalHash(base, prop);
        const g = gate(changes, owners, has('spec.approvals') ? parseApprovals(read('spec.approvals')) : [], hash);
        if (!g.ok) {
          console.error('not promoted: sign-off incomplete');
          for (const m of g.missing) console.error(`  missing ${m.role} (${m.because.join(', ')}); one of: ${m.candidates.join(', ')}`);
          for (const i of g.ignored) console.error(`  ignored: ${i}`);
          return 1;
        }
        if (has('spec.history')) {
          const want = lastPromotedSha(read('spec.history'));
          if (want && want !== sha256(base)) throw new SigilError('glossary.sigil does not match spec.history: it was edited outside promote; run spec check');
        }
        if (!has('spec.history')) console.error('warning: no spec.history, so there is no tamper check; run spec init first');
        // History first: if a later step fails, check flags the glossary instead of silently trusting an unrecorded edit.
        appendFileSync(join(dir, 'spec.history'), historyLine(sha256(prop), hash, g.satisfied.map((s) => `${s.by}`).join('+')));
        writeFileSync(join(dir, GLOSSARY), prop);
        rmSync(join(dir, PROPOSAL));
        console.log(`promoted ${hash.slice(0, 12)}: ${changes.length} change(s); approved by ${g.satisfied.map((s) => `${s.by} (${s.role})`).join(', ')}`);
        return 0;
      }
      case 'check': {
        if (!has('spec.history')) {
          console.log('glossary is not under spec control (run spec init)');
          return 0;
        }
        const want = lastPromotedSha(read('spec.history'));
        if (want !== sha256(read(GLOSSARY))) {
          console.error('FAIL: glossary.sigil differs from the last promoted version. Changes must go through proposed-glossary.sigil and spec promote.');
          return 1;
        }
        console.log(`ok: glossary.sigil matches the last promotion${has(PROPOSAL) ? ' (a proposal is pending)' : ''}`);
        return 0;
      }
      default:
        throw new SigilError('usage: sigil spec <init|review|approve|promote|check> DIR [--as NAME] [--role ROLE]');
    }
  } catch (e) {
    console.error(e instanceof SigilError || e instanceof Error ? `error: ${e.message}` : String(e));
    return 2;
  }
}
