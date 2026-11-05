# Sigil (working name)

A prototype of a programming language intended for AI agents only: token-efficient to produce, secure by construction, verifiable, explainable, and reviewable without a human reading the source. Humans review a readable intent layer (scenarios, glossary, policy), not code.

This repo is a feasibility prototype in TypeScript, not a full compiler. The only code generation is a Wasm backend (see below) that now compiles whole reference-app entry points as well as numeric helpers.

Terms such as mutant, survivor, trap and hidden case are defined in `docs/GLOSSARY.md`.

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
- Declassifiers (controlled release of labelled data). A declassifier exists only if the human-owned `policy.sigil` declares it: `(declassify name (from pii) (to internal) (reason "...") [(fields Type.field ...)] [(fns fn ...)])`. Code applies one with `(declassify name expr)` and must list it in the function's `(declassifies name ...)` clause (needs-style). It lowers confidentiality from `from` (or below) to `to` and nothing else: integrity is untouched, the implicit-flow label is not lowered, data above `from` is `E-flow` (a pii declassifier cannot launder secret), an undeclared name is `E-policy`, and a use outside the `fields`/`fns` restriction is `E-policy`. The manifest lists each function's declassifiers with the policy reason, the flow matrix marks flows `via declassify <name>`, and provenance paths keep the declassify step. Demo: `examples/declassify` (a pii salary released to the audit log only as a 10,000-wide band).
- Reference interpreter with a mock host (effect log, failure injection, seeded PRNG) and runtime contracts.
- Scenario compiler: Gherkin-style feature files bound to actions through a glossary; decision-table exhaustiveness; property tests; privacy scenarios (static flow matrix plus dynamic two-run noninterference with a vacuity check); open questions surfaced to humans.
- Mutation testing to measure whether the human-reviewable spec actually constrains the implementation.
- Five surface syntaxes for the same AST, with a token comparison and a fragility experiment.

## Wasm backend (numeric core, lists, records, Results, strings, effects, entry points)

`src/wasm/` hand-encodes a `.wasm` binary (no wabt) for functions that are pure and numeric. Because the interval analysis has already proved no overflow and a non-zero divisor, the emitted code is plain wrapping `i32`/`i64` arithmetic with no overflow or zero checks. `div-floor` is real floor division (Wasm `div_s` truncates, so it adds a sign-aware correction).

