# Glossary

Terms used in this repo, grouped by where they come up. For the language itself see `LANGUAGE.md`; for the experiment protocol see `EXPERIMENT.md`.

Not to be confused with `glossary.sigil`, which is a per-example file that binds feature phrases ("Given a gold customer") to program calls. This document is prose for people.

## The language

**Sigil.** The working name of the language: a language intended to be written by AI agents only, where a human reviews a readable intent layer rather than source code.

**Intent layer.** What humans read and own: a `.feature` file (rules, examples, properties), `glossary.sigil` and `policy.sigil`. Agents may not edit these.

**Implementation layer.** `app.sigil`: the program, written by the agent as a typed tree in S-expression form.

**Evidence layer.** What the tools produce about the implementation: range proofs, the flow matrix, scenario results, mutation report. It is what lets a reviewer trust the program without reading it.

**Feature file.** The human-readable spec, in a Gherkin-like form. It has these parts:
- **Rule**: a decision table (inputs and the expected result per row).
- **Example**: one concrete scenario (Given, When, Then). Run as a test.
- **Always**: a property that must hold for all inputs, checked by random testing.
- **Privacy**: a statement that a field must not reach a sink.
- **Unresolved**: a question the spec author deliberately left open, surfaced to a human instead of guessed.

**Glossary (`glossary.sigil`).** Binds the phrases used in a feature file to calls and checks on the program, so Examples and Always paragraphs can run.

**Policy (`policy.sigil`).** Declares data classification and what each output sink may receive. Also declares declassifiers.

**Ranged integer.** An integer type with declared bounds, such as `(Int 0 100)`. The machine representation (i32, i64, bigint) is derived by the checker from the ranges, not chosen by the author.

**Result.** The return type for anything that can fail: `ok` or `err`. There are no exceptions and no null.

**Capability.** A handle a function must declare it needs (for example `needs store:quotes`) before it can touch the outside world. Deny by default.

**Sink.** A place data leaves the program: a store, a network post or an audit event.

**Host.** The environment a program runs in. The mock host records effects and can inject failures.

## Checking

**`check`.** Fast static checks: parse, names and arities, ranges, capabilities, information flow, `ensures` clauses.

**`verify`.** `check` plus the feature scenarios, rules, properties, privacy runs and mutation testing.

**Interval analysis.** Abstract interpretation over value ranges. It proves that arithmetic cannot overflow and that divisors are non-zero. It does not follow `if` conditions, which is why programs sometimes need `min` and `max` clamps.

**Obligation.** A fact the checker must establish, such as "this sum fits the declared range". Shown as PROVED, FAILED or UNPROVED. FAILED and UNPROVED are defects.

**`ensures`.** A postcondition on a function. Tested at run time and, where possible, proved. Relational ones are discharged by SMT.

**SMT.** The z3 solver, used to prove properties such as "the discounted total never exceeds the gross total".

**Information flow.** Labels on data: confidentiality (public, internal, pii, secret) and integrity (untrusted, screened, validated, approved, trusted). The checker rejects a flow from a more sensitive source to a less sensitive sink, including through branching (an implicit flow).

**Flow matrix.** A table of which sources reach which sinks, shown in `check` output. `(REJECTED)` marks a violation.

**Declassifier.** A declared, named exception that allows a flow down a label (for example pii to internal) with a stated reason. The checker does not verify that the code really reduces the information; a reviewer must judge it. Privacy results report "PASS MODULO DECLASSIFIER".

**Vacuous (privacy check).** A privacy check passes vacuously when the protected field never reaches any sink, so there was nothing to test. It is a warning, not a failure.

**Noninterference.** The idea behind privacy runs: changing a protected input must not change what reaches a public sink. Tested by running the program twice with different protected values.

## Testing the spec

**Scenario.** One Example from a feature file, run against the program.

**Property.** An `Always` paragraph, checked on many random inputs.

**Mutant.** A copy of the program with one small deliberate change, such as `>` turned into `>=`, a constant changed, or a statement deleted.

**Killed.** A mutant is killed when at least one scenario or property fails on it. That is good: the spec noticed the change.

**Survivor (survived mutant).** A mutant that no scenario or property caught. It means the human-readable spec does not pin that behaviour. Survivors are reported to the humans who own the spec; the agent does not edit the spec to fix them.

