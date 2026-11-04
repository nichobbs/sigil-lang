# Experiment protocol: does an agent-only, provable language beat current agent codegen?

Status: DRAFT for approval. Nothing here has been run. Once approved this file is frozen; any change after the first scored run must be recorded in the "Deviations" section at the bottom with a date and reason.

## Question

Can a language designed for agents only (Sigil) give (1) agents that write correct programs from its spec alone, (2) better outcomes than the same agents writing TypeScript with a strong pipeline, (3) portability from one source, (4) a credible path to adoption? Each claim below has a pass bar set before any data exists, and a stated way to fail.

## Constraints

- Models: Claude Sonnet and Claude Haiku only.
- Budget: 10% of the user's weekly Claude plan limit. Runs are metered in tokens reported per session (input plus output as reported; cache reads recorded separately where the harness shows them). Stop rule: the pilot measures cost per run; the full run is sized to use at most 8% (2% held back for reruns and the write-up). If the pilot says the plan does not fit, shrink the design (fewer tasks, then fewer repeats, then Sonnet-only on a subset), not the bars.
- All runs are automatic: generation, scoring and token accounting are scripted. No human judgement enters a score.

## Arms (identical except for the language)

| | Sigil arm | TypeScript arm |
|---|---|---|
| Model, temperature, turn cap, token cap per task | same | same |
| Input | intent spec (Gherkin feature + glossary + policy, identical wording) + language spec | the same intent spec + brief note on the target runtime |
| Feedback tools | `check`, `verify` (flow, ranges, SMT, scenarios, mutation) | `tsc --strict`, vitest with the scenario tests ported, eslint (security rules), and one independent reviewer pass by the same model |
| Output scored on | hidden tests, trap tests, seeded-defect review | the same hidden tests, trap tests, seeded-defect review |

The TypeScript arm gets its best realistic pipeline. A weak baseline would make a win meaningless.

## Tasks

12 tasks in three tiers, each with an intent spec, a hidden test suite, and 2 to 3 traps. A trap is a requirement an agent can easily violate while still passing the visible examples (for example: a customer name must not reach telemetry; a refund must be refused for a non-admin; amounts must not overflow or go negative; user text must not reach a validated field unchecked).

- Tier A (4): pure logic with state (invoicing variant, ledger with limits, rate limiter, tiered pricing).
- Tier B (4): effects through capabilities (CRUD service with authorisation, notification sender with retry policy, audit-logged transfer, import of untrusted records).
- Tier C (4): data handling (parser for a small format, report aggregation over lists, search with filters, schedule conflict detection).

Split: Tier A tasks 1 to 4 form the DEV set. The language spec and tooling may be tuned on DEV only. Tasks 5 to 12 are HELD OUT and are not looked at until the language and spec are frozen.

Language freeze rule: if a held-out task needs a construct Sigil lacks, that task is scored as a failure for Sigil and recorded as a language gap. We do not add the construct and rerun. Gaps found are listed in the report and shape the next version only.

Each task ships a reference solution in both languages, used to validate that the hidden tests are correct and pass.

## Measures

Per run:
- M1 hidden-test pass (all or nothing), plus fraction passed.
- M2 total tokens until the first run that passes M1, or the cap (a capped fail counts the cap).
- M3 repair rounds used.
- M4 trap violations that escape (a trap test fails on a program that passed the visible examples).
- M5 spec cost: tokens in the language spec as given to the model (reported separately; with prompt caching it is paid once per session).
- M6 seeded-defect detection (see below).

Seeded-defect review (separate from generation): for each task, a correct program in each language has one defect inserted (information leak, missing authorisation, overflow, injection into a validated field, wrong audit behaviour). A reviewer agent (same model, same prompt) with that language's tooling must report it. In the Sigil arm the checker output is part of the tooling, so some defects are caught with no agent judgement; that is the claimed advantage and is reported as such, split into caught-by-tool and caught-by-agent.

## Repeats and statistics

Pilot: 2 DEV tasks x 2 arms x 2 models x 3 runs = 24 runs, to measure cost and variance.
Full design target (if the pilot allows): 12 tasks x 2 arms x Haiku x 5 runs = 120 generation runs, plus Sonnet on at least the 8 held-out tasks x 2 arms x 3 runs = 48. Seeded-defect review: 12 tasks x 2 arms x 2 models x 3 runs = 144 short runs.
Report medians and bootstrap 95% intervals per tier, per model. No pooling across models for a headline claim.

## Claims, pass bars, and how each can fail

Bars are set now, before data, and are deliberately not generous.

1. Cold authorship. On the held-out tasks, with Sonnet, Sigil passes M1 on at least 60% of tasks (median over runs) within the caps. With Haiku, at least 40%. FAIL if lower, or if the spec needs more than 25% of the per-task token cap.
2. Better outcomes than current codegen. Sigil beats TypeScript if both hold on held-out tasks (Sonnet and Haiku each): (a) escaped trap violations (M4) at most 50% of the TypeScript arm's; and (b) M2 no more than 1.5x the TypeScript arm's. Seeded-defect detection (M6) at least 20 percentage points higher in Sigil, counted with tool catches. FAIL if (a) fails. If (a) holds and (b) fails, report "safer but costlier" honestly.
3. Portable. Every Sigil program that passes M1 and compiles to Wasm must give byte-identical outputs from the same inputs on the interpreter, Node and a headless browser (and a standalone runtime if installable), over a seeded input set. FAIL on any divergence that is not a host bug found and fixed in the harness. Report how many held-out programs are compilable at all; that fraction is a headline number, not a footnote.
4. Plausible adoption. Demonstrated, not argued: a Sigil module called from TypeScript through Wasm; a Sigil program calling an existing JS library through a capability-wrapped boundary; and a one-page evidence bundle (manifest, flow matrix, proved obligations, mutation score) that a reviewer can check without reading code. FAIL if the first two cannot be built in the existing runtime.

## Threats to validity (stated in advance)

- The models know TypeScript deeply and Sigil not at all. Claim 1 and 2 measure the cold-start case on purpose. A fine-tuned model would change the picture and is out of scope.
- Spec and tool tuning on DEV tasks could leak into held-out results. Mitigated by the freeze above.
- The traps are authored by us. Mitigation: write traps from published weakness categories (leaks, authorisation, overflow, injection), fix them before generation, and keep trap tests hidden from both arms.
- Small task count. Results are evidence about this task family, not a general proof. The write-up says so.
- The Sigil checker is itself not proved. A Sigil "pass" means passed our checker and tests. The report lists any soundness bug found during the experiment; one escaping the checker counts against claim 2.
- Token counts come from session metering, not a controlled tokenizer comparison.

## Outputs

- `experiments/` with task specs, hidden tests, scorers, run logs and raw results (all runs, including failures).
- A short report with the table of claims, pass or fail, the numbers, the gaps found, and the cost actually spent. Negative results are published as they are.

## Deviations

(none yet)
