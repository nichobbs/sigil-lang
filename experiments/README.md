# Experiment harness

Scoring harness for the protocol in `docs/EXPERIMENT.md` (frozen; not edited here). A task is scored the same way
in both languages: hidden, language-neutral cases are run against a solution, and one scoring function compares
results and effects.

```
npx tsx experiments/run.ts <taskId> <sigil|ts> <path-to-solution>
npx tsx experiments/run.ts A1 sigil experiments/tasks/A1-tiered-pricing/ref/sigil/app.sigil
npx tsx experiments/run.ts A1 ts    experiments/tasks/A1-tiered-pricing/ref/ts/solution.ts
```

```ts
import { runTask } from './experiments/run.js';
const score = await runTask('A1-tiered-pricing', 'ts', 'work/solution.ts', { timeoutMs: 2000 });
```

`taskId` is the directory name under `experiments/tasks/`, or its prefix before the first dash (`A1`). The solution
path is a file, or a directory (then `app.sigil` / `solution.ts` inside it). Output (printed as JSON by the CLI,
returned by `runTask`):

```json
{ "total": 32, "passed": 32, "trapTotal": 3, "trapViolations": 0,
  "failures": [ { "name": "...", "trap": false, "reason": "result differs at $.ok.total: expected ..., got ..." } ] }
```

`trapViolations` is the number of failed cases marked `trap`. The CLI exits 0 if everything passed, 1 if not, and 2 on
a harness error (bad arguments, missing or malformed `cases.json`). A solution that is missing, does not parse, or has no
default export fails every case with one reason; it is never a harness error.

## Layout

```
experiments/
  run.ts                 CLI and runTask()
  lib/score.ts           the one scoring function (judge + score), case-file loading
  lib/json.ts            value encoding shared by both runners
  lib/sigil-runner.ts    parse, decode args by declared types, run on the reference interpreter, encode back
  lib/ts-runner.ts       runs the solution in a worker thread, per-case timeout, respawn on hang or crash
  lib/ts-worker.mjs      worker body (loads the .ts with tsx)
  lib/host.ts            TypeScript Host: same mock semantics as src/interp.ts Host
  tasks/<id>/
    visible/             what the agent gets: intent.feature, glossary.sigil, policy.sigil, README.md
    hidden/cases.json    what the agent must never see
    ref/sigil/app.sigil  reference solutions; both must score 100%
    ref/ts/solution.ts
```

## Case file: `hidden/cases.json`

The directory is read from `$EXPERIMENT_HIDDEN_DIR` (the directory that contains `cases.json`), default
`experiments/tasks/<id>/hidden`, so an orchestrator can keep the cases out of the agent's workspace. `runTask` also takes
`{ hiddenDir }`. Expected values never enter the solution's process (the TypeScript solution runs in a worker that is
only sent `args` and the `host` configuration).

```json
{ "entry": "fn-name",
  "cases": [ {
    "name": "unique, human-readable",
    "trap": true,
    "args":   { "param": <JSON>, "...": "..." },
    "host":   { "store": { "handle": { "key": <JSON> } },
                "fail":  [ { "handle": "store:quotes", "op": "put" } ],
                "seed":  1 },
    "expect": { "result": <JSON>,
                "effects": { "stored": [<JSON>], "sent": [<JSON>], "emitted": [<JSON>] },
                "forbid": ["substring", "..."] }
  } ] }
```

- `entry`: the Sigil function name. The TypeScript solution always exposes one entry, `run`.
- `args`: one JSON value per declared parameter, keyed by parameter name (Sigil: the names in the entry's `(in ...)`; TypeScript:
  the properties of the first argument to `run`).
- `host` (all optional): `fail` makes an operation fail with no effect (`op` is `put`, `get`, `post`, `emit` or `fresh`);
  `seed` seeds `rand.fresh` (default 1; the same sequence in both languages); `store` seeds readable data for `get`.
  `store` is only supported by the TypeScript runner: the interpreter's `get` is not implemented (see Known gaps), so a
  Sigil case with a non-empty `store` fails with a harness reason.