Covered:
- Parameters of ranged `Int`, `Bool`, enums (as an `i32` index) and records of those (flattened to one scalar parameter per field). Results: `Int`, `Bool`, enum.
- Expressions: literals, variables and field reads, `let`, `do`, `if`, `match` on enums (must be exhaustive, no payload binders), `add sub mul div-floor neg min max`, binary `= < <= > >=`, `and or not`.
- Every `Int` in a function uses the checker's derived repr (`i32` or `i64`). The checker counts parameter ranges and literals as well as arithmetic results (this was a gap the Wasm work found); the backend keeps a defensive check that widens to `i64` and reports it if the two ever disagree.
- Direct calls between compiled functions (scalar arguments, any order of definition, no recursion). Callees are compiled first; a caller is at least as wide as its callees, and `i32`/`i64` are converted at the call boundary (narrowing is lossless because the checker has proved each argument is in the callee's parameter range). A call to a function that is not compilable makes the caller not compilable, with the callee's reason.
- Lists (`(List T min max)` where `T` is Int, Bool, an enum, or a record of those): `len`, `sum`, `map`, `filter` and `(list a b ...)`, with the `map`/`filter` lambda inlined into a loop over memory. Lists can be let-bound and passed to other compiled functions. A list can be a parameter or an intermediate value, not a result, and not nested. See "Lists and memory" below.
- A function compiles only if it has no `needs`, no `requires`, no checker errors, and every non-`ensures` obligation is proved.

Not covered (reported as "not compilable" with the reason, never miscompiled): list results, nested lists, lists of strings, reading a `Str` field of a list element, strings and `text`, `Result`/`try`/`ok`/`err`, capabilities and effects, record construction or record results, calls that pass a whole record as an argument, lambdas, `bigint` repr, comparisons with more than two arguments, and `requires`. `ensures` clauses are specifications and are not emitted as runtime checks. There is no linking, host ABI or optimisation.

On the invoicing example: `discount`, `gross` and `price-invoice` compile; `receipt` (strings) and `issue-invoice` (capabilities) do not. `test/wasm.test.ts` also compiles a numeric fixture with a price-style `mul`/`div-floor`/`match` computation.

Language-gap work (branch `wasm/language-gaps`): records and Results are flattened to multi-value leaves; `Str` values are opaque i32 handles resolved by host imports (`str_eq`, `str_concat`, `str_int`, `str_money`, `str_chars`, `str_from_chars`); capability calls (`needs`) are imported host functions (`put$k`, `post$k`, `emit$k`, `fresh$k`) with the ABI documented in `src/wasm/abi.ts` and a `sigil.abi` custom section, and `src/wasm/host.ts` adapts them onto the interpreter `Host`; program entry points are exported; `fold` (also with the index), `sort` (the interpreter's stable top-down merge sort, same split points and comparison direction), `take`, `drop`, `at`, `append`, `concat`, `range`, `any`/`all` (exiting at the same element as the interpreter) and `mod` compile too. `range` sizes its scratch from the checker's bound on n (`CheckResult.rangeHi`, so the module must be compiled from the same checked program, or the function is refused) and also clamps n to that bound at run time. `npx tsx experiments/wasm-coverage.ts` prints per-task function and entry-point counts (`--reasons` lists refusals). Still refused with a reason: functions with `requires`, `get`, `=` on lists, `text` of non-scalars, `chars` without `:max`, Results whose type cannot be inferred from context, nested lists, and anything the checker does not prove.

### Lists and memory

- ABI: a list parameter is two `i32` arguments `(ptr, len)` into the exported `memory`. A function that uses lists, directly or through a callee, takes one more trailing `i32`: the start of its scratch memory. `src/wasm/abi.ts` (`lowerArgs`, `callCompiled`, `writeList`, `readList`) marshals Sigil values and passes the scratch base; the module's export checks the lengths, the element values and the memory bounds itself (see "Trust model" below).
- Layout: an element is `stride` consecutive 8-byte little-endian `i64` slots, one per scalar field in declaration order (`Int` sign-extended, `Bool` 0/1, enum case index). A scalar element has stride 1. `Str` fields of a record element are not stored, so compiled code cannot read them (a read is refused). Slots are 8 bytes whatever the function's `i32`/`i64` repr, so a list can be passed between functions of different widths.
- Memory map: inputs from address 16, each reserving its declared maximum (`max * stride * 8`), then scratch. `map`, `filter` and `list` get scratch at static offsets from the base (`map` output `max * 8`, `filter` output `max * stride * 8`), so there is no dynamic allocation and the whole need is a compile-time number: `FnReport.inputBytes` / `scratchBytes`, module `memPages`. A callee's scratch starts above everything its caller has allocated. On `gross`: 3200 bytes of input (200 lines of unit and qty), 1600 bytes of scratch, one page.
- Limits: a function is refused if inputs plus scratch exceed 16 MiB (a list type with an absurd declared maximum), or if a list argument could be longer than the callee's declared maximum.
- Arithmetic: loops run `len <= max` times, and the checker has already bounded `sum` (length times element range) and every lambda-body intermediate, so loop code is plain wrapping `i32`/`i64` with no overflow checks, as for scalars.
- Trust: the compiled bodies assume `min <= len <= max` and elements within their declared ranges, as they assume scalar arguments are in range; the validating export in front of each body checks exactly that (and that the list lies below the scratch base and the scratch inside the memory) before the body runs.

### Trust model (validating exports, ABI version 2)

The compiled function bodies are unchecked: they are plain wrapping arithmetic whose safety rests on the checker's proofs, which assume every argument is within its declared type. Until ABI version 2 the module exported those bodies directly, so a Wasm program was only as safe as its caller's input check. Now:

- Validated, at every export, before any unchecked code runs (`src/wasm/validate.ts`), in the interpreter's order: `Int` ranges (scalars, record fields at any depth, Result payloads, list elements, checked on the 8-byte slot so nothing wraps), `Bool` is 0/1, enum case indices, `Str` handles are live and within `:max` (code points, via the host import `str_len`), Result tags and an all-zero inactive side, list lengths within `min..max`, list memory below the scratch base, and the scratch base plus the function's scratch inside the memory. A violation calls the host import `contract_violation(site, index, value)` and then traps (`unreachable`), so a host whose import returns still never reaches the body. `site` indexes `checks` in the `sigil.abi` section (function, place, reason).
- Not exported: the unchecked bodies. Calls between compiled functions stay direct and unchecked, because the checker proved each callee's parameter ranges at the call site.
- Reasons are the interpreter's own (`ContractViolation.reason`: `range`, `str-max`, `enum`, `list-length`, `type`) plus `encoding` and `memory` for raw arguments no Sigil value encodes to. The JS adapter (`src/wasm/host.ts`) throws the interpreter's `ContractViolation` with the same reason and the same `where` path (`f(p).field`, `f(xs)[3].qty`), and for range, `:max` and length violations the same message. Values with no encoding at all (the wrong kind, an `Int` wider than the representation) are refused by the adapter with the same reason before the call. `test/wasm-validate.test.ts` checks every one-violation input to the 11 reference apps' entry points on both backends; `apps/docs/test/wasm.test.ts` does the same for the docs app with its shell check bypassed.
- Host results the compiled code relies on are checked at the call: `fresh` must be in `0..9007199254740991` (the checker's assumption) and the `str_chars` count in `0..:max`; either violation is a host fault (`RuntimeFault`, reason `host-result`). `str_eq` is normalised to 0/1.
- Still trusted: the host's string table (handles returned by `str_concat`, `str_int`, `str_money`, `str_from_chars`, and the text behind every handle), the success flags of `put`/`post`/`emit` (any nonzero is success, which cannot break an invariant), and the host's own writes into memory (a host can write to the exported memory at any time anyway). Compiled code does not check `ensures` at run time (the interpreter does), and does not re-check its results: the checker proved them (including `Str :max` on results), or the function is not compilable.
- Still refused (not compilable, with a reason): functions with `requires` (the backend does not enforce them), `get`, `=` on lists, `text` of non-scalars, `chars` without `:max`, nested lists, `bigint` repr, and anything the checker does not prove.
- Hosts can tell the two kinds of module apart: `isValidated(abi or module)` in `src/wasm/abi.ts` (`version: 2`, `validated: true` in `sigil.abi`).

Differential testing: each compilable function is run on the reference interpreter and on the Wasm module with 400 seeded, boundary-biased inputs and the results must be identical, including negative numerators and negative divisors for `div-floor`. A mutated compiler (`divMode: 'trunc'`) is shown to be caught by the same test. This checks agreement with the interpreter on sampled inputs; it is not a proof of compiler correctness. `test/wasm-lists.test.ts` does the same for lists (`gross`, `price-invoice`, and `filter`/`len`/`sum`/`map`/`list` fixtures) with lengths from `min` to `max` (200 for invoices) and extreme element values.

## Findings

1. **Intervals prove safety; SMT closes the relational gap.** Intervals prove all range, overflow and divisor obligations and derive `i64` for `price-invoice` (max intermediate 2e16), but cannot prove `ensures (<= out (gross ls))`. `src/smt.ts` (z3, via `z3-solver`) now discharges it: `verify` reports it as PROVED (SMT). The encoding covers integer arithmetic, comparisons, `if`, `let`, enum `match`, record reads and construction, and bounded lists: a `(List T min max)` with max <= 6 becomes a length variable plus one symbolic element per slot, with `len`, `sum`, `map`, `filter` and `list` modelled exactly, and calls to user functions are inlined (so `gross` is unfolded and e.g. `gross (filter ls ...) <= gross ls` is provable). For larger lists only `len` is modelled; a call that cannot be inlined (such as `gross` over a 200-element list, as in `price-invoice`) falls back to a constant constrained by the callee's declared output range, which is sound given the callee's separately checked contract; anything else is `unsupported`. Mutation sanity checks: allowing a negative Pct (a surcharge) gives a counterexample, and a too-strong `<` ensures is refuted with a concrete plan (Free). One bug found while writing it: assuming the function's own declared output range as a premise makes the proof vacuous whenever the body can leave that range, so the range is not assumed.
2. **Flow checking works on the example.** Telemetry leaks, pii laundered into a public field, untrusted strings into validated fields, and implicit flows are all rejected with a source-to-sink path (see `test/check.test.ts`).
3. **Mutation testing finds spec gaps, and forces decisions into the readable layer.** Of 22 mutants, 17 were killed at first; the 5 survivors were real gaps (receipt wording x3, the audit emit, and `:on-err MailFailed`). Two business-readable Examples (exact receipt text; audit event on issue) killed four. The fifth was an open question the spec author deliberately did not answer; once a human decided it (keep the invoice, report "mail failed") it became an Example and the mutant died: 22 of 22 killed. The decision exposed a second question (no audit event when the email fails); the answer (record a `ReceiptFailed` audit event) also became an Example, so the invoicing feature has no open questions left. Removing the discount Rule table makes the Enterprise-rate mutant survive. Pinning the receipt also surfaced that it printed the total in raw cents; fixed with a `money` builtin.
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

6. **Declassifiers and the Privacy scenario.** The static label is sound by construction, but the dynamic two-run check is not: a declassified flow *does* change what a sink sees, so strict noninterference is false for it. The prototype therefore does not exempt anything by default. A Privacy scenario fails if its source reaches a non-allowed sink via a declassifier, and the message tells the human what to add. Only if the glossary binding names the declassifier (`(declassified salary-band)`, a human decision in a human-owned file) is the sink excluded from the two-run comparison, and then the result is reported as `PASS MODULO DECLASSIFIER <name>` with the exempted sinks listed, never as noninterference. The exemption is by sink, not by individual flow, which is coarser than ideal; it is backed by the static matrix, which must show every flow from the source to that sink passing an accepted declassifier (a direct flow to the same sink wins in the matrix and fails the rule). Soundness caveats: the checker trusts the policy's `from`/`to` and the human's `reason`; it does not check that the expression inside `declassify` actually computes a hash, band or length (so a declassifier over an identity expression releases the whole value), and with no string builtins the demo releases a pii integer rather than, say, the initial of a name.

## Not implemented

Relational proofs through lists longer than 6 (elements are not modelled, so proofs there rely on callee ranges), recursion and folds, checking that a declassified expression really reduces information (bits-released or quantitative analysis), per-flow (not per-sink) exemption in Privacy scenarios, transitive `declassifies` declarations for callers, declassifier support in the Wasm backend (such functions are simply not compilable), covert-channel analysis (timing, size), capability-row inference, Wasm codegen beyond the numeric core, proof that a validator's `Ok` implies its predicate, and anything about an OS (deferred).

## Layout

`src/sexpr.ts` reader; `parse.ts`, `ast.ts`; `smt.ts`; `check.ts` (+ `interval.ts`, `labels.ts`, `caps.ts`); `interp.ts`; `scenario.ts`; `mutate.ts`; `compare.ts` and `print/*` (syntaxes); `cli.ts`.
