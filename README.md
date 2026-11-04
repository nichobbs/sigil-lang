# Sigil (working name)

A prototype of a programming language intended for AI agents only: token-efficient to produce, secure by construction, verifiable, explainable, and reviewable without a human reading the source. Humans review a readable intent layer (scenarios, glossary, policy), not code.

This repo is a feasibility prototype in TypeScript, not a compiler. There is no Wasm backend.

## Layers

| Layer | Who reads it | Files in `examples/invoicing` |
|---|---|---|
| Intent | humans | `invoicing.feature` (Rule / Example / Always / Privacy / Unresolved), `glossary.sigil`, `policy.sigil` |
| Implementation | agents | `app.sigil` (typed tree, canonical S-expression serialization) |
| Evidence | agents and CI | produced by `check`, `verify`: range proofs, flow matrix, scenario results, mutation report |

## Run

```
npm install
npm test                 # vitest, 48 tests
npm run check            # interval analysis, capabilities, information flow
npm run verify           # check + scenarios + properties + privacy + mutation adequacy
npm run compare          # syntax token comparison + single-token-deletion fragility
```

## What is implemented

- Total core language: ranged integers (representation derived, no machine ints), no null or exceptions, `Result` with `try ... :on-err`, capability handles with `needs` declarations, deny-by-default sinks.
- Interval abstract interpretation over bigints: range obligations, no overflow, non-zero divisors, derived i32/i64/bigint representation, three-valued evaluation of `ensures`.
- Information-flow checker: confidentiality (`public < internal < pii < secret`) and integrity (`untrusted < screened < validated < approved < trusted`) labels per field, implicit flows via branching, provenance paths in counterexamples, flow matrix.
- Reference interpreter with a mock host (effect log, failure injection, seeded PRNG) and runtime contracts.
- Scenario compiler: Gherkin-style feature files bound to actions through a glossary; decision-table exhaustiveness; property tests; privacy scenarios (static flow matrix plus dynamic two-run noninterference with a vacuity check); open questions surfaced to humans.
- Mutation testing to measure whether the human-reviewable spec actually constrains the implementation.
- Five surface syntaxes for the same AST, with a token comparison and a fragility experiment.

## Findings

1. **Intervals prove safety; SMT closes the relational gap.** Intervals prove all range, overflow and divisor obligations and derive `i64` for `price-invoice` (max intermediate 2e16), but cannot prove `ensures (<= out (gross ls))`. `src/smt.ts` (z3, via `z3-solver`) now discharges it: `verify` reports it as PROVED (SMT). The encoding covers integer arithmetic, comparisons, `if`, `let`, enum `match` and record field reads; calls to other functions (here `gross`, `discount`) are abstracted as constants constrained only by the callee's declared output range, so a proof is conditional on the callee's own (separately checked) contract. This is sound but incomplete: what `sum` over a list means is not modelled, so an `ensures` that depends on it is `unsupported`/unproved and falls back to runtime checks. Mutation sanity checks: allowing a negative Pct (a surcharge) gives a counterexample, and a too-strong `<` ensures is refuted with a concrete plan (Free). One bug found while writing it: assuming the function's own declared output range as a premise makes the proof vacuous whenever the body can leave that range, so the range is not assumed.
2. **Flow checking works on the example.** Telemetry leaks, pii laundered into a public field, untrusted strings into validated fields, and implicit flows are all rejected with a source-to-sink path (see `test/check.test.ts`).
3. **Mutation testing finds spec gaps.** Of 22 mutants, 17 are killed. The 5 survivors are real gaps: receipt wording is unspecified, the audit emit is unspecified, and `:on-err MailFailed` is exactly the open question left in `Unresolved`. Removing the discount Rule table makes the Enterprise-rate mutant survive.
4. **Syntax matters less than hoped, but delimiters cost.** Same AST, OpenAI tokenizers as a proxy (not a Claude tokenizer, so only the relative numbers mean anything), invoicing example:

   | syntax | o200k tokens | vs TS-like |
   |---|---|---|
   | prefix (delimiter-free) | 502 | -11% |
   | compact S-expr | 514 | -9% |
   | TS-like braces | 566 | baseline |
   | verbose S-expr | 591 | +4% |
   | JSON AST | 1918 | +239% |

   The example is small (one module); treat the percentages as indicative.
5. **Single-token deletion** (every token of every function body removed once): prefix is rejected by the parser 91% of the time and verbose S-expr 66%, but both accept 4 to 5% as a different valid program (e.g. dropping the root `sum` or one argument of `text`). Prefix's silent changes are mostly root or argument absorption, which a type check on the result would catch; the checker only caught some because it had no argument-type checking for builtins. Adding one (arithmetic on a list is now `E-type`) was a direct result of this experiment. Delimiter-free does not mean fragile at expression level; it does not show whole-program boundary behaviour, which was not tested.

## Not implemented

Relational proofs through lists (no model of `sum`/`map`/`filter`), recursion and folds, declassifiers, covert-channel analysis (timing, size), capability-row inference, Wasm codegen, proof that a validator's `Ok` implies its predicate, and anything about an OS (deferred).

## Layout

`src/sexpr.ts` reader; `parse.ts`, `ast.ts`; `smt.ts`; `check.ts` (+ `interval.ts`, `labels.ts`, `caps.ts`); `interp.ts`; `scenario.ts`; `mutate.ts`; `compare.ts` and `print/*` (syntaxes); `cli.ts`.