- `expect.result`: the encoded return value. `expect.effects.stored|sent|emitted` are the successful effects in call order,
  flat across handles: values passed to `put`, payloads passed to `post`, events passed to `emit`. A missing list means
  "none", so unexpected effects fail the case. Failed operations (`fail`) are not effects. Keys are not compared.
- `expect.forbid` (optional): strings that must not appear anywhere inside the JSON text of the effects. Use it for privacy
  traps, where the exact shape of a leak cannot be predicted.
- `trap: true` marks a case that an agent can violate while passing the visible examples (protocol measure M4).

### Value encoding

| Value | JSON |
|---|---|
| ranged `Int` / number | JSON number. Every id and amount must stay below 2^53; the runners reject larger ones |
| `Str` | string |
| `Bool` | boolean |
| enum value | its case name, a string (`"Gold"`) |
| record | object, field names as declared |
| list | array |
| `Result` | `{"ok": v}` or `{"err": v}`; an error variant is its case name: `{"err": "StoreFailed"}` |
| unit | `null` |

Records carry no type tag, so an audit event is told apart by its fields. Object key order does not matter; array order does.
The Sigil runner decodes `args` using the entry function's declared parameter types (an enum argument must be a valid case,
a record must have every field), and runtime range checks (contracts) are on, so an out-of-range value is a failure.

## TypeScript solutions

A solution is one `.ts` file with `export default async function run(args, host)` (sync is fine too). It must not depend on
anything but Node built-ins and itself. `host` (`experiments/lib/host.ts`, async like real I/O):

```ts
host.store.put(handle, key, value): Promise<{ ok: boolean }>        // ok:false when "handle put" is in host.fail
host.store.get(handle, key):        Promise<{ ok: true; value: unknown | null } | { ok: false }>
host.net.post(handle, payload):     Promise<{ ok: boolean }>
host.audit.emit(handle, event):     Promise<void>
host.rand.fresh(handle):            Promise<number>                  // seeded, same sequence as the interpreter
```

The harness records effects itself; the solution cannot change what was recorded. Values passed to the host must be plain JSON
(no bigint, undefined, class instances); anything else throws inside the solution. The return value must be plain JSON too.
Each case has a timeout (default 2 s). On timeout the worker is killed and replaced and the remaining cases still run; a thrown error,
a rejected promise, a process exit or a non-JSON result is that case's failure with a reason.

## Sigil solutions

One `.sigil` file with the types, functions and (optionally) the `program` wiring. Cases run on `src/interp.ts` with `Host` and
contracts on. Only the interpreter is exercised: `check` and `verify` (flow, range proofs, scenarios, mutation) are separate tools
and are not part of this score.

## Adding a task

1. Create `experiments/tasks/<ID>-<slug>/` with `visible/`, `hidden/`, `ref/sigil/app.sigil`, `ref/ts/solution.ts`.
2. `visible/` holds the intent (`intent.feature`, `glossary.sigil`, `policy.sigil`) and a `README.md` that fixes the entry signature, the exact
   record shapes of everything stored, sent or emitted, the JSON conventions, and (TypeScript) the host calls. The scorer compares
   effects exactly, so everything it compares must be stated there. Keep the feature in the repo's Feature / Rule / Example / Always / Privacy form.
3. Write `hidden/cases.json` (at least 25 cases, 2 to 3 marked `trap`). Compute expectations from an implementation that is
   neither reference solution, or by hand, then confirm all three agree.
4. Run both references through the runners; both must score 100%. Also run `npx tsx src/cli.ts verify <dir>` on a directory holding
   the Sigil reference plus the visible files: the visible examples must pass on the reference.
5. Add broken variants for the new task to `test/experiments.test.ts` (or generalise its variant table).

## Checklist for a task author

- [ ] Every requirement a hidden case tests is derivable from `visible/` by a careful reader. No trick questions, no unstated conventions
      (rounding direction, order of operations, inclusive/exclusive limits, what is audited on a refusal are all written down).
