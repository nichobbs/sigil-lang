# Sigil (working name)

A prototype of a programming language intended for AI agents only: token-efficient to produce, secure by construction, verifiable, explainable, and reviewable without a human reading the source. Humans review a readable intent layer (scenarios, glossary, policy), not code.

This repo is a feasibility prototype in TypeScript, not a full compiler. The only code generation is a narrow Wasm backend for the pure numeric core (see below).

## Layers

| Layer | Who reads it | Files in `examples/invoicing` |
|---|---|---|
| Intent | humans | `invoicing.feature` (Rule / Example / Always / Privacy / Unresolved), `glossary.sigil`, `policy.sigil` |
| Implementation | agents | `app.sigil` (typed tree, canonical S-expression serialization) |
| Evidence | agents and CI | produced by `check`, `verify`: range proofs, flow matrix, scenario results, mutation report |

## Run

```
npm install
npm test                 # vitest
npm run check            # interval analysis, capabilities, information flow
npm run verify           # check + scenarios + properties + privacy + mutation adequacy
npm run compare          # syntax token comparison + single-token-deletion fragility
npx tsx src/cli.ts wasm examples/invoicing [out.wasm]   # which functions compile to Wasm, and why not
```

## What is implemented

- Total core language: ranged integers (representation derived, no machine ints), no null or exceptions, `Result` with `try ... :on-err`, capability handles with `needs` declarations, deny-by-default sinks.
- Interval abstract interpretation over bigints: range obligations, no overflow, non-zero divisors, derived i32/i64/bigint representation, three-valued evaluation of `ensures`.
- Information-flow checker: confidentiality (`public < internal < pii < secret`) and integrity (`untrusted < screened < validated < approved < trusted`) labels per field, implicit flows via branching, provenance paths in counterexamples, flow matrix.
- Reference interpreter with a mock host (effect log, failure injection, seeded PRNG) and runtime contracts.
- Scenario compiler: Gherkin-style feature files bound to actions through a glossary; decision-table exhaustiveness; property tests; privacy scenarios (static flow matrix plus dynamic two-run noninterference with a vacuity check); open questions surfaced to humans.
- Mutation testing to measure whether the human-reviewable spec actually constrains the implementation.
- Five surface syntaxes for the same AST, with a token comparison and a fragility experiment.

## Wasm backend (pure numeric core)

`src/wasm/` hand-encodes a `.wasm` binary (no wabt) for functions that are pure and numeric. Because the interval analysis has already proved no overflow and a non-zero divisor, the emitted code is plain wrapping `i32`/`i64` arithmetic with no overflow or zero checks. `div-floor` is real floor division (Wasm `div_s` truncates, so it adds a sign-aware correction).

Covered:
- Parameters of ranged `Int`, `Bool`, enums (as an `i32` index) and records of those (flattened to one scalar parameter per field). Results: `Int`, `Bool`, enum.
- Expressions: literals, variables and field reads, `let`, `do`, `if`, `match` on enums (must be exhaustive, no payload binders), `add sub mul div-floor neg min max`, binary `= < <= > >=`, `and or not`.
- Every `Int` in a function uses the checker's derived repr (`i32` or `i64`). The checker counts parameter ranges and literals as well as arithmetic results (this was a gap the Wasm work found); the backend keeps a defensive check that widens to `i64` and reports it if the two ever disagree.
- A function compiles only if it has no `needs`, no `requires`, no checker errors, and every non-`ensures` obligation is proved.

Not covered (reported as "not compilable" with the reason, never miscompiled): lists and `sum`/`map`/`filter`/`len`, strings and `text`, `Result`/`try`/`ok`/`err`, capabilities and effects, record construction or record results, calls between functions, lambdas, `bigint` repr, comparisons with more than two arguments, and `requires`. `ensures` clauses are specifications and are not emitted as runtime checks. There is no linking, memory, host ABI or optimisation.

On the invoicing example: `discount` compiles; `gross` and `price-invoice` (list parameter), `receipt` (strings) and `issue-invoice` (capabilities) do not. `test/wasm.test.ts` also compiles a numeric fixture with a price-style `mul`/`div-floor`/`match` computation.

Differential testing: each compilable function is run on the reference interpreter and on the Wasm module with 400 seeded, boundary-biased inputs and the results must be identical, including negative numerators and negative divisors for `div-floor`. A mutated compiler (`divMode: 'trunc'`) is shown to be caught by the same test. This checks agreement with the interpreter on sampled inputs; it is not a proof of compiler correctness.

## Findings

1. **Intervals prove safety; SMT closes the relational gap.** Intervals prove all range, overflow and divisor obligations and derive `i64` for `price-invoice` (max intermediate 2e16), but cannot prove `ensures (<= out (gross ls))`. `src/smt.ts` (z3, via `z3-solver`) now discharges it: `verify` reports it as PROVED (SMT). The encoding covers integer arithmetic, comparisons, `if`, `let`, enum `match`, record reads and construction, and bounded lists: a `(List T min max)` with max <= 6 becomes a length variable plus one symbolic element per slot, with `len`, `sum`, `map`, `filter` and `list` modelled exactly, and calls to user functions are inlined (so `gross` is unfolded and e.g. `gross (filter ls ...) <= gross ls` is provable). For larger lists only `len` is modelled; a call that cannot be inlined (such as `gross` over a 200-element list, as in `price-invoice`) falls back to a constant constrained by the callee's declared output range, which is sound given the callee's separately checked contract; anything else is `unsupported`. Mutation sanity checks: allowing a negative Pct (a surcharge) gives a counterexample, and a too-strong `<` ensures is refuted with a concrete plan (Free). One bug found while writing it: assuming the function's own declared output range as a premise makes the proof vacuous whenever the body can leave that range, so the range is not assumed.
2. **Flow checking works on the example.** Telemetry leaks, pii laundered into a public field, untrusted strings into validated fields, and implicit flows are all rejected with a source-to-sink path (see `test/check.test.ts`).
3. **Mutation testing finds spec gaps.** Of 22 mutants, 17 were killed at first; the 5 survivors were real gaps (receipt wording x3, the audit emit, and `:on-err MailFailed`). Adding two business-readable Examples (exact receipt subject and body for a concrete customer and invoice; an audit event is recorded on issue) kills four of them, so now 21 of 22 (95%) are killed. The one survivor, `:on-err MailFailed -> StoreFailed`, is deliberately left: it is exactly the open question in `Unresolved` (store succeeded, email failed: keep or roll back?), and no spec author should answer it for the human. The CLI tags it as an open question. Removing the discount Rule table makes the Enterprise-rate mutant survive. Pinning the receipt also surfaced that it printed the total in raw cents (`your total is 900` for $9.00); fixed with a `money` builtin, and the Example now expects `$9.00`.
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

Relational proofs through lists longer than 6 (elements are not modelled, so proofs there rely on callee ranges), recursion and folds, declassifiers, covert-channel analysis (timing, size), capability-row inference, Wasm codegen beyond the numeric core, proof that a validator's `Ok` implies its predicate, and anything about an OS (deferred).

## Layout

`src/sexpr.ts` reader; `parse.ts`, `ast.ts`; `smt.ts`; `check.ts` (+ `interval.ts`, `labels.ts`, `caps.ts`); `interp.ts`; `scenario.ts`; `mutate.ts`; `compare.ts` and `print/*` (syntaxes); `cli.ts`.