**Mutation score.** Killed mutants divided by all mutants. A measure of how tightly the spec constrains the program, not of the program's correctness.

**Differential testing.** Running the same inputs through two implementations (here the interpreter and the compiled Wasm) and requiring identical results.

## The experiment

**Arm.** One side of the comparison: the Sigil arm or the TypeScript arm. Same model, same intent spec, same budget; only the language and its tools differ.

**Task.** One program to implement, with an intent spec, hidden tests and reference solutions. IDs are A1 to A4, B1 to B4, C1 to C4.

**Tier.** A: pure logic with state. B: effects through capabilities. C: data handling.

**DEV set.** Tasks A1 to A4. The language, spec and tooling were tuned using only these.

**Held-out set.** Tasks B1 to B4 and C1 to C4. Not looked at until the language was frozen.

**Freeze.** The point (see `FREEZE.md`) after which the language, spec and checker do not change for the held-out tasks.

**Language gap.** A construct the task needs that Sigil lacks. Under the freeze rule it is not added: the task scores as a Sigil failure and the gap is recorded for the next version.

**Visible files.** What the agent under test sees: the task README, the feature file, and for Sigil the glossary and policy. Examples here show happy paths only.

**Hidden cases.** The scorer's test cases (`hidden/cases.json`), which go beyond the visible Examples. The agent never sees them. Each gives arguments, host configuration and the expected result and effects.

**Trap.** A requirement an agent can easily violate while still passing every visible Example (for example "a name must not reach the audit log", or "the cap is on the running total, not per refund"). Each task has two or three, and each has one hidden case marked as its trap.

**Trap violation.** A trap case that fails. If the program passed the visible examples, it is an escaped trap violation (measure M4).

**Reference solution.** A correct implementation of a task in each language, written by the task author. Used only to prove the hidden cases are valid; never given to the agents under test.

**Broken variant.** A deliberately wrong version of a reference solution (an off-by-one, a leaked field, a missing effect). The task's tests check that the hidden cases catch every one, which shows the hidden cases are sensitive enough.

**Oracle.** A throwaway independent calculation of the expected results, used to write the hidden cases without trusting either reference. Not committed.

**Effects.** What a program did to the outside world, recorded by the scorer: `stored` (values put in a store), `sent` (payloads posted), `emitted` (audit events). Compared exactly and in order.

**`forbid`.** A hidden-case field listing strings that must not appear anywhere in the effects. Used for privacy traps where the exact shape of a leak cannot be predicted.

**Entry point.** The one function (or `run` in TypeScript) the scorer calls. Fixed by the task README.

**Workspace.** The clean directory an agent works in for one run. It holds only the visible files and that arm's tooling. Hidden cases and references stay in the repo.

**`leakHints`.** A search of an agent's transcript for hidden or reference paths. A hint to be read by hand, not a verdict.

**Pilot.** A small first batch of runs to measure token cost and variance before sizing the full experiment.

**Probe.** A pilot run done on its own to check that the pipeline and its cost estimate work.

**Measures.**
- M1: hidden-test pass (all or nothing, plus the fraction passed).
- M2: tokens used up to the first passing run, or the cap.
- M3: repair rounds used.
- M4: trap violations that escape.
- M5: spec cost, the tokens in the language spec given to the model.
- M6: seeded-defect detection.

**Seeded defect.** A single defect (a leak, a missing authorisation check, an overflow) inserted into a correct program, which a reviewer agent must find. Used for M6.

**Claim.** One of the four statements the experiment tests (cold authorship, better outcomes than current codegen, portability, plausible adoption). Each has a pass bar fixed before any data existed.

**Token proxy.** Token counts here use OpenAI tokenizers, not Claude's. Only relative numbers mean anything.

## Wasm backend

**Compilable.** A function is compilable when it is pure, numeric (or a bounded list of numbers), and has no checker errors or unproved obligations. Anything else is reported as "not compilable" with the reason, never miscompiled.

**Scratch memory.** The fixed region a compiled list function uses for intermediate lists. Its size is a compile-time number, so there is no dynamic allocation.

**Validating wrapper.** What a compiled module exports for each function: code that checks every argument against its declared type (ranges, enum cases, `Str :max`, list lengths and memory bounds) and traps through `contract_violation` before calling the internal, unchecked body. It is why a compiled module rejects out-of-range input the way the interpreter does, instead of trusting its caller (ABI version 2).