- [ ] Visible Examples cover happy paths only. Each trap passes every visible Example when violated.
- [ ] Each trap has exactly one case marked `trap`, and that case fails for the natural wrong implementation, not only for an exotic one.
- [ ] Boundary values are covered on both sides of every threshold (limit, limit + 1; tier edges; empty and maximum lists).
- [ ] Ids and amounts stay below 2^53; the declared type ranges in the README match the reference's types.
- [ ] Reference solutions pass 100% in both runners, were not used to generate the expectations, and agree with an independent calculation.
- [ ] At least four deliberately broken variants per language are caught: an off-by-one at a boundary, a trap violation (one per trap), wrong rounding,
      a missing effect. Trap variants must raise `trapViolations`.
- [ ] `visible/` contains nothing that quotes hidden cases, and `hidden/` is excluded from the agent's workspace.
- [ ] The Sigil reference passes `verify` with the visible files (no diagnostics, all Examples and Always pass).

## Known gaps

- The interpreter's `Host` has no `get` (and the language has no option type), so seeded `host.store` cannot be exercised from Sigil. Tasks that
  need to read state cannot be scored in both languages yet. This is a language gap in the sense of the freeze rule in the protocol.
- Effects are compared flat across handles; the handle a value was sent to is not compared. A task that depends on the destination must make
  the payloads distinguishable.
- The timeout is per case on a worker thread; a solution that spins in a native call or starves the event loop is killed, but memory exhaustion
  inside the worker is bounded only by Node's defaults.

## Orchestration (pilot and full runs)

`experiments/orchestrate.ts prepare <task> <sigil|ts> <model> <run>` builds a clean workspace under `$EXP_WORK` (default `/home/claude/exp-work`) and prints the prompt to give a fresh agent; `score <dir> [--tokens N --tools N --ms N --transcript FILE]` scores the result with the hidden cases (read from this repo, never copied into a workspace) and appends a record to `experiments/results/pilot.jsonl`.
- Sigil workspace: the bundled checker (`sigil.mjs`, not the source tree), `LANGUAGE.md`, `WORKFLOW.md`, and `task/` with the visible files.
- TypeScript workspace: `experiments/ts-kit` (strict tsc, eslint with the security plugin, vitest, a mock host), `README.md` and `intent.feature`. It does not get `glossary.sigil` or `policy.sigil` (Sigil bindings); the classification is in the README prose. The agent writes its own vitest tests from the examples, rather than receiving ported ones.
- Caps are advisory: 40 tool calls stated in the prompt; tokens and tool calls are read from the agent's reported usage afterwards.
- Hidden-case isolation is by instruction and audit (the transcript is searched for hidden/ref paths), not by sandbox.
- The independent reviewer pass for the TypeScript arm is not part of the pilot.

### Scorer notes from the cost probe
- Sigil arguments bind by name when every parameter name matches the case file, otherwise by position (the task README fixes the order; the agent chooses names). The first probe named a parameter `ls` for `lines` and scored 0/32 under strict naming; this was a scorer fix applied to all runs, not a solution fix.
- `leakHints` searches the agent transcript for hidden or reference paths; it is a hint, to be read by hand.

## v1 workflow changes (2026-11-04)

Runs made after language v1 use a changed Sigil workflow. Report them separately from the frozen runs (see `docs/FREEZE.md`).
- `verify --fast` (check plus scenarios, no mutation) and one-shot guidance in WORKFLOW.md. Agents are told not to run the full `verify`: in the transcripts it outran the shell timeout and cost 5 to 8 polling calls, and its survivors never caused an edit. The scorer still runs the full `verify` afterwards, so the mutation evidence is unchanged.
- Diagnostics: an undeclared or bare type (`Int`, `List`) is an error instead of a crash, unknown functions get a hint (`char-at` points at `chars` and `at`), and a number where a record is declared is `E-type` at check time.
- `sigil fix`: suggests exact edits (clamps, `take`, `(max 1 d)`, missing `needs`) for open findings.
- The Sigil PROMPT.md now names `fix` and `--fast`. The TS arm is unchanged, so it has no equivalent aid.
