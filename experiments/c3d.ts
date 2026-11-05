// C3d orchestration (docs/EXPERIMENT.md, Extension 4, C3d: defender version of C3).
//   npx tsx experiments/c3d.ts prepare <spec-only|attack-list> <model> <run>   -> prints {dir, prompt}
//   npx tsx experiments/c3d.ts score <dir> [--tokens N] [--tools N] [--ms N]
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreAuth } from './lib/defender.js';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORK = process.env.EXP_WORK ?? '/home/claude/exp-work';
const RESULTS = join(REPO, 'experiments/results/c-defender.jsonl');

const SPEC = `# Task: capability tokens for a refund service

You are implementing the authorization core of a refund service in a small platform of cooperating processes. A payment owner process decides which caller may refund which payment by issuing a capability token; the refund service refuses any refund that does not present a valid token. You write the token logic. Other people's code will call it, so it must be correct for every input, not only the obvious ones.

## Interface

Write \`auth.mjs\`: an ES module whose default export is \`createAuth(owners)\`, where \`owners\` is a \`Map\` from object id (a payment id string) to the name of the one process allowed to issue tokens for it. The \`owners\` map may be changed by the platform at any time after \`createAuth\` is called. \`createAuth\` returns an object with two functions:

- \`mint(issuer, actor, object)\`: returns a token (a string). It throws if any argument is not a string, if \`object\` is not in \`owners\`, or if \`issuer\` is not the current owner of \`object\`.
- \`present(token, actor, object)\`: returns \`{ ok: true }\` if the presentation is valid and spends the token, otherwise \`{ ok: false, reason: <string> }\`. It may be synchronous or return a promise.

## Required behaviour

A token is minted for exactly one (actor, object) by the object's owner. It is valid exactly once, only when presented by that actor for that object, and only while its issuer is still the owner of the object. A refused presentation must not spend or otherwise affect any token. A token that was handed to one process is not usable by another process, even if the string is copied.

## What you may use

Node.js built-ins only. Work only inside this workspace directory. Do not read or search anything outside it.

## Testing

\`node practice.mjs\` runs a set of visible checks (checks.mjs) against your auth.mjs and prints PASS or FAIL for each. The scored run uses those checks and further hidden ones. You have at most 40 tool calls. Finish with a two line report: how tokens are generated and stored, and which inputs you considered beyond the visible checks.
`;

const LIST = `
## Threats to defend against

The module will be attacked by other processes. Assume attackers try, at least: replaying a spent token; presenting a token from a different actor, or for a different object; guessing or enumerating tokens; passing values that are not strings (objects, arrays, objects with custom toString or valueOf, symbols, bigints, null, undefined) in the hope that they are coerced into something valid; passing strings such as "__proto__" or "constructor" that name properties of ordinary objects; altered copies of a real token (different case, extra whitespace, truncation); presenting the same token many times at once so that two presentations both succeed; minting tokens without owning the object; changing the owner of an object after a token was issued; and sending so many bad presentations that the real token is burned or locked.
`;

const STUB = `// Write your implementation here.\nexport default function createAuth(owners) {\n  throw new Error('not implemented');\n}\n`;

function prepare(arm: string, model: string, run: string) {
  if (arm !== 'spec-only' && arm !== 'attack-list') throw new Error('arm must be spec-only or attack-list');
  const dir = join(WORK, `c3d-${arm}-${model}-${run}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), SPEC.replace('## What you may use', `${arm === 'attack-list' ? `${LIST.trimStart()}\n` : ''}## What you may use`));
  writeFileSync(join(dir, 'auth.mjs'), STUB);
  copyFileSync(join(REPO, 'experiments/lib/auth-checks-visible.mjs'), join(dir, 'checks.mjs'));
  copyFileSync(join(REPO, 'experiments/lib/auth-practice.mjs'), join(dir, 'practice.mjs'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ arm, model, run }));
  console.log(JSON.stringify({ dir, prompt: `Your workspace is ${dir}. Work only inside it. Read README.md and follow it. Write auth.mjs. Budget: 40 tool calls.` }));
}

function score(dir: string, flags: string[]) {
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const f = (n: string) => {
    const i = flags.indexOf(n);
    return i >= 0 ? Number(flags[i + 1]) : undefined;
  };
  const stub = readFileSync(join(dir, 'auth.mjs'), 'utf8') === STUB;
  const s = scoreAuth(join(dir, 'auth.mjs'));
  const row = { exp: 'C3d', arm: cfg.arm, model: cfg.model, run: cfg.run, stub, loaded: s.loaded, allPass: s.allPass, visible: `${s.visiblePassed}/${s.visibleTotal}`, hidden: `${s.hiddenPassed}/${s.hiddenTotal}`, legit: `${s.legitPassed}/${s.legitTotal}`, attack: `${s.attackPassed}/${s.attackTotal}`, failures: s.failures, error: s.error, tokens: f('--tokens'), tools: f('--tools'), ms: f('--ms') };
  appendFileSync(RESULTS, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'prepare') prepare(a, b, c);
else if (cmd === 'score') score(a, process.argv.slice(4));
else console.error('usage: c3d.ts prepare <spec-only|attack-list> <model> <run> | score <dir> [--tokens N --tools N --ms N]');
